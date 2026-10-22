import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { freshDbEnv } from './pg-env.js';

let s: TestServer;
let hub: string;
let iem: string;
let flaky: string;
let demoPassword: string;

const DONE = ['succeeded', 'failed', 'cancelled'];
const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const w = (from: string, to: string, port = 'out') => ({ from, port, to });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createProcess(def: Record<string, unknown>, client: Client = s.api): Promise<string> {
  const p = await client('POST', '/processes', { definition: { name: `x-${Math.random().toString(36).slice(2)}`, connections: [], inputs: [], ...def } });
  return p.id;
}

async function start(
  processId: string,
  opts: { bindings?: Record<string, string>; inputs?: Record<string, unknown>; dryRun?: boolean } = {},
  client: Client = s.api,
) {
  const { id } = await client('POST', '/runs', { processId, bindings: opts.bindings ?? {}, inputs: opts.inputs ?? {}, dryRun: opts.dryRun });
  return id as string;
}

async function runToEnd(processId: string, opts: Parameters<typeof start>[1] = {}, client: Client = s.api) {
  return s.waitRun(await start(processId, opts, client), DONE);
}

const step = (r: any, key: string) => r.steps.find((x: any) => x.key === key);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  demoPassword = (await s.api('POST', '/demo/setup', {})).password;
  const platforms = await s.api('GET', '/platforms');
  hub = platforms.find((p: any) => p.kind === 'insights-hub').id;
  iem = platforms.find((p: any) => p.kind === 'industrial-edge-management').id;
  flaky = (
    await s.api('POST', '/platforms', {
      name: 'Flaky test API',
      kind: 'generic',
      baseUrl: `${s.base}/mock`,
      config: { auth: { type: 'none' }, variables: { region: 'test' }, http: { proxy: 'none', retry: { baseDelayMs: 50, maxDelayMs: 1500 } } },
    })
  ).id;
});
afterAll(async () => {
  await s?.app.close();
});

const flakyCalls = async (key: string) => (await (await fetch(`${s.base}/mock/test/flaky/calls?key=${key}`)).json()).calls;

describe('HTTP retries', () => {
  it('retries 429 honouring Retry-After and records the attempts', async () => {
    const id = await createProcess({
      connections: [{ slot: 'api' }],
      nodes: [n('start', 'start'), n('call', 'http', { connection: 'api', method: 'GET', path: '/test/flaky', query: { key: 'k1', fail: 2 }, saveAs: 'res' })],
      wires: [w('start', 'call')],
    });
    const t0 = Date.now();
    const r = await runToEnd(id, { bindings: { api: flaky } });
    expect(r.status).toBe('succeeded');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900); // 2 × Retry-After: 1
    const full = await s.api('GET', `/runs/${r.id}/steps/${step(r, 'call').id}`);
    expect(full.output.attempts).toBe(3);
    expect(full.output.body.calls).toBe(3);
    expect(await flakyCalls('k1')).toBe(3);
    expect(r.logs.some((l: any) => l.message.includes('after 3 attempts'))).toBe(true);
  });

  it('caps Retry-After at maxDelayMs and retries 503', async () => {
    const id = await createProcess({
      connections: [{ slot: 'api' }],
      nodes: [
        n('start', 'start'),
        n('call', 'http', { connection: 'api', method: 'GET', path: '/test/flaky', query: { key: 'k1b', fail: 1, status: 503, retryAfter: 3600 } }),
      ],
      wires: [w('start', 'call')],
    });
    const t0 = Date.now();
    const r = await runToEnd(id, { bindings: { api: flaky } });
    expect(r.status).toBe('succeeded');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await flakyCalls('k1b')).toBe(2);
  });

  it('does not repeat POST requests by default', async () => {
    const id = await createProcess({
      connections: [{ slot: 'api' }],
      nodes: [
        n('start', 'start'),
        n('call', 'http', { connection: 'api', method: 'POST', path: '/test/flaky', query: { key: 'k2', fail: 1 }, body: { a: 1 } }),
      ],
      wires: [w('start', 'call')],
    });
    const r = await runToEnd(id, { bindings: { api: flaky } });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('HTTP 429');
    expect(await flakyCalls('k2')).toBe(1);
  });
});

describe('redaction of query API keys', () => {
  it('masks the key in every URL encoding in the run journal and logs', async () => {
    // URLSearchParams (buildUrl) escapes ~ as %7E, encodeURIComponent does not; the echo uses both cases of hex
    const key = 'k3y~Sup3rS3cret~Value';
    const api = (
      await s.api('POST', '/platforms', {
        name: 'Query key API',
        kind: 'generic',
        baseUrl: `${s.base}/mock`,
        config: { auth: { type: 'apiKey', apiKeyIn: 'query', apiKeyName: 'api_key' }, variables: {}, http: { proxy: 'none' } },
        secrets: { apiKey: key },
      })
    ).id;
    const id = await createProcess({
      connections: [{ slot: 'api' }],
      nodes: [
        n('start', 'start'),
        n('upper', 'http', { connection: 'api', method: 'GET', path: '/test/echo-url', saveAs: 'a' }),
        n('lower', 'http', { connection: 'api', method: 'GET', path: '/test/echo-url', query: { lowerHex: 1 }, saveAs: 'b' }),
        n('show', 'log', { message: 'urls {{ vars.a.body.url }} {{ vars.b.body.url }} {{ vars.a.headers.link }} {{ vars.b.headers.link }}' }),
      ],
      wires: [w('start', 'upper'), w('upper', 'lower'), w('lower', 'show')],
    });
    const r = await runToEnd(id, { bindings: { api } });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    const steps = await Promise.all(r.steps.map((x: any) => s.api('GET', `/runs/${r.id}/steps/${x.id}`)));
    expect(JSON.stringify(steps)).toContain('api_key=***');
    const d = (await import('../src/db.js')).db();
    const everything = JSON.stringify([
      r,
      steps,
      d.all('SELECT * FROM run_steps WHERE run_id = ?', r.id),
      d.all('SELECT * FROM run_logs WHERE run_id = ?', r.id),
      d.all('SELECT * FROM audit_log WHERE run_id = ?', r.id),
    ]);
    expect(everything).toContain('urls ');
    expect(everything).not.toMatch(/Sup3rS3cret/i);
    await s.api('DELETE', `/platforms/${api}`);
  });
});

describe('parallel for-each', () => {
  const loopProcess = (concurrency: number) =>
    createProcess({
      connections: [{ slot: 'api' }],
      nodes: [
        n('start', 'start'),
        n('init', 'set', { values: { outer: 'kept' } }),
        n('loop', 'forEach', { items: '[1..8]', as: 'i', concurrency, saveAs: 'loopOut' }),
        n('fetch', 'http', { connection: 'api', method: 'GET', path: '/test/delay', query: { ms: 300, value: '{{ vars.i }}' }, saveAs: 'r' }),
        n('calc', 'set', { values: { doubled: '{{ vars.i * 2 }}', echoed: '{{ vars.r.body.value }}', seenOuter: '{{ vars.outer }}' } }),
        n('after', 'log', {
          message:
            '{{ $exists(vars.doubled) }}|{{ $join(vars.loopOut.results.$string(doubled), ",") }}|{{ $join(vars.loopOut.results.echoed, ",") }}|{{ vars.outer }}',
        }),
      ],
      wires: [w('start', 'init'), w('init', 'loop'), w('loop', 'fetch', 'each'), w('fetch', 'calc'), w('loop', 'after', 'done')],
    });

  it('runs items concurrently with per-item variables and order-stable results', async () => {
    const parallel = await runToEnd(await loopProcess(4), { bindings: { api: flaky } });
    expect(parallel.status).toBe('succeeded');
    expect(step(parallel, 'after').summary).toBe('false|2,4,6,8,10,12,14,16|1,2,3,4,5,6,7,8|kept');
    for (let i = 0; i < 8; i++) expect(step(parallel, `loop[${i}]/calc`).status).toBe('succeeded');
    const sequential = await runToEnd(await loopProcess(1), { bindings: { api: flaky } });
    expect(sequential.status).toBe('succeeded');
    const pMs = step(parallel, 'loop').durationMs;
    const sMs = step(sequential, 'loop').durationMs;
    expect(sMs).toBeGreaterThanOrEqual(2400);
    expect(pMs).toBeLessThan(sMs * 0.6);
  });

  it('fails the run when an item fails and stops on cancel', async () => {
    const failing = await createProcess({
      nodes: [
        n('start', 'start'),
        n('loop', 'forEach', { items: '[1..6]', as: 'i', concurrency: 3 }),
        n('maybe', 'fail', { message: 'item {{ vars.i }} broke', when: 'vars.i = 2' }),
      ],
      wires: [w('start', 'loop'), w('loop', 'maybe', 'each')],
    });
    const r = await runToEnd(failing);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('item 2 broke');

    const slow = await createProcess({
      nodes: [n('start', 'start'), n('loop', 'forEach', { items: '[1..20]', as: 'i', concurrency: 2 }), n('pause', 'wait', { seconds: 1 })],
      wires: [w('start', 'loop'), w('loop', 'pause', 'each')],
    });
    const id = await start(slow);
    await sleep(500);
    await s.api('POST', `/runs/${id}/cancel`);
    const c = await s.waitRun(id, DONE);
    expect(c.status).toBe('cancelled');
    expect(c.steps.filter((x: any) => x.stepId === 'pause').length).toBeLessThanOrEqual(4);
  });
});

describe('sub-processes', () => {
  let child: string;
  beforeAll(async () => {
    child = await createProcess({
      connections: [{ slot: 'api' }],
      inputs: [{ name: 'n', type: 'number', required: true }],
      outputs: { double: 'inputs.n * 2', greeting: 'vars.msg', users: 'vars.users.body.totalResults' },
      nodes: [
        n('start', 'start'),
        n('msg', 'set', { values: { msg: 'hi {{ inputs.n }}' } }),
        n('users', 'http', { connection: 'api', method: 'GET', path: '/api/identitymanagement/v3/Users', query: { count: 1 }, saveAs: 'users' }),
      ],
      wires: [w('start', 'msg'), w('msg', 'users')],
    });
  });

  const parentOf = (childId: string, extra: Record<string, unknown> = {}) =>
    createProcess({
      connections: [{ slot: 'hub' }],
      nodes: [
        n('start', 'start'),
        n('sub', 'subprocess', { process: childId, inputs: { n: '{{ 20 + 1 }}' }, connections: { api: 'hub' }, saveAs: 'res', ...extra }),
        n('show', 'log', { message: '{{ vars.res.double }} {{ vars.res.greeting }} {{ vars.res.users }}' }),
        n('handled', 'log', { message: 'handled: {{ vars.res.error }}' }),
      ],
      wires: [w('start', 'sub'), w('sub', 'show'), w('sub', 'handled', 'error')],
    });

  it('passes inputs, returns outputs and links the child run', async () => {
    const parent = await parentOf(child);
    const r = await runToEnd(parent, { bindings: { hub } });
    expect(r.status).toBe('succeeded');
    expect(step(r, 'show').summary).toBe('42 hi 21 15');
    expect(r.children).toHaveLength(1);
    expect(r.children[0]).toMatchObject({ processId: child, status: 'succeeded', parentStepKey: 'sub' });
    const c = await s.api('GET', `/runs/${r.children[0].id}`);
    expect(c).toMatchObject({ parentRunId: r.id, parentStepKey: 'sub', trigger: 'subprocess', actor: 'admin', dryRun: false });
    expect(c.outputs).toEqual({ double: 42, greeting: 'hi 21', users: 15 });
    expect(c.bindings.api.platformId).toBe(hub);
    expect(step(r, 'sub').input.childRunId).toBe(c.id);
    const list = await s.api('GET', `/runs?processId=${child}`);
    expect(list.find((x: any) => x.id === c.id).parentRunId).toBe(r.id);
  });

  it('propagates dry runs', async () => {
    const r = await runToEnd(await parentOf(child), { bindings: { hub }, dryRun: true });
    expect(r.status).toBe('succeeded');
    expect((await s.api('GET', `/runs/${r.children[0].id}`)).dryRun).toBe(true);
  });

  it('routes a failed child run to the error output', async () => {
    const failing = await createProcess({ nodes: [n('start', 'start'), n('boom', 'fail', { message: 'child broke' })], wires: [w('start', 'boom')] });
    const r = await runToEnd(await parentOf(failing), { bindings: { hub } });
    expect(r.status).toBe('succeeded');
    expect(step(r, 'handled').summary).toContain('child broke');
    expect(step(r, 'show')).toBeUndefined();
    expect(r.children[0].status).toBe('failed');

    const unhandled = await createProcess({
      nodes: [n('start', 'start'), n('sub', 'subprocess', { process: failing })],
      wires: [w('start', 'sub')],
    });
    const r2 = await runToEnd(unhandled);
    expect(r2.status).toBe('failed');
    expect(r2.error).toContain('child broke');
  });

  it('prevents recursion', async () => {
    const a = await createProcess({ nodes: [n('start', 'start'), n('log', 'log', { message: 'placeholder' })], wires: [w('start', 'log')] });
    const b = await createProcess({ nodes: [n('start', 'start'), n('callA', 'subprocess', { process: a })], wires: [w('start', 'callA')] });
    await s.api('PUT', `/processes/${a}`, {
      definition: {
        name: 'recursive a',
        connections: [],
        inputs: [],
        nodes: [n('start', 'start'), n('callB', 'subprocess', { process: b })],
        wires: [w('start', 'callB')],
      },
    });
    const r = await runToEnd(a);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('Recursion');
    const childB = await s.api('GET', `/runs/${r.children[0].id}`);
    expect(childB.status).toBe('failed');
    expect(childB.children).toEqual([]);

    const self = await createProcess({ nodes: [n('start', 'start')], wires: [] });
    await s.api('PUT', `/processes/${self}`, {
      definition: {
        name: 'self',
        connections: [],
        inputs: [],
        nodes: [n('start', 'start'), n('me', 'subprocess', { process: self })],
        wires: [w('start', 'me')],
      },
    });
    const r3 = await runToEnd(self);
    expect(r3.status).toBe('failed');
    expect(r3.error).toContain('Recursion');
    expect(r3.children).toEqual([]);
  });

  it('needs the run right on the child process', async () => {
    const restricted = await createProcess({ nodes: [n('start', 'start')], wires: [] });
    await s.api('PUT', `/processes/${restricted}/access`, { acl: [{ subject: 'user:dana', permissions: ['view', 'run'] }] });
    const parent = await createProcess({ nodes: [n('start', 'start'), n('sub', 'subprocess', { process: restricted })], wires: [w('start', 'sub')] });
    const olivia = await s.as('olivia', demoPassword);
    const r = await runToEnd(parent, {}, olivia);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('may not run');
    expect(r.children).toEqual([]);
  });

  it('cancels the child with the parent', async () => {
    const slow = await createProcess({ nodes: [n('start', 'start'), n('pause', 'wait', { seconds: 30 })], wires: [w('start', 'pause')] });
    const parent = await createProcess({ nodes: [n('start', 'start'), n('sub', 'subprocess', { process: slow })], wires: [w('start', 'sub')] });
    const id = await start(parent);
    let detail: any;
    for (let i = 0; i < 50; i++) {
      detail = await s.api('GET', `/runs/${id}`);
      if (detail.children?.length) break;
      await sleep(100);
    }
    expect(detail.status).toBe('waiting'); // waiting for the sub-process
    await s.api('POST', `/runs/${id}/cancel`);
    expect((await s.waitRun(id, DONE)).status).toBe('cancelled');
    expect((await s.waitRun(detail.children[0].id, DONE)).status).toBe('cancelled');
  });

  it('runs the bundled sub-process example', async () => {
    const { id } = await s.api('POST', '/runs', { processId: 'ih-onboarding-with-subflow', bindings: { hub }, dryRun: true });
    let r: any;
    for (let i = 0; i < 100; i++) {
      r = await s.api('GET', `/runs/${id}`);
      const t = r.tasks.find((x: any) => x.status === 'open');
      if (t) await s.api('POST', `/tasks/${t.id}/complete`, { approved: true, selectedKeys: [] });
      if (DONE.includes(r.status)) break;
      await sleep(100);
    }
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(r.children[0].processId).toBe('subflow-resolve-group');
    expect(r.stats.skippedWrites).toBe(2);
    expect(r.reports[0].rows.map((x: string[]) => x[1])).toEqual(['membership added', 'membership added', 'unknown user']);
  });
});

describe('metrics and readiness', () => {
  it('exposes Prometheus metrics to admins and auditors', async () => {
    const text: string = await s.api('GET', '/metrics');
    expect(text).toMatch(/sm_runs_total\{process="[^"]+",status="succeeded",trigger="manual"\} \d+/);
    expect(text).toContain('sm_runs_total{');
    expect(text).toContain('trigger="subprocess"');
    expect(text).toContain('sm_step_duration_seconds_bucket{');
    expect(text).toContain('sm_http_requests_total{');
    expect(text).toContain('sm_runs_active');
    expect(text).toContain('sm_tasks_open');
    expect(text).toContain('sm_dataset_age_seconds{dataset="ih.users"}');
    expect(text).toContain('sm_process_cpu_user_seconds_total');
    const audrey = await s.as('audrey', demoPassword);
    expect(await audrey('GET', '/metrics')).toContain('sm_runs_total');
    const vera = await s.as('vera', demoPassword);
    await expect(vera('GET', '/metrics')).rejects.toMatchObject({ status: 403 });
    expect((await fetch(`${s.base}/api/metrics`)).status).toBe(401);
  });

  it('reports readiness without signing in', async () => {
    const res = await fetch(`${s.base}/api/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.checks.vault.ok && body.checks.database.ok && body.checks.scheduler.ok).toBe(true);
  });
});

describe('editor support', () => {
  let proc: string;
  let runId: string;
  beforeAll(async () => {
    proc = await createProcess({
      connections: [{ slot: 'hub' }],
      inputs: [{ name: 'limit', type: 'number', default: 5 }],
      constants: { team: 'ops' },
      nodes: [
        n('start', 'start'),
        n('a', 'set', { values: { x: 1, secretCopy: "{{ $secret('hub', 'clientSecret') }}" } }),
        n('users', 'http', { connection: 'hub', method: 'GET', path: '/api/identitymanagement/v3/Users', saveAs: 'users' }),
        n('b', 'set', { values: { x: 2, long: '{{ $join([1..200].$string(), "-") }}' } }),
        n('loop', 'forEach', { items: '["p","q"]', as: 'item' }),
        n('each', 'log', { message: '{{ vars.item }} {{ vars.x }}' }),
      ],
      wires: [w('start', 'a'), w('a', 'users'), w('users', 'b'), w('b', 'loop'), w('loop', 'each', 'each')],
    });
    const r = await runToEnd(proc, { bindings: { hub } });
    expect(r.status).toBe('succeeded');
    runId = r.id;
  });

  it('lists scope hints', async () => {
    const h = await s.api('GET', `/processes/${proc}/scope`);
    expect(h.runId).toBe(runId);
    expect(h.inputs).toEqual(['limit']);
    expect(h.constants).toEqual(['team']);
    expect(h.connections).toEqual([{ slot: 'hub', vars: expect.arrayContaining(['tenant', 'idmPath']) }]);
    const names = h.vars.map((v: any) => v.name);
    expect(names).toEqual(expect.arrayContaining(['x', 'users', 'long', 'item']));
    expect(h.vars.find((v: any) => v.name === 'x').sample).toBe('2');
    expect(h.vars.every((v: any) => v.sample.length <= 120)).toBe(true);
    expect(JSON.stringify(h)).not.toContain('demo-secret');
    const fns = h.functions.map((f: any) => f.name);
    expect(fns).toEqual(expect.arrayContaining(['$count', '$map', '$toMillis', '$daysSince', '$pvar']));
    expect(h.functions.every((f: any) => f.signature && f.help)).toBe(true);
  });

  it('evaluates expressions against run data without secrets', async () => {
    const ev = (body: Record<string, unknown>) => s.api('POST', `/processes/${proc}/evaluate`, body);
    expect(await ev({ expression: 'vars.x' })).toEqual({ ok: true, value: 2, runId });
    expect((await ev({ expression: 'vars.x', nodeId: 'b' })).value).toBe(1);
    expect((await ev({ expression: '$count(vars.users.body.resources)', nodeId: 'b' })).value).toBe(15);
    expect((await ev({ expression: 'vars.users', nodeId: 'users' })).value).toBeUndefined();
    expect((await ev({ expression: 'vars.item & "/" & vars.itemIndex', nodeId: 'each' })).value).toBe('p/0');
    expect((await ev({ expression: 'Limit {{ inputs.limit }} for {{ const.team }} on {{ conn.hub.vars.region }}', template: true })).value).toBe(
      'Limit 5 for ops on eu1',
    );
    expect((await ev({ expression: 'name & "!"', item: { name: 'x' } })).value).toBe('x!');
    expect((await ev({ expression: "$pvar('hub', 'tenant')" })).value).toBe('demotenant');
    // secrets never leave the server
    const sec = await ev({ expression: "$secret('hub', 'clientSecret')" });
    expect(sec.ok).toBe(false);
    expect(sec.error).toContain('not available');
    const all = await ev({ expression: '$' });
    expect(all.ok).toBe(true);
    expect(JSON.stringify(all)).not.toContain('demo-secret');
    expect(all.value.vars.secretCopy).toBe('***');
    expect(JSON.stringify(await ev({ expression: 'vars.secretCopy & "x"' }))).not.toContain('demo-secret');
    // guard rails
    const loop = await ev({ expression: '($f := function($x) { $f($x + 1) }; $f(1))' });
    expect(loop.ok).toBe(false);
    const big = await ev({ expression: '[1..200000]' });
    expect(big.ok).toBe(true);
    expect(JSON.stringify(big.value).length).toBeLessThan(60000);
    expect((await ev({ expression: '1 +' })).ok).toBe(false);
    const vera = await s.as('vera', demoPassword);
    await expect(vera('POST', `/processes/${proc}/evaluate`, { expression: '1' })).rejects.toMatchObject({ status: 403 });
  });

  it('inspects node activations', async () => {
    const i = await s.api('GET', `/runs/${runId}/inspect/each`);
    expect(i.activations.map((a: any) => [a.key, a.status])).toEqual([
      ['loop[0]/each', 'succeeded'],
      ['loop[1]/each', 'succeeded'],
    ]);
    expect(i.activations[1].output.message).toBe('q 2');
    expect(i.varsBefore).toMatchObject({ x: 2, item: 'p', itemIndex: 0 });
    const b = await s.api('GET', `/runs/${runId}/inspect/b`);
    expect(b.varsBefore.x).toBe(1);
    expect(b.activations[0].input).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain('demo-secret');
    const none = await s.api('GET', `/runs/${runId}/inspect/nope`);
    expect(none).toEqual({ runId, nodeId: 'nope', activations: [], varsBefore: {} });
  });
});

describe('contract check', () => {
  it('checks the documented GET operations of the demo platform', async () => {
    const r = await s.api('POST', `/platforms/${hub}/contract-check`, {});
    expect(r.checked).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(2);
    expect(r.skipped).toBe(2); // operations with path parameters
    expect(r.results.map((x: any) => [x.operationId, x.status, x.ok])).toEqual([
      ['listUsers', 200, true],
      ['listGroups', 200, true],
    ]);
    const audit = await s.api('GET', `/audit?entityType=platform&entityId=${hub}`);
    expect(audit.some((a: any) => a.action === 'platform.contract_checked')).toBe(true);
    const empty = await s.api('POST', `/platforms/${iem}/contract-check`, {});
    expect(empty).toMatchObject({ checked: 0, passed: 0, failed: 0 });
    const olivia = await s.as('olivia', demoPassword);
    await expect(olivia('POST', `/platforms/${hub}/contract-check`, {})).rejects.toMatchObject({ status: 403 });
  });

  it('reports shape problems', async () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Wrong', version: '1' },
      paths: {
        '/test/delay': {
          get: {
            operationId: 'delayAsArray',
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } },
          },
        },
        '/test/flaky/calls': {
          get: {
            operationId: 'calls',
            responses: {
              '200': {
                description: 'ok',
                content: { 'application/json': { schema: { type: 'object', required: ['calls', 'total'], properties: { calls: { type: 'string' } } } } },
              },
            },
          },
        },
      },
    };
    await s.api('POST', `/platforms/${flaky}/specs`, { content: JSON.stringify(spec) });
    const r = await s.api('POST', `/platforms/${flaky}/contract-check`, {});
    expect(r.checked).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.results[0].problems.join(' ')).toContain('documented as array');
    expect(r.results[1].problems).toEqual(['missing required property "total"', 'property "calls" is integer, documented as string']);
  });
});

describe('sub-process after a restart', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-subflow-restart-'));
  const port = 40000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  let proc: ChildProcess | undefined;
  let cookie = '';
  let sessionKey = '';
  const dbEnv = freshDbEnv(); // not the in-process test server's database
  afterAll(() => {
    proc?.kill('SIGKILL');
  });

  const startServer = () =>
    new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          ...dbEnv,
          SM_LOG_LEVEL: 'info',
          SM_DATA_DIR: dataDir,
          SM_PORT: String(port),
          SM_DEMO: '1',
          SM_MASTER_PASSPHRASE: 'restart-test-pass',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('service manager started')) resolve(child);
      });
      child.stderr!.on('data', (d) => (out += d.toString()));
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
      setTimeout(() => reject(new Error('server start timeout: ' + out)), 30000);
    });
  const api = async (method: string, url: string, body?: unknown): Promise<any> => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: {
        'x-sm-client': '1',
        ...(cookie ? { cookie } : {}),
        ...(sessionKey ? { 'x-sm-session': sessionKey } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const key = res.headers.get('x-sm-session-key');
    if (key !== null) sessionKey = key;
    const t = await res.text();
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${t}`);
    return t ? JSON.parse(t) : null;
  };
  const waitFor = async (id: string, ok: (r: any) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const r = await api('GET', `/runs/${id}`);
      if (ok(r)) return r;
      await sleep(100);
    }
    throw new Error('timeout');
  };

  it('re-attaches to the existing child run instead of starting a new one', async () => {
    proc = await startServer();
    await api('POST', '/auth/setup', { passphrase: 'restart-test-pass', username: 'admin', password: 'Admin-password-1' });
    const childId = (
      await api('POST', '/processes', {
        definition: {
          name: 'restart child',
          outputs: { answer: 'vars.decision.approved' },
          nodes: [n('start', 'start'), n('ask', 'userTask', { mode: 'approve', title: 'Go on?', saveAs: 'decision' })],
          wires: [w('start', 'ask')],
        },
      })
    ).id;
    const parentId = (
      await api('POST', '/processes', {
        definition: {
          name: 'restart parent',
          nodes: [
            n('start', 'start'),
            n('sub', 'subprocess', { process: childId, saveAs: 'res' }),
            n('show', 'log', { message: 'answer {{ vars.res.answer }}' }),
          ],
          wires: [w('start', 'sub'), w('sub', 'show')],
        },
      })
    ).id;
    const { id } = await api('POST', '/runs', { processId: parentId });
    const waiting = await waitFor(id, (r) => r.children?.length === 1 && r.status === 'waiting');
    const child = await waitFor(waiting.children[0].id, (r) => r.status === 'waiting' && r.tasks.length === 1);

    proc.kill('SIGKILL');
    await sleep(300);
    proc = await startServer();

    await waitFor(id, (r) => r.status === 'waiting');
    const task = (await waitFor(child.id, (r) => r.status === 'waiting')).tasks[0];
    await sleep(800); // parent re-attached
    await api('POST', `/tasks/${task.id}/complete`, { approved: true, selectedKeys: [] });
    const done = await waitFor(id, (r) => DONE.includes(r.status));
    expect([done.status, done.error]).toEqual(['succeeded', null]);
    expect(done.children).toHaveLength(1);
    expect(done.children[0]).toMatchObject({ id: child.id, status: 'succeeded' });
    expect(done.steps.find((x: any) => x.key === 'show').summary).toBe('answer true');
    expect(done.logs.some((l: any) => l.message.includes(`Re-attached to sub-process run ${child.id}`))).toBe(true);
  }, 90000);
});
