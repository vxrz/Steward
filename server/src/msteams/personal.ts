import { TEAMS_PERSONAL_EVENTS, type NotificationEvent, type TeamsPersonalState, type UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { nowIso, parseJson } from '../util.js';
import { getNotificationSettings } from '../notifications/settings.js';
import { teamsCard, type OutgoingMessage } from '../notifications/channels.js';
import { aadObjectIdOf } from './identity.js';
import { BotConnectorError, sendActivity } from './connector.js';
import { botActive, botConfig } from './settings.js';

/**
 * Personal notifications in the chat with the Teams bot (0.15.0, ADR 0025): the events a person chose (nothing by
 * default), the chat Steward may use for them, and the send with retries when the Bot Connector throttles. The texts
 * are those of the person's e-mail (notifications/service.ts renders them); quiet hours and digests apply there too.
 */

export interface PersonalChat {
  id: string;
  conversation_id: string;
  service_url: string;
  kind: string;
  user_id: string | null;
  installed_at: string;
}

/**
 * The person's chat with the bot that may be used now: active account, an allowed tenant, and still linked through the
 * bot's sign-in provider – to the Entra object id the chat was recorded for (chats recorded before 0.15.0 have none).
 */
export function personalChat(u: UserInfo | undefined): PersonalChat | undefined {
  if (!u?.active) return undefined;
  const oid = aadObjectIdOf(u)?.toLowerCase();
  if (!oid) return undefined;
  const tenants = botConfig().tenantIds;
  return db()
    .all<PersonalChat & { tenant_id: string; aad_object_id: string | null }>(
      `SELECT id, conversation_id, service_url, kind, user_id, installed_at, tenant_id, aad_object_id FROM teams_conversations
       WHERE user_id = ? AND kind = 'personal' AND removed_at IS NULL ORDER BY installed_at DESC`,
      u.id,
    )
    .find((r) => tenants.includes(r.tenant_id) && (!r.aad_object_id || r.aad_object_id.toLowerCase() === oid));
}

// ---------- the person's choice ----------

/** The events a person chose for their chat (nothing by default). */
export function chosenEvents(userId: string): NotificationEvent[] {
  const r = db().get<{ teams: string }>('SELECT teams FROM notification_personal_channels WHERE user_id = ?', userId);
  const list = parseJson<unknown>(r?.teams, []);
  return Array.isArray(list) ? TEAMS_PERSONAL_EVENTS.filter((e) => list.includes(e)) : [];
}

/** The events that can be chosen now: those the instance routes to e-mail (Teams (personal) goes where e-mail goes). */
export function offeredEvents(): NotificationEvent[] {
  const routes = getNotificationSettings().routes;
  return TEAMS_PERSONAL_EVENTS.filter((e) => (routes[e] ?? []).includes('email'));
}

export function teamsPersonalState(u: UserInfo): TeamsPersonalState {
  const chat = botActive() ? personalChat(u) : undefined;
  return {
    available: botActive(),
    connected: !!chat,
    connectedSince: chat?.installed_at ?? null,
    notLinked: !aadObjectIdOf(u),
    events: chosenEvents(u.id),
    offered: offeredEvents(),
  };
}

/** Saves the person's choice (audited: before and after). */
export function saveTeamsPersonal(u: UserInfo, events: NotificationEvent[]): TeamsPersonalState {
  const before = chosenEvents(u.id);
  const next = TEAMS_PERSONAL_EVENTS.filter((e) => events.includes(e));
  db().tx(() => {
    if (next.length)
      db().run(
        `INSERT INTO notification_personal_channels (user_id, teams, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET teams = excluded.teams, updated_at = excluded.updated_at`,
        u.id,
        JSON.stringify(next),
        nowIso(),
      );
    else db().run('DELETE FROM notification_personal_channels WHERE user_id = ?', u.id);
    if (JSON.stringify(before) !== JSON.stringify(next))
      audit({
        action: 'notification.personal_channel_changed',
        entityType: 'user',
        entityId: u.id,
        summary: `${u.username}'s messages in Teams (personal): ${next.join(', ') || 'none'}`,
        details: { channel: 'teamsPersonal', from: before, to: next },
      });
  });
  return teamsPersonalState(u);
}

/** Whether a person gets this event in their chat now: the bot on, the event chosen, a chat that may be used. */
export const wantsNotice = (u: UserInfo, event: NotificationEvent): boolean => botActive() && chosenEvents(u.id).includes(event) && !!personalChat(u);

// ---------- sending ----------

/** Waits between attempts when the Bot Connector throttles (ADR 0025); tests shorten them. */
let retryDelays = [1000, 2000, 4000];
export function setNoticeRetryDelays(ms: number[]): void {
  retryDelays = ms;
}
const RETRY_AFTER_MAX_S = 30;
const THROTTLED = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The person blocked or removed the bot: the chat is no longer used (audited). Writing to the bot again records it. */
function retire(chat: PersonalChat, u: UserInfo, status: number): void {
  if (db().run('UPDATE teams_conversations SET removed_at = ? WHERE id = ? AND removed_at IS NULL', nowIso(), chat.id).changes)
    audit({
      actor: 'system',
      action: 'teams.conversation_removed',
      entityType: 'settings',
      entityId: 'teams-bot',
      summary: `Teams bot: the personal chat of ${u.username} is no longer used (the Bot Connector answered ${status})`,
      details: { conversation: chat.id, kind: 'personal', user: u.username, reason: 'unreachable', status },
    });
}

/**
 * Sends one card to the person's chat. Throttling (429, 502–504) is retried with backoff, honouring Retry-After up to
 * 30 seconds; 403/404 retire the chat. Rejects with the last error – the caller falls back to e-mail once.
 */
export async function postNotice(u: UserInfo, m: OutgoingMessage): Promise<void> {
  const chat = personalChat(u);
  if (!chat) throw new Error('No chat with the Teams bot');
  const card = teamsCard(m);
  for (let attempt = 0; ; attempt++) {
    try {
      await sendActivity(chat.service_url, chat.conversation_id, card);
      return;
    } catch (err) {
      const status = err instanceof BotConnectorError ? err.status : 0;
      if (status === 403 || status === 404) retire(chat, u, status);
      if (!THROTTLED.has(status) || attempt >= retryDelays.length) throw err;
      const wait = Math.max(retryDelays[attempt]!, Math.min((err as BotConnectorError).retryAfter ?? 0, RETRY_AFTER_MAX_S) * 1000);
      logger.info({ to: u.username, status, attempt: attempt + 1, wait }, 'Teams bot: throttled, trying again');
      await sleep(wait);
    }
  }
}
