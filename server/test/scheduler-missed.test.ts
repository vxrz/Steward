import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Fires missed while Steward was not running (scheduler.ts): found at start against the last time the scheduler ran,
 * reported once per schedule (event, notification, audit entry, shown on the schedule), and with catchUp 'once' one
 * run starts right after the start. The clock is faked (Date only; timers stay real).
 */
let s: TestServer;
let sch: typeof import('../src/scheduler.js');
let db: typeof import('../src/db.js').db;
let writeSetting: typeof import('../src/settings.js').writeSetting;
let readSetting: typeof import('../src/settings.js').readSetting;

const NOW = new Date('2026-11-03T10:30:20Z');
const ids: Record<string, string> = {};
const schedule = async <T = Record<string, unknown>>(id: string): Promise<T> =>
  (await s.api<(T & { id: string })[]>('GET', '/schedules')).find((x) => x.id === id)! as T;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  sch = await import('../src/scheduler.js');
  ({ db } = await import('../src/db.js'));
  ({ writeSetting, readSetting } = await import('../src/settings.js'));
  const { quiesce } = await import('./helpers.js');
  await quiesce();
  await s.api('POST', '/processes', { definition: { name: 'Missed target', steps: [{ id: 'note', type: 'log', message: 'ran' }] } });
  for (const [key, cron, catchUp, enabled] of [
    ['hourly', '0 * * * *', 'none', true],
    ['quarter', '*/15 * * * *', 'once', true],
    ['off', '*/5 * * * *', 'once', false],
  ] as const) {
    const r = await s.api<{ id: string; catchUp: string }>('POST', '/schedules', {
      name: `Missed ${key}`,
      processId: 'missed-target',
      cron,
      timezone: 'UTC',
      enabled,
      catchUp,
    });
    expect(r.catchUp).toBe(catchUp);
    ids[key] = r.id;
  }
  sch.stopScheduler();
  // created a day before the fake "now"
  db().run('UPDATE schedules SET created_at = ? WHERE id IN (?, ?, ?)', '2026-11-02T10:00:00.000Z', ids.hourly, ids.quarter, ids.off);
});
afterEach(() => {
  sch.stopScheduler();
  vi.useRealTimers();
});
afterAll(async () => {
  await s?.app.close();
});

const audits = (action: string) =>
  db().all<{ entity_id: string; summary: string; actor: string }>('SELECT entity_id, summary, actor FROM audit_log WHERE action = ? ORDER BY seq', action);

describe('missed schedule fires', () => {
  it('lists the fires of a cron expression between two times', () => {
    const r = sch.firesBetween('0 * * * *', 'UTC', new Date('2026-11-03T07:10:00Z'), NOW);
    expect(r).toEqual({
      times: ['2026-11-03T08:00:00.000Z', '2026-11-03T09:00:00.000Z', '2026-11-03T10:00:00.000Z'],
      count: 3,
      last: '2026-11-03T10:00:00.000Z',
    });
    // in the schedule's time zone
    expect(sch.firesBetween('0 9 * * *', 'Europe/Berlin', new Date('2026-11-02T00:00:00Z'), new Date('2026-11-04T00:00:00Z')).times).toEqual([
      '2026-11-02T08:00:00.000Z',
      '2026-11-03T08:00:00.000Z',
    ]);
    // all are counted, ten are listed
    const many = sch.firesBetween('* * * * *', 'UTC', new Date('2026-11-03T00:00:00Z'), new Date('2026-11-03T01:00:00Z'));
    expect(many.count).toBe(60);
    expect(many.times).toHaveLength(10);
  });

  it('records nothing on the first start (no time of the last run known)', () => {
    writeSetting(sch.ALIVE_KEY, null);
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    expect(sch.detectMissedFires()).toEqual([]);
    sch.startScheduler();
    expect(audits('schedule.missed')).toEqual([]);
    // now it is known
    expect(readSetting(sch.ALIVE_KEY, null)).toBe(NOW.toISOString());
  });

  it('reports the fires missed while Steward was down, once per enabled schedule, and starts one catch-up run where asked', async () => {
    writeSetting(sch.ALIVE_KEY, '2026-11-03T07:10:00.000Z');
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    sch.startScheduler();
    vi.useRealTimers();
    const missed = audits('schedule.missed');
    expect(missed.map((a) => a.entity_id).sort()).toEqual([ids.hourly, ids.quarter].sort());
    expect(missed.every((a) => a.actor === 'scheduler')).toBe(true);
    expect(missed.find((a) => a.entity_id === ids.hourly)!.summary).toBe(
      'Schedule "Missed hourly": missed while Steward was not running: 2026-11-03T08:00:00.000Z, 2026-11-03T09:00:00.000Z, 2026-11-03T10:00:00.000Z',
    );
    expect(missed.find((a) => a.entity_id === ids.quarter)!.summary).toMatch(/… \(14 in all\) – one catch-up run starts$/);
    // shown on the schedule
    const hourly = await schedule<{ missed: { count: number; times: string[]; catchUp: boolean; detectedAt: string; from: string } }>(ids.hourly);
    expect(hourly.missed).toMatchObject({ count: 3, catchUp: false, detectedAt: NOW.toISOString(), from: '2026-11-03T07:10:00.000Z' });
    expect(hourly.missed.times).toHaveLength(3);
    expect(await schedule(ids.quarter)).toMatchObject({ catchUp: 'once', missed: { count: 14, catchUp: true } });
    // the notification (owner and administrators), in the recipient's language
    await new Promise((r) => setTimeout(r, 100));
    const titles = db()
      .all<{ title: string; body: string }>("SELECT title, body FROM notifications WHERE event = 'schedule.skipped' ORDER BY ts")
      .filter((n) => n.title.startsWith('Missed while Steward was not running'));
    expect(titles.map((n) => n.title)).toEqual(
      expect.arrayContaining(['Missed while Steward was not running: Missed hourly', 'Missed while Steward was not running: Missed quarter']),
    );
    expect(titles.find((n) => n.title.endsWith('Missed hourly'))!.body).toMatch(/No run was started for it/);
    expect(titles.find((n) => n.title.endsWith('Missed quarter'))!.body).toMatch(/14 times in all\)\. One catch-up run was started\./);
    // one catch-up run for the schedule that asks for it, none for the others
    await new Promise((r) => setTimeout(r, 200));
    const runs = db().all<{ schedule_id: string; id: string }>(
      'SELECT schedule_id, id FROM runs WHERE schedule_id IN (?, ?, ?)',
      ids.hourly,
      ids.quarter,
      ids.off,
    );
    expect(runs.map((r) => r.schedule_id)).toEqual([ids.quarter]);
    expect(audits('schedule.caught_up').map((a) => a.entity_id)).toEqual([ids.quarter]);
    await s.waitRun(runs[0]!.id, ['succeeded']);
  });

  it('does not report the same time again after a clean restart, and starts from the last fire when it is later', () => {
    const before = audits('schedule.missed').length;
    // stopScheduler (afterEach) recorded the moment it stopped; a restart five minutes later misses nothing hourly
    writeSetting(sch.ALIVE_KEY, '2026-11-03T10:30:20.000Z');
    vi.useFakeTimers({ now: new Date('2026-11-03T10:35:00Z'), toFake: ['Date'] });
    expect(sch.detectMissedFires()).toEqual([]);
    expect(audits('schedule.missed').length).toBe(before);
    // the quarter-hourly schedule fired at 10:45 (last_fired_at), then Steward was gone until 11:20
    writeSetting(sch.ALIVE_KEY, '2026-11-03T10:40:00.000Z');
    db().run('UPDATE schedules SET last_fired_at = ? WHERE id = ?', '2026-11-03T10:45:00.000Z', ids.quarter);
    vi.setSystemTime(new Date('2026-11-03T11:20:00Z'));
    const found = sch.detectMissedFires();
    expect(found.find((m) => m.scheduleId === ids.quarter)).toEqual({ scheduleId: ids.quarter, count: 2, catchUp: true });
    expect(found.find((m) => m.scheduleId === ids.hourly)).toEqual({ scheduleId: ids.hourly, count: 1, catchUp: false });
  });

  it('records each cron fire, also one that is skipped', async () => {
    db().run('UPDATE schedules SET last_fired_at = NULL, cron = ? WHERE id = ?', '* * * * * *', ids.off);
    // a run of the same schedule is still going: the fire is skipped, but it counts as a fire
    const blocker = await s.api<{ id: string }>('POST', '/runs', { processId: 'missed-target' });
    await s.waitRun(blocker.id, ['succeeded']);
    db().run("UPDATE runs SET status = 'running' WHERE id = ?", blocker.id);
    db().run('UPDATE schedules SET enabled = 1, last_run_id = ? WHERE id = ?', blocker.id, ids.off);
    const lastFired = () => db().get<{ last_fired_at: string | null }>('SELECT last_fired_at FROM schedules WHERE id = ?', ids.off)!.last_fired_at;
    sch.startScheduler();
    // wait for the first fire instead of a fixed time: on a busy CI runner the timer of the next second can come late
    try {
      await vi.waitFor(
        () => {
          expect(lastFired()).not.toBeNull();
          expect(audits('schedule.skipped').some((a) => a.entity_id === ids.off)).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      sch.stopScheduler();
      db().run("UPDATE runs SET status = 'succeeded' WHERE id = ?", blocker.id);
      db().run('UPDATE schedules SET enabled = 0 WHERE id = ?', ids.off);
    }
    expect(Date.now() - Date.parse(lastFired()!)).toBeLessThan(3000);
  });

  it('keeps catchUp when an older client saves without it, and changes it when sent (audited)', async () => {
    const cur = await schedule(ids.quarter);
    const { catchUp: _drop, missed: _m, ...rest } = cur;
    void _drop;
    void _m;
    const keep = await s.api<{ catchUp: string }>('PUT', `/schedules/${ids.quarter}`, { ...rest, processId: 'missed-target' });
    expect(keep.catchUp).toBe('once');
    const changed = await s.api<{ catchUp: string }>('PUT', `/schedules/${ids.quarter}`, { ...rest, processId: 'missed-target', catchUp: 'none' });
    expect(changed.catchUp).toBe('none');
    await expect(s.api('PUT', `/schedules/${ids.quarter}`, { ...rest, processId: 'missed-target', catchUp: 'always' })).rejects.toMatchObject({ status: 400 });
    sch.stopScheduler();
  });
});
