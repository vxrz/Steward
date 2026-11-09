import { NOTIFICATION_DECISION_EVENTS, type AppNotification, type NotificationEvent } from '@sm/shared';
import { db } from '../db.js';
import { HttpError, newId, nowIso } from '../util.js';

interface NotificationRow {
  id: string;
  user_id: string;
  ts: string;
  event: NotificationEvent;
  title: string;
  body: string;
  link: string | null;
  read: number;
  dedupe_key: string | null;
}

const toNotification = (r: NotificationRow): AppNotification => ({
  id: r.id,
  ts: r.ts,
  event: r.event,
  title: r.title,
  body: r.body,
  link: r.link ?? undefined,
  read: !!r.read,
});

/** Stores an in-app notification unless the user got one with the same key within `windowMs`. */
export function addInApp(
  userId: string,
  n: { event: NotificationEvent; title: string; body: string; link?: string; dedupeKey?: string },
  windowMs: number,
): boolean {
  if (n.dedupeKey) {
    const since = new Date(Date.now() - windowMs).toISOString();
    if (db().get('SELECT 1 FROM notifications WHERE user_id = ? AND dedupe_key = ? AND ts > ?', userId, n.dedupeKey, since)) return false;
  }
  db().run(
    'INSERT INTO notifications (id, user_id, ts, event, title, body, link, read, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
    newId('ntf_'),
    userId,
    nowIso(),
    n.event,
    n.title,
    n.body,
    n.link ?? null,
    n.dedupeKey ?? null,
  );
  return true;
}

export function listInApp(userId: string, limit = 50): { items: AppNotification[]; unread: number } {
  const rows = db().all<NotificationRow>(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?',
    userId,
    Math.min(Math.max(limit, 1), 500),
  );
  // unread decision requests stay in the list however many alerts came after them (U9 of the 0.10 review)
  const seen = new Set(rows.map((r) => r.id));
  const marks = NOTIFICATION_DECISION_EVENTS.map(() => '?').join(', ');
  const waiting = db()
    .all<NotificationRow>(
      `SELECT * FROM notifications WHERE user_id = ? AND read = 0 AND event IN (${marks}) ORDER BY ts DESC, rowid DESC LIMIT 100`,
      userId,
      ...NOTIFICATION_DECISION_EVENTS,
    )
    .filter((r) => !seen.has(r.id));
  const items = [...rows, ...waiting].map(toNotification);
  const unread = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', userId)!.n;
  return { items, unread };
}

export function markRead(userId: string, id: string): void {
  const r = db().run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', id, userId);
  if (!r.changes && !db().get('SELECT 1 FROM notifications WHERE id = ? AND user_id = ?', id, userId)) {
    throw new HttpError(404, 'Notification not found');
  }
}

/** Marks every unread notification of the user read – or only those of the given events (a group in the bell). */
export function markAllRead(userId: string, events?: readonly string[]): void {
  if (events?.length)
    db().run(`UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0 AND event IN (${events.map(() => '?').join(', ')})`, userId, ...events);
  else db().run('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0', userId);
}

/** Retention: read notifications older than `days`. */
export function deleteReadOlderThan(days: number): number {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return db().run('DELETE FROM notifications WHERE read = 1 AND ts < ?', cutoff).changes;
}

/**
 * External sends are de-duplicated per channel + event + entity: returns true
 * (and records the send) when nothing was sent for `key` within `windowMs`.
 */
export function claimSend(key: string, windowMs: number): boolean {
  const now = Date.now();
  return db().tx(() => {
    const r = db().get<{ sent_at: string }>('SELECT sent_at FROM notification_sends WHERE key = ?', key);
    if (r && now - Date.parse(r.sent_at) < windowMs) return false;
    db().run(
      'INSERT INTO notification_sends (key, sent_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET sent_at = excluded.sent_at',
      key,
      new Date(now).toISOString(),
    );
    if (Math.random() < 0.02) db().run('DELETE FROM notification_sends WHERE sent_at < ?', new Date(now - 86400000).toISOString());
    return true;
  });
}
