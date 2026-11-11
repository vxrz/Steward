import { fiscalYearMonths, fiscalYearOf, moneyText, shiftMonth, type Locale, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso, parseJson } from '../util.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { visibleContracts } from '../suppliers/links.js';
import { owningTeams } from '../auth/policy.js';
import { notify, titleName } from '../notifications/service.js';
import { optedIn } from '../notifications/opt-ins.js';
import { t } from '../i18n/index.js';
import { usersOfSubjects } from '../tickets/reminders.js';
import { lineMonths, lineTitle, startMonth, today, type LineRow } from './plans.js';
import { scopeInfo } from './access.js';

/**
 * The reminder "contract payments not booked" (0.18.0, ADR 0030, event `cost.booking_due`): off by default, opted in
 * per person (Profile → Notifications). On the third day of a month, to the owners of a service who opted in, the
 * payments of the previous month of its contract lines (lines made from a payment schedule) that have no entry on
 * their line yet – one message per service, at most once a month (claimed in cost_booking_reminders). Steward never
 * books on its own: the reminder points at what a person may want to book.
 *
 * 0.19.0 (ADR 0032): the same for a platform's own cost plan – to who manages the platform or is a member of its owning
 * teams and opted in; claimed with the platform's id in cost_booking_reminders.service_id.
 */

interface Missing {
  /** The line's own title (a schedule's line: the schedule's title) */
  title: string;
  scheduleId: string | null;
  contractId: string | null;
  amount: number;
  currency: string;
}

function claim(serviceId: string, month: string): boolean {
  return (
    db().run('INSERT INTO cost_booking_reminders (service_id, month, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', serviceId, month, nowIso()).changes ===
    1
  );
}

/** The service's owners (named users and the members of named and owning teams). */
function ownersOf(serviceId: string, owners: string, all: UserInfo[]): UserInfo[] {
  const subjects = [...parseJson<string[]>(owners, []), ...owningTeams('service', serviceId).map((x) => `team:${x.name}`)];
  return usersOfSubjects(subjects, all);
}

/**
 * The message in one language. A recipient reads each line's title with the contract's title in front when they may
 * see the contract (plans.ts lineTitle, security review 0.18.0 M6); channel posts (no recipient) get the lines' own
 * titles only.
 */
function text(l: Locale, service: string, month: string, missing: Missing[], recipient?: UserInfo): { title: string; body: string } {
  const contracts = recipient
    ? visibleContracts(
        missing.map((m) => m.contractId),
        toAuthUser(recipient),
      )
    : new Map<string, { title: string }>();
  return {
    title: t(l, 'costBooking.title', { service: titleName(service), month, count: missing.length }),
    body: [
      t(l, 'costBooking.body', { service, month, count: missing.length }),
      ...missing.map(
        (m) =>
          `• ${lineTitle({ title: m.title, schedule_id: m.scheduleId, supplier_contract_id: m.contractId }, contracts)}: ${moneyText(m.amount, m.currency)}`,
      ),
      t(l, 'costBooking.hint'),
    ].join('\n'),
  };
}

/** Sends the reminders that are due (from the third day of a month, for the month before). Returns the number sent. */
export function checkBookingReminders(now = Date.now()): number {
  // while the vault is locked nothing can be e-mailed; claiming now would lose the reminder
  if (!vault().unlocked) return 0;
  const day = today(now);
  if (Number(day.slice(8, 10)) < 3) return 0;
  const opted = optedIn('cost.booking_due');
  if (!opted.size) return 0;
  const month = shiftMonth(day.slice(0, 7), -1);
  const start = startMonth();
  const fy = fiscalYearOf(month, start);
  const index = fiscalYearMonths(fy, start).indexOf(month);
  const lines = db().all<LineRow & { owners: string; service_name: string }>(
    `SELECT l.*, s.owners AS owners, s.name AS service_name FROM cost_plan_lines l JOIN services s ON s.id = l.service_id
      WHERE l.fiscal_year = ? AND l.schedule_id IS NOT NULL AND s.archived = 0
        AND NOT EXISTS (SELECT 1 FROM cost_booking_reminders r WHERE r.service_id = l.service_id AND r.month = ?)
      ORDER BY l.service_id, l.title`,
    fy,
    month,
  );
  // a platform's own plan (0.19.0): its owners are its managers and the members of its owning teams
  const platformLines = db().all<LineRow & { service_name: string }>(
    `SELECT l.*, p.name AS service_name FROM cost_plan_lines l JOIN platforms p ON p.id = l.platform_id
      WHERE l.fiscal_year = ? AND l.schedule_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cost_booking_reminders r WHERE r.service_id = l.platform_id AND r.month = ?)
      ORDER BY l.platform_id, l.title`,
    fy,
    month,
  );
  if (!lines.length && !platformLines.length) return 0;
  const booked = new Set(
    db()
      .all<{ plan_line_id: string }>(
        `SELECT DISTINCT plan_line_id FROM cost_entries WHERE plan_line_id IS NOT NULL AND entry_date >= ? AND entry_date <= ?`,
        `${month}-01`,
        `${month}-31`,
      )
      .map((r) => r.plan_line_id),
  );
  const byService = new Map<string, { name: string; owners: string; platform: boolean; missing: Missing[] }>();
  for (const l of [...lines, ...platformLines.map((x) => ({ ...x, owners: '[]' }))]) {
    const amount = lineMonths(l)[index] ?? 0;
    if (!amount || booked.has(l.id)) continue;
    const ownerId = l.platform_id || l.service_id;
    const s = byService.get(ownerId) ?? { name: l.service_name, owners: l.owners, platform: !!l.platform_id, missing: [] };
    s.missing.push({ title: l.title, scheduleId: l.schedule_id, contractId: l.supplier_contract_id, amount, currency: l.currency });
    byService.set(ownerId, s);
  }
  const all = listUsers().filter((u) => u.active);
  let sent = 0;
  for (const [serviceId, s] of byService) {
    const owners = s.platform ? all.filter((u) => !!scopeInfo('platform', serviceId, toAuthUser(u))?.owner) : ownersOf(serviceId, s.owners, all);
    const recipients = owners.filter((u) => opted.has(u.id));
    // nobody of the owners opted in (yet): nothing is claimed, so one who opts in later this month still gets it
    if (!recipients.length || !claim(serviceId, month)) continue;
    try {
      notify({
        event: 'cost.booking_due',
        text: (l, recipient) => text(l, s.name, month, s.missing, recipient),
        personal: true,
        link: s.platform ? `/platforms/${encodeURIComponent(serviceId)}?tab=costPlan` : `/services/${encodeURIComponent(serviceId)}/costs`,
        recipients,
        about: { kind: s.platform ? 'platform' : 'service', id: serviceId },
        inAppKey: `cost.booking_due:${serviceId}:${month}`,
        externalKey: `cost.booking_due:${serviceId}:${month}`,
        data: { serviceId, service: s.name, month, payments: s.missing.length },
      });
      sent++;
    } catch (err) {
      logger.warn({ err, serviceId }, 'booking reminder could not be sent');
    }
  }
  return sent;
}
