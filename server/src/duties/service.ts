import { z } from 'zod';
import {
  DUTY_INTERVALS,
  DUTY_LEVELS,
  DUTY_LIMITS,
  DUTY_NOT_MET,
  type DutyDetail,
  type DutyPeriod,
  type DutyScheduleRef,
  type DutySkip,
  type DutySkipStatus,
  type DutySummary,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { matches, processPermissions } from '../auth/permissions.js';
import { sameIdentity } from '../auth/aliases.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { logger } from '../log.js';
import { t } from '../i18n/index.js';
import { notify, titleName } from '../notifications/service.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { canEditService, forbid, me } from '../records/access.js';
import { getSchedule } from '../scheduler.js';
import { evaluateDuty, type DutyRow, type Evaluated, type PeriodRow } from './evaluate.js';
import { closeForChange, persistDuty, storeInactiveGap } from './store.js';
import { addLocalDays, instanceTimeZone, nextPeriod, periodAt, periodOfKey } from './periods.js';

/**
 * Service duties (#85): CRUD, the period view of a duty, exceptions with four-eyes, and the figures for the start
 * page and the daily summary.
 *
 * Permissions follow the service: everyone who can sign in reads duties (like services); whoever may edit the
 * service (designers, administrators, its owners) defines and changes them. The duty's owners and the service's
 * editors ask for a skip; a second person – an administrator, a designer, or an owner of the duty or the service as of
 * the request, never the one who asked (former names count as the same person) – approves or rejects it. Names of processes the reader may not view are
 * left out (the status stays visible: it belongs to the service).
 */

const subject = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(user|team):[^\s].{0,119}$/, 'Use user:<name> or team:<name>');
const id = z.string().trim().min(1).max(200);

const fields = {
  applicationId: id.nullable().default(null),
  name: z.string().trim().min(1).max(DUTY_LIMITS.name),
  description: z.string().max(DUTY_LIMITS.description).default(''),
  processId: id,
  scheduleId: id.nullable().default(null),
  interval: z.enum(DUTY_INTERVALS),
  level: z.enum(DUTY_LEVELS),
  graceDays: z.number().int().min(0).max(DUTY_LIMITS.graceDays).default(0),
  remindDays: z.number().int().min(0).max(DUTY_LIMITS.remindDays).default(5),
  owners: z.array(subject).max(DUTY_LIMITS.owners).default([]),
};
export const dutyInput = z.object({ serviceId: id, ...fields }).strict();
export const dutyUpdate = z.object(fields).strict();
export type DutyInputData = z.infer<typeof dutyInput>;
export type DutyUpdateData = z.infer<typeof dutyUpdate>;

export const skipInput = z.object({ periodKey: z.string().trim().min(4).max(10), reason: z.string().trim().min(1).max(DUTY_LIMITS.reason) }).strict();
export const decisionInput = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(DUTY_LIMITS.reason).default('') }).strict();

interface SkipRow {
  id: string;
  duty_id: string;
  period_key: string;
  period_start: string;
  reason: string;
  status: DutySkipStatus;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string;
  decider_subjects: string;
}

interface ServiceRef {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

// ---------- rows and permissions ----------

export function dutyRow(dutyId: string): DutyRow {
  const r = db().get<DutyRow>('SELECT * FROM service_duties WHERE id = ?', dutyId);
  if (!r) throw new HttpError(404, `Duty ${dutyId} not found`, 'DUTY_NOT_FOUND', { id: dutyId });
  return r;
}

function serviceRef(serviceId: string): ServiceRef {
  const s = db().get<ServiceRef>('SELECT id, name, owners, archived FROM services WHERE id = ?', serviceId);
  if (!s) throw new HttpError(404, `Service ${serviceId} not found`, 'SERVICE_NOT_FOUND', { id: serviceId });
  return s;
}

const serviceOwners = (s: ServiceRef) => parseJson<string[]>(s.owners, []);
const dutyOwners = (d: DutyRow) => parseJson<string[]>(d.owners, []);
export const canEditDuty = (u: AuthUser | null, s: ServiceRef): boolean => canEditService(u, serviceOwners(s));
const isDutyOwner = (u: AuthUser | null, d: DutyRow) => !!u && dutyOwners(d).some((x) => matches(u, x));
const canRequestSkip = (u: AuthUser | null, d: DutyRow, s: ServiceRef) => canEditDuty(u, s) || isDutyOwner(u, d);
/** Who is responsible when a skip is asked for: the duty's owners and the service's owners, frozen with the request. */
const deciderSubjects = (d: DutyRow, s: ServiceRef) => [...new Set([...dutyOwners(d), ...serviceOwners(s)])];
/**
 * Who may decide a skip (the four-eyes rule comes on top): administrators, the service's editors by role (designers),
 * and the duty's and the service's owners as they were when it was asked for – so the requester cannot pick the second
 * person by adding an owner afterwards. Approvers of unrelated services may not.
 */
const mayDecideSkip = (u: AuthUser | null, r: Pick<SkipRow, 'decider_subjects'>) =>
  !!u && (u.roles.includes('admin') || u.roles.includes('designer') || parseJson<string[]>(r.decider_subjects, []).some((x) => matches(u, x)));

/** Responsible for a duty: its owners, else the service's owners. */
export function responsibleSubjects(d: DutyRow, s: ServiceRef): string[] {
  const own = dutyOwners(d);
  return own.length ? own : serviceOwners(s);
}
export const isResponsible = (u: AuthUser, d: DutyRow, s: ServiceRef): boolean => responsibleSubjects(d, s).some((x) => matches(u, x));

/** Active users responsible for a duty; administrators when nobody is named. */
export function responsibleUsers(d: DutyRow, s: ServiceRef, all: UserInfo[]): UserInfo[] {
  const subjects = responsibleSubjects(d, s);
  const named = all.filter((u) => subjects.some((x) => matches(toAuthUser(u), x)));
  return named.length ? named : all.filter((u) => u.roles.includes('admin'));
}

// ---------- the period view ----------

const iso = (t: number) => new Date(t).toISOString();

interface ViewCtx {
  u: AuthUser | null;
  now: number;
  tz: string;
  processName: Map<string, string>;
  processVisible: (processId: string) => boolean;
}

function viewCtx(now = Date.now()): ViewCtx {
  const u = currentUser();
  const procs = new Map(
    db()
      .all<{ id: string; name: string; owner: string | null; acl: string }>('SELECT id, name, owner, acl FROM processes')
      .map((p) => [p.id, p]),
  );
  const seen = new Map<string, boolean>();
  return {
    u,
    now,
    tz: instanceTimeZone(),
    processName: new Map([...procs.values()].map((p) => [p.id, p.name])),
    processVisible: (pid) => {
      if (!seen.has(pid)) {
        const p = procs.get(pid);
        seen.set(pid, !!p && processPermissions(u, { owner: p.owner, acl: parseJson(p.acl, []) }).includes('view'));
      }
      return seen.get(pid)!;
    },
  };
}

function toSkip(r: SkipRow, d: DutyRow, s: ServiceRef, u: AuthUser | null): DutySkip {
  const pending = r.status === 'pending';
  const may = mayDecideSkip(u, r);
  const own = !!u && sameIdentity(r.requested_by, u);
  return {
    id: r.id,
    dutyId: r.duty_id,
    periodKey: r.period_key,
    periodStart: r.period_start,
    reason: r.reason,
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    comment: r.decision_comment,
    canDecide: pending && may && !own,
    decideBlocked: pending && may && own ? 'FOUR_EYES_SKIP' : null,
    canWithdraw: pending && own,
  };
}

function toPeriod(e: Evaluated, d: DutyRow, c: ViewCtx, skip: DutySkip | null): DutyPeriod {
  const row = e.closed ? e.row : null;
  const processId = row?.process_id ?? d.process_id;
  const visible = c.processVisible(processId);
  return {
    key: e.period.key,
    start: iso(e.period.start),
    end: iso(e.period.end),
    graceEndsAt: iso(e.graceEnd),
    status: e.status,
    closed: e.closed,
    closedAt: e.closedAt,
    closeNote: e.row?.close_note ?? null,
    inGrace: !e.closed && c.now >= e.period.end && c.now < e.graceEnd,
    run: visible ? e.run : null,
    failedRuns: e.failedRuns,
    runsInProgress: e.runsInProgress,
    skip,
    snapshot: row
      ? {
          name: row.duty_name,
          level: row.level,
          interval: row.interval_kind,
          graceDays: row.grace_days,
          processName: visible ? row.process_name : '',
          timeZone: row.time_zone,
        }
      : {
          name: d.name,
          level: d.level,
          interval: d.interval_kind,
          graceDays: d.grace_days,
          processName: visible ? (c.processName.get(d.process_id) ?? d.process_id) : '',
          timeZone: c.tz,
        },
  };
}

function scheduleRef(d: DutyRow, c: ViewCtx): DutyScheduleRef | null {
  if (!d.schedule_id) return null;
  try {
    const s = getSchedule(d.schedule_id);
    if (!c.processVisible(s.processId)) return null;
    return { id: s.id, name: s.name, enabled: s.enabled, dryRun: s.dryRun, nextRunAt: s.nextRunAt ?? null };
  } catch {
    return null; // deleted
  }
}

/** Whether new periods are evaluated: the duty and its service are not archived. */
const activeDuty = (d: DutyRow, s: ServiceRef) => !d.archived && !s.archived;

export interface Built {
  summary: DutySummary;
  periods: Evaluated[];
  row: DutyRow;
  service: ServiceRef;
}

function build(d: DutyRow, s: ServiceRef, c: ViewCtx, appName: string | null): Built {
  const periods = evaluateDuty(d, c.now, c.tz, activeDuty(d, s));
  const skipRows = db().all<SkipRow>('SELECT * FROM duty_skips WHERE duty_id = ? ORDER BY requested_at DESC, id', d.id);
  const skipFor = (key: string) => {
    const r = skipRows.find((x) => x.period_key === key && x.status === 'approved') ?? skipRows.find((x) => x.period_key === key && x.status === 'pending');
    return r ? toSkip(r, d, s, c.u) : null;
  };
  const active = activeDuty(d, s);
  const cur = active ? periods.filter((p) => p.period.start <= c.now && c.now < p.period.end).pop() : undefined;
  // the period that ended last (after an interval change it can lie inside the current period of the new interval)
  const before = periods
    .filter((p) => p !== cur && p.period.end <= c.now)
    .sort((a, b) => a.period.end - b.period.end)
    .pop();
  const visible = c.processVisible(d.process_id);
  return {
    row: d,
    service: s,
    periods,
    summary: {
      id: d.id,
      serviceId: d.service_id,
      serviceName: s.name,
      applicationId: d.application_id,
      applicationName: d.application_id ? appName : null,
      name: d.name,
      description: d.description,
      processId: visible ? d.process_id : null,
      processName: visible ? (c.processName.get(d.process_id) ?? null) : null,
      processVisible: visible,
      schedule: scheduleRef(d, c),
      interval: d.interval_kind,
      level: d.level,
      graceDays: d.grace_days,
      remindDays: d.remind_days,
      owners: dutyOwners(d),
      archived: !!d.archived,
      timeZone: c.tz,
      current: cur ? toPeriod(cur, d, c, skipFor(cur.period.key)) : null,
      previous: before ? toPeriod(before, d, c, skipFor(before.period.key)) : null,
      pendingSkips: skipRows.filter((x) => x.status === 'pending').length,
      plannedSkips: skipRows.filter((x) => (x.status === 'pending' || x.status === 'approved') && Date.parse(x.period_start) > c.now).length,
      createdAt: d.created_at,
      createdBy: d.created_by,
      updatedAt: d.updated_at,
      updatedBy: d.updated_by,
      canEdit: canEditDuty(c.u, s),
      canRequestSkip: active && canRequestSkip(c.u, d, s),
    },
  };
}

const appNames = () =>
  new Map(
    db()
      .all<{ id: string; name: string }>('SELECT id, name FROM applications')
      .map((a) => [a.id, a.name]),
  );

export interface DutyFilter {
  serviceId?: string;
  applicationId?: string;
  archived?: boolean;
}

/** The duties (with their current and previous period) for the reader, ordered by service and name. */
export function listDutyViews(f: DutyFilter = {}, now = Date.now()): Built[] {
  me();
  const c = viewCtx(now);
  const services = new Map(
    db()
      .all<ServiceRef>('SELECT id, name, owners, archived FROM services')
      .map((s) => [s.id, s]),
  );
  const names = appNames();
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.serviceId) (where.push('service_id = ?'), args.push(f.serviceId));
  if (f.applicationId) (where.push('application_id = ?'), args.push(f.applicationId));
  if (!f.archived) where.push('archived = 0');
  return db()
    .all<DutyRow>(`SELECT * FROM service_duties${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name, id`, ...args)
    .filter((d) => services.has(d.service_id))
    .map((d) => build(d, services.get(d.service_id)!, c, d.application_id ? (names.get(d.application_id) ?? null) : null))
    .sort((a, b) => a.service.name.localeCompare(b.service.name) || a.row.name.localeCompare(b.row.name));
}

export const listDuties = (f: DutyFilter = {}, now = Date.now()): DutySummary[] => listDutyViews(f, now).map((b) => b.summary);

export function getDuty(dutyId: string, now = Date.now()): DutyDetail {
  me();
  const d = dutyRow(dutyId);
  const s = serviceRef(d.service_id);
  const c = viewCtx(now);
  const b = build(d, s, c, d.application_id ? (appNames().get(d.application_id) ?? null) : null);
  const skipRows = db().all<SkipRow>('SELECT * FROM duty_skips WHERE duty_id = ? ORDER BY requested_at DESC, id LIMIT 200', d.id);
  const skips = skipRows.map((r) => toSkip(r, d, s, c.u));
  const skipFor = (key: string) =>
    skips.find((x) => x.periodKey === key && x.status === 'approved') ?? skips.find((x) => x.periodKey === key && x.status === 'pending') ?? null;
  return { ...b.summary, periods: [...b.periods].reverse().map((e) => toPeriod(e, d, c, skipFor(e.period.key))), skips };
}

// ---------- changes ----------

/** Stores the open periods of a duty right after it changed, so the start page and the daily summary see it now. */
function refreshStored(dutyId: string): void {
  try {
    const d = dutyRow(dutyId);
    persistDuty(d, serviceRef(d.service_id), Date.now());
  } catch (err) {
    logger.warn({ err, dutyId }, 'duty periods could not be stored');
  }
}

function checkReferences(serviceId: string, input: DutyUpdateData): void {
  if (input.applicationId && !db().get('SELECT 1 FROM service_applications WHERE service_id = ? AND application_id = ?', serviceId, input.applicationId))
    throw new HttpError(400, 'The application is not part of the service', 'DUTY_APPLICATION_NOT_IN_SERVICE', { id: input.applicationId });
  const p = db().get<{ owner: string | null; acl: string }>('SELECT owner, acl FROM processes WHERE id = ?', input.processId);
  // a process the user may not see is "unknown" to them (no probing)
  if (!p || !processPermissions(currentUser(), { owner: p.owner, acl: parseJson(p.acl, []) }).includes('view'))
    throw new HttpError(400, `Process ${input.processId} not found`, 'DUTY_PROCESS_UNKNOWN', { id: input.processId });
  if (input.scheduleId) {
    const sch = db().get<{ process_id: string }>('SELECT process_id FROM schedules WHERE id = ?', input.scheduleId);
    if (!sch) throw new HttpError(400, `Schedule ${input.scheduleId} not found`, 'DUTY_SCHEDULE_UNKNOWN', { id: input.scheduleId });
    if (sch.process_id !== input.processId)
      throw new HttpError(400, 'The schedule runs another process than the duty', 'DUTY_SCHEDULE_PROCESS', { id: input.scheduleId });
  }
}

function checkName(serviceId: string, name: string, except?: string): void {
  if (db().get('SELECT 1 FROM service_duties WHERE service_id = ? AND lower(name) = lower(?) AND archived = 0 AND id <> ?', serviceId, name, except ?? ''))
    throw new HttpError(409, `The service has a duty named "${name}" already`, 'DUTY_EXISTS', { name });
}

export function createDuty(input: DutyInputData): DutyDetail {
  const u = me();
  const s = serviceRef(input.serviceId);
  if (!canEditDuty(u, s)) forbid('define duties of this service', 'changeService');
  if (s.archived) throw new HttpError(409, 'The service is archived', 'DUTY_SERVICE_ARCHIVED', { id: s.id });
  checkReferences(s.id, input);
  checkName(s.id, input.name);
  const dutyId = newId('dty_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO service_duties (id, service_id, application_id, name, description, process_id, schedule_id, interval_kind, level, grace_days, remind_days, owners, archived, active_from, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      dutyId,
      s.id,
      input.applicationId,
      input.name,
      input.description,
      input.processId,
      input.scheduleId,
      input.interval,
      input.level,
      input.graceDays,
      input.remindDays,
      JSON.stringify([...new Set(input.owners)]),
      now,
      now,
      u.username,
      now,
      u.username,
    );
    audit({
      action: 'duty.created',
      entityType: 'duty',
      entityId: dutyId,
      summary: `Duty "${input.name}" of service "${s.name}" defined (${input.level}, ${input.interval}${input.graceDays ? `, ${input.graceDays} days grace` : ''})`,
      details: {
        serviceId: s.id,
        applicationId: input.applicationId,
        processId: input.processId,
        scheduleId: input.scheduleId,
        interval: input.interval,
        level: input.level,
        graceDays: input.graceDays,
        remindDays: input.remindDays,
        owners: input.owners,
      },
    });
  });
  refreshStored(dutyId);
  return getDuty(dutyId);
}

/** Changes of the rules a period is judged by: the open periods are closed first, under the old rules (closeForChange). */
export const JUDGED_BY = ['process_id', 'interval_kind', 'grace_days', 'level'] as const;

export function updateDuty(dutyId: string, input: DutyUpdateData): DutyDetail {
  const u = me();
  const cur = dutyRow(dutyId);
  const s = serviceRef(cur.service_id);
  if (!canEditDuty(u, s)) forbid('change duties of this service', 'changeService');
  checkReferences(s.id, input);
  checkName(s.id, input.name, dutyId);
  const next = {
    application_id: input.applicationId,
    name: input.name,
    description: input.description,
    process_id: input.processId,
    schedule_id: input.scheduleId,
    interval_kind: input.interval,
    level: input.level,
    grace_days: input.graceDays,
    remind_days: input.remindDays,
    owners: JSON.stringify([...new Set(input.owners)]),
  };
  const changes = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (next[k] ?? null) !== (cur[k] ?? null));
  if (!changes.length) return getDuty(dutyId);
  const rules = changes.some((k) => (JUDGED_BY as readonly string[]).includes(k));
  db().tx(() => {
    // the open periods keep the result of the rules they ran under; the new rules start at the change (or after a
    // current period that is done already)
    const change = rules ? closeForChange(cur, s, Date.now(), 'duty changed') : null;
    db().run(
      `UPDATE service_duties SET application_id = ?, name = ?, description = ?, process_id = ?, schedule_id = ?, interval_kind = ?, level = ?, grace_days = ?,
       remind_days = ?, owners = ?, updated_at = ?, updated_by = ?${change ? ', rules_from = ?' : ''} WHERE id = ?`,
      next.application_id,
      next.name,
      next.description,
      next.process_id,
      next.schedule_id,
      next.interval_kind,
      next.level,
      next.grace_days,
      next.remind_days,
      next.owners,
      nowIso(),
      u.username,
      ...(change ? [new Date(change.rulesFrom).toISOString()] : []),
      dutyId,
    );
    audit({
      action: 'duty.updated',
      entityType: 'duty',
      entityId: dutyId,
      summary: `Duty "${input.name}" of service "${s.name}" changed (${changes.join(', ')})`,
      details: {
        changes,
        before: Object.fromEntries(changes.map((k) => [k, cur[k]])),
        after: Object.fromEntries(changes.map((k) => [k, next[k]])),
        periodsClosedEarly: (change?.closed ?? []).map((e) => ({ key: e.period.key, status: e.status })),
        ...(change ? { rulesFrom: new Date(change.rulesFrom).toISOString() } : {}),
      },
    });
  });
  refreshStored(dutyId);
  return getDuty(dutyId);
}

export function setDutyArchived(dutyId: string, archived: boolean): DutyDetail {
  const u = me();
  const cur = dutyRow(dutyId);
  const s = serviceRef(cur.service_id);
  if (!canEditDuty(u, s)) forbid('change duties of this service', 'changeService');
  if (!!cur.archived === archived) return getDuty(dutyId);
  if (!archived) checkName(s.id, cur.name, dutyId);
  db().tx(() => {
    // archiving ends the duty: the periods that ended are closed as they stand (and a current period that is done
    // already), the rest of the current period is not judged; a restored duty stores the periods it was archived
    // through as inactive and is judged again from the current period on
    const now = Date.now();
    // archiving closes the open periods as for a change of the rules (rules_from keeps the moment of the archive);
    // restoring stores the periods entirely inside the archive window as inactive and starts again now
    const change = archived ? closeForChange(cur, s, now, 'duty archived') : null;
    const closedEarly = change?.closed ?? [];
    const inactive = archived ? 0 : storeInactiveGap(cur, Date.parse(cur.rules_from ?? cur.updated_at), now);
    db().run(
      'UPDATE service_duties SET archived = ?, rules_from = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      archived ? 1 : 0,
      new Date(change ? Math.min(change.rulesFrom, now) : now).toISOString(),
      nowIso(),
      u.username,
      dutyId,
    );
    audit({
      action: archived ? 'duty.archived' : 'duty.restored',
      entityType: 'duty',
      entityId: dutyId,
      summary: `Duty "${cur.name}" of service "${s.name}" ${archived ? 'archived' : 'restored'}`,
      details: { serviceId: s.id, periodsClosedEarly: closedEarly.map((e) => ({ key: e.period.key, status: e.status })), inactivePeriods: inactive },
    });
  });
  refreshStored(dutyId);
  return getDuty(dutyId);
}

// ---------- skips (four-eyes) ----------

function skipRow(dutyId: string, skipId: string): SkipRow {
  const r = db().get<SkipRow>('SELECT * FROM duty_skips WHERE id = ? AND duty_id = ?', skipId, dutyId);
  if (!r) throw new HttpError(404, `Skip ${skipId} not found`, 'DUTY_SKIP_NOT_FOUND', { id: skipId });
  return r;
}

/** The evaluated period of a key (open or stored), or the bare period for a future one. */
function periodState(d: DutyRow, s: ServiceRef, key: string, now: number) {
  const tz = instanceTimeZone();
  const p = periodOfKey(d.interval_kind, key, tz);
  if (!p) throw new HttpError(400, `"${key}" is not a period of this duty`, 'DUTY_PERIOD_UNKNOWN', { key });
  const e = evaluateDuty(d, now, tz, activeDuty(d, s)).find((x) => x.period.key === key);
  return { p, e };
}

export function requestSkip(dutyId: string, input: z.infer<typeof skipInput>, now = Date.now()): DutyDetail {
  const u = me();
  const d = dutyRow(dutyId);
  const s = serviceRef(d.service_id);
  if (!canRequestSkip(u, d, s)) forbid('ask for an exception of this duty', 'requestDutySkip');
  if (!activeDuty(d, s)) throw new HttpError(409, 'The duty is archived', 'DUTY_ARCHIVED', { id: dutyId });
  const { p, e } = periodState(d, s, input.periodKey, now);
  if (e?.closed || e?.final || (!e && p.end <= now)) throw new HttpError(409, `The period ${p.key} is closed`, 'DUTY_PERIOD_CLOSED', { key: p.key });
  if (e && (e.status === 'done' || e.status === 'late')) throw new HttpError(409, `The duty is done for ${p.key}`, 'DUTY_PERIOD_DONE', { key: p.key });
  // the current period and the next few at most: no long queue of approved exceptions
  let limit = periodAt(d.interval_kind, now, instanceTimeZone());
  for (let i = 0; i < DUTY_LIMITS.skipAheadPeriods; i++) limit = nextPeriod(d.interval_kind, limit, instanceTimeZone());
  if (p.start > limit.start)
    throw new HttpError(400, `The period ${p.key} is too far ahead`, 'DUTY_PERIOD_TOO_FAR', { key: p.key, periods: DUTY_LIMITS.skipAheadPeriods });
  if (db().get("SELECT 1 FROM duty_skips WHERE duty_id = ? AND period_key = ? AND status IN ('pending', 'approved')", dutyId, p.key))
    throw new HttpError(409, `There is an exception for ${p.key} already`, 'DUTY_SKIP_EXISTS', { key: p.key });
  const skipId = newId('dsk_');
  const deciders = deciderSubjects(d, s);
  db().tx(() => {
    db().run(
      `INSERT INTO duty_skips (id, duty_id, period_key, period_start, reason, status, requested_by, requested_at, decision_comment, decider_subjects)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, '', ?)`,
      skipId,
      dutyId,
      p.key,
      iso(p.start),
      input.reason,
      u.username,
      nowIso(),
      JSON.stringify(deciders),
    );
    audit({
      action: 'duty.skip_requested',
      entityType: 'duty',
      entityId: dutyId,
      summary: `Exception asked for duty "${d.name}" of service "${s.name}", period ${p.key}: ${input.reason.slice(0, 300)}`,
      details: { skipId, periodKey: p.key, reason: input.reason, deciders },
    });
  });
  notifySkipRequested(d, s, { id: skipId, periodKey: p.key, reason: input.reason }, u);
  return getDuty(dutyId);
}

/**
 * Tells the people who may decide a new exception about it, once: the duty's and the service's owners as of the
 * request, else the administrators – never the requester.
 */
function notifySkipRequested(d: DutyRow, s: ServiceRef, skip: { id: string; periodKey: string; reason: string }, by: AuthUser): void {
  try {
    const all = listUsers().filter((x) => x.active && !sameIdentity(by.username, x));
    const subjects = deciderSubjects(d, s);
    const named = all.filter((x) => subjects.some((sub) => matches(toAuthUser(x), sub)));
    notify({
      event: 'duty.exception',
      text: (l) => ({
        title: t(l, 'duty.exceptionTitle', { name: titleName(d.name), service: titleName(s.name), period: skip.periodKey }),
        body: t(l, 'duty.exceptionBody', { user: by.username, name: d.name, service: s.name, period: skip.periodKey, reason: skip.reason.slice(0, 500) }),
      }),
      link: `/duties/${d.id}`,
      recipients: named.length ? named : all.filter((x) => x.roles.includes('admin')),
      inAppKey: `duty-skip:${skip.id}`,
      externalKey: `duty-skip:${skip.id}`,
      data: { dutyId: d.id, serviceId: s.id, skipId: skip.id, periodKey: skip.periodKey, requestedBy: by.username },
    });
  } catch (err) {
    logger.warn({ err, dutyId: d.id }, 'exception notification could not be sent');
  }
}

export function decideSkip(dutyId: string, skipId: string, input: z.infer<typeof decisionInput>, now = Date.now()): DutyDetail {
  const u = me();
  const d = dutyRow(dutyId);
  const s = serviceRef(d.service_id);
  const r = skipRow(dutyId, skipId);
  if (!mayDecideSkip(u, r)) forbid('decide exceptions of this duty', 'decideDutySkip');
  if (r.status !== 'pending') throw new HttpError(409, `The exception is ${r.status} already`, 'DUTY_SKIP_DECIDED', { status: r.status });
  // four-eyes: never the person who asked (also under a former name)
  if (sameIdentity(r.requested_by, u)) throw new HttpError(403, 'Four-eyes principle: another person decides the exception you asked for', 'FOUR_EYES_SKIP');
  const approve = input.decision === 'approve';
  if (approve) {
    const { e } = periodState(d, s, r.period_key, now);
    if (e?.closed || e?.final) throw new HttpError(409, `The period ${r.period_key} is closed`, 'DUTY_PERIOD_CLOSED', { key: r.period_key });
  }
  db().tx(() => {
    const changed = db().run(
      "UPDATE duty_skips SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ? AND status = 'pending'",
      approve ? 'approved' : 'rejected',
      u.username,
      nowIso(),
      input.comment,
      skipId,
    ).changes;
    if (!changed) throw new HttpError(409, 'The exception was decided already', 'DUTY_SKIP_DECIDED', { status: 'decided' });
    audit({
      action: approve ? 'duty.skip_approved' : 'duty.skip_rejected',
      entityType: 'duty',
      entityId: dutyId,
      summary: `Exception for duty "${d.name}" of service "${s.name}", period ${r.period_key} ${approve ? 'approved' : 'rejected'} (asked by ${r.requested_by})${input.comment ? `: ${input.comment.slice(0, 300)}` : ''}`,
      details: { skipId, periodKey: r.period_key, requestedBy: r.requested_by, reason: r.reason, comment: input.comment },
    });
  });
  refreshStored(dutyId);
  return getDuty(dutyId);
}

export function withdrawSkip(dutyId: string, skipId: string): DutyDetail {
  const u = me();
  const d = dutyRow(dutyId);
  const r = skipRow(dutyId, skipId);
  if (!sameIdentity(r.requested_by, u)) forbid('withdraw an exception someone else asked for', 'withdrawDutySkip');
  if (r.status !== 'pending') throw new HttpError(409, `The exception is ${r.status} already`, 'DUTY_SKIP_DECIDED', { status: r.status });
  db().tx(() => {
    db().run("UPDATE duty_skips SET status = 'withdrawn', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", u.username, nowIso(), skipId);
    audit({
      action: 'duty.skip_withdrawn',
      entityType: 'duty',
      entityId: dutyId,
      summary: `Exception for duty "${d.name}", period ${r.period_key} withdrawn`,
      details: { skipId, periodKey: r.period_key },
    });
  });
  return getDuty(dutyId);
}

// ---------- start page, daily summary ----------

/** Service editors, auditors and administrators see every duty on the start page; the others the duties they are responsible for. */
const seesAll = (u: AuthUser) => u.roles.some((r) => r === 'admin' || r === 'designer' || r === 'auditor');

/**
 * The stored state of the active duties, as the duty job keeps it (every five minutes, and right after a duty or one
 * of its exceptions changes): their open periods and their last closed period. The start page and the daily summary
 * read this instead of judging every duty on every request – it is at most one job tick old.
 */
function storedState(): { d: DutyRow; s: ServiceRef; open: PeriodRow[]; last: PeriodRow | null }[] {
  const services = new Map(
    db()
      .all<ServiceRef>('SELECT id, name, owners, archived FROM services WHERE archived = 0')
      .map((x) => [x.id, x]),
  );
  const open = new Map<string, PeriodRow[]>();
  for (const r of db().all<PeriodRow>('SELECT * FROM duty_periods WHERE closed_at IS NULL ORDER BY period_start'))
    open.set(r.duty_id, [...(open.get(r.duty_id) ?? []), r]);
  const last = new Map(
    db()
      .all<PeriodRow>(
        `SELECT p.* FROM duty_periods p WHERE p.closed_at IS NOT NULL
         AND p.period_end = (SELECT MAX(q.period_end) FROM duty_periods q WHERE q.duty_id = p.duty_id AND q.closed_at IS NOT NULL)`,
      )
      .map((r) => [r.duty_id, r]),
  );
  return db()
    .all<DutyRow>('SELECT * FROM service_duties WHERE archived = 0 ORDER BY id')
    .filter((d) => services.has(d.service_id))
    .map((d) => ({ d, s: services.get(d.service_id)!, open: open.get(d.id) ?? [], last: last.get(d.id) ?? null }));
}

/** Stored open periods that are not done and end within `days` (or are in their grace period). */
const dueRows = (open: PeriodRow[], now: number, days: number) =>
  open.filter((r) => r.status === 'due' && now < Date.parse(r.grace_end) && now >= addLocalDays(Date.parse(r.period_end), -days, r.time_zone));
/** The last period that ended was missed or failed (and no ended period is still in its grace period). */
const missedLast = (x: { open: PeriodRow[]; last: PeriodRow | null }, now: number) =>
  !!x.last && DUTY_NOT_MET.includes(x.last.status) && !x.open.some((r) => Date.parse(r.period_end) <= now);

/** The start page tile: mandatory duties due within a week or missed (their last period); null without any for the user. */
export function dutyAttention(now = Date.now()): { missed: number; dueSoon: number } | null {
  const u = currentUser();
  if (!u) return null;
  const all = storedState().filter((x) => x.d.level === 'mandatory');
  const mine = seesAll(u) ? all : all.filter((x) => isResponsible(u, x.d, x.s));
  if (!seesAll(u) && !mine.length) return null;
  return {
    missed: mine.filter((x) => missedLast(x, now)).length,
    dueSoon: mine.filter((x) => dueRows(x.open, now, 7).length > 0).length,
  };
}

export interface DutyDueItem {
  dutyId: string;
  name: string;
  serviceName: string;
  level: string;
  periodKey: string;
  status: 'due' | 'missed' | 'failed' | 'ended';
  /** Last day of the period (missed, failed, due) or of its grace period (due in the grace period) */
  dueAt: string;
}

/**
 * The duties a user is responsible for that need them (daily summary), from the stored periods: open periods due
 * within the reminder days (at least a week for duties without a reminder) or in their grace period, and periods of
 * mandatory and recommended duties that ended missed or failed between `since` and `until`.
 */
export function dutiesDueFor(u: AuthUser, since: number, until: number): DutyDueItem[] {
  const out: DutyDueItem[] = [];
  const state = storedState().filter((x) => isResponsible(u, x.d, x.s));
  const byId = new Map(state.map((x) => [x.d.id, x]));
  for (const r of db().all<PeriodRow>(
    "SELECT * FROM duty_periods WHERE closed_at IS NOT NULL AND status IN ('missed', 'failed', 'ended') AND level <> 'optional' AND grace_end >= ? AND grace_end < ? ORDER BY grace_end",
    iso(since),
    iso(until),
  )) {
    const x = byId.get(r.duty_id);
    if (x)
      out.push({
        dutyId: x.d.id,
        name: x.d.name,
        serviceName: x.s.name,
        level: r.level,
        periodKey: r.period_key,
        status: r.status as 'missed',
        dueAt: iso(Date.parse(r.period_end) - 1),
      });
  }
  for (const x of state)
    for (const r of dueRows(x.open, until, x.d.remind_days || 7)) {
      const end = Date.parse(r.period_end);
      out.push({
        dutyId: x.d.id,
        name: x.d.name,
        serviceName: x.s.name,
        level: x.d.level,
        periodKey: r.period_key,
        status: 'due',
        dueAt: iso((until >= end ? Date.parse(r.grace_end) : end) - 1),
      });
    }
  return out;
}
