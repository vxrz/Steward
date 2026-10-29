import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The start page's failed checks (#138): one entry per process and check with the latest failure, how often it failed
 * in 7 days, since when it has been failing and whether it passed again; informational checks stay out. The runs list
 * filters runs with failed checks.
 */

process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let processId: string;
const DONE = ['succeeded', 'failed', 'cancelled'];
const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const w = (from: string, to: string) => ({ from, port: 'out', to });
const groups = async () => (await s.api('GET', '/dashboard')).failedChecks.filter((g: any) => g.processId === processId);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  processId = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Failed checks test',
        inputs: [{ name: 'ok', type: 'boolean', default: false }],
        nodes: [
          n('start', 'start'),
          n('health', 'check', {
            name: 'Endpoints healthy',
            condition: 'inputs.ok = true',
            severity: 'error',
            message: '{{ inputs.ok ? "all up" : "3 endpoints down" }}',
          }),
          n('slow', 'check', { name: 'Responses fast', condition: 'false', severity: 'warning', message: 'slow' }),
          n('info', 'check', { name: 'Informational', condition: 'false', severity: 'info', message: 'just so you know', notify: false }),
        ],
        wires: [w('start', 'health'), w('health', 'slow'), w('slow', 'info')],
      },
    })
  ).id;
});
afterAll(async () => {
  await s?.app.close();
});

const run = async (ok: boolean) => {
  const { id } = await s.api('POST', '/runs', { processId, inputs: { ok } });
  return s.waitRun(id, DONE);
};

describe('failed checks on the start page', () => {
  it('groups failures per process and check, with streak, count and resolved', async () => {
    await run(false);
    await run(false);
    await run(true); // health passes again
    let g = await groups();
    // informational checks stay out
    expect(g.map((x: any) => x.checkId).sort()).toEqual(['health', 'slow']);
    const health = g.find((x: any) => x.checkId === 'health');
    expect(health).toMatchObject({ name: 'Endpoints healthy', severity: 'error', count: 2, streak: 2, resolved: true, message: '3 endpoints down' });
    // still failing (warning) before resolved ones
    expect(g[0]).toMatchObject({ checkId: 'slow', severity: 'warning', count: 3, streak: 3, resolved: false });

    // failing again: a new streak, the count over 7 days keeps growing
    const last = await run(false);
    await new Promise((r) => setTimeout(r, 5));
    const latest = await run(false);
    g = await groups();
    const again = g.find((x: any) => x.checkId === 'health');
    expect(again).toMatchObject({ count: 4, streak: 2, resolved: false, runId: latest.id });
    expect(Date.parse(again.since)).toBeGreaterThanOrEqual(Date.parse(last.startedAt));
    // errors before warnings
    expect(g.map((x: any) => x.checkId)).toEqual(['health', 'slow']);
  });

  it('the runs list filters runs with failed checks', async () => {
    const all = await s.api('GET', `/runs?processId=${processId}`);
    const failed = await s.api('GET', `/runs?processId=${processId}&checks=failed`);
    expect(all).toHaveLength(5);
    // every run has the failing "slow" check
    expect(failed).toHaveLength(5);
    const other = await s.api('POST', '/processes', {
      definition: { name: 'All checks pass', nodes: [n('start', 'start'), n('c', 'check', { condition: 'true', message: 'fine' })], wires: [w('start', 'c')] },
    });
    const { id } = await s.api('POST', '/runs', { processId: other.id });
    await s.waitRun(id, DONE);
    expect(await s.api('GET', `/runs?processId=${other.id}&checks=failed`)).toHaveLength(0);
    expect(await s.api('GET', `/runs?processId=${other.id}`)).toHaveLength(1);
  });
});
