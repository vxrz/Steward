import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The cron preview of the schedule editors warns about the day-of-month/day-of-week trap: croner (like vixie cron)
 * runs on a day when either field matches once both are restricted, so `0 6 1-7 * 1` is not "the first Monday".
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
// the server first: a module of the app loaded before it would read the configuration of the previous test file
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
const cronWarnings = async (cron: string) => (await import('../src/scheduler.js')).cronWarnings(cron);

describe('cron warnings', () => {
  it('warns when day of month and day of week are both restricted, and names the nth-weekday form', async () => {
    expect(await cronWarnings('0 6 1-7 * 1')).toEqual([
      expect.objectContaining({
        code: 'CRON_DAY_OR',
        params: { suggestion: '0 6 * * 1#1', context: 'suggestion' },
        message: expect.stringContaining('0 6 * * 1#1'),
      }),
    ]);
    expect((await cronWarnings('30 7 15-21 * fri'))[0]?.params.suggestion).toBe('30 7 * * FRI#3');
    // with seconds
    expect((await cronWarnings('0 0 6 8-14 * 2'))[0]?.params.suggestion).toBe('0 0 6 * * 2#2');
    // no exact week: the warning without a suggestion
    expect(await cronWarnings('0 6 1,15 * 1-5')).toEqual([expect.objectContaining({ code: 'CRON_DAY_OR', params: {} })]);
  });

  it('is quiet when only one of them is restricted, or for the nth weekday and the last day', async () => {
    for (const ok of ['0 6 * * 1', '0 6 1-7 * *', '0 6 * * 1#1', '0 6 ? * 1', '0 6 L * 5', '@daily', '*/15 * * * *'])
      expect(await cronWarnings(ok), ok).toEqual([]);
  });
});

describe('POST /api/cron/preview', () => {
  it('returns the next runs with the warnings; the nth weekday runs once a month', async () => {
    const trap = await s.api('POST', '/cron/preview', { cron: '0 6 1-7 * 1', timezone: 'UTC' });
    expect(trap.next).toHaveLength(5);
    expect(trap.warnings).toEqual([expect.objectContaining({ code: 'CRON_DAY_OR', params: { suggestion: '0 6 * * 1#1', context: 'suggestion' } })]);
    const first = await s.api('POST', '/cron/preview', { cron: '0 6 * * 1#1', timezone: 'UTC' });
    expect(first.warnings).toEqual([]);
    for (const n of first.next as string[]) {
      const d = new Date(n);
      expect(d.getUTCDay()).toBe(1);
      expect(d.getUTCDate()).toBeLessThanOrEqual(7);
    }
  });
});
