import type { Locale, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso } from '../util.js';
import { listUsers } from '../auth/users.js';
import { t, type MessageKey } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import { evaluateDuty, type DutyRow, type Evaluated, type PeriodRow } from './evaluate.js';
import { addLocalDays, instanceTimeZone } from './periods.js';
import { responsibleUsers } from './service.js';

/**
 * The duty job (called by the notification job loop every few minutes, idempotent):
 *   1. stores the state of the open periods of every active duty and closes the periods whose grace period has ended,
 *      with their final status (audited) – a closed period is never written again;
 *   2. sends the reminder "due soon" once per period, `remind_days` before the period ends, while it is not done;
 *   3. sends "missed" once per closed period of a mandatory or recommended duty that ended missed or failed (only
 *      for periods closed in the last week: a server that was off for months does not send a burst of old news).
 * Each message is claimed in duty_notifications before it is sent, so it goes out at most once, also across restarts.
 * Nothing happens while the vault is locked (audit entries and external channels need it).
 */

const DAY = 86400000;
const MISSED_WITHIN_DAYS = 7;
const iso = (t: number) => new Date(t).toISOString();

interface ServiceRow {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

function processName(id: string): string {
  return db().get<{ name: string }>('SELECT name FROM processes WHERE id = ?', id)?.name ?? id;
}

/** Writes an open period, or closes it; returns whether the row is now closed by this call. */
function write(d: DutyRow, e: Evaluated, tz: string, close: boolean, now: number): boolean {
  const res = db().run(
    `INSERT INTO duty_periods (duty_id, period_key, period_start, period_end, grace_end, status, run_id, run_status, run_started_at, run_finished_at,
       failed_runs, skip_id, service_id, application_id, duty_name, process_id, process_name, level, interval_kind, grace_days, time_zone, evaluated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (duty_id, period_key) DO UPDATE SET status = excluded.status, run_id = excluded.run_id, run_status = excluded.run_status,
       run_started_at = excluded.run_started_at, run_finished_at = excluded.run_finished_at, failed_runs = excluded.failed_runs, skip_id = excluded.skip_id,
       service_id = excluded.service_id, application_id = excluded.application_id, duty_name = excluded.duty_name, process_id = excluded.process_id,
       process_name = excluded.process_name, level = excluded.level, interval_kind = excluded.interval_kind, grace_days = excluded.grace_days,
       time_zone = excluded.time_zone, evaluated_at = excluded.evaluated_at, closed_at = excluded.closed_at
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
  );
  return close && res.changes === 1;
}

const differs = (r: PeriodRow, e: Evaluated) =>
  r.status !== e.status || r.run_id !== (e.run?.id ?? null) || r.failed_runs !== e.failedRuns || r.skip_id !== e.skipId;

/** Stores the open periods of a duty that have something to keep and closes the ended ones. Returns the newly closed. */
export function persistDuty(d: DutyRow, s: ServiceRow, now: number, tz = instanceTimeZone()): Evaluated[] {
  const closed: Evaluated[] = [];
  for (const e of evaluateDuty(d, now, tz, !d.archived && !s.archived)) {
    if (e.closed) continue;
    const worth = e.status !== 'due' || e.failedRuns > 0;
    if (!e.final && !(e.row ? differs(e.row, e) : worth)) continue;
    db().tx(() => {
      if (!write(d, e, tz, e.final, now)) return;
      closed.push(e);
      audit({
        actor: 'system',
        action: 'duty.period_closed',
        entityType: 'duty',
        entityId: d.id,
        summary: `Duty "${d.name}" of service "${s.name}": period ${e.period.key} ${e.status}`,
        details: {
          serviceId: s.id,
          periodKey: e.period.key,
          status: e.status,
          level: d.level,
          runId: e.run?.id ?? null,
          failedRuns: e.failedRuns,
          skipId: e.skipId,
        },
      });
    });
  }
  return closed;
}

const claim = (dutyId: string, key: string, kind: 'due' | 'missed'): boolean =>
  db().run('INSERT INTO duty_notifications (duty_id, period_key, kind, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', dutyId, key, kind, nowIso())
    .changes === 1;

const lastDay = (l: Locale, end: number, tz: string) =>
  new Intl.DateTimeFormat(l, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(
    new Date(addLocalDays(end, -1, tz) + 12 * 3600000),
  );
const level = (l: Locale, x: string) => t(l, `duty.levels.${x}` as MessageKey);

function sendDue(d: DutyRow, s: ServiceRow, e: Evaluated, users: UserInfo[], now: number, tz: string): void {
  const days = Math.max(1, Math.ceil((e.period.end - now) / DAY));
  notify({
    event: 'duty.due',
    text: (l) => ({
      title: t(l, 'duty.dueTitle', { name: titleName(d.name), service: titleName(s.name), count: days }),
      body: t(l, 'duty.dueBody', { name: d.name, service: s.name, level: level(l, d.level), period: e.period.key, date: lastDay(l, e.period.end, tz) }),
    }),
    link: `/duties/${d.id}`,
    recipients: users,
    inAppKey: `duty:${d.id}:${e.period.key}:due`,
    externalKey: `duty:${d.id}:${e.period.key}:due`,
    data: { dutyId: d.id, serviceId: s.id, periodKey: e.period.key, level: d.level, periodEnd: iso(e.period.end) },
  });
}

function sendMissed(d: DutyRow, s: ServiceRow, r: PeriodRow, users: UserInfo[]): void {
  notify({
    event: 'duty.missed',
    text: (l) => ({
      title: t(l, r.status === 'failed' ? 'duty.failedTitle' : 'duty.missedTitle', {
        name: titleName(r.duty_name),
        service: titleName(s.name),
        period: r.period_key,
      }),
      body: t(l, r.status === 'failed' ? 'duty.failedBody' : 'duty.missedBody', {
        name: r.duty_name,
        service: s.name,
        level: level(l, r.level),
        period: r.period_key,
      }),
    }),
    link: `/duties/${d.id}`,
    recipients: users,
    inAppKey: `duty:${d.id}:${r.period_key}:missed`,
    externalKey: `duty:${d.id}:${r.period_key}:missed`,
    data: { dutyId: d.id, serviceId: s.id, periodKey: r.period_key, status: r.status, level: r.level },
  });
}

export function runDutyJob(now = Date.now()): { closed: number; reminders: number; missed: number } {
  const out = { closed: 0, reminders: 0, missed: 0 };
  if (!vault().unlocked) return out;
  const tz = instanceTimeZone();
  const services = new Map(
    db()
      .all<ServiceRow>('SELECT id, name, owners, archived FROM services')
      .map((s) => [s.id, s]),
  );
  const duties = db().all<DutyRow>('SELECT * FROM service_duties ORDER BY id');
  let all: UserInfo[] | null = null;
  const users = (d: DutyRow, s: ServiceRow) => responsibleUsers(d, s, (all ??= listUsers().filter((u) => u.active)));
  for (const d of duties) {
    const s = services.get(d.service_id);
    if (!s) continue;
    try {
      out.closed += persistDuty(d, s, now, tz).length;
      if (d.archived || s.archived || d.remind_days <= 0) continue;
      for (const e of evaluateDuty(d, now, tz)) {
        if (e.closed || e.status !== 'due' || now >= e.period.end || now < addLocalDays(e.period.end, -d.remind_days, tz)) continue;
        if (!claim(d.id, e.period.key, 'due')) continue;
        const to = users(d, s);
        sendDue(d, s, e, to, now, tz);
        audit({
          actor: 'system',
          action: 'duty.reminder_sent',
          entityType: 'duty',
          entityId: d.id,
          summary: `Reminder for duty "${d.name}" (period ${e.period.key}) sent to ${to.map((x) => x.username).join(', ') || 'nobody'}`,
          details: { periodKey: e.period.key, kind: 'due', users: to.map((x) => x.username) },
        });
        out.reminders++;
      }
    } catch (err) {
      logger.warn({ err, dutyId: d.id }, 'duty job failed for a duty');
    }
  }
  const byId = new Map(duties.map((d) => [d.id, d]));
  for (const r of db().all<PeriodRow>(
    "SELECT * FROM duty_periods WHERE closed_at IS NOT NULL AND status IN ('missed', 'failed') AND level <> 'optional' AND grace_end >= ? ORDER BY grace_end",
    iso(now - MISSED_WITHIN_DAYS * DAY),
  )) {
    const d = byId.get(r.duty_id);
    const s = d && services.get(d.service_id);
    if (!d || !s || !claim(d.id, r.period_key, 'missed')) continue;
    try {
      const to = users(d, s);
      sendMissed(d, s, r, to);
      audit({
        actor: 'system',
        action: 'duty.reminder_sent',
        entityType: 'duty',
        entityId: d.id,
        summary: `"${r.status}" message for duty "${r.duty_name}" (period ${r.period_key}) sent to ${to.map((x) => x.username).join(', ') || 'nobody'}`,
        details: { periodKey: r.period_key, kind: 'missed', status: r.status, users: to.map((x) => x.username) },
      });
      out.missed++;
    } catch (err) {
      logger.warn({ err, dutyId: d.id }, 'duty "missed" message could not be sent');
    }
  }
  return out;
}
