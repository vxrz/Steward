import { db } from '../db.js';
import { emit, type CheckContent } from '../events.js';
import { sourceOfRun, type RunSource } from './notify-source.js';

/**
 * Which check results of a run notify (#127, #139).
 *
 * Runs started by hand notify on every failed check, as before. Runs of a source that repeats them – a schedule, a
 * webhook trigger, a monitor output, and the sub-processes of their runs – follow the source's policy:
 * - change: when a check starts failing, when its result changes, and – while it keeps failing – as a reminder every
 *   `reminderHours` (0: never). What counts as a change: the message or severity (`result`), or nothing until the
 *   check passes again (`state`: only the start and the end of failing).
 * - every: after every run in which the check fails (webhook triggers and monitor outputs start with this).
 * - off: never.
 * `resolved` adds a message when the check passes again. A check step with `notify: false` never notifies. Where the
 * messages go and whether they are paused is decided when they are sent (notifications/service.ts).
 *
 * The state is kept per source, check and dry run in notify_alerts: one row while the check fails.
 */

export interface CheckOutcome extends CheckContent {
  runId: string;
  processId: string;
  processName: string;
  /** Kept for the callers; the source is read from the run */
  scheduleId: string | null;
  check: string;
  passed: boolean;
  severity: string;
  message: string;
  dryRun: boolean;
  /** The step's `notify` (false: informational) */
  notify: boolean | undefined;
  /** Whether a lower or a higher value is better (default lower) */
  betterWhen?: 'lower' | 'higher';
}

interface AlertRow {
  failing_since: string;
  severity: string;
  message: string;
  value: number | null;
  notified_at: string;
}

const HOUR = 3_600_000;
/** Messages are compared on this many characters (the stored copy is cut there too). */
const MESSAGE_CHARS = 2000;
const RANK: Record<string, number> = { info: 0, warning: 1, error: 2 };

/** Better or worse: from the value when the check has one, else from the severity. */
export function directionOf(
  o: { value?: number; severity: string; betterWhen?: 'lower' | 'higher' },
  prev: { value: number | null; severity: string },
): 'better' | 'worse' | 'same' {
  if (o.value !== undefined && prev.value !== null && prev.value !== undefined) {
    if (o.value === prev.value) return 'same';
    const lower = o.value < prev.value;
    return (o.betterWhen ?? 'lower') === 'lower' ? (lower ? 'better' : 'worse') : lower ? 'worse' : 'better';
  }
  const a = RANK[o.severity] ?? 2;
  const b = RANK[prev.severity] ?? 2;
  return a === b ? 'same' : a < b ? 'better' : 'worse';
}

const content = (o: CheckOutcome): CheckContent => ({
  ...(o.checkId ? { checkId: o.checkId } : {}),
  ...(o.headline ? { headline: o.headline } : {}),
  ...(o.value !== undefined ? { value: o.value } : {}),
  ...(o.items?.length ? { items: o.items } : {}),
  runbook: o.runbook ?? null,
});

export function checkOutcome(o: CheckOutcome, now = Date.now()): void {
  if (o.notify === false) return;
  const base = { runId: o.runId, processId: o.processId, processName: o.processName, check: o.check, dryRun: o.dryRun };
  const failed = { ...base, severity: o.severity, message: o.message, ...content(o) };
  const src: RunSource | null = sourceOfRun(o.runId);
  if (!src) {
    if (!o.passed) emit('check.failed', failed);
    return;
  }
  const p = src.policy;
  const ids = { source: src.key, ...(src.kind === 'schedule' ? { scheduleId: src.id } : {}) };
  const key = [src.key, o.check, o.dryRun ? 1 : 0] as const;
  const row = db().get<AlertRow>(
    'SELECT failing_since, severity, message, value, notified_at FROM notify_alerts WHERE source = ? AND check_name = ? AND dry_run = ?',
    ...key,
  );
  const ts = new Date(now).toISOString();
  if (o.passed) {
    if (!row) return;
    db().run('DELETE FROM notify_alerts WHERE source = ? AND check_name = ? AND dry_run = ?', ...key);
    if (p.mode !== 'off' && p.resolved) emit('check.resolved', { ...base, ...ids, since: row.failing_since, ...content(o) });
    return;
  }
  const message = o.message.slice(0, MESSAGE_CHARS);
  const value = o.value ?? null;
  if (!row) {
    db().run(
      'INSERT INTO notify_alerts (source, check_name, dry_run, failing_since, severity, message, value, notified_at, last_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...key,
      ts,
      o.severity,
      message,
      value,
      ts,
      o.runId,
    );
    if (p.mode === 'off') return;
    emit('check.failed', { ...failed, ...ids, phase: p.mode === 'every' ? 'every' : 'new', since: ts });
    return;
  }
  const differs = row.message !== message || row.severity !== o.severity || (value !== null && row.value !== null && Number(row.value) !== value);
  // "state": only the start and the end of failing count, a different result is not news
  const changed = p.change !== 'state' && differs;
  const remind = !changed && Number(p.reminderHours) > 0 && now - Date.parse(row.notified_at) >= Number(p.reminderHours) * HOUR;
  const phase = p.mode === 'every' ? 'every' : changed ? 'changed' : remind ? 'reminder' : null;
  const send = p.mode !== 'off' && phase !== null;
  db().run(
    `UPDATE notify_alerts SET severity = ?, message = ?, value = ?, last_run_id = ?${send ? ', notified_at = ?' : ''} WHERE source = ? AND check_name = ? AND dry_run = ?`,
    o.severity,
    message,
    value,
    o.runId,
    ...(send ? [ts] : []),
    ...key,
  );
  if (!send) return;
  const prev = { value: row.value === null ? null : Number(row.value), severity: row.severity };
  emit('check.failed', {
    ...failed,
    ...ids,
    phase: phase!,
    since: row.failing_since,
    ...(prev.value !== null ? { previousValue: prev.value } : {}),
    direction: directionOf(o, prev),
  });
}

/** The checks of a source that fail now (for "still failing" after a pause). */
export function failingChecks(source: string): {
  check: string;
  dryRun: boolean;
  since: string;
  severity: string;
  message: string;
  value: number | null;
  runId: string;
}[] {
  return db()
    .all<{
      check_name: string;
      dry_run: number;
      failing_since: string;
      severity: string;
      message: string;
      value: number | null;
      last_run_id: string;
    }>('SELECT check_name, dry_run, failing_since, severity, message, value, last_run_id FROM notify_alerts WHERE source = ? ORDER BY failing_since', source)
    .map((r) => ({
      check: r.check_name,
      dryRun: !!r.dry_run,
      since: r.failing_since,
      severity: r.severity,
      message: r.message,
      value: r.value === null ? null : Number(r.value),
      runId: r.last_run_id,
    }));
}

/** A source whose policy changed how it counts starts over with its failing checks. */
export function resetAlerts(source: string): void {
  db().run('DELETE FROM notify_alerts WHERE source = ?', source);
}
