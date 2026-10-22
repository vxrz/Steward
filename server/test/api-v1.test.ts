import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { authHeaders, loginCookie, setup, startTestServer, ADMIN, type Client, type TestServer } from './helpers.js';

let s: TestServer;
const PW = 'Demo-password-1';
let vera: Client, audrey: Client, dana: Client;
const tokens: Record<string, string> = {};
let tinyProcess: string;
let restricted: string;
let hub: string;
/** Every secret value we know of; none may ever show up in a /api/v1 response. */
const SECRETS: string[] = [];
const PLATFORM_KEYS = ['id', 'name', 'kind', 'description', 'environment', 'baseUrl', 'authType', 'permissions', 'createdAt', 'updatedAt'].sort();

interface Res {
  status: number;
  headers: Headers;
  text: string;
  body: any;
}

async function v1(token: string | null, url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Res> {
  const res = await fetch(s.base + '/api/v1' + url, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, text, body };
}

/** Sign in through the internal API and return the raw session cookie. */
async function sessionCookie(username: string, password: string): Promise<string> {
  return loginCookie(s.base, username, password);
}

async function newToken(c: Client, name: string, scope: 'read' | 'full' = 'read'): Promise<string> {
  return (await c('POST', '/me/tokens', { name, scope })).token;
}

// ---------- OpenAPI response validation ----------

let doc: any;
let ajv: InstanceType<typeof Ajv2020>;
const validators = new Map<string, ReturnType<InstanceType<typeof Ajv2020>['compile']>>();

function withRefs(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema).replace(/"#\/components\//g, '"openapi#/components/'));
}

/** Validate a response against the operation's documented schema (by path template). */
function validate(template: string, res: Res): void {
  const op = doc.paths[template]?.get;
  expect(op, `documented operation for ${template}`).toBeTruthy();
  const status = String(res.status);
  let resp = op.responses[status];
  expect(resp, `documented ${status} response for ${template}`).toBeTruthy();
  if (resp.$ref) resp = doc.components.responses[resp.$ref.split('/').pop()];
  const [ctype, media] = Object.entries<any>(resp.content)[0]!;
  expect(res.headers.get('content-type')).toContain(ctype);
  const key = `${template} ${status}`;
  if (!validators.has(key)) validators.set(key, ajv.compile(withRefs(media.schema) as object));
  const fn = validators.get(key)!;
  if (!fn(res.body)) throw new Error(`${key} does not match the OpenAPI document: ${ajv.errorsText(fn.errors)}\n${res.text.slice(0, 500)}`);
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [vera, audrey, dana] = await Promise.all(['vera', 'audrey', 'dana'].map((u) => s.as(u, PW)));
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;

  const { DEMO_CREDENTIALS } = await import('../src/mock/mockPlatform.js');
  SECRETS.push(DEMO_CREDENTIALS.client.secret, DEMO_CREDENTIALS.iem.password);
  const extra = 'sk-live-SECRET-0123456789abcdef';
  SECRETS.push(extra);
  await s.api('PUT', `/platforms/${hub}/secrets`, { apiKey: extra });

  tinyProcess = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'API tiny',
        tags: ['api-test'],
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'say', type: 'log', message: 'hello from {{ run.id }}', x: 1, y: 0 },
          { id: 'chk', type: 'check', name: 'Always true', condition: 'true', message: 'fine', x: 2, y: 0 },
        ],
        wires: [
          { from: 'start', port: 'out', to: 'say' },
          { from: 'say', port: 'out', to: 'chk' },
        ],
      },
    })
  ).id;
  // A second version
  const p = await s.api('GET', `/processes/${tinyProcess}`);
  await s.api('PUT', `/processes/${tinyProcess}`, { definition: { ...p.definition, description: 'v2' }, comment: 'second' });

  restricted = (await s.api('POST', '/processes', { definition: { name: 'API secret process', nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } })).id;
  await s.api('PUT', `/processes/${restricted}/access`, { acl: [{ subject: 'user:dana', permissions: ['view', 'run'] }] });
  await s.waitRun((await s.api('POST', '/runs', { processId: restricted })).id, ['succeeded', 'failed']);

  // Runs that use the platform credentials, so step journals contain (redacted) authenticated calls.
  await s.waitRun((await s.api('POST', '/runs', { processId: 'ih-health-check', bindings: { hub } })).id, ['succeeded', 'failed']);
  // A run waiting for a decision (tasks endpoints)
  const approval = await s.api('POST', '/processes', {
    definition: {
      name: 'API approval',
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'ok', type: 'userTask', mode: 'approve', title: 'Approve the API test', x: 1, y: 0 },
      ],
      wires: [{ from: 'start', port: 'out', to: 'ok' }],
    },
  });
  await s.waitRun((await s.api('POST', '/runs', { processId: approval.id })).id, ['waiting']);
  for (let i = 0; i < 7; i++) await s.waitRun((await s.api('POST', '/runs', { processId: tinyProcess })).id, ['succeeded', 'failed']);

  tokens.admin = await newToken(s.api, 'admin read');
  tokens.vera = await newToken(vera, 'vera read');
  tokens.audrey = await newToken(audrey, 'audrey full', 'full');
  tokens.dana = await newToken(dana, 'dana read');

  doc = (await v1(tokens.admin, '/openapi.json')).body;
  ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
});

afterAll(async () => {
  await s?.app.close();
});

describe('authentication', () => {
  it('requires an API token (problem details, WWW-Authenticate)', async () => {
    const r = await v1(null, '/runs');
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer realm=/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toMatchObject({ status: 401, title: 'Unauthorized', instance: '/api/v1/runs' });
    expect(r.body.type).toMatch(/API\.md#token-required$/);
    validate('/runs', r);
  });

  it('does not accept session cookies', async () => {
    const cookie = await sessionCookie(ADMIN.username, ADMIN.password);
    // the same cookie works for the internal API …
    expect((await fetch(s.base + '/api/runs', { headers: authHeaders(cookie) })).status).toBe(200);
    // … but not for /api/v1
    const r = await v1(null, '/runs', { headers: authHeaders(cookie) });
    expect(r.status).toBe(401);
    expect(r.body.detail).toMatch(/session cookies/);
  });

  it('rejects unknown, revoked and URL tokens', async () => {
    const bad = await v1('smt_not-a-real-token', '/me');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
    const t = await s.api('POST', '/me/tokens', { name: 'short-lived', scope: 'read' });
    expect((await v1(t.token, '/me')).status).toBe(200);
    await s.api('DELETE', `/me/tokens/${t.id}`);
    expect((await v1(t.token, '/me')).status).toBe(401);
    const inUrl = await v1(null, `/runs?access_token=${tokens.admin}`);
    expect(inUrl.status).toBe(400);
    expect(inUrl.body.type).toMatch(/#token-in-url$/);
  });

  it('answers 403 when the token owner is deactivated', async () => {
    const { user, temporaryPassword } = await s.api('POST', '/users', { username: 'svc-report', roles: ['viewer'] });
    const first = await s.as('svc-report', temporaryPassword);
    await first('POST', '/auth/password', { current: temporaryPassword, next: 'Svc-password-123' });
    const svc = await s.as('svc-report', 'Svc-password-123');
    const token = await newToken(svc, 'report');
    expect((await v1(token, '/processes')).status).toBe(200);
    await s.api('PUT', `/users/${user.id}`, { active: false });
    const r = await v1(token, '/processes');
    expect(r.status).toBe(403);
    expect(r.body.type).toMatch(/#owner-disabled$/);
  });

  it('tells who the token belongs to; both scopes work', async () => {
    const me = await v1(tokens.audrey, '/me');
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('audrey');
    expect(me.body.token).toMatchObject({ name: 'audrey full', scope: 'full' });
    expect(me.body.capabilities).toEqual({ viewAudit: true, manageUsers: false });
    expect(me.text).not.toContain(tokens.audrey);
    validate('/me', me);
    expect((await v1(tokens.vera, '/me')).body.token.scope).toBe('read');
  });

  it('serves health without a token', async () => {
    const r = await v1(null, '/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    validate('/health', r);
  });

  it('is read-only and answers unknown paths with problem details', async () => {
    const post = await v1(tokens.audrey, '/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    const missing = await v1(tokens.admin, '/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
  });

  it('records token use in the audit log once per day', async () => {
    const t = await newToken(s.api, 'daily');
    await v1(t, '/me');
    await v1(t, '/runs');
    const entries = (await s.api('GET', '/audit?action=api.token_used&limit=500')).filter((a: any) => a.summary.includes('"daily"'));
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('admin');
  });
});

describe('permissions mirror the web UI', () => {
  it('hides processes restricted by an access list', async () => {
    const list = await v1(tokens.vera, '/processes?limit=200');
    expect(list.body.items.map((p: any) => p.id)).not.toContain(restricted);
    expect((await v1(tokens.vera, `/processes/${restricted}`)).status).toBe(404);
    expect((await v1(tokens.vera, `/runs?processId=${restricted}`)).body.items).toEqual([]);
    const all = await v1(tokens.vera, '/runs?limit=200');
    expect(all.body.items.some((r: any) => r.processId === restricted)).toBe(false);
    // dana is on the list, auditors see everything
    expect((await v1(tokens.dana, `/processes/${restricted}`)).status).toBe(200);
    expect((await v1(tokens.audrey, `/runs?processId=${restricted}`)).body.items).toHaveLength(1);
    const runId = (await v1(tokens.audrey, `/runs?processId=${restricted}`)).body.items[0].id;
    expect((await v1(tokens.vera, `/runs/${runId}`)).status).toBe(404);
  });

  it('limits the audit log to auditors and administrators', async () => {
    const denied = await v1(tokens.vera, '/audit');
    expect(denied.status).toBe(403);
    validate('/audit', denied);
    expect((await v1(tokens.vera, '/audit/verify')).status).toBe(403);
    const ok = await v1(tokens.audrey, '/audit?limit=5');
    expect(ok.status).toBe(200);
    validate('/audit', ok);
    const verify = await v1(tokens.audrey, '/audit/verify');
    expect(verify.body.ok).toBe(true);
    validate('/audit/verify', verify);
  });

  it('limits users and teams to administrators', async () => {
    expect((await v1(tokens.audrey, '/users')).status).toBe(403);
    expect((await v1(tokens.vera, '/teams')).status).toBe(403);
    const u = await v1(tokens.admin, '/users?limit=200');
    expect(u.status).toBe(200);
    validate('/users', u);
    expect(u.text).not.toMatch(/password_?hash|scrypt|smt_/i);
    expect(u.body.items.map((x: any) => x.username)).toContain('vera');
  });
});

describe('pagination', () => {
  it('pages through runs with cursors and Link headers, without duplicates', async () => {
    const full = await v1(tokens.admin, `/runs?processId=${tinyProcess}&limit=200`);
    expect(full.body.items.length).toBeGreaterThanOrEqual(7);
    expect(full.body.nextCursor).toBeNull();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Res = await v1(tokens.admin, `/runs?processId=${tinyProcess}&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      validate('/runs', r);
      expect(r.body.items.length).toBeLessThanOrEqual(3);
      seen.push(...r.body.items.map((x: any) => x.id));
      cursor = r.body.nextCursor;
      if (cursor) expect(r.headers.get('link')).toContain(`cursor=${cursor}>; rel="next"`);
      else expect(r.headers.get('link')).toBeNull();
      pages++;
    } while (cursor && pages < 20);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(full.body.items.map((x: any) => x.id));
    const starts = full.body.items.map((x: any) => x.startedAt);
    expect([...starts].sort().reverse()).toEqual(starts);
  });

  it('keeps cursors tied to their filters and validates parameters', async () => {
    const first = await v1(tokens.admin, `/runs?processId=${tinyProcess}&limit=2`);
    const other = await v1(tokens.admin, `/runs?status=failed&limit=2&cursor=${first.body.nextCursor}`);
    expect(other.status).toBe(400);
    expect(other.body.type).toMatch(/#invalid-cursor$/);
    expect((await v1(tokens.admin, '/runs?cursor=garbage!')).status).toBe(400);
    const tooBig = await v1(tokens.admin, '/runs?limit=500');
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.type).toMatch(/#validation-error$/);
    expect(tooBig.body.errors[0]).toMatchObject({ in: 'query', name: 'limit' });
    expect((await v1(tokens.admin, '/runs?status=bogus')).status).toBe(400);
    expect((await v1(tokens.admin, '/runs?from=yesterday')).status).toBe(400);
  });

  it('filters runs', async () => {
    const r = await v1(tokens.admin, `/runs?processId=${tinyProcess}&status=succeeded&status=failed&trigger=manual&dryRun=false&from=2000-01-01T00:00:00Z`);
    expect(r.body.items.length).toBeGreaterThanOrEqual(7);
    expect((await v1(tokens.admin, `/runs?processId=${tinyProcess}&dryRun=true`)).body.items).toEqual([]);
    expect((await v1(tokens.admin, `/runs?processId=${tinyProcess}&to=2000-01-01T00:00:00Z`)).body.items).toEqual([]);
  });

  it('pages through steps and logs', async () => {
    const runId = (await v1(tokens.admin, `/runs?processId=${tinyProcess}&limit=1`)).body.items[0].id;
    const detail = await v1(tokens.admin, `/runs/${runId}`);
    validate('/runs/{runId}', detail);
    expect(detail.body.steps.total).toBeGreaterThanOrEqual(3);
    expect(detail.body.checks).toEqual([expect.objectContaining({ name: 'Always true', passed: true })]);
    expect(detail.body.protocol.intact).toBe(true);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const r: Res = await v1(tokens.admin, `/runs/${runId}/steps?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      validate('/runs/{runId}/steps', r);
      ids.push(...r.body.items.map((x: any) => x.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(detail.body.steps.total);
    expect(new Set(ids).size).toBe(ids.length);
    const one = await v1(tokens.admin, `/runs/${runId}/steps/${ids[1]}`);
    validate('/runs/{runId}/steps/{stepId}', one);
    const logs = await v1(tokens.admin, `/runs/${runId}/logs?limit=200`);
    validate('/runs/{runId}/logs', logs);
    expect(logs.body.items.some((l: any) => l.message === `hello from ${runId}`)).toBe(true);
  });

  it('lists versions of a process', async () => {
    const v = await v1(tokens.vera, `/processes/${tinyProcess}/versions?limit=1`);
    validate('/processes/{processId}/versions', v);
    expect(v.body.items[0].version).toBe(2);
    const v1page2 = await v1(tokens.vera, `/processes/${tinyProcess}/versions?limit=1&cursor=${v.body.nextCursor}`);
    expect(v1page2.body.items[0].version).toBe(1);
    expect(v1page2.body.nextCursor).toBeNull();
    const one = await v1(tokens.vera, `/processes/${tinyProcess}/versions/1`);
    validate('/processes/{processId}/versions/{version}', one);
    expect(one.body.definition.description).toBeUndefined();
    expect((await v1(tokens.vera, `/processes/${tinyProcess}/versions/99`)).status).toBe(404);
    const filtered = await v1(tokens.vera, '/processes?tag=api-test');
    expect(filtered.body.items.map((p: any) => p.id)).toEqual([tinyProcess]);
  });
});

/** Fetch every documented endpoint (filling path parameters from list results) as `token`. */
async function crawl(token: string): Promise<{ template: string; url: string; res: Res }[]> {
  const out: { template: string; url: string; res: Res }[] = [];
  const get = async (template: string, url: string) => {
    const res = await v1(token, url);
    out.push({ template, url, res });
    return res;
  };
  const listAll = async (template: string, url: string) => {
    const items: any[] = [];
    let cursor: string | null = null;
    do {
      const r: Res = await get(template, `${url}${url.includes('?') ? '&' : '?'}limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      if (r.status !== 200) return items;
      items.push(...r.body.items);
      cursor = r.body.nextCursor;
    } while (cursor);
    return items;
  };
  await get('/health', '/health');
  await get('/me', '/me');
  for (const p of (await listAll('/processes', '/processes')).slice(0, 15)) {
    await get('/processes/{processId}', `/processes/${p.id}`);
    for (const v of (await listAll('/processes/{processId}/versions', `/processes/${p.id}/versions`)).slice(0, 2)) {
      await get('/processes/{processId}/versions/{version}', `/processes/${p.id}/versions/${v.version}`);
    }
  }
  for (const r of (await listAll('/runs', '/runs')).slice(0, 25)) {
    await get('/runs/{runId}', `/runs/${r.id}`);
    for (const st of await listAll('/runs/{runId}/steps', `/runs/${r.id}/steps`)) await get('/runs/{runId}/steps/{stepId}', `/runs/${r.id}/steps/${st.id}`);
    await listAll('/runs/{runId}/logs', `/runs/${r.id}/logs`);
  }
  for (const t of await listAll('/tasks', '/tasks')) await get('/tasks/{taskId}', `/tasks/${t.id}`);
  for (const x of await listAll('/schedules', '/schedules')) await get('/schedules/{scheduleId}', `/schedules/${x.id}`);
  for (const x of await listAll('/platforms', '/platforms')) await get('/platforms/{platformId}', `/platforms/${x.id}`);
  for (const x of await listAll('/datasets', '/datasets')) {
    await get('/datasets/{datasetKey}', `/datasets/${encodeURIComponent(x.key)}`);
    await listAll('/datasets/{datasetKey}/rows', `/datasets/${encodeURIComponent(x.key)}/rows`);
    await get('/datasets/{datasetKey}/metrics', `/datasets/${encodeURIComponent(x.key)}/metrics`);
  }
  for (const x of await listAll('/dashboards', '/dashboards')) await get('/dashboards/{dashboardId}', `/dashboards/${x.id}`);
  await listAll('/audit', '/audit');
  await get('/audit/verify', '/audit/verify');
  for (const x of (await listAll('/users', '/users')).slice(0, 5)) await get('/users/{userId}', `/users/${x.id}`);
  await listAll('/teams', '/teams');
  await get('/monitors/discovery', '/monitors/discovery');
  for (const x of (await listAll('/monitors', '/monitors')).slice(0, 5)) {
    await get('/monitors/{monitorId}', `/monitors/${x.id}`);
    await get('/monitors/{monitorId}/status', `/monitors/${x.key}/status`);
    await listAll('/monitors/{monitorId}/history', `/monitors/${x.id}/history`);
  }
  for (const x of (await listAll('/records', '/records')).slice(0, 5)) {
    await get('/records/{recordId}', `/records/${x.id}`);
    await listAll('/records/{recordId}/versions', `/records/${x.number}/versions`);
  }
  return out;
}

describe('every endpoint', () => {
  let adminCrawl: Awaited<ReturnType<typeof crawl>>;
  beforeAll(async () => {
    // Publish a dataset so the dataset endpoints have something to show.
    const pub = await s.api('POST', '/processes', {
      definition: {
        name: 'API publisher',
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          {
            id: 'pub',
            type: 'publish',
            dataset: 'api.test',
            title: 'API test rows',
            rows: '[{"name":"a","state":"ok"},{"name":"b","state":"down"},{"name":"c","state":"ok"}]',
            status: 'state',
            metrics: { total: '3' },
            x: 1,
            y: 0,
          },
        ],
        wires: [{ from: 'start', port: 'out', to: 'pub' }],
      },
    });
    const run = await s.waitRun((await s.api('POST', '/runs', { processId: pub.id })).id, ['succeeded', 'failed']);
    expect(run.status).toBe('succeeded');
    // A submitted change request with a link, so the record endpoints have something to show.
    const rec = await s.api('POST', '/records', { type: 'CR', title: 'API change', fields: { reason: 'r', risk: 'low', rollbackPlan: 'p' } });
    await s.api('PUT', `/records/${rec.id}`, { body: 'Changed\n', tags: ['api'] });
    await s.api('POST', `/records/${rec.id}/links`, { url: 'https://cmdb.example.com/1', label: 'CMDB' });
    await s.api('POST', `/records/${rec.id}/transition`, { action: 'submit', comment: 'ready' });
    adminCrawl = await crawl(tokens.admin);
  });

  it('matches the OpenAPI document', async () => {
    const templates = new Set(adminCrawl.map((c) => c.template));
    // every documented GET operation (except the document itself) was exercised
    for (const p of Object.keys(doc.paths)) if (p !== '/openapi.json') expect(templates, p).toContain(p);
    for (const c of adminCrawl) {
      expect(c.res.status, c.url).toBe(200);
      validate(c.template, c.res);
      expect(c.res.headers.get('cache-control')).toBe('no-store');
    }
    expect(adminCrawl.length).toBeGreaterThan(40);
  });

  it('never returns platform credentials or secret variables', async () => {
    const crawls = [adminCrawl, await crawl(tokens.audrey), await crawl(tokens.vera)];
    for (const c of crawls.flat()) {
      for (const secret of SECRETS) expect(c.res.text, `${c.url} leaks a secret`).not.toContain(secret);
      for (const t of Object.values(tokens)) expect(c.res.text).not.toContain(t);
      // platform metadata only (step outputs and audit details may legitimately use such field names)
      if (c.template.startsWith('/platforms')) expect(c.res.text, c.url).not.toMatch(/"(secrets|secretKeys|clientSecret|password|acl|variables|auth)"\s*:/);
    }
    const platforms = adminCrawl.filter((c) => c.template === '/platforms/{platformId}');
    expect(platforms.length).toBeGreaterThanOrEqual(2);
    for (const p of platforms) expect(Object.keys(p.res.body).sort()).toEqual(PLATFORM_KEYS);
  });

  it('pages dataset rows and detects re-publishing', async () => {
    const meta = await v1(tokens.vera, '/datasets/api.test');
    expect(meta.body).toMatchObject({ rowCount: 3, statusCounts: { good: 2, critical: 1 } });
    const p1 = await v1(tokens.vera, '/datasets/api.test/rows?limit=2');
    expect(p1.body.items.map((r: any) => r.name)).toEqual(['a', 'b']);
    const p2 = await v1(tokens.vera, `/datasets/api.test/rows?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((r: any) => r.name)).toEqual(['c']);
    expect(p2.body.nextCursor).toBeNull();
    const crit = await v1(tokens.vera, '/datasets/api.test/rows?status=critical');
    expect(crit.body.items.map((r: any) => r.name)).toEqual(['b']);
    const metrics = await v1(tokens.vera, '/datasets/api.test/metrics?names=total');
    expect(metrics.body.series[0].points.at(-1).value).toBe(3);
    // re-publish → an old cursor is refused
    const pid = (await v1(tokens.vera, '/datasets/api.test')).body.processId;
    await new Promise((r) => setTimeout(r, 5));
    await s.waitRun((await s.api('POST', '/runs', { processId: pid })).id, ['succeeded', 'failed']);
    const stale = await v1(tokens.vera, `/datasets/api.test/rows?limit=2&cursor=${p1.body.nextCursor}`);
    expect(stale.status).toBe(409);
    expect(stale.body.type).toMatch(/#dataset-changed$/);
  });
});

describe('rate limiting', () => {
  it('answers 429 with Retry-After and RateLimit headers', async () => {
    const before = process.env.SM_API_RATE_LIMIT;
    process.env.SM_API_RATE_LIMIT = '3';
    try {
      const t = await newToken(s.api, 'limited');
      const first = await v1(t, '/me');
      expect(first.headers.get('ratelimit-limit')).toBe('3');
      expect(first.headers.get('ratelimit-remaining')).toBe('2');
      expect(first.headers.get('ratelimit-policy')).toBe('3;w=60');
      await v1(t, '/me');
      await v1(t, '/me');
      const r = await v1(t, '/me');
      expect(r.status).toBe(429);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(r.body.type).toMatch(/#rate-limited$/);
      // other tokens have their own bucket
      expect((await v1(tokens.vera, '/me')).status).toBe(200);
    } finally {
      if (before === undefined) delete process.env.SM_API_RATE_LIMIT;
      else process.env.SM_API_RATE_LIMIT = before;
    }
  });
});

describe('documentation', () => {
  const docsPage = (headers: Record<string, string> = {}) => fetch(s.base + '/api/docs/', { headers: { accept: 'text/html', ...headers } });
  const env = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));

  it('defaults to signed-in users', async () => {
    env('SM_API_DOCS', undefined);
    expect((await docsPage()).status).toBe(401);
    expect((await fetch(s.base + '/api/docs/json')).status).toBe(401);
    expect((await v1(null, '/openapi.json')).status).toBe(401);
    const cookie = await sessionCookie('vera', PW);
    const page = await docsPage({ cookie });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('swagger-ui');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self';");
    expect((await fetch(s.base + '/api/docs/static/swagger-ui-bundle.js', { headers: { cookie } })).status).toBe(200);
    expect((await v1(null, '/openapi.json', { headers: { cookie } })).status).toBe(200);
    // a token always gets the document
    expect((await v1(tokens.vera, '/openapi.json')).status).toBe(200);
    const yaml = await v1(tokens.vera, '/openapi.yaml');
    expect(yaml.text).toContain('openapi: 3.1.0');
  });

  it('can be public or off (environment overrides the setting)', async () => {
    try {
      env('SM_API_DOCS', 'public');
      expect((await docsPage()).status).toBe(200);
      expect((await v1(null, '/openapi.json')).status).toBe(200);
      env('SM_API_DOCS', 'off');
      expect((await docsPage()).status).toBe(404);
      expect((await fetch(s.base + '/api/docs/static/swagger-ui-bundle.js')).status).toBe(404);
      expect((await v1(null, '/openapi.json')).status).toBe(404);
      expect((await v1(tokens.vera, '/openapi.json')).status).toBe(200);
      expect((await s.api('GET', '/public-api')).docsUrl).toBeNull();
      // setting (no environment variable)
      env('SM_API_DOCS', undefined);
      await s.api('PUT', '/settings', { apiDocs: 'off' });
      expect((await docsPage()).status).toBe(404);
      await s.api('PUT', '/settings', { apiDocs: 'public' });
      expect((await docsPage()).status).toBe(200);
      const st = await s.api('GET', '/public-api');
      expect(st).toMatchObject({ enabled: true, basePath: '/api/v1', docs: 'public', docsSource: 'settings', docsUrl: '/api/docs/' });
      env('SM_API_DOCS', 'authenticated');
      expect((await docsPage()).status).toBe(401);
      expect((await s.api('GET', '/public-api')).docsSource).toBe('env');
    } finally {
      env('SM_API_DOCS', undefined);
      await s.api('PUT', '/settings', { apiDocs: 'authenticated' });
    }
  });

  it('turns the whole API off with SM_API_V1=off', async () => {
    try {
      env('SM_API_V1', 'off');
      expect((await v1(tokens.admin, '/me')).status).toBe(404);
      expect((await v1(null, '/health')).status).toBe(404);
      expect((await docsPage({ cookie: await sessionCookie('vera', PW) })).status).toBe(404);
      expect((await s.api('GET', '/public-api')).enabled).toBe(false);
    } finally {
      env('SM_API_V1', undefined);
    }
    expect((await v1(tokens.admin, '/me')).status).toBe(200);
  });
});

describe('OpenAPI document', () => {
  it('is a structurally valid OpenAPI 3.1 document', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toMatchObject({ title: 'Steward API', license: { name: 'Apache-2.0', identifier: 'Apache-2.0' } });
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doc.servers).toEqual([expect.objectContaining({ url: '/api/v1' })]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'smt_ token' });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    const tagNames = new Set(doc.tags.map((t: any) => t.name));
    const opIds = new Set<string>();
    for (const [p, item] of Object.entries<any>(doc.paths)) {
      expect(p.startsWith('/')).toBe(true);
      expect(p).not.toMatch(/:|\/api\/v1/);
      expect(Object.keys(item)).toEqual(['get']);
      const op = item.get;
      expect(op.operationId).toMatch(/^[a-z][A-Za-z]+$/);
      expect(opIds.has(op.operationId)).toBe(false);
      opIds.add(op.operationId);
      expect(op.summary).toBeTruthy();
      for (const t of op.tags) expect(tagNames.has(t)).toBe(true);
      expect(op.responses['200']).toBeTruthy();
      for (const param of (p.match(/\{(\w+)\}/g) ?? []).map((x) => x.slice(1, -1))) {
        expect(op.parameters.find((x: any) => x.in === 'path' && x.name === param)?.required).toBe(true);
      }
    }
    // all local references resolve
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(50);
    for (const r of refs) {
      const target = r.split('/').reduce((o: any, k) => o?.[k], doc);
      expect(target, r).toBeTruthy();
    }
    // every component schema compiles as JSON Schema 2020-12
    for (const name of Object.keys(doc.components.schemas)) ajv.getSchema(`openapi#/components/schemas/${name}`) ?? ajv.compile({ $ref: `openapi#/components/schemas/${name}` });
  });

  it('is committed and up to date (npm run openapi -- --check)', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'server/src/cli/openapi.ts', '--check'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SM_DATA_DIR: s.dataDir },
    });
    expect(out).toBe('');
  });
});
