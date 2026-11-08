import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Security review of 0.10.0 (engine boundary and debugging, review c): regression tests. Each failed before the fix.
 *  1. variables copied from a run keep that run's data sources – the AI allowed-data rule holds for them;
 *  2. a debug run is hidden everywhere from people who may not see it (inspect, scope, evaluate, reports, links);
 *  3. at most two single-node runs per person at a time (429 DEBUG_NODE_BUSY);
 *  4. run.cancelled names who cancelled in its summary; the reason is one line of plain text;
 *  5. a decision skipped in a sub-process switches the whole run tree to recorded answers;
 *  6. driving a paused debug run checks the rights of now.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const LLM = 'llm-gateway';
const DONE = ['succeeded', 'failed', 'cancelled'];
let s: TestServer;
let dana: Client;
let dirk: Client;
let vera: Client;
let audrey: Client;
let gateway: string;
let source: string;
let mock: typeof import('../src/mock/mockLlmGateway.js');

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
    (e: { status: number; body?: { code?: string } }) => e.body?.code ?? String(e.status),
  );
async function user(name: string, roles: string[]): Promise<Client> {
  const { temporaryPassword } = await s.api('POST', '/users', { username: name, roles });
  await (
    await s.as(name, temporaryPassword)
  )('POST', '/auth/password', { current: temporaryPassword, next: `${name}-Password-123` });
  return s.as(name, `${name}-Password-123`);
}
const mockKey = () => ({ 'x-api-key': mock.DEMO_LLM.apiKey });
const llmCalls = async (): Promise<unknown[]> => (await (await fetch(`${s.base}/mock/llm/_mock/calls`, { headers: mockKey() })).json()).calls;
const define = async (definition: Record<string, unknown>) => (await s.api('POST', '/processes', { definition })).id as string;
const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 40));
  }
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  dana = await user('sec-dana', ['designer']);
  dirk = await user('sec-dirk', ['designer']);
  vera = await user('sec-vera', ['viewer']);
  audrey = await user('sec-audrey', ['auditor']);
  mock = await import('../src/mock/mockLlmGateway.js');
  const preset = (await s.api('GET', '/platform-presets')).find((p: { kind: string }) => p.kind === LLM);
  gateway = (
    await s.api('POST', '/platforms', {
      name: 'Gateway',
      kind: LLM,
      baseUrl: `${s.base}/mock/llm`,
      config: { ...preset.config, http: { ...preset.config.http, proxy: 'none' } },
      secrets: { apiKey: mock.DEMO_LLM.apiKey },
    })
  ).id;
  source = (await s.api('POST', '/platforms', { name: 'HR source', kind: 'generic', baseUrl: s.base, config: { variables: {}, http: { proxy: 'none' } } })).id;
  // the administrator's AI rule: run inputs may go to the model, data of the HR source may not
  await s.api('PUT', `/platforms/${gateway}/ai`, {
    models: [{ id: 'demo-chat-small', format: 'chat-completions', contextTokens: 32000, maxOutputTokens: 500 }],
    allowedData: { platforms: [], datasets: [], inputs: true },
  });
});

describe('1: copied run data keeps its sources (AI allowed-data rule)', () => {
  it('variables from a run are refused for the model like in the run; typed sample data stays a run input', async () => {
    const pid = await define({
      name: 'Sec AI sources',
      connections: [
        { slot: 'llm', kind: LLM },
        { slot: 'src', kind: 'generic' },
      ],
      nodes: [
        n('start', 'start'),
        n('read', 'http', { connection: 'src', method: 'GET', path: '/mock/test/delay?ms=1&value=SALARY-OF-ALICE-98765', saveAs: 'read' }),
        n('ask', 'ai', {
          connection: 'llm',
          model: 'demo-chat-small',
          prompt: 'Summarise {{ data }}',
          context: [{ name: 'data', from: 'step', step: 'read', path: 'body' }],
          saveAs: 'answer',
        }),
      ],
      wires: [w('start', 'read'), w('read', 'ask')],
    });
    await fetch(`${s.base}/mock/llm/_mock/reset`, { method: 'POST', headers: mockKey() });
    const { id } = await s.api('POST', '/runs', { processId: pid, bindings: { llm: gateway, src: source } });
    expect((await s.waitRun(id, DONE)).status).toBe('failed');

    const copied = await dana('POST', `/processes/${pid}/debug/node`, {
      nodeId: 'ask',
      vars: { from: 'run', runId: id },
      answers: 'live',
      bindings: { llm: gateway },
    });
    expect(copied.status).toBe('failed');
    expect(copied.step.error).toContain('AI_DATA_NOT_ALLOWED');
    expect(JSON.stringify(await llmCalls())).not.toContain('SALARY-OF-ALICE');

    // the same value typed in as sample data is what the person enters: a run input, which the gateway allows
    const typed = await dana('POST', `/processes/${pid}/debug/node`, {
      nodeId: 'ask',
      vars: { from: 'sample', vars: { read: { body: { value: 'typed-by-hand-42' } } } },
      answers: 'live',
      bindings: { llm: gateway },
    });
    expect(typed.status).toBe('succeeded');
    expect(JSON.stringify(await llmCalls())).toContain('typed-by-hand-42');
  });
});

describe('2: a debug run is hidden everywhere from people who may not see it', () => {
  it('inspect, scope, evaluate, reports and record links answer like a missing run; starter and auditors see it', async () => {
    const pid = await define({
      name: 'Sec debug visibility',
      connections: [],
      inputs: [{ name: 'who', type: 'string' }],
      nodes: [n('start', 'start'), n('calc', 'set', { values: { note: "{{ 'private: ' & inputs.who }}" } }), n('after', 'log', { message: 'x' })],
      wires: [w('start', 'calc'), w('calc', 'after')],
    });
    const r = await dana('POST', `/processes/${pid}/debug/node`, {
      nodeId: 'calc',
      vars: { from: 'inputs', inputs: { who: 'dana-sample-PRIVATE-123' } },
      answers: 'offline',
    });
    const runId = r.runId as string;
    for (const c of [vera, dirk]) {
      expect(await status(c('GET', `/runs/${runId}/inspect/calc`))).toBe(404);
      expect(await status(c('GET', `/runs/${runId}/reports`))).toBe(404);
      expect(await status(c('POST', `/runs/${runId}/reports`, {}))).toBe(404);
      expect(await status(c('GET', `/runs/${runId}/report.pdf`))).toBe(404);
      expect(await status(c('GET', `/processes/${pid}/scope?runId=${runId}`))).toBe(404);
    }
    expect(await status(dirk('POST', `/processes/${pid}/evaluate`, { expression: 'inputs.who', runId }))).toBe(404);
    // the people who may see it still can
    expect(JSON.stringify(await dana('GET', `/runs/${runId}/inspect/calc`))).toContain('dana-sample-PRIVATE-123');
    expect(await dana('POST', `/processes/${pid}/evaluate`, { expression: 'inputs.who', runId })).toMatchObject({ ok: true, value: 'dana-sample-PRIVATE-123' });
    expect(await status(audrey('GET', `/runs/${runId}/inspect/calc`))).toBe(200);
    // a link to it from a record resolves only for those who see it
    const { targetVisible } = await import('../src/records/links.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const as = (name: string) => runAs(toAuthUser(findUserByName(name)!), () => targetVisible('run', runId));
    expect(as('sec-vera')).toBe(false);
    expect(as('sec-dirk')).toBe(false);
    expect(as('sec-dana')).toBe(true);
  });
});

describe('3: at most two single-node runs per person at a time', () => {
  it('a third one while two run is refused with DEBUG_NODE_BUSY; afterwards it runs again', async () => {
    const pid = await define({
      name: 'Sec node cap',
      connections: [{ slot: 'src', kind: 'generic' }],
      nodes: [n('start', 'start'), n('slow', 'http', { connection: 'src', method: 'GET', path: '/mock/test/delay?ms=2500' })],
      wires: [w('start', 'slow')],
    });
    const call = () =>
      dana('POST', `/processes/${pid}/debug/node`, { nodeId: 'slow', vars: { from: 'sample', vars: {} }, answers: 'live', bindings: { src: source } });
    const first = [call(), call()];
    await new Promise((r) => setTimeout(r, 400));
    expect(await code(call())).toBe('DEBUG_NODE_BUSY');
    // another person is not held up
    expect(
      (await dirk('POST', `/processes/${pid}/debug/node`, { nodeId: 'slow', vars: { from: 'sample', vars: {} }, answers: 'live', bindings: { src: source } }))
        .status,
    ).toBe('succeeded');
    for (const r of await Promise.all(first)) expect(r.status).toBe('succeeded');
    expect((await call()).status).toBe('succeeded');
  });
});

describe('4: run.cancelled names who cancelled it', () => {
  it('the summary says the canceller, the reason follows as one line of plain text', async () => {
    const pid = await define({
      name: 'Sec cancel',
      connections: [],
      nodes: [n('start', 'start'), n('hold', 'wait', { seconds: 30 })],
      wires: [w('start', 'hold')],
    });
    const { id } = await dana('POST', '/runs', { processId: pid, dryRun: true });
    await s.waitRun(id, ['running']);
    await dirk('POST', `/runs/${id}/cancel`, { reason: 'Cancelled by sec-dana:\nduplicate run' });
    await s.waitRun(id, DONE);
    const c = (
      (await s.api('GET', `/audit?runId=${id}&limit=50`)) as { action: string; actor: string; summary: string; details: Record<string, unknown> }[]
    ).find((e) => e.action === 'run.cancelled')!;
    expect(c.actor).toBe('sec-dana'); // the run's starter
    expect(c.summary).toBe('Run of "Sec cancel" cancelled by sec-dirk – reason: Cancelled by sec-dana: duplicate run');
    expect(c.details).toMatchObject({ cancelledBy: 'sec-dirk', reason: 'Cancelled by sec-dana: duplicate run' });
    // a run that is not active (queued, interrupted …): the entry's actor is the canceller anyway
    const pid2 = await define({
      name: 'Sec cancel 2',
      connections: [],
      nodes: [n('start', 'start'), n('ok', 'userTask', { mode: 'approve', title: 'Go?' })],
      wires: [w('start', 'ok')],
    });
    const run2 = await dana('POST', '/runs', { processId: pid2, dryRun: true });
    await s.waitRun(run2.id, ['waiting']);
    await dirk('POST', `/runs/${run2.id}/cancel`, {});
    await s.waitRun(run2.id, DONE);
    const c2 = ((await s.api('GET', `/audit?runId=${run2.id}&limit=50`)) as { action: string; summary: string }[]).find((e) => e.action === 'run.cancelled')!;
    expect(c2.summary).toBe('Run of "Sec cancel 2" cancelled by sec-dirk');
  });
});

describe('5: a decision skipped in a sub-process switches the whole run tree to recorded answers', () => {
  it('the parent of a step-through run no longer reads live after its child skipped a decision', async () => {
    const child = await define({
      name: 'Sec child approval',
      connections: [],
      nodes: [n('start', 'start'), n('ok', 'userTask', { mode: 'approve', title: 'Release the data?' }), n('val', 'set', { values: { released: true } })],
      wires: [w('start', 'ok'), w('ok', 'val', 'approved')],
    });
    const parent = await define({
      name: 'Sec parent',
      connections: [{ slot: 'src', kind: 'generic' }],
      nodes: [
        n('start', 'start'),
        n('sub', 'subprocess', { process: child, saveAs: 'c' }),
        n('after', 'http', {
          connection: 'src',
          method: 'GET',
          path: '/mock/test/delay?ms=1&value=read-after-unmade-decision',
          saveAs: 'a',
          onError: 'continue',
        }),
      ],
      wires: [w('start', 'sub'), w('sub', 'after')],
    });
    const st = await dana('POST', `/processes/${parent}/debug/runs`, { mode: 'dry', bindings: { src: source } });
    const runId = st.runId as string;
    const done = await s.waitRun(runId, DONE);
    const d = await dana('GET', `/runs/${runId}/debug`);
    expect(d.debug.recordedFrom).toBeTruthy();
    const after = done.steps.find((x: { stepId: string }) => x.stepId === 'after');
    const full = await dana('GET', `/runs/${runId}/steps/${after.id}`);
    expect(JSON.stringify(full)).not.toContain('"read-after-unmade-decision"');
    expect(full.error ?? JSON.stringify(full.output)).toMatch(/recorded/i);
  });
});

describe('6: driving a paused debug run checks the rights of now', () => {
  it('without run on the process the starter can no longer step on, but can still stop', async () => {
    const pid = await define({
      name: 'Sec drive rights',
      connections: [],
      nodes: [n('start', 'start'), n('a', 'set', { values: { a: 1 } }), n('b', 'set', { values: { b: 2 } })],
      wires: [w('start', 'a'), w('a', 'b')],
    });
    const st = await dana('POST', `/processes/${pid}/debug/runs`, { pauseBeforeEach: true });
    await until(async () => (await dana('GET', `/runs/${st.runId}/debug`)).paused?.nodeId === 'a');
    await dana('POST', `/runs/${st.runId}/debug`, { type: 'debug.step' });
    await until(async () => (await dana('GET', `/runs/${st.runId}/debug`)).paused?.nodeId === 'b');
    // the right to run is taken away while the run waits
    await s.api('PUT', `/processes/${pid}/access`, { acl: [{ subject: 'user:sec-dana', permissions: ['view', 'edit'] }] });
    expect(await status(dana('POST', `/runs/${st.runId}/debug`, { type: 'debug.step' }))).toBe(403);
    expect(await status(dana('POST', `/runs/${st.runId}/debug`, { type: 'debug.continue' }))).toBe(403);
    expect((await dana('GET', `/runs/${st.runId}/debug`)).paused?.nodeId).toBe('b');
    await dana('POST', `/runs/${st.runId}/debug`, { type: 'debug.stop' });
    expect((await s.waitRun(st.runId, DONE)).status).toBe('cancelled');
  });
});
