import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Recorded platform responses (#105): stored per platform with credentials redacted, matched by method, path (with
 * {placeholders}), query and body; a test run of a process answers platform calls from them and names the call
 * without one; real runs and dry runs never use them; a monitor's platform checks can be tried against them.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let vera: Client;
let platformId: string;
const SECRET = 'Rec0rded-Secret-Value';
const DONE = ['succeeded', 'failed', 'cancelled'];
const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const w = (from: string, to: string, port = 'out') => ({ from, port, to });
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code,
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  vera = await s.as('vera', 'Demo-password-1');
  // nothing listens on port 9: a call that reaches the network fails
  platformId = (
    await s.api('POST', '/platforms', {
      name: 'Recorded API',
      kind: 'generic',
      baseUrl: 'http://127.0.0.1:9/api',
      config: { auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' }, variables: {}, http: { proxy: 'none' } },
      secrets: { apiKey: SECRET },
    })
  ).id;
});
afterAll(async () => {
  await s?.app.close();
});

const add = (r: Record<string, unknown>) => s.api('POST', `/platforms/${platformId}/recordings`, { status: 200, ...r });

describe('recorded responses', () => {
  it('stores a recording with the credentials redacted, audited; managers change them, others may not', async () => {
    const r = await add({
      method: 'GET',
      path: '/users?active=true',
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=abc', Authorization: `Bearer ${SECRET}`, 'x-trace': `t-${SECRET}` },
      body: { items: [{ id: 'u1', name: 'Ada', token: SECRET }], total: 1 },
      note: 'from Swagger',
    });
    expect(r).toMatchObject({ method: 'GET', path: '/users', query: { active: 'true' }, status: 200, note: 'from Swagger', createdBy: 'admin' });
    expect(r.headers).toEqual({ 'content-type': 'application/json', 'x-trace': 't-***' });
    expect(r.body.items[0].token).toBe('***');
    expect(JSON.stringify(await s.api('GET', `/platforms/${platformId}/recordings`))).not.toContain(SECRET);
    const audit = await s.api('GET', `/audit?entityType=platform&entityId=${platformId}&limit=5`);
    expect(audit[0]).toMatchObject({ action: 'platform.recording_added' });
    expect(audit[0].summary).toContain('GET /users?active=true → HTTP 200');

    const changed = await s.api('PUT', `/platforms/${platformId}/recordings/${r.id}`, {
      method: 'GET',
      path: '/users',
      query: { active: 'true' },
      status: 200,
      body: {
        items: [
          { id: 'u1', name: 'Ada' },
          { id: 'u2', name: 'Bob' },
        ],
        total: 2,
      },
    });
    expect(changed.body.total).toBe(2);
    expect((await s.api('GET', `/audit?entityType=platform&entityId=${platformId}&limit=1`))[0].action).toBe('platform.recording_changed');

    // a viewer without rights on the platform sees nothing and changes nothing
    expect(await status(vera('GET', `/platforms/${platformId}/recordings`))).toBe(403);
    expect(await status(vera('POST', `/platforms/${platformId}/recordings`, { method: 'GET', path: '/x', status: 200 }))).toBe(403);
    expect(await status(vera('DELETE', `/platforms/${platformId}/recordings/${r.id}`))).toBe(403);
  });

  it('refuses invalid and oversized recordings', async () => {
    expect(await status(add({ method: 'TRACE', path: '/x' }))).toBe(400);
    expect(await status(add({ method: 'GET', path: '' }))).toBe(400);
    expect(await status(add({ method: 'GET', path: '/x', status: 99 }))).toBe(400);
    expect(await code(add({ method: 'GET', path: '/big', body: 'x'.repeat(1024 * 1024 + 10) }))).toBe('RECORDING_TOO_LARGE');
  });

  it('a test run answers from the recordings, the most specific first; writes too; a missing one fails the run', async () => {
    await add({ method: 'GET', path: '/users/{id}', body: { id: 'any', name: 'Placeholder' } });
    await add({ method: 'GET', path: '/users/u1', body: { id: 'u1', name: 'Ada (exact)' } });
    await add({ method: 'POST', path: '/groups/{id}/members', bodyMatch: { user: 'u2' }, status: 201, body: { added: 'u2' } });
    await add({ method: 'POST', path: '/groups/{id}/members', status: 409, body: { error: 'other' } });
    await add({ method: 'GET', path: '/pages', body: [{ n: 1 }, { n: 2 }] });
    const proc = await s.api('POST', '/processes', {
      definition: {
        name: 'Recorded test process',
        connections: [{ slot: 'api' }],
        inputs: [{ name: 'path', type: 'string', default: '/users' }],
        nodes: [
          n('start', 'start'),
          n('list', 'http', { connection: 'api', method: 'GET', path: '{{ inputs.path }}', query: { active: 'true' }, saveAs: 'list' }),
          n('one', 'http', { connection: 'api', method: 'GET', path: '/users/u1', saveAs: 'one' }),
          n('other', 'http', { connection: 'api', method: 'GET', path: '/users/u9', saveAs: 'other' }),
          n('addMember', 'http', { connection: 'api', method: 'POST', path: '/groups/g1/members', body: { user: 'u2' }, expectStatus: [201], saveAs: 'added' }),
          n('paged', 'http', { connection: 'api', method: 'GET', path: '/pages', paginate: { mode: 'offset', pageSize: 2 }, saveAs: 'paged' }),
          n('show', 'log', {
            message:
              '{{ vars.list.body.total }} {{ vars.one.body.name }} / {{ vars.other.body.name }} / {{ vars.added.body.added }} / {{ $count(vars.paged.body) }}',
          }),
        ],
        wires: [w('start', 'list'), w('list', 'one'), w('one', 'other'), w('other', 'addMember'), w('addMember', 'paged'), w('paged', 'show')],
      },
    });
    const run = async (opts: Record<string, unknown>, inputs: Record<string, unknown> = {}) => {
      const { id } = await s.api('POST', '/runs', { processId: proc.id, bindings: { api: platformId }, inputs, ...opts });
      return s.waitRun(id, DONE);
    };

    const r = await run({ recorded: true });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(r).toMatchObject({ dryRun: true, recorded: true });
    expect(JSON.stringify(r.logs)).toContain('2 Ada (exact) / Placeholder / u2 / 2');
    expect(JSON.stringify(r.logs)).toContain('TEST RUN – recorded response for GET /users?active=true → HTTP 200');
    // the write was answered by the recording, not skipped, and not audited as a write
    const audit = await s.api('GET', `/audit?runId=${r.id}&limit=50`);
    expect(audit.some((e: any) => e.action === 'api.write')).toBe(false);
    expect(audit.find((e: any) => e.action === 'run.started').summary).toMatch(/^Test run of "Recorded test process"/);

    // a call without a recording fails the run and names the call
    const missing = await run({ recorded: true }, { path: '/nothing' });
    expect(missing.status).toBe('failed');
    expect(missing.error).toContain('Test run: no recorded response for GET /nothing?active=true on "Recorded API"');

    // dry runs and real runs never use recordings: the platform is called (and is not there)
    for (const opts of [{ dryRun: true }, {}]) {
      const real = await run(opts);
      expect(real.status).toBe('failed');
      expect(real.recorded).toBe(false);
      expect(JSON.stringify(real)).not.toContain('Ada (exact)');
    }
  });

  it('tries the platform checks of a monitor against the recordings, without storing a result', async () => {
    await add({ method: 'GET', path: '/health', body: { ok: true } });
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Recorded monitor',
        failuresBeforeDown: 1,
        checks: [
          { id: 'health', name: 'Health', type: 'platform', platform: 'Recorded API', path: '/health', condition: 'body.ok = true' },
          { id: 'missing', name: 'Missing', type: 'platform', platform: 'Recorded API', path: '/not-recorded' },
          { id: 'tcp', name: 'TCP', type: 'tcp', host: '127.0.0.1', port: 9 },
        ],
      },
    });
    const t = await s.api('POST', `/monitors/${monitor.id}/test-run`, {});
    const by = (id: string) => t.checks.find((c: any) => c.checkId === id);
    expect(by('health')).toMatchObject({ status: 'up', recorded: true });
    expect(by('missing')).toMatchObject({ status: 'unknown', recorded: false });
    expect(by('missing').message).toContain('no recorded response for GET /not-recorded');
    expect(by('tcp')).toMatchObject({ status: null, skipped: true });
    // nothing stored: the monitor has no results yet
    const m = await s.api('GET', `/monitors/${monitor.id}`);
    expect(m.checks.every((c: any) => !c.last)).toBe(true);
  });

  it('removes a recording', async () => {
    const list = await s.api('GET', `/platforms/${platformId}/recordings`);
    await s.api('DELETE', `/platforms/${platformId}/recordings/${list[0].id}`);
    expect(await s.api('GET', `/platforms/${platformId}/recordings`)).toHaveLength(list.length - 1);
    expect((await s.api('GET', `/audit?entityType=platform&entityId=${platformId}&limit=1`))[0].action).toBe('platform.recording_removed');
  });
});
