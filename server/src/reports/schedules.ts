import { Cron } from 'croner';
import { z } from 'zod';
import {
  REPORT_LANGS,
  REPORT_SCHEDULE_PRESETS,
  type ReportRecord,
  type ReportRecipients,
  type ReportSchedule,
  type ReportSchedulePreset,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { currentUser, runAs, type AuthUser } from '../auth/context.js';
import { capabilities, isAdmin, matches } from '../auth/permissions.js';
import { findUserByName, listTeams, listUsers, toAuthUser } from '../auth/users.js';
import { notify } from '../notifications/service.js';
import { formatDateTime, t } from '../i18n/index.js';
import { generateScheduledReport } from './service.js';
import { parseSections, reportSection } from './sections.js';

/**
 * Scheduled summary reports. A schedule has an owner and runs with the owner's
 * rights: every section only contains what the owner may see (checked again on
 * every run). Generated reports are archived like all reports (immutable file,
 * SHA-256 in the audit log) and can be sent to recipients through the
 * notification service (in-app and e-mail; external addresses e-mail only).
 *
 * Periods: daily = the previous calendar day, weekly = the previous week
 * (Monday–Monday), monthly = the previous calendar month – in the schedule's
 * time zone. custom = the last `periodDays` days before the run.
 */

const DAY = 86400000;
export const PRESET_CRON: Record<Exclude<ReportSchedulePreset, 'custom'>, string> = { daily: '0 6 * * *', weekly: '0 6 * * 1', monthly: '0 6 1 * *' };
/** Largest PDF attached to e-mails (bigger reports are linked only). */
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
/** Roles that may create report schedules (viewers may not). */
const CREATE_ROLES = ['admin', 'designer', 'operator', 'approver', 'auditor'];

interface Row {
  id: string;
  name: string;
  owner: string;
  enabled: number;
  preset: ReportSchedulePreset;
  cron: string;
  timezone: string;
  period_days: number;
  lang: 'en' | 'de';
  classification: string;
  title: string;
  sections: string;
  recipients: string;
  attach_pdf: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_report_id: string | null;
  last_error: string | null;
}

const jobs = new Map<string, Cron>();

// ---------- time zones and periods ----------

function zoneParts(t: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number; wd: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second!, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!) };
}

const offset = (t: number, tz: string): number => {
  const p = zoneParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
};

/** The instant of local midnight of y-m-d in `tz` (DST-safe). */
export function localMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offset(guess, tz);
  const o2 = offset(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

export function reportPeriod(preset: ReportSchedulePreset, periodDays: number, tz: string, at: number): { from: number; to: number } {
  if (preset === 'custom') return { from: at - periodDays * DAY, to: at };
  const p = zoneParts(at, tz);
  if (preset === 'daily') {
    const to = localMidnight(p.y, p.m, p.d, tz);
    const prev = zoneParts(to - 12 * 3600000, tz);
    return { from: localMidnight(prev.y, prev.m, prev.d, tz), to };
  }
  if (preset === 'weekly') {
    const back = (p.wd + 6) % 7; // days since Monday
    const monday = zoneParts(at - back * DAY, tz);
    const to = localMidnight(monday.y, monday.m, monday.d, tz);
    const prev = zoneParts(to - 7 * DAY + 12 * 3600000, tz);
    return { from: localMidnight(prev.y, prev.m, prev.d, tz), to };
  }
  const to = localMidnight(p.y, p.m, 1, tz);
  const py = p.m === 1 ? p.y - 1 : p.y;
  const pm = p.m === 1 ? 12 : p.m - 1;
  return { from: localMidnight(py, pm, 1, tz), to };
}

const validTz = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// ---------- permissions ----------

export const canCreateReportSchedules = (u: AuthUser | null = currentUser()): boolean => !!u && u.roles.some((r) => CREATE_ROLES.includes(r));
const isScheduleOwner = (u: AuthUser, r: { owner: string }) => r.owner.toLowerCase() === u.username.toLowerCase();
const canEdit = (u: AuthUser | null, r: Row) => !!u && (isAdmin(u) || isScheduleOwner(u, r));
const isRecipient = (u: AuthUser, rec: ReportRecipients) => rec.users.some((x) => x.toLowerCase() === u.username.toLowerCase()) || rec.teams.some((tm) => matches(u, `team:${tm}`));
const canView = (u: AuthUser | null, r: Row) => !!u && (canEdit(u, r) || capabilities(u).viewAudit || isRecipient(u, parseJson(r.recipients, { users: [], teams: [], emails: [] })));

/** Archived scheduled reports: the owner, the recipients, auditors and administrators. */
export function canViewScheduledReport(rec: ReportRecord, u: AuthUser | null = currentUser()): boolean {
  if (!u) return false;
  if (capabilities(u).viewAudit || rec.createdBy.toLowerCase() === u.username.toLowerCase()) return true;
  const r = rec.scheduleId ? db().get<Row>('SELECT * FROM report_schedules WHERE id = ?', rec.scheduleId) : undefined;
  return !!r && canView(u, r);
}

// ---------- mapping ----------

function toSchedule(r: Row): ReportSchedule {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    enabled: !!r.enabled,
    preset: r.preset,
    cron: r.cron,
    timezone: r.timezone,
    periodDays: r.period_days,
    lang: r.lang,
    classification: r.classification,
    title: r.title,
    sections: parseJson(r.sections, {}),
    recipients: parseJson(r.recipients, { users: [], teams: [], emails: [] }),
    attachPdf: !!r.attach_pdf,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastRunAt: r.last_run_at,
    lastReportId: r.last_report_id,
    lastError: r.last_error,
    nextRunAt: jobs.get(r.id)?.nextRun()?.toISOString() ?? null,
    canEdit: canEdit(currentUser(), r),
  };
}

function rowOf(id: string): Row {
  const r = db().get<Row>('SELECT * FROM report_schedules WHERE id = ?', id);
  if (!r || !canView(currentUser(), r)) throw new HttpError(404, `Report schedule ${id} not found`);
  return r;
}

export function listReportSchedules(): ReportSchedule[] {
  const u = currentUser();
  return db()
    .all<Row>('SELECT * FROM report_schedules ORDER BY name, id')
    .filter((r) => canView(u, r))
    .map(toSchedule);
}

export const getReportSchedule = (id: string): ReportSchedule => toSchedule(rowOf(id));

// ---------- input ----------

export const scheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  preset: z.enum(REPORT_SCHEDULE_PRESETS).default('weekly'),
  cron: z.string().trim().max(100).optional(),
  timezone: z.string().trim().max(64).optional(),
  periodDays: z.number().int().min(1).max(366).default(7),
  lang: z.enum(REPORT_LANGS).default('en'),
  classification: z.string().trim().max(60).default(''),
  title: z.string().trim().max(200).default(''),
  sections: z.record(z.unknown()),
  recipients: z
    .object({
      users: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
      teams: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
      emails: z.array(z.string().trim().toLowerCase().email().max(254)).max(50).default([]),
    })
    .default({}),
  attachPdf: z.boolean().default(false),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

function normalize(b: ScheduleInput, owner: AuthUser): Omit<Row, 'id' | 'owner' | 'created_at' | 'updated_at' | 'last_run_at' | 'last_report_id' | 'last_error'> {
  const tz = b.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!validTz(tz)) throw new HttpError(400, `Unknown time zone "${tz}"`);
  const cron = b.preset === 'custom' ? b.cron : PRESET_CRON[b.preset];
  if (!cron) throw new HttpError(400, 'Enter a cron expression for a custom schedule');
  try {
    new Cron(cron, { paused: true, timezone: tz }).stop();
  } catch (e) {
    throw new HttpError(400, `Invalid cron expression: ${(e as Error).message}`);
  }
  const sections = parseSections(b.sections);
  // references must be visible to the owner (the report would silently miss them otherwise)
  runAs(owner, () => {
    for (const [id, cfg] of Object.entries(sections)) reportSection(id)?.validate?.(cfg);
  });
  const users = new Map(listUsers().map((u) => [u.username.toLowerCase(), u]));
  for (const n of b.recipients.users) if (!users.has(n.toLowerCase())) throw new HttpError(400, `User "${n}" not found`);
  const teams = new Set(listTeams().map((tm) => tm.name.toLowerCase()));
  for (const n of b.recipients.teams) if (!teams.has(n.toLowerCase())) throw new HttpError(400, `Team "${n}" not found`);
  return {
    name: b.name,
    enabled: b.enabled ? 1 : 0,
    preset: b.preset,
    cron,
    timezone: tz,
    period_days: b.periodDays,
    lang: b.lang,
    classification: b.classification,
    title: b.title,
    sections: JSON.stringify(sections),
    recipients: JSON.stringify({ users: [...new Set(b.recipients.users)], teams: [...new Set(b.recipients.teams)], emails: [...new Set(b.recipients.emails)] }),
    attach_pdf: b.attachPdf ? 1 : 0,
  };
}

const me = (): AuthUser => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in');
  return u;
};

export function createReportSchedule(b: ScheduleInput): ReportSchedule {
  const u = me();
  if (!canCreateReportSchedules(u)) throw new HttpError(403, 'You are not allowed to create report schedules', 'FORBIDDEN');
  const v = normalize(b, u);
  const id = newId('rsc_');
  const now = nowIso();
  const row = { id, owner: u.username, ...v, created_at: now, updated_at: now };
  const cols = Object.keys(row);
  db().tx(() => {
    db().run(`INSERT INTO report_schedules (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => (row as Record<string, unknown>)[c]));
    audit({
      action: 'report_schedule.created',
      entityType: 'report_schedule',
      entityId: id,
      summary: `Report schedule "${v.name}" created (${v.preset}, ${v.cron} ${v.timezone}; sections ${Object.keys(JSON.parse(v.sections)).join(', ')})`,
      details: { ...v, sections: JSON.parse(v.sections), recipients: JSON.parse(v.recipients) },
    });
  });
  arm(id);
  return toSchedule(rowOf(id));
}

export function updateReportSchedule(id: string, b: ScheduleInput): ReportSchedule {
  const u = me();
  const r = rowOf(id);
  if (!canEdit(u, r)) throw new HttpError(403, 'Only the owner or an administrator can change this report schedule', 'FORBIDDEN');
  const owner = findUserByName(r.owner);
  const v = normalize(b, owner ? toAuthUser(owner) : u);
  const changed = (Object.keys(v) as (keyof typeof v)[]).filter((k) => String(r[k]) !== String(v[k]));
  db().tx(() => {
    db().run(`UPDATE report_schedules SET ${Object.keys(v).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(v), nowIso(), id);
    audit({
      action: 'report_schedule.updated',
      entityType: 'report_schedule',
      entityId: id,
      summary: `Report schedule "${v.name}" changed${changed.length ? ` (${changed.join(', ')})` : ''}`,
      details: Object.fromEntries(changed.map((k) => [k, { from: r[k], to: v[k] }])),
    });
  });
  arm(id);
  return toSchedule(rowOf(id));
}

export function deleteReportSchedule(id: string): void {
  const u = me();
  const r = rowOf(id);
  if (!canEdit(u, r)) throw new HttpError(403, 'Only the owner or an administrator can delete this report schedule', 'FORBIDDEN');
  disarm(id);
  db().tx(() => {
    db().run('DELETE FROM report_schedules WHERE id = ?', id);
    audit({ action: 'report_schedule.deleted', entityType: 'report_schedule', entityId: id, summary: `Report schedule "${r.name}" deleted (generated reports stay in the archive)` });
  });
}

// ---------- running ----------

const runningNow = new Set<string>();

function recipientUsers(rec: ReportRecipients): UserInfo[] {
  const all = listUsers().filter((u) => u.active);
  const names = new Set(rec.users.map((n) => n.toLowerCase()));
  const teams = listTeams().filter((tm) => rec.teams.some((x) => x.toLowerCase() === tm.name.toLowerCase()));
  for (const tm of teams) tm.members.forEach((m) => names.add(m.toLowerCase()));
  return all.filter((u) => names.has(u.username.toLowerCase()));
}

/**
 * Generates the report of a schedule now (period ending at `at`, default: now).
 * `actor` is who triggered it ("system" for the timer). Fails when the owner is
 * missing or deactivated.
 */
export async function runReportSchedule(id: string, o: { actor: string; at?: number; compress?: boolean }): Promise<ReportRecord & { texts: string[] }> {
  const r = db().get<Row>('SELECT * FROM report_schedules WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Report schedule ${id} not found`);
  if (runningNow.has(id)) throw new HttpError(409, 'This report is being generated right now');
  runningNow.add(id);
  try {
    const ownerInfo = findUserByName(r.owner);
    if (!ownerInfo || !ownerInfo.active) {
      const msg = `the owner ${r.owner} is missing or deactivated`;
      db().run('UPDATE report_schedules SET last_run_at = ?, last_error = ? WHERE id = ?', nowIso(), msg, id);
      audit({ actor: o.actor, action: 'report_schedule.skipped', entityType: 'report_schedule', entityId: id, summary: `Report schedule "${r.name}" skipped: ${msg}` });
      throw new HttpError(409, `The report was not generated: ${msg}`);
    }
    const owner = toAuthUser(ownerInfo);
    const at = o.at ?? Date.now();
    const { from, to } = reportPeriod(r.preset, r.period_days, r.timezone, at);
    let rec: ReportRecord & { texts: string[]; pdf: Buffer };
    try {
      rec = await generateScheduledReport({
        actor: o.actor,
        owner,
        scheduleId: r.id,
        scheduleName: r.name,
        title: r.title || r.name,
        from,
        to,
        sections: parseJson(r.sections, {}),
        lang: r.lang,
        classification: r.classification,
        timeZone: r.timezone,
        compress: o.compress,
      });
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      db().run('UPDATE report_schedules SET last_run_at = ?, last_error = ? WHERE id = ?', nowIso(), msg, id);
      audit({ actor: o.actor, action: 'report_schedule.failed', entityType: 'report_schedule', entityId: id, summary: `Report schedule "${r.name}" failed: ${msg}` });
      throw e;
    }
    db().run('UPDATE report_schedules SET last_run_at = ?, last_report_id = ?, last_error = NULL WHERE id = ?', nowIso(), rec.id, id);
    sendReport(r, rec);
    const { pdf: _pdf, ...out } = rec;
    return out;
  } finally {
    runningNow.delete(id);
  }
}

function sendReport(r: Row, rec: ReportRecord & { pdf: Buffer }): void {
  const recipients = parseJson<ReportRecipients>(r.recipients, { users: [], teams: [], emails: [] });
  const users = recipientUsers(recipients);
  if (!users.length && !recipients.emails.length) return;
  const attach = !!r.attach_pdf && rec.pdf.length <= ATTACH_MAX_BYTES;
  notify({
    event: 'report.ready',
    text: (l) => ({
      title: t(l, 'reportReady.title', { name: r.name }),
      body: [t(l, 'reportReady.body', { name: r.name, from: formatDateTime(l, rec.from!), to: formatDateTime(l, rec.to!) }), attach ? t(l, 'reportReady.attached') : ''].filter(Boolean).join('\n'),
    }),
    link: `/reports?report=${encodeURIComponent(rec.id)}`,
    recipients: users,
    emails: recipients.emails,
    attachments: attach ? [{ filename: rec.filename, content: rec.pdf, contentType: 'application/pdf' }] : undefined,
    inAppKey: `report:${rec.id}`,
    externalKey: `report:${rec.id}`,
    data: { reportId: rec.id, scheduleId: r.id, name: r.name, from: rec.from, to: rec.to, sha256: rec.sha256 },
  });
}

// ---------- timer ----------

function disarm(id: string): void {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

function arm(id: string): void {
  disarm(id);
  const r = db().get<Row>('SELECT * FROM report_schedules WHERE id = ?', id);
  if (!r || !r.enabled || !started) return;
  try {
    const job = new Cron(r.cron, { timezone: r.timezone, protect: true }, () => {
      if (!vault().unlocked) return;
      runReportSchedule(id, { actor: 'system' }).catch((e) => logger.warn({ err: { message: (e as Error).message }, reportScheduleId: id }, 'scheduled report failed'));
    });
    jobs.set(id, job);
  } catch (err) {
    logger.warn({ err, reportScheduleId: id }, 'report schedule could not be armed');
  }
}

let started = false;
export function startReportSchedules(): void {
  started = true;
  for (const r of db().all<{ id: string }>('SELECT id FROM report_schedules WHERE enabled = 1')) arm(r.id);
}

export function stopReportSchedules(): void {
  started = false;
  for (const id of [...jobs.keys()]) disarm(id);
}
