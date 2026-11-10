import type { UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso } from '../util.js';
import { listUsers } from '../auth/users.js';
import { defaultLocale, setBotDelivery, userLocale } from '../notifications/service.js';
import { registerOutboxTarget } from '../notifications/outbox.js';
import { effectiveNotificationPrefs } from '../notifications/prefs.js';
import { teamsCard } from '../notifications/channels.js';
import { aadObjectIdOf } from './identity.js';
import { teamsDecidable, versionOf, type ItemKind } from './decide.js';
import { asAttachment, itemCard } from './botcard.js';
import { sendActivity, updateActivity } from './connector.js';
import { botActive, botConfig } from './settings.js';
import { setBotCardUpdater } from './followup.js';
import { personalChat, postNotice, wantsNotice } from './personal.js';

/**
 * Posting through the bot (ADR 0013 stage 2b, preview). With the bot on, decision cards – and only those – go through
 * the bot: to a channel target's conversation when the administrator picked one (instead of its webhook), and to the
 * personal chat of each decider who installed the app (`teamsChat:<userId>`, with their quiet hours, ADR 0012). A
 * channel card shows the status and Open to everyone; `refresh.userIds` lists the eligible deciders (at most 60), who
 * see their own buttons. When the decision is made, Steward updates its cards for everyone (teams_cards). Since 0.15.0
 * (ADR 0025) the personal chat also takes the other messages a person chose (personal.ts).
 */

interface Conversation {
  id: string;
  conversation_id: string;
  service_url: string;
  kind: string;
  user_id: string | null;
}

const activeConversation = (id: string) =>
  db().get<Conversation>('SELECT id, conversation_id, service_url, kind, user_id FROM teams_conversations WHERE id = ? AND removed_at IS NULL', id);
/** The person's chat: an allowed tenant, still linked to the Entra object id it was recorded for (ADR 0025) */
const personalConversation = (u: UserInfo | undefined): Conversation | undefined => personalChat(u);

/** The Entra object ids of the people who may decide an item in a card now (for the card's refresh list, at most 60). */
const eligibleCache = new Map<string, { at: number; ids: string[] }>();

export function eligibleAadIds(kind: ItemKind, id: string): string[] {
  // refreshes of one card come in bursts: one computation per item and version a minute
  const key = `${kind}|${id}|${versionOf(kind, id) ?? ''}`;
  const hit = eligibleCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.ids;
  const ids = computeEligible(kind, id);
  if (eligibleCache.size > 2000) eligibleCache.clear();
  eligibleCache.set(key, { at: Date.now(), ids });
  return ids;
}

function computeEligible(kind: ItemKind, id: string): string[] {
  const out: string[] = [];
  for (const u of listUsers()) {
    if (out.length >= 60) break;
    if (!u.active) continue;
    const oid = aadObjectIdOf(u);
    if (oid && teamsDecidable(u, kind, id).ok) out.push(oid);
  }
  return out;
}

function remember(kind: ItemKind, id: string, conv: Conversation, activityId: string | undefined): void {
  if (!activityId) return;
  db().run(
    `INSERT INTO teams_cards (item_kind, item_id, conversation_id, activity_id, version, posted_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_kind, item_id, conversation_id) DO UPDATE SET activity_id = excluded.activity_id, version = excluded.version, posted_at = excluded.posted_at`,
    kind,
    id,
    conv.id,
    activityId,
    versionOf(kind, id) ?? '',
    nowIso(),
  );
}

async function postToChannel(target: string, item: { kind: ItemKind; id: string }): Promise<void> {
  const conv = activeConversation(botConfig().channels[target] ?? '');
  if (!conv) throw new Error('The bot is no longer in the chosen conversation');
  const card = itemCard(defaultLocale(), item.kind, item.id, { viewer: null, refreshFor: eligibleAadIds(item.kind, item.id) });
  const r = await sendActivity(conv.service_url, conv.conversation_id, { type: 'message', attachments: [asAttachment(card)] });
  remember(item.kind, item.id, conv, r.id);
}

async function postToPerson(u: UserInfo, item: { kind: ItemKind; id: string }): Promise<void> {
  const conv = personalConversation(u);
  if (!conv) return;
  const card = itemCard(userLocale(u), item.kind, item.id, { viewer: u, personal: true });
  const r = await sendActivity(conv.service_url, conv.conversation_id, { type: 'message', attachments: [asAttachment(card)] });
  remember(item.kind, item.id, conv, r.id);
}

/** Updates every card the bot posted for an item (the outcome, for everyone). */
async function updateCards(kind: ItemKind, id: string): Promise<void> {
  const rows = db().all<Conversation & { activity_id: string }>(
    `SELECT c.id, c.conversation_id, c.service_url, c.kind, c.user_id, k.activity_id FROM teams_cards k JOIN teams_conversations c ON c.id = k.conversation_id
     WHERE k.item_kind = ? AND k.item_id = ? AND c.removed_at IS NULL`,
    kind,
    id,
  );
  for (const r of rows) {
    const viewer = r.user_id ? listUsers().find((u) => u.id === r.user_id) : null;
    const card = itemCard(viewer ? userLocale(viewer) : defaultLocale(), kind, id, { viewer, personal: r.kind === 'personal' });
    try {
      await updateActivity(r.service_url, r.conversation_id, r.activity_id, { type: 'message', id: r.activity_id, attachments: [asAttachment(card)] });
      db().run('UPDATE teams_cards SET version = ? WHERE item_kind = ? AND item_id = ? AND conversation_id = ?', versionOf(kind, id) ?? '', kind, id, r.id);
    } catch (err) {
      logger.warn({ err: { message: (err as Error).message }, conversation: r.id }, 'Teams bot: a card could not be updated');
    }
  }
}

let wired = false;
/** Connects the bot to the notifications (idempotent): only while it is on does it take decision cards. */
export function wireBotDelivery(): void {
  if (wired) return;
  wired = true;
  setBotDelivery({
    covers: (target) => botActive() && !!activeConversation(botConfig().channels[target] ?? ''),
    postChannel: postToChannel,
    hasPersonal: (u) => botActive() && !!personalConversation(u),
    postPersonal: postToPerson,
    wantsNotice,
    postNotice,
  });
  setBotCardUpdater(async (kind, id) => {
    if (botActive()) await updateCards(kind, id);
  });
  // held messages of a person's chat with the bot (their quiet hours and – for the messages they chose, ADR 0025 –
  // their digests) are released there as one card
  registerOutboxTarget('teamsChat', (userId) => {
    const u = listUsers().find((x) => x.id === userId);
    const conv = u?.active && botActive() ? personalConversation(u) : undefined;
    const prefs = effectiveNotificationPrefs(userId).prefs;
    return {
      personal: true,
      user: u,
      quietHours: prefs.quietHours,
      digests: prefs.digests,
      send: conv
        ? async (m) => {
            await sendActivity(conv.service_url, conv.conversation_id, teamsCard(m));
          }
        : null,
      why: conv ? undefined : 'no chat',
    };
  });
}
