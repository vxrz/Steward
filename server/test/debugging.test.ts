import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Debugging procedures (ADR 0010): compare two runs, run one node, step through a run. Debug runs use the same step
 * functions as every run; they are never live, never publish, alert, create tasks or notify; only their starter,
 * the process's managers, administrators and auditors see them.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let platformId: string;
let livePlatform: string;
let liveServer: http.Server;
let liveCalls: { method?: string; url?: string }[] = [];
const DONE = ['succeeded', 'failed', 'cancelled'];
const SECRET = 'Debug-Secret-Value-42';

const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const w = (from: string, to: string, port = 'out') => ({ from, port, to });
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { status: number; body?: { code?: string } }) => e.body?.code ?? String(e.status),
  );
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 30));
  }
};
async function user(name: string, roles: string[]): Promise<Client> {
  const { temporaryPassword } = await s.api('POST', '/users', { username: name, roles });
  await (
    await s.as(name, temporaryPassword)
  )('POST', '/auth/password', { current: temporaryPassword, next: `${name}-Password-123` });
  return s.as(name, `${name}-Password-123`);
}
const proc = async (name: string, nodes: unknown[], wires: unknown[], extra: Record<string, unknown> = {}) =>
  (await s.api('POST', '/processes', { definition: { name, nodes, wires, connections: [{ slot: 'api' }], ...extra } })).id as string;
const auditOf = async (runId: string) => (await s.api('GET', `/audit?runId=${runId}&limit=200`)) as { action: string; summary: string; details?: any }[];

let designer: Client;
let operator: Client;
let viewer: Client;
let auditor: Client;
let designer2: Client;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  platformId = (
    await s.api('POST', '/platforms', {
      name: 'Debug API',
      kind: 'generic',
      baseUrl: 'http://127.0.0.1:9/api',
      config: { auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' }, variables: {}, http: { proxy: 'none' } },
      secrets: { apiKey: SECRET },
    })
  ).id;
  const rec = (r: Record<string, unknown>) => s.api('POST', `/platforms/${platformId}/recordings`, { status: 200, ...r });
  await rec({ method: 'GET', path: '/flag', body: { on: true, items: [1, 2, 3] } });
  await rec({ method: 'GET', path: '/after', body: { after: 'recorded' } });
  liveServer = http.createServer((req, res) => {
    liveCalls.push({ method: req.method, url: req.url });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ live: true, path: req.url }));
  });
  await new Promise<void>((r) => liveServer.listen(0, '127.0.0.1', () => r()));
  livePlatform = (
    await s.api('POST', '/platforms', {
      name: 'Live API',
      kind: 'generic',
      baseUrl: `http://127.0.0.1:${(liveServer.address() as { port: number }).port}`,
      config: { variables: {}, http: { proxy: 'none' } },
    })
  ).id;
  designer = await user('debug-dana', ['designer']);
  designer2 = await user('debug-dirk', ['designer']);
  operator = await user('debug-otto', ['operator']);
  viewer = await user('debug-vera', ['viewer']);
  auditor = await user('debug-audrey', ['auditor']);
});
afterAll(async () => {
  liveServer?.closeAllConnections();
  liveServer?.close();
  await s?.app.close();
});

// ---------------------------------------------------------------------------
describe('compare two runs', () => {
  it('aligns activations by key, shows the path, decisions and requests; masks secrets; writes no audit entry', async () => {
    const pid = await proc(
      'Debug compare',
      [
        n('start', 'start'),
        n('read', 'http', { connection: 'api', method: 'GET', path: '/flag', saveAs: 'f' }),
        n('on', 'if', { condition: 'inputs.mode = "a"' }),
        n('yes', 'set', { values: { picked: 'a', key: "{{ $secret('api', 'apiKey') }}" } }),
        n('no', 'set', { values: { picked: 'b' } }),
        n('chk', 'check', { condition: 'vars.picked = "a"', message: "{{ 'picked ' & vars.picked }}" }),
      ],
      [w('start', 'read'), w('read', 'on'), w('on', 'yes', 'true'), w('on', 'no', 'false'), w('yes', 'chk'), w('no', 'chk')],
      {
        inputs: [
          { name: 'mode', type: 'string' },
          { name: 'token', type: 'secret' },
        ],
      },
    );
    const run = async (mode: string) => {
      const { id } = await s.api('POST', '/runs', {
        processId: pid,
        inputs: { mode, token: 'Sealed-Token-Value-9' },
        bindings: { api: platformId },
        recorded: true,
      });
      return (await s.waitRun(id, DONE)).id as string;
    };
    const a = await run('a');
    const b = await run('b');
    const before = (await auditOf(a)).length;
    const c = await s.api('GET', `/runs/compare?a=${a}&b=${b}`);
    expect(c).toMatchObject({ processId: pid, a: { id: a, mode: 'test' }, b: { id: b, mode: 'test' } });
    const row = (key: string) => c.rows.find((r: { key: string }) => r.key === key);
    expect(row('read').presence).toBe('both');
    expect(row('read').differs).toEqual([]);
    expect(row('read').a.request).toMatchObject({ method: 'GET', path: '/api/flag', status: 200 });
    expect(row('on').differs).toContain('decision');
    expect(row('yes')).toMatchObject({ presence: 'a', differs: ['path'] });
    expect(row('no')).toMatchObject({ presence: 'b', differs: ['path'] });
    expect(row('chk').differs).toEqual(expect.arrayContaining(['status', 'check', 'vars']));
    // the variable built from a secret is masked in run a – shown as masked, never as a value
    expect(row('chk').vars.key).toEqual({ a: { masked: true }, b: null });
    expect(JSON.stringify(c)).not.toContain(SECRET);
    // secret inputs are not compared
    expect(c.inputs.token).toEqual({ a: { secret: true }, b: { secret: true }, same: null });
    expect(c.inputs.mode).toMatchObject({ a: { value: 'a' }, b: { value: 'b' }, same: false });
    expect(c.summary).toMatchObject({ onlyA: 1, onlyB: 1 });
    // a read: no audit entry
    expect((await auditOf(a)).length).toBe(before);

    // the last good run before a failed one: same process, same mode, succeeded without findings
    const fails = await s
      .api('POST', '/runs', { processId: pid, inputs: { mode: 'b' }, bindings: { api: 'plt_missing_platform' }, recorded: true })
      .catch(() => null);
    expect(fails).toBeNull();
    expect((await s.api('GET', `/runs/${b}/last-good`)).run.id).toBe(a);
    expect((await s.api('GET', `/runs/${a}/last-good`)).run).toBeNull();
  });

  it('only runs of the same process, both visible', async () => {
    const p1 = await proc('Debug compare one', [n('start', 'start')], []);
    const p2 = await proc('Debug compare two', [n('start', 'start')], []);
    const r1 = (await s.api('POST', '/runs', { processId: p1, bindings: { api: platformId }, dryRun: true })).id;
    const r2 = (await s.api('POST', '/runs', { processId: p2, bindings: { api: platformId }, dryRun: true })).id;
    await s.waitRun(r1, DONE);
    await s.waitRun(r2, DONE);
    expect(await code(s.api('GET', `/runs/compare?a=${r1}&b=${r2}`))).toBe('COMPARE_OTHER_PROCESS');
    await s.api('PUT', `/processes/${p1}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });
    expect(await status(viewer('GET', `/runs/compare?a=${r1}&b=${r1}`))).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('run one node', () => {
  let pid: string;
  beforeAll(async () => {
    pid = await proc(
      'Debug nodes',
      [
        n('start', 'start'),
        n('calc', 'set', { values: { double: '{{ vars.n * 2 }}', greeting: "{{ 'hi ' & inputs.who }}" } }),
        n('read', 'http', { connection: 'api', method: 'GET', path: '/flag', saveAs: 'f' }),
        n('write', 'http', { connection: 'api', method: 'POST', path: '/items', body: { a: '{{ vars.n }}' }, saveAs: 'wr' }),
        n('loop', 'forEach', { items: 'vars.f.body.items', as: 'it' }),
        n('inner', 'log', { message: 'inside' }),
        n('ask', 'userTask', { mode: 'approve', title: 'Go?' }),
        n('pub', 'publish', { dataset: 'debug.items', rows: '[{"a": 1}]' }),
        n('chk', 'check', { condition: 'vars.n > 100', message: 'too small' }),
        n('pause', 'wait', { seconds: 600 }),
      ],
      [
        w('start', 'calc'),
        w('calc', 'read'),
        w('read', 'write'),
        w('write', 'loop'),
        w('loop', 'inner', 'each'),
        w('loop', 'ask', 'done'),
        w('ask', 'pub', 'approved'),
        w('pub', 'chk'),
        w('chk', 'pause'),
      ],
      { inputs: [{ name: 'who', type: 'string', required: true }] },
    );
  });
  const node = (c: Client, body: Record<string, unknown>) => c('POST', `/processes/${pid}/debug/node`, body);

  it('offline: a set node with sample data; stored as a debug run of its starter, not audited', async () => {
    const r = await node(designer, { nodeId: 'calc', vars: { from: 'sample', vars: { n: 21 }, inputs: { who: 'Ada' } } });
    expect(r).toMatchObject({ status: 'succeeded', mode: 'test', answers: 'offline', written: { double: 42, greeting: 'hi Ada' } });
    expect(r.step).toMatchObject({ key: 'calc', status: 'succeeded' });
    const run = await designer('GET', `/runs/${r.runId}`);
    expect(run).toMatchObject({ trigger: 'debug', recorded: true, debug: { kind: 'node', nodeId: 'calc', answers: 'offline', varsFrom: 'sample' } });
    expect(await auditOf(r.runId)).toEqual([]);
    // an offline node needs only edit: still refused without it
    expect(await status(operator('POST', `/processes/${pid}/debug/node`, { nodeId: 'calc', vars: { from: 'sample', vars: {} } }))).toBe(403);
  });

  it('sample data that looks like a credential is refused', async () => {
    expect(await code(node(designer, { nodeId: 'calc', vars: { from: 'sample', vars: { login: { password: 'Summer2024!x' } } } }))).toBe('DEBUG_SAMPLE_SECRET');
    expect(await code(node(designer, { nodeId: 'calc', vars: { from: 'sample', vars: { t: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' } } }))).toBe(
      'DEBUG_SAMPLE_SECRET',
    );
    expect(
      await code(node(designer, { nodeId: 'calc', vars: { from: 'inputs', inputs: { who: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk' } } })),
    ).toBe('DEBUG_SAMPLE_SECRET');
  });

  it('recorded (default for a platform node): edit, run and use; audited with the sealed protocol', async () => {
    expect(
      await status(operator('POST', `/processes/${pid}/debug/node`, { nodeId: 'read', vars: { from: 'sample', vars: {} }, bindings: { api: platformId } })),
    ).toBe(403);
    expect(
      await status(viewer('POST', `/processes/${pid}/debug/node`, { nodeId: 'read', vars: { from: 'sample', vars: {} }, bindings: { api: platformId } })),
    ).toBe(403);
    const r = await node(designer, { nodeId: 'read', vars: { from: 'sample', vars: {} }, bindings: { api: platformId } });
    expect(r).toMatchObject({ status: 'succeeded', mode: 'test', answers: 'recorded', written: { f: { status: 200, body: { on: true } } } });
    const audit = await auditOf(r.runId);
    const started = audit.find((a) => a.action === 'run.started')!;
    expect(started.details.debug).toEqual({ kind: 'node', nodeId: 'read', answers: 'recorded', varsFrom: 'sample' });
    expect(started.details.mode).toBe('test');
    expect(audit.find((a) => a.action === 'run.succeeded')!.details.protocolHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('offline needs a pasted answer for a request; the pasted answer is never stored as a recording', async () => {
    expect(await code(node(designer, { nodeId: 'read', answers: 'offline', vars: { from: 'sample', vars: {} } }))).toBe('DEBUG_ANSWERS_REFUSED');
    const recordings = (await s.api('GET', `/platforms/${platformId}/recordings`)).length;
    const r = await node(designer, { nodeId: 'read', answers: 'offline', vars: { from: 'sample', vars: {} }, answer: { status: 200, body: { pasted: 1 } } });
    expect(r).toMatchObject({ status: 'succeeded', answers: 'offline', written: { f: { status: 200, body: { pasted: 1 } } } });
    expect((await designer('GET', `/runs/${r.runId}`)).debug).toMatchObject({ pasted: true });
    expect((await s.api('GET', `/platforms/${platformId}/recordings`)).length).toBe(recordings);
    expect(await auditOf(r.runId)).toEqual([]);
  });

  it('live reads only: GET is sent (a dry run), a write is refused', async () => {
    expect(await code(node(designer, { nodeId: 'write', answers: 'live', vars: { from: 'sample', vars: {} }, bindings: { api: livePlatform } }))).toBe(
      'DEBUG_ANSWERS_REFUSED',
    );
    liveCalls = [];
    const r = await node(designer, { nodeId: 'read', answers: 'live', vars: { from: 'sample', vars: {} }, bindings: { api: livePlatform } });
    expect(r).toMatchObject({ status: 'succeeded', mode: 'dry', answers: 'live', written: { f: { body: { live: true } } } });
    expect(liveCalls).toEqual([{ method: 'GET', url: '/flag' }]);
    // a write in recorded mode is skipped and audited as in any test run
    const wr = await node(designer, { nodeId: 'write', vars: { from: 'sample', vars: { n: 1 } }, bindings: { api: platformId } });
    expect(wr.step.status).toBe('dryrun');
    expect((await auditOf(wr.runId)).some((a) => a.action === 'api.write_skipped')).toBe(true);
  });

  it('variables from an earlier run, masked values named; the unsaved node is checked and hashed', async () => {
    const { id } = await s.api('POST', '/runs', { processId: pid, inputs: { who: 'Bo' }, bindings: { api: platformId }, recorded: true });
    await s.waitRun(id, ['waiting', ...DONE]);
    await s.api('POST', `/runs/${id}/cancel`, {}).catch(() => undefined);
    const r = await node(designer, { nodeId: 'loop', vars: { from: 'run', runId: id }, bindings: { api: platformId } });
    expect(r).toMatchObject({ status: 'succeeded', answers: 'offline' });
    expect(r.step.output).toMatchObject({ count: 3, items: [1, 2, 3] });
    expect(r.step.summary).toContain('the body does not run');
    const saved = (await designer('GET', `/runs/${r.runId}`)).definitionHash;
    const draft = await node(designer, {
      nodeId: 'calc',
      node: n('calc', 'set', { values: { double: '{{ 3 * 3 }}' } }),
      vars: { from: 'sample', vars: {} },
    });
    expect(draft).toMatchObject({ status: 'succeeded', written: { double: 9 } });
    const dr = await designer('GET', `/runs/${draft.runId}`);
    expect(dr.debug.draft).toBe(true);
    expect(dr.definitionHash).not.toBe(saved);
    expect(await code(node(designer, { nodeId: 'calc', node: n('calc', 'http', { method: 'GET' }), vars: { from: 'sample', vars: {} } }))).toBe(
      'DEBUG_NODE_INVALID',
    );
  });

  it('a decision is simulated (no task); publish previews; a check alerts nobody; a wait is not waited', async () => {
    const { on } = await import('../src/events.js');
    const failed: unknown[] = [];
    const off = on('check.failed', (e) => void failed.push(e));
    const ask = await node(designer, { nodeId: 'ask', vars: { from: 'sample', vars: {} }, decision: { approved: true, selectedKeys: [], comment: 'ok' } });
    expect(ask).toMatchObject({ status: 'succeeded', written: {} });
    expect(ask.step.output).toMatchObject({ approved: true, simulated: true, decidedBy: 'debug-dana' });
    expect((await designer('GET', `/runs/${ask.runId}`)).tasks).toEqual([]);
    expect(await code(node(designer, { nodeId: 'ask', vars: { from: 'sample', vars: {} } }))).toBe('ok'); // runs, but fails without an answer
    const pub = await node(designer, { nodeId: 'pub', vars: { from: 'sample', vars: {} } });
    expect(pub.step).toMatchObject({ status: 'dryrun' });
    expect(await status(s.api('GET', '/datasets/debug.items'))).toBe(404);
    const chk = await node(designer, { nodeId: 'chk', vars: { from: 'sample', vars: { n: 1 } } });
    expect(chk.step).toMatchObject({ status: 'failed' });
    expect(failed).toEqual([]);
    off();
    const pause = await node(designer, { nodeId: 'pause', vars: { from: 'sample', vars: {} } });
    expect(pause).toMatchObject({ status: 'succeeded' });
    expect(pause.step.summary).toContain('Would wait 600s');
  });

  it('a debug run is never live (DEBUG_LIVE_RUN)', async () => {
    const { engine } = await import('../src/engine/index.js');
    await expect(
      engine().start({ processId: pid, inputs: {}, bindings: {}, mode: 'live', actor: 'admin', origin: { trigger: 'debug' }, debug: { kind: 'step' } }),
    ).rejects.toMatchObject({ code: 'DEBUG_LIVE_RUN' });
  });
});

// ---------------------------------------------------------------------------
describe('step through a run', () => {
  let pid: string;
  const state = (c: Client, id: string) => c('GET', `/runs/${id}/debug`);
  const signal = (c: Client, id: string, body: Record<string, unknown>) => c('POST', `/runs/${id}/debug`, body);
  const pausedAt = async (c: Client, id: string, key: string) => {
    await until(async () => (await state(c, id)).paused?.stepKey === key);
    return state(c, id);
  };
  beforeAll(async () => {
    pid = await proc(
      'Debug steps',
      [
        n('start', 'start'),
        n('read', 'http', { connection: 'api', method: 'GET', path: '/flag', headers: { 'x-key': "{{ $secret('api', 'apiKey') }}" }, saveAs: 'f' }),
        n('mark', 'set', { values: { seen: true } }),
        n('ask', 'userTask', { mode: 'approve', title: 'Carry on?' }),
        n('after', 'http', { connection: 'api', method: 'GET', path: '/after', saveAs: 'a' }),
        n('end', 'log', { message: 'end' }),
      ],
      [w('start', 'read'), w('read', 'mark'), w('mark', 'ask'), w('ask', 'after', 'approved'), w('after', 'end')],
    );
  });

  it('pauses before each node with a redacted preview; step, skip and continue; a decision is answered in the panel', async () => {
    const st = await designer('POST', `/processes/${pid}/debug/runs`, { mode: 'dry', pauseBeforeEach: true, bindings: { api: platformId } });
    const id = st.runId;
    let p = await pausedAt(designer, id, 'read');
    expect(p).toMatchObject({ status: 'waiting', mode: 'dry', canSignal: true, debug: { kind: 'step', pauseBeforeEach: true } });
    expect(p.paused).toMatchObject({ reason: 'each', nodeId: 'read', nodeType: 'http' });
    expect(p.paused.preview).toMatchObject({ method: 'GET', url: 'http://127.0.0.1:9/api/flag', headers: { 'x-key': '***' } });
    expect(JSON.stringify(p)).not.toContain(SECRET);
    // only the starter drives it; others with view do not even see it
    expect(await code(signal(designer2, id, { type: 'debug.step' }))).toBe('404');
    expect(await status(viewer('GET', `/runs/${id}`))).toBe(404);
    expect(await status(auditor('GET', `/runs/${id}`))).toBe(200);
    expect(await status(s.api('GET', `/runs/${id}`))).toBe(200);
    expect(await code(signal(auditor, id, { type: 'debug.step' }))).toBe('DEBUG_NOT_STARTER');
    // skip the read: recorded as skipped, its pass-through port fires
    await signal(designer, id, { type: 'debug.skip' });
    p = await pausedAt(designer, id, 'mark');
    expect(p.steps.find((x: { key: string }) => x.key === 'read')).toMatchObject({ status: 'skipped', summary: 'Skipped while debugging by debug-dana' });
    await signal(designer, id, { type: 'debug.step' });
    p = await pausedAt(designer, id, 'ask');
    expect(p.paused).toMatchObject({ reason: 'decision', task: { mode: 'approve', title: 'Carry on?' } });
    expect(await code(signal(designer, id, { type: 'debug.continue' }))).toBe('DEBUG_DECISION_OPEN');
    await signal(designer, id, { type: 'debug.answer', decision: { approved: true, selectedKeys: [] } });
    // continue: no more pauses before each node, to the end; after the simulated decision only recordings answer
    p = await pausedAt(designer, id, 'after');
    expect(p.debug.recordedFrom).toBe('ask');
    expect(p.mode).toBe('test');
    await signal(designer, id, { type: 'debug.continue' });
    const done = await s.waitRun(id, DONE);
    expect(done.status).toBe('succeeded');
    expect(done.tasks).toEqual([]);
    const after = done.steps.find((x: { key: string }) => x.key === 'after');
    expect(after.output.body).toEqual({ after: 'recorded' });
    const ask = done.steps.find((x: { key: string }) => x.key === 'ask');
    expect(ask.output).toMatchObject({ approved: true, simulated: true });
    expect(JSON.stringify(done.logs)).toContain('answers from recordings only');
    const audit = await auditOf(id);
    expect(audit.find((a) => a.action === 'run.started')!.details.debug).toMatchObject({ kind: 'step', pauseBeforeEach: true });
    expect(audit.find((a) => a.action === 'run.succeeded')!.details).toMatchObject({ recordedFrom: 'ask' });
  });

  it('breakpoints, stop with a reason; one step-through run per person; an administrator may stop any', async () => {
    const st = await designer('POST', `/processes/${pid}/debug/runs`, { breakpoints: ['mark'], bindings: { api: platformId } });
    await pausedAt(designer, st.runId, 'mark');
    await signal(designer, st.runId, { type: 'debug.breakpoints', breakpoints: ['end'] });
    await signal(designer, st.runId, { type: 'debug.continue' });
    await pausedAt(designer, st.runId, 'ask');
    await signal(designer, st.runId, { type: 'debug.stop' });
    const r = await s.waitRun(st.runId, DONE);
    expect(r.status).toBe('cancelled');
    const entry = (await auditOf(st.runId)).find((a) => a.action === 'run.cancelled')!;
    expect(entry.details.reason).toBe('Stopped while debugging by debug-dana');

    const one = await designer('POST', `/processes/${pid}/debug/runs`, { pauseBeforeEach: true, bindings: { api: platformId } });
    await pausedAt(designer, one.runId, 'read');
    const two = await designer('POST', `/processes/${pid}/debug/runs`, { pauseBeforeEach: true, bindings: { api: platformId } });
    expect((await s.waitRun(one.runId, DONE)).status).toBe('cancelled');
    expect((await auditOf(one.runId)).find((a) => a.action === 'run.cancelled')!.details.reason).toBe('Replaced by a new debug run');
    expect(await status(designer2('POST', `/runs/${two.runId}/cancel`, {}))).toBe(404);
    await s.api('POST', `/runs/${two.runId}/cancel`, { reason: 'Admin cleans up' });
    expect((await s.waitRun(two.runId, DONE)).status).toBe('cancelled');
  });

  it('a pause times out: the run is cancelled with the reason', async () => {
    const runner = await import('../src/engine/runner.js');
    runner.setDebugPauseMsForTests(300);
    try {
      const st = await designer('POST', `/processes/${pid}/debug/runs`, { pauseBeforeEach: true, bindings: { api: platformId } });
      const r = await s.waitRun(st.runId, DONE);
      expect(r.status).toBe('cancelled');
      expect((await auditOf(st.runId)).find((a) => a.action === 'run.cancelled')!.details.reason).toBe('debug pause timed out');
    } finally {
      runner.setDebugPauseMsForTests(null);
    }
  });

  it('needs edit and run; a live mode is refused; unknown breakpoints too', async () => {
    expect(await status(operator('POST', `/processes/${pid}/debug/runs`, { bindings: { api: platformId } }))).toBe(403);
    expect(await status(designer('POST', `/processes/${pid}/debug/runs`, { mode: 'live', bindings: { api: platformId } }))).toBe(400);
    expect(await code(designer('POST', `/processes/${pid}/debug/runs`, { breakpoints: ['nope'], bindings: { api: platformId } }))).toBe('DEBUG_NODE_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
describe('debug runs as a kind', () => {
  it('run lists hide them unless asked; visible to the starter, managers, administrators and auditors only', async () => {
    const pid = await proc('Debug lists', [n('start', 'start'), n('calc', 'set', { values: { a: 1 } })], [w('start', 'calc')]);
    const r = await designer('POST', `/processes/${pid}/debug/node`, { nodeId: 'calc', vars: { from: 'sample', vars: {} } });
    expect((await designer('GET', `/runs?processId=${pid}`)).map((x: { id: string }) => x.id)).not.toContain(r.runId);
    expect((await designer('GET', `/runs?processId=${pid}&debug=1`)).map((x: { id: string }) => x.id)).toEqual([r.runId]);
    expect(await designer2('GET', `/runs?processId=${pid}&debug=1`)).toEqual([]);
    expect((await s.api('GET', `/runs?processId=${pid}&debug=1`)).length).toBe(1);
    expect((await auditor('GET', `/runs?processId=${pid}&debug=1`)).length).toBe(1);
    expect(await status(designer2('GET', `/runs/${r.runId}`))).toBe(404);
    // a process manager sees them
    await s.api('PUT', `/processes/${pid}/access`, {
      acl: [
        { subject: 'user:debug-dirk', permissions: ['view', 'manage'] },
        { subject: 'role:designer', permissions: ['view', 'edit', 'run'] },
      ],
    });
    expect(await status(designer2('GET', `/runs/${r.runId}`))).toBe(200);
    // the process's last run and the public API are not about debug runs
    const p = (await s.api('GET', '/processes')).find((x: { id: string }) => x.id === pid);
    expect(p.lastRun).toBeNull();
    const { token } = await s.api('POST', '/me/tokens', { name: 'debug-read', scope: 'read' });
    const res = await fetch(`${s.base}/api/v1/runs/${r.runId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
    const list = await fetch(`${s.base}/api/v1/runs?processId=${pid}`, { headers: { authorization: `Bearer ${token}` } });
    expect(JSON.stringify(await list.json())).not.toContain(r.runId);
  });

  it('finished debug runs are deleted after retentionDebugRunDays; ordinary runs of the same age stay', async () => {
    const pid = await proc('Debug retention', [n('start', 'start'), n('calc', 'set', { values: { a: 1 } })], [w('start', 'calc')]);
    const dbg = (await designer('POST', `/processes/${pid}/debug/node`, { nodeId: 'calc', vars: { from: 'sample', vars: {} } })).runId;
    const { id: plain } = await s.api('POST', '/runs', { processId: pid, bindings: { api: platformId }, dryRun: true });
    await s.waitRun(plain, DONE);
    const { db } = await import('../src/db.js');
    const old = new Date(Date.now() - 8 * 86400_000).toISOString();
    db().run('UPDATE runs SET started_at = ?, finished_at = ? WHERE id IN (?, ?)', old, old, dbg, plain);
    expect(await status(s.api('PUT', '/settings/instance', { retentionDebugRunDays: 0 }))).toBe(400);
    await s.api('PUT', '/settings/instance', { retentionDebugRunDays: 7, debugPauseMinutes: 45 });
    expect(await s.api('GET', '/settings/instance')).toMatchObject({ retentionDebugRunDays: 7, debugPauseMinutes: 45 });
    const res = await s.api('POST', '/maintenance/cleanup', {});
    expect(res.lastCleanup.debugRunsDeleted).toBe(1);
    expect(await status(s.api('GET', `/runs/${dbg}`))).toBe(404);
    expect(await status(s.api('GET', `/runs/${plain}`))).toBe(200);
    const entry = (await s.api('GET', '/audit?action=maintenance.cleanup&limit=1'))[0];
    expect(entry.summary).toContain('1 debug run(s) older than 7 days');
    // the debug run's audit entries stay (ADR 0003): it had none (offline), the settings change has one
    expect((await s.api('GET', '/audit?action=settings.updated&limit=1'))[0].details).toMatchObject({ retentionDebugRunDays: 7 });
  });

  it('a failed debug run notifies nobody', async () => {
    const { flushNotifications } = await import('../src/notifications/service.js');
    const { db } = await import('../src/db.js');
    const pid = await proc('Debug quiet', [n('start', 'start'), n('boom', 'fail', { message: 'boom' })], [w('start', 'boom')]);
    await flushNotifications();
    const count = () => db().get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE event = 'run.failed'")!.n;
    const before = count();
    const r = await designer('POST', `/processes/${pid}/debug/node`, { nodeId: 'boom', vars: { from: 'sample', vars: {} } });
    expect(r.status).toBe('failed');
    await flushNotifications();
    expect(count()).toBe(before);
    const { id } = await designer('POST', '/runs', { processId: pid, bindings: { api: platformId }, dryRun: true });
    await s.waitRun(id, DONE);
    await flushNotifications();
    expect(count()).toBeGreaterThan(before);
  });
});
