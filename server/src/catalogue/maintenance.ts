import { z } from 'zod';
import {
  MAINTENANCE_FREQS,
  MAINTENANCE_KINDS,
  MAINTENANCE_LIMITS,
  MAINTENANCE_TARGET_KINDS,
  isPlantMaintenanceTarget,
  occurrencesBetween,
  type AclEntry,
  type MaintenanceList,
  type MaintenanceOccurrence,
  type MaintenanceRecurrence,
  type MaintenanceTarget,
  type MaintenanceTargetKind,
  type MaintenanceWindowDetail,
  type MaintenanceWindowSummary,
  type MaintenanceWindow as MonitorMaintenanceWindow,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { assertKnownSubjects } from '../auth/subjects.js';
import { canCreateServices, canEditService, canReadRecordRow, canViewCatalogue, forbid, me } from '../records/access.js';
import { catalogueTeams, owningTeams } from '../auth/policy.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { instanceTimeZone } from '../duties/periods.js';
import { logger } from '../log.js';
import { setCatalogueMaintenance, setPlannedDowntime } from '../monitors/maintenance-hook.js';
import { permissionsOfRow } from '../monitors/model.js';
import { setMaintenancePause } from '../notifications/service.js';
import { mayPlanPlantTarget, plantTarget, plantTargetName } from '../plant/targets.js';

/**
 * Maintenance windows (#108): planned work on platforms, systems, applications, services and monitors, once or
 * repeating weekly or monthly (in the instance's time zone, so 02:00 stays 02:00 across daylight saving changes).
 * This is the one maintenance-window concept (0.11, ADR 0018): the monitors' own windows of earlier versions were
 * copied into windows that list the monitor (migrateMonitorWindows), and the monitor API's maintenance routes
 * (deprecated) read and write such windows.
 *
 * During an occurrence
 *   - monitors it lists, and monitors that check an affected platform, show "maintenance" and send no alerts (checks
 *     are still recorded; engine.activeMaintenance asks here); objectives with such a monitor as their source send no
 *     breach messages and show the planned minutes;
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
  /** maintenance or downtime (0.13, ADR 0021) */
  kind: string;
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
  /** 0: disabled (a copy starts so): it neither applies nor announces anything */
  enabled: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}
export type TargetRef = { kind: MaintenanceTargetKind; id: string };
type CatalogueKind = 'service' | 'application' | 'system';
const catalogueTable = (kind: CatalogueKind) => (kind === 'service' ? 'services' : kind === 'application' ? 'applications' : 'systems');

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
    /** maintenance (default) or planned downtime (ADR 0021) */
    kind: z.enum(MAINTENANCE_KINDS).default('maintenance'),
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
      // a plant device or collection is written <asset>/<id> (0.14)
      .array(z.object({ kind: z.enum(MAINTENANCE_TARGET_KINDS), id: z.string().trim().min(1).max(161) }).strict())
      .min(1)
      .max(MAINTENANCE_LIMITS.targets),
    responsible: z.array(subject).max(20).default([]),
    changeRecordId: z.string().trim().min(1).max(100).nullable().default(null),
    quietMonitors: z.boolean().default(true),
    pauseMessages: z.boolean().default(false),
    /** Missing: 24 for maintenance, 0 for downtime (announcements are off by default) */
    reminderHours: z.number().int().min(0).max(MAINTENANCE_LIMITS.reminderHoursMax).optional(),
    /** A disabled window neither applies nor announces anything (missing: enabled when planned, unchanged when changed) */
    enabled: z.boolean().optional(),
  })
  .strict();
export type MaintenanceInput = z.infer<typeof maintenanceInput>;

// ---------- targets: names, rights, what they reach ----------

type PlatformRow = { id: string; name: string; acl: string };
const platformRights = (u: AuthUser | null, p: Pick<PlatformRow, 'id' | 'acl'>) =>
  platformPermissions(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) });

type MonitorRef = { id: string; name: string; owner: string; acl: string };
/** A monitor (not a template) by id. */
export const monitorRef = (id: string) => db().get<MonitorRef>('SELECT id, name, owner, acl FROM monitors WHERE id = ? AND is_template = 0', id);

export function ownersOf(kind: CatalogueKind, id: string): string[] | null {
  const r = db().get<{ owners: string }>(`SELECT owners FROM ${catalogueTable(kind)} WHERE id = ?`, id);
  return r ? parseJson<string[]>(r.owners, []) : null;
}

/** The item's name, or null when it does not exist or the reader may not see it (#131); jobs without a reader see all. */
export function nameOf(t: TargetRef, u: AuthUser | null): string | null {
  // 0.14: a site, asset, device or collection of the plant registry – who may see its site
  if (isPlantMaintenanceTarget(t.kind)) return plantTargetName(t.kind, t.id, u);
  if (t.kind === 'platform') {
    const p = db().get<PlatformRow>('SELECT id, name, acl FROM platforms WHERE id = ?', t.id);
    return p && platformRights(u, p).length ? p.name : null;
  }
  if (t.kind === 'monitor') {
    const m = monitorRef(t.id);
    return m && (!u || permissionsOfRow(m, u).includes('view')) ? m.name : null;
  }
  const r = db().get<{ name: string; owners: string }>(`SELECT name, owners FROM ${catalogueTable(t.kind)} WHERE id = ?`, t.id);
  if (!r) return null;
  if (u && !canViewCatalogue(u, { kind: t.kind, id: t.id, owners: parseJson<string[]>(r.owners, []) })) return null;
  return r.name;
}

/** Whether the item belongs to owning teams (#131): then only those who may change it plan its maintenance. */
const teamScopedTarget = (t: TargetRef): boolean =>
  isPlantMaintenanceTarget(t.kind) || (t.kind === 'platform' || t.kind === 'monitor' ? owningTeams(t.kind, t.id) : catalogueTeams(t.kind, t.id)).length > 0;

/**
 * May the user change this item (and so plan its maintenance)? For a platform the manage right; for a monitor the
 * acknowledge right, which its own maintenance windows needed before 0.11.
 */
function mayChange(u: AuthUser, t: TargetRef): boolean {
  // 0.14: plant entries – who manages their site
  if (isPlantMaintenanceTarget(t.kind)) return mayPlanPlantTarget(t.kind, t.id, u);
  if (t.kind === 'platform') {
    const p = db().get<PlatformRow>('SELECT id, name, acl FROM platforms WHERE id = ?', t.id);
    return !!p && platformRights(u, p).includes('manage');
  }
  if (t.kind === 'monitor') {
    const m = monitorRef(t.id);
    return !!m && permissionsOfRow(m, u).includes('acknowledge');
  }
  const owners = ownersOf(t.kind, t.id);
  return owners !== null && canEditService(u, { kind: t.kind, id: t.id, owners });
}

/**
 * Planning maintenance for these items: each one the user may change, or – for items of the whole instance (no owning
 * team), as before team scopes – any item a service editor can see. Monitors always need the acknowledge right (as
 * their own windows did); plant entries who manages their site (0.14). A window without items: service editors.
 */
export const canPlan = (u: AuthUser, targets: TargetRef[]) =>
  targets.length
    ? targets.every((t) => mayChange(u, t) || (t.kind !== 'monitor' && canCreateServices(u) && !teamScopedTarget(t) && nameOf(t, u) !== null))
    : canCreateServices(u);
/** A window is listed to a reader who sees at least one of its items (or it has none). */
const windowVisible = (u: AuthUser | null, targets: TargetRef[]) => !u || !targets.length || targets.some((t) => nameOf(t, u) !== null);

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
  /** The monitors it lists (monitors on an affected platform are reached too: reachesMonitor) */
  monitors: Set<string>;
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
  return { platforms, applications: new Set([...down, ...up]), services, systems, monitors: new Set(listed('monitor')) };
}

/** Does a window with this reach affect the monitor (it lists the monitor, or the monitor checks an affected platform)? */
export const reachesMonitor = (reach: Reach, monitorId: string): boolean =>
  reach.monitors.has(monitorId) || (reach.platforms.size > 0 && monitorPlatforms(monitorId).some((p) => reach.platforms.has(p)));

// ---------- reading ----------

export const targetsOf = (id: string): TargetRef[] =>
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

/** A window the reader may see (404 otherwise, as for one that does not exist). */
export function visibleRow(id: string, u: AuthUser | null): WindowRow {
  const r = row(id);
  if (!windowVisible(u, targetsOf(id))) throw new HttpError(404, `Maintenance window ${id} not found`, 'MAINTENANCE_NOT_FOUND', { id });
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
    kind: r.kind === 'downtime' ? 'downtime' : 'maintenance',
    title: r.title,
    note: r.note,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    recurrence: recurrenceOf(r),
    timeZone: r.time_zone,
    responsible: parseJson<string[]>(r.responsible, []),
    // only the items the reader may see: names and ids of others' items stay hidden (#131)
    targets: targets.flatMap((t): MaintenanceTarget[] => {
      const name = nameOf(t, u);
      return name === null && u ? [] : [{ ...t, name }];
    }),
    changeRecord: changeRecordOf(r.change_record_id, u),
    quietMonitors: !!r.quiet_monitors,
    pauseMessages: !!r.pause_messages,
    reminderHours: Number(r.reminder_hours),
    cancelledAt: r.cancelled_at,
    cancelledBy: r.cancelled_by,
    enabled: r.enabled !== 0,
    current: r.cancelled_at && Date.parse(r.cancelled_at) <= now ? null : currentOf(r, now),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    canEdit: !!u && !r.cancelled_at && canPlan(u, targets),
  };
}

/** Monitors that check one of these platforms (their definitions name the platform ids). */
export function monitorsOn(platforms: Set<string>): string[] {
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
  let rows = db()
    .all<WindowRow>(`SELECT * FROM maintenance_windows ${f.cancelled ? '' : 'WHERE cancelled_at IS NULL'} ORDER BY starts_at`)
    .filter((r) => windowVisible(u, targetsOf(r.id)));
  if (f.target) {
    const [kind, id] = [f.target.slice(0, f.target.indexOf(':')), f.target.slice(f.target.indexOf(':') + 1)];
    // 0.14: a plant entry – windows that list it, or (an asset, device or collection) the site or asset it is in
    const site = isPlantMaintenanceTarget(kind) ? plantTarget(kind, id) : null;
    const listing = (r: WindowRow) =>
      targetsOf(r.id).some(
        (t) =>
          (t.kind === kind && t.id === id) ||
          (!!site && kind !== 'site' && t.kind === 'site' && t.id === site.siteId) ||
          (!!site?.assetId && (kind === 'device' || kind === 'collection') && t.kind === 'asset' && t.id === site.assetId),
      );
    rows = rows.filter((r) => {
      if (isPlantMaintenanceTarget(kind)) return listing(r);
      const reach = reachOf(targetsOf(r.id));
      if (kind === 'monitor') return reachesMonitor(reach, id);
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
  const r = visibleRow(id, u);
  const reach = reachOf(targetsOf(id));
  return {
    ...toSummary(r, u, now),
    upcoming: occurrencesOf(r, now, now + 400 * DAY)
      .slice(0, 20)
      .map((o) => ({ startsAt: iso(o.start), endsAt: iso(o.end) })),
    affected: {
      platforms: reach.platforms.size,
      monitors: new Set([...reach.monitors, ...monitorsOn(reach.platforms)]).size,
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

/** The reminder: as given, else 24 hours before maintenance and none before planned downtime (ADR 0021). */
const reminderOf = (input: MaintenanceInput): number => input.reminderHours ?? (input.kind === 'downtime' ? 0 : 24);

/** The input that would save a window as it is (0.14: the impact's actions change one part of it). */
export function inputOfWindow(id: string): MaintenanceInput {
  const r = row(id);
  return {
    kind: r.kind === 'downtime' ? 'downtime' : 'maintenance',
    title: r.title,
    note: r.note,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    recurrence: recurrenceOf(r),
    targets: targetsOf(id),
    responsible: parseJson<string[]>(r.responsible, []),
    changeRecordId: r.change_record_id,
    quietMonitors: !!r.quiet_monitors,
    pauseMessages: !!r.pause_messages,
    reminderHours: Number(r.reminder_hours),
    enabled: r.enabled !== 0,
  };
}

/** `from`: the window whose impact it was made from (0.14, "Planned downtime for the affected monitors"). */
export function createMaintenance(input: MaintenanceInput, meta: { from?: string } = {}): MaintenanceWindowDetail {
  const u = me();
  // service editors hear first about an item that does not exist (or that they may not see), as before team scopes
  if (canCreateServices(u)) checkTargets(input.targets, u);
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
         pause_messages, reminder_hours, enabled, created_at, created_by, updated_at, updated_by, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      reminderOf(input),
      input.enabled === false ? 0 : 1,
      now,
      u.username,
      now,
      u.username,
      input.kind,
    );
    writeTargets(id, input.targets);
    audit({
      action: 'maintenance.created',
      entityType: 'maintenance',
      entityId: id,
      summary: `${input.kind === 'downtime' ? 'Planned downtime' : 'Maintenance'} "${input.title}" planned (${describe(input)}; ${input.targets.length} item(s)${input.enabled === false ? ', disabled' : ''})${meta.from ? `, for the monitors affected by ${meta.from}` : ''}`,
      details: { ...input, ...(meta.from ? { from: meta.from } : {}) },
    });
  });
  invalidate();
  if (input.enabled !== false && (input.kind !== 'downtime' || reminderOf(input) > 0)) announce(row(id), 'planned', Date.parse(input.startsAt));
  return getMaintenance(id);
}

export function updateMaintenance(id: string, input: MaintenanceInput): MaintenanceWindowDetail {
  const u = me();
  const cur = row(id);
  const before = targetsOf(id);
  if (cur.cancelled_at) throw new HttpError(409, 'The maintenance window was cancelled', 'MAINTENANCE_CANCELLED');
  if (canCreateServices(u)) checkTargets(input.targets, u, before);
  if (!canPlan(u, before) || !canPlan(u, input.targets)) forbid('change this maintenance window', 'planMaintenance');
  validate(input);
  checkTargets(input.targets, u, before);
  assertKnownSubjects(input.responsible, parseJson<string[]>(cur.responsible, []));
  checkChangeRecord(input.changeRecordId, u, cur.change_record_id);
  const enabled = input.enabled ?? cur.enabled !== 0;
  db().tx(() => {
    db().run(
      `UPDATE maintenance_windows SET title = ?, note = ?, starts_at = ?, ends_at = ?, recurrence = ?, responsible = ?, change_record_id = ?,
         quiet_monitors = ?, pause_messages = ?, reminder_hours = ?, enabled = ?, updated_at = ?, updated_by = ?, kind = ? WHERE id = ?`,
      input.title,
      input.note,
      input.startsAt,
      input.endsAt,
      input.recurrence ? JSON.stringify(input.recurrence) : null,
      JSON.stringify([...new Set(input.responsible)]),
      input.changeRecordId,
      input.quietMonitors ? 1 : 0,
      input.pauseMessages ? 1 : 0,
      reminderOf(input),
      enabled ? 1 : 0,
      nowIso(),
      u.username,
      input.kind,
      id,
    );
    writeTargets(id, input.targets);
    audit({
      action: 'maintenance.changed',
      entityType: 'maintenance',
      entityId: id,
      summary: `Maintenance "${input.title}" changed (${describe(input)}${enabled !== (cur.enabled !== 0) ? (enabled ? ', enabled' : ', disabled') : ''})`,
      details: { before: { ...shape(cur), title: cur.title, enabled: cur.enabled !== 0, targets: before }, after: { ...input, enabled } },
    });
  });
  invalidate();
  // enabled now: announced as a newly planned window (once)
  if (enabled && cur.enabled === 0) announce(row(id), 'planned', Date.parse(input.startsAt));
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

// ---------- monitors' own windows (before 0.11) and the deprecated monitor API ----------

interface LegacyRow {
  id: string;
  monitor_id: string;
  starts_at: string;
  ends_at: string;
  reason: string;
  created_by: string;
  created_at: string;
}

/** Title and note of a window made from a monitor window's reason (the title has at most MAINTENANCE_LIMITS.title characters). */
function titleOfReason(reason: string, monitorName: string): { title: string; note: string } {
  const r = reason.trim();
  const first = r.split(/\r?\n/)[0]!.trim();
  const title = (first || `Maintenance of monitor "${monitorName}"`).slice(0, MAINTENANCE_LIMITS.title);
  return { title, note: r && r !== title ? r.slice(0, MAINTENANCE_LIMITS.note) : '' };
}

/**
 * A window that lists one monitor, as the monitor's own windows were: once, quiet monitors, no paused messages, no
 * reminder and no announcements (its notices are claimed when it is made, so it stays as quiet as before).
 */
function insertMonitorWindow(
  monitorId: string,
  w: { startsAt: string; endsAt: string; title: string; note: string; createdBy: string; createdAt: string; updatedBy: string },
): string {
  const id = newId('mtw_');
  const now = nowIso();
  db().run(
    `INSERT INTO maintenance_windows (id, title, note, starts_at, ends_at, recurrence, time_zone, responsible, change_record_id, quiet_monitors,
       pause_messages, reminder_hours, enabled, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, NULL, ?, '[]', NULL, 1, 0, 0, 1, ?, ?, ?, ?)`,
    id,
    w.title,
    w.note,
    w.startsAt,
    w.endsAt,
    instanceTimeZone(),
    w.createdAt,
    w.createdBy,
    now,
    w.updatedBy,
  );
  writeTargets(id, [{ kind: 'monitor', id: monitorId }]);
  for (const [kind, start] of [
    ['planned', ''],
    ['start', w.startsAt],
    ['end', w.startsAt],
  ] as const)
    db().run('INSERT INTO maintenance_notices (window_id, occurrence_start, kind, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', id, start, kind, now);
  return id;
}

/**
 * Copies the monitors' own maintenance windows (table monitor_maintenance, before 0.11) into maintenance windows that
 * list the monitor, once: each copied row says what it became (migrated_to, migrated_at), and each copy has an audit
 * entry. Rows of monitors that no longer exist are only marked. Runs once the vault is open (the audit log needs its
 * key) and after a migration package is imported. Returns the number of windows made.
 */
export function migrateMonitorWindows(): number {
  const rows = db().all<LegacyRow>('SELECT * FROM monitor_maintenance WHERE migrated_at IS NULL ORDER BY created_at, id');
  if (!rows.length) return 0;
  let made = 0;
  db().tx(() => {
    for (const r of rows) {
      const m = db().get<{ name: string }>('SELECT name FROM monitors WHERE id = ?', r.monitor_id);
      const at = nowIso();
      if (!m || !(Date.parse(r.ends_at) > Date.parse(r.starts_at))) {
        db().run('UPDATE monitor_maintenance SET migrated_at = ? WHERE id = ?', at, r.id);
        continue;
      }
      const { title, note } = titleOfReason(r.reason, m.name);
      const id = insertMonitorWindow(r.monitor_id, {
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        title,
        note,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedBy: 'system',
      });
      db().run('UPDATE monitor_maintenance SET migrated_to = ?, migrated_at = ? WHERE id = ?', id, at, r.id);
      audit({
        actor: 'system',
        action: 'maintenance.migrated',
        entityType: 'maintenance',
        entityId: id,
        summary: `Maintenance window ${r.id} of monitor "${m.name}" (${r.starts_at} – ${r.ends_at}) became the maintenance window "${title}" (0.11: one maintenance-window concept)`,
        details: { from: { table: 'monitor_maintenance', id: r.id, monitorId: r.monitor_id, reason: r.reason, createdBy: r.created_by }, windowId: id },
      });
      made++;
    }
  });
  if (made) invalidate();
  return made;
}

/** The old shape of a monitor's window (MaintenanceWindow of the monitor API) for a window that lists the monitor. */
function legacyShape(r: WindowRow, monitorId: string, now: number): MonitorMaintenanceWindow | null {
  const cancelled = r.cancelled_at ? Date.parse(r.cancelled_at) : null;
  // the current or next occurrence (a repeating window), else the last one
  const o = occurrencesOf(r, now, now + 400 * DAY)[0] ?? occurrencesOf(r, Date.parse(r.starts_at), now).at(-1);
  if (!o) return null;
  // cancelled before it started: removed, as the monitor API removed future windows
  if (cancelled !== null && cancelled <= o.start) return null;
  const end = cancelled !== null ? Math.min(o.end, cancelled) : o.end;
  return {
    id: r.id,
    monitorId,
    startsAt: iso(o.start),
    endsAt: iso(end),
    reason: r.note || r.title,
    createdBy: r.created_by,
    createdAt: r.created_at,
    active: r.enabled !== 0 && o.start <= now && now < end,
  };
}

/** Deprecated monitor API: the windows that list this monitor, newest first (at most 100). Rights: the caller checked them. */
export function monitorWindows(monitorId: string, now = Date.now()): MonitorMaintenanceWindow[] {
  return db()
    .all<WindowRow>(
      `SELECT w.* FROM maintenance_windows w JOIN maintenance_targets t ON t.window_id = w.id
       WHERE t.kind = 'monitor' AND t.target_id = ? ORDER BY w.starts_at DESC LIMIT 100`,
      monitorId,
    )
    .flatMap((r) => legacyShape(r, monitorId, now) ?? []);
}

/** Deprecated monitor API: plan a window for one monitor (the caller checked the acknowledge right). */
export function planMonitorWindow(monitor: { id: string; name: string }, input: { start: number; end: number; reason: string }): MonitorMaintenanceWindow {
  const u = me();
  const { title, note } = titleOfReason(input.reason, monitor.name);
  let id = '';
  db().tx(() => {
    id = insertMonitorWindow(monitor.id, {
      startsAt: iso(input.start),
      endsAt: iso(input.end),
      title,
      note,
      createdBy: u.username,
      createdAt: nowIso(),
      updatedBy: u.username,
    });
    audit({
      action: 'maintenance.created',
      entityType: 'maintenance',
      entityId: id,
      summary: `Maintenance "${title}" planned (${iso(input.start)} – ${iso(input.end)}; monitor "${monitor.name}", through the deprecated monitor API)`,
      details: { targets: [{ kind: 'monitor', id: monitor.id }], startsAt: iso(input.start), endsAt: iso(input.end), reason: input.reason, via: 'monitorApi' },
    });
  });
  invalidate();
  return legacyShape(row(id), monitor.id, Date.now())!;
}

/**
 * Deprecated monitor API: end a window that lists only this monitor – one going on ends now, a future one is
 * cancelled (the monitor API removed it). False when the window does not list the monitor; 409 when it lists more.
 */
export function endMonitorWindow(monitorId: string, id: string): boolean {
  const u = me();
  // the id of a monitor window from before 0.11 names the window it became
  const windowId =
    db().get<{ migrated_to: string | null }>('SELECT migrated_to FROM monitor_maintenance WHERE id = ? AND monitor_id = ?', id, monitorId)?.migrated_to ?? id;
  const listed = db().get('SELECT 1 FROM maintenance_targets WHERE window_id = ? AND kind = ? AND target_id = ?', windowId, 'monitor', monitorId);
  if (!listed) return false;
  const r = row(windowId);
  if (targetsOf(windowId).length > 1)
    throw new HttpError(409, 'The maintenance window lists other items too – change it under Maintenance', 'MAINTENANCE_SHARED', { id: windowId });
  if (r.cancelled_at) return true;
  const now = nowIso();
  db().tx(() => {
    db().run(
      'UPDATE maintenance_windows SET cancelled_at = ?, cancelled_by = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      now,
      u.username,
      now,
      u.username,
      windowId,
    );
    audit({
      action: 'maintenance.cancelled',
      entityType: 'maintenance',
      entityId: windowId,
      summary: `Maintenance "${r.title}" ended (through the deprecated monitor API)`,
      details: { reason: '', via: 'monitorApi', monitorId },
    });
  });
  invalidate();
  return true;
}

/** A deleted monitor leaves the windows: windows that listed only it go with it (their history went with the monitor's). */
export function forgetMonitorInWindows(monitorId: string): void {
  const ids = db()
    .all<{ window_id: string }>("SELECT window_id FROM maintenance_targets WHERE kind = 'monitor' AND target_id = ?", monitorId)
    .map((r) => r.window_id);
  if (!ids.length) return;
  db().run("DELETE FROM maintenance_targets WHERE kind = 'monitor' AND target_id = ?", monitorId);
  for (const id of ids)
    if (!db().get('SELECT 1 FROM maintenance_targets WHERE window_id = ?', id)) {
      db().run('DELETE FROM maintenance_notices WHERE window_id = ?', id);
      db().run('DELETE FROM maintenance_windows WHERE id = ?', id);
    }
  invalidate();
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
  for (const r of db().all<WindowRow>('SELECT * FROM maintenance_windows WHERE enabled = 1 AND (cancelled_at IS NULL OR cancelled_at > ?)', iso(now))) {
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

/** The catalogue maintenance a monitor is in now (quiet monitors only), for the engine: one that lists it, or reaches a platform it checks. */
export function maintenanceForMonitor(
  monitorId: string,
  now = Date.now(),
): { id: string; starts_at: string; ends_at: string; reason: string; created_by: string; created_at: string } | undefined {
  // planned downtime (ADR 0021) never silences a monitor
  const list = activeNow(now).filter((a) => a.row.quiet_monitors && a.row.kind !== 'downtime');
  if (!list.length) return undefined;
  // a window that lists the monitor comes first, then the one that ends last
  const a = [
    ...list.filter((x) => x.reach.monitors.has(monitorId)).sort((x, y) => y.end - x.end),
    ...list.filter((x) => reachesMonitor(x.reach, monitorId)),
  ][0];
  return a
    ? { id: a.row.id, starts_at: iso(a.start), ends_at: iso(a.end), reason: a.row.title, created_by: a.row.created_by, created_at: a.row.created_at }
    : undefined;
}

/** Do check and run messages of this run go to the app only (a window with "pause messages" on one of its platforms)? */
export function maintenancePausesRun(runId: string, now = Date.now()): boolean {
  const list = activeNow(now).filter((a) => a.row.pause_messages);
  if (!list.length) return false;
  // debug runs: one run by its id
  const bindings = parseJson<Record<string, string>>(db().get<{ bindings: string }>('SELECT bindings FROM runs WHERE id = ?', runId)?.bindings ?? '{}', {});
  const platforms = Object.values(bindings).filter((x): x is string => typeof x === 'string');
  return list.some((a) => platforms.some((p) => a.reach.platforms.has(p)));
}

/** What an objective is about: its service, optionally one of its applications, and its source monitor (if any). */
type ObjectiveScope = { service_id: string; application_id: string | null; monitor_id?: string | null };
const reachesObjective = (reach: Reach, o: ObjectiveScope): boolean =>
  reach.services.has(o.service_id) ||
  (!!o.application_id && reach.applications.has(o.application_id)) ||
  (!!o.monitor_id && reachesMonitor(reach, o.monitor_id));

/** Is an availability objective (of a service, optionally one of its applications, or its source monitor) under maintenance now? */
export function objectiveInMaintenance(o: ObjectiveScope, now = Date.now()): boolean {
  // planned downtime leaves objectives as the status says (ADR 0021)
  return activeNow(now).some((a) => a.row.kind !== 'downtime' && reachesObjective(a.reach, o));
}

// every window with what it reaches (cached briefly: objective views ask for each objective)
let allCache: { at: number; list: { row: WindowRow; reach: Reach }[] } | null = null;
function allWithReach(now: number) {
  if (allCache && Math.abs(now - allCache.at) < CACHE_MS) return allCache.list;
  const list = db()
    .all<WindowRow>('SELECT * FROM maintenance_windows WHERE enabled = 1')
    .map((row) => ({ row, reach: reachOf(targetsOf(row.id)) }));
  allCache = { at: now, list };
  return list;
}

/**
 * Planned maintenance minutes of an objective's service or application within each uptime window ending now
 * (overlapping occurrences of one window counted once; a cancelled window counts up to when it was cancelled).
 */
export function plannedMinutes<K extends string>(o: ObjectiveScope, windowsMs: Record<K, number>, now = Date.now()): Record<K, number> {
  const keys = Object.keys(windowsMs) as K[];
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const longest = Math.max(0, ...keys.map((k) => windowsMs[k]));
  const spans: { start: number; end: number }[] = [];
  for (const { row: r, reach } of allWithReach(now)) {
    if (r.kind === 'downtime' || !reachesObjective(reach, o)) continue;
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

/**
 * Planned downtime of a monitor (ADR 0021): windows of kind downtime that list it or reach a platform it checks – active
 * now, and their time within [from, to] (overlaps counted once; a cancelled window up to when it was cancelled).
 */
export function plannedDowntimeForMonitor(monitorId: string, from: number, to: number): { active: boolean; ms: number } {
  const spans: { start: number; end: number }[] = [];
  let active = false;
  for (const { row: r, reach } of allWithReach(to)) {
    if (r.kind !== 'downtime' || !reachesMonitor(reach, monitorId)) continue;
    const stop = r.cancelled_at ? Math.min(to, Date.parse(r.cancelled_at)) : to;
    for (const occ of occurrencesOf(r, from, stop)) {
      const a = Math.max(occ.start, from);
      const b = Math.min(occ.end, stop);
      if (b > a) spans.push({ start: a, end: b });
      if (occ.start <= to - 1 && to - 1 < occ.end && stop >= to) active = true;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let ms = 0;
  let cur: { start: number; end: number } | null = null;
  for (const x of spans) {
    if (cur && x.start <= cur.end) cur.end = Math.max(cur.end, x.end);
    else {
      if (cur) ms += cur.end - cur.start;
      cur = { ...x };
    }
  }
  if (cur) ms += cur.end - cur.start;
  return { active, ms };
}

// the monitor engine and the notifications ask here (registered, so neither imports this module)
setCatalogueMaintenance((mid, now) => maintenanceForMonitor(mid, now));
setPlannedDowntime((mid, from, to) => plannedDowntimeForMonitor(mid, from, to));
setMaintenancePause((runId) => maintenancePausesRun(runId));

// ---------- announcements ----------

type NoticeKind = 'planned' | 'reminder' | 'start' | 'end';

/**
 * 0.14: the affected owners told from the impact view – the announcement "Maintenance planned" to the people the impact
 * names (not only those the window lists), once per version of the window (a changed window may be announced again).
 * Returns the number of recipients; null when it was sent for this version before.
 */
export async function announceImpact(id: string, contacts: { subject: string; of: string[] }[]): Promise<number | null> {
  const u = me();
  const r = row(id);
  if (!canPlan(u, targetsOf(id))) forbid('tell the owners about this maintenance window', 'planMaintenance');
  if (r.cancelled_at) throw new HttpError(409, 'The maintenance window was cancelled', 'MAINTENANCE_CANCELLED');
  const claimed =
    db().run(
      'INSERT INTO maintenance_notices (window_id, occurrence_start, kind, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      id,
      r.updated_at,
      'impact',
      nowIso(),
    ).changes === 1;
  if (!claimed) return null;
  const { usersOfSubjects } = await import('../tickets/reminders.js');
  const { notify } = await import('../notifications/service.js');
  const { t, formatDateTime } = await import('../i18n/index.js');
  // each person hears what of theirs it affects (through their teams too)
  const ofUser = new Map<string, Set<string>>();
  for (const c of contacts)
    for (const x of usersOfSubjects([c.subject])) for (const o of c.of) (ofUser.get(x.id) ?? ofUser.set(x.id, new Set()).get(x.id)!).add(o);
  const recipients = usersOfSubjects(contacts.map((c) => c.subject));
  const start = Date.parse(currentOf(r, Date.now())?.startsAt ?? r.starts_at);
  const dur = Date.parse(r.ends_at) - Date.parse(r.starts_at);
  const items = targetsOf(id)
    .map((x) => nameOf(x, null))
    .filter((x): x is string => !!x);
  db().tx(() =>
    audit({
      action: 'maintenance.impact_notified',
      entityType: 'maintenance',
      entityId: id,
      summary: `The owners affected by maintenance "${r.title}" were told (${recipients.length} people)`,
      details: { subjects: contacts.map((c) => c.subject), recipients: recipients.map((x) => x.username) },
    }),
  );
  notify({
    event: 'maintenance.announced',
    personal: true,
    text: (l, x) => {
      const of = [...(x ? (ofUser.get(x.id) ?? []) : [])].slice(0, 10).join(', ') || '–';
      const params = { title: r.title, start: formatDateTime(l, iso(start)), end: formatDateTime(l, iso(start + dur)), items: items.join(', ') || '–', of };
      return { title: t(l, 'maintenance.impact.title', params), body: t(l, 'maintenance.impact.body', params) + (r.note ? `\n\n${r.note.slice(0, 500)}` : '') };
    },
    link: `/maintenance?open=${r.id}`,
    recipients,
    inAppKey: `maintenance:${r.id}:impact:${r.updated_at}`,
    externalKey: `maintenance:${r.id}:impact:${r.updated_at}`,
    data: { windowId: r.id, phase: 'impact', startsAt: iso(start), endsAt: iso(start + dur) },
  });
  return recipients.length;
}

/** The people to tell: the responsible people and the owners of what it lists and reaches (applications, systems). */
async function recipientsOf(r: WindowRow) {
  const { usersOfSubjects } = await import('../tickets/reminders.js');
  const targets = targetsOf(r.id);
  const reach = reachOf(targets);
  const subjects = new Set<string>(parseJson<string[]>(r.responsible, []));
  for (const t of targets) {
    if (t.kind === 'platform') continue;
    // 0.14: a plant entry – the owning teams of its site
    if (isPlantMaintenanceTarget(t.kind)) {
      const site = plantTarget(t.kind, t.id)?.siteId;
      if (site) for (const team of owningTeams('site', site)) subjects.add(`team:${team.name.toLowerCase()}`);
      continue;
    }
    if (t.kind === 'monitor') {
      const owner = monitorRef(t.id)?.owner;
      if (owner) subjects.add(`user:${owner.toLowerCase()}`);
    } else for (const s of ownersOf(t.kind, t.id) ?? []) subjects.add(s);
  }
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
  for (const r of db().all<WindowRow>('SELECT * FROM maintenance_windows WHERE cancelled_at IS NULL AND enabled = 1')) {
    // planned downtime announces nothing unless it was given a reminder (ADR 0021: weekends are routine)
    if (r.kind === 'downtime' && !Number(r.reminder_hours)) continue;
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
  const r = visibleRow(id, u);
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
