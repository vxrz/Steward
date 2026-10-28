import type { ScheduleNotifyMode } from '@sm/shared';
import { db } from '../db.js';
import { emit } from '../events.js';

/**
 * Which check results of a run notify (#127).
 *
 * Runs without a schedule (started by hand, by a webhook, a monitor or a parent process) notify on every failed
 * check, as before. Scheduled runs follow their schedule's setting:
 * - change (default): when a check starts failing, when its result (message or severity) changes, and – while it
 *   keeps failing with the same result – as a reminder every `reminderHours` (0: never). A check that passes again
 *   sends a "resolved" message when the schedule asks for it.
 * - every: after every run in which the check fails (the behaviour before 0.2.3), plus "resolved" when asked for.
 * - off: never.
 * A check step with `notify: false` never notifies. The state is kept per schedule, check and dry run in
 * check_alerts: one row while the check fails.
 */

export interface CheckOutcome {
  runId: string;
  processId: string;
  processName: string;
  scheduleId: string | null;
  check: string;
  passed: boolean;
  severity: string;
  message: string;
  dryRun: boolean;
  /** The step's `notify` (false: informational) */
  notify: boolean | undefined;
}

interface ScheduleNotifyRow {
  notify_mode: ScheduleNotifyMode;
  notify_reminder_hours: number;
  notify_resolved: number;
}

interface AlertRow {
  failing_since: string;
  severity: string;
  message: string;
  notified_at: string;
}

const HOUR = 3_600_000;
/** Messages are compared on this many characters (the stored copy is cut there too). */
const MESSAGE_CHARS = 2000;

export function checkOutcome(o: CheckOutcome, now = Date.now()): void {
  if (o.notify === false) return;
  const base = { runId: o.runId, processId: o.processId, processName: o.processName, check: o.check, dryRun: o.dryRun };
  const failed = { ...base, severity: o.severity, message: o.message };
  const s = o.scheduleId
    ? db().get<ScheduleNotifyRow>('SELECT notify_mode, notify_reminder_hours, notify_resolved FROM schedules WHERE id = ?', o.scheduleId)
    : undefined;
  if (!o.scheduleId || !s) {
    if (!o.passed) emit('check.failed', failed);
    return;
  }
  const scheduleId = o.scheduleId;
  const key = [scheduleId, o.check, o.dryRun ? 1 : 0] as const;
  const row = db().get<AlertRow>(
    'SELECT failing_since, severity, message, notified_at FROM check_alerts WHERE schedule_id = ? AND check_name = ? AND dry_run = ?',
    ...key,
  );
  const ts = new Date(now).toISOString();
  if (o.passed) {
    if (!row) return;
    db().run('DELETE FROM check_alerts WHERE schedule_id = ? AND check_name = ? AND dry_run = ?', ...key);
    if (s.notify_mode !== 'off' && s.notify_resolved) emit('check.resolved', { ...base, scheduleId, since: row.failing_since });
    return;
  }
  const message = o.message.slice(0, MESSAGE_CHARS);
  if (!row) {
    db().run(
      'INSERT INTO check_alerts (schedule_id, check_name, dry_run, failing_since, severity, message, notified_at, last_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ...key,
      ts,
      o.severity,
      message,
      ts,
      o.runId,
    );
    if (s.notify_mode === 'off') return;
    emit('check.failed', { ...failed, phase: s.notify_mode === 'every' ? 'every' : 'new', scheduleId, since: ts });
    return;
  }
  const changed = row.message !== message || row.severity !== o.severity;
  const remind = !changed && Number(s.notify_reminder_hours) > 0 && now - Date.parse(row.notified_at) >= Number(s.notify_reminder_hours) * HOUR;
  const phase = s.notify_mode === 'every' ? 'every' : changed ? 'changed' : remind ? 'reminder' : null;
  const send = s.notify_mode !== 'off' && phase !== null;
  db().run(
    `UPDATE check_alerts SET severity = ?, message = ?, last_run_id = ?${send ? ', notified_at = ?' : ''} WHERE schedule_id = ? AND check_name = ? AND dry_run = ?`,
    o.severity,
    message,
    o.runId,
    ...(send ? [ts] : []),
    ...key,
  );
  if (send) emit('check.failed', { ...failed, phase: phase!, scheduleId, since: row.failing_since });
}
