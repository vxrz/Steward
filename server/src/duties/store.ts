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

const differs = (r: PeriodRow, e: Evaluated, d: DutyRow) =>
  r.status !== e.status ||
  r.run_id !== (e.run?.id ?? null) ||
  r.failed_runs !== e.failedRuns ||
  r.skip_id !== e.skipId ||
  // a stricter level or a shorter grace period applies to the open period as it is
  r.level !== d.level ||
  Date.parse(r.grace_end) !== e.graceEnd;

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
    if (!e.final && e.row && !differs(e.row, e, d)) continue;
    db().tx(() => {
      if (!write(d, e, tz, e.final, now)) return;
      closed.push(e);
      closedAudit(d, s, e, null);
    });
  }
  return { periods, closed };
}

/**
 * Before a duty is archived or the rules a period is judged by change (process, interval, grace period, level), at
 * `now`. Runs in the transaction of the change and returns the closed periods and the moment the new rules start.
 *
 * - Every period that has ended – also one still in its grace period – is closed under the old rules, as it stands:
 *   done or late with a run that counts, skipped with an approved exception, else failed or missed.
 * - The current period: done, late or skipped already – closed with that status, as a whole; the new rules start
 *   when it ends. Otherwise it is closed now as **ended** (without a run – it counts as not met, like missed, but sends
 *   no "missed" message): its stored end is the moment of the change, and the new rules start then, with a partial
 *   first period up to the end of the period of the (new) interval that contains it.
 * - `endedOnly` (a change that only makes the duty stricter): only the ended periods are closed, under the old rules;
 *   the current period stays open and is judged by the stricter rules.
 */
export function closeForChange(
  d: DutyRow,
  s: ServiceRef,
  now: number,
  note: string,
  tz = instanceTimeZone(),
  endedOnly = false,
): { closed: Evaluated[]; rulesFrom: number } {
  const closed: Evaluated[] = [];
  let rulesFrom = now;
  if (d.archived || s.archived) return { closed, rulesFrom };
  const keys = new Set(storedPeriods(d.id).map((r) => r.period_key));
  for (const e of evaluateDuty(d, now, tz)) {
    if (e.closed || (endedOnly && e.period.end > now)) continue;
    let final: Evaluated;
    if (e.period.end <= now) final = e.status === 'due' ? { ...e, status: e.failedRuns > 0 ? 'failed' : 'missed', final: true } : { ...e, final: true };
    else if (e.status === 'done' || e.status === 'late' || e.status === 'skipped') {
      final = { ...e, final: true };
      rulesFrom = Math.max(rulesFrom, e.period.end);
    } else {
      // the rest of the period is judged under the new rules under its own key: this part gets a key of its own
      let n = 1;
      while (keys.has(`${e.period.key}~${n}`)) n++;
      final = { ...e, period: { ...e.period, key: `${e.period.key}~${n}`, end: now }, graceEnd: now, status: 'ended', final: true };
    }
    if (!write(d, final, tz, true, now, note)) continue;
    closedAudit(d, s, final, note);
    closed.push(final);
  }
  return { closed, rulesFrom };
}

/**
 * A restored duty: the periods that lay entirely inside the archive window (after `archivedAt`, before `now`) are
 * stored as inactive, so they are neither judged nor lost. The duty is judged again from `now` on (a partial first
 * period).
 */
export function storeInactiveGap(d: DutyRow, archivedAt: number, now: number, tz = instanceTimeZone()): number {
  const rows = storedPeriods(d.id).filter((r) => r.closed_at);
  const from = Math.max(
    archivedAt,
    rows.reduce((m, r) => Math.max(m, Date.parse(r.period_end)), 0),
  );
  let n = 0;
  for (let p = periodAt(d.interval_kind, from, tz); p.end <= now && n < 600; p = nextPeriod(d.interval_kind, p, tz)) {
    if (p.start < from || rows.some((r) => r.period_key === p.key)) continue;
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
