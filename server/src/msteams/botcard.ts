import crypto from 'node:crypto';
import type { Locale, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { getTask } from '../engine/store.js';
import { t, type MessageKey } from '../i18n/index.js';
import { absoluteLink } from '../notifications/settings.js';
import { resolveLook } from '../notifications/look.js';
import type { MessageParts } from '../notifications/channels.js';
import { mcpCardParts, taskCardParts } from './cards.js';
import { teamsDecidable, teamsVisible, versionOf, type ItemKind } from './decide.js';
import { botConfig, botSecrets } from './settings.js';

/**
 * Cards of the Teams bot (ADR 0013 stage 2): Universal Actions (Adaptive Cards 1.4, `Action.Execute`). Each viewer's
 * buttons are computed for them when the card refreshes, and again on every click. The card data carries the item, its
 * version and an HMAC over both – card data cannot be edited to point at another item. Content follows the stage 1
 * rules: what is decided, never bodies, inputs or values.
 */

export interface CardData {
  kind: ItemKind;
  id: string;
  version: string;
  /** When the card was made (seconds): card data older than CARD_DATA_MAX_DAYS is refused */
  iat: number;
  sig: string;
}

/** Card data lives at most this long (an AI request expires within a day, a proposal within days). */
export const CARD_DATA_MAX_DAYS = 30;

const sign = (key: string, kind: string, id: string, version: string, iat: number) =>
  crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(`v2|${kind}|${id}|${version}|${iat}`).digest('base64url');

export function cardData(kind: ItemKind, id: string, version: string, now = Date.now()): CardData | null {
  const s = botSecrets();
  const iat = Math.floor(now / 1000);
  return s ? { kind, id, version, iat, sig: sign(s.hmacKey, kind, id, version, iat) } : null;
}

/** The card data of a click, when its signature holds (compared in constant time). */
export function checkCardData(v: unknown): CardData | null {
  const d = v as Partial<CardData> | null;
  if (!d || (d.kind !== 'task' && d.kind !== 'mcp_request') || typeof d.id !== 'string' || typeof d.version !== 'string' || typeof d.sig !== 'string')
    return null;
  if (d.id.length > 100 || d.version.length > 100 || d.sig.length > 100 || typeof d.iat !== 'number' || !Number.isInteger(d.iat)) return null;
  // old card data (an item's whole life is shorter): refused
  if (Date.now() / 1000 - d.iat > CARD_DATA_MAX_DAYS * 86_400 || d.iat > Date.now() / 1000 + 300) return null;
  const s = botSecrets();
  if (!s) return null;
  const want = Buffer.from(sign(s.hmacKey, d.kind, d.id, d.version, d.iat));
  const got = Buffer.from(d.sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? (d as CardData) : null;
}

interface ItemView {
  title: string;
  link: string;
  parts: MessageParts;
}

function itemView(l: Locale, kind: ItemKind, id: string): ItemView | null {
  if (kind === 'task') {
    let task;
    try {
      task = getTask(id);
    } catch {
      return null;
    }
    const run = db().get<{ actor: string; process_name: string }>('SELECT actor, process_name FROM runs WHERE id = ?', task.runId);
    return {
      title: t(l, 'task.title', { title: task.title }),
      link: `/runs/${task.runId}`,
      parts: taskCardParts(l, {
        taskId: id,
        runId: task.runId,
        processName: run?.process_name ?? '',
        title: task.title,
        runActor: run?.actor ?? '',
        createdAt: task.createdAt,
      }),
    };
  }
  const r = db().get<Parameters<typeof mcpCardParts>[1] & { platform_id: string | null }>('SELECT * FROM mcp_requests WHERE id = ?', id);
  if (!r) return null;
  const platformName = r.platform_id ? (db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', r.platform_id)?.name ?? null) : null;
  const what = r.kind === 'gateway' ? `${r.method ?? ''} ${r.path_template ?? ''}`.trim() : (r.process_name ?? '');
  return { title: t(l, 'teamsCard.mcpTitle', { user: r.requested_by, what }), link: `/mcp-requests/${id}`, parts: mcpCardParts(l, { ...r, platformName }) };
}

const STATUS_KEYS: Record<string, MessageKey> = {
  completed: 'teamsBot.state.decided',
  cancelled: 'teamsBot.state.cancelled',
  done: 'teamsBot.state.decided',
  failed: 'teamsBot.state.decided',
  approved: 'teamsBot.state.decided',
  rejected: 'teamsBot.state.decided',
  withdrawn: 'teamsBot.state.decided',
  expired: 'teamsBot.state.expired',
};

/**
 * The card of an item, for one viewer (null: the channel view – status and Open for everyone). `note` is a line on top
 * ("This changed – here is the current state", "Your Teams account is not linked …"). `refreshFor`: the Entra object ids
 * of the eligible deciders (at most 60) whose clients ask for their own buttons.
 */
export function itemCard(
  l: Locale,
  kind: ItemKind,
  id: string,
  opts: { viewer?: UserInfo | null; note?: string; refreshFor?: string[]; personal?: boolean } = {},
): unknown {
  // a viewer sees an item's facts only while they may see the item (security review 0.10.0)
  if (opts.viewer && !teamsVisible(opts.viewer, kind, id)) return noticeCard(l, t(l, 'teamsBot.gone'));
  const view = itemView(l, kind, id);
  const version = versionOf(kind, id) ?? '';
  const data = cardData(kind, id, version);
  const open = { type: 'Action.OpenUrl', title: t(l, 'common.openIn', { brand: resolveLook().name }), url: absoluteLink(view?.link ?? '/') };
  const body: unknown[] = [];
  if (opts.note) body.push({ type: 'TextBlock', text: opts.note, wrap: true, weight: 'Bolder', color: 'Attention' });
  body.push({ type: 'TextBlock', text: view?.title ?? t(l, 'teamsBot.gone'), weight: 'Bolder', size: 'Medium', wrap: true });
  if (view?.parts.facts?.length) body.push({ type: 'FactSet', facts: view.parts.facts.map((f) => ({ title: f.label, value: f.value })) });
  // a personal chat shows what is decided (instructions and items; the concrete request) – a channel card never does
  if (opts.personal && opts.viewer && view) body.push(...personalDetails(l, kind, id));
  const open_ = version.startsWith('open') || version === 'pending';
  if (!open_ && STATUS_KEYS[version.split(':')[0]!])
    body.push({ type: 'TextBlock', text: t(l, STATUS_KEYS[version.split(':')[0]!]!), wrap: true, isSubtle: true });
  const actions: unknown[] = [];
  const can = opts.viewer && view && data && open_ ? teamsDecidable(opts.viewer, kind, id) : null;
  if (can?.ok) {
    body.push({ type: 'Input.Text', id: 'comment', label: t(l, 'teamsBot.comment'), isMultiline: true, maxLength: 500 });
    actions.push(
      { type: 'Action.Execute', verb: 'approve', title: t(l, 'teamsCard.approve'), data, style: 'positive' },
      { type: 'Action.Execute', verb: 'reject', title: t(l, 'teamsCard.reject'), data, style: 'destructive' },
    );
  } else if (can && !can.ok && can.reason !== 'decided' && can.reason !== 'gone') {
    body.push({ type: 'TextBlock', text: t(l, `teamsBot.why.${can.reason}` as MessageKey, { days: botConfig().signInDays }), wrap: true, isSubtle: true });
  }
  actions.push(open);
  const refresh =
    data && open_ && opts.refreshFor?.length ? { action: { type: 'Action.Execute', verb: 'refresh', data }, userIds: opts.refreshFor.slice(0, 60) } : undefined;
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    ...(refresh ? { refresh } : {}),
    body,
    actions,
  };
}

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The details a person needs to decide in their personal chat: a step's instructions and items, or an AI request's
 * concrete method, path, query and (shortened) body with the assistant's reason – marked as data, not instructions.
 */
function personalDetails(l: Locale, kind: ItemKind, id: string): unknown[] {
  const out: unknown[] = [];
  if (kind === 'task') {
    let task;
    try {
      task = getTask(id);
    } catch {
      return out; // gone meanwhile
    }
    if (task.instructions?.trim()) out.push({ type: 'TextBlock', text: cap(task.instructions.trim(), 2000), wrap: true, spacing: 'Medium' });
    if (task.items.length) {
      const head = task.columns.map((c) => c.label).join(' · ');
      const rows = task.items.slice(0, 20).map((i) => `- ${i.cells.join(' · ')}`);
      out.push({
        type: 'TextBlock',
        text: cap(
          [head ? `**${head}**` : '', ...rows, task.items.length > 20 ? `+ ${t(l, 'common.moreItems', { count: task.items.length - 20 })}` : '']
            .filter(Boolean)
            .join('\n'),
          3000,
        ),
        wrap: true,
        spacing: 'Medium',
      });
    }
    return out;
  }
  const r = db().get<{ kind: string; method: string | null; path: string | null; query: string; body: string | null; reason: string }>(
    'SELECT kind, method, path, query, body, reason FROM mcp_requests WHERE id = ?',
    id,
  );
  if (!r) return out;
  out.push({ type: 'TextBlock', text: t(l, 'teamsBot.dataNotInstructions'), wrap: true, isSubtle: true, spacing: 'Medium' });
  if (r.kind === 'gateway') {
    const query = r.query && r.query !== '{}' ? `\n${t(l, 'teamsBot.query')}: ${cap(r.query, 500)}` : '';
    out.push({ type: 'TextBlock', text: cap(`${r.method ?? ''} ${r.path ?? ''}`, 500) + query, wrap: true, fontType: 'Monospace' });
    if (r.body) out.push({ type: 'TextBlock', text: `${t(l, 'teamsBot.body')}: ${cap(r.body, 1500)}`, wrap: true, fontType: 'Monospace' });
  }
  if (r.reason) out.push({ type: 'TextBlock', text: `${t(l, 'teamsBot.reason')}: ${cap(r.reason, 500)}`, wrap: true });
  return out;
}

/** A short card with one line and Open (not linked, locked, refused). */
export function noticeCard(l: Locale, text: string, link = '/'): unknown {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [{ type: 'TextBlock', text, wrap: true }],
    actions: [{ type: 'Action.OpenUrl', title: t(l, 'common.openIn', { brand: resolveLook().name }), url: absoluteLink(link) }],
  };
}

export const asAttachment = (card: unknown) => ({ contentType: 'application/vnd.microsoft.card.adaptive', content: card });
