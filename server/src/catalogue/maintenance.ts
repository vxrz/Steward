import { z } from 'zod';
import {
  MAINTENANCE_FREQS,
  MAINTENANCE_LIMITS,
  MAINTENANCE_TARGET_KINDS,
  occurrencesBetween,
  type AclEntry,
  type MaintenanceList,
  type MaintenanceOccurrence,
  type MaintenanceRecurrence,
  type MaintenanceTarget,
  type MaintenanceTargetKind,
  type MaintenanceWindowDetail,
  type MaintenanceWindowSummary,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { assertKnownSubjects } from '../auth/subjects.js';
import { canCreateServices, canEditService, canReadRecordRow, forbid, me } from '../records/access.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { instanceTimeZone } from '../duties/periods.js';
import { logger } from '../log.js';
import { setCatalogueMaintenance } from '../monitors/engine.js';
import { setMaintenancePause } from '../notifications/service.js';

/**
 * Maintenance windows (#108): planned work on platforms, systems, applications and services, once or repeating weekly
 * or monthly (in the instance's time zone, so 02:00 stays 02:00 across daylight saving changes).
 *
 * During an occurrence
 *   - monitors that check an affected platform show "maintenance" and send no alerts (checks are still recorded) –
 *     like a monitor's own maintenance window (engine.activeMaintenance asks here);
 *   - with "pause messages", check and run messages of runs bound to an affected platform go to the app only;
 *   - availability objectives of affected services and applications send no breach messages; their figures (Gatus'
 *     own uptime) stay as they are and show the planned minutes next to them.
 * Announcements go to the responsible people and the owners of what it affects: when planned, before an occurrence
 * (reminder), at its start and at its end.
 *
 * Who plans: designers and administrators, and whoever may change every item it affects (owners; for a platform the
 * manage right). Everyone who can sign in reads the windows (platforms they may not see are not named).
 */

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString();

interface WindowRow {
  id: string;
  title: string;
  note: string;
  starts_at: string;
  ends_at: string;
  recurrence: string | null;
  time_zone: string;
  responsible: string;
  change_record_id: string | null;
  quiet_monitors: number;
  pause_messages: number;
  reminder_hours: number;
  cancelled_at: string | null;
  cancelled_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}
type TargetRef = { kind: MaintenanceTargetKind; id: string };

// ---------- input ----------

const isoTime = z
  .string()
  .trim()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'an ISO timestamp')
  .transform((s) => new Date(s).toISOString());

const subject = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(user|team):[^\s].{0,119}$/, 'Use user:<name> or team:<name>');

export const maintenanceInput = z
  .object({
    title: z.string().trim().min(1).max(MAINTENANCE_LIMITS.title),
    note: z.string().max(MAINTENANCE_LIMITS.note).default(''),
    startsAt: isoTime,
    endsAt: isoTime,
    recurrence: z
      .object({
        freq: z.enum(MAINTENANCE_FREQS),
        interval: z.number().int().min(1).max(MAINTENANCE_LIMITS.interval).default(1),
        until: isoTime.nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
    targets: z
      .array(z.object({ kind: z.enum(MAINTENANCE_TARGET_KINDS), id: z.string().trim().min(1).max(100) }).strict())
      .min(1)
      .max(MAINTENANCE_LIMITS.targets),
    responsible: z.array(subject).max(20).default([]),
    changeRecordId: z.string().trim().min(1).max(100).nullable().default(null),
    quietMonitors: z.boolean().default(true),
    pauseMessages: z.boolean().default(false),
    reminderHours: z.number().int().min(0).max(MAINTENANCE_LIMITS.reminderHoursMax).default(24),
  })
  .strict();
export type MaintenanceInput = z.infer<typeof maintenanceInput>;

// ---------- targets: names, rights, what they reach ----------

type PlatformRow = { id: string; name: string; acl: string };
const platformRights = (u: AuthUser | null, p: Pick<PlatformRow, 'id' | 'acl'>) =>
  platformPermissions(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) });

function ownersOf(kind: Exclude<MaintenanceTargetKind, 'platform'>, id: string): string[] | null {
  const table = kind === 'service' ? 'services' : kind === 'application' ? 'applications' : 'systems';
  const r = db().get<{ owners: string }>(`SELECT owners FROM ${table} WHERE id = ?`, id);
  return r ? parseJson<string[]>(r.owners, []) : null;
}

function nameOf(t: TargetRef, u: AuthUser | null): string | null {
  if (t.kind === 'platform') {
    const p = db().get<PlatformRow>('SELECT id, name, acl FROM platforms WHERE id = ?', t.id);
    return p && platformRights(u, p).length ? p.name : null;
  }
  const table = t.kind === 'service' ? 'services' : t.kind === 'application' ? 'applications' : 'systems';
  return db().get<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, t.id)?.name ?? null;
}

/** May the user change this item (and so plan its maintenance)? */
function mayChange(u: AuthUser, t: TargetRef): boolean {
  if (t.kind === 'platform') {
    const p = db().get<PlatformRow>('SELECT id, name, acl FROM platforms WHERE id = ?', t.id);
    return !!p && platformRights(u, p).includes('manage');
  }
  const owners = ownersOf(t.kind, t.id);
  return owners !== null && canEditService(u, owners);
}

const canPlan = (u: AuthUser, targets: TargetRef[]) => canCreateServices(u) || (targets.length > 0 && targets.every((t) => mayChange(u, t)));

/** 400 for an item that does not exist (or a platform the user may not see). */
function checkTargets(targets: TargetRef[], u: AuthUser, kept: TargetRef[] = []): void {
  const keep = new Set(kept.map((t) => `${t.kind}:${t.id}`));
  for (const t of targets) {
    if (keep.has(`${t.kind}:${t.id}`)) continue;
    if (nameOf(t, u) === null) throw new HttpError(400, `The ${t.kind} ${t.id} does not exist`, 'MAINTENANCE_TARGET_NOT_FOUND', { kind: t.kind, id: t.id });
  }
}

export interface Reach {
  platforms: Set<string>;
  applications: Set<string>;
  services: Set<string>;
  systems: Set<string>;
}

/**
 * What a window reaches. Down from what it lists: a service's applications, an application's platforms and systems,
 * a system's platform (monitors and runs on those platforms are affected). Up from a platform or system: the
 * applications that use it, and the services of affected applications (objectives and owners are told) – but not the
 * other services of an application that is only reached through a listed service.
 */
export function reachOf(targets: TargetRef[]): Reach {
  const listed = (k: MaintenanceTargetKind) => targets.filter((t) => t.kind === k).map((t) => t.id);
  const ids = (sql: string, id: string) =>
    db()
      .all<{ id: string | null }>(sql, id)
      .flatMap((r) => (r.id ? [r.id] : []));
  const down = new Set(listed('application'));
  for (const s of listed('service')) for (const a of ids('SELECT application_id AS id FROM service_applications WHERE service_id = ?', s)) down.add(a);
  const up = new Set<string>();
  for (const p of listed('platform')) for (const a of ids('SELECT application_id AS id FROM application_platforms WHERE platform_id = ?', p)) up.add(a);
  for (const s of listed('system')) for (const a of ids('SELECT DISTINCT application_id AS id FROM application_systems WHERE system_id = ?', s)) up.add(a);
  const systems = new Set(listed('system'));
  const platforms = new Set(listed('platform'));
  for (const a of down) {
    for (const p of ids('SELECT platform_id AS id FROM application_platforms WHERE application_id = ?', a)) platforms.add(p);
    for (const s of ids('SELECT DISTINCT system_id AS id FROM application_systems WHERE application_id = ?', a)) systems.add(s);
  }
  for (const s of systems) for (const p of ids('SELECT platform_id AS id FROM systems WHERE id = ?', s)) platforms.add(p);
  const services = new Set(listed('service'));
  for (const a of [...listed('application'), ...up])
    for (const s of ids('SELECT service_id AS id FROM service_applications WHERE application_id = ?', a)) services.add(s);
  return { platforms, applications: new Set([...down, ...up]), services, systems };
}

// ---------- reading ----------

const targetsOf = (id: string): TargetRef[] =>
  db()
    .all<{ kind: MaintenanceTargetKind; target_id: string }>('SELECT kind, target_id FROM maintenance_targets WHERE window_id = ? ORDER BY kind, target_id', id)
    .map((t) => ({ kind: t.kind, id: t.target_id }));

const recurrenceOf = (r: WindowRow): MaintenanceRecurrence | null => (r.recurrence ? parseJson<MaintenanceRecurrence | null>(r.recurrence, null) : null);

const shape = (r: WindowRow) => ({ startsAt: r.starts_at, endsAt: r.ends_at, recurrence: recurrenceOf(r), timeZone: r.time_zone });

/** The occurrences of a window in [from, to) – none once it is cancelled (an occurrence going on ends at the cancellation). */
export function occurrencesOf(r: WindowRow, from: number, to: number): { start: number; end: number }[] {
  const end = r.cancelled_at ? Math.min(to, Date.parse(r.cancelled_at)) : to;
  return occurrencesBetween(shape(r), from, end).map((o) => ({ start: o.start, end: r.cancelled_at ? Math.min(o.end, Date.parse(r.cancelled_at)) : o.end }));
}

function currentOf(r: WindowRow, now: number) {
  const o = occurrencesOf(r, now, now + 400 * DAY)[0];
  return o ? { startsAt: iso(o.start), endsAt: iso(o.end), active: o.start <= now && now < o.end } : null;
}

function row(id: string): WindowRow {
  const r = db().get<WindowRow>('SELECT * FROM maintenance_windows WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Maintenance window ${id} not found`, 'MAINTENANCE_NOT_FOUND', { id });
  return r;
}

function changeRecordOf(id: string | null, u: AuthUser | null): MaintenanceWindowSummary['changeRecord'] {
  if (!id) return null;
  const rec = db().get<{ id: string; number: string; title: string; type_id: string; fields: string; owner: string }>(
    'SELECT id, number, title, type_id, fields, owner FROM records WHERE id = ?',
    id,
  );
  return rec && canReadRecordRow(u, rec) ? { id: rec.id, number: rec.number, title: rec.title } : null;
}

function toSummary(r: WindowRow, u: AuthUser | null, now: number): MaintenanceWindowSummary {
  const targets = targetsOf(r.id);
  return {
    id: r.id,
    title: r.title,
    note: r.note,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    recurrence: recurrenceOf(r),
    timeZone: r.time_zone,
    responsible: parseJson<string[]>(r.responsible, []),
    targets: targets.map((t): MaintenanceTarget => ({ ...t, name: nameOf(t, u) })),
    changeRecord: changeRecordOf(r.change_record_id, u),
    quietMonitors: !!r.quiet_monitors,
    pauseMessages: !!r.pause_messages,
    reminderHours: Number(r.reminder_hours),
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    current: r.cancelled_at && Date.parse(r.cancelled_at) <= now ? null : currentOf(r, now),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    canEdit: !!u && !r.cancelled_at && canPlan(u, targets),
  };
}

/** Monitors that check one of these platforms (their definitions name the platform ids). */
function monitorsOn(platforms: Set<string>): string[] {
  if (!platforms.size) return [];
  return db()
    .all<{ id: string; definition: string }>('SELECT id, definition FROM monitors WHERE is_template = 0')
    .filter((m) => platformsOfDefinition(m.definition).some((p) => platforms.has(p)))
    .map((m) => m.id);
}

/** The platform ids a monitor definition names (checks and their inputs: every `platform` field). */
function platformsOfDefinition(definition: string): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'platform' && typeof x === 'string') out.add(x);
      else walk(x, depth + 1);
    }
  };
  walk(parseJson<unknown>(definition, {}), 0);
  return [...out];
}

export interface MaintenanceFilter {
  from?: string;
  to?: string;
  /** kind:id – windows that list or reach this item */
  target?: string;
  cancelled?: boolean;
}

export function listMaintenance(f: MaintenanceFilter = {}, now = Date.now()): MaintenanceList {
  const u = me();
  const from = f.from ? Date.parse(f.from) : now - DAY;
  const to = Math.min(f.to ? Date.parse(f.to) : now + 60 * DAY, from + 400 * DAY);
  if (!(to > from)) throw new HttpError(400, 'The range must end after it starts', 'MAINTENANCE_RANGE');
  let rows = db().all<WindowRow>(`SELECT * FROM maintenance_windows ${f.cancelled ? '' : 'WHERE cancelled_at IS NULL'} ORDER BY starts_at`);
  if (f.target) {
    const [kind, id] = [f.target.slice(0, f.target.indexOf(':')), f.target.slice(f.target.indexOf(':') + 1)];
    rows = rows.filter((r) => {
      const reach = reachOf(targetsOf(r.id));
      const set = reach[`${kind}s` as keyof Reach] as Set<string> | undefined;
      return !!set?.has(id);
    });
  }
  const windows = rows.map((r) => toSummary(r, u, now));
  const byId = new Map(windows.map((w) => [w.id, w]));
  const occurrences: MaintenanceOccurrence[] = rows
    .flatMap((r) =>
      occurrencesOf(r, from, to).map((o) => ({
        windowId: r.id,
        title: r.title,
        startsAt: iso(o.start),
        endsAt: iso(o.end),
        active: o.start <= now && now < o.end,
        targets: byId.get(r.id)!.targets,
      })),
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  // past windows that ended are listed with their occurrences only when they overlap the range
  const used = new Set(occurrences.map((o) => o.windowId));
  return {
    windows: windows.filter((w) => used.has(w.id) || (w.current && Date.parse(w.current.startsAt) < to)),
    occurrences,
    from: iso(from),
    to: iso(to),
    canPlan: canCreateServices(u),
  };
}

export function getMaintenance(id: string, now = Date.now()): MaintenanceWindowDetail {
  const u = me();
  const r = row(id);
  const reach = reachOf(targetsOf(id));
  return {
    ...toSummary(r, u, now),
    upcoming: occurrencesOf(r, now, now + 400 * DAY)
      .slice(0, 20)
      .map((o) => ({ startsAt: iso(o.start), endsAt: iso(o.end) })),
    affected: {
      platforms: reach.platforms.size,
      monitors: monitorsOn(reach.platforms).length,
      applications: reach.applications.size,
      services: reach.services.size,
    },
  };
}

// ---------- changing ----------

function validate(input: MaintenanceInput): void {
  const s = Date.parse(input.startsAt);
  const e = Date.parse(input.endsAt);
  if (!(e > s)) throw new HttpError(400, 'A maintenance window ends after it starts', 'MAINTENANCE_END_BEFORE_START');
  if (e - s > MAINTENANCE_LIMITS.maxDays * DAY)
    throw new HttpError(400, `A maintenance window lasts at most ${MAINTENANCE_LIMITS.maxDays} days`, 'MAINTENANCE_TOO_LONG', {
      days: MAINTENANCE_LIMITS.maxDays,
    });
  if (input.recurrence) {
    const period = (input.recurrence.freq === 'weekly' ? 7 : 28) * DAY * input.recurrence.interval;
    if (e - s >= period) throw new HttpError(400, 'A repeating window must end before it repeats', 'MAINTENANCE_OVERLAPS_ITSELF');
    if (input.recurrence.until && Date.parse(input.recurrence.until) < s)
      throw new HttpError(400, 'The repetition ends before the first window', 'MAINTENANCE_UNTIL_BEFORE_START');
  }
}

function checkChangeRecord(id: string | null, u: AuthUser, unchanged: string | null = null): void {
  if (!id || id === unchanged) return;
  if (!changeRecordOf(id, u)) throw new HttpError(400, `Record ${id} not found`, 'RECORD_NOT_FOUND', { id });
}

const describe = (input: MaintenanceInput) =>
  `${input.startsAt} – ${input.endsAt}${input.recurrence ? `, every ${input.recurrence.interval > 1 ? `${input.recurrence.interval} ` : ''}${input.recurrence.freq === 'weekly' ? 'week(s)' : 'month(s)'}` : ''}`;

function writeTargets(id: string, targets: TargetRef[]): void {
  db().run('DELETE FROM maintenance_targets WHERE window_id = ?', id);
  const seen = new Set<string>();
  for (const t of targets) {
    const k = `${t.kind}:${t.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    db().run('INSERT INTO maintenance_targets (window_id, kind, target_id) VALUES (?, ?, ?)', id, t.kind, t.id);
  }
}

export function createMaintenance(input: MaintenanceInput): MaintenanceWindowDetail {
  const u = me();
  if (!canPlan(u, input.targets)) forbid('plan maintenance for these items', 'planMaintenance');
  validate(input);
  checkTargets(input.targets, u);
  assertKnownSubjects(input.responsible);
  checkChangeRecord(input.changeRecordId, u);
  const id = newId('mtw_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO maintenance_windows (id, title, note, starts_at, ends_at, recurrence, time_zone, responsible, change_record_id, quiet_monitors,
         pause_messages, reminder_hours, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.title,
      input.note,
      input.startsAt,
      input.endsAt,
      input.recurrence ? JSON.stringify(input.recurrence) : null,
      instanceTimeZone(),
      JSON.stringify([...new Set(input.responsible)]),
      input.changeRecordId,
      input.quietMonitors ? 1 : 0,
      input.pauseMessages ? 1 : 0,
      input.reminderHours,
      now,
      u.username,
      now,
      u.username,
    );
    writeTargets(id, input.targets);
    audit({
      action: 'maintenance.created',
      entityType: 'maintenance',
      entityId: id,
      summary: `Maintenance "${input.title}" planned (${describe(input)}; ${input.targets.length} item(s))`,
      details: { ...input },
    });
  });
  invalidate();
  announce(row(id), 'planned', Date.parse(input.startsAt));
  return getMaintenance(id);
}

export function updateMaintenance(id: string, input: MaintenanceInput): MaintenanceWindowDetail {
  const u = me();
  const cur = row(id);
  const before = targetsOf(id);
  if (cur.cancelled_at) throw new HttpError(409, 'The maintenance window was cancelled', 'MAINTENANCE_CANCELLED');
  if (!canPlan(u, before) || !canPlan(u, input.targets)) forbid('change this maintenance window', 'planMaintenance');
  validate(input);
  checkTargets(input.targets, u, before);
  assertKnownSubjects(input.responsible, parseJson<string[]>(cur.responsible, []));
  checkChangeRecord(input.changeRecordId, u, cur.change_record_id);
  db().tx(() => {
    db().run(
      `UPDATE maintenance_windows SET title = ?, note = ?, starts_at = ?, ends_at = ?, recurrence = ?, responsible = ?, change_record_id = ?,
         quiet_monitors = ?, pause_messages = ?, reminder_hours = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      input.title,
      input.note,
      input.startsAt,
      input.endsAt,
      input.recurrence ? JSON.stringify(input.recurrence) : null,
      JSON.stringify([...new Set(input.responsible)]),
      input.changeRecordId,
      input.quietMonitors ? 1 : 0,
      input.pauseMessages ? 1 : 0,
      input.reminderHours,
      nowIso(),
      u.username,
      id,
    );
    writeTargets(id, input.targets);
    audit({
      action: 'maintenance.changed',
      entityType: 'maintenance',
      entityId: id,
      summary: `Maintenance "${input.title}" changed (${describe(input)})`,
      details: { before: { ...shape(cur), title: cur.title, targets: before }, after: input },
    });
  });
  invalidate();
  return getMaintenance(id);
}

export function cancelMaintenance(id: string, reason: string): MaintenanceWindowDetail {
  const u = me();
  const cur = row(id);
  if (cur.cancelled_at) return getMaintenance(id);
  if (!canPlan(u, targetsOf(id))) forbid('cancel this maintenance window', 'planMaintenance');
  const now = nowIso();
  db().tx(() => {
    db().run(
      'UPDATE maintenance_windows SET cancelled_at = ?, cancelled_by = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      now,
      u.username,
      now,
      u.username,
      id,
    );
    audit({
      action: 'maintenance.cancelled',
      entityType: 'maintenance',
      entityId: id,
      summary: `Maintenance "${cur.title}" cancelled${reason ? `: ${reason}` : ''}`,
      details: { reason },
    });
  });
  invalidate();
  return getMaintenance(id);
}

// ---------- in effect now (cached briefly: the monitor engine asks every cycle) ----------

interface Active {
  row: WindowRow;
  start: number;
  end: number;
  reach: Reach;
}
let cache: { at: number; list: Active[] } | null = null;
const CACHE_MS = 15_000;
const invalidate = () => {
  cache = null;
  allCache = null;
  monitorPlatformCache.clear();
};

function activeNow(now: number): Active[] {
  if (cache && Math.abs(now - cache.at) < CACHE_MS) return cache.list;
  const list: Active[] = [];
  for (const r of db().all<WindowRow>('SELECT * FROM maintenance_windows WHERE cancelled_at IS NULL OR cancelled_at > ?', iso(now))) {
    const o = occurrencesOf(r, now, now + 1)[0];
    if (o && o.start <= now && now < o.end) list.push({ row: r, start: o.start, end: o.end, reach: reachOf(targetsOf(r.id)) });
  }
  cache = { at: now, list };
  return list;
}

const monitorPlatformCache = new Map<string, { version: number; platforms: string[] }>();
function monitorPlatforms(monitorId: string): string[] {
  const m = db().get<{ version: number; definition: string }>('SELECT version, definition FROM monitors WHERE id = ?', monitorId);
  if (!m) return [];
  const c = monitorPlatformCache.get(monitorId);
  if (c && c.version === Number(m.version)) return c.platforms;
  const platforms = platformsOfDefinition(m.definition);
  monitorPlatformCache.set(monitorId, { version: Number(m.version), platforms });
  return platforms;
}

/** The catalogue maintenance a monitor is in now (quiet monitors only), for the engine. */
export function maintenanceForMonitor(monitorId: string, now = Date.now()): { id: string; starts_at: string; ends_at: string; reason: string } | undefined {
  const list = activeNow(now).filter((a) => a.row.quiet_monitors);
  if (!list.length) return undefined;
  const platforms = monitorPlatforms(monitorId);
  const a = list.find((x) => platforms.some((p) => x.reach.platforms.has(p)));
  return a ? { id: a.row.id, starts_at: iso(a.start), ends_at: iso(a.end), reason: a.row.title } : undefined;
}

/** Do check and run messages of this run go to the app only (a window with "pause messages" on one of its platforms)? */
export function maintenancePausesRun(runId: string, now = Date.now()): boolean {
  const list = activeNow(now).filter((a) => a.row.pause_messages);
  if (!list.length) return false;
  const bindings = parseJson<Record<string, string>>(db().get<{ bindings: string }>('SELECT bindings FROM runs WHERE id = ?', runId)?.bindings ?? '{}', {});
  const platforms = Object.values(bindings).filter((x): x is string => typeof x === 'string');
  return list.some((a) => platforms.some((p) => a.reach.platforms.has(p)));
}

/** Is an availability objective (of a service, optionally one of its applications) under maintenance now? */
export function objectiveInMaintenance(o: { service_id: string; application_id: string | null }, now = Date.now()): boolean {
  return activeNow(now).some((a) => (o.application_id ? a.reach.applications.has(o.application_id) : false) || a.reach.services.has(o.service_id));
}

// every window with what it reaches (cached briefly: objective views ask for each objective)
let allCache: { at: number; list: { row: WindowRow; reach: Reach }[] } | null = null;
function allWithReach(now: number) {
  if (allCache && Math.abs(now - allCache.at) < CACHE_MS) return allCache.list;
  const list = db()
    .all<WindowRow>('SELECT * FROM maintenance_windows')
    .map((row) => ({ row, reach: reachOf(targetsOf(row.id)) }));
  allCache = { at: now, list };
  return list;
}

/**
 * Planned maintenance minutes of an objective's service or application within each uptime window ending now
 * (overlapping occurrences of one window counted once; a cancelled window counts up to when it was cancelled).
 */
export function plannedMinutes<K extends string>(
  o: { service_id: string; application_id: string | null },
  windowsMs: Record<K, number>,
  now = Date.now(),
): Record<K, number> {
  const keys = Object.keys(windowsMs) as K[];
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const longest = Math.max(0, ...keys.map((k) => windowsMs[k]));
  const spans: { start: number; end: number }[] = [];
  for (const { row: r, reach } of allWithReach(now)) {
    if (!(reach.services.has(o.service_id) || (o.application_id && reach.applications.has(o.application_id)))) continue;
    const stop = r.cancelled_at ? Math.min(now, Date.parse(r.cancelled_at)) : now;
    for (const occ of occurrencesOf(r, now - longest, stop)) spans.push({ start: occ.start, end: Math.min(occ.end, stop) });
  }
  if (!spans.length) return out;
  // merge overlaps, so two windows at the same time count once
  spans.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const x of spans) {
    const last = merged[merged.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else merged.push({ ...x });
  }
  for (const k of keys) {
    let ms = 0;
    for (const x of merged) ms += Math.max(0, Math.min(x.end, now) - Math.max(x.start, now - windowsMs[k]));
    out[k] = Math.round(ms / 60000);
  }
  return out;
}

// the monitor engine and the notifications ask here (registered, so neither imports this module)
setCatalogueMaintenance((mid, now) => maintenanceForMonitor(mid, now));
setMaintenancePause((runId) => maintenancePausesRun(runId));

// ---------- announcements ----------

type NoticeKind = 'planned' | 'reminder' | 'start' | 'end';

/** The people to tell: the responsible people and the owners of what it lists and reaches (applications, systems). */
async function recipientsOf(r: WindowRow) {
  const { usersOfSubjects } = await import('../tickets/reminders.js');
  const targets = targetsOf(r.id);
  const reach = reachOf(targets);
  const subjects = new Set<string>(parseJson<string[]>(r.responsible, []));
  for (const t of targets) if (t.kind !== 'platform') for (const s of ownersOf(t.kind, t.id) ?? []) subjects.add(s);
  for (const a of reach.applications) for (const s of ownersOf('application', a) ?? []) subjects.add(s);
  const users = usersOfSubjects([...subjects]);
  const creator = db().get<{ username: string }>('SELECT username FROM users WHERE username = ? AND active = 1', r.created_by);
  if (!users.length && creator) return usersOfSubjects([`user:${creator.username.toLowerCase()}`]);
  return users;
}

function announce(r: WindowRow, kind: NoticeKind, start: number): boolean {
  const claimed =
    db().run(
      'INSERT INTO maintenance_notices (window_id, occurrence_start, kind, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      r.id,
      kind === 'planned' ? '' : iso(start),
      kind,
      nowIso(),
    ).changes === 1;
  if (!claimed) return false;
  void (async () => {
    const { notify } = await import('../notifications/service.js');
    const { t, formatDateTime } = await import('../i18n/index.js');
    const recipients = await recipientsOf(r);
    const dur = Date.parse(r.ends_at) - Date.parse(r.starts_at);
    const items = targetsOf(r.id)
      .map((x) => nameOf(x, null))
      .filter((x): x is string => !!x);
    notify({
      event: 'maintenance.announced',
      text: (l) => {
        const params = {
          title: r.title,
          start: formatDateTime(l, iso(start)),
          end: formatDateTime(l, iso(start + dur)),
          items: items.join(', ') || '–',
          note: r.note.slice(0, 500),
        };
        return { title: t(l, `maintenance.${kind}.title`, params), body: t(l, `maintenance.${kind}.body`, params) + (r.note ? `\n\n${params.note}` : '') };
      },
      link: `/maintenance?open=${r.id}`,
      recipients,
      inAppKey: `maintenance:${r.id}:${kind}:${iso(start)}`,
      externalKey: `maintenance:${r.id}:${kind}:${iso(start)}`,
      data: { windowId: r.id, phase: kind, startsAt: iso(start), endsAt: iso(start + dur) },
    });
  })().catch((err) => logger.warn({ err }, 'maintenance announcement failed'));
  return true;
}

/** The job (every minute): reminders before, and messages at the start and end of each occurrence. */
export function runMaintenanceJob(now = Date.now()): number {
  let sent = 0;
  for (const r of db().all<WindowRow>('SELECT * FROM maintenance_windows WHERE cancelled_at IS NULL')) {
    const ahead = Math.max(Number(r.reminder_hours), 0) * 3600000;
    for (const o of occurrencesOf(r, now - 2 * 3600000, now + ahead + 60000)) {
      const due: NoticeKind | null =
        now >= o.end && now < o.end + 2 * 3600000
          ? 'end'
          : now >= o.start && now < o.end
            ? 'start'
            : ahead && now >= o.start - ahead && now < o.start
              ? 'reminder'
              : null;
      if (!due) continue;
      // a window planned shortly before it starts gets no separate reminder
      if (due === 'reminder' && Date.parse(r.created_at) > o.start - ahead) continue;
      if (!announce(r, due, o.start)) continue;
      sent++;
      if (due === 'start' || due === 'end') invalidate();
    }
  }
  return sent;
}

// ---------- calendar file ----------

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Lines longer than 75 octets are folded (RFC 5545 3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}
const localStamp = (t: number, tz: string) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
};
const utcStamp = (t: number) =>
  iso(t)
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/**
 * Monthly on the 29th–31st: Steward moves the window to the last day of shorter months; plain RRULEs would skip those
 * months, so the rule picks the latest of the days 28…d that the month has.
 */
function monthEnd(rec: MaintenanceRecurrence, start: number, tz: string): string {
  if (rec.freq !== 'monthly') return '';
  const d = Number(localStamp(start, tz).slice(6, 8));
  if (d < 29) return '';
  return `;BYMONTHDAY=${Array.from({ length: d - 27 }, (_, i) => 28 + i).join(',')};BYSETPOS=-1`;
}

/** The window as an iCalendar file (one event, with its repetition), to add to a calendar. */
export function maintenanceIcs(id: string): { name: string; body: string } {
  const u = me();
  const r = row(id);
  const w = toSummary(r, u, Date.now());
  const s = Date.parse(r.starts_at);
  const e = Date.parse(r.ends_at);
  const rec = recurrenceOf(r);
  const items = w.targets
    .map((x) => x.name)
    .filter(Boolean)
    .join(', ');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Steward//Maintenance//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${r.id}@steward`,
    `DTSTAMP:${utcStamp(Date.now())}`,
    `DTSTART;TZID=${r.time_zone}:${localStamp(s, r.time_zone)}`,
    `DTEND;TZID=${r.time_zone}:${localStamp(e, r.time_zone)}`,
    ...(rec
      ? [
          `RRULE:FREQ=${rec.freq.toUpperCase()};INTERVAL=${rec.interval}${monthEnd(rec, s, r.time_zone)}${rec.until ? `;UNTIL=${utcStamp(Date.parse(rec.until))}` : ''}`,
        ]
      : []),
    `SUMMARY:${icsText(r.title)}`,
    `DESCRIPTION:${icsText([items && `Affects: ${items}`, r.note].filter(Boolean).join('\n\n'))}`,
    ...(r.cancelled_at ? ['STATUS:CANCELLED'] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return { name: `${r.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'maintenance'}.ics`, body: lines.map(fold).join('\r\n') + '\r\n' };
}
