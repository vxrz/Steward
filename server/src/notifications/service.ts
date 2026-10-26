import type { AclEntry, Locale, NotificationEvent, ProcessPermission, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { on, type DomainEvents } from '../events.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso, parseJson } from '../util.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { matches, processPermissions, verificationCheck } from '../auth/permissions.js';
import { getTask } from '../engine/store.js';
import { absoluteLink, channelSecrets, getNotificationSettings } from './settings.js';
import { addInApp, claimSend } from './store.js';
import { sendEmail, sendTeams, sendWebhook, type OutgoingMessage } from './channels.js';
import { BRAND } from '@sm/shared';
import { getSettings } from '../settings.js';
import { formatDateTime, resolveLocale, t } from '../i18n/index.js';
import { allowedDomainRules, domainAllowed } from './domains.js';

/** Same event + entity within this window → no second e-mail/Teams/webhook message (and no second in-app entry for the same key). */
export const DEDUPE_WINDOW_MS = 60 * 60000;
const STALE_CHECK_MS = 5 * 60000;

export interface NoticeText {
  title: string;
  body: string;
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

function processAccess(processId: string): { owner: string | null; acl: AclEntry<ProcessPermission>[] } {
  const r = db().get<{ owner: string | null; acl: string }>('SELECT owner, acl FROM processes WHERE id = ?', processId);
  return { owner: r?.owner ?? null, acl: parseJson(r?.acl, []) };
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

function runPeople(runId: string, all: UserInfo[]): { actor?: UserInfo; scheduleOwner?: UserInfo } {
  const r = db().get<{ actor: string; schedule_id: string | null }>('SELECT actor, schedule_id FROM runs WHERE id = ?', runId);
  if (!r) return {};
  const owner = r.schedule_id ? db().get<{ owner: string | null }>('SELECT owner FROM schedules WHERE id = ?', r.schedule_id)?.owner : null;
  return { actor: userNamed(r.actor, all), scheduleOwner: userNamed(owner, all) };
}

// ---------- language ----------

/** Language for channel posts (Teams, webhook) and for users who have not chosen one. */
export const defaultLocale = (): Locale => resolveLocale(getSettings().defaultLocale);
/** The recipient's chosen language, else the default language. */
export const userLocale = (u: UserInfo, fallback = defaultLocale()): Locale => resolveLocale(u.locale, fallback);

// ---------- delivery ----------

const pending = new Set<Promise<void>>();

/** Stores in-app notifications and sends the external messages (in the background; failures are only logged). */
export function notify(n: Notice): void {
  if (!n.recipients.length && !n.emails?.length) return;
  const settings = getNotificationSettings();
  const channels = settings.routes[n.event] ?? [];
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
        addInApp(u.id, { event: n.event, title: m.title, body: m.body, link: n.link, dedupeKey: `${n.event}:${n.inAppKey}` }, DEDUPE_WINDOW_MS);
      } catch (err) {
        logger.warn({ err, event: n.event }, 'could not store notification');
      }
    }
  }
  const external = channels.filter((c) => c !== 'inApp' && settings[c].enabled);
  if (!external.length) return;
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
  const jobs: { channel: string; to?: string; send: () => Promise<void> }[] = [];
  let secrets: ReturnType<typeof channelSecrets>;
  try {
    secrets = channelSecrets();
  } catch (err) {
    logger.warn({ err, event: n.event }, 'notification not sent: channel settings unreadable');
    return;
  }
  if (external.includes('email')) {
    for (const u of n.recipients) {
      if (!u.email || !u.emailNotifications) continue;
      if (claimSend(`email:${key}:${u.id}`, DEDUPE_WINDOW_MS)) {
        const msg = message(userLocale(u, fallback), u);
        jobs.push({ channel: 'email', to: u.username, send: () => sendEmail(settings.email, secrets, u.email!, msg) });
      }
    }
    const userAddresses = new Set(n.recipients.map((u) => u.email?.toLowerCase()).filter(Boolean));
    const rules = n.emails?.length ? allowedDomainRules() : [];
    let refused = 0;
    for (const addr of new Set((n.emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e)))) {
      if (userAddresses.has(addr)) continue; // already reached as a Steward user (with their own settings)
      if (!domainAllowed(addr, rules)) {
        refused++;
        continue;
      }
      if (claimSend(`email:${key}:${addr}`, DEDUPE_WINDOW_MS)) {
        const msg = message(fallback);
        jobs.push({ channel: 'email', to: 'external address', send: () => sendEmail(settings.email, secrets, addr, msg) });
      }
    }
    if (refused) logger.warn({ event: n.event, refused }, 'e-mail not sent to addresses outside the allowed domains');
  }
  if (external.includes('teams') && secrets.teamsWebhookUrl && claimSend(`teams:${key}`, DEDUPE_WINDOW_MS)) {
    const msg = message(fallback);
    jobs.push({ channel: 'teams', send: () => sendTeams(secrets.teamsWebhookUrl!, msg) });
  }
  if (external.includes('webhook') && secrets.webhookUrl && claimSend(`webhook:${key}`, DEDUPE_WINDOW_MS)) {
    const msg = message(fallback);
    jobs.push({ channel: 'webhook', send: () => sendWebhook(secrets.webhookUrl!, msg) });
  }
  for (const j of jobs) {
    const p = j
      .send()
      .then(() => logger.debug({ event: n.event, channel: j.channel, to: j.to }, 'notification sent'))
      .catch((err) => logger.warn({ err: { message: (err as Error).message }, event: n.event, channel: j.channel, to: j.to }, 'notification could not be sent'))
      .finally(() => pending.delete(p));
    pending.add(p);
  }
}

/** For tests and shutdown: wait until queued external sends are done. */
export async function flushNotifications(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  while (pending.size) await Promise.allSettled([...pending]);
}

// ---------- event handlers ----------

export function onTaskCreated(e: DomainEvents['task.created']): void {
  notify({
    event: 'task.assigned',
    text: (l) => ({
      title: t(l, 'task.title', { title: e.title }),
      body: t(l, e.fourEyes ? 'task.bodyFourEyes' : 'task.body', { process: e.processName, actor: e.runActor }),
    }),
    link: `/runs/${e.runId}`,
    recipients: taskRecipients(e),
    inAppKey: `task:${e.taskId}`,
    externalKey: `task:${e.taskId}`,
    data: { taskId: e.taskId, runId: e.runId, processId: e.processId, processName: e.processName, assignees: e.assignees, fourEyes: e.fourEyes },
  });
}

export function onVerificationNeeded(e: DomainEvents['task.verification_needed']): void {
  const round = getTask(e.taskId).manual?.round ?? 1;
  notify({
    event: 'task.assigned',
    text: (l) => ({
      title: t(l, 'task.verifyTitle', { title: titleName(e.title) }),
      body: t(l, 'task.verifyBody', { process: e.processName, user: e.completedBy }),
    }),
    link: `/runs/${e.runId}`,
    recipients: verifierRecipients(e.taskId),
    inAppKey: `task-verify:${e.taskId}:${round}`,
    externalKey: `task-verify:${e.taskId}:${round}`,
    data: { taskId: e.taskId, runId: e.runId, processId: e.processId, processName: e.processName, completedBy: e.completedBy, verification: true },
  });
}

export function onTaskReturned(e: DomainEvents['task.returned']): void {
  const all = activeUsers();
  const completer = userNamed(e.completedBy, all);
  const round = getTask(e.taskId).manual?.round ?? 1;
  notify({
    event: 'task.assigned',
    text: (l) => ({
      title: t(l, 'task.returnedTitle', { title: titleName(e.title) }),
      body: t(l, 'task.returnedBody', { process: e.processName, user: e.rejectedBy, comment: e.comment.slice(0, 500) }),
    }),
    link: `/runs/${e.runId}`,
    recipients: completer ? [completer] : [],
    inAppKey: `task-returned:${e.taskId}:${round}`,
    externalKey: `task-returned:${e.taskId}:${round}`,
    data: { taskId: e.taskId, runId: e.runId, processId: e.processId, processName: e.processName, rejectedBy: e.rejectedBy, returned: true },
  });
}

export function onRunFinished(e: DomainEvents['run.finished']): void {
  if (e.status !== 'failed') return;
  const all = activeUsers();
  const { actor, scheduleOwner } = runPeople(e.runId, all);
  notify({
    event: 'run.failed',
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

export function onCheckFailed(e: DomainEvents['check.failed']): void {
  const all = activeUsers();
  const { actor, scheduleOwner } = runPeople(e.runId, all);
  const owner = userNamed(processAccess(e.processId).owner, all);
  notify({
    event: 'check.failed',
    text: (l) => ({
      title: t(l, e.dryRun ? 'checkFailed.titleDryRun' : 'checkFailed.title', { check: e.check, process: e.processName }),
      body: t(l, 'checkFailed.body', { severity: severityLabel(l, e.severity), message: e.message.slice(0, 500) }),
    }),
    link: `/runs/${e.runId}`,
    recipients: uniqueUsers([actor, scheduleOwner, owner]),
    inAppKey: `check:${e.runId}:${e.check}`,
    externalKey: `check:${e.processId}:${e.check}`,
    data: { runId: e.runId, processId: e.processId, processName: e.processName, check: e.check, severity: e.severity, message: e.message, dryRun: e.dryRun },
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

export function onScheduleSkipped(e: DomainEvents['schedule.skipped']): void {
  const all = activeUsers();
  notify({
    event: 'schedule.skipped',
    text: (l) => ({ title: t(l, 'scheduleSkipped.title', { name: e.name }), body: t(l, 'scheduleSkipped.body', { reason: skipReason(l, e) }) }),
    link: '/schedules',
    recipients: uniqueUsers([userNamed(e.owner, all), ...admins(all)]),
    inAppKey: `schedule:${e.scheduleId}`,
    externalKey: `schedule:${e.scheduleId}`,
    data: { scheduleId: e.scheduleId, name: e.name, owner: e.owner, reason: e.reason },
  });
}

/** Reports each dataset once per stale period (a new publish starts a new period). Returns how many were reported. */
export function checkStaleDatasets(now = Date.now()): number {
  const rows = db().all<{ key: string; title: string; process_id: string; process_name: string; updated_at: string; stale_after_minutes: number }>(
    'SELECT key, title, process_id, process_name, updated_at, stale_after_minutes FROM datasets WHERE stale_after_minutes > 0',
  );
  let reported = 0;
  for (const r of rows) {
    if (now - Date.parse(r.updated_at) <= r.stale_after_minutes * 60000) continue;
    const done = db().get<{ updated_at: string }>('SELECT updated_at FROM notification_stale WHERE dataset_key = ?', r.key);
    if (done?.updated_at === r.updated_at) continue;
    db().run(
      `INSERT INTO notification_stale (dataset_key, updated_at, notified_at) VALUES (?, ?, ?)
       ON CONFLICT(dataset_key) DO UPDATE SET updated_at = excluded.updated_at, notified_at = excluded.notified_at`,
      r.key,
      r.updated_at,
      nowIso(),
    );
    const all = activeUsers();
    notify({
      event: 'dataset.stale',
      text: (l) => ({
        title: t(l, 'datasetStale.title', { title: r.title }),
        body: t(l, 'datasetStale.body', {
          title: r.title,
          updatedAt: formatDateTime(l, r.updated_at),
          process: r.process_name,
          limit: t(l, 'common.minutes', { count: r.stale_after_minutes }),
        }),
      }),
      link: '/dashboards',
      recipients: uniqueUsers([userNamed(processAccess(r.process_id).owner, all), ...admins(all)]),
      inAppKey: `dataset:${r.key}:${r.updated_at}`,
      externalKey: `dataset:${r.key}`,
      data: { dataset: r.key, title: r.title, processId: r.process_id, updatedAt: r.updated_at, staleAfterMinutes: r.stale_after_minutes },
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
  on('schedule.skipped', deferred('schedule.skipped', onScheduleSkipped));
  on('dataset.published', (e) => {
    db().run('DELETE FROM notification_stale WHERE dataset_key = ?', e.key);
  });
}

let staleTimer: NodeJS.Timeout | undefined;
export function startNotificationJobs(): void {
  if (staleTimer) return;
  staleTimer = setInterval(() => {
    try {
      checkStaleDatasets();
    } catch (err) {
      logger.warn({ err }, 'stale dataset check failed');
    }
    // credentials register: expiry / rotation / review reminders (idempotent, see credentials/reminders.ts)
    import('../credentials/reminders.js').then((m) => m.checkCredentialReminders()).catch((err) => logger.warn({ err }, 'credential reminder check failed'));
    // living documents: periodic review reminders, same schedule as the credentials register (records/documents.ts)
    import('../records/documents.js').then((m) => m.checkDocumentReviews()).catch((err) => logger.warn({ err }, 'document review reminder check failed'));
    // ticket references: "not checked for N days" reminders (tickets/reminders.ts); daily summaries (summary.ts) – both idempotent
    import('../tickets/reminders.js').then((m) => m.checkTicketReminders()).catch((err) => logger.warn({ err }, 'ticket reminder check failed'));
    // service duties: store and close periods, reminders and "missed" messages (duties/jobs.ts, idempotent)
    import('../duties/jobs.js').then((m) => m.runDutyJob()).catch((err) => logger.warn({ err }, 'duty job failed'));
    // availability objectives and the service scorecard: hourly samples, breaches, daily snapshots (scorecard/jobs.ts, idempotent)
    import('../scorecard/jobs.js').then((m) => m.runScorecardJob()).catch((err) => logger.warn({ err }, 'scorecard job failed'));
    import('./summary.js').then((m) => m.runDailySummaries()).catch((err) => logger.warn({ err }, 'daily summary job failed'));
  }, STALE_CHECK_MS);
  staleTimer.unref();
}

export function stopNotificationJobs(): void {
  if (staleTimer) clearInterval(staleTimer);
  staleTimer = undefined;
}

/** Sends a test message on one channel (ignores routes and de-duplication). */
export async function sendTest(channel: 'email' | 'teams' | 'webhook', to: string | undefined): Promise<{ ok: boolean; error?: string }> {
  const settings = getNotificationSettings();
  const locale = defaultLocale();
  const msg: OutgoingMessage = {
    event: 'test',
    title: t(locale, 'test.title'),
    body: t(locale, 'test.body', { brand: BRAND.name }),
    locale,
    link: absoluteLink('/'),
    ts: nowIso(),
    data: { test: true },
  };
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
      await sendWebhook(secrets.webhookUrl, msg);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}
