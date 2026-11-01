import type { Credential, CredentialDue, Locale, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso } from '../util.js';
import { runAs } from '../auth/context.js';
import { listTeams, listUsers } from '../auth/users.js';
import { notify, titleName } from '../notifications/service.js';
import { formatDateTime, t } from '../i18n/index.js';
import { addEvent, reminderSettings, toCredential, type CredentialRow } from './service.js';

/**
 * Reminders for expiry, rotation and review dates of the credentials register.
 *
 * Before a due date the reminder for the smallest threshold reached is sent once
 * (e.g. 30, 14, 7, 1 days before; an entry added 5 days before its date gets the
 * 7-day reminder, not three at once). After the date an overdue reminder is sent
 * every N days. Every reminder is claimed in credential_reminders under a key
 * that contains the due date, so it is sent at most once – also across restarts –
 * and a new due date (rotated, renewed) re-arms the thresholds.
 *
 * Recipients: the Steward users and team members listed as owners (in-app and
 * e-mail per their settings), and the owners' e-mail addresses (e-mail only, when
 * SMTP is configured, the event is routed to e-mail and the address's domain is
 * allowed – see notifications/domains.ts). Entries without any owner remind the
 * administrators.
 */

const DAY = 86400000;

export interface PlannedReminder {
  key: string;
  phase: 'before' | 'overdue' | 'expired';
  /** before: days left; after: days over */
  days: number;
}

/** The reminder that is due now for one due date, or null. */
export function plannedReminder(due: CredentialDue, cfg: { daysBefore: number[]; overdueEveryDays: number }, now: number): PlannedReminder | null {
  const t0 = Date.parse(due.dueAt);
  const day = due.dueAt.slice(0, 10);
  if (t0 > now) {
    const left = Math.ceil((t0 - now) / DAY);
    const reached = cfg.daysBefore.filter((d) => left <= d);
    if (!reached.length) return null;
    const threshold = Math.min(...reached);
    return { key: `${due.kind}:${day}:before:${threshold}`, phase: 'before', days: left };
  }
  const over = Math.floor((now - t0) / DAY);
  const n = cfg.overdueEveryDays > 0 ? Math.floor(over / cfg.overdueEveryDays) : 0;
  return { key: `${due.kind}:${day}:${due.kind === 'expiry' ? 'expired' : 'overdue'}:${n}`, phase: due.kind === 'expiry' ? 'expired' : 'overdue', days: over };
}

/** Claims a reminder; true when it was not sent before. */
function claim(credentialId: string, key: string): boolean {
  return (
    db().run('INSERT INTO credential_reminders (credential_id, reminder_key, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', credentialId, key, nowIso())
      .changes === 1
  );
}

function recipientsOf(c: Credential): { users: UserInfo[]; emails: string[] } {
  const all = listUsers().filter((u) => u.active);
  const teams = listTeams();
  const ids = new Set<string>();
  for (const s of c.ownerSubjects) {
    const [kind, name] = [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1).toLowerCase()];
    if (kind === 'user') all.filter((u) => u.username.toLowerCase() === name).forEach((u) => ids.add(u.id));
    if (kind === 'team') {
      const team = teams.find((x) => x.name.toLowerCase() === name);
      for (const m of team?.members ?? []) all.filter((u) => u.id === m || u.username.toLowerCase() === m.toLowerCase()).forEach((u) => ids.add(u.id));
    }
  }
  const emails = c.owners.map((o) => o.email);
  let users = all.filter((u) => ids.has(u.id));
  if (!users.length && !emails.length) users = all.filter((u) => u.roles.includes('admin'));
  return { users, emails };
}

function text(l: Locale, c: Credential, due: CredentialDue, r: PlannedReminder): { title: string; body: string } {
  const kind = t(l, `credentialDue.kinds.${due.kind}` as never);
  const vars = {
    name: c.name,
    kind,
    type: t(l, `credentialDue.types.${c.type}` as never),
    platform: c.platformName || c.platformText ? `, ${c.platformName ?? c.platformText}` : '',
    date: formatDateTime(l, due.dueAt),
  };
  // the subject carries the name only quoted and capped (it is written by whoever edits the entry)
  const tv = { ...vars, name: titleName(c.name) };
  const title =
    r.phase === 'before'
      ? t(l, 'credentialDue.titleBefore', { ...tv, count: r.days })
      : r.phase === 'expired'
        ? t(l, 'credentialDue.titleExpired', tv)
        : t(l, 'credentialDue.titleOverdue', tv);
  const lines = [
    r.phase === 'before'
      ? t(l, 'credentialDue.bodyBefore', vars)
      : r.phase === 'expired'
        ? t(l, 'credentialDue.bodyExpired', vars)
        : t(l, 'credentialDue.bodyOverdue', vars),
  ];
  if (c.location.text) lines.push(t(l, 'credentialDue.location', { location: c.location.text.slice(0, 300) }));
  if (c.owners.length) lines.push(t(l, 'credentialDue.owners', { owners: c.owners.map((o) => (o.role ? `${o.email} (${o.role})` : o.email)).join(', ') }));
  return { title, body: lines.join('\n') };
}

/** Checks every entry and sends the reminders that are due. Returns the number sent. */
export function checkCredentialReminders(now = Date.now()): number {
  // While the vault is locked nothing can be e-mailed; claiming now would lose the reminder.
  if (!vault().unlocked) return 0;
  const settings = reminderSettings();
  if (!settings.enabled) return 0;
  const rows = db().all<CredentialRow>('SELECT * FROM credentials WHERE archived = 0');
  let sent = 0;
  for (const row of rows) {
    // computed without a user: link labels are not needed for the message
    const c = runAs(null, () => toCredential(row, null, now, settings));
    if (c.reminders?.disabled) continue;
    const cfg = { daysBefore: c.reminders?.daysBefore ?? settings.daysBefore, overdueEveryDays: c.reminders?.overdueEveryDays ?? settings.overdueEveryDays };
    for (const due of c.dues) {
      const r = plannedReminder(due, cfg, now);
      if (!r || !claim(c.id, r.key)) continue;
      // smaller thresholds already passed count as sent as well (no burst of older reminders)
      if (r.phase === 'before') for (const d of cfg.daysBefore.filter((x) => x > r.days)) claim(c.id, `${due.kind}:${due.dueAt.slice(0, 10)}:before:${d}`);
      const { users, emails } = recipientsOf(c);
      try {
        notify({
          event: 'credential.due',
          text: (l) => text(l, c, due, r),
          link: `/credentials?open=${encodeURIComponent(c.id)}`,
          recipients: users,
          emails,
          about: { kind: 'credential', id: c.id },
          inAppKey: `credential:${c.id}:${r.key}`,
          externalKey: `credential:${c.id}:${r.key}`,
          data: { credentialId: c.id, name: c.name, type: c.type, due: due.kind, dueAt: due.dueAt, phase: r.phase },
        });
        addEvent(c.id, 'reminded', 'system', '', { reminder: r.key, users: users.map((u) => u.username), emails: emails.length });
        sent++;
      } catch (err) {
        logger.warn({ err, credentialId: c.id }, 'credential reminder could not be sent');
      }
    }
  }
  return sent;
}
