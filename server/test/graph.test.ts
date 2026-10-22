import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let hub: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
});
afterAll(async () => {
  await s?.app.close();
});

const n = (id: string, type: string, extra: Record<string, unknown> = {}, y = 0) => ({ id, type, x: 0, y, ...extra });
const w = (from: string, to: string, port = 'out') => ({ from, port, to });

async function runGraph(nodes: unknown[], wires: unknown[], opts: { inputs?: unknown[]; values?: Record<string, unknown> } = {}) {
  const p = await s.api('POST', '/processes', {
    definition: { name: `g-${Math.random()}`, connections: [{ slot: 'hub' }], inputs: opts.inputs ?? [], nodes, wires },
  });
  const { id } = await s.api('POST', '/runs', { processId: p.id, bindings: { hub }, inputs: opts.values ?? {} });
  return s.waitRun(id);
}

const executed = (r: any) => r.steps.filter((x: any) => x.status !== 'skipped').map((x: any) => x.key);

describe('graph engine', () => {
  it('routes failures to the error output', async () => {
    const r = await runGraph(
      [
        n('start', 'start'),
        n('bad', 'http', { connection: 'hub', method: 'GET', path: '/nope', saveAs: 'res' }),
        n('handled', 'log', { message: 'handled {{ $exists(vars.res.error) }}' }),
        n('next', 'log', { message: 'should not run' }),
      ],
      [w('start', 'bad'), w('bad', 'handled', 'error'), w('bad', 'next', 'out')],
    );
    expect(r.status).toBe('succeeded');
    expect(executed(r)).toEqual(['start', 'bad', 'handled']);
    expect(r.steps.find((x: any) => x.key === 'handled').summary).toBe('handled true');
  });

  it('fails the run when an error output is not connected', async () => {
    const r = await runGraph(
      [n('start', 'start'), n('bad', 'http', { connection: 'hub', method: 'GET', path: '/nope' })],
      [w('start', 'bad')],
    );
    expect(r.status).toBe('failed');
  });

  it('joins if branches into one node that runs once', async () => {
    const r = await runGraph(
      [
        n('start', 'start'),
        n('cond', 'if', { condition: 'inputs.flag' }),
        n('a', 'log', { message: 'A' }),
        n('b', 'log', { message: 'B' }),
        n('join', 'log', { message: 'J' }),
      ],
      [w('start', 'cond'), w('cond', 'a', 'true'), w('cond', 'b', 'false'), w('a', 'join'), w('b', 'join')],
      { inputs: [{ name: 'flag', type: 'boolean' }], values: { flag: false } },
    );
    expect(executed(r)).toEqual(['start', 'cond', 'b', 'join']);
  });

  it('runs loop bodies per item in their own scope and continues on done', async () => {
    const r = await runGraph(
      [
        n('start', 'start'),
        n('loop', 'forEach', { items: '[1,2,3]', as: 'i' }),
        n('body1', 'set', { values: { sum: '{{ ($exists(vars.sum) ? vars.sum : 0) + vars.i }}' } }),
        n('body2', 'log', { message: 'item {{ vars.i }}' }),
        n('after', 'log', { message: 'sum {{ vars.sum }}' }),
      ],
      [w('start', 'loop'), w('loop', 'body1', 'each'), w('body1', 'body2'), w('loop', 'after', 'done')],
    );
    expect(r.status).toBe('succeeded');
    expect(executed(r)).toEqual(['start', 'loop', 'loop[0]/body1', 'loop[0]/body2', 'loop[1]/body1', 'loop[1]/body2', 'loop[2]/body1', 'loop[2]/body2', 'after']);
    expect(r.steps.find((x: any) => x.key === 'after').summary).toBe('sum 6');
  });

  it('follows the rejected output of an approval', async () => {
    const id = (
      await s.api('POST', '/processes', {
        definition: {
          name: 'approval branches',
          nodes: [
            n('start', 'start'),
            n('ok', 'userTask', { mode: 'approve', title: 'Go?' }),
            n('yes', 'log', { message: 'yes' }),
            n('no', 'log', { message: 'no' }),
          ],
          wires: [w('start', 'ok'), w('ok', 'yes', 'approved'), w('ok', 'no', 'rejected')],
        },
      })
    ).id;
    const runId = (await s.api('POST', '/runs', { processId: id })).id;
    const waiting = await s.waitRun(runId);
    await s.api('POST', `/tasks/${waiting.tasks[0].id}/complete`, { approved: false, comment: 'not now' });
    const r = await s.waitRun(runId, ['succeeded', 'failed']);
    expect(r.status).toBe('succeeded');
    expect(executed(r)).toEqual(['start', 'ok', 'no']);
  });

  it('skipped nodes pass through', async () => {
    const r = await runGraph(
      [n('start', 'start'), n('maybe', 'log', { message: 'x', when: 'false' }), n('then', 'log', { message: 'after' })],
      [w('start', 'maybe'), w('maybe', 'then')],
    );
    expect(r.steps.map((x: any) => [x.key, x.status])).toEqual([
      ['start', 'succeeded'],
      ['maybe', 'skipped'],
      ['then', 'succeeded'],
    ]);
  });

  it('rejects cycles and missing start nodes', async () => {
    const v = await s.api('POST', '/processes/validate', {
      definition: { name: 'x', nodes: [n('a', 'log', { message: '' }), n('b', 'log', { message: '' })], wires: [w('a', 'b'), w('b', 'a')] },
    });
    expect(v.ok).toBe(false);
    const msgs = v.issues.map((i: any) => i.message).join(' ');
    expect(msgs).toContain('exactly one start node');
    expect(msgs).toContain('cycle');
  });

  it('converts the sequential YAML format', async () => {
    const v = await s.api('POST', '/processes/validate', {
      text: 'name: seq\nsteps:\n  - { id: a, type: log, message: hi }\n  - { id: b, type: fail, message: stop, when: "false" }\n  - { id: c, type: log, message: end }\n',
    });
    expect(v.ok).toBe(true);
    const wires = v.definition.wires.map((x: any) => `${x.from}.${x.port}>${x.to}`);
    expect(wires).toEqual(['start.out>a', 'a.out>b_when', 'b_when.true>b', 'b_when.false>c']);
  });
});
