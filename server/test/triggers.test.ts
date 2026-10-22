import crypto from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

let s: TestServer;
let olivia: Client, dana: Client, vera: Client;
let hub: string;
const PW = 'Demo-password-1';
/** Every secret handed out in this file – none of them may show up anywhere else. */
const secrets: string[] = [];
const logged: string[] = [];

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A raw call to the inbound endpoint, like Gatus or curl would send it (no session, no x-sm-client header). */
async function hook(id: string, body: unknown, headers: Record<string, string> = {}, query = '') {
  const res = await fetch(`${s.base}/api/hooks/${id}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
const sign = (secret: string, raw: string) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

const PROCESS = {
  name: 'Hook target',
  connections: [{ slot: 'hub', kind: 'insights-hub' }],
  inputs: [
    { name: 'endpoint', type: 'string', required: true },
    { name: 'severity', type: 'string', default: 'low' },
    { name: 'count', type: 'number' },
  ],
  steps: [{ id: 'note', type: 'log', message: 'alert for {{ inputs.endpoint }} ({{ inputs.severity }})' }],
};
const WAITING = {
  name: 'Hook target with approval',
  inputs: [{ name: 'endpoint', type: 'string' }],
  steps: [{ id: 'ok', type: 'userTask', mode: 'approve', title: 'Go on?' }],
};

async function create(c: Client, body: Record<string, unknown>) {
  const r = await c('POST', '/triggers', { name: 'Gatus alerts', processId: 'hook-target', bindings: { hub }, ...body });
  secrets.push(r.secret);
  return r as { trigger: any; secret: string };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
  await s.api('POST', '/processes', { definition: { ...PROCESS } });
  await s.api('POST', '/processes', { definition: { ...WAITING } });
  [olivia, dana, vera] = await Promise.all(['olivia', 'dana', 'vera'].map((u) => s.as(u, PW)));
  // imported after the test server set SM_* (config is read on import)
  const { logger } = await import('../src/log.js');
  for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    }) as never);
  }
});
afterAll(async () => {
  vi.restoreAllMocks();
  await s?.app.close();
});

describe('webhook triggers', () => {
  let t: { trigger: any; secret: string };

  it('creates a trigger owned by the creator and shows the secret only once', async () => {
    t = await create(olivia, {
      inputMapping: { endpoint: 'body.name', severity: "headers.'x-severity'", count: '$number(query.n)' },
      allowedHeaders: ['X-Severity'],
      dedupeSeconds: 0,
    });
    expect(t.secret).toMatch(/^whs_[A-Za-z0-9_-]{40,}$/);
    expect(t.trigger).toMatchObject({ owner: 'olivia', enabled: true, authMode: 'token', allowedHeaders: ['x-severity'], path: `/api/hooks/${t.trigger.id}` });
    expect(t.secret.startsWith(t.trigger.secretPrefix)).toBe(true);
    const again = await olivia('GET', `/triggers/${t.trigger.id}`);
    expect(JSON.stringify(again)).not.toContain(t.secret);
    expect(JSON.stringify(await olivia('GET', '/triggers'))).not.toContain(t.secret);
  });

  it('starts a run as the owner with inputs mapped from body, allow-listed headers and query', async () => {
    const r = await hook(t.trigger.id, { name: 'Historian API', group: 'plant' }, { ...bearer(t.secret), 'x-severity': 'high', 'x-other': 'ignored' }, '?n=3');
    expect(r.status).toBe(202);
    expect(r.body.runId).toMatch(/^run_/);
    expect(JSON.stringify(r.body)).not.toContain(t.secret);
    const run = await s.waitRun(r.body.runId);
    expect(run).toMatchObject({
      status: 'succeeded',
      trigger: 'webhook',
      actor: 'olivia',
      triggerId: t.trigger.id,
      triggerName: 'Gatus alerts',
      dryRun: false,
    });
    expect(run.inputs).toEqual({ endpoint: 'Historian API', severity: 'high', count: 3 });
    const tr = await olivia('GET', `/triggers/${t.trigger.id}`);
    expect(tr).toMatchObject({ fireCount: 1, lastRunId: r.body.runId, lastResult: 'started' });
    const html = await s.api('GET', `/runs/${r.body.runId}/report.html`);
    expect(html).toContain('Gatus alerts');
  });

  it('accepts X-Steward-Token and needs no CSRF header, even with a cookie', async () => {
    const r = await hook(t.trigger.id, { name: 'A' }, { 'x-steward-token': t.secret, cookie: 'sm_session=whatever' });
    expect(r.status).toBe(202);
    // ordinary API routes still demand the header
    const other = await fetch(`${s.base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'x=1' }, body: '{}' });
    expect(other.status).toBe(403);
  });

  it('answers 401 for a wrong or missing secret and 404 for unknown and disabled triggers', async () => {
    expect((await hook(t.trigger.id, { name: 'A' }, bearer('whs_wrong'))).status).toBe(401);
    expect((await hook(t.trigger.id, { name: 'A' }, { 'x-steward-token': t.secret.slice(0, -1) })).status).toBe(401);
    expect((await hook(t.trigger.id, { name: 'A' })).status).toBe(401);
    const unknown = await hook('wht_doesnotexist123', { name: 'A' }, bearer(t.secret));
    expect(unknown).toMatchObject({ status: 404, body: { error: 'Not found' } });
    // fetch normalises /api/hooks/../processes to /api/processes: an ordinary route that still wants a session
    expect((await hook('../processes', { name: 'A' }, bearer(t.secret))).status).toBe(401);
    const d = await create(olivia, { name: 'Disabled', enabled: false, inputMapping: { endpoint: 'body.name' } });
    const disabled = await hook(d.trigger.id, { name: 'A' }, bearer(d.secret));
    expect(disabled).toMatchObject({ status: 404, body: unknown.body });
  });

  it('rejects non-JSON (415), invalid JSON (400) and bodies over 64 KB (413)', async () => {
    const res = await fetch(`${s.base}/api/hooks/${t.trigger.id}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...bearer(t.secret) },
      body: 'hello',
    });
    expect(res.status).toBe(415);
    const noType = await fetch(`${s.base}/api/hooks/${t.trigger.id}`, { method: 'POST', headers: bearer(t.secret), body: '{}' });
    expect(noType.status).toBe(415);
    expect((await hook(t.trigger.id, '{"name": ', bearer(t.secret))).status).toBe(400);
    expect((await hook(t.trigger.id, { name: 'x'.repeat(70 * 1024) }, bearer(t.secret))).status).toBe(413);
  });

  it('verifies HMAC signatures over the raw body', async () => {
    const h = await create(olivia, { name: 'Signed', authMode: 'hmac', inputMapping: { endpoint: 'body.name' } });
    const raw = JSON.stringify({ name: 'signed endpoint' });
    expect((await hook(h.trigger.id, raw, { 'x-steward-signature': sign(h.secret, raw) })).status).toBe(202);
    expect((await hook(h.trigger.id, raw, { 'x-steward-signature': sign(h.secret, raw + ' ') })).status).toBe(401);
    expect((await hook(h.trigger.id, raw, { 'x-steward-signature': sign('whs_other', raw) })).status).toBe(401);
    expect((await hook(h.trigger.id, raw, bearer(h.secret))).status).toBe(401); // static token not accepted in hmac mode
    await olivia('PUT', `/triggers/${h.trigger.id}`, { ...h.trigger, authMode: 'either' });
    expect((await hook(h.trigger.id, { name: 'token now ok' }, bearer(h.secret))).status).toBe(202);
  });

  it('rate-limits accepted calls per trigger (429 with Retry-After)', async () => {
    const rl = await create(olivia, {
      name: 'Limited',
      rateLimitPerMinute: 3,
      dedupeSeconds: 0,
      skipIfRunning: false,
      inputMapping: { endpoint: 'body.name' },
    });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await hook(rl.trigger.id, { name: `n${i}` }, bearer(rl.secret))).status);
    expect(codes).toEqual([202, 202, 202, 429, 429]);
    const r = await hook(rl.trigger.id, { name: 'again' }, bearer(rl.secret));
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    const tr = await olivia('GET', `/triggers/${rl.trigger.id}`);
    expect(tr.rejectedCount).toBe(3);
    expect(tr.lastRejectedReason).toBe('rate limit exceeded');
  });

  it('ignores identical payloads within the dedupe window', async () => {
    const dd = await create(olivia, { name: 'Deduped', dedupeSeconds: 60, skipIfRunning: false, inputMapping: { endpoint: 'body.name' } });
    const a = await hook(dd.trigger.id, { name: 'same' }, bearer(dd.secret));
    const b = await hook(dd.trigger.id, { name: 'same' }, bearer(dd.secret));
    const c = await hook(dd.trigger.id, { name: 'different' }, bearer(dd.secret));
    expect([a.status, b.status, c.status]).toEqual([202, 202, 202]);
    expect(a.body.runId).toBeTruthy();
    expect(b.body).toEqual({ skipped: 'duplicate' });
    expect(c.body.runId).toBeTruthy();
  });

  it('skips while the previous run of the trigger is still waiting', async () => {
    const w = await create(olivia, {
      name: 'Waiting',
      processId: 'hook-target-with-approval',
      bindings: {},
      dedupeSeconds: 0,
      inputMapping: { endpoint: 'body.name' },
    });
    const a = await hook(w.trigger.id, { name: 'one' }, bearer(w.secret));
    await s.waitRun(a.body.runId, ['waiting']);
    const b = await hook(w.trigger.id, { name: 'two' }, bearer(w.secret));
    expect(b).toMatchObject({ status: 202, body: { skipped: 'previous run still active' } });
    await s.api('POST', `/runs/${a.body.runId}/cancel`);
  });

  it('re-checks the owner on every call: no run permission → skipped and audited', async () => {
    await s.api('PUT', '/processes/hook-target/access', { acl: [{ subject: 'user:dana', permissions: ['view', 'run'] }] });
    try {
      const r = await hook(t.trigger.id, { name: 'after ACL change' }, bearer(t.secret));
      expect(r).toMatchObject({ status: 202, body: { skipped: 'not permitted' } });
      const audit = await s.api('GET', `/audit?entityId=${t.trigger.id}&limit=20`);
      const skipped = audit.find((a: any) => a.action === 'trigger.skipped');
      expect(skipped.summary).toContain('olivia may not run process hook-target');
      expect((await s.api('GET', `/triggers/${t.trigger.id}/fires`))[0]).toMatchObject({ outcome: 'skipped' });
    } finally {
      await s.api('PUT', '/processes/hook-target/access', { acl: [] });
    }
    expect((await hook(t.trigger.id, { name: 'after restore' }, bearer(t.secret))).status).toBe(202);
  });

  it('restricts source addresses with CIDR allow-lists', async () => {
    const c = await create(olivia, { name: 'Office only', allowedCidrs: ['10.0.0.0/8', '2001:db8::/32'], inputMapping: { endpoint: 'body.name' } });
    expect((await hook(c.trigger.id, { name: 'A' }, bearer(c.secret))).status).toBe(404);
    await olivia('PUT', `/triggers/${c.trigger.id}`, { ...c.trigger, allowedCidrs: ['127.0.0.0/8', '::1'] });
    expect((await hook(c.trigger.id, { name: 'A' }, bearer(c.secret))).status).toBe(202);
    expect(await status(olivia('PUT', `/triggers/${c.trigger.id}`, { ...c.trigger, allowedCidrs: ['10.0.0.0/33'] }))).toBe(400);
    expect(await status(olivia('PUT', `/triggers/${c.trigger.id}`, { ...c.trigger, allowedHeaders: ['authorization'] }))).toBe(400);
    expect(await status(olivia('PUT', `/triggers/${c.trigger.id}`, { ...c.trigger, inputMapping: { nope: 'body.x' } }))).toBe(400);
    expect(await status(olivia('PUT', `/triggers/${c.trigger.id}`, { ...c.trigger, inputMapping: { endpoint: 'body.(' } }))).toBe(400);
  });

  it('rotates the secret: the old one stops working', async () => {
    const r = await olivia('POST', `/triggers/${t.trigger.id}/rotate`);
    secrets.push(r.secret);
    expect(r.secret).not.toBe(t.secret);
    expect((await hook(t.trigger.id, { name: 'old' }, bearer(t.secret))).status).toBe(401);
    expect((await hook(t.trigger.id, { name: 'new' }, bearer(r.secret))).status).toBe(202);
    t = { trigger: r.trigger, secret: r.secret };
  });

  it('test calls go through the real endpoint, as a dry run marked as test', async () => {
    const r = await olivia('POST', `/triggers/${t.trigger.id}/test`, { payload: { name: 'from the test button' }, headers: { 'x-severity': 'medium' } });
    expect(r.status).toBe(202);
    expect(r.inputs).toEqual({ endpoint: 'from the test button', severity: 'medium' });
    const run = await s.waitRun(r.response.runId);
    expect(run).toMatchObject({ dryRun: true, trigger: 'webhook' });
    const fires = await olivia('GET', `/triggers/${t.trigger.id}/fires`);
    expect(fires[0]).toMatchObject({ test: true, outcome: 'started', runId: r.response.runId });
    const preview = await olivia('POST', '/triggers/preview-mapping', {
      inputMapping: { endpoint: '$uppercase(body.name)', broken: 'body.(' },
      payload: { name: 'x' },
    });
    expect(preview.inputs).toEqual({ endpoint: 'X' });
    expect(preview.errors.broken).toBeTruthy();
  });

  it('permissions follow schedules: viewers read, only owner/admin/manager edit', async () => {
    expect((await vera('GET', '/triggers')).length).toBeGreaterThan(0);
    expect(await status(vera('POST', '/triggers', { name: 'x', processId: 'hook-target', bindings: { hub } }))).toBe(403);
    expect(await status(dana('PUT', `/triggers/${t.trigger.id}`, { ...t.trigger }))).toBe(403);
    expect(await status(dana('POST', `/triggers/${t.trigger.id}/rotate`))).toBe(403);
    expect(await status(dana('DELETE', `/triggers/${t.trigger.id}`))).toBe(403);
    const asVera = await vera('GET', `/triggers/${t.trigger.id}`);
    expect(asVera.canEdit).toBe(false);
  });

  it('audits changes and calls; floods of rejected calls produce one entry with a counter', async () => {
    const f = await create(olivia, { name: 'Flooded', inputMapping: { endpoint: 'body.name' } });
    for (let i = 0; i < 6; i++) await hook(f.trigger.id, { name: 'x' }, bearer('whs_guess' + i));
    await sleep(50);
    const audit = await s.api('GET', `/audit?entityId=${f.trigger.id}&limit=50`);
    const rejected = audit.filter((a: any) => a.action === 'trigger.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].details).toMatchObject({ reason: 'missing or wrong secret', sourceIp: expect.any(String) });
    expect((await olivia('GET', `/triggers/${f.trigger.id}`)).rejectedCount).toBe(6);

    const all = await s.api('GET', `/audit?entityId=${t.trigger.id}&limit=100`);
    const actions = new Set(all.map((a: any) => a.action));
    for (const a of ['trigger.created', 'trigger.secret_rotated', 'trigger.fired', 'trigger.skipped', 'trigger.rejected']) expect(actions).toContain(a);
    const fired = all.find((a: any) => a.action === 'trigger.fired');
    expect(fired.details).toMatchObject({
      sourceIp: expect.any(String),
      payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      runId: expect.stringMatching(/^run_/),
    });
    await olivia('DELETE', `/triggers/${f.trigger.id}`);
    expect(await status(olivia('GET', `/triggers/${f.trigger.id}`))).toBe(404);
  });

  it('does not open other routes through the public hook prefix', async () => {
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(Number(new URL(s.base).port), '127.0.0.1', () => {
        sock.write('GET /api/hooks/../processes HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    // 401 (sign in), 403 (static file server refuses ..) or 404 – never the process list
    expect(raw.split('\r\n')[0], raw).toMatch(/ 40[134] /);
    expect(raw).not.toContain('hook-target');
  });

  it('never leaks secrets into responses, logs, audit entries or run data', async () => {
    const audit = JSON.stringify(await s.api('GET', '/audit?limit=5000'));
    const triggers = JSON.stringify(await s.api('GET', '/triggers'));
    const runs = await s.api('GET', '/runs?limit=200');
    const details = JSON.stringify(await Promise.all(runs.filter((r: any) => r.trigger === 'webhook').map((r: any) => s.api('GET', `/runs/${r.id}`))));
    expect(logged.length).toBeGreaterThan(0);
    const logs = logged.join('\n');
    expect(secrets.length).toBeGreaterThan(5);
    for (const secret of secrets) {
      for (const [where, text] of Object.entries({ audit, triggers, details, logs })) {
        expect(text.includes(secret), `secret found in ${where}`).toBe(false);
        expect(text.includes(secret.slice(8)), `secret tail found in ${where}`).toBe(false);
      }
    }
  });
});
