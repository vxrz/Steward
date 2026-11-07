import type { Locale } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso } from '../util.js';
import { findUserByName } from '../auth/users.js';
import { formatDateTime, t } from '../i18n/index.js';
import { absoluteLink } from '../notifications/settings.js';
import type { ItemKind } from './posts.js';
import type { MessageParts, OutgoingMessage } from '../notifications/channels.js';
import { deliveryPlan } from '../notifications/quiet.js';
import { holdMessage, resolveOutboxTarget } from '../notifications/outbox.js';
import { quietHoursAllowed } from '../notifications/prefs.js';
import { defaultLocale } from '../notifications/service.js';

/**
 * Approvals from Microsoft Teams, stage 1 (ADR 0013): decision cards that lead straight to the decision. The card
 * shows what is decided – never a request body, run inputs or values (a channel card is read by everyone in the
 * channel) – and Approve / Reject are links that open the decision dialog in Steward with the choice pre-selected.
 * A link never decides and carries no token: the person confirms in a signed-in session, with step-up and four-eyes.
 *
 * Incoming webhooks cannot update a posted card, so once the decision is made (in Steward or in Teams), the run is
 * cancelled or the request expires, a short follow-up card goes to the channels the card went to (approval_posts).
 */

export type { ItemKind } from './posts.js';

/** /runs/<run>?task=<task>&decide=approve – the dialog opens pre-filled; nothing is decided by opening it. */
export function decideLink(kind: ItemKind, id: string, verb: 'approve' | 'reject', runId?: string): string {
  return kind === 'task'
    ? absoluteLink(`/runs/${encodeURIComponent(runId ?? '')}?task=${encodeURIComponent(id)}&decide=${verb}`)
    : absoluteLink(`/mcp-requests/${encodeURIComponent(id)}?decide=${verb}`);
}

/** Approve / Reject buttons for what may be decided by approving: approve-mode steps and MCP gateway and run requests. */
export function decisionActions(l: Locale, kind: ItemKind, id: string, runId?: string): NonNullable<MessageParts['actions']> {
  return [
    { label: t(l, 'teamsCard.approve'), href: decideLink(kind, id, 'approve', runId) },
    { label: t(l, 'teamsCard.reject'), href: decideLink(kind, id, 'reject', runId) },
  ];
}

/** The card of a decision step: process, step, who started the run, since when; buttons for approve-mode steps. */
export function taskCardParts(
  l: Locale,
  e: { taskId: string; runId: string; processName: string; title: string; runActor: string; mode?: string; createdAt?: string; verification?: boolean },
): MessageParts {
  return {
    facts: [
      { label: t(l, 'facts.process'), value: e.processName },
      { label: t(l, 'teamsCard.step'), value: e.title },
      { label: t(l, 'teamsCard.askedBy'), value: e.runActor || '–' },
      { label: t(l, 'teamsCard.waitingSince'), value: formatDateTime(l, e.createdAt ?? nowIso()) },
    ],
    // select decisions, manual steps and their verification need the items, the entry or the evidence: Open only
    ...(e.mode === 'approve' && !e.verification ? { actions: decisionActions(l, 'task', e.taskId, e.runId) } : {}),
  };
}

/** The card of an MCP request: platform, the change as METHOD path_template, who asked, since, the expiry. */
export function mcpCardParts(
  l: Locale,
  r: {
    id: string;
    mode: string;
    kind: string;
    requested_by: string;
    created_at: string;
    expires_at: string;
    method: string | null;
    path_template: string | null;
    process_name: string | null;
    platformName?: string | null;
  },
): MessageParts {
  const change =
    r.kind === 'gateway' ? `${r.method ?? ''} ${r.path_template ?? ''}`.trim() : r.process_name ? t(l, 'teamsCard.startRun', { process: r.process_name }) : '';
  return {
    facts: [
      ...(r.platformName ? [{ label: t(l, 'teamsCard.platform'), value: r.platformName }] : []),
      ...(change ? [{ label: t(l, 'teamsCard.change'), value: change }] : []),
      { label: t(l, 'teamsCard.askedBy'), value: t(l, 'teamsCard.assistantOf', { user: r.requested_by }) },
      { label: t(l, 'teamsCard.waitingSince'), value: formatDateTime(l, r.created_at) },
      { label: t(l, 'teamsCard.expires'), value: formatDateTime(l, r.expires_at) },
    ],
    // proposals need the comparison: Open only
    ...(r.mode !== 'review' ? { actions: decisionActions(l, 'mcp_request', r.id) } : {}),
  };
}

// ---------- where a card went, and the follow-up ----------

export type Outcome = {
  status: 'approved' | 'rejected' | 'completed' | 'cancelled' | 'expired' | 'withdrawn' | 'failed';
  by?: string | null;
  at?: string;
  via?: 'teams';
};

function outcomeText(l: Locale, o: Outcome): string {
  const user = o.by ? (findUserByName(o.by)?.displayName ?? o.by) : '';
  const at = formatDateTime(l, o.at ?? nowIso());
  const key = `teamsCard.outcome.${o.status}${o.via === 'teams' ? 'Teams' : ''}` as const;
  return t(l, key as Parameters<typeof t>[1], { user, at });
}

/** Sends the outcome to the channels a decision card went to (once each); quiet hours of a channel apply. */
export function followUpDecision(kind: ItemKind, id: string, title: string, link: string, outcome: Outcome): number {
  const posts = db().all<{ target: string }>('SELECT target FROM approval_posts WHERE item_kind = ? AND item_id = ? AND followed_up_at IS NULL', kind, id);
  let sent = 0;
  for (const p of posts) {
    // claim the follow-up first: it goes out once, also when two paths settle the same item
    if (
      db().run(
        'UPDATE approval_posts SET followed_up_at = ? WHERE item_kind = ? AND item_id = ? AND target = ? AND followed_up_at IS NULL',
        nowIso(),
        kind,
        id,
        p.target,
      ).changes !== 1
    )
      continue;
    const target = resolveOutboxTarget(p.target);
    if (!target?.send) continue;
    const l = defaultLocale();
    const msg: OutgoingMessage = {
      event: kind === 'task' ? 'task.assigned' : 'mcp.request',
      title: t(l, 'teamsCard.followUpTitle', { title }),
      body: outcomeText(l, outcome),
      locale: l,
      link: absoluteLink(link),
      ts: nowIso(),
      data: { followUp: true, itemKind: kind, itemId: id, outcome: outcome.status },
    };
    const plan = deliveryPlan({ personal: false, quietHours: target.quietHours }, { event: msg.event as never }, Date.now(), { allowed: quietHoursAllowed() });
    if (!plan.send) {
      // collapses with nothing else: one line in the channel's catch-up
      holdMessage({
        target: p.target,
        itemKey: `followup:${kind}:${id}`,
        event: msg.event as never,
        reason: plan.hold,
        locale: l,
        state: { ts: msg.ts, title: msg.title, lead: msg.body, tone: 'good', link },
        about: { outcome: true },
      });
      continue;
    }
    sent++;
    target.send(msg).catch((err) => logger.warn({ err: { message: (err as Error).message }, target: p.target }, 'follow-up card could not be sent'));
  }
  return sent;
}
