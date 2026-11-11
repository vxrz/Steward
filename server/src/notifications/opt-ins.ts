import { z } from 'zod';
import { NOTIFICATION_OPT_IN_EVENTS, type NotificationOptInEvent, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { nowIso } from '../util.js';

/**
 * Notifications a person turns on for themselves (0.18.0, ADR 0030): events that are off by default
 * (NOTIFICATION_OPT_IN_EVENTS, such as `cost.booking_due`) reach only who opted in under Profile → Notifications. The
 * instance's routes still decide the channels; no step-up – it only reaches oneself; audited.
 */

export const notificationOptInsInput = z.object({ events: z.array(z.enum(NOTIFICATION_OPT_IN_EVENTS)).max(NOTIFICATION_OPT_IN_EVENTS.length) }).strict();

export interface NotificationOptIns {
  /** The events that can be turned on */
  offered: NotificationOptInEvent[];
  /** Those the person turned on */
  events: NotificationOptInEvent[];
}

export function optInsOf(userId: string): NotificationOptIns {
  const on = new Set(
    db()
      .all<{ event: string }>('SELECT event FROM notification_opt_ins WHERE user_id = ?', userId)
      .map((r) => r.event),
  );
  return { offered: [...NOTIFICATION_OPT_IN_EVENTS], events: NOTIFICATION_OPT_IN_EVENTS.filter((e) => on.has(e)) };
}

/** The ids of the users who turned an event on. */
export function optedIn(event: NotificationOptInEvent): Set<string> {
  return new Set(
    db()
      .all<{ user_id: string }>('SELECT user_id FROM notification_opt_ins WHERE event = ?', event)
      .map((r) => r.user_id),
  );
}

export function saveOptIns(u: UserInfo, body: unknown): NotificationOptIns {
  const x = notificationOptInsInput.parse(body ?? {});
  const before = optInsOf(u.id).events;
  const next = NOTIFICATION_OPT_IN_EVENTS.filter((e) => x.events.includes(e));
  if (before.join() === next.join()) return optInsOf(u.id);
  db().tx(() => {
    db().run('DELETE FROM notification_opt_ins WHERE user_id = ?', u.id);
    for (const e of next) db().run('INSERT INTO notification_opt_ins (user_id, event, created_at) VALUES (?, ?, ?)', u.id, e, nowIso());
    audit({
      action: 'notification.opt_ins_changed',
      entityType: 'user',
      entityId: u.id,
      summary: `${u.username} ${next.length ? `turned on ${next.join(', ')}` : 'turned the optional notifications off'}`,
      details: { from: before, to: next },
    });
  });
  return optInsOf(u.id);
}
