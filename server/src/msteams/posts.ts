import { db } from '../db.js';
import { nowIso } from '../util.js';
import { getNotificationSettings } from '../notifications/settings.js';

/** Where decision cards went (ADR 0013 stage 1): the follow-up card with the outcome goes there and nowhere else. */

export type ItemKind = 'task' | 'mcp_request';

/** Remembers that a decision card went to a channel target in Teams format. */
export function recordApprovalPost(kind: ItemKind, id: string, target: string): void {
  db().run('INSERT INTO approval_posts (item_kind, item_id, target, posted_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', kind, id, target, nowIso());
}

/** Channel targets that show cards (JSON webhooks are machines: they get no follow-up card). */
export function isCardTarget(target: string): boolean {
  if (target === 'teams:instance') return true;
  if (target === 'webhook:instance') return getNotificationSettings().webhook.format === 'teams';
  return target.startsWith('team:');
}
