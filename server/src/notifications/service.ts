import type { AclEntry, NotificationEvent, ProcessPermission, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { on, type DomainEvents } from '../events.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso, parseJson } from '../util.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { matches, processPermissions } from '../auth/permissions.js';
import { absoluteLink, channelSecrets, getNotificationSettings } from './settings.js';
import { addInApp, claimSend } from './store.js';
import { sendEmail, sendTeams, sendWebhook, type OutgoingMessage } from './channels.js';
import { BRAND } from '@sm/shared';

/** Same event + entity within this window → no second e-mail/Teams/webhook message (and no second in-app entry for the same key). */
export const DEDUPE_WINDOW_MS = 60 * 60000;
const STALE_CHECK_MS = 5 * 60000;

export interface Notice {
  event: NotificationEvent;
  title: string;
  body: string;
  /** In-app path, e.g. /runs/run_123 */
  link?: string;
  recipients: UserInfo[];
  /** De-duplicates in-app entries per user */
  inAppKey: string;
  /** De-duplicates external sends (coarser, e.g. per process or schedule) */
  externalKey: string;
  data?: Record<string, unknown>;
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

function runPeople(runId: string, all: UserInfo[]): { actor?: UserInfo; scheduleOwner?: UserInfo } {
  const r = db().get<{ actor: string; schedule_id: string | null }>('SELECT actor, schedule_id FROM runs WHERE id = ?', runId);
  if (!r) return {};
  const owner = r.schedule_id ? db().get<{ owner: string | null }>('SELECT owner FROM schedules WHERE id = ?', r.schedule_id)?.owner : null;
  return { actor: userNamed(r.actor, all), scheduleOwner: userNamed(owner, all) };
}

// ---------- delivery ----------

const pending = new Set<Promise<void>>();

/** Stores in-app notifications and sends the external messages (in the background; failures are only logged). */
export function notify(n: Notice): void {
  if (!n.recipients.length) return;
  const settings = getNotificationSettings();
  const channels = settings.routes[n.event] ?? [];
  if (channels.includes('inApp')) {
    for (const u of n.recipients) {
      try {
        addInApp(u.id, { event: n.event, title: n.title, body: n.body, link: n.link, dedupeKey: `${n.event}:${n.inAppKey}` }, DEDUPE_WINDOW_MS);
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
  const msg: OutgoingMessage = { event: n.event, title: n.title, body: n.body, link: absoluteLink(n.link), ts: nowIso(), data: n.data };
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
        jobs.push({ channel: 'email', to: u.username, send: () => sendEmail(settings.email, secrets, u.email!, msg) });
      }
    }
  }
  if (external.includes('teams') && secrets.teamsWebhookUrl && claimSend(`teams:${key}`, DEDUPE_WINDOW_MS)) {
    jobs.push({ channel: 'teams', send: () => sendTeams(secrets.teamsWebhookUrl!, msg) });
  }
  if (external.includes('webhook') && secrets.webhookUrl && claimSend(`webhook:${key}`, DEDUPE_WINDOW_MS)) {
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
    title: `Decision needed: ${e.title}`,
    body: `The run of "${e.processName}" (started by ${e.runActor}) waits for your decision.${e.fourEyes ? ' Four-eyes principle: the starter may not decide.' : ''}`,
    link: `/runs/${e.runId}`,
    recipients: taskRecipients(e),
    inAppKey: `task:${e.taskId}`,
    externalKey: `task:${e.taskId}`,
    data: { taskId: e.taskId, runId: e.runId, processId: e.processId, processName: e.processName, assignees: e.assignees, fourEyes: e.fourEyes },
  });
}

export function onRunFinished(e: DomainEvents['run.finished']): void {
  if (e.status !== 'failed') return;
  const all = activeUsers();
  const { actor, scheduleOwner } = runPeople(e.runId, all);
  notify({
    event: 'run.failed',
    title: `Run failed: ${e.processName}${e.dryRun ? ' (dry run)' : ''}`,
    body: e.error ? `Error: ${e.error.slice(0, 500)}` : 'The run failed.',
    link: `/runs/${e.runId}`,
    recipients: uniqueUsers([actor, scheduleOwner]),
    inAppKey: `run:${e.runId}`,
    externalKey: e.scheduleId ? `schedule:${e.scheduleId}` : `process:${e.processId}`,
    data: { runId: e.runId, processId: e.processId, processName: e.processName, actor: e.actor, trigger: e.trigger, scheduleId: e.scheduleId ?? null, dryRun: e.dryRun, error: e.error ?? null },
  });
}

export function onCheckFailed(e: DomainEvents['check.failed']): void {
  const all = activeUsers();
  const { actor, scheduleOwner } = runPeople(e.runId, all);
  const owner = userNamed(processAccess(e.processId).owner, all);
  notify({
    event: 'check.failed',
    title: `Check failed: ${e.check} in ${e.processName}${e.dryRun ? ' (dry run)' : ''}`,
    body: `${e.severity}: ${e.message.slice(0, 500)}`,
    link: `/runs/${e.runId}`,
    recipients: uniqueUsers([actor, scheduleOwner, owner]),
    inAppKey: `check:${e.runId}:${e.check}`,
    externalKey: `check:${e.processId}:${e.check}`,
    data: { runId: e.runId, processId: e.processId, processName: e.processName, check: e.check, severity: e.severity, message: e.message, dryRun: e.dryRun },
  });
}

export function onScheduleSkipped(e: DomainEvents['schedule.skipped']): void {
  const all = activeUsers();
  notify({
    event: 'schedule.skipped',
    title: `Schedule skipped: ${e.name}`,
    body: `The schedule did not start a run: ${e.reason}.`,
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
      title: `Dashboard data is stale: ${r.title}`,
      body: `"${r.title}" was last updated ${r.updated_at} by "${r.process_name}" (freshness limit ${r.stale_after_minutes} minutes).`,
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
  const msg: OutgoingMessage = {
    event: 'test',
    title: 'Test notification',
    body: `If you can read this, notifications from ${BRAND.name} reach this channel.`,
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
