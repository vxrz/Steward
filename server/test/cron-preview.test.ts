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

describe('time zones, codes and daylight saving (0.20 review)', () => {
  it('a wrong time zone is named as such, not as a wrong expression; both errors carry a code', async () => {
    await expect(s.api('POST', '/cron/preview', { cron: '0 7 * * *', timezone: 'Europe/Berln' })).rejects.toMatchObject({
      status: 400,
      body: { code: 'TIME_ZONE_UNKNOWN', params: { tz: 'Europe/Berln' } },
    });
    await expect(s.api('POST', '/cron/preview', { cron: '0 7 * *', timezone: 'UTC' })).rejects.toMatchObject({
      status: 400,
      body: { code: 'CRON_INVALID' },
    });
  });

  it('runs in its time zone: the first Tuesday, and local times across the change to summer time', async () => {
    const first = await s.api('POST', '/cron/preview', { cron: '0 6 * * 2#1', timezone: 'Europe/Berlin' });
    for (const n of first.next as string[]) {
      const local = new Date(n).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      expect(local).toMatch(/^Tue \d, 06:00$/);
    }
    // every 30 minutes in operating hours and hourly outside them: two expressions, each in Berlin time
    const busy = await s.api('POST', '/cron/preview', { cron: '*/30 6-21 * * 1-5', timezone: 'Europe/Berlin' });
    for (const n of busy.next as string[]) {
      const h = Number(new Date(n).toLocaleString('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }));
      expect(h).toBeGreaterThanOrEqual(6);
      expect(h).toBeLessThanOrEqual(21);
    }
    const { Cron } = await import('croner');
    // 02:30 does not exist on the last Sunday of March in Berlin: the run is not lost, it comes at 03:30
    const spring = new Cron('30 2 * * *', { paused: true, timezone: 'Europe/Berlin' })
      .nextRuns(3, new Date('2027-03-27T00:00:00Z'))
      .map((d) => d.toISOString());
    expect(spring).toEqual(['2027-03-27T01:30:00.000Z', '2027-03-28T01:30:00.000Z', '2027-03-29T00:30:00.000Z']);
  });
});
