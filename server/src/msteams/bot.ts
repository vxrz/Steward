import type { Locale } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { newId, nowIso } from '../util.js';
import { resolveLocale, t } from '../i18n/index.js';
import { absoluteLink } from '../notifications/settings.js';
import { userLocale } from '../notifications/service.js';
import { verifyBotToken, type AuthFailure } from './bot-auth.js';
import { botConfig } from './settings.js';
import { userForTeams } from './identity.js';
import { decideFromTeams, type TeamsOutcome } from './decide.js';
import { asAttachment, checkCardData, itemCard, noticeCard } from './botcard.js';
import { sendActivity } from './connector.js';
import { eligibleAadIds } from './delivery.js';
import { moduleEnabled } from '../modules/registry.js';

/**
 * The bot endpoint `POST /teams/bot/messages` (ADR 0013 stage 2, preview). Served only by the separate listener
 * (listener.ts, SM_TEAMS_BOT_PORT). Cheap, non-revealing checks first, in this order:
 *
 *  1. bot off → 404; body over 64 KB → 413; not JSON → 415;
 *  2. no or bad token → 401 with no detail (bot-auth.ts: key, issuer, audience, expiry, endorsement, serviceUrl);
 *  3. `channelId` msteams, the tenant an allowed one;
 *  4. an activity id seen in the last 24 hours gets the same answer again and changes nothing;
 *  5. rate limits per tenant and per Teams user;
 *  6. vault locked → a card "Steward is locked – try again later".
 *
 * Rejections are audited at most once per reason every 10 minutes (teams.action_refused). The bot handles installation
 * and conversation updates (where it is installed), card actions (approve, reject, refresh) and messages (a short help
 * text with a link) – no chat commands.
 */

export const BOT_BODY_LIMIT = 64 * 1024;
const REPLAY_MS = 24 * 3_600_000;
const AUDIT_EVERY_MS = 10 * 60_000;
const LIMITS = { tenantPerMinute: 300, userPerMinute: 30 };

export interface BotResponse {
  status: number;
  body?: unknown;
}

// ---------- refusals ----------

const lastRefusal = new Map<string, number>();

function refused(reason: string, details: Record<string, unknown> = {}): void {
  const now = Date.now();
  if (now - (lastRefusal.get(reason) ?? 0) < AUDIT_EVERY_MS) return;
  lastRefusal.set(reason, now);
  audit({
    actor: 'system',
    action: 'teams.action_refused',
    entityType: 'settings',
    entityId: 'teams-bot',
    summary: `Teams bot: a call was refused (${reason}); further refusals for this reason within 10 minutes are not audited`,
    details: { reason, ...details },
  });
}

// ---------- rate limits ----------

const windows = new Map<string, { start: number; n: number }>();
function overLimit(key: string, max: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start > 60_000) {
    if (windows.size > 10_000) windows.clear();
    windows.set(key, { start: now, n: 1 });
    return false;
  }
  return ++w.n > max;
}

/** Tests: forget rate-limit windows and audit throttling. */
export function resetBotState(): void {
  windows.clear();
  lastRefusal.clear();
}

// ---------- the activity ----------

interface Activity {
  type?: string;
  id?: string;
  name?: string;
  channelId?: string;
  serviceUrl?: string;
  locale?: string;
  action?: string;
  from?: { id?: string; aadObjectId?: string; name?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; tenantId?: string; conversationType?: string; name?: string };
  channelData?: { tenant?: { id?: string }; channel?: { name?: string }; team?: { name?: string } };
  membersAdded?: { id?: string }[];
  membersRemoved?: { id?: string }[];
  value?: { action?: { type?: string; verb?: string; data?: unknown }; data?: unknown };
}

const str = (v: unknown, max = 512): string => (typeof v === 'string' && v.length <= max ? v : '');

/** The tenant of an activity: both places it can be named must agree. */
function tenantOf(a: Activity): string {
  const x = str(a.conversation?.tenantId, 64).toLowerCase();
  const y = str(a.channelData?.tenant?.id, 64).toLowerCase();
  if (x && y && x !== y) return '';
  return x || y;
}

const localeOf = (a: Activity, fallback?: Locale): Locale => resolveLocale(str(a.locale, 20).slice(0, 2).toLowerCase(), fallback);

export async function handleBotRequest(headers: Record<string, string | string[] | undefined>, raw: string | Buffer | undefined): Promise<BotResponse> {
  const cfg = botConfig();
  // off, or its module switched off (ADR 0016): as if the listener had no route
  if (!cfg.enabled || !moduleEnabled('teamsBot')) return { status: 404 };
  const text = typeof raw === 'string' ? raw : (raw?.toString('utf8') ?? '');
  if (Buffer.byteLength(text) > BOT_BODY_LIMIT) return { status: 413 };
  const type = String(headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  let a: Activity;
  try {
    if (type !== 'application/json') throw new Error('not JSON');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    a = parsed as Activity;
  } catch {
    return { status: 415 };
  }
  const auth = await verifyBotToken(typeof headers.authorization === 'string' ? headers.authorization : undefined, a, cfg.appId);
  if (!auth.ok) {
    refused(auth.reason satisfies AuthFailure);
    return { status: 401 };
  }
  const tenant = tenantOf(a);
  if (a.channelId !== 'msteams' || !tenant || !cfg.tenantIds.includes(tenant)) {
    refused('tenant', { tenantId: tenant || null });
    return { status: 403 };
  }
  const activityId = str(a.id, 256);
  if (activityId) {
    const seen = db().get<{ received_at: string; answer: string | null }>(
      'SELECT received_at, answer FROM teams_bot_activities WHERE activity_id = ?',
      activityId,
    );
    if (seen && Date.now() - Date.parse(seen.received_at) < REPLAY_MS) {
      refused('replay');
      return seen.answer ? (JSON.parse(seen.answer) as BotResponse) : { status: 200, body: {} };
    }
    db().run(
      'INSERT INTO teams_bot_activities (activity_id, received_at) VALUES (?, ?) ON CONFLICT(activity_id) DO UPDATE SET received_at = excluded.received_at, answer = NULL',
      activityId,
      nowIso(),
    );
    if (Math.random() < 0.02) db().run('DELETE FROM teams_bot_activities WHERE received_at < ?', new Date(Date.now() - REPLAY_MS).toISOString());
  }
  const aad = str(a.from?.aadObjectId, 64).toLowerCase();
  if (overLimit(`t:${tenant}`, LIMITS.tenantPerMinute) || (aad && overLimit(`u:${tenant}:${aad}`, LIMITS.userPerMinute))) {
    refused('rateLimit', { tenantId: tenant });
    return { status: 429 };
  }
  const answer = await dispatch(a, tenant, aad);
  if (activityId) db().run('UPDATE teams_bot_activities SET answer = ? WHERE activity_id = ?', JSON.stringify(answer), activityId);
  return answer;
}

async function dispatch(a: Activity, tenant: string, aad: string): Promise<BotResponse> {
  if (a.type === 'invoke' && a.name === 'adaptiveCard/action') return cardAction(a, tenant, aad);
  if (a.type === 'conversationUpdate' || a.type === 'installationUpdate') {
    conversationChanged(a, tenant, aad);
    return { status: 200, body: {} };
  }
  if (a.type === 'message') {
    helpReply(a, tenant, aad);
    return { status: 200, body: {} };
  }
  return { status: 200, body: {} };
}

const invokeCard = (card: unknown): BotResponse => ({ status: 200, body: { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card } });

async function cardAction(a: Activity, tenant: string, aad: string): Promise<BotResponse> {
  const l0 = localeOf(a);
  if (!vault().unlocked) return invokeCard(noticeCard(l0, t(l0, 'teamsBot.locked')));
  const user = userForTeams(tenant, aad);
  const action = a.value?.action;
  const data = checkCardData(action?.data);
  if (!user) {
    refused('notLinked', { tenantId: tenant });
    return invokeCard(noticeCard(l0, t(l0, 'teamsBot.notLinked')));
  }
  const l = localeOf(a, userLocale(user));
  if (!data) {
    refused('badCardData', { user: user.username });
    return invokeCard(noticeCard(l, t(l, 'teamsBot.changed')));
  }
  const verb = action?.verb;
  const conversationKind = str(a.conversation?.conversationType, 20) || 'personal';
  const personal = conversationKind === 'personal';
  if (verb === 'refresh') return invokeCard(itemCard(l, data.kind, data.id, { viewer: user, personal, refreshFor: eligibleAadIds(data.kind, data.id) }));
  if (verb !== 'approve' && verb !== 'reject') return invokeCard(itemCard(l, data.kind, data.id, { viewer: user, personal }));
  const comment =
    str((action?.data as { comment?: unknown } | undefined)?.comment, 2000) || str((a.value?.data as { comment?: unknown } | undefined)?.comment, 2000);
  let outcome: TeamsOutcome;
  try {
    outcome = await decideFromTeams(user, { kind: data.kind, id: data.id }, verb, data.version, comment, {
      tenantId: tenant,
      aadObjectId: aad,
      conversationKind,
    });
  } catch (err) {
    logger.warn({ err, kind: data.kind, id: data.id }, 'Teams bot: the decision failed');
    return invokeCard(noticeCard(l, t(l, 'teamsBot.failed')));
  }
  if (!outcome.ok) {
    refused(outcome.reason, { user: user.username, kind: data.kind, id: data.id });
    const note = outcome.reason === 'stale' ? t(l, 'teamsBot.changed') : undefined;
    return invokeCard(itemCard(l, data.kind, data.id, { viewer: user, personal, note, refreshFor: eligibleAadIds(data.kind, data.id) }));
  }
  return invokeCard(itemCard(l, data.kind, data.id, { viewer: user, personal }));
}

/** Installation and conversation updates: where the bot is installed (audited). */
function conversationChanged(a: Activity, tenant: string, aad: string): void {
  const convId = str(a.conversation?.id, 512);
  const serviceUrl = str(a.serviceUrl, 512);
  if (!convId || !serviceUrl) return;
  const botId = str(a.recipient?.id, 256);
  const added = a.type === 'installationUpdate' ? a.action === 'add' : (a.membersAdded ?? []).some((m) => m.id === botId);
  const removed = a.type === 'installationUpdate' ? a.action === 'remove' : (a.membersRemoved ?? []).some((m) => m.id === botId);
  if (!added && !removed) return;
  const kind = a.conversation?.conversationType === 'personal' ? 'personal' : 'channel';
  const name = (str(a.channelData?.channel?.name, 200) || str(a.channelData?.team?.name, 200) || str(a.conversation?.name, 200)).slice(0, 200);
  const user = kind === 'personal' ? userForTeams(tenant, aad) : null;
  const row = db().get<{ id: string }>('SELECT id FROM teams_conversations WHERE tenant_id = ? AND conversation_id = ?', tenant, convId);
  if (added) {
    const id = row?.id ?? newId('tcv_');
    db().run(
      `INSERT INTO teams_conversations (id, tenant_id, conversation_id, service_url, kind, name, user_id, installed_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET service_url = excluded.service_url, name = excluded.name, user_id = excluded.user_id, removed_at = NULL`,
      id,
      tenant,
      convId,
      serviceUrl,
      kind,
      name,
      user?.id ?? null,
      nowIso(),
    );
    audit({
      actor: 'system',
      action: 'teams.conversation_added',
      entityType: 'settings',
      entityId: 'teams-bot',
      summary: `Teams bot installed in ${kind === 'personal' ? `a personal chat${user ? ` of ${user.username}` : ' (not linked to an account)'}` : `the channel "${name}"`}`,
      details: { conversation: id, kind, name, tenantId: tenant, user: user?.username ?? null },
    });
  } else if (row) {
    db().run('UPDATE teams_conversations SET removed_at = ? WHERE id = ?', nowIso(), row.id);
    audit({
      actor: 'system',
      action: 'teams.conversation_removed',
      entityType: 'settings',
      entityId: 'teams-bot',
      summary: `Teams bot removed from ${kind === 'personal' ? 'a personal chat' : `the channel "${name}"`}`,
      details: { conversation: row.id, kind, tenantId: tenant },
    });
  }
}

/** A message to the bot: a short help text with a link (no chat commands). Sent in the background. */
function helpReply(a: Activity, tenant: string, aad: string): void {
  const convId = str(a.conversation?.id, 512);
  const serviceUrl = str(a.serviceUrl, 512);
  if (!convId || !serviceUrl || !vault().unlocked) return;
  const user = userForTeams(tenant, aad);
  const l = localeOf(a, user ? userLocale(user) : undefined);
  const text = t(l, user ? 'teamsBot.help' : 'teamsBot.helpNotLinked');
  void sendActivity(serviceUrl, convId, {
    type: 'message',
    attachments: [asAttachment(noticeCard(l, text, '/tasks'))],
    text: `${text} ${absoluteLink('/tasks')}`,
  }).catch((err) => logger.warn({ err: { message: (err as Error).message } }, 'Teams bot: the help text could not be sent'));
}
