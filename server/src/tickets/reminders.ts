import type { Locale, UserInfo } from '@sm/shared';
import { isTicketOpen } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso, parseJson } from '../util.js';
import { listTeams, listUsers } from '../auth/users.js';
import { notify, titleName } from '../notifications/service.js';
import { formatDateTime, t } from '../i18n/index.js';
import { addTicketEvent, effectiveReminderDays, ticketSettings, type TicketRow } from './service.js';

/**
 * Optional reminder: "remind the responsible people when an open ticket was not
 * checked for N days" (off by default; a global default in the settings, or per
 * entry). The clock starts at the last check (marking it checked, or changing
 * its status) or, for an entry never checked, when it was added to Steward.
 * After N days one reminder is sent, then again every N days until somebody
 * checks it. Each reminder is claimed in ticket_ref_reminders under a key that
 * contains the start of the clock, so it goes out at most once – also across
 * restarts – and a check re-arms it.
 *
 * Recipients: the responsible users and the members of the responsible teams
 * (in-app and e-mail per their settings); without anyone responsible, the
 * person who added the entry.
 */

const DAY = 86400000;

/** The reminder due now, or null. */
export function plannedTicketReminder(r: Pick<TicketRow, 'last_checked_at' | 'created_at'>, days: number, now: number): { key: string; days: number } | null {
  const base = r.last_checked_at ?? r.created_at;
  const elapsed = Math.floor((now - Date.parse(base)) / DAY);
  if (elapsed < days) return null;
  const n = Math.floor(elapsed / days);
  return { key: `unchecked:${base}:${n}`, days: elapsed };
}

function claim(ticketId: string, key: string): boolean {
  return (
    db().run('INSERT INTO ticket_ref_reminders (ticket_id, reminder_key, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', ticketId, key, nowIso()).changes ===
    1
  );
}

/** Active users behind a list of user:/team: subjects. */
export function usersOfSubjects(subjects: string[], all: UserInfo[] = listUsers().filter((u) => u.active)): UserInfo[] {
  const teams = listTeams();
  const ids = new Set<string>();
  for (const s of subjects) {
    const i = s.indexOf(':');
    const kind = s.slice(0, i);
    const name = s.slice(i + 1).toLowerCase();
    if (kind === 'user') all.filter((u) => u.username.toLowerCase() === name).forEach((u) => ids.add(u.id));
    if (kind === 'team') {
      const team = teams.find((x) => x.name.toLowerCase() === name);
      for (const m of team?.members ?? []) all.filter((u) => u.id === m || u.username.toLowerCase() === m.toLowerCase()).forEach((u) => ids.add(u.id));
    }
  }
  return all.filter((u) => ids.has(u.id));
}

function text(l: Locale, r: TicketRow, days: number): { title: string; body: string } {
  const vars = { number: titleName(r.external_number, 60), title: r.title, count: days };
  const lines = [
    t(l, 'ticketUnchecked.body', { number: r.external_number, title: r.title, status: t(l, `ticketStatus.${r.status}` as never), count: days }),
    t(l, 'ticketUnchecked.since', { date: formatDateTime(l, r.last_checked_at ?? r.created_at) }),
  ];
  if (r.vendor) lines.push(t(l, 'ticketUnchecked.vendor', { vendor: r.vendor }));
  if (r.external_url) lines.push(r.external_url);
  return { title: t(l, 'ticketUnchecked.title', vars), body: lines.join('\n') };
}

/** Checks every open entry and sends the reminders that are due. Returns the number sent. */
export function checkTicketReminders(now = Date.now()): number {
  // While the vault is locked nothing can be e-mailed; claiming now would lose the reminder.
  if (!vault().unlocked) return 0;
  const settings = ticketSettings();
  const rows = db().all<TicketRow>("SELECT * FROM ticket_refs WHERE status IN ('open', 'waitingVendor', 'waitingUs')");
  let sent = 0;
  const all = listUsers().filter((u) => u.active);
  for (const r of rows) {
    if (!isTicketOpen(r.status)) continue;
    const days = effectiveReminderDays(r, settings);
    if (!days) continue;
    const plan = plannedTicketReminder(r, days, now);
    if (!plan || !claim(r.id, plan.key)) continue;
    let users = usersOfSubjects(parseJson<string[]>(r.responsible, []), all);
    if (!users.length) users = all.filter((u) => u.username.toLowerCase() === r.created_by.toLowerCase());
    try {
      notify({
        event: 'ticket.unchecked',
        text: (l) => text(l, r, plan.days),
        link: `/tickets/${encodeURIComponent(r.id)}`,
        recipients: users,
        inAppKey: `ticket:${r.id}:${plan.key}`,
        externalKey: `ticket:${r.id}:${plan.key}`,
        data: { ticketId: r.id, number: r.external_number, source: r.source, status: r.status, daysUnchecked: plan.days },
      });
      addTicketEvent(r.id, 'reminded', 'system', { details: { reminder: plan.key, users: users.map((u) => u.username) } });
      sent++;
    } catch (err) {
      logger.warn({ err, ticketId: r.id }, 'ticket reminder could not be sent');
    }
  }
  return sent;
}
