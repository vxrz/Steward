import type { DutyInterval, DutyLevel, DutyPeriodStatus, DutyRunRef } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { graceEnd, nextPeriod, periodAt, type Period } from './periods.js';

/**
 * How a period of a duty gets its status, from the runs of the duty's process.
 *
 * What counts: real runs of exactly that process – any trigger (a person, a schedule, a webhook), any version of the
 * process. Dry runs never count (they change nothing on the platforms), runs of other processes never count (a copy
 * of a process is another process), and cancelled runs are ignored (someone stopped them on purpose).
 *
 * A run belongs to the period it started in. The first period of a duty counts only runs started after the duty was
 * defined (and, after a change of its rules, after the last closed period). Per period, in this order:
 *   - done: a run that started in the period, succeeded and ended by the end of the grace period;
 *   - late: no such run, but one that started in the grace period and ended in it;
 *   - skipped: an approved exception for the period (four-eyes);
 *   - failed: runs started in the period, but only failed ones (also interrupted runs, and runs that took the
 *     "rejected" branch of an approval: they succeed as runs, but the duty was not done);
 *   - missed: no run at all.
 * A run counts for one period only: the run that made a period late does not also make the next period done.
 * Runs waiting for a decision or a manual step count once they end, by their final status – a run still waiting at
 * the end of the grace period does not count.
 *
 * Open periods are evaluated on every read and by the duty job; the job stores the result and closes a period once
 * its grace period has ended. A closed period is never evaluated again. The evidence of an open period is kept when
 * its run is deleted by the run retention (a done period stays done).
 */

export interface DutyRow {
  id: string;
  service_id: string;
  application_id: string | null;
  name: string;
  description: string;
  process_id: string;
  schedule_id: string | null;
  interval_kind: DutyInterval;
  level: DutyLevel;
  grace_days: number;
  remind_days: number;
  owners: string;
  archived: number;
  active_from: string;
  /** When the current rules started (the last change of process, interval, grace or level, an archive or a restore) */
  rules_from: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface PeriodRow {
  duty_id: string;
  period_key: string;
  period_start: string;
  period_end: string;
  grace_end: string;
  status: DutyPeriodStatus;
  run_id: string | null;
  run_status: string | null;
  run_started_at: string | null;
  run_finished_at: string | null;
  failed_runs: number;
  skip_id: string | null;
  service_id: string;
  application_id: string | null;
  duty_name: string;
  process_id: string;
  process_name: string;
  level: DutyLevel;
  interval_kind: DutyInterval;
  grace_days: number;
  time_zone: string;
  evaluated_at: string;
  closed_at: string | null;
  close_note: string | null;
  run_version: number | null;
  run_definition_hash: string | null;
}

export interface Evaluated {
  period: Period;
  graceEnd: number;
  status: DutyPeriodStatus;
  run: DutyRunRef | null;
  failedRuns: number;
  runsInProgress: number;
  skipId: string | null;
  /** Stored as closed (never changes) */
  closed: boolean;
  closedAt: string | null;
  /** The grace period has ended: the job closes the period with this status */
  final: boolean;
  /** The stored row (closed periods; open ones the job wrote) */
  row: PeriodRow | null;
}

interface RunRow {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  process_version: number;
  definition_hash: string;
}

const iso = (t: number) => new Date(t).toISOString();
const MAX_PERIODS = 600;

/** Runs that took the "rejected" branch of an approval (the run succeeded, the approval did not). */
function rejectedRuns(ids: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (const t of db().all<{ run_id: string; decision: string | null }>(
      `SELECT run_id, decision FROM run_tasks WHERE mode = 'approve' AND run_id IN (${chunk.map(() => '?').join(',')})`,
      ...chunk,
    ))
      if (parseJson<{ approved?: boolean } | null>(t.decision, null)?.approved === false) out.add(t.run_id);
  }
  return out;
}

const ref = (r: RunRow): DutyRunRef => ({
  id: r.id,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  processVersion: r.process_version,
  definitionHash: r.definition_hash,
});

/** The approved skips of a duty, by period key. */
function approvedSkips(dutyId: string): Map<string, string> {
  return new Map(
    db()
      .all<{ id: string; period_key: string }>("SELECT id, period_key FROM duty_skips WHERE duty_id = ? AND status = 'approved'", dutyId)
      .map((s) => [s.period_key, s.id]),
  );
}

export const storedPeriods = (dutyId: string): PeriodRow[] =>
  db().all<PeriodRow>('SELECT * FROM duty_periods WHERE duty_id = ? ORDER BY period_start, period_key', dutyId);

/** One period: its status from the runs, without the runs other periods already count. */
function judge(
  d: DutyRow,
  p: Period,
  g: number,
  now: number,
  claimed: Set<string>,
  skipId: string | null,
  row: PeriodRow | null,
  since: number,
): Omit<Evaluated, 'closed' | 'closedAt' | 'row'> {
  const runs = db()
    .all<RunRow>(
      'SELECT id, status, started_at, finished_at, process_version, definition_hash FROM runs WHERE process_id = ? AND dry_run = 0 AND started_at >= ? AND started_at < ? ORDER BY started_at, id',
      d.process_id,
      iso(Math.max(p.start, since)),
      iso(g),
    )
    .filter((r) => !claimed.has(r.id));
  const rejected = rejectedRuns(runs.filter((r) => r.status === 'succeeded').map((r) => r.id));
  const endIso = iso(p.end);
  const gIso = iso(g);
  const ok = runs.filter((r) => r.status === 'succeeded' && !rejected.has(r.id) && !!r.finished_at && r.finished_at < gIso);
  const byEnd = (a: RunRow, b: RunRow) => a.finished_at!.localeCompare(b.finished_at!) || a.id.localeCompare(b.id);
  const inPeriod = runs.filter((r) => r.started_at < endIso);
  const failed = inPeriod.filter((r) => r.status === 'failed' || r.status === 'interrupted' || rejected.has(r.id));
  const inProgress = inPeriod.filter((r) => r.status === 'queued' || r.status === 'running' || r.status === 'waiting').length;
  const done = ok.filter((r) => r.started_at < endIso).sort(byEnd)[0];
  const late = ok.filter((r) => r.started_at >= endIso).sort(byEnd)[0];
  const final = now >= g;
  // retention deleted the run that counted: the stored evidence stays
  const keep =
    !done && !late && row && (row.status === 'done' || row.status === 'late') && row.run_id && !db().get('SELECT 1 FROM runs WHERE id = ?', row.run_id);
  const failedRuns = Math.max(failed.length, row?.failed_runs ?? 0);
  if (keep)
    return {
      period: p,
      graceEnd: g,
      status: row.status,
      run: {
        id: row.run_id!,
        status: row.run_status ?? 'succeeded',
        startedAt: row.run_started_at ?? '',
        finishedAt: row.run_finished_at,
        processVersion: row.run_version,
        definitionHash: row.run_definition_hash,
      },
      failedRuns,
      runsInProgress: inProgress,
      skipId,
      final,
    };
  const base = { period: p, graceEnd: g, failedRuns, runsInProgress: inProgress, skipId, final };
  if (done) return { ...base, status: 'done', run: ref(done) };
  if (late) return { ...base, status: 'late', run: ref(late) };
  if (skipId) return { ...base, status: 'skipped', run: null };
  const lastFailed = failed[failed.length - 1];
  if (!final) return { ...base, status: 'due', run: lastFailed ? ref(lastFailed) : null };
  if (failedRuns > 0) return { ...base, status: 'failed', run: lastFailed ? ref(lastFailed) : null };
  return { ...base, status: 'missed', run: null };
}

/**
 * The periods of a duty from its first one up to the current one: the stored closed periods as they are, the others
 * evaluated now (oldest first, so an older period gets a run before a newer one can count it). Archived duties (and
 * duties of archived services) only have their stored periods.
 */
export function evaluateDuty(d: DutyRow, now: number, tz: string, active = true): Evaluated[] {
  const rows = storedPeriods(d.id);
  const closed = rows.filter((r) => r.closed_at);
  const out: Evaluated[] = closed.map((r) => fromRow(r));
  if (!active) return out;
  const open = new Map(rows.filter((r) => !r.closed_at).map((r) => [r.period_key, r]));
  const claimed = new Set(closed.map((r) => r.run_id).filter((x): x is string => !!x));
  const closedKeys = new Set(closed.map((r) => r.period_key));
  const skips = approvedSkips(d.id);
  const lastClosedEnd = closed.reduce((m, r) => Math.max(m, Date.parse(r.period_end)), 0);
  // the first period counts runs from the moment the duty (or its current rules) started, not from the period start:
  // runs before the duty existed, and runs the closed periods before a rule change were judged by, never count again
  const since = Math.max(Date.parse(d.active_from), d.rules_from ? Date.parse(d.rules_from) : 0, lastClosedEnd);
  let p = periodAt(d.interval_kind, since, tz);
  // a partial first period: from the moment the duty (or its current rules) started
  if (p.start < since) p = { ...p, start: since };
  for (let i = 0; i < MAX_PERIODS && p.start <= now; i++, p = nextPeriod(d.interval_kind, p, tz)) {
    if (closedKeys.has(p.key)) continue;
    const g = graceEnd(p, d.grace_days, tz);
    const row = open.get(p.key) ?? null;
    const e = judge(d, p, g, now, claimed, skips.get(p.key) ?? null, row, since);
    if (e.run && (e.status === 'done' || e.status === 'late')) claimed.add(e.run.id);
    out.push({ ...e, closed: false, closedAt: null, row });
  }
  return out.sort((a, b) => a.period.start - b.period.start || a.period.key.localeCompare(b.period.key));
}

export function fromRow(r: PeriodRow): Evaluated {
  return {
    period: { key: r.period_key, start: Date.parse(r.period_start), end: Date.parse(r.period_end) },
    graceEnd: Date.parse(r.grace_end),
    status: r.status,
    run: r.run_id
      ? {
          id: r.run_id,
          status: r.run_status ?? '',
          startedAt: r.run_started_at ?? '',
          finishedAt: r.run_finished_at,
          processVersion: r.run_version,
          definitionHash: r.run_definition_hash,
        }
      : null,
    failedRuns: r.failed_runs,
    runsInProgress: 0,
    skipId: r.skip_id,
    closed: !!r.closed_at,
    closedAt: r.closed_at,
    final: !!r.closed_at,
    row: r,
  };
}
