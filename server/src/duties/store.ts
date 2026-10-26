import { db } from '../db.js';
import { audit } from '../audit.js';
import { evaluateDuty, storedPeriods, type DutyRow, type Evaluated, type PeriodRow } from './evaluate.js';
import { graceEnd, instanceTimeZone, nextPeriod, periodAt } from './periods.js';

/**
 * Writing duty periods: the open ones the duty job keeps up to date, and closing them – at the end of the grace
 * period (the job), or early, under the rules they were judged by, before a duty is archived or its rules change. A
 * closed period is never written again (every write has `WHERE closed_at IS NULL`).
 */

export interface ServiceRef {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

const iso = (t: number) => new Date(t).toISOString();

function processName(id: string): string {
  return db().get<{ name: string }>('SELECT name FROM processes WHERE id = ?', id)?.name ?? id;
}

/** Writes an open period, or closes it; returns whether the row is now closed by this call. */
function write(d: DutyRow, e: Evaluated, tz: string, close: boolean, now: number, note: string | null = null): boolean {
  const res = db().run(
    `INSERT INTO duty_periods (duty_id, period_key, period_start, period_end, grace_end, status, run_id, run_status, run_started_at, run_finished_at,
       failed_runs, skip_id, service_id, application_id, duty_name, process_id, process_name, level, interval_kind, grace_days, time_zone, evaluated_at,
       closed_at, close_note, run_version, run_definition_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (duty_id, period_key) DO UPDATE SET status = excluded.status, run_id = excluded.run_id, run_status = excluded.run_status,
       run_started_at = excluded.run_started_at, run_finished_at = excluded.run_finished_at, failed_runs = excluded.failed_runs, skip_id = excluded.skip_id,
       service_id = excluded.service_id, application_id = excluded.application_id, duty_name = excluded.duty_name, process_id = excluded.process_id,
       process_name = excluded.process_name, level = excluded.level, interval_kind = excluded.interval_kind, grace_days = excluded.grace_days,
       time_zone = excluded.time_zone, evaluated_at = excluded.evaluated_at, closed_at = excluded.closed_at, close_note = excluded.close_note,
       run_version = excluded.run_version, run_definition_hash = excluded.run_definition_hash
     WHERE duty_periods.closed_at IS NULL`,
    d.id,
    e.period.key,
    iso(e.period.start),
    iso(e.period.end),
    iso(e.graceEnd),
    e.status,
    e.run?.id ?? null,
    e.run?.status ?? null,
    e.run?.startedAt || null,
    e.run?.finishedAt ?? null,
    e.failedRuns,
    e.skipId,
    d.service_id,
    d.application_id,
    d.name,
    d.process_id,
    processName(d.process_id),
    d.level,
    d.interval_kind,
    d.grace_days,
    tz,
    iso(now),
    close ? iso(now) : null,
    close ? note : null,
    e.run?.processVersion ?? null,
    e.run?.definitionHash ?? null,
  );
  return close && res.changes === 1;
}

const differs = (r: PeriodRow, e: Evaluated) =>
  r.status !== e.status || r.run_id !== (e.run?.id ?? null) || r.failed_runs !== e.failedRuns || r.skip_id !== e.skipId;

function closedAudit(d: DutyRow, s: ServiceRef, e: Evaluated, note: string | null): void {
  audit({
    actor: note ? undefined : 'system',
    action: 'duty.period_closed',
    entityType: 'duty',
    entityId: d.id,
    summary: `Duty "${d.name}" of service "${s.name}": period ${e.period.key} ${e.status}${note ? ` (closed early: ${note})` : ''}`,
    details: {
      serviceId: s.id,
      periodKey: e.period.key,
      status: e.status,
      level: d.level,
      runId: e.run?.id ?? null,
      failedRuns: e.failedRuns,
      skipId: e.skipId,
      ...(note ? { closedEarly: note } : {}),
    },
  });
}

/** Stores the open periods of a duty and closes the ended ones. Returns the periods as evaluated and the newly closed. */
export function persistDuty(d: DutyRow, s: ServiceRef, now: number, tz = instanceTimeZone()): { periods: Evaluated[]; closed: Evaluated[] } {
  const closed: Evaluated[] = [];
  const periods = evaluateDuty(d, now, tz, !d.archived && !s.archived);
  for (const e of periods) {
    if (e.closed) continue;
    // every open period is stored (the start page and the daily summary read them), written again only when it changed
    if (!e.final && e.row && !differs(e.row, e)) continue;
    db().tx(() => {
      if (!write(d, e, tz, e.final, now)) return;
      closed.push(e);
      closedAudit(d, s, e, null);
    });
  }
  return { periods, closed };
}

/**
 * Before a duty is archived or the rules a period is judged by change (process, interval, grace period, level): every
 * period that has ended – also one still in its grace period – is closed now, under the old rules and as it stands:
 * done or late with a run that counts, skipped with an approved exception, else failed or missed. The new rules apply
 * from the current period on. With `keepCurrent` (archiving), the current period is closed too when it is done,
 * late or skipped already – that result stays; otherwise it is left open (and dropped by the caller). Runs in the
 * transaction of the change.
 */
export function closeEnded(d: DutyRow, s: ServiceRef, now: number, note: string, keepCurrent = false, tz = instanceTimeZone()): Evaluated[] {
  if (d.archived || s.archived) return [];
  const out: Evaluated[] = [];
  for (const e of evaluateDuty(d, now, tz)) {
    if (e.closed) continue;
    if (e.period.end > now && !(keepCurrent && (e.status === 'done' || e.status === 'late' || e.status === 'skipped'))) continue;
    const final: Evaluated = e.status === 'due' ? { ...e, status: e.failedRuns > 0 ? 'failed' : 'missed', final: true } : { ...e, final: true };
    if (!write(d, final, tz, true, now, note)) continue;
    closedAudit(d, s, final, note);
    out.push(final);
  }
  return out;
}

/**
 * A restored duty: the periods it was archived through are stored as inactive (from the end of its last stored
 * period – or the period it was defined in – up to the current period), so they are neither judged nor lost. The
 * current period is judged as usual.
 */
export function storeInactiveGap(d: DutyRow, now: number, tz = instanceTimeZone()): number {
  const rows = storedPeriods(d.id);
  const lastEnd = rows.reduce((m, r) => Math.max(m, Date.parse(r.period_end)), 0);
  const current = periodAt(d.interval_kind, now, tz);
  let n = 0;
  for (
    let p = periodAt(d.interval_kind, Math.max(lastEnd, Date.parse(d.active_from)), tz);
    p.start < current.start && n < 600;
    p = nextPeriod(d.interval_kind, p, tz)
  ) {
    if (rows.some((r) => r.period_key === p.key)) continue;
    const e: Evaluated = {
      period: p,
      graceEnd: graceEnd(p, d.grace_days, tz),
      status: 'inactive',
      run: null,
      failedRuns: 0,
      runsInProgress: 0,
      skipId: null,
      closed: false,
      closedAt: null,
      final: true,
      row: null,
    };
    if (write(d, e, tz, true, now, 'duty archived')) n++;
  }
  return n;
}
