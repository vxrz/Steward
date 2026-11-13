import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Platform identities, steps 2 and 3 (0.13.0, ADR 0009): several identities per platform – created, changed, deleted,
 * sealed and audited; who may use them; choosing them for runs, schedules, triggers, sub-processes, monitors and MCP;
 * the read-only flag and the operation filter, enforced before anything is sent (HTTP and other steps, dry runs too).
 */
let s: TestServer;
let echo: http.Server;
let echoBase = '';
const PW = 'Demo-password-1';
let olivia: Client;
let dana: Client;

/** What the echo server saw: method, path and credential of every request */
const seen: { method: string; path: string; key: string | undefined }[] = [];
const lastFor = (path: string) => [...seen].reverse().find((r) => r.path === path);

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Directory', version: '1' },
  paths: {
    '/users': {
      get: { operationId: 'listUsers', responses: { 200: { description: 'ok' } } },
      post: { operationId: 'createUser', responses: { 201: { description: 'ok' } } },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
      delete: {
        operationId: 'deleteUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 204: { description: 'ok' } },
      },
    },
    '/users/me': { get: { operationId: 'me', responses: { 200: { description: 'ok' } } } },
    '/search': { post: { operationId: 'search', responses: { 200: { description: 'ok' } } } },
    '/hop': { get: { operationId: 'hop', responses: { 200: { description: 'ok' } } } },
  },
});

beforeAll(async () => {
  echo = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    seen.push({ method: req.method ?? '', path, key: req.headers['x-api-key'] as string | undefined });
    if (path === '/hop') {
      // a redirect to a path no operation of the filter allows
      res.writeHead(307, { location: '/elsewhere' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, path, method: req.method }));
  });
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  echoBase = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [olivia, dana] = await Promise.all(['olivia', 'dana'].map((u) => s.as(u, PW)));
  await s.api('PUT', '/mcp-server', { enabled: true });
}, 600_000);

const db = async () => (await import('../src/db.js')).db();
/** Audit entries, newest first */
const auditOf = async (query: string): Promise<any[]> => {
  const r = await s.api('GET', `/audit?${query}`);
  return r.items ?? r;
};

/** A platform on the echo server with an API key in a header (key of the default identity: default-key-…). */
async function platform(name: string, withSpec = true): Promise<any> {
  const p = await s.api('POST', '/platforms', {
    name,
    kind: 'generic',
    baseUrl: echoBase,
    config: {
      variables: { tenant: 'plant-a' },
      http: { proxy: 'none' },
      auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' },
      testPath: '/users',
    },
  });
  await s.api('PUT', `/platforms/${p.id}/secrets`, { apiKey: `default-key-${p.id.slice(3, 9)}` });
  if (withSpec) await s.api('POST', `/platforms/${p.id}/specs`, { name: 'Directory', content: SPEC });
  return s.api('GET', `/platforms/${p.id}`);
}

async function identity(p: any, body: Record<string, unknown>, key?: string): Promise<any> {
  const i = await s.api('POST', `/platforms/${p.id}/identities`, body);
  return key ? s.api('PUT', `/platforms/${p.id}/identities/${i.id}/secrets`, { apiKey: key }) : i;
}

const op = (ops: any[], operationId: string) => {
  const o = ops.find((x) => x.operationId === operationId);
  return { specId: o.specId, method: o.method, specPath: o.specPath ?? o.path };
};

/** A process with one http step per entry: [method, path]. Slots: api (and optionally the slot's identity requirement). */
async function process(name: string, steps: [string, string][], slot: Record<string, unknown> = {}): Promise<string> {
  const nodes: any[] = [{ id: 'start', type: 'start', x: 0, y: 0 }];
  const wires: any[] = [];
  steps.forEach(([method, path], i) => {
    nodes.push({ id: `s${i}`, type: 'http', connection: 'api', method, path, body: method === 'GET' ? undefined : { a: 1 }, x: i + 1, y: 0 });
    wires.push({ from: i ? `s${i - 1}` : 'start', port: 'out', to: `s${i}` });
  });
  return (await s.api('POST', '/processes', { definition: { name, connections: [{ slot: 'api', ...slot }], nodes, wires } })).id;
}

describe('managing identities', () => {
  it('creates closed identities with their own credentials, sealed and audited – never showing a secret', async () => {
    const p = await platform('Directory A');
    const i = await identity(p, { name: 'Reader', description: 'Reads the directory', variables: { role: 'READER' } }, 'reader-key-123456');
    expect(i).toMatchObject({ name: 'Reader', default: false, readOnly: false, mayUse: true, secretKeys: ['apiKey'], integrity: 'ok', acl: [] });
    // unique names (case-insensitive), the default identity cannot be deleted
    await expect(s.api('POST', `/platforms/${p.id}/identities`, { name: 'reader' })).rejects.toMatchObject({ status: 409 });
    const def = p.identities.find((x: any) => x.default);
    await expect(s.api('DELETE', `/platforms/${p.id}/identities/${def.id}`)).rejects.toMatchObject({ status: 409 });
    // a variable used where requests go cannot be overridden (base URL, token URL, trusted origins)
    const q = await s.api('POST', '/platforms', {
      name: 'Templated',
      kind: 'generic',
      baseUrl: 'https://{{ vars.host }}.example.com',
      config: { variables: { host: 'a' }, http: {}, auth: { type: 'none' } },
    });
    await expect(s.api('POST', `/platforms/${q.id}/identities`, { name: 'Other host', variables: { host: 'evil' } })).rejects.toMatchObject({
      status: 400,
      body: { code: 'IDENTITY_VARIABLE_FIXED' },
    });
    // an operation filter needs a specification
    await expect(
      s.api('POST', `/platforms/${q.id}/identities`, { name: 'Filtered', operationFilter: { preset: 'read', operations: [] } }),
    ).rejects.toMatchObject({
      body: { code: 'IDENTITY_FILTER_NOT_AVAILABLE' },
    });
    const settings = await s.api('GET', `/platforms/${p.id}/identities/${i.id}/settings`);
    expect(settings).toMatchObject({ auth: null, variables: { role: 'READER' } });
    const all = JSON.stringify([await s.api('GET', `/platforms/${p.id}`), await s.api('GET', `/platforms/${p.id}/identities`), settings]);
    expect(all).not.toContain('reader-key-123456');
    const audit = await auditOf(`entityId=${p.id}&limit=50`);
    const actions = audit.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.identity_created', 'platform.identity_secrets_changed']));
    expect(JSON.stringify(audit)).not.toContain('reader-key-123456');
    // rename audited with the old name
    await s.api('PUT', `/platforms/${p.id}/identities/${i.id}`, { name: 'Read only' });
    const renamed = (await auditOf(`entityId=${p.id}&action=platform.identity_updated`))[0];
    expect(renamed.summary).toContain('Directory A · Read only');
    expect(renamed.details).toMatchObject({ previousName: 'Reader' });
  });

  it('signs in with its own settings only at the platform’s own origins (IDENTITY_AUTH_ORIGIN)', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Directory sign-in',
      kind: 'generic',
      baseUrl: echoBase,
      config: {
        variables: { tenant: 'plant-a' },
        http: { proxy: 'none', trustedOrigins: ['https://login.example.com'] },
        auth: { type: 'oauth2_client_credentials', tokenUrl: 'https://idp.example.com/{{ vars.tenant }}/token', clientAuth: 'body' },
      },
    });
    const own = (tokenUrl: string, variables: Record<string, string> = {}) => ({
      name: `Own ${Math.random().toString(36).slice(2, 8)}`,
      auth: { type: 'oauth2_client_credentials', tokenUrl, clientAuth: 'body' },
      variables,
    });
    // the platform's origins: its base URL, a trusted origin, its own token URL's origin; a relative URL
    for (const ok of [`${echoBase}/oauth/token`, 'https://login.example.com/token', 'https://idp.example.com/other/token', '{{ baseUrl }}/token', '/token'])
      await s.api('POST', `/platforms/${p.id}/identities`, own(ok));
    // another host, an expression that cannot be checked, a variable that takes it elsewhere, a protocol-relative URL
    for (const bad of [
      'https://evil.example.net/token',
      '{{ $string(secrets.x) }}/token',
      'https://{{ vars.tenant }}.evil.example.net/token',
      '//evil.example.net/token',
    ])
      await expect(s.api('POST', `/platforms/${p.id}/identities`, own(bad)), bad).rejects.toMatchObject({
        status: 400,
        body: { code: 'IDENTITY_AUTH_ORIGIN' },
      });
    // a change of the sign-in settings is checked as well
    const i = await s.api('POST', `/platforms/${p.id}/identities`, { name: 'Changed later' });
    await expect(
      s.api('PUT', `/platforms/${p.id}/identities/${i.id}`, {
        auth: { type: 'token_request', request: { method: 'POST', url: 'https://evil.example.net/login' } },
      }),
    ).rejects.toMatchObject({ body: { code: 'IDENTITY_AUTH_ORIGIN' } });
  });

  it('is used by administrators, its access list and owning-team members – not by everyone with "use" on the platform', async () => {
    const p = await platform('Directory B');
    const i = await identity(p, { name: 'Admin' }, 'admin-key-1234567');
    const seenBy = async (c: Client) => ((await c('GET', `/platforms/${p.id}`)) as any).identities.find((x: any) => x.id === i.id);
    // olivia (operator) uses the platform and its default identity, sees the other one, but may not use it
    expect(await seenBy(olivia)).toMatchObject({ name: 'Admin', mayUse: false });
    expect(((await olivia('GET', `/platforms/${p.id}`)) as any).identities.find((x: any) => x.default).mayUse).toBe(true);
    await s.api('PUT', `/platforms/${p.id}/identities/${i.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['use'] }] });
    expect((await seenBy(olivia)).mayUse).toBe(true);
    // dana (designer) is not on the list
    expect((await seenBy(dana)).mayUse).toBe(false);
    // an owning team: its members with a role that uses platforms (designer, operator) use it
    const { setOwningTeams } = await import('../src/auth/policy.js');
    const d = await db();
    const team = { id: 'team_identity_test' };
    d.run("INSERT INTO teams (id, name, created_at) VALUES (?, 'Directory team', ?)", team.id, new Date().toISOString());
    const danaId = d.get<{ id: string }>("SELECT id FROM users WHERE username = 'dana'")!.id;
    d.run("INSERT INTO team_members (team_id, user_id, roles) VALUES (?, ?, '[]')", team.id, danaId);
    setOwningTeams('platform_identity', i.id, [team.id]);
    expect((await seenBy(dana)).mayUse).toBe(true);
    // the default identity has no access list of its own
    const def = p.identities.find((x: any) => x.default);
    await expect(s.api('PUT', `/platforms/${p.id}/identities/${def.id}/access`, { acl: [] })).rejects.toMatchObject({
      body: { code: 'IDENTITY_DEFAULT_NO_ACCESS_LIST' },
    });
    // managing is not using: a platform manager who is not listed may configure, not use
    // (since 0.23.0 the list is the identity's shares: audited as an access change on the identity)
    expect((await auditOf(`entityId=${i.id}&action=access.share_added`))[0].details).toMatchObject({
      subject: 'user:olivia',
      after: { level: 'view', actions: ['use'] },
    });
  });

  it('switches the default identity: audited, the new default is open to everyone, the former one closed', async () => {
    const p = await platform('Directory C');
    const i = await identity(p, { name: 'Least privilege' }, 'least-key-1234567');
    await s.api('PUT', `/platforms/${p.id}/identities/${i.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['use'] }] });
    await s.api('POST', `/platforms/${p.id}/identities/${i.id}/default`);
    const after = (await olivia('GET', `/platforms/${p.id}`)) as any;
    expect(after.identities[0]).toMatchObject({ id: i.id, default: true, mayUse: true });
    expect(after.identities.find((x: any) => x.name === 'Default')).toMatchObject({ default: false, mayUse: false });
    const e = (await auditOf(`entityId=${p.id}&action=platform.identity_default_changed`))[0];
    expect(e.details).toMatchObject({ previousDefault: { name: 'Default' }, clearedAccessList: [{ subject: 'user:dana', permissions: ['use'] }] });
    // requests that name no identity use the new default (caches are keyed by it)
    seen.length = 0;
    const { getPlatform, getSecrets } = await import('../src/platforms/service.js');
    const { platformRequest } = await import('../src/platforms/http.js');
    await platformRequest(getPlatform(p.id), getSecrets(p.id), { method: 'GET', url: '/users' });
    expect(lastFor('/users')?.key).toBe('least-key-1234567');
  });

  it('detects an identity changed in the database; confirming keeps it disabled until an administrator enables it', async () => {
    const p = await platform('Directory D');
    const i = await identity(p, { name: 'Writer' }, 'writer-key-1234567');
    await identity(p, { name: 'Reader', readOnly: true }, 'reader-key-1234567');
    const d = await db();
    d.run('UPDATE platform_identities SET read_only = 0 WHERE platform_id = ? AND name = ?', p.id, 'Reader');
    const after = await s.api('GET', `/platforms/${p.id}`);
    expect(after.integrity).toBe('mismatch');
    expect(after.identities.find((x: any) => x.name === 'Reader').integrity).toBe('mismatch');
    const { getConnection } = await import('../src/platforms/service.js');
    const reader = after.identities.find((x: any) => x.name === 'Reader');
    expect(() => getConnection(p.id, reader.id)).toThrow(/changed outside/);
    // binding the row to another platform is detected too
    const other = await platform('Directory D2', false);
    d.run('UPDATE platform_identities SET platform_id = ? WHERE id = ?', other.id, i.id);
    expect((await s.api('GET', `/platforms/${other.id}`)).identities.find((x: any) => x.id === i.id).integrity).toBe('mismatch');
    d.run('UPDATE platform_identities SET platform_id = ? WHERE id = ?', p.id, i.id);
    // the default identity and an identity whose seal verified are kept; the changed one is kept disabled
    const review = await s.api('GET', `/platforms/${p.id}/confirm-config`);
    expect(review.identities.map((x: any) => [x.name, x.action])).toEqual([
      ['Default', 'keep'],
      ['Reader', 'disable'],
      ['Writer', 'keep'],
    ]);
    await s.api('POST', `/platforms/${p.id}/confirm-config`);
    const confirmed = await s.api('GET', `/platforms/${p.id}`);
    expect(confirmed.integrity).toBe('ok');
    expect(confirmed.identities).toHaveLength(3);
    expect(confirmed.identities.find((x: any) => x.name === 'Reader')).toMatchObject({ disabled: true, mayUse: false, integrity: 'ok' });
    expect(getConnection(p.id, i.id).secrets).toEqual({ apiKey: 'writer-key-1234567' });
    // disabled: nothing is handed out, it cannot be chosen or made the default
    expect(() => getConnection(p.id, reader.id)).toThrow(/disabled/);
    const proc = await process('Read directory D', [['GET', '/users']]);
    await expect(s.api('POST', '/runs', { processId: proc, bindings: { api: p.id }, identities: { api: reader.id } })).rejects.toMatchObject({ status: 403 });
    await expect(s.api('POST', `/platforms/${p.id}/identities/${reader.id}/default`)).rejects.toMatchObject({ body: { code: 'IDENTITY_DISABLED' } });
    // enabling it in the database breaks its seal
    d.run('UPDATE platform_identities SET disabled = 0 WHERE id = ?', reader.id);
    expect((await s.api('GET', `/platforms/${p.id}`)).integrity).toBe('mismatch');
    d.run('UPDATE platform_identities SET disabled = 1 WHERE id = ?', reader.id);
    expect((await s.api('GET', `/platforms/${p.id}`)).integrity).toBe('ok');
    // an administrator enables it (step-up, audited with what it gives)
    await s.api('POST', `/platforms/${p.id}/identities/${reader.id}/enable`);
    expect((await s.api('GET', `/platforms/${p.id}`)).identities.find((x: any) => x.name === 'Reader')).toMatchObject({ mayUse: true, integrity: 'ok' });
    expect(getConnection(p.id, reader.id).secrets).toEqual({ apiKey: 'reader-key-1234567' });
    const enabled = (await auditOf(`entityId=${p.id}&action=platform.identity_enabled`))[0];
    expect(enabled.details).toMatchObject({ identityName: 'Reader', acl: [], secretKeys: ['apiKey'] });
    expect(JSON.stringify(enabled)).not.toContain('reader-key-1234567');
  });

  it('refuses deleting an identity a schedule still names, and an identity of another platform anywhere', async () => {
    const p = await platform('Directory E');
    const q = await platform('Directory F');
    const i = await identity(p, { name: 'Scheduled' }, 'scheduled-key-12345');
    const proc = await process('Read directory E', [['GET', '/users']]);
    const sched = await s.api('POST', '/schedules', {
      name: 'Nightly',
      processId: proc,
      cron: '0 3 * * *',
      bindings: { api: p.id },
      identities: { api: i.id },
      enabled: false,
    });
    expect(sched.identities).toEqual({ api: i.id });
    await expect(s.api('DELETE', `/platforms/${p.id}/identities/${i.id}`)).rejects.toMatchObject({ status: 409, body: { code: 'IDENTITY_IN_USE' } });
    // an identity of platform E bound to platform F: not found, nothing is sent
    await expect(s.api('POST', '/runs', { processId: proc, bindings: { api: q.id }, identities: { api: i.id } })).rejects.toMatchObject({
      status: 404,
      body: { code: 'IDENTITY_NOT_FOUND' },
    });
    const { getConnection } = await import('../src/platforms/service.js');
    expect(() => getConnection(q.id, i.id)).toThrow(/not found/);
    await s.api('DELETE', `/schedules/${sched.id}`);
    await s.api('DELETE', `/platforms/${p.id}/identities/${i.id}`);
    expect((await s.api('GET', `/platforms/${p.id}`)).identities).toHaveLength(1);
  });
});

describe('choosing the identity', () => {
  let p: any;
  let admin: any;
  let proc: string;
  beforeAll(async () => {
    p = await platform('Directory runs');
    admin = await identity(p, { name: 'Admin' }, 'admin-run-key-1234');
    proc = await process('Read users', [['GET', '/users']]);
  });

  it('runs with the identity chosen per slot, recorded with its name; a missing slot uses the default', async () => {
    seen.length = 0;
    const r1 = await s.waitRun((await s.api('POST', '/runs', { processId: proc, bindings: { api: p.id }, identities: { api: admin.id } })).id);
    expect(r1.status).toBe('succeeded');
    expect(lastFor('/users')?.key).toBe('admin-run-key-1234');
    expect(r1.bindings.api).toMatchObject({ platformId: p.id, identityId: admin.id, identityName: 'Admin' });
    const started = (await auditOf(`runId=${r1.id}&action=run.started`))[0];
    expect(started.details.bindings.api).toMatchObject({ identityId: admin.id, identityName: 'Admin' });
    const r2 = await s.waitRun((await s.api('POST', '/runs', { processId: proc, bindings: { api: p.id } })).id);
    expect(r2.status).toBe('succeeded');
    expect(lastFor('/users')?.key).toMatch(/^default-key-/);
    expect(r2.bindings.api.identityName).toBe('Default');
  });

  it('checks the identity for the person starting the run, schedules and triggers when saved', async () => {
    await expect(olivia('POST', '/runs', { processId: proc, bindings: { api: p.id }, identities: { api: admin.id } })).rejects.toMatchObject({
      status: 403,
      body: { code: 'IDENTITY_NOT_ALLOWED' },
    });
    await expect(
      olivia('POST', '/schedules', { name: 'Not mine', processId: proc, cron: '0 3 * * *', bindings: { api: p.id }, identities: { api: admin.id } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      olivia('POST', '/triggers', { name: 'Not mine', processId: proc, bindings: { api: p.id }, identities: { api: admin.id } }),
    ).rejects.toMatchObject({ status: 403 });
    // the default identity is open to her, as before
    const ok = await olivia('POST', '/runs', { processId: proc, bindings: { api: p.id } });
    expect((await s.waitRun(ok.id)).status).toBe('succeeded');
  });

  it('skips a scheduled fire and a webhook fire when the owner may no longer use the identity', async () => {
    await s.api('PUT', `/platforms/${p.id}/identities/${admin.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['use'] }] });
    const sched = await olivia('POST', '/schedules', {
      name: 'As olivia',
      processId: proc,
      cron: '0 3 * * *',
      bindings: { api: p.id },
      identities: { api: admin.id },
      enabled: false,
    });
    const trig = await olivia('POST', '/triggers', { name: 'As olivia', processId: proc, bindings: { api: p.id }, identities: { api: admin.id } });
    await s.api('PUT', `/platforms/${p.id}/identities/${admin.id}/access`, { acl: [] });
    const { fire } = await import('../src/scheduler.js');
    const { clearPlatformAccessCache } = await import('../src/monitors/platforms.js');
    clearPlatformAccessCache();
    expect(await fire(sched.id)).toBeNull();
    const skipped = (await auditOf(`entityId=${sched.id}&action=schedule.skipped`))[0];
    expect(skipped.summary).toMatch(/may not use the identity "Admin"/);
    const res = await fetch(`${s.base}/api/hooks/${trig.trigger.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${trig.secret}` },
      body: '{}',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ skipped: 'not permitted' });
    await olivia('DELETE', `/schedules/${sched.id}`);
    await olivia('DELETE', `/triggers/${trig.trigger.id}`);
  });

  it('passes the identity on to a sub-process, which cannot choose another one', async () => {
    const child = await process('Child reads', [['GET', '/users']]);
    const parent = (
      await s.api('POST', '/processes', {
        definition: {
          name: 'Parent',
          connections: [{ slot: 'api' }],
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            { id: 'sub', type: 'subprocess', process: child, x: 1, y: 0 },
          ],
          wires: [{ from: 'start', port: 'out', to: 'sub' }],
        },
      })
    ).id;
    seen.length = 0;
    const r = await s.waitRun((await s.api('POST', '/runs', { processId: parent, bindings: { api: p.id }, identities: { api: admin.id } })).id, [
      'succeeded',
      'failed',
    ]);
    expect(r.status).toBe('succeeded');
    expect(lastFor('/users')?.key).toBe('admin-run-key-1234');
    const runs = (await s.api('GET', `/runs?processId=${child}`)) as any;
    const childRun = await s.api('GET', `/runs/${(runs.items ?? runs)[0].id}`);
    expect(childRun.bindings.api).toMatchObject({ identityId: admin.id });
  });

  it('refuses a read-only identity for a slot that needs writes', async () => {
    const ro = await identity(p, { name: 'Read only', readOnly: true }, 'ro-run-key-1234567');
    const writer = await process('Writes users', [['POST', '/users']], { identity: { writes: true } });
    await expect(s.api('POST', '/runs', { processId: writer, bindings: { api: p.id }, identities: { api: ro.id } })).rejects.toMatchObject({
      status: 403,
      body: { code: 'IDENTITY_WRITE_REQUIRED' },
    });
  });

  it('resumes a queued run with its identity and fails it when the identity is gone (never another one)', async () => {
    const d = await db();
    const gone = await identity(p, { name: 'Gone soon' }, 'gone-key-123456789');
    const r = await s.waitRun((await s.api('POST', '/runs', { processId: proc, bindings: { api: p.id }, identities: { api: gone.id } })).id);
    expect(r.status).toBe('succeeded');
    // the run as stored names the identity; a queued copy of it would resolve by id
    const stored = JSON.parse(d.get<{ bindings: string }>('SELECT bindings FROM runs WHERE id = ?', r.id)!.bindings);
    expect(stored.api).toMatchObject({ identityId: gone.id, identityName: 'Gone soon' });
    await s.api('DELETE', `/platforms/${p.id}/identities/${gone.id}`);
    const { engine } = await import('../src/engine/index.js');
    await expect(
      engine().start({
        processId: proc,
        inputs: {},
        bindings: { api: p.id },
        identities: { api: gone.id },
        mode: 'live',
        actor: 'admin',
        origin: { trigger: 'manual' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });
});

describe('read-only identities and the operation filter', () => {
  let p: any;
  let ops: any[];
  beforeAll(async () => {
    p = await platform('Directory guarded');
    ops = await s.api('GET', `/platforms/${p.id}/operations`);
  });

  it('refuses writes of a read-only identity before anything is sent – live, dry and test runs', async () => {
    const ro = await identity(p, { name: 'Viewer', readOnly: true }, 'viewer-key-1234567');
    const writes = await process('Delete a user', [['DELETE', '/users/42']]);
    for (const mode of [{}, { dryRun: true }, { recorded: true }]) {
      seen.length = 0;
      const r = await s.waitRun((await s.api('POST', '/runs', { processId: writes, bindings: { api: p.id }, identities: { api: ro.id }, ...mode })).id);
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/read-only/);
      expect(seen.filter((x) => x.method === 'DELETE')).toEqual([]);
    }
    // reads pass
    const reads = await process('Read a user', [['GET', '/users/42']]);
    expect((await s.waitRun((await s.api('POST', '/runs', { processId: reads, bindings: { api: p.id }, identities: { api: ro.id } })).id)).status).toBe(
      'succeeded',
    );
    const refused = (await auditOf(`entityId=${p.id}&action=platform.identity_refused`))[0];
    expect(refused.summary).toContain('Directory guarded · Viewer');
    // a step's mutating: false does not make a POST a read; Steward's own reads (intent read) pass
    const { getConnection } = await import('../src/platforms/service.js');
    const { platformRequest } = await import('../src/platforms/http.js');
    const c = getConnection(p.id, ro.id);
    await expect(platformRequest(c.platform, c.secrets, { method: 'POST', url: '/search', body: {} })).rejects.toMatchObject({ code: 'IDENTITY_READ_ONLY' });
    expect((await platformRequest(c.platform, c.secrets, { method: 'POST', url: '/search', body: {}, intent: 'read' })).status).toBe(200);
    // the request explorer: the same rule, for whoever uses the identity
    await expect(s.api('POST', `/platforms/${p.id}/request`, { method: 'POST', path: '/users', body: {}, identityId: ro.id })).rejects.toMatchObject({
      status: 403,
      body: { code: 'IDENTITY_READ_ONLY' },
    });
  });

  it('refuses access-change steps and browser interactions through a read-only identity', async () => {
    const ro = (await s.api('GET', `/platforms/${p.id}`)).identities.find((x: any) => x.name === 'Viewer');
    const ac = (
      await s.api('POST', '/processes', {
        definition: {
          name: 'Document a grant',
          connections: [{ slot: 'api' }],
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            { id: 'doc', type: 'accessChange', connection: 'api', kind: 'grant', subjectId: "'u1'", rights: "'admin'", x: 1, y: 0 },
          ],
          wires: [{ from: 'start', port: 'out', to: 'doc' }],
        },
      })
    ).id;
    const r = await s.waitRun((await s.api('POST', '/runs', { processId: ac, bindings: { api: p.id }, identities: { api: ro.id }, dryRun: true })).id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/read-only/);
  });

  it('lets only the operations of the filter through – the most specific operation decides, unmatched paths are refused', async () => {
    const f = await identity(
      p,
      { name: 'Lookups', operationFilter: { preset: 'chosen', operations: [op(ops, 'getUser'), op(ops, 'search'), op(ops, 'hop')] } },
      'lookup-key-1234567',
    );
    const { getConnection } = await import('../src/platforms/service.js');
    const { platformRequest } = await import('../src/platforms/http.js');
    const c = getConnection(p.id, f.id);
    const call = (method: string, url: string) => platformRequest(c.platform, c.secrets, { method, url, ...(method === 'POST' ? { body: {} } : {}) });
    seen.length = 0;
    expect((await call('GET', '/users/42')).status).toBe(200);
    expect((await call('HEAD', '/users/42')).status).toBe(200);
    expect((await call('POST', '/search')).status).toBe(200);
    for (const [m, u] of [
      ['GET', '/users/me'], // /users/{id} is allowed, but /users/me is an operation of its own
      ['GET', '/users/ME'],
      ['GET', '/users'],
      ['DELETE', '/users/42'],
      ['GET', '/undocumented'],
      ['GET', '/users/42/extra'],
      ['GET', '/users/a%2Fb'],
      ['GET', '/users/..%2Fusers'],
      ['GET', '/users/42;x=1'],
      ['GET', `${echoBase.replace('127.0.0.1', 'localhost')}/users/42`],
    ])
      await expect(call(m!, u!), `${m} ${u}`).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_REFUSED' });
    // a redirect to a path outside the filter: refused before the second hop is sent
    await expect(call('GET', '/hop')).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_REFUSED' });
    expect(seen.map((x) => x.path)).not.toContain('/elsewhere');
    expect(seen.map((x) => `${x.method} ${x.path}`).sort()).toEqual(['GET /hop', 'GET /users/42', 'HEAD /users/42', 'POST /search'].sort());
    // the read preset: every GET and HEAD, no changing operation
    const r = await identity(p, { name: 'Read preset', operationFilter: { preset: 'read', operations: [] } }, 'read-preset-key-12');
    const c2 = getConnection(p.id, r.id);
    expect((await platformRequest(c2.platform, c2.secrets, { method: 'GET', url: '/users/me' })).status).toBe(200);
    await expect(platformRequest(c2.platform, c2.secrets, { method: 'POST', url: '/users', body: {} })).rejects.toMatchObject({
      code: 'IDENTITY_OPERATION_REFUSED',
    });
    // a read-only identity: a POST only where the filter chose it
    const ro = await identity(
      p,
      { name: 'Read search', readOnly: true, operationFilter: { preset: 'read', operations: [op(ops, 'search')] } },
      'ro-search-key-1234',
    );
    const c3 = getConnection(p.id, ro.id);
    expect((await platformRequest(c3.platform, c3.secrets, { method: 'POST', url: '/search', body: {} })).status).toBe(200);
    await expect(platformRequest(c3.platform, c3.secrets, { method: 'POST', url: '/users', body: {} })).rejects.toMatchObject({
      code: 'IDENTITY_OPERATION_REFUSED',
    });
    // a connection test outside the filter says so
    const t = await s.api('POST', `/platforms/${p.id}/identities/${f.id}/test`);
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/operation filter/);
  });

  it('keeps references through a new path prefix, marks stale ones after a spec is removed and fails closed', async () => {
    const q = await platform('Directory stale');
    const qops = await s.api('GET', `/platforms/${q.id}/operations`);
    const f = await identity(q, { name: 'Users only', operationFilter: { preset: 'chosen', operations: [op(qops, 'getUser')] } }, 'stale-key-12345678');
    const spec = (await s.api('GET', `/platforms/${q.id}/specs`))[0];
    await s.api('DELETE', `/platforms/${q.id}/specs/${spec.id}`);
    const deleted = (await auditOf(`entityId=${q.id}&action=platform.spec_deleted`))[0];
    expect(deleted.details.identities).toEqual([{ id: f.id, name: 'Users only' }]);
    expect((await s.api('GET', `/platforms/${q.id}`)).identities.find((x: any) => x.id === f.id).staleOperations).toBe(1);
    const settings = await s.api('GET', `/platforms/${q.id}/identities/${f.id}/settings`);
    expect(settings.operations[0]).toMatchObject({ stale: true, path: null });
    const { getConnection } = await import('../src/platforms/service.js');
    const { platformRequest } = await import('../src/platforms/http.js');
    const c = getConnection(q.id, f.id);
    await expect(platformRequest(c.platform, c.secrets, { method: 'GET', url: '/users/1' })).rejects.toMatchObject({ code: 'IDENTITY_OPERATION_REFUSED' });
  });

  it('copies operation filters with "Copy specs" when asked: same name gets the filter, others are created closed without credentials', async () => {
    const src = await platform('Copy source');
    const sops = await s.api('GET', `/platforms/${src.id}/operations`);
    await identity(src, { name: 'Lookups', readOnly: true, operationFilter: { preset: 'chosen', operations: [op(sops, 'getUser')] } }, 'copy-src-key-12345');
    const target = await platform('Copy target', false);
    const spec = (await s.api('GET', `/platforms/${src.id}/specs`))[0];
    const r = await s.api('POST', `/platforms/${src.id}/specs/${spec.id}/copy`, { targets: [target.id], copyFilters: true });
    expect(r.filters[target.id]).toMatchObject({ created: ['Lookups'] });
    const t = (await s.api('GET', `/platforms/${target.id}`)).identities.find((x: any) => x.name === 'Lookups');
    expect(t).toMatchObject({ readOnly: true, secretKeys: [], acl: [], mcp: { mode: 'off' }, operationFilter: { preset: 'chosen' } });
    expect(t.operationFilter.operations[0].specId).toBe(r.copied[0].specId);
  });

  it('carries identity templates in connector types: names, flags and filters – never credentials or access', async () => {
    const src = await platform('Template source');
    const sops = await s.api('GET', `/platforms/${src.id}/operations`);
    const i = await identity(
      src,
      { name: 'Lookups', readOnly: true, operationFilter: { preset: 'chosen', operations: [op(sops, 'getUser')] } },
      'tpl-key-1234567890',
    );
    await s.api('PUT', `/platforms/${src.id}/identities/${i.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['use'] }] });
    const type = await s.api('POST', '/platform-types', { fromPlatformId: src.id, kind: 'directory-tpl', label: 'Directory type' });
    const pkg = await s.api('GET', `/platform-types/${type.kind}/export`);
    expect(pkg.identities).toEqual([
      { name: 'Default', default: true },
      { name: 'Lookups', readOnly: true, operationFilter: { preset: 'chosen', operations: ['GET /users/{id}'] } },
    ]);
    expect(JSON.stringify(pkg)).not.toContain('tpl-key-1234567890');
    expect(JSON.stringify(pkg)).not.toContain('olivia');
    const made = await s.api('POST', '/platforms', { name: 'From type', typeKind: type.kind, baseUrl: echoBase });
    const lookups = made.identities.find((x: any) => x.name === 'Lookups');
    expect(lookups).toMatchObject({ readOnly: true, secretKeys: [], acl: [], mcp: { mode: 'off' } });
    expect(lookups.operationFilter.operations).toHaveLength(1);
  });
});

describe('monitors', () => {
  it('read with the identity a check names, checked for the owner when saved and at every run', async () => {
    const p = await platform('Directory monitored');
    const i = await identity(p, { name: 'Monitoring' }, 'monitoring-key-12345');
    const ro = await identity(p, { name: 'Read only', readOnly: true }, 'monitoring-ro-key-1');
    const check = { id: 'users', name: 'Users', type: 'platform', platform: p.id, identity: 'Monitoring', method: 'GET', path: '/users' };
    // dana may not use it: refused when saved
    await expect(dana('POST', '/monitors', { definition: { name: 'Not mine', checks: [check] } })).rejects.toMatchObject({
      status: 403,
      body: { code: 'IDENTITY_NOT_ALLOWED' },
    });
    const created = await s.api('POST', '/monitors', { definition: { name: 'Directory', checks: [check] } });
    const m = await s.api('GET', `/monitors/${created.monitor?.id ?? created.id}`);
    expect(m.definition.checks[0].identity).toBe(i.id);
    seen.length = 0;
    await s.api('POST', `/monitors/${m.id}/run`);
    expect(lastFor('/users')?.key).toBe('monitoring-key-12345');
    // an output never sends with a read-only identity
    await expect(
      s.api('PUT', `/monitors/${m.id}`, {
        definition: { ...m.definition, outputs: [{ id: 'out', type: 'webhook', platform: p.id, identity: ro.id, path: '/hook' }] },
      }),
    ).rejects.toMatchObject({ body: { code: 'IDENTITY_READ_ONLY' } });
    // the identity's name in a monitor holds the identity back from deletion
    await expect(s.api('DELETE', `/platforms/${p.id}/identities/${i.id}`)).rejects.toMatchObject({ body: { code: 'IDENTITY_IN_USE' } });
  });
});

describe('MCP', () => {
  it('uses the identity a client names; the mode, read-only flag and filter are per identity', async () => {
    const p = await platform('Directory MCP');
    const ops = await s.api('GET', `/platforms/${p.id}/operations`);
    const ro = await identity(p, { name: 'MCP reader', readOnly: true }, 'mcp-reader-key-1234');
    await s.api('PUT', `/platforms/${p.id}/identities/${ro.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['use'] }] });
    await s.api('PUT', `/platforms/${p.id}/identities/${ro.id}/mcp`, { mode: 'read' });
    const filtered = await identity(p, { name: 'MCP lookups', operationFilter: { preset: 'chosen', operations: [op(ops, 'getUser')] } }, 'mcp-lookup-key-1234');
    await s.api('PUT', `/platforms/${p.id}/identities/${filtered.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['use'] }] });
    await s.api('PUT', `/platforms/${p.id}/identities/${filtered.id}/mcp`, { mode: 'writes', writes: 'confirm' });
    const token = (await olivia('POST', '/me/tokens', { name: 'mcp ident', scope: 'mcp' })).token;
    let n = 1;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: n++, method: 'tools/call', params: { name, arguments: args } }),
      });
      const body = (await res.json()) as any;
      return { isError: !!body.result?.isError, data: body.result?.isError ? body.result.content[0].text : body.result?.structuredContent, body };
    };
    const list = await call('list_platforms', {});
    const item = list.data.items.find((x: any) => x.id === p.id);
    expect(item.mcpGateway).toBe(true);
    expect(item.mcpIdentities.map((x: any) => x.name).sort()).toEqual(['MCP lookups', 'MCP reader']);
    // the default identity is off: a call without `identity` says which ones to name
    expect((await call('platform_find_operations', { platformId: p.id })).data).toMatch(/name one with `identity`/);
    seen.length = 0;
    const read = await call('platform_call_operation', { platformId: p.id, identity: 'MCP reader', operation: 'listUsers' });
    expect(read.isError).toBe(false);
    expect(lastFor('/users')?.key).toBe('mcp-reader-key-1234');
    // the read-only identity offers no changing operation; the filtered one only its operations
    const roOps = (await call('platform_find_operations', { platformId: p.id, identity: 'MCP reader' })).data.items.map((o: any) => o.method);
    expect(roOps.every((m: string) => m === 'GET')).toBe(true);
    const fOps = (await call('platform_find_operations', { platformId: p.id, identity: 'MCP lookups' })).data.items.map((o: any) => o.operation);
    expect(fOps).toEqual(['getUser']);
    expect((await call('platform_call_operation', { platformId: p.id, identity: 'MCP lookups', operation: 'listUsers' })).data).toMatch(/operation filter/);
    // a changing call through an identity whose filter does not allow it is refused before a request is created
    const del = await call('platform_call_operation', {
      platformId: p.id,
      identity: 'MCP lookups',
      operation: 'deleteUser',
      pathParams: { id: '7' },
      reason: 'Remove the test account',
    });
    expect(del.data).toMatch(/operation filter/);
    const audit = (await auditOf(`entityId=${p.id}&action=mcp.gateway_call`))[0];
    expect(audit.details).toMatchObject({ identityName: 'MCP reader' });
    expect(audit.summary).toContain('Directory MCP · MCP reader');
  });
});

describe('key rotation', () => {
  it('re-encrypts the credentials of every identity; seals and requests stay intact', async () => {
    const p = await platform('Rotation identities');
    const i = await identity(p, { name: 'Second' }, 'second-rotation-key-1');
    const r = await s.api('POST', '/vault/passphrase', { current: 'correct horse battery', next: 'a rotated passphrase 2026', rotateDataKey: true });
    expect(r.rotated).toBe(true);
    try {
      const after = await s.api('GET', `/platforms/${p.id}`);
      expect(after.identities.map((x: any) => x.integrity)).toEqual(['ok', 'ok']);
      const { getConnection } = await import('../src/platforms/service.js');
      expect(getConnection(p.id, i.id).secrets).toEqual({ apiKey: 'second-rotation-key-1' });
    } finally {
      await s.api('POST', '/vault/passphrase', { current: 'a rotated passphrase 2026', next: 'correct horse battery', rotateDataKey: false });
    }
  });
});
