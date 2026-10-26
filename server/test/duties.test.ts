import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Service duties (#85): calendar periods in time zones (DST), grace periods, every period status from the runs (dry
 * runs, cancelled runs, runs of other processes, rejected approvals, runs still waiting), exceptions with four-eyes,
 * closed periods stored for good (history does not change with the duty, the process or the run retention),
 * permissions, reminders and "missed" messages (once), the start page tile, the daily summary, the report section,
 * the public API and the audit trail.
 *
 * The instance time zone is Europe/Berlin here. Tests that judge periods at a chosen time use periods in 2025 and
 * early 2026, so they never close a period of a duty that other tests look at in real time.
 */

process.env.TZ = 'Europe/Berlin';
process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client, olivia: Client, adam: Client, vera: Client;
let processId = '';
/** A process that never runs (duties on it stay due) */
let freshProc = '';
type Db = (typeof import('../src/db.js'))['db'];
let db: Db;
let ev: typeof import('../src/duties/evaluate.js');
let jobs: typeof import('../src/duties/jobs.js');
let periods: typeof import('../src/duties/periods.js');
let store: typeof import('../src/duties/store.js');

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: { body: { code?: string } }) => e.body?.code ?? '',
  );
const Z = (x: string) => Date.parse(x);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, vera] = await Promise.all(['dana', 'olivia', 'adam', 'vera'].map((u) => s.as(u, PW)));
  processId = (await s.api('GET', '/processes')).find((p: { id: string }) => p.id === 'ih-health-check')?.id ?? (await s.api('GET', '/processes'))[0].id;
  freshProc = (await s.api('POST', '/processes', { definition: { name: 'Fresh duty process', nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } })).id;
  db = (await import('../src/db.js')).db;
  ev = await import('../src/duties/evaluate.js');
  jobs = await import('../src/duties/jobs.js');
  periods = await import('../src/duties/periods.js');
  store = await import('../src/duties/store.js');
});
afterAll(async () => {
  await s?.app.close();
});

// ---------- fixtures ----------

let runNo = 0;
/** A run of `proc`, written directly (started and finished when the test says). */
function run(proc: string, o: { status: string; start: string; end?: string | null; dry?: boolean; rejected?: boolean }): string {
  const id = `run_dty_${++runNo}`;
  db().run(
    `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, dry_run, trigger, actor, inputs, bindings, started_at, finished_at, stats)
     VALUES (?, ?, ?, 1, 'x', ?, ?, 'manual', 'dana', '{}', '{}', ?, ?, '{}')`,
    id,
    proc,
    proc,
    o.status,
    o.dry ? 1 : 0,
    o.start,
    o.end === undefined ? o.start : o.end,
  );
  if (o.rejected)
    db().run(
      `INSERT INTO run_tasks (id, run_id, step_key, mode, title, columns, items, status, decision, decided_by, decided_at, created_at)
       VALUES (?, ?, 'approve', 'approve', 'Go?', '[]', '[]', 'completed', '{"approved":false}', 'adam', ?, ?)`,
      `tsk_${id}`,
      id,
      o.start,
      o.start,
    );
  return id;
}

let serviceNo = 0;
async function service(owners: string[] = []): Promise<{ id: string; name: string }> {
  return s.api('POST', '/services', { name: `Duty service ${++serviceNo}`, owners });
}

let procNo = 0;
/**
 * A duty judged from `activeFrom` on, on a process of its own (runs are written directly): created through the API,
 * then pointed at the private process id.
 */
async function duty(
  o: { interval?: string; grace?: number; level?: string; owners?: string[]; activeFrom?: string; remind?: number; serviceOwners?: string[] } = {},
) {
  const svc = await service(o.serviceOwners ?? []);
  const d = await s.api('POST', '/duties', {
    serviceId: svc.id,
    name: `Restore test ${procNo + 1}`,
    processId,
    interval: o.interval ?? 'monthly',
    level: o.level ?? 'mandatory',
    graceDays: o.grace ?? 0,
    remindDays: o.remind ?? 5,
    owners: o.owners ?? [],
  });
  const proc = `proc_dty_${++procNo}`;
  db().run('UPDATE service_duties SET process_id = ?, active_from = ? WHERE id = ?', proc, o.activeFrom ?? '2025-01-01T00:00:00.000Z', d.id);
  return { id: d.id as string, proc, service: svc, row: () => db().get<any>('SELECT * FROM service_duties WHERE id = ?', d.id) };
}

const TZ = 'Europe/Berlin';
/** The status of one period of a duty, judged at `now`. */
function statusAt(row: any, key: string, now: string) {
  const e = ev.evaluateDuty(row, Z(now), TZ).find((x) => x.period.key === key);
  return e;
}

// ---------- periods ----------

describe('calendar periods in a time zone', () => {
  const iso = (t: number) => new Date(t).toISOString();
  it('weeks run Monday to Monday, months/quarters/half years/years from local midnight – also across DST', () => {
    const w = periods.periodAt('weekly', Z('2026-10-21T12:00:00Z'), TZ);
    // the week with the change from CEST to CET: 7 days and one hour
    expect([w.key, iso(w.start), iso(w.end)]).toEqual(['2026-W43', '2026-10-18T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);
    expect(w.end - w.start).toBe(7 * 86400000 + 3600000);
    const m = periods.periodAt('monthly', Z('2026-03-15T12:00:00Z'), TZ);
    expect([m.key, iso(m.start), iso(m.end)]).toEqual(['2026-03', '2026-02-28T23:00:00.000Z', '2026-03-31T22:00:00.000Z']);
    const q = periods.periodAt('quarterly', Z('2026-11-15T12:00:00Z'), 'America/New_York');
    expect([q.key, iso(q.start), iso(q.end)]).toEqual(['2026-Q4', '2026-10-01T04:00:00.000Z', '2027-01-01T05:00:00.000Z']);
    // southern hemisphere: New Zealand leaves summer time in April
    const nz = periods.periodAt('monthly', Z('2026-04-10T00:00:00Z'), 'Pacific/Auckland');
    expect([iso(nz.start), iso(nz.end)]).toEqual(['2026-03-31T11:00:00.000Z', '2026-04-30T12:00:00.000Z']);
    const h = periods.periodAt('halfYearly', Z('2026-07-01T00:30:00Z'), TZ);
    expect([h.key, iso(h.start)]).toEqual(['2026-H2', '2026-06-30T22:00:00.000Z']);
    expect(periods.periodAt('yearly', Z('2026-12-31T23:30:00Z'), TZ).key).toBe('2027');
    // the last minutes of the year in Berlin are already 2027 – and New Year's Eve in UTC is still 2026
    expect(periods.periodAt('monthly', Z('2026-12-31T23:30:00Z'), 'UTC').key).toBe('2026-12');
  });

  it('knows ISO weeks (53-week years) and finds a period by its key', () => {
    expect(periods.periodAt('weekly', Z('2027-01-02T12:00:00Z'), TZ).key).toBe('2026-W53');
    expect(periods.periodAt('weekly', Z('2027-01-04T12:00:00Z'), TZ).key).toBe('2027-W01');
    expect(periods.periodOfKey('weekly', '2027-W53', TZ)).toBeNull();
    expect(periods.periodOfKey('monthly', '2026-13', TZ)).toBeNull();
    expect(periods.periodOfKey('quarterly', '2026-10', TZ)).toBeNull();
    for (const interval of ['weekly', 'monthly', 'quarterly', 'halfYearly', 'yearly'] as const)
      for (let t = Z('2025-12-20T00:00:00Z'); t < Z('2027-01-10T00:00:00Z'); t += 5 * 86400000 + 3700000) {
        const p = periods.periodAt(interval, t, TZ);
        expect(p.start <= t && t < p.end, `${interval} ${iso(t)}`).toBe(true);
        expect(periods.periodOfKey(interval, p.key, TZ), `${interval} ${p.key}`).toEqual(p);
        expect(periods.nextPeriod(interval, p, TZ).start).toBe(p.end);
      }
  });

  it('counts grace days in calendar days of the time zone', () => {
    const mar = periods.periodAt('monthly', Z('2026-03-10T00:00:00Z'), TZ);
    // 1 April 00:00 CEST + 5 days = 6 April 00:00 CEST
    expect(iso(periods.graceEnd(mar, 5, TZ))).toBe('2026-04-05T22:00:00.000Z');
    expect(periods.graceEnd(mar, 0, TZ)).toBe(mar.end);
  });
});

// ---------- statuses ----------

describe('period status from the runs', () => {
  // March 2026 in Berlin: 28 Feb 23:00Z – 31 Mar 22:00Z; with 5 grace days the grace period ends 5 Apr 22:00Z
  const AFTER = '2026-04-06T08:00:00Z';

  it('done: a successful run started in the period and ended by the end of the grace period', async () => {
    const d = await duty({ grace: 5 });
    expect(statusAt(d.row(), '2026-03', '2026-03-05T10:00:00Z')).toMatchObject({ status: 'due', final: false });
    const r = run(d.proc, { status: 'succeeded', start: '2026-03-10T08:00:00Z', end: '2026-03-10T08:05:00Z' });
    expect(statusAt(d.row(), '2026-03', '2026-03-11T10:00:00Z')).toMatchObject({ status: 'done', run: { id: r } });
    expect(statusAt(d.row(), '2026-03', AFTER)).toMatchObject({ status: 'done', final: true });
    // started on the last evening, ended in the grace period: still done (not late)
    const d2 = await duty({ grace: 5 });
    run(d2.proc, { status: 'succeeded', start: '2026-03-31T21:30:00Z', end: '2026-04-02T09:00:00Z' });
    expect(statusAt(d2.row(), '2026-03', AFTER)?.status).toBe('done');
  });

  it('late: started in the grace period – and that run does not count for the next period too', async () => {
    const d = await duty({ grace: 5 });
    // 00:00 local on 1 April is already April
    const r = run(d.proc, { status: 'succeeded', start: '2026-03-31T22:00:00Z', end: '2026-03-31T22:10:00Z' });
    expect(statusAt(d.row(), '2026-03', '2026-04-01T10:00:00Z')).toMatchObject({ status: 'late', run: { id: r } });
    expect(statusAt(d.row(), '2026-04', '2026-04-01T10:00:00Z')).toMatchObject({ status: 'due', run: null });
    // a second run in April counts for April
    run(d.proc, { status: 'succeeded', start: '2026-04-02T08:00:00Z', end: '2026-04-02T08:10:00Z' });
    expect(statusAt(d.row(), '2026-04', '2026-04-03T10:00:00Z')?.status).toBe('done');
    // without a grace period, the April run is April's
    const d2 = await duty({ grace: 0 });
    run(d2.proc, { status: 'succeeded', start: '2026-04-01T08:00:00Z', end: '2026-04-01T08:10:00Z' });
    expect(statusAt(d2.row(), '2026-03', AFTER)?.status).toBe('missed');
    expect(statusAt(d2.row(), '2026-04', AFTER)?.status).toBe('done');
  });

  it('failed: only failed, interrupted or rejected runs; missed: no run that counts', async () => {
    const d = await duty({ grace: 5 });
    run(d.proc, { status: 'failed', start: '2026-03-03T08:00:00Z', end: '2026-03-03T08:01:00Z' });
    expect(statusAt(d.row(), '2026-03', '2026-03-04T08:00:00Z')).toMatchObject({ status: 'due', failedRuns: 1 });
    expect(statusAt(d.row(), '2026-03', AFTER)).toMatchObject({ status: 'failed', failedRuns: 1 });
    // a run that succeeded through the "rejected" branch of an approval is not the duty done
    const d2 = await duty();
    run(d2.proc, { status: 'succeeded', start: '2026-03-03T08:00:00Z', end: '2026-03-03T09:00:00Z', rejected: true });
    expect(statusAt(d2.row(), '2026-03', AFTER)?.status).toBe('failed');
    // dry runs, cancelled runs and runs of another process never count
    const d3 = await duty();
    run(d3.proc, { status: 'succeeded', start: '2026-03-03T08:00:00Z', end: '2026-03-03T08:01:00Z', dry: true });
    run(d3.proc, { status: 'cancelled', start: '2026-03-04T08:00:00Z', end: '2026-03-04T08:01:00Z' });
    run(`${d3.proc}_copy`, { status: 'succeeded', start: '2026-03-05T08:00:00Z', end: '2026-03-05T08:01:00Z' });
    expect(statusAt(d3.row(), '2026-03', AFTER)).toMatchObject({ status: 'missed', failedRuns: 0 });
    // a run that ends after the grace period does not count
    const d4 = await duty({ grace: 2 });
    run(d4.proc, { status: 'succeeded', start: '2026-03-31T10:00:00Z', end: '2026-04-05T10:00:00Z' });
    expect(statusAt(d4.row(), '2026-03', AFTER)?.status).toBe('missed');
  });

  it('a run waiting for a person (approval, manual step) counts once it ends, by its final status', async () => {
    const d = await duty({ grace: 5 });
    const id = run(d.proc, { status: 'waiting', start: '2026-03-30T08:00:00Z', end: null });
    expect(statusAt(d.row(), '2026-03', '2026-03-31T08:00:00Z')).toMatchObject({ status: 'due', runsInProgress: 1 });
    db().run("UPDATE runs SET status = 'succeeded', finished_at = '2026-04-03T08:00:00Z' WHERE id = ?", id);
    expect(statusAt(d.row(), '2026-03', AFTER)?.status).toBe('done');
    // still waiting when the grace period ends: not done
    const d2 = await duty({ grace: 1 });
    run(d2.proc, { status: 'waiting', start: '2026-03-30T08:00:00Z', end: null });
    expect(statusAt(d2.row(), '2026-03', AFTER)?.status).toBe('missed');
  });

  it('the first period counts only runs started after the duty was defined', async () => {
    const d = await duty({ activeFrom: '2026-03-15T00:00:00Z' });
    run(d.proc, { status: 'succeeded', start: '2026-03-10T08:00:00Z', end: '2026-03-10T08:05:00Z' });
    expect(statusAt(d.row(), '2026-03', AFTER)?.status).toBe('missed');
    run(d.proc, { status: 'succeeded', start: '2026-03-20T08:00:00Z', end: '2026-03-20T08:05:00Z' });
    expect(statusAt(d.row(), '2026-03', AFTER)?.status).toBe('done');
  });

  it('weekly duties follow the week of the time zone across the change to winter time', async () => {
    const d = await duty({ interval: 'weekly', grace: 1, activeFrom: '2025-10-01T00:00:00Z' });
    // Sunday 26 Oct 2025, 23:30 local (CET, UTC+1) is still week 43
    run(d.proc, { status: 'succeeded', start: '2025-10-26T22:30:00Z', end: '2025-10-26T22:40:00Z' });
    expect(statusAt(d.row(), '2025-W43', '2025-10-28T08:00:00Z')?.status).toBe('done');
    expect(statusAt(d.row(), '2025-W44', '2025-10-28T08:00:00Z')?.status).toBe('due');
  });
});

// ---------- history ----------

describe('stored periods', () => {
  it('the job closes ended periods once, with their status and what they were judged against (audited)', async () => {
    const d = await duty({ grace: 5, activeFrom: '2026-02-10T00:00:00Z' });
    const r = run(d.proc, { status: 'succeeded', start: '2026-02-12T08:00:00Z', end: '2026-02-12T08:10:00Z' });
    run(d.proc, { status: 'failed', start: '2026-03-12T08:00:00Z', end: '2026-03-12T08:10:00Z' });
    const out = jobs.runDutyJob(Z('2026-04-06T08:00:00Z'));
    expect(out.closed).toBeGreaterThanOrEqual(2);
    const rows = db().all<any>('SELECT * FROM duty_periods WHERE duty_id = ? ORDER BY period_start', d.id);
    expect(rows.map((x) => [x.period_key, x.status, !!x.closed_at])).toEqual([
      ['2026-02', 'done', true],
      ['2026-03', 'failed', true],
    ]);
    // the process version and definition hash of the run that counted (what exactly was done)
    expect(rows[0]).toMatchObject({ run_version: 1, run_definition_hash: 'x' });
    expect(rows[0]).toMatchObject({ run_id: r, level: 'mandatory', interval_kind: 'monthly', grace_days: 5, time_zone: TZ, duty_name: d.row().name });
    // idempotent: a second run closes nothing again
    expect(jobs.runDutyJob(Z('2026-04-06T08:00:00Z')).closed).toBe(0);
    const audit = await s.api('GET', `/audit?entityType=duty&entityId=${d.id}&limit=50`);
    expect(
      audit
        .filter((a: any) => a.action === 'duty.period_closed')
        .map((a: any) => a.details.periodKey)
        .sort(),
    ).toEqual(['2026-02', '2026-03']);
    expect(audit.find((a: any) => a.action === 'duty.period_closed').actor).toBe('system');

    // later changes of the duty, the process and the runs do not change closed periods
    const before = (await s.api('GET', `/duties/${d.id}`)).periods.filter((p: any) => p.closed);
    await s.api('PUT', `/duties/${d.id}`, {
      name: 'Renamed duty',
      processId,
      interval: 'quarterly',
      level: 'optional',
      graceDays: 0,
      owners: [],
    });
    const processName = db().get<{ name: string }>('SELECT name FROM processes WHERE id = ?', processId)!.name;
    db().run('UPDATE processes SET name = ? WHERE id = ?', 'Renamed process', processId);
    db().run('DELETE FROM runs WHERE id = ?', r);
    // (the change closed the periods since April as they stood – under the old rules)
    const after = (await s.api('GET', `/duties/${d.id}`)).periods.filter((p: any) => before.some((b: any) => b.key === p.key));
    expect(after).toEqual(before);
    expect(after.find((p: any) => p.key === '2026-02')).toMatchObject({ status: 'done', snapshot: { level: 'mandatory', interval: 'monthly', graceDays: 5 } });
    expect(after.find((p: any) => p.key === '2026-02').snapshot.name).not.toBe('Renamed duty');
    expect(after.find((p: any) => p.key === '2026-02').snapshot.processName).not.toBe('Renamed process');
    // the database refuses nothing, but the job never writes a closed period again
    jobs.runDutyJob(Z('2026-04-07T08:00:00Z'));
    expect(db().get<any>("SELECT status, level FROM duty_periods WHERE duty_id = ? AND period_key = '2026-02'", d.id)).toEqual({
      status: 'done',
      level: 'mandatory',
    });
    db().run('UPDATE processes SET name = ? WHERE id = ?', processName, processId);
  });

  it('an open period that is done stays done when the run retention deletes its run', async () => {
    const d = await duty({ activeFrom: '2026-03-01T00:00:00Z' });
    const r = run(d.proc, { status: 'succeeded', start: '2026-03-02T08:00:00Z', end: '2026-03-02T08:10:00Z' });
    jobs.runDutyJob(Z('2026-03-03T08:00:00Z'));
    db().run('DELETE FROM runs WHERE id = ?', r);
    expect(statusAt(d.row(), '2026-03', '2026-03-04T08:00:00Z')).toMatchObject({ status: 'done', run: { id: r } });
    jobs.runDutyJob(Z('2026-04-01T08:00:00Z'));
    expect(db().get<any>("SELECT status, closed_at FROM duty_periods WHERE duty_id = ? AND period_key = '2026-03'", d.id).status).toBe('done');
  });
});

describe('archiving a duty or changing its rules', () => {
  // the previous month is in its grace period now (40 days), the current month is open
  const now = Date.now();
  const cur = () => periods.periodAt('monthly', now, TZ);
  const prev = () => periods.periodAt('monthly', cur().start - 1, TZ);
  const iso = (t: number) => new Date(t).toISOString();
  async function graceDuty() {
    const d = await duty({ grace: 40, activeFrom: iso(prev().start) });
    db().run('UPDATE service_duties SET process_id = ? WHERE id = ?', freshProc, d.id);
    const body = (patch: Record<string, unknown> = {}) => ({
      name: d.row().name,
      processId: freshProc,
      interval: 'monthly',
      level: 'mandatory',
      graceDays: 40,
      ...patch,
    });
    return { ...d, body };
  }
  const period = (x: any, key: string) => x.periods.find((p: any) => p.key === key);

  it('closes the ended periods as they stand before archiving, and stores the archived periods as inactive on restore', async () => {
    const d = await graceDuty();
    const before = await dana('GET', `/duties/${d.id}`);
    expect(before.previous).toMatchObject({ key: prev().key, status: 'due', inGrace: true });
    await dana('POST', `/duties/${d.id}/archive`, { archived: true });
    const archived = await dana('GET', `/duties/${d.id}`);
    expect(period(archived, prev().key)).toMatchObject({ status: 'missed', closed: true, closeNote: 'duty archived' });
    // restore in the same period: the previous period stays missed, the current one is judged again
    const restored = await dana('POST', `/duties/${d.id}/archive`, { archived: false });
    expect(period(restored, prev().key)).toMatchObject({ status: 'missed', closed: true });
    expect(restored.current).toMatchObject({ key: cur().key, status: 'due' });
    const audit = await s.api('GET', `/audit?entityType=duty&entityId=${d.id}&limit=50`);
    expect(audit.find((a: any) => a.action === 'duty.period_closed' && a.details.periodKey === prev().key).details.closedEarly).toBe('duty archived');
    // archived over months: the periods in between are stored as inactive
    await dana('POST', `/duties/${d.id}/archive`, { archived: true });
    db().run('UPDATE service_duties SET archived = 0 WHERE id = ?', d.id);
    expect(store.storeInactiveGap(d.row(), now + 70 * 86400000)).toBeGreaterThanOrEqual(2);
    expect(db().get<any>('SELECT status, close_note FROM duty_periods WHERE duty_id = ? AND period_key = ?', d.id, cur().key)).toEqual({
      status: 'inactive',
      close_note: 'duty archived',
    });
  });

  it('a period done before archiving stays done', async () => {
    const d = await graceDuty();
    // the previous month is done; a later run is the current month's
    run(freshProc, { status: 'succeeded', start: iso(prev().start + 3600000), end: iso(prev().start + 3700000) });
    run(freshProc, { status: 'succeeded', start: iso(cur().start + 3600000), end: iso(cur().start + 3700000) });
    await dana('POST', `/duties/${d.id}/archive`, { archived: true });
    expect(period(await dana('GET', `/duties/${d.id}`), cur().key)).toMatchObject({ status: 'done', closed: true, closeNote: 'duty archived' });
    db().run('DELETE FROM runs WHERE process_id = ?', freshProc);
  });

  it('a new interval, grace period or process applies from the current period on; ended periods keep the old rules', async () => {
    // monthly → yearly: the previous month is closed as it stands, and the year counts no run from before the change
    const d = await graceDuty();
    await dana('PUT', `/duties/${d.id}`, d.body({ interval: 'yearly' }));
    const y = await dana('GET', `/duties/${d.id}`);
    expect(period(y, prev().key)).toMatchObject({ status: 'missed', closed: true, closeNote: 'duty changed', snapshot: { interval: 'monthly' } });
    run(freshProc, { status: 'succeeded', start: iso(prev().start + 3600000), end: iso(prev().start + 3700000) });
    expect((await dana('GET', `/duties/${d.id}`)).current.status).toBe('due');
    db().run('DELETE FROM runs WHERE process_id = ?', freshProc);
    // a longer grace period does not turn a missed period into a late one
    const g = await graceDuty();
    await dana('PUT', `/duties/${g.id}`, g.body({ graceDays: 60 }));
    expect(period(await dana('GET', `/duties/${g.id}`), prev().key)).toMatchObject({ status: 'missed', closed: true, snapshot: { graceDays: 40 } });
    // another process: the period in grace was judged by the old one
    const p = await graceDuty();
    run(freshProc, { status: 'succeeded', start: iso(prev().start + 3600000), end: iso(prev().start + 3700000) });
    await dana('PUT', `/duties/${p.id}`, p.body({ processId }));
    expect(period(await dana('GET', `/duties/${p.id}`), prev().key)).toMatchObject({ status: 'done', closed: true });
    db().run('DELETE FROM runs WHERE process_id = ?', freshProc);
    // a lower level does not change the level a period that ended is judged by
    const l = await graceDuty();
    await dana('PUT', `/duties/${l.id}`, l.body({ level: 'optional' }));
    expect(period(await dana('GET', `/duties/${l.id}`), prev().key)).toMatchObject({ status: 'missed', snapshot: { level: 'mandatory' } });
    const audit = await s.api('GET', `/audit?entityType=duty&entityId=${l.id}&limit=50`);
    expect(audit.find((a: any) => a.action === 'duty.updated').details.periodsClosedEarly).toEqual(
      expect.arrayContaining([{ key: prev().key, status: 'missed' }]),
    );
  });
});

// ---------- API and permissions ----------

describe('duties of a service', () => {
  it('follow the permissions of the service: editors and owners define them, everyone reads them', async () => {
    const svc = await service(['user:olivia']);
    const body = { serviceId: svc.id, name: 'Access review', processId: freshProc, interval: 'quarterly', level: 'mandatory', graceDays: 10 };
    for (const c of [adam, vera]) expect(await status(c('POST', '/duties', body))).toBe(403);
    const d = await olivia('POST', '/duties', body); // owner of the service (operator)
    expect(d).toMatchObject({ name: 'Access review', interval: 'quarterly', level: 'mandatory', graceDays: 10, remindDays: 5, canEdit: true });
    expect(d.current).toMatchObject({ status: 'due', closed: false });
    expect(await code(dana('POST', '/duties', body))).toBe('DUTY_EXISTS');
    // everyone reads them, with the service; only editors may change them
    const seen = await vera('GET', `/duties?serviceId=${svc.id}`);
    expect(seen.map((x: any) => [x.name, x.canEdit])).toEqual([['Access review', false]]);
    expect(await code(dana('PUT', `/duties/${d.id}`, body))).toBe('INVALID_INPUT'); // the service of a duty never changes
    const { serviceId: _, ...update } = body;
    expect(await status(vera('PUT', `/duties/${d.id}`, update))).toBe(403);
    expect(await status(adam('POST', `/duties/${d.id}/archive`, { archived: true }))).toBe(403);
    expect((await dana('PUT', `/duties/${d.id}`, { ...update, level: 'recommended' })).level).toBe('recommended');
    // archived: no current period, history stays, restored with the current period
    const archived = await olivia('POST', `/duties/${d.id}/archive`, { archived: true });
    expect([archived.archived, archived.current]).toEqual([true, null]);
    expect((await vera('GET', `/duties?serviceId=${svc.id}`)).length).toBe(0);
    expect((await vera('GET', `/duties?serviceId=${svc.id}&archived=1`)).length).toBe(1);
    expect((await olivia('POST', `/duties/${d.id}/archive`, { archived: false })).current.status).toBe('due');
    const audit = await s.api('GET', `/audit?entityType=duty&entityId=${d.id}&limit=50`);
    expect(audit.map((a: any) => a.action).sort()).toEqual(['duty.archived', 'duty.created', 'duty.restored', 'duty.updated']);
    expect(audit.find((a: any) => a.action === 'duty.updated').details.changes).toEqual(['level']);
    expect(await status(vera('GET', '/duties/dty_nothing'))).toBe(404);
  });

  it('check the process, the schedule and the application they name', async () => {
    const svc = await service();
    const base = { serviceId: svc.id, name: 'Firmware check', processId, interval: 'weekly', level: 'recommended' };
    expect(await code(dana('POST', '/duties', { ...base, processId: 'nope' }))).toBe('DUTY_PROCESS_UNKNOWN');
    expect(await code(dana('POST', '/duties', { ...base, interval: 'daily' }))).toBe('INVALID_INPUT');
    expect(await code(dana('POST', '/duties', { ...base, owners: ['olivia'] }))).toBe('INVALID_INPUT');
    expect(await code(dana('POST', '/duties', { ...base, graceDays: 91 }))).toBe('INVALID_INPUT');
    expect(await code(dana('POST', '/duties', { ...base, applicationId: 'app_nope' }))).toBe('DUTY_APPLICATION_NOT_IN_SERVICE');
    const schedules = await s.api('GET', '/schedules');
    const other = schedules.find((x: any) => x.processId !== processId);
    if (other) expect(await code(dana('POST', '/duties', { ...base, scheduleId: other.id }))).toBe('DUTY_SCHEDULE_PROCESS');
    const sch = await s.api('POST', '/schedules', { name: 'Duty schedule', processId, cron: '0 3 * * 1', enabled: false });
    const app = await s.api('POST', '/applications', { name: 'Duty firmware app', owners: [] });
    await s.api('PUT', `/services/${svc.id}/applications/${app.id}`, { role: 'primary' });
    const d = await dana('POST', '/duties', { ...base, scheduleId: sch.id, applicationId: app.id });
    expect(d.schedule).toMatchObject({ id: sch.id, name: 'Duty schedule', enabled: false });
    expect(d.applicationName).toBe('Duty firmware app');
    expect((await vera('GET', `/duties?applicationId=${app.id}`)).map((x: any) => x.id)).toEqual([d.id]);
    // a process the reader may not view: the duty is listed, the process is not named
    const proc = await s.api('POST', '/processes', { definition: { name: 'Secret restore', nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } });
    await s.api('PUT', `/processes/${proc.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
    expect(await code(olivia('POST', '/duties', { ...base, name: 'Hidden', processId: proc.id }))).toBe('FORBIDDEN');
    const hidden = await dana('POST', '/duties', { ...base, name: 'Hidden', processId: proc.id });
    expect(hidden.processName).toBe('Secret restore');
    const asVera = await vera('GET', `/duties/${hidden.id}`);
    expect([asVera.processId, asVera.processName, asVera.processVisible]).toEqual([null, null, false]);
    expect(JSON.stringify(asVera)).not.toContain('Secret restore');
  });
});

// ---------- skips ----------

describe('exceptions (skipped for this period)', () => {
  it('need a second person: never the one who asked, also not under a former name', async () => {
    const svc = await service(['user:olivia']);
    const d = await dana('POST', '/duties', {
      serviceId: svc.id,
      name: 'Restore test',
      processId: freshProc,
      interval: 'monthly',
      level: 'mandatory',
      owners: ['user:olivia'],
    });
    const key = d.current.key;
    expect(await status(vera('POST', `/duties/${d.id}/skips`, { periodKey: key, reason: 'x' }))).toBe(403);
    expect(await code(olivia('POST', `/duties/${d.id}/skips`, { periodKey: '2026-Q1', reason: 'x' }))).toBe('DUTY_PERIOD_UNKNOWN');
    expect(await code(olivia('POST', `/duties/${d.id}/skips`, { periodKey: '2024-01', reason: 'x' }))).toBe('DUTY_PERIOD_CLOSED');
    expect(await code(olivia('POST', `/duties/${d.id}/skips`, { periodKey: '2099-01', reason: 'x' }))).toBe('DUTY_PERIOD_TOO_FAR');
    const asked = await olivia('POST', `/duties/${d.id}/skips`, { periodKey: key, reason: 'The backup system is replaced this month' });
    const skip = asked.skips[0];
    expect(skip).toMatchObject({ status: 'pending', requestedBy: 'olivia', canDecide: false, canWithdraw: true, decideBlocked: 'FOUR_EYES_SKIP' });
    expect(asked.current.status).toBe('due');
    expect(asked.current.skip).toMatchObject({ id: skip.id, status: 'pending' });
    expect(await code(olivia('POST', `/duties/${d.id}/skips`, { periodKey: key, reason: 'again' }))).toBe('DUTY_SKIP_EXISTS');
    // four-eyes: the requester cannot decide; a viewer may not decide at all
    expect(await code(olivia('POST', `/duties/${d.id}/skips/${skip.id}/decision`, { decision: 'approve' }))).toBe('FOUR_EYES_SKIP');
    expect(await status(vera('POST', `/duties/${d.id}/skips/${skip.id}/decision`, { decision: 'approve' }))).toBe(403);
    expect(await status(adam('POST', `/duties/${d.id}/skips/${skip.id}/withdraw`))).toBe(403);
    const approved = await adam('POST', `/duties/${d.id}/skips/${skip.id}/decision`, { decision: 'approve', comment: 'Agreed with the CISO' });
    expect(approved.current).toMatchObject({ status: 'skipped', skip: { status: 'approved', decidedBy: 'adam' } });
    expect(await code(dana('POST', `/duties/${d.id}/skips/${skip.id}/decision`, { decision: 'reject' }))).toBe('DUTY_SKIP_DECIDED');
    const audit = await s.api('GET', `/audit?entityType=duty&entityId=${d.id}&limit=50`);
    const approval = audit.find((a: any) => a.action === 'duty.skip_approved');
    expect(approval).toMatchObject({ actor: 'adam', details: { requestedBy: 'olivia', comment: 'Agreed with the CISO' } });
    expect(audit.some((a: any) => a.action === 'duty.skip_requested' && a.actor === 'olivia')).toBe(true);

    // a former name of the approver (imported account) counts as the same person
    const users = await s.api('GET', '/users');
    const adamId = users.find((u: any) => u.username === 'adam').id;
    db().run(
      `INSERT INTO instance_imports (id, package_id, package_sha256, imported_at, imported_by, source_fingerprint, source_public_key, source_version,
         source_exported_at, source_exported_by, manifest, mapping, mapping_sha256, counts, history_checkpoint, history_entries)
       VALUES ('imp_duty', '00000000-0000-0000-0000-000000000001', 'x', 'now', 'test', 'fp', 'key', '0.1.2', 'now', 'test', '{}', '[]', '', '{}', '{}', 0)`,
    );
    db().run("INSERT INTO identity_aliases (kind, alias, target_id, import_id) VALUES ('user', 'laptop-adam', ?, 'imp_duty')", adamId);
    (await import('../src/auth/aliases.js')).invalidateAliases();
    const next = (await dana('GET', `/duties/${d.id}`)).current.key;
    const nextKey = (() => {
      const [y, m] = next.split('-').map(Number);
      return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    })();
    db().run(
      `INSERT INTO duty_skips (id, duty_id, period_key, period_start, reason, status, requested_by, requested_at) VALUES ('dsk_alias', ?, ?, '2099-01-01T00:00:00Z', 'Planned', 'pending', 'laptop-adam', ?)`,
      d.id,
      nextKey,
      new Date().toISOString(),
    );
    expect(await code(adam('POST', `/duties/${d.id}/skips/dsk_alias/decision`, { decision: 'approve' }))).toBe('FOUR_EYES_SKIP');
    expect((await adam('POST', `/duties/${d.id}/skips/dsk_alias/withdraw`)).skips.find((x: any) => x.id === 'dsk_alias').status).toBe('withdrawn');
    // a rejected exception leaves the period as it is
    const again = await dana('POST', `/duties/${d.id}/skips`, { periodKey: nextKey, reason: 'Planned downtime' });
    const rejected = await olivia('POST', `/duties/${d.id}/skips/${again.skips[0].id}/decision`, { decision: 'reject', comment: 'Not a reason' });
    expect(rejected.skips[0]).toMatchObject({ status: 'rejected', decidedBy: 'olivia' });
  });

  it('skipped wins over failed and missed, done wins over skipped, and done periods need no exception', async () => {
    const d = await duty({ activeFrom: '2026-02-01T00:00:00Z' });
    run(d.proc, { status: 'failed', start: '2026-02-03T08:00:00Z', end: '2026-02-03T08:10:00Z' });
    db().run(
      `INSERT INTO duty_skips (id, duty_id, period_key, period_start, reason, status, requested_by, requested_at, decided_by, decided_at)
       VALUES ('dsk_feb', ?, '2026-02', '2026-01-31T23:00:00Z', 'Migration', 'approved', 'dana', 'now', 'adam', 'now')`,
      d.id,
    );
    expect(statusAt(d.row(), '2026-02', '2026-03-02T08:00:00Z')).toMatchObject({ status: 'skipped', skipId: 'dsk_feb' });
    run(d.proc, { status: 'succeeded', start: '2026-02-10T08:00:00Z', end: '2026-02-10T08:10:00Z' });
    expect(statusAt(d.row(), '2026-02', '2026-03-02T08:00:00Z')?.status).toBe('done');
    // a period done today needs no exception
    const svc = await service();
    const quick = (await s.api('POST', '/processes', { definition: { name: 'Quick duty process', nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } })).id;
    const live = await dana('POST', '/duties', { serviceId: svc.id, name: 'Done today', processId: quick, interval: 'yearly', level: 'mandatory' });
    const r = await s.api('POST', '/runs', { processId: quick });
    await s.waitRun(r.id, ['succeeded', 'failed']);
    const done = await dana('GET', `/duties/${live.id}`);
    expect(done.current).toMatchObject({
      status: 'done',
      run: { id: r.id, status: 'succeeded', processVersion: 1, definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(await code(dana('POST', `/duties/${live.id}/skips`, { periodKey: done.current.key, reason: 'x' }))).toBe('DUTY_PERIOD_DONE');
    // a dry run of it does not count
    const dry = await dana('POST', '/duties', { serviceId: svc.id, name: 'Dry today', processId: quick, interval: 'yearly', level: 'mandatory' });
    db().run('UPDATE runs SET dry_run = 1 WHERE id = ?', r.id);
    expect((await dana('GET', `/duties/${dry.id}`)).current.status).toBe('due');
  });
});

// ---------- notifications, start page, summary, report, API ----------

describe('reminders and missed periods', () => {
  it('remind the responsible people once before the period ends, and tell them once when it was missed', async () => {
    const d = await duty({ grace: 2, remind: 5, owners: ['user:olivia'], activeFrom: '2025-05-01T00:00:00Z' });
    const ids = Object.fromEntries((await s.api('GET', '/users')).map((u: any) => [u.username, u.id]));
    const inApp = (user: string) => db().all<any>("SELECT * FROM notifications WHERE user_id = ? AND event LIKE 'duty.%' ORDER BY ts", ids[user]);
    // May 2025 ends 31 May 22:00Z; the reminder is due from 26 May 00:00 local
    jobs.runDutyJob(Z('2025-05-20T08:00:00Z'));
    expect(inApp('olivia').filter((n) => n.link === `/duties/${d.id}`)).toHaveLength(0);
    jobs.runDutyJob(Z('2025-05-27T08:00:00Z'));
    jobs.runDutyJob(Z('2025-05-28T08:00:00Z'));
    const due = inApp('olivia').filter((n) => n.link === `/duties/${d.id}` && n.event === 'duty.due');
    expect(due).toHaveLength(1);
    expect(due[0].title).toContain('Duty due');
    expect(inApp('dana').filter((n) => n.link === `/duties/${d.id}`)).toHaveLength(0);
    // the grace period ends 2 June 22:00Z: closed as missed, one message
    jobs.runDutyJob(Z('2025-06-03T08:00:00Z'));
    jobs.runDutyJob(Z('2025-06-04T08:00:00Z'));
    const missed = inApp('olivia').filter((n) => n.link === `/duties/${d.id}` && n.event === 'duty.missed');
    expect(missed).toHaveLength(1);
    expect(missed[0].title).toContain('2025-05');
    expect(db().all("SELECT kind FROM duty_notifications WHERE duty_id = ? AND period_key = '2025-05' ORDER BY kind", d.id)).toEqual([
      { kind: 'due' },
      { kind: 'missed' },
    ]);
    // a done period gets no reminder; optional duties no "missed" message
    const d2 = await duty({ remind: 5, owners: ['user:olivia'], activeFrom: '2025-05-01T00:00:00Z', level: 'optional' });
    run(d2.proc, { status: 'succeeded', start: '2025-05-02T08:00:00Z', end: '2025-05-02T08:10:00Z' });
    jobs.runDutyJob(Z('2025-05-29T08:00:00Z'));
    jobs.runDutyJob(Z('2025-07-02T08:00:00Z'));
    expect(inApp('olivia').filter((n) => n.link === `/duties/${d2.id}`)).toEqual([]);
    // without owners: the service owners
    const d3 = await duty({ serviceOwners: ['user:adam'], activeFrom: '2025-05-01T00:00:00Z' });
    jobs.runDutyJob(Z('2025-06-02T08:00:00Z'));
    expect(inApp('adam').filter((n) => n.link === `/duties/${d3.id}` && n.event === 'duty.missed')).toHaveLength(1);
  });

  it('the start page tile counts mandatory duties due soon or missed – for editors, auditors and the responsible people', async () => {
    const svc = await service(['user:vera']);
    await dana('POST', '/duties', {
      serviceId: svc.id,
      name: 'Vera duty',
      processId: freshProc,
      interval: 'weekly',
      level: 'mandatory',
      owners: ['user:vera'],
    });
    const tile = async (c: Client) => (await c('GET', '/dashboard')).attention.duties;
    expect(await tile(dana)).toMatchObject({ missed: expect.any(Number), dueSoon: expect.any(Number) });
    // a weekly duty is always due within a week
    expect((await tile(vera)).dueSoon).toBeGreaterThanOrEqual(1);
    // olivia is responsible for no duty of a service in real time (only the fake-time ones above, which are mandatory too)
    const o = await tile(olivia);
    expect(o === undefined || typeof o.missed === 'number').toBe(true);
  });

  it('the daily summary lists the duties due and missed for the responsible person', async () => {
    const d = await duty({ owners: ['user:vera'], activeFrom: '2025-08-01T00:00:00Z', remind: 3 });
    const sum = await import('../src/notifications/summary.js');
    const { DEFAULT_DAILY_SUMMARY } = await import('@sm/shared');
    const users = await s.api('GET', '/users');
    const vu = users.find((u: any) => u.username === 'vera');
    const prefs = { ...DEFAULT_DAILY_SUMMARY, enabled: true, timeZone: TZ, sections: ['duties'] } as any;
    const at = (iso: string) => sum.buildSummary(vu, prefs, Z(iso) - 86400000, Z(iso)).sections[0]!;
    // 29 Aug: due within the reminder days
    expect(at('2025-08-29T06:00:00Z').items.map((i) => i.title)).toContain(`${d.row().name} (${d.service.name}) – period 2025-08`);
    // 1 Sep: August was missed in the last day
    const sep = at('2025-09-01T06:00:00Z');
    expect(sep.items.some((i) => i.title.includes('2025-08') && i.detail?.startsWith('missed'))).toBe(true);
    expect(at('2025-08-10T06:00:00Z').items.filter((i) => i.link === `/duties/${d.id}`)).toHaveLength(0);
  });

  it('the "duties" report section and the public API show the stored periods', async () => {
    const d = await duty({ activeFrom: '2025-09-01T00:00:00Z' });
    run(d.proc, { status: 'succeeded', start: '2025-09-03T08:00:00Z', end: '2025-09-03T08:10:00Z' });
    jobs.runDutyJob(Z('2025-11-02T08:00:00Z'));
    const { reportSection } = await import('../src/reports/sections.js');
    await import('../src/reports/schedules.js');
    const { runAs } = await import('../src/auth/context.js');
    const { getUser, toAuthUser } = await import('../src/auth/users.js');
    const users = await s.api('GET', '/users');
    const sec = reportSection('duties')!;
    expect(sec).toBeTruthy();
    const cfg = sec.schema.parse({ serviceIds: [d.service.id] });
    const data = runAs(toAuthUser(getUser(users.find((u: any) => u.username === 'audrey').id)), () =>
      sec.build(cfg, { from: Z('2025-09-01T00:00:00Z'), to: Z('2025-11-01T00:00:00Z'), now: Date.now(), lang: 'en' }),
    ) as any;
    expect(data.ended.map((r: any) => [r.period, r.status])).toEqual([
      ['2025-09', 'done'],
      ['2025-10', 'missed'],
    ]);
    expect(data.counts).toMatchObject({ done: 1, missed: 1 });
    expect(data.ended[0].version).toBe(1);

    const token = (await vera('POST', '/me/tokens', { name: 'duties', scope: 'read' })).token;
    const v1 = async (url: string) => {
      const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json() };
    };
    const list = await v1(`/duties?serviceId=${d.service.id}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: any) => x.id)).toEqual([d.id]);
    const ps = await v1(`/duties/${d.id}/periods?closed=true&limit=2`);
    expect(ps.body.items.map((p: any) => [p.key, p.status])).toEqual([
      ['2025-10', 'missed'],
      ['2025-09', 'done'],
    ]);
    // the runs of a process the reader may not view are not shown (this duty's process is not one the reader may view)
    expect(ps.body.items[1].run).toBeNull();
    expect(ps.body.items[1].snapshot).toMatchObject({ level: 'mandatory', interval: 'monthly', timeZone: TZ });
    expect((await v1('/duties/dty_none')).status).toBe(404);
  });
});
