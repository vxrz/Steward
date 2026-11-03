import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/** Empty dashboard widgets name the process that fills them: the processes whose current version publishes the key. */

process.env.SM_MONITOR_AUTOSTART = '0';

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
});

describe('dataset publishers', () => {
  it('lists the processes with a publish node for the key, and whether a schedule runs them', async () => {
    const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
    const p = await s.api('POST', '/processes', {
      definition: {
        name: 'Privileged access review',
        nodes: [n('start', 'start'), n('pub', 'publish', { dataset: 'test.privileged', rows: '[]' })],
        wires: [{ from: 'start', port: 'out', to: 'pub' }],
      },
    });
    expect(await s.api('GET', '/datasets/test.privileged/publishers')).toEqual([
      { processId: p.id, processName: 'Privileged access review', scheduled: false, canEdit: true, canRun: true },
    ]);
    await s.api('POST', '/schedules', { name: 'Monthly', processId: p.id, cron: '0 3 1 * *', enabled: true });
    expect((await s.api('GET', '/datasets/test.privileged/publishers'))[0].scheduled).toBe(true);
    expect(await s.api('GET', '/datasets/nobody.publishes/publishers')).toEqual([]);
  });
});
