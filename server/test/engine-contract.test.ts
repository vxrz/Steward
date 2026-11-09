import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Contract of the run engine (ADR 0011): the invariants every engine keeps, checked against the built-in engine. Runs
 * on SQLite and on PostgreSQL (SM_TEST_DATABASE_URL, test/pg-global.ts).
 *
 * Golden protocol hashes: example processes as test runs against fixed recordings give the same `protocolHash` the
 * engine gave before the boundary was drawn (0.9.0). Test runs answer from recordings, so the hash is reproducible.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const ROOT = path.resolve(__dirname, '..', '..');
const example = (file: string) => fs.readFileSync(path.join(ROOT, 'examples', 'processes', file), 'utf8');

let s: TestServer;
let platformId: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  // nothing listens on port 9: a call that reaches the network fails
  platformId = (
    await s.api('POST', '/platforms', {
      name: 'Contract API',
      kind: 'generic',
      baseUrl: 'http://127.0.0.1:9/api',
      config: { auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' }, variables: {}, http: { proxy: 'none' } },
      secrets: { apiKey: 'Contract-Secret-Value' },
    })
  ).id;
  const rec = (r: Record<string, unknown>) => s.api('POST', `/platforms/${platformId}/recordings`, { status: 200, ...r });
  await rec({ method: 'GET', path: '/health', body: { ok: true } });
  await rec({ method: 'GET', path: '/status', status: 503, body: { ok: false } });
  await rec({
    method: 'GET',
    path: '/api/identitymanagement/v3/Groups',
    query: { filter: 'displayName eq "Operators"' },
    body: { resources: [{ id: 'g-1', displayName: 'Operators', members: [{ value: 'u-1' }, { value: 'u-2' }] }] },
  });
  await rec({ method: 'GET', path: '/items', query: { page: '0', size: '2' }, body: { content: [{ id: 1 }, { id: 2 }], page: { totalPages: 2 } } });
  await rec({ method: 'GET', path: '/items', query: { page: '1', size: '2' }, body: { content: [{ id: 3 }], page: { totalPages: 2 } } });
  await rec({ method: 'GET', path: '/items/{id}', body: { detail: 'item' } });
});

const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const w = (from: string, to: string, port = 'out') => ({ from, port, to });

/** A process that touches every control and leaf type a test run can answer offline: set, if, for-each (sequential and parallel), http with pages, check, log, report. */
const SYNTHETIC = {
  name: 'Contract synthetic',
  connections: [{ slot: 'api' }],
  inputs: [{ name: 'limit', type: 'number', default: 2 }],
  nodes: [
    n('start', 'start'),
    n('init', 'set', { values: { seen: 0, label: "{{ 'limit ' & inputs.limit }}" } }),
    n('list', 'http', { connection: 'api', method: 'GET', path: '/items', paginate: { mode: 'page', pageSize: 2 }, saveAs: 'items' }),
    n('many', 'if', { condition: '$count(vars.items.body) > inputs.limit' }),
    n('warn', 'log', { level: 'warn', message: "{{ 'more than ' & inputs.limit & ' items' }}" }),
    n('each', 'forEach', { items: 'vars.items.body', as: 'item' }),
    n('detail', 'http', { connection: 'api', method: 'GET', path: '/items/{{ vars.item.id }}', saveAs: 'd' }),
    n('count', 'set', { values: { seen: '{{ vars.seen + 1 }}' } }),
    n('par', 'forEach', { items: '[1, 2, 3]', as: 'k', concurrency: 2 }),
    n('sq', 'set', { values: { sq: '{{ vars.k * vars.k }}' } }),
    n('chk', 'check', { condition: 'vars.seen = 3', message: "{{ 'seen ' & vars.seen }}", severity: 'warning' }),
    n('chk2', 'check', { condition: 'vars.seen > 5', message: 'too few', severity: 'info', notify: false }),
    n('rep', 'report', { title: 'Items', rows: 'vars.items.body', columns: [{ label: 'Id', value: 'id' }] }),
  ],
  wires: [
    w('start', 'init'),
    w('init', 'list'),
    w('list', 'many'),
    w('many', 'warn', 'true'),
    w('many', 'each', 'false'),
    w('warn', 'each'),
    w('each', 'detail', 'each'),
    w('detail', 'count'),
    w('each', 'par', 'done'),
    w('par', 'sq', 'each'),
    w('par', 'chk', 'done'),
    w('chk', 'chk2'),
    w('chk2', 'rep'),
  ],
};

async function testRun(processId: string, slot: string, inputs: Record<string, unknown> = {}): Promise<{ id: string; status: string; hash: string }> {
  const { id } = await s.api('POST', '/runs', { processId, inputs, bindings: { [slot]: platformId }, recorded: true });
  const r = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
  const report = await s.api('GET', `/runs/${id}/report.json`);
  return { id, status: r.status, hash: report.protocolHash };
}

/** The protocol hashes of the 0.9.0 engine (before the boundary): the refactor must not change them. */
const GOLDEN: Record<string, string> = {
  'examples/70-generic-endpoint-check': '434cd4c5e2b882d40fbf25ccba8bff0ce77b609373f04b4d89bfd73b1bae4622',
  'examples/90-subflow-resolve-group': 'c5ff81afcec0b11bbe992d9e3a042919ffef30630f9d2567c81853c5c73c8ef3',
  synthetic: '96178ea267f68a239993257dc5588d61eaa7fb4ad25d8286d6cf031f6c13aa77',
};

describe('golden protocol hashes (invariant 7)', () => {
  it('example 70: generic endpoint check against recordings', async () => {
    const p = await s.api('POST', '/processes', { text: example('70-generic-endpoint-check.yaml') });
    const r = await testRun(p.id, 'target', { paths: ['/health', '/status'] });
    expect(r.status).toBe('succeeded');
    expect(r.hash).toBe(GOLDEN['examples/70-generic-endpoint-check']);
    // the same run again gives the same hash
    expect((await testRun(p.id, 'target', { paths: ['/health', '/status'] })).hash).toBe(r.hash);
  });
  it('example 90: sub-process building block against recordings', async () => {
    const p = await s.api('POST', '/processes', { text: example('90-subflow-resolve-group.yaml') });
    const r = await testRun(p.id, 'hub', { groupName: 'Operators' });
    expect(r.status).toBe('succeeded');
    expect(r.hash).toBe(GOLDEN['examples/90-subflow-resolve-group']);
  });
  it('synthetic: every control and leaf type a test run answers', async () => {
    const p = await s.api('POST', '/processes', { definition: SYNTHETIC });
    const r = await testRun(p.id, 'api');
    expect(r.status).toBe('succeeded');
    expect(r.hash).toBe(GOLDEN.synthetic);
  });
});

// ---------------------------------------------------------------------------
// The other invariants, the interface and the command layer
// ---------------------------------------------------------------------------

const DONE = ['succeeded', 'failed', 'cancelled'];
const steps = (r: { steps: { key: string; stepId: string; status: string; input?: unknown }[] }) => r.steps;
const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 30));
  }
};
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
async function user(name: string, roles: string[]) {
  const { temporaryPassword } = await s.api('POST', '/users', { username: name, roles });
  await (
    await s.as(name, temporaryPassword)
  )('POST', '/auth/password', { current: temporaryPassword, next: `${name}-Password-123` });
  return s.as(name, `${name}-Password-123`);
}
const proc = async (name: string, nodes: unknown[], wires: unknown[], extra: Record<string, unknown> = {}) =>
  (await s.api('POST', '/processes', { definition: { name, nodes, wires, ...extra } })).id as string;

describe('invariant 1: one journal entry per activation, in execution order', () => {
  it('keys are <scope>/<node>#n, depth first; control decisions are in input.decision', async () => {
    const id = (await s.api('POST', '/processes', { definition: { ...SYNTHETIC, name: 'Contract order' } })).id;
    const r = await testRun(id, 'api');
    const run = await s.api('GET', `/runs/${r.id}`);
    const keys = steps(run).map((x) => x.key);
    // branches of a parallel node run at the same time: their entries follow the parallel node in the order they ran
    // (by completion on a busy machine), so they are compared as a group; everything else keeps its exact order
    const par = keys.indexOf('par');
    const ordered = [...keys.slice(0, par + 1), ...keys.slice(par + 1, par + 4).sort(), ...keys.slice(par + 4)];
    expect(ordered).toEqual([
      'start',
      'init',
      'list',
      'many',
      'warn',
      'each',
      'each[0]/detail',
      'each[0]/count',
      'each[1]/detail',
      'each[1]/count',
      'each[2]/detail',
      'each[2]/count',
      'par',
      'par[0]/sq',
      'par[1]/sq',
      'par[2]/sq',
      'chk',
      'chk2',
      'rep',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
    const byKey = Object.fromEntries(steps(run).map((x) => [x.key, x]));
    expect((byKey.many!.input as { decision: boolean }).decision).toBe(true);
    expect((byKey.each!.input as { decision: unknown[] }).decision).toHaveLength(3);
  });
});

describe('the engine interface (built-in engine)', () => {
  it('query reads the record: status, current keys, open tasks, mode; events carry mode and debug', async () => {
    const { on } = await import('../src/events.js');
    const seen: { name: string; mode?: string; debug?: unknown }[] = [];
    const offA = on('run.started', (e) => void seen.push({ name: 'started', mode: e.mode, debug: e.debug }));
    const offB = on('run.finished', (e) => void seen.push({ name: 'finished', mode: e.mode, debug: e.debug }));
    const pid = await proc('Contract query', [n('start', 'start'), n('ok', 'userTask', { mode: 'approve', title: 'Go?' })], [w('start', 'ok')]);
    const { id } = await s.api('POST', '/runs', { processId: pid, dryRun: true });
    await s.waitRun(id, ['waiting']);
    const { engine } = await import('../src/engine/index.js');
    const q = engine().query(id);
    expect(q).toMatchObject({ runId: id, status: 'waiting', mode: 'dry', current: ['ok'] });
    expect(q.waitingTasks).toHaveLength(1);
    expect(q.waitingTasks[0]).toMatchObject({ stepKey: 'ok', mode: 'approve' });
    const task = (await s.api('GET', `/runs/${id}`)).tasks[0];
    await s.api('POST', `/tasks/${task.id}/complete`, { approved: true });
    await s.waitRun(id, DONE);
    offA();
    offB();
    expect(seen).toEqual([
      { name: 'started', mode: 'dry', debug: null },
      { name: 'finished', mode: 'dry', debug: null },
    ]);
    expect(engine().query(id)).toMatchObject({ status: 'succeeded', current: [], waitingTasks: [] });
  });
});

describe('invariant 4: the decision is written first; a repeated signal changes nothing', () => {
  it('a second decision and a decision on a cancelled task answer 409 and add nothing to the journal', async () => {
    const pid = await proc(
      'Contract signals',
      [n('start', 'start'), n('ok', 'userTask', { mode: 'approve', title: 'Go?' }), n('after', 'log', { message: 'after' })],
      [w('start', 'ok'), w('ok', 'after', 'approved')],
    );
    const { id } = await s.api('POST', '/runs', { processId: pid, dryRun: true });
    const waiting = await s.waitRun(id, ['waiting']);
    const task = waiting.tasks[0];
    await s.api('POST', `/tasks/${task.id}/complete`, { approved: true });
    // no longer open: refused (TASK_CLOSED) before anything reaches the engine
    await expect(s.api('POST', `/tasks/${task.id}/complete`, { approved: false })).rejects.toMatchObject({ status: 403, body: { code: 'TASK_CLOSED' } });
    const done = await s.waitRun(id, DONE);
    expect(done.status).toBe('succeeded');
    expect(steps(done).map((x) => x.key)).toEqual(['start', 'ok', 'after']);
    // the decision was committed with its audit entry before the run went on
    const audit = await s.api('GET', `/audit?runId=${id}&limit=100`);
    const order = audit.map((a: { action: string }) => a.action).reverse();
    expect(order.indexOf('task.completed')).toBeLessThan(order.indexOf('run.succeeded'));

    const second = await s.api('POST', '/runs', { processId: pid, dryRun: true });
    const w2 = await s.waitRun(second.id, ['waiting']);
    await s.api('POST', `/runs/${second.id}/cancel`, { reason: 'Contract: no longer needed' });
    expect((await s.waitRun(second.id, DONE)).status).toBe('cancelled');
    await expect(s.api('POST', `/tasks/${w2.tasks[0].id}/complete`, { approved: true })).rejects.toMatchObject({ status: 403, body: { code: 'TASK_CLOSED' } });
    expect(steps(await s.api('GET', `/runs/${second.id}`)).map((x) => x.key)).toEqual(['start', 'ok']);
  });

  it('a decision that arrives while the run is not in memory replays it without repeating finished steps', async () => {
    const runner = await import('../src/engine/runner.js');
    const pid = await proc(
      'Contract replay',
      [
        n('start', 'start'),
        n('read', 'http', { connection: 'api', method: 'GET', path: '/health', saveAs: 'h' }),
        n('ok', 'userTask', { mode: 'approve', title: 'Go?' }),
        n('after', 'log', { message: "{{ 'health ' & vars.h.status }}" }),
      ],
      [w('start', 'read'), w('read', 'ok'), w('ok', 'after', 'approved')],
      { connections: [{ slot: 'api' }] },
    );
    const { id } = await s.api('POST', '/runs', { processId: pid, bindings: { api: platformId }, recorded: true });
    const waiting = await s.waitRun(id, ['waiting']);
    const readBefore = steps(waiting).find((x) => x.key === 'read') as { startedAt?: string } | undefined;
    // what a restart leaves: the run in the record only (its waiter and context gone)
    await runner.forgetRunForTests(id);
    expect(runner.isActive(id)).toBe(false);
    await s.api('POST', `/tasks/${waiting.tasks[0].id}/complete`, { approved: true });
    const done = await s.waitRun(id, DONE);
    expect(done.status).toBe('succeeded');
    expect(steps(done).map((x) => x.key)).toEqual(['start', 'read', 'ok', 'after']);
    expect((steps(done).find((x) => x.key === 'read') as { startedAt?: string }).startedAt).toBe(readBefore?.startedAt);
    const audit = await s.api('GET', `/audit?runId=${id}&limit=100`);
    expect(audit.filter((a: { action: string }) => a.action === 'run.resumed')).toHaveLength(1);
  });
});

describe('invariant 5: cancel reaches the open request, open tasks and child runs; one run.cancelled with its reason', () => {
  it('a slow request is aborted', async () => {
    const http = await import('node:http');
    let open = 0;
    const slow = http.createServer((_req, res) => {
      open++;
      setTimeout(() => res.end('{}'), 30_000).unref();
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
    const port = (slow.address() as { port: number }).port;
    try {
      const pf = (
        await s.api('POST', '/platforms', {
          name: 'Slow API',
          kind: 'generic',
          baseUrl: `http://127.0.0.1:${port}`,
          config: { variables: {}, http: { proxy: 'none' } },
        })
      ).id;
      const pid = await proc(
        'Contract slow',
        [n('start', 'start'), n('slow', 'http', { connection: 'api', method: 'GET', path: '/slow' })],
        [w('start', 'slow')],
        { connections: [{ slot: 'api' }] },
      );
      const { id } = await s.api('POST', '/runs', { processId: pid, bindings: { api: pf } });
      await until(async () => open > 0);
      const t0 = Date.now();
      await s.api('POST', `/runs/${id}/cancel`, {});
      const r = await s.waitRun(id, DONE);
      expect(r.status).toBe('cancelled');
      expect(Date.now() - t0).toBeLessThan(10_000);
      const audit = await s.api('GET', `/audit?runId=${id}&limit=50`);
      const cancelled = audit.filter((a: { action: string }) => a.action === 'run.cancelled');
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].summary).toMatch(/cancelled by admin$/);
      expect(cancelled[0].details).toMatchObject({ reason: 'Cancelled by admin', cancelledBy: 'admin' });
    } finally {
      slow.closeAllConnections();
      slow.close();
    }
  });

  it('a wait, open tasks and a running child run are cancelled with it', async () => {
    const child = await proc('Contract child', [n('start', 'start'), n('ok', 'userTask', { mode: 'approve', title: 'Child?' })], [w('start', 'ok')]);
    const parent = await proc('Contract parent', [n('start', 'start'), n('sub', 'subprocess', { process: child })], [w('start', 'sub')]);
    const { id } = await s.api('POST', '/runs', { processId: parent, dryRun: true });
    await until(async () => (await s.api('GET', `/runs/${id}`)).children?.length > 0);
    const childId = (await s.api('GET', `/runs/${id}`)).children[0].id;
    await s.waitRun(childId, ['waiting']);
    await s.api('POST', `/runs/${id}/cancel`, { reason: 'Contract: stop the chain' });
    expect((await s.waitRun(id, DONE)).status).toBe('cancelled');
    const cr = await s.waitRun(childId, DONE);
    expect(cr.status).toBe('cancelled');
    expect(cr.tasks[0].status).toBe('cancelled');
    const audit = await s.api('GET', `/audit?runId=${childId}&limit=50`);
    const entries = audit.filter((a: { action: string }) => a.action === 'run.cancelled');
    expect(entries).toHaveLength(1);
    expect(entries[0].details.reason).toContain('Contract: stop the chain');

    const waits = await proc('Contract wait', [n('start', 'start'), n('w', 'wait', { seconds: 60 })], [w('start', 'w')]);
    const wr = await s.api('POST', '/runs', { processId: waits, dryRun: true });
    await until(async () => steps(await s.api('GET', `/runs/${wr.id}`)).some((x) => x.key === 'w'));
    await s.api('POST', `/runs/${wr.id}/cancel`, {});
    expect((await s.waitRun(wr.id, DONE)).status).toBe('cancelled');
  });
});

describe('invariant 6: modes are inherited; nesting is limited', () => {
  it('a child run has the parent mode, actor and recorded flag; recursion and depth are refused', async () => {
    const child = await proc(
      'Contract test child',
      [n('start', 'start'), n('read', 'http', { connection: 'api', method: 'GET', path: '/health', saveAs: 'h' })],
      [w('start', 'read')],
      { connections: [{ slot: 'api' }], outputs: { ok: 'vars.h.body.ok' } },
    );
    const parent = await proc(
      'Contract test parent',
      [n('start', 'start'), n('sub', 'subprocess', { process: child, saveAs: 'r' }), n('chk', 'check', { condition: 'vars.r.ok = true' })],
      [w('start', 'sub'), w('sub', 'chk')],
      { connections: [{ slot: 'api' }] },
    );
    const r = await testRun(parent, 'api');
    expect(r.status).toBe('succeeded');
    const kid = (await s.api('GET', `/runs/${r.id}`)).children[0];
    const kr = await s.api('GET', `/runs/${kid.id}`);
    expect(kr).toMatchObject({ recorded: true, dryRun: true, actor: 'admin', trigger: 'subprocess', parentRunId: r.id });

    const self = await proc('Contract recursion', [n('start', 'start')], []);
    await s.api('PUT', `/processes/${self}`, {
      definition: { name: 'Contract recursion', nodes: [n('start', 'start'), n('sub', 'subprocess', { process: self })], wires: [w('start', 'sub')] },
    });
    const rec = await s.api('POST', '/runs', { processId: self, dryRun: true });
    const rr = await s.waitRun(rec.id, DONE);
    expect(rr.status).toBe('failed');
    expect(rr.error).toContain('Recursion');

    // a chain deeper than MAX_SUBPROCESS_DEPTH (5)
    const { MAX_SUBPROCESS_DEPTH } = await import('../src/engine/index.js');
    let next = await proc('Contract depth leaf', [n('start', 'start')], []);
    for (let i = 0; i <= MAX_SUBPROCESS_DEPTH + 1; i++)
      next = await proc(`Contract depth ${i}`, [n('start', 'start'), n('sub', 'subprocess', { process: next })], [w('start', 'sub')]);
    const deep = await s.api('POST', '/runs', { processId: next, dryRun: true });
    const dr = await s.waitRun(deep.id, DONE);
    expect(dr.status).toBe('failed');
    expect(dr.error).toContain('Sub-process run');
  });
});

describe('dry and test runs', () => {
  it('writes are skipped and audited (api.write_skipped) in both', async () => {
    const pid = await proc(
      'Contract write',
      [n('start', 'start'), n('write', 'http', { connection: 'api', method: 'POST', path: '/items', body: { a: 1 } })],
      [w('start', 'write')],
      { connections: [{ slot: 'api' }] },
    );
    for (const mode of [{ dryRun: true }, { recorded: true }]) {
      const { id } = await s.api('POST', '/runs', { processId: pid, bindings: { api: platformId }, ...mode });
      const r = await s.waitRun(id, DONE);
      expect(r.status).toBe('succeeded');
      expect(r.stats.skippedWrites).toBe(1);
      const audit = await s.api('GET', `/audit?runId=${id}&limit=50`);
      expect(audit.some((a: { action: string }) => a.action === 'api.write_skipped')).toBe(true);
      expect(audit.some((a: { action: string }) => a.action === 'api.write')).toBe(false);
    }
  });
});

describe('the queue (SM_MAX_CONCURRENT_RUNS)', () => {
  it('a run beyond the limit is queued with its place; a waiting run frees its slot', async () => {
    const { config } = await import('../src/config.js');
    const { engine } = await import('../src/engine/index.js');
    const before = config.maxConcurrentRuns;
    const waits = await proc('Contract queue wait', [n('start', 'start'), n('w', 'wait', { seconds: 30 })], [w('start', 'w')]);
    const asks = await proc('Contract queue ask', [n('start', 'start'), n('ok', 'userTask', { mode: 'approve', title: 'Go?' })], [w('start', 'ok')]);
    config.maxConcurrentRuns = 1;
    try {
      const a = await s.api('POST', '/runs', { processId: waits, dryRun: true });
      const b = await s.api('POST', '/runs', { processId: waits, dryRun: true });
      expect(engine().query(b.id)).toMatchObject({ status: 'queued', queuePosition: 1 });
      await s.api('POST', `/runs/${a.id}/cancel`, {});
      await until(async () => engine().query(b.id).status === 'running');
      await s.api('POST', `/runs/${b.id}/cancel`, {});
      await s.waitRun(b.id, DONE);
      // a run waiting for a person does not hold the slot
      const c = await s.api('POST', '/runs', { processId: asks, dryRun: true });
      await s.waitRun(c.id, ['waiting']);
      const d = await s.api('POST', '/runs', { processId: waits, dryRun: true });
      expect(engine().query(d.id).status).toBe('running');
      await s.api('POST', `/runs/${d.id}/cancel`, {});
      await s.api('POST', `/runs/${c.id}/cancel`, {});
    } finally {
      config.maxConcurrentRuns = before;
    }
  });
});

describe('the command layer (engine/commands.ts)', () => {
  it('start: view (else not found), run, use on every bound platform; debug runs need edit, an offline node only edit', async () => {
    const { startProblem, authorizeStart } = await import('../src/engine/commands.js');
    const pid = await proc('Contract rights', [n('start', 'start')], [], { connections: [{ slot: 'api' }] });
    const op = { id: 'u-op', username: 'contract-op', displayName: 'Op', roles: ['operator'], teams: [] } as never;
    const des = { id: 'u-des', username: 'contract-des', displayName: 'Des', roles: ['designer'], teams: [] } as never;
    const viewer = { id: 'u-v', username: 'contract-viewer', displayName: 'V', roles: ['viewer'], teams: [] } as never;
    const status = { id: 'u-s', username: 'contract-status', displayName: 'S', roles: ['status'], teams: [] } as never;
    expect(startProblem(op, { processId: pid, bindings: { api: platformId } })).toBeNull();
    expect(startProblem(viewer, { processId: pid })?.code).toBe('mayNotRun');
    expect(startProblem(status, { processId: pid })?.code).toBe('processNotFound');
    expect(startProblem('no-such-user', { processId: pid })?.code).toBe('actorMissing');
    expect(startProblem(op, { processId: pid, bindings: { api: 'plt_missing' } })?.code).toBe('platformMissing');
    // a platform only the administrator may use
    const closed = (
      await s.api('POST', '/platforms', {
        name: 'Closed API',
        kind: 'generic',
        baseUrl: 'http://127.0.0.1:9/closed',
        config: { variables: {}, http: { proxy: 'none' } },
      })
    ).id;
    await s.api('PUT', `/platforms/${closed}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage', 'use'] }] });
    expect(startProblem(op, { processId: pid, bindings: { api: closed } })).toMatchObject({ code: 'mayNotUsePlatform', vars: { platform: closed } });
    // debug runs (ADR 0010)
    expect(startProblem(op, { processId: pid, debug: { kind: 'step' } })?.code).toBe('mayNotEdit');
    expect(startProblem(des, { processId: pid, bindings: { api: platformId }, debug: { kind: 'step' } })).toBeNull();
    expect(startProblem(des, { processId: pid, bindings: { api: closed }, debug: { kind: 'node', answers: 'recorded', slots: ['api'] } })?.code).toBe(
      'mayNotUsePlatform',
    );
    expect(startProblem(des, { processId: pid, bindings: { api: closed }, debug: { kind: 'node', answers: 'offline', slots: ['api'] } })).toBeNull();
    expect(() => authorizeStart(viewer, { processId: pid })).toThrow(/not allowed to run this process/);
  });

  it('every route that starts runs goes through it: POST /runs, schedules and triggers refuse what a run would', async () => {
    const pid = await proc('Contract routes', [n('start', 'start')], [], { connections: [{ slot: 'api' }] });
    const closed = (
      await s.api('POST', '/platforms', {
        name: 'Closed API 2',
        kind: 'generic',
        baseUrl: 'http://127.0.0.1:9/closed2',
        config: { variables: {}, http: { proxy: 'none' } },
      })
    ).id;
    await s.api('PUT', `/platforms/${closed}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage', 'use'] }] });
    const olga = await user('contract-olga', ['operator']);
    expect(await status(olga('POST', '/runs', { processId: pid, bindings: { api: closed }, dryRun: true }))).toBe(403);
    expect(await status(olga('POST', '/schedules', { name: 'x', processId: pid, cron: '0 3 * * *', bindings: { api: closed } }))).toBe(403);
    expect(await status(olga('POST', '/triggers', { name: 'x', processId: pid, bindings: { api: closed } }))).toBe(403);
    expect(await status(olga('POST', '/runs', { processId: 'no-such-process', dryRun: true }))).toBe(404);
    const ok = await olga('POST', '/runs', { processId: pid, bindings: { api: platformId }, dryRun: true });
    expect((await s.waitRun(ok.id, DONE)).status).toBe('succeeded');
  });

  it('a sub-process step checks run and (since 0.10.0) use on the child, with the rights of the run actor', async () => {
    const closed = (
      await s.api('POST', '/platforms', {
        name: 'Closed API 3',
        kind: 'generic',
        baseUrl: 'http://127.0.0.1:9/closed3',
        config: { variables: {}, http: { proxy: 'none' } },
      })
    ).id;
    await s.api('PUT', `/platforms/${closed}/access`, {
      acl: [
        { subject: 'user:admin', permissions: ['manage', 'use'] },
        { subject: 'user:contract-ulla', permissions: ['use'] },
      ],
    });
    const ulla = await user('contract-ulla', ['operator']);
    const child = await proc('Contract use child', [n('start', 'start')], [], { connections: [{ slot: 'api' }] });
    const parent = await proc(
      'Contract use parent',
      [n('start', 'start'), n('ok', 'userTask', { mode: 'approve', title: 'Go?' }), n('sub', 'subprocess', { process: child })],
      [w('start', 'ok'), w('ok', 'sub', 'approved')],
      { connections: [{ slot: 'api' }] },
    );
    const { id } = await ulla('POST', '/runs', { processId: parent, bindings: { api: closed }, dryRun: true });
    const waiting = await s.waitRun(id, ['waiting']);
    // the right is taken away while the run waits
    await s.api('PUT', `/platforms/${closed}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage', 'use'] }] });
    await s.api('POST', `/tasks/${waiting.tasks[0].id}/complete`, { approved: true });
    const r = await s.waitRun(id, DONE);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('may not use platform');
  });
});
