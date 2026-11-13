import { SHARE_REMINDER_DAYS, type Locale, type OwnedKind, type ResourceShare, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso } from '../util.js';
import { runAs } from './context.js';
import { listUsers, toAuthUser } from './users.js';
import { managesShares } from './policy.js';
import { expireShares, heldOn, shareKind } from './shares.js';
import { toShare, type ShareRow } from './share-store.js';
import { notify, titleName } from '../notifications/service.js';
import { formatDay, t } from '../i18n/index.js';

/**
 * The job "shares" (ADR 0033 decision 4): removes shares whose end date has passed (audited as
 * `access.share_expired`) and reminds the Manage holders of an item 7 days before one of its shares ends
 * (`access.share_expiring`). A reminder is claimed on the share (`reminded_at`), so it goes out once – also across
 * restarts; a new end date arms it again (shares.ts). Recipients are the active users who manage the item by the
 * kind's own rights (`ShareKindDef.rights`) – they all may see it; for a kind that is not registered, the
 * administrators.
 */

const DAY = 86_400_000;

function subjectText(l: Locale, subject: string): string {
  const i = subject.indexOf(':');
  const type = subject.slice(0, i);
  const name = subject.slice(i + 1);
  return type === 'team' ? t(l, 'shareExpiry.team', { name }) : type === 'role' ? t(l, 'shareExpiry.role', { name }) : t(l, 'shareExpiry.user', { name });
}

function text(l: Locale, item: string, s: ResourceShare, days: number): { title: string; body: string } {
  const subject = subjectText(l, s.subject);
  const level = t(l, `shareExpiry.levels.${s.level}`);
  return {
    title: t(l, 'shareExpiry.title', { item: titleName(item), subject, count: days }),
    body: [t(l, 'shareExpiry.body', { item, subject, level, date: formatDay(l, s.expiresAt!.slice(0, 10)) }), t(l, 'shareExpiry.hint', { item })].join('\n'),
  };
}

/** Who is reminded of a share of an item: its Manage holders by the kind's rules, else the administrators. */
export function shareReminderRecipients(kind: OwnedKind, id: string, all: UserInfo[]): UserInfo[] {
  const admins = all.filter((u) => u.roles.includes('admin'));
  const def = shareKind(kind);
  if (!def) return admins;
  const managers = all.filter((u) => managesShares(heldOn(def, toAuthUser(u), id)));
  return managers.length ? managers : admins;
}

/** Sends the reminders that are due (shares ending within 7 days, not reminded yet). Returns the number sent. */
export function remindExpiringShares(now: number = Date.now()): number {
  // while the vault is locked nothing can be e-mailed; claiming now would lose the reminder
  if (!vault().unlocked) return 0;
  const rows = db().all<ShareRow>(
    'SELECT * FROM resource_shares WHERE expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ? AND reminded_at IS NULL ORDER BY expires_at LIMIT 500',
    new Date(now).toISOString(),
    new Date(now + SHARE_REMINDER_DAYS * DAY).toISOString(),
  );
  if (!rows.length) return 0;
  const all = listUsers().filter((u) => u.active);
  let sent = 0;
  // one job run: the owning teams, memberships and shares of the decisions are read once
  runAs(null, () => {
    for (const r of rows) {
      const kind = r.kind as OwnedKind;
      const claimed = db().run(
        'UPDATE resource_shares SET reminded_at = ? WHERE kind = ? AND resource_id = ? AND subject = ? AND expires_at = ? AND reminded_at IS NULL',
        nowIso(),
        kind,
        r.resource_id,
        r.subject,
        r.expires_at,
      ).changes;
      if (!claimed) continue;
      const s = toShare(r);
      const def = shareKind(kind);
      const item = def?.name(r.resource_id) ?? `${kind} ${r.resource_id}`;
      const days = Math.max(1, Math.ceil((Date.parse(s.expiresAt!) - now) / DAY));
      try {
        notify({
          event: 'access.share_expiring',
          text: (l) => text(l, item, s, days),
          ...(def ? { link: def.link(r.resource_id) } : {}),
          recipients: shareReminderRecipients(kind, r.resource_id, all),
          about: { kind, id: r.resource_id },
          inAppKey: `share:${kind}:${r.resource_id}:${s.subject}:${s.expiresAt}`,
          externalKey: `share:${kind}:${r.resource_id}:${s.subject}:${s.expiresAt}`,
          data: { kind, id: r.resource_id, subject: s.subject, level: s.level, expiresAt: s.expiresAt, days },
        });
        sent++;
      } catch (err) {
        logger.warn({ err, kind, id: r.resource_id }, 'share reminder could not be sent');
      }
    }
  });
  return sent;
}

/** The job: expired shares removed, reminders sent (asked every 5 minutes). */
export function runShareJob(now: number = Date.now()): { expired: number; reminders: number } {
  const expired = runAs(null, () => expireShares(now));
  const reminders = remindExpiringShares(now);
  return { expired, reminders };
}
