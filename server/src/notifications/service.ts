import {
  type AiBudgetUse,
  pauseActive,
  type AclEntry,
  type Locale,
  type NotificationEvent,
  type OwnedKind,
  type NotificationLookInput,
  type NotificationLookPreview,
  type ProcessPermission,
  type UserInfo,
  type QuietHours,
  isEmailAddress,
} from '@sm/shared';
import { db } from '../db.js';
import { on, type DomainEvents } from '../events.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { matches, platformPermissions, processPermissions, verificationCheck } from '../auth/permissions.js';
import { onBudgetNotice } from '../ai/usage.js';
import { onCostBudgetNotice, type BudgetNotice } from '../costs/budgets.js';
import { scopeInfo as costScopeInfo, seesWholeScope as costSeesWholeScope } from '../costs/access.js';
import { getTask } from '../engine/store.js';
import { absoluteLink, channelSecrets, getNotificationSettings } from './settings.js';
import { addInApp, claimSend } from './store.js';
import { emailContent, partsText, sendEmail, sendTeams, sendWebhook, teamsCard, type MessageParts, type OutgoingMessage } from './channels.js';
import { sourceOfRun, type RunSource } from '../engine/notify-source.js';
import { allParts } from '../dashboards/datasets.js';
import { dryRunDelivery, isDryRun, logoDataUrl, lookProblems, resolveLook } from './look.js';
import { defaultLocale, userLocale } from './locale.js';
import { formatDateTime, t, type MessageKey } from '../i18n/index.js';
import { allowedDomainRules, domainAllowed } from './domains.js';
import { flushEmails, queueEmail } from './email.js';
import { teamChannelUrl, teamChannelsFor, teamsOf } from './team-channels.js';
import { deliveryPlan, inQuietHours, type BreakReason, type DeliveryPlan } from './quiet.js';
import { emailBlocked, holdMessage, type HeldAbout } from './outbox.js';
import { effectiveNotificationPrefs, quietHoursAllowed } from './prefs.js';
import { eventTone } from './look.js';
import { isCardTarget, recordApprovalPost } from '../msteams/posts.js';
import { taskCardParts } from '../msteams/cards.js';

/** Same event + entity within this window → no second e-mail/Teams/webhook message (and no second in-app entry for the same key). */
export const DEDUPE_WINDOW_MS = 60 * 60000;

export interface NoticeText {
  title: string;
  body: string;
  /** Structured content (#144): e-mail and Teams render it, the in-app body gets it as text */
  parts?: MessageParts;
}

export interface Notice {
  event: NotificationEvent;
  /**
   * Title and body in one language – called per recipient (in-app, e-mail) and once for channel posts
   * (Teams, webhook) and plain addresses. With `personal`, the in-app and e-mail texts of a Steward user
   * get that user (e.g. to leave out what they may not see); the other calls get no recipient.
   */
  text: (locale: Locale, recipient?: UserInfo) => NoticeText;
  personal?: boolean;
  /** In-app path, e.g. /runs/run_123 */
  link?: string;
  recipients: UserInfo[];
  /** De-duplicates in-app entries per user */
  inAppKey: string;
  /** De-duplicates external sends (coarser, e.g. per process or schedule) */
  externalKey: string;
  data?: Record<string, unknown>;
  /**
   * Plain e-mail addresses outside Steward (e-mail only, when the event is routed to e-mail and SMTP is
   * enabled). Addresses whose domain is not allowed (see domains.ts) are left out.
   */
  emails?: string[];
  /** E-mail attachments */
  attachments?: OutgoingMessage['attachments'];
  /**
   * The source of the run the message is about (#139): its policy picks the channels (null: the routes) and can pause
   * the messages. Missing: the routes, as before.
   */
  source?: RunSource | null;
  /** The run the message is about: during a maintenance window with "pause messages" on its platforms it goes to the app only (#108) */
  runId?: string;
  /** The resource the message is about: its owning teams' own channels get it too (#136). A run's process otherwise. */
  about?: { kind: OwnedKind; id: string };
  // ---- quiet hours and digests (0.10.0, ADR 0012) ----
  /** Repeats of the same thing collapse into one held item (default: event + externalKey) */
  itemKey?: string;
  /** A decision that expires then (ISO): it breaks through quiet hours when it would expire inside them */
  expiresAt?: string;
  /** A decision: left out of a catch-up when someone else decided it meanwhile */
  decision?: HeldAbout['decision'];
  /** 0.13.0: a plant change set to review – left out of a catch-up when it was decided meanwhile (no card to decide in Teams) */
  changeSet?: string;
  /** A check of a source: "still failing" or "passed again" at release */
  check?: HeldAbout['check'];
  /** Urgent beyond the source's policy (a monitor output marked urgent going down) */
  urgent?: boolean;
}

/** The Teams bot (ADR 0013 stage 2, msteams/delivery.ts): decision cards through the bot instead of the webhook. */
export interface BotDelivery {
  covers: (target: string) => boolean;
  postChannel: (target: string, item: NonNullable<Notice['decision']>) => Promise<void>;
  hasPersonal: (u: UserInfo) => boolean;
  postPersonal: (u: UserInfo, item: NonNullable<Notice['decision']>) => Promise<void>;
  /** 0.15.0 (ADR 0025): the person chose this event for their chat with the bot, and the chat may be used now */
  wantsNotice: (u: UserInfo, event: NotificationEvent) => boolean;
  /** Posts a personal message there (retries when throttled; rejects with the last error) */
  postNotice: (u: UserInfo, m: OutgoingMessage) => Promise<void>;
}
let botDelivery: BotDelivery | null = null;
export function setBotDelivery(b: BotDelivery | null): void {
  botDelivery = b;
}

/** Set by the maintenance module (no import cycle): does a maintenance window pause the messages of this run? */
let maintenancePause: ((runId: string) => boolean) | null = null;
export function setMaintenancePause(fn: (runId: string) => boolean): void {
  maintenancePause = fn;
}

/**
 * A user-chosen name for a message title (e-mail subject): one line, at most `max` characters. Titles
 * put it in quotes after a fixed prefix, so a name cannot pose as the whole subject.
 */
export function titleName(name: string, max = 80): string {
  // eslint-disable-next-line no-control-regex -- control characters (line breaks) are the point
  const one = name.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

// ---------- recipients ----------

const activeUsers = (): UserInfo[] => listUsers().filter((u) => u.active);
const sameName = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const userNamed = (name: string | null | undefined, all: UserInfo[]) => all.find((u) => sameName(u.username, name));
const admins = (all: UserInfo[]) => all.filter((u) => u.roles.includes('admin'));

function uniqueUsers(list: (UserInfo | undefined)[]): UserInfo[] {
  const seen = new Map<string, UserInfo>();
  for (const u of list) if (u && !seen.has(u.id)) seen.set(u.id, u);
  return [...seen.values()];
}

function processAccess(processId: string): { id: string; owner: string | null; acl: AclEntry<ProcessPermission>[] } {
  const r = db().get<{ owner: string | null; acl: string }>('SELECT owner, acl FROM processes WHERE id = ?', processId);
  return { id: processId, owner: r?.owner ?? null, acl: parseJson(r?.acl, []) };
}

/** Users who may decide a new task (same rules as decisionCheck, but without the admin override for assigned tasks). */
export function taskRecipients(e: DomainEvents['task.created']): UserInfo[] {
  const all = activeUsers();
  const access = processAccess(e.processId);
  const eligible = all.filter((u) => {
    if (e.fourEyes && sameName(u.username, e.runActor)) return false;
    const au = toAuthUser(u);
    const perms = processPermissions(au, access);
    if (!perms.includes('view')) return false;
    return e.assignees.length ? e.assignees.some((s) => matches(au, s)) : perms.includes('approve');
  });
  if (eligible.length) return eligible;
  // nobody matches the assignees – administrators can still decide
  return admins(all).filter((u) => !(e.fourEyes && sameName(u.username, e.runActor)));
}

/** Users who may verify a manual step that waits for its second person (same rules as verificationCheck). */
export function verifierRecipients(taskId: string): UserInfo[] {
  const task = getTask(taskId);
  if (!task.manual || !task.processId) return [];
  const all = activeUsers();
  const access = processAccess(task.processId);
  const verifiers = task.manual.spec.verification.verifiers;
  const eligible = all.filter((u) => {
    const au = toAuthUser(u);
    const perms = processPermissions(au, access);
    if (!verificationCheck(au, task.manual!, { actor: task.startedBy ?? '' }, perms).ok) return false;
    // without a verifier list: the approvers (like decisions), not everyone who may run the process
    return verifiers.length > 0 || perms.includes('approve');
  });
  if (eligible.length || verifiers.length) return eligible;
  return admins(all).filter(
    (u) => verificationCheck(toAuthUser(u), task.manual!, { actor: task.startedBy ?? '' }, processPermissions(toAuthUser(u), access)).ok,
  );
}

/** The person who started a run and the owner of its source (schedule, webhook trigger, monitor – #139). */
function runPeople(runId: string, all: UserInfo[]): { actor?: UserInfo; scheduleOwner?: UserInfo; source: RunSource | null } {
  // debug runs: one run by its id (a message that is being sent; debug runs send none)
  const r = db().get<{ actor: string }>('SELECT actor FROM runs WHERE id = ?', runId);
  const source = sourceOfRun(runId);
  if (!r) return { source };
  return { actor: userNamed(r.actor, all), scheduleOwner: userNamed(source?.owner, all), source };
}

// ---------- language ----------

/** Language for channel posts (Teams, webhook) and for users who have not chosen one. */
export { defaultLocale, userLocale };

// ---------- delivery ----------

const pending = new Set<Promise<void>>();

/** Stores in-app notifications and sends the external messages (in the background; failures are only logged). */
export function notify(n: Notice): void {
  if (!n.recipients.length && !n.emails?.length) return;
  const settings = getNotificationSettings();
  const policy = n.source?.policy;
  // the source's choice replaces the routes; a channel the instance turned off stays off (below)
  let channels = policy?.channels ? [...policy.channels] : (settings.routes[n.event] ?? []);
  // paused: nothing goes out, the app keeps the messages when the pause says so
  if (pauseActive(policy?.pause)) channels = policy!.pause!.inApp ? ['inApp'] : [];
  // planned maintenance on the run's platforms (#108): the app keeps the messages, nothing goes out
  else if (n.runId && maintenancePause?.(n.runId)) channels = channels.filter((c) => c === 'inApp');
  if (!channels.length) return;
  const fallback = defaultLocale();
  const texts = new Map<Locale, NoticeText>();
  const textIn = (locale: Locale, u?: UserInfo): NoticeText => {
    if (n.personal && u) return n.text(locale, u);
    if (!texts.has(locale)) texts.set(locale, n.text(locale));
    return texts.get(locale)!;
  };
  if (channels.includes('inApp')) {
    for (const u of n.recipients) {
      try {
        const m = textIn(userLocale(u, fallback), u);
        // the app shows text only: the lead and the items go into the body
        // a decision's Approve / Reject are links into the app: the entry itself opens the item
        const pt = partsText(m.parts, { facts: false, actions: !n.decision });
        const body = [pt.before, m.body, pt.after].filter(Boolean).join('\n\n').slice(0, 4000);
        addInApp(u.id, { event: n.event, title: m.title, body, link: n.link, dedupeKey: `${n.event}:${n.inAppKey}` }, DEDUPE_WINDOW_MS);
      } catch (err) {
        logger.warn({ err, event: n.event }, 'could not store notification');
      }
    }
  }
  // a dry run is a test: with "in the app only" it never reaches a mailbox, Teams or a webhook
  if (isDryRun(n.data) && dryRunDelivery() === 'inAppOnly') return;
  let external = channels.filter((c) => c !== 'inApp' && settings[c].enabled);
  // the owning teams' own channels (#136): for messages routed to a channel (Teams or webhook)
  const toChannel = channels.includes('teams') || channels.includes('webhook');
  const teamChannels = toChannel ? teamChannelsFor(teamsOf(n.about, n.runId)) : { channels: [], skipInstance: false };
  if (teamChannels.skipInstance) external = external.filter((c) => c !== 'teams' && c !== 'webhook');
  // Teams (personal) (ADR 0025): instead of the personal e-mail – the route says e-mail – for the recipients who chose
  // the event and have a chat with the bot that may be used; decision cards take their own path below
  const bot = botDelivery;
  const toChat = bot && !n.decision && channels.includes('email') ? n.recipients.filter((u) => bot.wantsNotice(u, n.event)) : [];
  const chatIds = new Set(toChat.map((u) => u.id));
  if (!external.length && !teamChannels.channels.length && !toChat.length) return;
  if (!vault().unlocked) {
    logger.warn({ event: n.event }, 'notification not sent: the vault is locked');
    return;
  }
  const message = (locale: Locale, u?: UserInfo): OutgoingMessage => ({
    event: n.event,
    ...textIn(locale, u),
    locale,
    link: absoluteLink(n.link),
    ts: nowIso(),
    data: n.data,
    attachments: n.attachments,
  });
  const key = `${n.event}:${n.externalKey}`;
  const jobs: { channel: string; to?: string; target?: string; send: () => Promise<void> }[] = [];
  let secrets: ReturnType<typeof channelSecrets>;
  try {
    secrets = channelSecrets();
  } catch (err) {
    logger.warn({ err, event: n.event }, 'notification not sent: channel settings unreadable');
    return;
  }
  // quiet hours and digests (ADR 0012): per target, send now or hold for later – claimSend only when it goes out
  const now = Date.now();
  const allowed = quietHoursAllowed();
  const urgent = !!n.urgent || (!!policy?.urgent && (n.event === 'run.failed' || (n.event === 'check.failed' && n.data?.severity === 'error')));
  const prefsOf = new Map<string, ReturnType<typeof effectiveNotificationPrefs>['prefs']>();
  const personPrefs = (u: UserInfo) => {
    if (!prefsOf.has(u.id)) prefsOf.set(u.id, effectiveNotificationPrefs(u.id).prefs);
    return prefsOf.get(u.id)!;
  };
  const about: HeldAbout = {
    ...(n.about ? { kind: n.about.kind, id: n.about.id } : {}),
    ...(n.runId ? { runId: n.runId } : {}),
    ...(n.decision ? { decision: n.decision } : {}),
    ...(n.changeSet ? { changeSet: n.changeSet } : {}),
    ...(n.check ? { check: n.check } : {}),
  };
  const hold = (target: string, plan: Extract<DeliveryPlan, { send: false }>, locale: Locale, u?: UserInfo) => {
    try {
      const m = textIn(locale, u);
      holdMessage({
        target,
        userId: u?.id ?? null,
        itemKey: n.itemKey ?? key,
        event: n.event,
        reason: plan.hold,
        locale,
        state: { ts: nowIso(), title: m.title, lead: m.parts?.lead, tone: eventTone(n.event, n.data), link: n.link },
        about,
      });
    } catch (err) {
      logger.warn({ err, event: n.event, target }, 'notification could not be held');
    }
  };
  const channelPlan = (quietHours: QuietHours | null | undefined) =>
    deliveryPlan({ personal: false, quietHours: quietHours ?? null }, { event: n.event, urgent, expiresAt: n.expiresAt }, now, { allowed });
  const broke = (msg: OutgoingMessage, plan: DeliveryPlan, personal: boolean, timeZone: string): OutgoingMessage => {
    if (!plan.send || !plan.broke) return msg;
    const why = breakText(msg.locale, plan.broke, personal, n.expiresAt, timeZone);
    return { ...msg, parts: { ...msg.parts, reason: [why, msg.parts?.reason].filter(Boolean).join(' ') } };
  };
  if (external.includes('email')) {
    // one way out for e-mail (email.ts): the user's own address, or an address outside Steward with an allowed domain
    const reachable = (o: UserInfo) => !!o.email && o.emailNotifications && !inQuietHours(allowed ? personPrefs(o).quietHours : null, now);
    for (const u of n.recipients) {
      if (!u.email || !u.emailNotifications) continue;
      if (chatIds.has(u.id)) continue; // Teams (personal) instead, e-mail only as its fallback (below)
      const prefs = personPrefs(u);
      const plan = deliveryPlan(
        { personal: true, quietHours: prefs.quietHours, digests: prefs.digests },
        { event: n.event, urgent, expiresAt: n.expiresAt, otherDeciderReachable: !!n.expiresAt && n.recipients.some((o) => o.id !== u.id && reachable(o)) },
        now,
        { allowed },
      );
      if (!plan.send) {
        hold(`email:${u.id}`, plan, userLocale(u, fallback), u);
        continue;
      }
      if (claimSend(`email:${key}:${u.id}`, DEDUPE_WINDOW_MS))
        queueEmail({ event: n.event, to: { user: u }, message: broke(message(userLocale(u, fallback), u), plan, true, prefs.quietHours.timeZone), secrets });
    }
    const userAddresses = new Set(n.recipients.map((u) => u.email?.toLowerCase()).filter(Boolean));
    const rules = n.emails?.length ? allowedDomainRules() : [];
    for (const addr of new Set((n.emails ?? []).map((e) => e.trim().toLowerCase()).filter(isEmailAddress))) {
      if (userAddresses.has(addr)) continue; // already reached as a Steward user (with their own settings)
      if (!domainAllowed(addr, rules)) {
        queueEmail({ event: n.event, to: { address: addr }, message: message(fallback), rules, secrets }); // logs the refusal
        continue;
      }
      if (claimSend(`email:${key}:${addr}`, DEDUPE_WINDOW_MS))
        queueEmail({ event: n.event, to: { address: addr }, message: message(fallback), rules, secrets });
    }
  }
  // Teams (personal): the person's quiet hours and digests, the text of their e-mail; e-mail once when the chat fails
  for (const u of toChat) {
    const prefs = personPrefs(u);
    const plan = deliveryPlan(
      { personal: true, quietHours: prefs.quietHours, digests: prefs.digests },
      { event: n.event, urgent, expiresAt: n.expiresAt },
      now,
      {
        allowed,
      },
    );
    const locale = userLocale(u, fallback);
    if (!plan.send) {
      hold(`teamsChat:${u.id}`, plan, locale, u);
      continue;
    }
    if (!claimSend(`teamsChat:${key}:${u.id}`, DEDUPE_WINDOW_MS)) continue;
    const msg = broke(message(locale, u), plan, true, prefs.quietHours.timeZone);
    jobs.push({
      channel: 'teamsChat',
      to: u.username,
      send: () =>
        bot!.postNotice(u, msg).catch((err: unknown) => {
          // the same message by e-mail, once: only when e-mail can reach the person and it did not go out by e-mail already
          if (emailBlocked(u) || !claimSend(`email:${key}:${u.id}`, DEDUPE_WINDOW_MS)) throw err;
          logger.warn({ err: { message: (err as Error).message }, event: n.event, to: u.username }, 'Teams (personal) failed: sent by e-mail instead');
          queueEmail({ event: n.event, to: { user: u }, message: msg, secrets });
        }),
    });
  }
  // decision cards through the Teams bot where an administrator chose its conversation for a channel target (stage 2)
  const byBot = (target: string): (() => Promise<void>) | null =>
    n.decision && botDelivery?.covers(target) ? () => botDelivery!.postChannel(target, n.decision!) : null;
  // … and to the personal chat of each decider who installed the app, with their quiet hours (target teamsChat:<user>)
  if (n.decision && botDelivery)
    for (const u of n.recipients) {
      if (!botDelivery.hasPersonal(u)) continue;
      const plan = deliveryPlan(
        { personal: true, quietHours: personPrefs(u).quietHours, digests: null },
        { event: n.event, urgent, expiresAt: n.expiresAt },
        now,
        {
          allowed,
        },
      );
      if (!plan.send) hold(`teamsChat:${u.id}`, plan, userLocale(u, fallback), u);
      else if (claimSend(`teamsChat:${key}:${u.id}`, DEDUPE_WINDOW_MS))
        jobs.push({ channel: 'teamsChat', to: u.username, send: () => botDelivery!.postPersonal(u, n.decision!) });
    }
  if (external.includes('teams') && secrets.teamsWebhookUrl) {
    const plan = channelPlan(settings.teams.quietHours);
    if (!plan.send) hold('teams:instance', plan, fallback);
    else if (claimSend(`teams:${key}`, DEDUPE_WINDOW_MS)) {
      const msg = broke(message(fallback), plan, false, settings.teams.quietHours?.timeZone ?? 'UTC');
      const bot = byBot('teams:instance');
      // a card the bot posted is updated with its outcome; only webhook cards get a follow-up card (approval_posts)
      jobs.push({ channel: 'teams', target: bot ? undefined : 'teams:instance', send: bot ?? (() => sendTeams(secrets.teamsWebhookUrl!, msg)) });
    }
  }
  if (external.includes('webhook') && secrets.webhookUrl) {
    const asCard = settings.webhook.format === 'teams';
    // JSON webhooks are never held: they feed tickets and on-call tools with their own rules
    const plan: DeliveryPlan = asCard ? channelPlan(settings.webhook.quietHours) : { send: true };
    if (!plan.send) hold('webhook:instance', plan, fallback);
    else if (claimSend(`webhook:${key}`, DEDUPE_WINDOW_MS)) {
      const msg = broke(message(fallback), plan, false, settings.webhook.quietHours?.timeZone ?? 'UTC');
      const bot = asCard ? byBot('webhook:instance') : null;
      jobs.push({
        channel: 'webhook',
        target: bot ? undefined : 'webhook:instance',
        send: bot ?? (() => (asCard ? sendTeams(secrets.webhookUrl!, msg) : sendWebhook(secrets.webhookUrl!, msg))),
      });
    }
  }
  for (const c of teamChannels.channels) {
    const plan: DeliveryPlan = c.format === 'teams' ? channelPlan(c.quietHours) : { send: true };
    if (!plan.send) {
      hold(`team:${c.team.id}`, plan, fallback);
      continue;
    }
    if (!claimSend(`team:${c.team.id}:${key}`, DEDUPE_WINDOW_MS)) continue;
    const msg = broke(message(fallback), plan, false, c.quietHours?.timeZone ?? 'UTC');
    const bot = c.format === 'teams' ? byBot(`team:${c.team.id}`) : null;
    jobs.push({
      channel: `team:${c.team.name}`,
      target: bot ? undefined : `team:${c.team.id}`,
      send: bot ?? (() => (c.format === 'teams' ? sendTeams(c.url, msg) : sendWebhook(c.url, msg))),
    });
  }
  for (const j of jobs) {
    const p = j
      .send()
      .then(() => {
        logger.debug({ event: n.event, channel: j.channel, to: j.to }, 'notification sent');
        // a decision card in a channel (ADR 0013): the outcome follows it there
        if (n.decision && j.target && isCardTarget(j.target)) recordApprovalPost(n.decision.kind, n.decision.id, j.target);
      })
      .catch((err) => logger.warn({ err: { message: (err as Error).message }, event: n.event, channel: j.channel, to: j.to }, 'notification could not be sent'))
      .finally(() => pending.delete(p));
    pending.add(p);
  }
}

/** The footer of a message that broke through quiet hours: why (ADR 0012). */
function breakText(l: Locale, reason: BreakReason, personal: boolean, expiresAt: string | undefined, timeZone: string): string {
  const time = (): string => {
    if (!expiresAt) return '';
    try {
      return new Intl.DateTimeFormat(l, { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(expiresAt));
    } catch {
      return formatDateTime(l, expiresAt); // an unknown zone: the server's
    }
  };
  return t(l, `${personal ? 'quiet.broke' : 'quiet.brokeChannel'}.${reason}` as MessageKey, { time: time() });
}

/** For tests and shutdown: wait until queued external sends are done. */
export async function flushNotifications(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  while (pending.size) await Promise.allSettled([...pending]);
  await flushEmails();
}

// ---------- event handlers ----------

export function onTaskCreated(e: DomainEvents['task.created']): void {
  const task = getTask(e.taskId);
  notify({
    event: 'task.assigned',
    text: (l) => ({
      title: t(l, e.dryRun ? 'task.titleDryRun' : 'task.title', { title: e.title }),
      body: t(l, e.fourEyes ? 'task.bodyFourEyes' : 'task.body', { process: e.processName, actor: e.runActor }),
      // the card (ADR 0013): what is decided, and Approve / Reject links that open the dialog in Steward
      parts: taskCardParts(l, { ...e, mode: task.mode, createdAt: task.createdAt }),
    }),
    link: `/runs/${e.runId}`,
    recipients: taskRecipients(e),
    source: sourceOfRun(e.runId),
    about: { kind: 'process', id: e.processId },
    inAppKey: `task:${e.taskId}`,
    externalKey: `task:${e.taskId}`,
    decision: { kind: 'task', id: e.taskId },
    data: {
      taskId: e.taskId,
      runId: e.runId,
      processId: e.processId,
      processName: e.processName,
      assignees: e.assignees,
      fourEyes: e.fourEyes,
      dryRun: e.dryRun,
    },
  });
}

export function onVerificationNeeded(e: DomainEvents['task.verification_needed']): void {
  const round = getTask(e.taskId).manual?.round ?? 1;
  notify({
    event: 'task.assigned',
    text: (l) => ({
      title: t(l, e.dryRun ? 'task.verifyTitleDryRun' : 'task.verifyTitle', { title: titleName(e.title) }),
      body: t(l, 'task.verifyBody', { process: e.processName, user: e.completedBy }),
      // a verification needs the entry and the evidence: Open only
      parts: taskCardParts(l, { taskId: e.taskId, runId: e.runId, processName: e.processName, title: e.title, runActor: e.completedBy, verification: true }),
    }),
    link: `/runs/${e.runId}`,
    recipients: verifierRecipients(e.taskId),
    source: sourceOfRun(e.runId),
    about: { kind: 'process', id: e.processId },
    inAppKey: `task-verify:${e.taskId}:${round}`,
    externalKey: `task-verify:${e.taskId}:${round}`,
    decision: { kind: 'task', id: e.taskId },
    data: {
      taskId: e.taskId,
      runId: e.runId,
      processId: e.processId,
      processName: e.processName,
      completedBy: e.completedBy,
      verification: true,
      dryRun: e.dryRun,
    },
  });
}

export function onTaskReturned(e: DomainEvents['task.returned']): void {
  const all = activeUsers();
  const completer = userNamed(e.completedBy, all);
  const round = getTask(e.taskId).manual?.round ?? 1;
  notify({
    event: 'task.assigned',
    text: (l) => ({
      title: t(l, e.dryRun ? 'task.returnedTitleDryRun' : 'task.returnedTitle', { title: titleName(e.title) }),
      body: t(l, 'task.returnedBody', { process: e.processName, user: e.rejectedBy, comment: e.comment.slice(0, 500) }),
    }),
    link: `/runs/${e.runId}`,
    recipients: completer ? [completer] : [],
    about: { kind: 'process', id: e.processId },
    inAppKey: `task-returned:${e.taskId}:${round}`,
    externalKey: `task-returned:${e.taskId}:${round}`,
    data: { taskId: e.taskId, runId: e.runId, processId: e.processId, processName: e.processName, rejectedBy: e.rejectedBy, returned: true, dryRun: e.dryRun },
  });
}

export function onRunFinished(e: DomainEvents['run.finished']): void {
  // a debug run (ADR 0010) notifies nobody
  if (e.status !== 'failed' || e.debug) return;
  const all = activeUsers();
  const { actor, scheduleOwner, source } = runPeople(e.runId, all);
  notify({
    event: 'run.failed',
    source,
    runId: e.runId,
    text: (l) => ({
      title: t(l, e.dryRun ? 'runFailed.titleDryRun' : 'runFailed.title', { process: e.processName }),
      // The error itself comes from the platform or the engine and stays as it is.
      body: e.error ? t(l, 'runFailed.body', { error: e.error.slice(0, 500) }) : t(l, 'runFailed.bodyNoError'),
    }),
    link: `/runs/${e.runId}`,
    recipients: uniqueUsers([actor, scheduleOwner]),
    inAppKey: `run:${e.runId}`,
    externalKey: e.scheduleId ? `schedule:${e.scheduleId}` : `process:${e.processId}`,
    data: {
      runId: e.runId,
      processId: e.processId,
      processName: e.processName,
      actor: e.actor,
      trigger: e.trigger,
      scheduleId: e.scheduleId ?? null,
      dryRun: e.dryRun,
      error: e.error ?? null,
    },
  });
}

/** What a check is about in a subject: the author's headline, else the check name (#144). */
const checkWhat = (e: { check: string; headline?: string }) => titleName(e.headline || e.check, 120);

/** A runbook as an absolute link: a living document of Steward or an http(s) URL. */
function runbookLink(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (/^rec_[A-Za-z0-9_-]+$/.test(ref)) return absoluteLink(`/records/${ref}`);
  return /^https?:\/\//i.test(ref) ? ref : null;
}

const fmtValue = (l: Locale, v: number): string => new Intl.NumberFormat(l, { maximumFractionDigits: 2 }).format(v);

/** "Schedule “Gatus overview”" – who started the run. */
function sourceLabel(l: Locale, src: RunSource | null, actor?: string): string {
  if (!src) return t(l, 'source.manual', { actor: actor ?? '–' });
  return t(l, `source.${src.kind}`, { name: titleName(src.name) });
}

/** Why this reader gets the message, and where the source's messages are set (#144). */
function reasonParts(
  l: Locale,
  u: UserInfo | undefined,
  o: { source: RunSource | null; processOwner?: UserInfo; actor?: UserInfo; processName: string },
): Pick<MessageParts, 'reason' | 'settings'> {
  const src = o.source;
  const settings = src
    ? { label: t(l, 'messageSettings.source', { kind: t(l, `kind.${src.kind}`) }), href: absoluteLink(src.settingsLink) }
    : { label: t(l, 'messageSettings.routes'), href: absoluteLink('/settings/notifications') };
  let reason: string;
  if (!u) reason = t(l, 'reason.channel');
  else if (src && sameName(u.username, src.owner)) reason = t(l, 'reason.sourceOwner', { kind: t(l, `kind.${src.kind}`), name: titleName(src.name) });
  else if (o.processOwner && u.id === o.processOwner.id) reason = t(l, 'reason.processOwner', { process: titleName(o.processName) });
  else reason = t(l, 'reason.actor');
  return { reason, settings };
}

const ITEMS_SHOWN = 10;

export function onCheckFailed(e: DomainEvents['check.failed']): void {
  const all = activeUsers();
  const { actor, scheduleOwner, source } = runPeople(e.runId, all);
  const owner = userNamed(processAccess(e.processId).owner, all);
  // debug runs: one run by its id (a message that is being sent; debug runs send none)
  const runActor = db().get<{ actor: string }>('SELECT actor FROM runs WHERE id = ?', e.runId)?.actor;
  // runs of a source decided themselves whether this result is news (#127): each message goes out; others keep the hourly limit
  const decided = e.phase === 'new' || e.phase === 'changed' || e.phase === 'reminder' || e.phase === 'pauseEnded';
  const runbook = runbookLink(e.runbook);
  const lead = (l: Locale): string | undefined => {
    const since = e.since ? formatDateTime(l, e.since) : '';
    if (e.phase === 'new') return t(l, 'checkFailed.lead.new') + (e.value !== undefined ? ` · ${fmtValue(l, e.value)}` : '');
    if (e.phase === 'reminder') return t(l, 'checkFailed.lead.reminder', { since });
    if (e.phase === 'pauseEnded') return t(l, 'checkFailed.lead.pauseEnded', { since });
    if (e.phase === 'every') return t(l, 'checkFailed.lead.every') + (e.value !== undefined ? ` · ${fmtValue(l, e.value)}` : '');
    if (e.phase === 'changed') {
      if (e.direction === 'better' || e.direction === 'worse') {
        const from = e.previousValue !== undefined ? fmtValue(l, e.previousValue) : '';
        const to = e.value !== undefined ? fmtValue(l, e.value) : severityLabel(l, e.severity);
        return t(l, `checkFailed.lead.${e.direction}`, { from: from || '–', to, since });
      }
      return t(l, 'checkFailed.lead.changed', { since });
    }
    return undefined;
  };
  notify({
    event: 'check.failed',
    personal: true,
    source,
    runId: e.runId,
    text: (l, u) => ({
      // state first, then where (#144)
      title: t(l, e.dryRun ? 'checkFailed.subjectDryRun' : 'checkFailed.subject', {
        severity: severityLabel(l, e.severity),
        what: checkWhat(e),
        process: titleName(e.processName),
      }),
      body: t(l, 'checkFailed.body', { severity: severityLabel(l, e.severity), message: e.message.slice(0, 500) }),
      parts: {
        lead: lead(l),
        facts: [
          { label: t(l, 'facts.process'), value: e.processName },
          { label: t(l, 'facts.source'), value: sourceLabel(l, source, runActor) },
          ...(e.headline ? [{ label: t(l, 'facts.check'), value: e.check }] : []),
          { label: t(l, 'facts.severity'), value: severityLabel(l, e.severity) },
          ...(e.value !== undefined ? [{ label: t(l, 'facts.value'), value: fmtValue(l, e.value) }] : []),
          ...(e.since ? [{ label: t(l, 'facts.since'), value: formatDateTime(l, e.since) }] : []),
          // text an AI model wrote is marked as such (0.6.0, docs/AI.md)
          ...(e.aiGenerated?.length ? [{ label: t(l, 'facts.aiGenerated'), value: t(l, 'aiGenerated', { models: e.aiGenerated.join(', ') }) }] : []),
        ],
        ...(e.items?.length ? { items: { list: e.items.slice(0, ITEMS_SHOWN), more: Math.max(0, e.items.length - ITEMS_SHOWN) } } : {}),
        ...(runbook ? { actions: [{ label: t(l, 'actions.runbook'), href: runbook }] } : {}),
        ...reasonParts(l, u, { source, processOwner: owner, actor, processName: e.processName }),
      },
    }),
    link: `/runs/${e.runId}`,
    recipients: uniqueUsers([actor, scheduleOwner, owner]),
    inAppKey: `check:${e.runId}:${e.check}`,
    externalKey: decided ? `check:${e.source ?? e.scheduleId}:${e.check}:${e.runId}` : `check:${e.processId}:${e.check}`,
    // held: one item per check of the source, failing and passing again (ADR 0012)
    itemKey: `check:${e.source ?? e.processId}:${e.check}`,
    ...(e.source ? { check: { source: e.source, name: e.check } } : {}),
    data: {
      runId: e.runId,
      processId: e.processId,
      processName: e.processName,
      check: e.check,
      severity: e.severity,
      message: e.message,
      dryRun: e.dryRun,
      ...(e.phase ? { phase: e.phase, scheduleId: e.scheduleId ?? null, since: e.since } : {}),
      // the content of #144 as data; null when the process does not say
      headline: e.headline ?? null,
      value: e.value ?? null,
      previousValue: e.previousValue ?? null,
      direction: e.direction ?? null,
      items: e.items ?? [],
      runbook,
      source: source ? { kind: source.kind, id: source.id, name: source.name, ...(source.output ? { output: source.output } : {}) } : null,
      ...(e.aiGenerated?.length ? { aiGenerated: e.aiGenerated } : {}),
    },
  });
}

export function onCheckResolved(e: DomainEvents['check.resolved']): void {
  const all = activeUsers();
  const { actor, scheduleOwner, source } = runPeople(e.runId, all);
  const owner = userNamed(processAccess(e.processId).owner, all);
  // debug runs: one run by its id (a message that is being sent; debug runs send none)
  const runActor = db().get<{ actor: string }>('SELECT actor FROM runs WHERE id = ?', e.runId)?.actor;
  notify({
    event: 'check.resolved',
    personal: true,
    source,
    runId: e.runId,
    text: (l, u) => ({
      title: t(l, e.dryRun ? 'checkResolved.subjectDryRun' : 'checkResolved.subject', { check: titleName(e.check), process: titleName(e.processName) }),
      body: '',
      parts: {
        lead: t(l, 'checkResolved.lead', { since: formatDateTime(l, e.since) }),
        facts: [
          { label: t(l, 'facts.process'), value: e.processName },
          { label: t(l, 'facts.source'), value: sourceLabel(l, source, runActor) },
          ...(e.value !== undefined ? [{ label: t(l, 'facts.value'), value: fmtValue(l, e.value) }] : []),
        ],
        ...reasonParts(l, u, { source, processOwner: owner, actor, processName: e.processName }),
      },
    }),
    link: `/runs/${e.runId}`,
    recipients: uniqueUsers([actor, scheduleOwner, owner]),
    inAppKey: `check-resolved:${e.runId}:${e.check}`,
    externalKey: `check-resolved:${e.source ?? e.scheduleId}:${e.check}:${e.runId}`,
    itemKey: `check:${e.source ?? e.processId}:${e.check}`,
    ...(e.source ? { check: { source: e.source, name: e.check } } : {}),
    data: {
      runId: e.runId,
      processId: e.processId,
      processName: e.processName,
      check: e.check,
      dryRun: e.dryRun,
      scheduleId: e.scheduleId ?? null,
      since: e.since,
      value: e.value ?? null,
      source: source ? { kind: source.kind, id: source.id, name: source.name, ...(source.output ? { output: source.output } : {}) } : null,
    },
  });
}

const severityLabel = (l: Locale, severity: string): string =>
  severity === 'error' || severity === 'warning' || severity === 'info' ? t(l, `severity.${severity}`) : severity;

function skipReason(l: Locale, e: DomainEvents['schedule.skipped']): string {
  if (!e.reasonCode) return e.reason;
  const vars = { ...e.reasonVars };
  if (vars.status === 'queued' || vars.status === 'running' || vars.status === 'waiting') vars.status = t(l, `runStatus.${vars.status}`);
  return t(l, `scheduleSkipped.reasons.${e.reasonCode}`, vars);
}

/** "Missed while Steward was not running": the first missed fires in the recipient's language, and whether a catch-up run starts. */
function missedText(
  l: Locale,
  e: DomainEvents['schedule.skipped'],
  m: NonNullable<DomainEvents['schedule.skipped']['missed']>,
): { title: string; body: string } {
  const listed =
    m.times.map((x) => formatDateTime(l, x)).join(', ') + (m.count > m.times.length ? ` (${t(l, 'scheduleMissed.more', { count: m.count })})` : '');
  return {
    title: t(l, 'scheduleMissed.title', { name: e.name }),
    body: `${t(l, 'scheduleMissed.body', { times: listed })} ${t(l, m.catchUp ? 'scheduleMissed.catchUp' : 'scheduleMissed.noCatchUp')}`,
  };
}

export function onScheduleSkipped(e: DomainEvents['schedule.skipped']): void {
  const all = activeUsers();
  notify({
    event: 'schedule.skipped',
    text: (l) =>
      e.missed
        ? missedText(l, e, e.missed)
        : { title: t(l, 'scheduleSkipped.title', { name: e.name }), body: t(l, 'scheduleSkipped.body', { reason: skipReason(l, e) }) },
    link: '/schedules',
    recipients: uniqueUsers([userNamed(e.owner, all), ...admins(all)]),
    inAppKey: `schedule:${e.scheduleId}`,
    externalKey: `schedule:${e.scheduleId}`,
    data: { scheduleId: e.scheduleId, name: e.name, owner: e.owner, reason: e.reason },
  });
}

/** The periodic connection test of a platform started failing (v0.4.0, platforms/health.ts): its managers, once per failing period. */
export function notifyPlatformFailing(e: { platformId: string; name: string; message: string; since: string; recipients: UserInfo[] }): void {
  notify({
    event: 'platform.failing',
    text: (l) => ({
      title: t(l, 'platformFailing.title', { name: titleName(e.name) }),
      body: t(l, 'platformFailing.body', { name: e.name, message: e.message.slice(0, 500), since: formatDateTime(l, e.since) }),
    }),
    link: `/platforms/${encodeURIComponent(e.platformId)}`,
    recipients: e.recipients,
    inAppKey: `platform:${e.platformId}:${e.since}`,
    externalKey: `platform:${e.platformId}`,
    data: { platformId: e.platformId, name: e.name, message: e.message.slice(0, 500), since: e.since },
    about: { kind: 'platform', id: e.platformId },
  });
}

/**
 * An AI budget reached 80 % or is used up (0.6.0, ai/usage.ts): once per budget, period and level – to the
 * administrators, for a gateway's budget also its managers, for a process's budget its owner.
 */
export function notifyAiBudget(n: { use: AiBudgetUse; level: 80 | 100; period: 'day' | 'month' }): void {
  const all = activeUsers();
  const { use, level, period } = n;
  const extra: (UserInfo | undefined)[] = [];
  if (use.scope === 'platform') {
    const r = db().get<{ acl: string }>('SELECT acl FROM platforms WHERE id = ?', use.scopeId);
    const acl = parseJson(r?.acl, []);
    extra.push(...all.filter((u) => platformPermissions(toAuthUser(u), { id: use.scopeId, acl }).includes('manage')));
  }
  if (use.scope === 'process') extra.push(userNamed(processAccess(use.scopeId).owner, all));
  const limit = (period === 'day' ? use.tokensPerDay : use.tokensPerMonth) ?? 0;
  const spent = period === 'day' ? use.usedToday : use.usedThisMonth;
  const name = (l: Locale) => (use.scope === 'installation' ? t(l, 'aiBudget.installation') : t(l, `aiBudget.${use.scope}`, { name: use.name }));
  const stamp = period === 'day' ? nowIso().slice(0, 10) : nowIso().slice(0, 7);
  notify({
    event: 'ai.budget',
    text: (l) => ({
      title: t(l, level === 100 ? 'aiBudget.title100' : 'aiBudget.title80', { name: titleName(name(l)) }),
      body: t(l, level === 100 ? 'aiBudget.body100' : 'aiBudget.body80', {
        name: name(l),
        used: spent.toLocaleString(l),
        limit: limit.toLocaleString(l),
        period: t(l, `aiBudget.${period}`),
      }),
    }),
    link:
      use.scope === 'platform'
        ? `/platforms/${encodeURIComponent(use.scopeId)}?tab=ai-usage`
        : use.scope === 'process'
          ? `/processes/${encodeURIComponent(use.scopeId)}`
          : '/settings',
    recipients: uniqueUsers([...admins(all), ...extra]),
    inAppKey: `ai:${use.scope}:${use.scopeId}:${stamp}:${level}`,
    externalKey: `ai:${use.scope}:${use.scopeId}:${stamp}:${level}`,
    data: { scope: use.scope, scopeId: use.scopeId, name: use.name, level, period, used: spent, limit },
    ...(use.scope === 'platform' ? { about: { kind: 'platform' as const, id: use.scopeId } } : {}),
  });
}

/**
 * A monthly cost budget reached 80 % or 100 % (0.9.0, #226, costs/budgets.ts): once per budget, month and level – to
 * the owners of the service or application and the members of its owning teams (of a team: its members), who see its
 * amounts; to the administrators when nobody else is. A recipient who does not see every application of the service or
 * team reads the state only (the budget covers them all: the figures would give away the costs of the others).
 */
export function notifyCostBudget(n: BudgetNotice): void {
  const all = activeUsers();
  const owners = all.filter((u) => {
    if (u.roles.includes('admin')) return false;
    const i = costScopeInfo(n.scope, n.scopeId, toAuthUser(u));
    return !!i?.owner && i.amounts;
  });
  const recipients = owners.length ? owners : admins(all);
  const b = n.budget;
  const money = (l: Locale, v: string | null) =>
    v === null ? '' : `${Number(v).toLocaleString(l, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${b.currency}`;
  const name = (l: Locale) => t(l, `costBudget.${n.scope}`, { name: n.name });
  const forecast = (l: Locale) =>
    b.forecastPct === null || b.amount === null
      ? t(l, 'costBudget.noForecast')
      : `${money(l, String((Number(b.amount) * b.forecastPct) / 100))} (${b.forecastPct} %)`;
  const link = `/costs/${n.scope}/${encodeURIComponent(n.scopeId)}`;
  const whole = new Map(recipients.map((u) => [u.id, costSeesWholeScope(n.scope, n.scopeId, toAuthUser(u))]));
  notify({
    event: 'cost.budget',
    personal: true,
    text: (l, u) => ({
      title: t(l, n.level === 100 ? 'costBudget.title100' : 'costBudget.title80', { name: titleName(name(l)) }),
      body:
        u && whole.get(u.id) === false
          ? t(l, n.level === 100 ? 'costBudget.body100State' : 'costBudget.body80State', { name: name(l) })
          : t(l, n.level === 100 ? 'costBudget.body100' : 'costBudget.body80', {
              name: name(l),
              used: money(l, b.used),
              limit: money(l, b.amount),
              pct: (b.pct ?? 0).toLocaleString(l),
              forecast: forecast(l),
            }),
    }),
    link,
    recipients: uniqueUsers(recipients),
    inAppKey: `cost:${n.scope}:${n.scopeId}:${n.month}:${n.level}`,
    externalKey: `cost:${n.scope}:${n.scopeId}:${n.month}:${n.level}`,
    data: {
      scope: n.scope,
      scopeId: n.scopeId,
      name: n.name,
      level: n.level,
      month: n.month,
      used: b.used,
      budget: b.amount,
      currency: b.currency,
      pct: b.pct,
    },
  });
}

/**
 * Reports each stale partition of a dataset once per stale period (a new publish starts a new period, #142): when the
 * publish step sets `staleAfterMinutes`, or a schedule feeds the partition (2.5 × its interval). Returns how many.
 */
export function checkStaleDatasets(now = Date.now()): number {
  let reported = 0;
  for (const p of allParts()) {
    if (!p.notify || now - Date.parse(p.source.updatedAt) <= p.source.staleAfterMinutes * 60000) continue;
    const key = p.source.id === 'instance' ? p.key : `${p.key}#${p.source.id}`;
    const done = db().get<{ updated_at: string }>('SELECT updated_at FROM notification_stale WHERE dataset_key = ?', key);
    if (done?.updated_at === p.source.updatedAt) continue;
    db().run(
      `INSERT INTO notification_stale (dataset_key, updated_at, notified_at) VALUES (?, ?, ?)
       ON CONFLICT(dataset_key) DO UPDATE SET updated_at = excluded.updated_at, notified_at = excluded.notified_at`,
      key,
      p.source.updatedAt,
      nowIso(),
    );
    const all = activeUsers();
    const title = p.source.id === 'instance' ? p.title : `${p.title} (${p.source.name})`;
    notify({
      event: 'dataset.stale',
      text: (l) => ({
        title: t(l, 'datasetStale.title', { title }),
        body: t(l, 'datasetStale.body', {
          title,
          updatedAt: formatDateTime(l, p.source.updatedAt),
          process: p.processName,
          limit: t(l, 'common.minutes', { count: p.source.staleAfterMinutes }),
        }),
      }),
      link: '/dashboards',
      recipients: uniqueUsers([userNamed(processAccess(p.processId).owner, all), ...admins(all)]),
      inAppKey: `dataset:${key}:${p.source.updatedAt}`,
      externalKey: `dataset:${key}`,
      data: {
        dataset: p.key,
        title: p.title,
        processId: p.processId,
        updatedAt: p.source.updatedAt,
        staleAfterMinutes: p.source.staleAfterMinutes,
        source: { id: p.source.id, name: p.source.name, platformIds: p.source.platformIds },
      },
      source: p.source.runId ? sourceOfRun(p.source.runId) : null,
    });
    reported++;
  }
  return reported;
}

// ---------- wiring ----------

/** Run handlers after the producer's current step (outside its transaction); never throw into it. */
function deferred<T>(name: string, fn: (e: T) => void): (e: T) => void {
  return (e) =>
    void setImmediate(() => {
      try {
        fn(e);
      } catch (err) {
        logger.warn({ err, event: name }, 'notification handler failed');
      }
    });
}

let subscribed = false;
/** Subscribes to the domain events (idempotent). */
export function initNotifications(): void {
  if (subscribed) return;
  subscribed = true;
  on('task.created', deferred('task.created', onTaskCreated));
  on('task.verification_needed', deferred('task.verification_needed', onVerificationNeeded));
  on('task.returned', deferred('task.returned', onTaskReturned));
  on('run.finished', deferred('run.finished', onRunFinished));
  on('check.failed', deferred('check.failed', onCheckFailed));
  on('check.resolved', deferred('check.resolved', onCheckResolved));
  on('schedule.skipped', deferred('schedule.skipped', onScheduleSkipped));
  onBudgetNotice(notifyAiBudget);
  onCostBudgetNotice(notifyCostBudget);
  on('dataset.published', (e) => {
    // a partition's new publish starts its own period (its updated_at changes); others keep theirs
    db().run('DELETE FROM notification_stale WHERE dataset_key = ?', e.key);
  });
}

// The periodic checks (stale datasets, reminders, integrations, daily summaries …) are background jobs: the manifests of their features (features/).

/** The test message (also the sample of the look preview). */
function testMessage(name: string): OutgoingMessage {
  const locale = defaultLocale();
  return {
    event: 'test',
    title: t(locale, 'test.title'),
    body: t(locale, 'test.body', { brand: name }),
    locale,
    link: absoluteLink('/'),
    ts: nowIso(),
    data: { test: true },
  };
}

/** A failed dry run, as the preview of how dry runs look (never sent). */
function dryRunSample(): OutgoingMessage {
  const locale = defaultLocale();
  const process = t(locale, 'dryRun.sampleProcess');
  return {
    event: 'run.failed',
    title: t(locale, 'runFailed.titleDryRun', { process }),
    body: t(locale, 'runFailed.body', { error: t(locale, 'dryRun.sampleError') }),
    locale,
    link: absoluteLink('/runs'),
    ts: nowIso(),
    data: { dryRun: true },
  };
}

/** The test message (or a failed dry run) as an e-mail and a Teams card with unsaved look settings (nothing is sent or stored). */
export function previewLook(draft: Partial<NotificationLookInput>, sample: 'test' | 'dryRun' = 'test'): NotificationLookPreview {
  const problems = lookProblems(draft);
  if (problems.length) throw new HttpError(400, problems.join('; '), 'NOTIFICATION_LOOK_INVALID');
  const look = resolveLook(draft);
  const msg = sample === 'dryRun' ? dryRunSample() : testMessage(look.name);
  const mail = emailContent(msg, look, look.logo ? logoDataUrl(look.logo) : undefined);
  return { subject: mail.subject, html: mail.html, teams: teamsCard(msg, look) };
}

/** Sends a test message to a team's own channel (#136). */
export async function sendTeamTest(teamId: string): Promise<{ ok: boolean; error?: string }> {
  const url = teamChannelUrl(teamId);
  if (!url) return { ok: false, error: 'No URL is stored for this team' };
  const r = db().get<{ channel: string | null }>('SELECT channel FROM team_settings WHERE team_id = ?', teamId);
  const format = parseJson<{ format?: string } | null>(r?.channel, null)?.format ?? 'teams';
  try {
    const msg = testMessage(resolveLook().name);
    if (format === 'teams') await sendTeams(url, msg);
    else await sendWebhook(url, msg);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

/** Sends a test message on one channel (ignores routes and de-duplication). */
export async function sendTest(channel: 'email' | 'teams' | 'webhook', to: string | undefined): Promise<{ ok: boolean; error?: string }> {
  const settings = getNotificationSettings();
  const msg = testMessage(resolveLook().name);
  try {
    const secrets = channelSecrets();
    if (channel === 'email') {
      if (!settings.email.host || !settings.email.from) return { ok: false, error: 'Configure the SMTP host and sender address first' };
      if (!to) return { ok: false, error: 'Enter a recipient address (your profile has no e-mail address)' };
      await sendEmail(settings.email, secrets, to, msg);
    } else if (channel === 'teams') {
      if (!secrets.teamsWebhookUrl) return { ok: false, error: 'No Teams webhook URL is stored' };
      await sendTeams(secrets.teamsWebhookUrl, msg);
    } else {
      if (!secrets.webhookUrl) return { ok: false, error: 'No webhook URL is stored' };
      if (getNotificationSettings().webhook.format === 'teams') await sendTeams(secrets.webhookUrl, msg);
      else await sendWebhook(secrets.webhookUrl, msg);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}
