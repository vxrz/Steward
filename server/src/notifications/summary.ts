import { z } from 'zod';
import {
  BRAND,
  DAILY_SUMMARY_SECTIONS,
  DEFAULT_DAILY_SUMMARY,
  type DailySummaryAdmin,
  type DailySummaryContent,
  type DailySummaryItem,
  type DailySummaryPrefs,
  type DailySummarySection,
  type DailySummaryState,
  type Locale,
  type MonitorStatus,
  type ReportRecipients,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { nowIso, parseJson, HttpError } from '../util.js';
import { runAs, type AuthUser } from '../auth/context.js';
import { decisionCheck, processPermissions } from '../auth/permissions.js';
import { getUser, listUsers, toAuthUser } from '../auth/users.js';
import { readSetting, writeSetting } from '../settings.js';
import { t, type MessageKey } from '../i18n/index.js';
import * as store from '../engine/store.js';
import { parseCauses } from '../monitors/model.js';
import { monitorVisibility, redactCauses, rootCauseMessage } from '../monitors/redact.js';
import { listCredentials } from '../credentials/service.js';
import { reviewsDueFor } from '../records/documents.js';
import { listTickets } from '../tickets/service.js';
import { getRecord } from '../records/service.js';
import { absoluteLink, channelSecrets, getNotificationSettings } from './settings.js';
import { addInApp } from './store.js';
import { sendEmail } from './channels.js';
import { domainAllowed } from './domains.js';
import { userLocale } from './service.js';

/**
 * Optional daily summary per user (off by default, turned on in the profile).
 *
 * Content: what happened since the last summary, collected with the rights of
 * the recipient (runAs) through the same permission helpers as the pages – runs
 * and failures of processes they may view, open tasks they may decide, status
 * changes of monitors they may view (root causes in monitors they may not view
 * are redacted), credentials due that they may see, open ticket references they
 * are responsible for, records waiting for their approval or owned by them that
 * changed status, and scheduled reports they receive.
 *
 * Delivery: in-app and, if chosen, e-mail – only when SMTP is on, the event
 * "summary.daily" is routed to e-mail (Settings → Notifications), the user has
 * e-mail notifications on and their address's domain is allowed (domains.ts).
 * Never to Teams or webhooks (the content is personal).
 *
 * Scheduling: the notification job loop calls runDailySummaries() every few
 * minutes. A summary is due once the user's local time passes the chosen time
 * (on the chosen days), within a catch-up window of a few hours (a short restart
 * does not lose the day). Each user and local day is claimed in
 * daily_summary_sends before anything is sent, so a summary goes out at most once
 * per day – also across restarts. One Steward instance is assumed (several
 * instances on one database would still not send twice: the claim is a primary
 * key insert, but the job would run in each of them).
 */

const DAY = 86400000;
const CATCH_UP_MINUTES = 6 * 60;
const MAX_ITEMS = 10;
const MAX_SINCE_DAYS = 7;
const SWITCH_KEY = 'notifications.dailySummary';

// ---------- settings ----------

export const summariesAllowed = (): boolean => readSetting<{ allowed?: boolean }>(SWITCH_KEY, {}).allowed !== false;

export function setSummariesAllowed(allowed: boolean): DailySummaryAdmin {
  writeSetting(SWITCH_KEY, { allowed });
  audit({
    action: 'notification.daily_summary_switch',
    entityType: 'settings',
    entityId: 'notifications',
    summary: `Daily summaries ${allowed ? 'allowed' : 'switched off for everyone'}`,
    details: { allowed },
  });
  return adminView();
}

const validTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const prefsSchema = z
  .object({
    enabled: z.boolean(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM, e.g. 07:30'),
    timeZone: z.string().min(1).max(64).refine(validTimeZone, 'unknown time zone'),
    days: z.enum(['weekdays', 'everyday']),
    channel: z.enum(['inApp', 'inAppEmail']),
    sections: z.array(z.enum(DAILY_SUMMARY_SECTIONS)).max(DAILY_SUMMARY_SECTIONS.length),
    skipEmpty: z.boolean(),
  })
  .strict();

export function getPrefs(userId: string): DailySummaryPrefs {
  const r = db().get<{ enabled: number; prefs: string }>('SELECT enabled, prefs FROM daily_summary_prefs WHERE user_id = ?', userId);
  if (!r) return { ...DEFAULT_DAILY_SUMMARY };
  const stored = parseJson<Partial<DailySummaryPrefs>>(r.prefs, {});
  const parsed = prefsSchema.safeParse({ ...DEFAULT_DAILY_SUMMARY, ...stored, enabled: !!r.enabled });
  return parsed.success ? parsed.data : { ...DEFAULT_DAILY_SUMMARY, enabled: false };
}

export function savePrefs(u: UserInfo, input: z.infer<typeof prefsSchema>): DailySummaryState {
  if (input.enabled && !summariesAllowed()) throw new HttpError(409, 'An administrator switched daily summaries off', 'DAILY_SUMMARY_NOT_ALLOWED');
  const prefs = { ...input, sections: DAILY_SUMMARY_SECTIONS.filter((s) => input.sections.includes(s)) };
  const before = getPrefs(u.id);
  db().run(
    `INSERT INTO daily_summary_prefs (user_id, enabled, prefs, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, prefs = excluded.prefs, updated_at = excluded.updated_at`,
    u.id,
    prefs.enabled ? 1 : 0,
    JSON.stringify(prefs),
    nowIso(),
  );
  audit({
    action: 'notification.daily_summary_changed',
    entityType: 'user',
    entityId: u.id,
    summary: prefs.enabled
      ? `${u.username} receives a daily summary at ${prefs.time} (${prefs.timeZone}, ${prefs.days === 'weekdays' ? 'Monday to Friday' : 'every day'}, ${prefs.channel === 'inAppEmail' ? 'in-app and e-mail' : 'in-app'})`
      : `${u.username} ${before.enabled ? 'turned the daily summary off' : 'saved the daily summary settings (off)'}`,
    details: { from: before, to: prefs },
  });
  return summaryState(getUser(u.id));
}

/** Why e-mail cannot reach this user (null: it can). */
export function emailBlockedReason(u: UserInfo): DailySummaryState['emailBlockedReason'] {
  const s = getNotificationSettings();
  if (!s.email.enabled) return 'smtpOff';
  if (!(s.routes['summary.daily'] ?? []).includes('email')) return 'routeOff';
  if (!u.email) return 'noAddress';
  if (!u.emailNotifications) return 'optedOut';
  if (!domainAllowed(u.email)) return 'domainNotAllowed';
  return null;
}

const lastSent = (userId: string): string | null =>
  db().get<{ ts: string | null }>("SELECT MAX(ts) AS ts FROM daily_summary_sends WHERE user_id = ? AND outcome IN ('sent', 'empty')", userId)?.ts ?? null;

export function summaryState(u: UserInfo): DailySummaryState {
  const reason = emailBlockedReason(u);
  return { prefs: getPrefs(u.id), allowed: summariesAllowed(), emailAvailable: !reason, emailBlockedReason: reason, lastSentAt: lastSent(u.id) };
}

/** Administrators: who subscribed (no content) and the global switch. */
export function adminView(): DailySummaryAdmin {
  const users = new Map(listUsers().map((u) => [u.id, u]));
  const subscribers = db()
    .all<{ user_id: string }>('SELECT user_id FROM daily_summary_prefs WHERE enabled = 1')
    .map((r) => users.get(r.user_id))
    .filter((u): u is UserInfo => !!u && u.active)
    .map((u) => {
      const p = getPrefs(u.id);
      return {
        username: u.username,
        displayName: u.displayName,
        time: p.time,
        timeZone: p.timeZone,
        days: p.days,
        channel: p.channel,
        lastSentAt: lastSent(u.id),
      };
    })
    .sort((a, b) => a.username.localeCompare(b.username));
  return { allowed: summariesAllowed(), subscribers };
}

// ---------- time ----------

/** Local calendar day (YYYY-MM-DD), weekday (0 = Sunday) and minutes after midnight in a time zone. */
export function localClock(now: number, timeZone: string): { day: string; weekday: number; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** The local day a summary is due for at `now`, or null. */
export function dueDay(p: DailySummaryPrefs, now: number): string | null {
  const c = localClock(now, p.timeZone);
  if (p.days === 'weekdays' && (c.weekday === 0 || c.weekday === 6)) return null;
  const [h, m] = p.time.split(':').map(Number);
  const at = h! * 60 + m!;
  return c.minutes >= at && c.minutes - at < CATCH_UP_MINUTES ? c.day : null;
}

const dateTime = (l: Locale, iso: string | number, timeZone: string) =>
  new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
const dateOnly = (l: Locale, iso: string | number, timeZone: string) =>
  new Intl.DateTimeFormat(l, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(new Date(iso));

// ---------- content ----------

interface Ctx {
  user: AuthUser;
  since: string;
  until: string;
  l: Locale;
  tz: string;
}

type Section = { count: number; items: DailySummaryItem[] };

function runsSection(c: Ctx): Section & { failed: number } {
  const access = new Map(
    db()
      .all<{ id: string; owner: string | null; acl: string }>('SELECT id, owner, acl FROM processes')
      .map((p) => [p.id, processPermissions(c.user, { owner: p.owner, acl: parseJson(p.acl, []) }).includes('view')]),
  );
  const rows = db()
    .all<{ id: string; process_id: string; process_name: string; status: string; dry_run: number; started_at: string; error: string | null }>(
      'SELECT id, process_id, process_name, status, dry_run, started_at, error FROM runs WHERE started_at >= ? AND started_at < ? ORDER BY started_at DESC',
      c.since,
      c.until,
    )
    .filter((r) => access.get(r.process_id));
  const failed = rows.filter((r) => r.status === 'failed');
  return {
    count: rows.length,
    failed: failed.length,
    items: failed.map((r) => ({
      title: t(c.l, 'dailySummary.runFailed', { process: r.process_name }) + (r.dry_run ? ` (${t(c.l, 'dailySummary.dryRun')})` : ''),
      detail: [dateTime(c.l, r.started_at, c.tz), r.error ? r.error.slice(0, 160) : ''].filter(Boolean).join(' · '),
      link: `/runs/${r.id}`,
      tone: 'bad' as const,
    })),
  };
}

function tasksSection(c: Ctx): Section {
  const perms = new Map<string, ReturnType<typeof processPermissions>>();
  const permsOf = (pid: string) => {
    if (!perms.has(pid)) {
      const p = db().get<{ owner: string | null; acl: string }>('SELECT owner, acl FROM processes WHERE id = ?', pid);
      perms.set(pid, p ? processPermissions(c.user, { owner: p.owner, acl: parseJson(p.acl, []) }) : []);
    }
    return perms.get(pid)!;
  };
  const items = store
    .listTasks({ status: 'open' })
    .filter((task) => {
      const pid = task.processId ?? store.taskProcessId(task.id);
      const p = permsOf(pid);
      return p.includes('view') && decisionCheck(c.user, task, { actor: task.startedBy ?? '' }, p).ok;
    })
    .map((task) => ({
      title: t(c.l, 'dailySummary.task', { title: task.title }),
      detail: t(c.l, 'dailySummary.taskDetail', { process: task.processName ?? '', date: dateTime(c.l, task.createdAt, c.tz) }),
      link: `/runs/${task.runId}`,
      tone: 'attention' as const,
    }));
  return { count: items.length, items };
}

function monitorsSection(c: Ctx): Section {
  const canView = monitorVisibility(c.user);
  const names = new Map(
    db()
      .all<{ id: string; name: string }>('SELECT id, name FROM monitors WHERE is_template = 0')
      .map((m) => [m.id, m.name]),
  );
  const status = (s: MonitorStatus | null) => t(c.l, `dailySummary.monitorStatus.${s ?? 'none'}` as MessageKey);
  const items = db()
    .all<{ monitor_id: string; ts: string; status: MonitorStatus; previous: MonitorStatus | null; caused_by: string }>(
      "SELECT monitor_id, ts, status, previous, caused_by FROM monitor_history WHERE check_id = '' AND ts >= ? AND ts < ? ORDER BY id DESC",
      c.since,
      c.until,
    )
    .filter((h) => names.has(h.monitor_id) && canView(h.monitor_id))
    .map((h) => {
      const causes = redactCauses(parseCauses(h.caused_by), canView);
      return {
        title: t(c.l, 'dailySummary.monitorChange', { name: names.get(h.monitor_id)!, from: status(h.previous), to: status(h.status) }),
        detail: [dateTime(c.l, h.ts, c.tz), causes.length ? rootCauseMessage(causes, h.monitor_id) : ''].filter(Boolean).join(' · '),
        link: `/monitors/${h.monitor_id}`,
        tone: h.status === 'down' ? ('bad' as const) : h.status === 'up' ? ('ok' as const) : ('attention' as const),
      };
    });
  return { count: items.length, items };
}

function credentialsSection(c: Ctx): Section {
  const rank = { expired: 0, overdue: 1, dueSoon: 2, ok: 3 } as const;
  const list = listCredentials({}, Date.parse(c.until))
    .filter((x) => x.status !== 'ok')
    .sort((a, b) => rank[a.status] - rank[b.status] || (a.nextDueAt ?? '').localeCompare(b.nextDueAt ?? ''));
  const items = list.map((x) => ({
    title: x.name,
    detail: t(c.l, 'dailySummary.credentialDetail', {
      status: t(c.l, `dailySummary.credentialStatus.${x.status}` as MessageKey),
      date: x.nextDueAt ? dateOnly(c.l, x.nextDueAt, c.tz) : '–',
    }),
    link: `/credentials?open=${encodeURIComponent(x.id)}`,
    tone: x.status === 'dueSoon' ? ('attention' as const) : ('bad' as const),
  }));
  return { count: items.length, items };
}

function ticketsSection(c: Ctx): Section {
  const items = listTickets({ state: 'open', responsible: 'me' }, Date.parse(c.until))
    .sort((a, b) => b.ageDays - a.ageDays)
    .map((x) => ({
      title: `${x.externalNumber} ${x.title}`,
      detail: t(c.l, 'dailySummary.ticketDetail', {
        status: t(c.l, `ticketStatus.${x.status}` as MessageKey),
        count: x.ageDays,
        vendor: x.vendor ? ` · ${x.vendor}` : '',
      }),
      link: `/tickets/${x.id}`,
      tone: x.status === 'waitingUs' ? ('attention' as const) : ('info' as const),
    }));
  return { count: items.length, items };
}

function recordsSection(c: Ctx): Section {
  const status = (s: string) => t(c.l, `dailySummary.recordStatus.${s}` as MessageKey);
  const approvals: DailySummaryItem[] = [];
  for (const r of db().all<{ id: string }>(
    "SELECT id FROM records WHERE status IN ('submitted', 'proposed', 'in_review') ORDER BY updated_at DESC LIMIT 200",
  )) {
    try {
      const d = getRecord(r.id);
      if (d.actions.some((a) => a.approval && a.allowed))
        approvals.push({ title: t(c.l, 'dailySummary.recordApproval', { number: d.number, title: d.title }), link: `/records/${d.id}`, tone: 'attention' });
    } catch {
      /* not visible or gone */
    }
  }
  const changed = db()
    .all<{ id: string; number: string; title: string; from_status: string | null; to_status: string; created_at: string }>(
      `SELECT r.id, r.number, r.title, e.from_status, e.to_status, e.created_at FROM record_events e JOIN records r ON r.id = e.record_id
       WHERE e.to_status IS NOT NULL AND e.created_at >= ? AND e.created_at < ? AND lower(r.owner) = lower(?) ORDER BY e.created_at DESC`,
      c.since,
      c.until,
      c.user.username,
    )
    .map((e) => ({
      title: t(c.l, 'dailySummary.recordChanged', {
        number: e.number,
        title: e.title,
        from: e.from_status ? status(e.from_status) : '–',
        to: status(e.to_status),
      }),
      detail: dateTime(c.l, e.created_at, c.tz),
      link: `/records/${e.id}`,
      tone: 'info' as const,
    }));
  const items = [...approvals, ...changed];
  return { count: items.length, items };
}

/** Living documents whose periodic review is due soon or overdue and that the recipient reviews (review owner, else owner). */
function reviewsSection(c: Ctx): Section {
  const items = reviewsDueFor(c.user, Date.parse(c.until)).map((x) => ({
    title: t(c.l, 'dailySummary.reviewTitle', { number: x.number, title: x.title, edition: x.edition }),
    detail: t(c.l, 'dailySummary.credentialDetail', {
      status: t(c.l, `dailySummary.credentialStatus.${x.status}` as MessageKey),
      date: dateOnly(c.l, x.nextReviewAt, c.tz),
    }),
    link: `/records/${encodeURIComponent(x.id)}?tab=changelog`,
    tone: x.status === 'dueSoon' ? ('attention' as const) : ('bad' as const),
  }));
  return { count: items.length, items };
}

function reportsSection(c: Ctx): Section {
  const name = c.user.username.toLowerCase();
  const teams = new Set(c.user.teams.map((x) => x.toLowerCase()));
  const items = db()
    .all<{ id: string; title: string; created_at: string; recipients: string }>(
      `SELECT r.id, r.title, r.created_at, s.recipients FROM reports r JOIN report_schedules s ON s.id = r.schedule_id
       WHERE r.created_at >= ? AND r.created_at < ? ORDER BY r.created_at DESC`,
      c.since,
      c.until,
    )
    .filter((r) => {
      const rec = parseJson<Partial<ReportRecipients>>(r.recipients, {});
      return (rec.users ?? []).some((x) => x.toLowerCase() === name) || (rec.teams ?? []).some((x) => teams.has(x.toLowerCase()));
    })
    .map((r) => ({
      title: r.title,
      detail: t(c.l, 'dailySummary.reportDetail', { date: dateTime(c.l, r.created_at, c.tz) }),
      link: `/reports?report=${encodeURIComponent(r.id)}`,
      tone: 'info' as const,
    }));
  return { count: items.length, items };
}

const BUILDERS: Record<DailySummarySection, (c: Ctx) => Section> = {
  runs: runsSection,
  tasks: tasksSection,
  monitors: monitorsSection,
  credentials: credentialsSection,
  tickets: ticketsSection,
  records: recordsSection,
  reviews: reviewsSection,
  reports: reportsSection,
};

/** The summary for one user, collected with their rights. */
export function buildSummary(u: UserInfo, prefs: DailySummaryPrefs, since: number, until: number): DailySummaryContent {
  const user = toAuthUser(u);
  const ctx: Ctx = { user, since: new Date(since).toISOString(), until: new Date(until).toISOString(), l: userLocale(u), tz: prefs.timeZone };
  return runAs(user, () => {
    const sections = prefs.sections.map((id) => {
      let s: Section & { failed?: number };
      try {
        s = BUILDERS[id](ctx);
      } catch (err) {
        logger.warn({ err, section: id }, 'daily summary section failed');
        s = { count: 0, items: [] };
      }
      // runs: the headline counts every run; the items are the failed ones
      const items = id === 'runs' ? [{ title: t(ctx.l, 'dailySummary.runsTotal', { count: s.count, failed: s.failed ?? 0 }) }, ...s.items] : s.items;
      const max = id === 'runs' ? MAX_ITEMS + 1 : MAX_ITEMS;
      return { id, count: s.count, items: items.slice(0, max), more: Math.max(0, items.length - max) };
    });
    return { since: ctx.since, until: ctx.until, sections, empty: sections.every((s) => s.count === 0) };
  });
}

// ---------- rendering ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const TONE_COLOR = { bad: '#c92a2a', attention: '#e8590c', ok: '#2b8a3e', info: '#1971c2' } as const;

export function renderSummary(c: DailySummaryContent, l: Locale, timeZone: string): { title: string; inApp: string; text: string; html: string } {
  const title = t(l, 'dailySummary.title', { date: dateOnly(l, c.until, timeZone) });
  const intro = t(l, 'dailySummary.intro', { since: dateTime(l, c.since, timeZone) });
  const label = (id: DailySummarySection) => t(l, `dailySummary.sections.${id}` as MessageKey);
  const shown = c.sections.filter((s) => s.count > 0);
  const inApp = c.empty ? t(l, 'dailySummary.nothing') : shown.map((s) => t(l, 'dailySummary.count', { section: label(s.id), count: s.count })).join('\n');
  const home = absoluteLink('/');
  const profile = absoluteLink('/profile');
  const text = [
    title,
    intro,
    '',
    ...(c.empty
      ? [t(l, 'dailySummary.nothing')]
      : shown.flatMap((s) => [
          `${label(s.id)} (${s.count})`,
          ...s.items.map((i) => `- ${i.title}${i.detail ? ` – ${i.detail}` : ''}${i.link ? `\n  ${absoluteLink(i.link)}` : ''}`),
          ...(s.more ? [`  ${t(l, 'dailySummary.more', { count: s.more })}`] : []),
          '',
        ])),
    home,
    '',
    t(l, 'dailySummary.footer', { link: profile }),
    '',
  ].join('\n');
  const item = (i: DailySummaryItem) => {
    const head = i.link ? `<a href="${esc(absoluteLink(i.link))}" style="color:#1c7ed6;text-decoration:none">${esc(i.title)}</a>` : esc(i.title);
    const dot = i.tone ? `<span style="color:${TONE_COLOR[i.tone]}">●</span> ` : '';
    return `<li style="margin:2px 0">${dot}${head}${i.detail ? `<br><span style="color:#868e96;font-size:12px">${esc(i.detail)}</span>` : ''}</li>`;
  };
  const html = [
    `<div lang="${l}" style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#212529;max-width:640px">`,
    `<p style="margin:0 0 4px"><strong style="font-size:16px">${esc(title)}</strong></p>`,
    `<p style="margin:0 0 12px;color:#868e96">${esc(intro)}</p>`,
    ...(c.empty
      ? [`<p>${esc(t(l, 'dailySummary.nothing'))}</p>`]
      : shown.map(
          (s) =>
            `<p style="margin:12px 0 2px"><strong>${esc(label(s.id))}</strong> <span style="color:#868e96">(${s.count})</span></p><ul style="margin:0;padding-left:18px">${s.items.map(item).join('')}${s.more ? `<li style="list-style:none;color:#868e96">${esc(t(l, 'dailySummary.more', { count: s.more }))}</li>` : ''}</ul>`,
        )),
    `<p style="margin:16px 0 8px"><a href="${esc(home)}">${esc(t(l, 'dailySummary.open', { brand: BRAND.name }))}</a></p>`,
    `<p style="margin:0;color:#868e96;font-size:12px">${esc(t(l, 'dailySummary.footer', { link: '' }))}<a href="${esc(profile)}" style="color:#868e96">${esc(profile)}</a></p>`,
    '</div>',
  ].join('');
  return { title, inApp, text, html };
}

/** The current user's summary as it would be sent now (preview on the profile page; nothing is sent or claimed). */
export function previewSummary(u: UserInfo, now = Date.now()): DailySummaryContent & { title: string } {
  const prefs = getPrefs(u.id);
  const since = sinceFor(u.id, now);
  const content = buildSummary(u, prefs, since, now);
  return { ...content, title: renderSummary(content, userLocale(u), prefs.timeZone).title };
}

function sinceFor(userId: string, now: number): number {
  const last = db().get<{ ts: string | null }>('SELECT MAX(ts) AS ts FROM daily_summary_sends WHERE user_id = ?', userId)?.ts;
  const floor = now - MAX_SINCE_DAYS * DAY;
  return last ? Math.max(Date.parse(last), floor) : now - DAY;
}

// ---------- job ----------

function claimDay(userId: string, day: string, now: number): boolean {
  return (
    db().run(
      "INSERT INTO daily_summary_sends (user_id, day, ts, outcome) VALUES (?, ?, ?, 'pending') ON CONFLICT DO NOTHING",
      userId,
      day,
      new Date(now).toISOString(),
    ).changes === 1
  );
}

const setOutcome = (userId: string, day: string, outcome: 'sent' | 'empty' | 'failed') =>
  db().run('UPDATE daily_summary_sends SET outcome = ? WHERE user_id = ? AND day = ?', outcome, userId, day);

const pendingMails = new Set<Promise<void>>();
/** For tests: wait for e-mails queued by runDailySummaries(). */
export async function flushSummaryMails(): Promise<void> {
  while (pendingMails.size) await Promise.allSettled([...pendingMails]);
}

/** Sends the summaries that are due at `now`. Returns how many users got one (skipped empty ones not counted). */
export function runDailySummaries(now = Date.now()): number {
  if (!summariesAllowed()) return 0;
  const rows = db().all<{ user_id: string }>('SELECT user_id FROM daily_summary_prefs WHERE enabled = 1');
  if (!rows.length) return 0;
  const users = new Map(listUsers().map((u) => [u.id, u]));
  const settings = getNotificationSettings();
  const route = settings.routes['summary.daily'] ?? [];
  let sent = 0;
  for (const r of rows) {
    const u = users.get(r.user_id);
    if (!u?.active) continue;
    const prefs = getPrefs(u.id);
    if (!prefs.enabled) continue;
    const day = dueDay(prefs, now);
    if (!day) continue;
    const wantsEmail = prefs.channel === 'inAppEmail' && route.includes('email') && !emailBlockedReason(u);
    // while the vault is locked nothing can be e-mailed: claiming now would lose the day's e-mail
    if (wantsEmail && !vault().unlocked) continue;
    const since = sinceFor(u.id, now);
    if (!claimDay(u.id, day, now)) continue;
    try {
      const content = buildSummary(u, prefs, since, now);
      if (content.empty && prefs.skipEmpty) {
        setOutcome(u.id, day, 'empty');
        continue;
      }
      const l = userLocale(u);
      const m = renderSummary(content, l, prefs.timeZone);
      if (route.includes('inApp')) addInApp(u.id, { event: 'summary.daily', title: m.title, body: m.inApp, link: '/', dedupeKey: `summary.daily:${day}` }, DAY);
      if (wantsEmail && settings.email.enabled) {
        const secrets = channelSecrets();
        const p = sendEmail(settings.email, secrets, u.email!, {
          event: 'summary.daily',
          title: m.title,
          body: m.inApp,
          locale: l,
          link: absoluteLink('/'),
          ts: nowIso(),
          emailParts: { text: m.text, html: m.html },
        })
          .then(() => logger.debug({ user: u.username }, 'daily summary e-mailed'))
          .catch((err) => logger.warn({ err: { message: (err as Error).message }, user: u.username }, 'daily summary could not be e-mailed'))
          .finally(() => pendingMails.delete(p));
        pendingMails.add(p);
      }
      setOutcome(u.id, day, 'sent');
      sent++;
    } catch (err) {
      setOutcome(u.id, day, 'failed');
      logger.warn({ err, user: u.username }, 'daily summary failed');
    }
  }
  return sent;
}
