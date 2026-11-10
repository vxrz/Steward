import {
  EVENT_DIGEST_GROUP,
  OWNED_KINDS,
  QUIET_LIMITS,
  type DigestPrefs,
  type Locale,
  type NotificationEvent,
  type OwnedKind,
  type QuietHours,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { newId, nowIso, parseJson } from '../util.js';
import { runAs } from '../auth/context.js';
import { getUser, toAuthUser } from '../auth/users.js';
import { processPermissions } from '../auth/permissions.js';
import { canSeeResource } from '../auth/scope-routes.js';
import { formatDateTime, t, type MessageKey } from '../i18n/index.js';
import { failingChecks } from '../engine/check-alerts.js';
import { absoluteLink, channelSecrets, getNotificationSettings } from './settings.js';
import { domainAllowed } from './domains.js';
import { queueEmail } from './email.js';
import { escHtml, resolveLook, type MessageTone } from './look.js';
import { sendTeams, type OutgoingMessage } from './channels.js';
import { teamsFormatChannel } from './team-channels.js';
import { digestDue, inQuietHours, rhythmOf, type HoldReason } from './quiet.js';
import { effectiveNotificationPrefs, quietHoursAllowed } from './prefs.js';

/**
 * The outbox of held messages (ADR 0012). A message held for quiet hours or a digest is kept here per target, as the
 * rendered text in the target's language – never a channel URL or a secret (the target is an id; the URL is read from
 * the vault at release). Repeats of the same thing collapse into one row with its first and last states.
 *
 * The job `notification-outbox` (every five minutes) releases what is due: at the first tick after a target's quiet
 * hours end, one catch-up message; a digest when its time has come. The send is claimed per target and period
 * (notification_digest_sends) and the rows are marked released in the same step, so a message goes out at most once –
 * also after a restart. Rights are checked again at release: an item the person may no longer see is left out.
 */

export interface HeldState {
  ts: string;
  title: string;
  lead?: string;
  tone?: MessageTone;
  link?: string;
  /** Rows folded into this one (the 500-row limit) */
  more?: number;
}

/** What a held item is about, checked again at release. */
export interface HeldAbout {
  kind?: OwnedKind;
  id?: string;
  runId?: string;
  /** A decision: left out when someone else decided it meanwhile */
  decision?: { kind: 'task' | 'mcp_request'; id: string };
  /** A check: its current state at release ("still failing" or "passed again") */
  check?: { source: string; name: string };
  /** The outcome of a decision (a follow-up card, ADR 0013): listed with the others, not as a waiting decision */
  outcome?: boolean;
  /** 0.13.0: a plant change set waiting for review – left out when it was decided meanwhile or is no longer visible */
  changeSet?: string;
}

/**
 * 0.13.0: whether a plant change set still waits for review and whether a person may still see it (set by the plant
 * registry's change sets – no import cycle). Without it, a held item about a change set is left out.
 */
let changeSetCheck: { open: (id: string) => boolean; visible: (u: UserInfo, id: string) => boolean } | null = null;
export function setChangeSetCheck(c: typeof changeSetCheck): void {
  changeSetCheck = c;
}

export interface HoldInput {
  target: string;
  userId?: string | null;
  itemKey: string;
  event: NotificationEvent;
  reason: HoldReason;
  locale: Locale;
  state: HeldState;
  about?: HeldAbout | null;
}

interface Row {
  id: string;
  target: string;
  user_id: string | null;
  item_key: string;
  event: NotificationEvent;
  reason: HoldReason;
  locale: Locale;
  states: string;
  about: string | null;
  first_at: string;
  last_at: string;
}

/** Keeps the first state and the last four. */
const trimStates = (s: HeldState[]): HeldState[] => (s.length > QUIET_LIMITS.statesPerItem ? [s[0]!, ...s.slice(-(QUIET_LIMITS.statesPerItem - 1))] : s);

/** Holds a message for a target (claimSend is called at release, not now). */
export function holdMessage(h: HoldInput): void {
  const at = h.state.ts || nowIso();
  db().tx(() => {
    const open = db().get<Row>(
      'SELECT * FROM notification_outbox WHERE target = ? AND item_key = ? AND reason = ? AND released_at IS NULL',
      h.target,
      h.itemKey,
      h.reason,
    );
    if (open) {
      const states = trimStates([...parseJson<HeldState[]>(open.states, []), h.state]);
      db().run(
        'UPDATE notification_outbox SET states = ?, last_at = ?, about = COALESCE(?, about) WHERE id = ?',
        JSON.stringify(states),
        at,
        aboutJson(h.about),
        open.id,
      );
      return;
    }
    const openCount = () =>
      Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM notification_outbox WHERE target = ? AND released_at IS NULL', h.target)?.n ?? 0);
    // at most 500 open items per target: the oldest are folded into a count
    // (only decisions left: they all stay, the limit is exceeded rather than a decision hidden)
    for (let i = 0; i < 3 && openCount() >= QUIET_LIMITS.openPerTarget; i++) if (!foldOldest(h, at)) break;
    db().run(
      `INSERT INTO notification_outbox (id, target, user_id, item_key, event, reason, locale, states, about, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('nob_'),
      h.target,
      h.userId ?? null,
      h.itemKey,
      h.event,
      h.reason,
      h.locale,
      JSON.stringify([h.state]),
      aboutJson(h.about),
      at,
      at,
    );
  });
}

const aboutJson = (a: HeldAbout | null | undefined) => (a && Object.keys(a).length ? JSON.stringify(a) : null);

/** Over the limit: the oldest row of the same event (else of the target) becomes a count ("+ 120 more failed checks"). */
function foldOldest(h: HoldInput, at: string): boolean {
  // a decision waiting for someone is never folded into a count (security review 0.10.0): only other events are
  const decisions = Object.entries(EVENT_DIGEST_GROUP)
    .filter(([, g]) => g === 'decisions')
    .map(([e]) => e);
  const notDecision = `event NOT IN (${decisions.map(() => '?').join(', ')})`;
  const oldest =
    (decisions.includes(h.event)
      ? undefined
      : db().get<Row>(
          "SELECT * FROM notification_outbox WHERE target = ? AND event = ? AND released_at IS NULL AND substr(item_key, 1, 5) <> 'more:' ORDER BY first_at LIMIT 1",
          h.target,
          h.event,
        )) ??
    db().get<Row>(
      `SELECT * FROM notification_outbox WHERE target = ? AND released_at IS NULL AND substr(item_key, 1, 5) <> 'more:' AND ${notDecision} ORDER BY first_at LIMIT 1`,
      h.target,
      ...decisions,
    );
  if (!oldest) return false;
  db().run('DELETE FROM notification_outbox WHERE id = ?', oldest.id);
  const key = `more:${oldest.event}`;
  const more = db().get<Row>(
    'SELECT * FROM notification_outbox WHERE target = ? AND item_key = ? AND reason = ? AND released_at IS NULL',
    h.target,
    key,
    oldest.reason,
  );
  const count = (more ? (parseJson<HeldState[]>(more.states, [])[0]?.more ?? 0) : 0) + 1;
  const state: HeldState = { ts: at, title: '', more: count };
  if (more) db().run('UPDATE notification_outbox SET states = ?, last_at = ? WHERE id = ?', JSON.stringify([state]), at, more.id);
  else
    db().run(
      `INSERT INTO notification_outbox (id, target, user_id, item_key, event, reason, locale, states, about, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      newId('nob_'),
      h.target,
      oldest.user_id,
      key,
      oldest.event,
      oldest.reason,
      oldest.locale,
      JSON.stringify([state]),
      oldest.first_at,
      at,
    );
  return true;
}

// ---------- targets ----------

/** A target as the outbox releases to it. */
export interface OutboxTarget {
  personal: boolean;
  user?: UserInfo;
  quietHours: QuietHours | null;
  /** Personal e-mail targets only */
  digests: DigestPrefs | null;
  /** Sends the rendered catch-up or digest; null: it cannot receive now (why) */
  send: ((m: OutgoingMessage) => Promise<void>) | null;
  why?: string;
}

type Resolver = (rest: string) => OutboxTarget | null;
const resolvers = new Map<string, Resolver>();

/** Other modules add their targets (monitor outputs, the Teams bot's personal chats) without an import cycle. */
export function registerOutboxTarget(prefix: string, r: Resolver): void {
  resolvers.set(prefix, r);
}

/** The target behind an id (also for the follow-up cards of decisions, msteams/cards.ts); null when unknown. */
export const resolveOutboxTarget = (target: string): OutboxTarget | null => resolveTarget(target);

function resolveTarget(target: string): OutboxTarget | null {
  const i = target.indexOf(':');
  const r = resolvers.get(i < 0 ? target : target.slice(0, i));
  if (!r) return null;
  try {
    return r(i < 0 ? '' : target.slice(i + 1));
  } catch (err) {
    logger.warn({ err, target }, 'outbox target unreadable');
    return null;
  }
}

/** Why e-mail cannot reach this person now (null: it can). */
export function emailBlocked(u: UserInfo | undefined): string | null {
  if (!u?.active) return 'inactive';
  if (!getNotificationSettings().email.enabled) return 'smtpOff';
  if (!u.email) return 'noAddress';
  if (!u.emailNotifications) return 'optedOut';
  if (!domainAllowed(u.email)) return 'domainNotAllowed';
  return null;
}

const userOf = (id: string): UserInfo | undefined => {
  try {
    return getUser(id);
  } catch {
    return undefined; // deleted: its rows went with it (ON DELETE CASCADE)
  }
};

async function sent(o: ReturnType<typeof queueEmail>): Promise<void> {
  if (o.status !== 'queued') throw new Error(`e-mail ${o.status}`);
  if (!(await o.done)) throw new Error('e-mail could not be sent');
}

registerOutboxTarget('email', (userId) => {
  const user = userOf(userId);
  const prefs = effectiveNotificationPrefs(userId).prefs;
  const why = emailBlocked(user);
  return {
    personal: true,
    user,
    quietHours: prefs.quietHours,
    digests: prefs.digests,
    why: why ?? undefined,
    send: why ? null : (m) => sent(queueEmail({ event: m.event, to: { user: user! }, message: m })),
  };
});
registerOutboxTarget('teams', () => {
  const s = getNotificationSettings();
  const url = s.teams.enabled ? channelSecrets().teamsWebhookUrl : undefined;
  return { personal: false, quietHours: s.teams.quietHours ?? null, digests: null, send: url ? (m) => sendTeams(url, m) : null, why: url ? undefined : 'off' };
});
registerOutboxTarget('webhook', () => {
  const s = getNotificationSettings();
  const url = s.webhook.enabled && s.webhook.format === 'teams' ? channelSecrets().webhookUrl : undefined;
  return {
    personal: false,
    quietHours: s.webhook.quietHours ?? null,
    digests: null,
    send: url ? (m) => sendTeams(url, m) : null,
    why: url ? undefined : 'off',
  };
});
registerOutboxTarget('team', (teamId) => {
  const c = teamsFormatChannel(teamId);
  return { personal: false, quietHours: c?.quietHours ?? null, digests: null, send: c ? (m) => sendTeams(c.url, m) : null, why: c ? undefined : 'off' };
});

// ---------- release ----------

/** Whether a held item is still visible to the person (the process of a run, a process, a platform, a monitor). */
function stillVisible(u: UserInfo, a: HeldAbout | null): boolean {
  if (!a) return true;
  if (a.changeSet && !changeSetCheck?.visible(u, a.changeSet)) return false;
  const au = toAuthUser(u);
  const processVisible = (pid: string) => {
    const p = db().get<{ owner: string | null; acl: string }>('SELECT owner, acl FROM processes WHERE id = ?', pid);
    return !!p && processPermissions(au, { id: pid, owner: p.owner, acl: parseJson(p.acl, []) }).includes('view');
  };
  try {
    return runAs(au, () => {
      if (a.runId) {
        // debug runs: one run by its id (a message that is being sent; debug runs send none)
        const r = db().get<{ process_id: string }>('SELECT process_id FROM runs WHERE id = ?', a.runId);
        if (!r || !processVisible(r.process_id)) return false;
      }
      // every kind a held message can be about (process, platform, monitor, credential, record, service, ticket …):
      // the same access decision as its page; an unknown kind is left out (security review 0.10.0)
      if (a.kind && a.id && !((OWNED_KINDS as readonly string[]).includes(a.kind) && canSeeResource(a.kind, a.id, au))) return false;
      return true;
    });
  } catch {
    return false; // not visible (or gone): left out
  }
}

/** Whether a decision is still open (left out of the catch-up when someone else decided it). */
function decisionOpen(d: NonNullable<HeldAbout['decision']>, now: string): boolean {
  if (d.kind === 'task') return db().get<{ status: string }>('SELECT status FROM run_tasks WHERE id = ?', d.id)?.status === 'open';
  const r = db().get<{ status: string; expires_at: string }>('SELECT status, expires_at FROM mcp_requests WHERE id = ?', d.id);
  return r?.status === 'pending' && r.expires_at > now;
}

type GroupId = 'decisions' | 'stillFailing' | 'passedAgain' | 'other';
interface Item {
  group: GroupId;
  event: NotificationEvent;
  title: string;
  detail: string;
  link?: string;
  tone?: MessageTone;
}

export interface HeldContent {
  title: string;
  /** Plain text, for the e-mail text part and the in-app body */
  text: string;
  /** Markdown for a Teams card */
  markdown: string;
  /** E-mail HTML (inside the standard layout) */
  html: string;
  items: number;
}

/** The held rows as one message: grouped, most important first, each item once with its start and latest state. */
export function renderHeld(rows: Row[], kind: 'catchup' | 'digest', locale: Locale, user?: UserInfo, now = nowIso()): HeldContent | null {
  const items: Item[] = [];
  let decidedMeanwhile = 0;
  let leftOut = 0;
  const failing = new Map<string, Set<string>>();
  const stillFailing = (c: NonNullable<HeldAbout['check']>) => {
    if (!failing.has(c.source)) failing.set(c.source, new Set(failingChecks(c.source).map((x) => x.check)));
    return failing.get(c.source)!.has(c.name);
  };
  for (const r of rows) {
    const states = parseJson<HeldState[]>(r.states, []);
    const last = states[states.length - 1];
    if (!last) continue;
    if (last.more) {
      items.push({ group: 'other', event: r.event, title: t(locale, 'quiet.more', { count: last.more, event: r.event }), detail: '' });
      continue;
    }
    const about = parseJson<HeldAbout | null>(r.about, null);
    if (user && !stillVisible(user, about)) {
      leftOut++;
      continue;
    }
    if ((about?.decision && !decisionOpen(about.decision, now)) || (about?.changeSet && !changeSetCheck?.open(about.changeSet))) {
      decidedMeanwhile++;
      continue;
    }
    const first = states[0]!;
    const since = t(locale, 'quiet.since', { date: formatDateTime(locale, first.ts) });
    const detail = [states.length > 1 || first.ts !== last.ts ? since : formatDateTime(locale, last.ts), last.lead].filter(Boolean).join(' · ');
    let group: GroupId = 'other';
    if (EVENT_DIGEST_GROUP[r.event] === 'decisions' && !about?.outcome) group = 'decisions';
    else if (about?.check) group = stillFailing(about.check) ? 'stillFailing' : 'passedAgain';
    items.push({ group, event: r.event, title: last.title, detail, link: last.link, tone: group === 'passedAgain' ? 'good' : last.tone });
  }
  if (leftOut) logger.info({ leftOut, user: user?.username }, 'held messages left out at release: no longer visible to the person');
  if (!items.length && !decidedMeanwhile) return null;
  const order: GroupId[] = ['decisions', 'stillFailing', 'passedAgain', 'other'];
  const groups = order
    .map((g) => ({ g, list: items.filter((i) => i.group === g).sort((a, b) => (g === 'other' ? a.event.localeCompare(b.event) : 0)) }))
    .filter((x) => x.list.length);
  const counts = [
    ...(groups.find((x) => x.g === 'decisions') ? [t(locale, 'quiet.countDecisions', { count: groups.find((x) => x.g === 'decisions')!.list.length })] : []),
    ...(groups.find((x) => x.g === 'stillFailing')
      ? [t(locale, 'quiet.countFailing', { count: groups.find((x) => x.g === 'stillFailing')!.list.length })]
      : []),
  ];
  const summary = counts.length ? counts.join(', ') : t(locale, 'quiet.countMessages', { count: items.length });
  const title = t(locale, kind === 'catchup' ? 'quiet.catchupTitle' : 'quiet.digestTitle', { summary });
  const head = (g: GroupId) => t(locale, `quiet.groups.${g}` as MessageKey);
  const meanwhile = decidedMeanwhile ? t(locale, 'quiet.decidedMeanwhile', { count: decidedMeanwhile }) : '';
  const intro = t(locale, user ? `quiet.intro.${kind}` : `quiet.introChannel.${kind}`);
  const text = [
    intro,
    '',
    ...groups.flatMap(({ g, list }) => [
      `${head(g)} (${list.length})`,
      ...list.map((i) => `- ${i.title}${i.detail ? ` – ${i.detail}` : ''}${i.link ? `\n  ${absoluteLink(i.link)}` : ''}`),
      '',
    ]),
    ...(meanwhile ? [meanwhile, ''] : []),
  ].join('\n');
  const markdown = [
    intro,
    ...groups.flatMap(({ g, list }) => [
      `**${head(g)}**`,
      list.map((i) => `- ${i.link ? `[${mdText(i.title)}](${absoluteLink(i.link)})` : mdText(i.title)}${i.detail ? ` – ${mdText(i.detail)}` : ''}`).join('\n'),
    ]),
    ...(meanwhile ? [`_${meanwhile}_`] : []),
  ].join('\n\n');
  const color = { attention: '#c92a2a', warning: '#e8590c', good: '#2b8a3e', accent: '#1971c2', emphasis: '#868e96' } as Record<string, string>;
  const li = (i: Item) => {
    const headHtml = i.link
      ? `<a href="${escHtml(absoluteLink(i.link))}" style="color:#1c7ed6;text-decoration:none">${escHtml(i.title)}</a>`
      : escHtml(i.title);
    const dot = i.tone && color[i.tone] ? `<span style="color:${color[i.tone]}">●</span> ` : '';
    return `<li style="margin:2px 0">${dot}${headHtml}${i.detail ? `<br><span style="color:#868e96;font-size:12px">${escHtml(i.detail)}</span>` : ''}</li>`;
  };
  const html = [
    `<div lang="${locale}">`,
    `<p style="margin:0 0 12px;color:#868e96">${escHtml(intro)}</p>`,
    ...groups.map(
      ({ g, list }) =>
        `<p style="margin:12px 0 2px"><strong>${escHtml(head(g))}</strong> <span style="color:#868e96">(${list.length})</span></p><ul style="margin:0;padding-left:18px">${list.map(li).join('')}</ul>`,
    ),
    ...(meanwhile ? [`<p style="margin:12px 0 0;color:#868e96">${escHtml(meanwhile)}</p>`] : []),
    '</div>',
  ].join('');
  return { title, text, markdown, html, items: items.length };
}

/** Text in a Teams markdown line: no link or emphasis syntax from names */
const mdText = (s: string) => s.replace(/[[\]*_`<>]/g, (c) => `\\${c}`);

const openRows = (target: string) => db().all<Row>('SELECT * FROM notification_outbox WHERE target = ? AND released_at IS NULL ORDER BY first_at', target);

/** Claims the send of a target and period and marks the rows released – in one step, before anything is sent. */
function claim(target: string, period: string, ids: string[], at: string): boolean {
  return db().tx(() => {
    if (
      db().run("INSERT INTO notification_digest_sends (target, period, ts, outcome) VALUES (?, ?, ?, 'pending') ON CONFLICT DO NOTHING", target, period, at)
        .changes !== 1
    )
      return false;
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      db().run(`UPDATE notification_outbox SET released_at = ? WHERE released_at IS NULL AND id IN (${part.map(() => '?').join(', ')})`, at, ...part);
    }
    return true;
  });
}

const setOutcome = (target: string, period: string, outcome: 'sent' | 'empty' | 'failed' | 'dropped') =>
  db().run('UPDATE notification_digest_sends SET outcome = ? WHERE target = ? AND period = ?', outcome, target, period);

/** What is due for a target at `now`: the quiet rows once the quiet hours ended, and digest rows whose time came. */
function dueRows(target: OutboxTarget, rows: Row[], now: number): { rows: Row[]; kind: 'catchup' | 'digest' } | null {
  if (inQuietHours(quietHoursAllowed() ? target.quietHours : null, now)) return null;
  const tz = target.digests?.timeZone ?? 'UTC';
  const quiet = rows.filter((r) => r.reason === 'quiet' || !quietHoursAllowed());
  const digest = rows.filter(
    (r) => r.reason !== 'quiet' && quietHoursAllowed() && digestDue(rhythmOf(target.digests, r.event).choice, tz, Date.parse(r.first_at), now),
  );
  if (!quiet.length && !digest.length) return null;
  return { rows: [...quiet, ...digest], kind: quiet.length ? 'catchup' : 'digest' };
}

/** Set by the daily summary (no import cycle): is the person's summary e-mail due within 60 minutes? */
let summarySoon: ((u: UserInfo, now: number) => boolean) | null = null;
export function setSummarySoon(fn: (u: UserInfo, now: number) => boolean): void {
  summarySoon = fn;
}

/** The job: releases what is due. Returns how many messages were sent. */
export async function runOutbox(now = Date.now()): Promise<number> {
  // like the daily summaries: nothing is released while the vault is locked (channel URLs, SMTP password)
  if (!vault().unlocked) return 0;
  const targets = db()
    .all<{ target: string }>('SELECT DISTINCT target FROM notification_outbox WHERE released_at IS NULL')
    .map((r) => r.target);
  let count = 0;
  for (const name of targets) {
    const target = resolveTarget(name);
    const rows = openRows(name);
    if (!target) {
      // the target is gone (a team channel removed, an output deleted): logged and dropped – the app kept its copy
      if (
        claim(
          name,
          `gone:${new Date(now).toISOString()}`,
          rows.map((r) => r.id),
          new Date(now).toISOString(),
        )
      ) {
        setOutcome(name, `gone:${new Date(now).toISOString()}`, 'dropped');
        logger.warn({ target: name, held: rows.length }, 'held messages dropped: the target no longer exists');
      }
      continue;
    }
    const due = dueRows(target, rows, now);
    if (!due) continue;
    // the daily summary takes the catch-up as its first section when it is due within 60 minutes
    if (due.kind === 'catchup' && target.user && summarySoon?.(target.user, now)) continue;
    const at = new Date(now).toISOString();
    const period = `${due.kind}:${at.slice(0, 16)}`;
    if (!target.send) {
      if (
        claim(
          name,
          period,
          due.rows.map((r) => r.id),
          at,
        )
      )
        setOutcome(name, period, 'dropped');
      logger.info({ target: name, why: target.why, held: due.rows.length }, 'held messages not sent: the target cannot receive them now');
      continue;
    }
    if (
      !claim(
        name,
        period,
        due.rows.map((r) => r.id),
        at,
      )
    )
      continue;
    const locale = due.rows[0]!.locale;
    try {
      const content = renderHeld(due.rows, due.kind, locale, target.user, at);
      if (!content) {
        setOutcome(name, period, 'empty');
        continue;
      }
      await target.send(heldMessage(content, due.kind, locale, !!target.user));
      setOutcome(name, period, 'sent');
      logger.debug({ target: name, kind: due.kind, items: content.items }, 'held messages released');
      count++;
    } catch (err) {
      setOutcome(name, period, 'failed');
      logger.warn({ err: { message: (err as Error).message }, target: name }, 'held messages could not be sent');
    }
  }
  return count;
}

/** The catch-up or digest as a message: e-mail parts, and the markdown body for a Teams card. */
function heldMessage(c: HeldContent, kind: 'catchup' | 'digest', locale: Locale, personal: boolean): OutgoingMessage {
  const profile = absoluteLink(personal ? '/profile' : '/settings/notifications');
  const note = `${escHtml(t(locale, personal ? 'quiet.footer' : 'quiet.footerChannel'))} <a href="${escHtml(profile)}" style="color:#5c636a">${escHtml(profile)}</a>`;
  return {
    event: kind === 'catchup' ? 'notification.catchup' : 'notification.digest',
    title: c.title,
    body: c.markdown,
    locale,
    link: absoluteLink('/'),
    ts: nowIso(),
    emailParts: {
      text: `${c.title}\n\n${c.text}\n${t(locale, personal ? 'quiet.footer' : 'quiet.footerChannel')} ${profile}\n`,
      html: c.html,
      note,
      button: { label: t(locale, 'common.openIn', { brand: resolveLook().name }), href: absoluteLink('/') },
    },
  };
}

/**
 * For the daily summary: the person's catch-up as its first section ("While you were away") – the held rows are
 * claimed and released with the summary. Null when nothing is held or the quiet hours have not ended.
 */
export function takeCatchUp(u: UserInfo, now = Date.now()): HeldContent | null {
  const target = resolveTarget(`email:${u.id}`);
  if (!target) return null;
  const due = dueRows(target, openRows(`email:${u.id}`), now);
  if (!due || due.kind !== 'catchup') return null;
  const at = new Date(now).toISOString();
  const period = `summary:${at.slice(0, 16)}`;
  if (
    !claim(
      `email:${u.id}`,
      period,
      due.rows.map((r) => r.id),
      at,
    )
  )
    return null;
  const content = renderHeld(due.rows, 'catchup', due.rows[0]!.locale, u, at);
  setOutcome(`email:${u.id}`, period, content ? 'sent' : 'empty');
  return content;
}

/** Cleanup: released rows after 7 days, and old claims. */
export function cleanupOutbox(now = Date.now()): number {
  const cutoff = new Date(now - QUIET_LIMITS.releasedDays * 86_400_000).toISOString();
  const n = db().run('DELETE FROM notification_outbox WHERE released_at IS NOT NULL AND released_at < ?', cutoff).changes;
  db().run('DELETE FROM notification_digest_sends WHERE ts < ?', cutoff);
  return n;
}
