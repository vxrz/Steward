import type { Locale, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso } from '../util.js';
import { listUsers } from '../auth/users.js';
import { t, type MessageKey } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import type { DutyRow, Evaluated, PeriodRow } from './evaluate.js';
import { persistDuty, type ServiceRef } from './store.js';
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

type ServiceRow = ServiceRef;

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
      const { periods, closed } = persistDuty(d, s, now, tz);
      out.closed += closed.length;
      if (d.archived || s.archived || d.remind_days <= 0) continue;
      for (const e of periods) {
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
