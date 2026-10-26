import { z } from 'zod';
import {
  OBJECTIVE_LIMITS,
  OBJECTIVE_WINDOWS,
  type AclEntry,
  type ObjectiveBreach,
  type ObjectiveDetail,
  type ObjectiveNoDataReason,
  type ObjectiveSample,
  type ObjectiveStatus,
  type ObjectiveSummary,
  type ObjectiveTargets,
  type ObjectiveValues,
  type ObjectiveWindow,
  type ObjectiveWindowState,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { canEditService, forbid, me } from '../records/access.js';

/**
 * Availability objectives (#86): targets for the uptime windows Gatus reports (1 h, 24 h, 7 d, 30 d; each optional)
 * of one Gatus endpoint, attached to a service or one of its applications.
 *
 * The values are Gatus' own uptime figures: the metrics mode of a Gatus platform reads them once an hour when "read
 * Gatus' uptime figures" is on (gatus_endpoints.gatus_uptime). Nothing here calls Gatus; the objective job samples
 * what Steward has read (jobs.ts).
 *
 * Status per window: met (value ≥ target), below (value < target), no data (no value). An objective is below when any
 * window is below, else no data when any window has no value, else met.
 *
 * Permissions follow the service: everyone who can sign in reads objectives (like services and duties); whoever may
 * edit the service defines them. The endpoint must be on a Gatus platform the author may see (use or manage) – an
 * unknown or hidden platform is "not found", so ids cannot be probed. Readers who may not see the platform get the
 * objective's name, status and values, but neither the platform nor the endpoint (as duties leave out the names of
 * processes the reader may not view).
 */

const HOUR = 3600000;

export interface ObjectiveRow {
  id: string;
  service_id: string;
  application_id: string | null;
  name: string;
  description: string;
  platform_id: string;
  endpoint_key: string;
  target_h1: number | null;
  target_h24: number | null;
  target_d7: number | null;
  target_d30: number | null;
  notify: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface BreachRow {
  id: string;
  objective_id: string;
  started_at: string;
  ended_at: string | null;
  windows: string;
  notified_at: string | null;
}

interface SampleRow {
  objective_id: string;
  bucket: string;
  value_h1: number | null;
  value_h24: number | null;
  value_d7: number | null;
  value_d30: number | null;
  status: ObjectiveStatus;
  sampled_at: string;
}

interface ServiceRef {
  id: string;
  name: string;
  owners: string;
  archived: number;
}

const id = z.string().trim().min(1).max(200);
/** Percent with at most two decimals (Gatus' figures have two). */
const percent = z
  .number()
  .min(0)
  .max(100)
  .refine((x) => Math.abs(Math.round(x * 100) - x * 100) < 1e-6, 'At most two decimals')
  .nullable()
  .default(null);
const targets = z.object({ h1: percent, h24: percent, d7: percent, d30: percent }).strict();

const fields = {
  applicationId: id.nullable().default(null),
  name: z.string().trim().min(1).max(OBJECTIVE_LIMITS.name),
  description: z.string().max(OBJECTIVE_LIMITS.description).default(''),
  platformId: id,
  endpointKey: z.string().trim().min(1).max(500),
  targets,
  notify: z.boolean().default(false),
};
const oneTarget = (x: { targets: ObjectiveTargets }) => OBJECTIVE_WINDOWS.some((w) => x.targets[w] !== null);
const oneTargetMsg = { message: 'Set a target for at least one window', path: ['targets'] };
export const objectiveInput = z
  .object({ serviceId: id, ...fields })
  .strict()
  .refine(oneTarget, oneTargetMsg);
/** A change; without platform and endpoint they stay (editors who may not see the platform change the targets only). */
export const objectiveUpdate = z
  .object({ ...fields, platformId: fields.platformId.optional(), endpointKey: fields.endpointKey.optional() })
  .strict()
  .refine(oneTarget, oneTargetMsg);
export type ObjectiveInput = z.infer<typeof objectiveInput>;
export type ObjectiveUpdate = z.infer<typeof objectiveUpdate>;
type Resolved = Omit<ObjectiveUpdate, 'platformId' | 'endpointKey'> & { platformId: string; endpointKey: string };

// ---------- values ----------

/** Percent → hundredths (stored); hundredths → percent. */
const toHundredths = (x: number | null) => (x === null ? null : Math.round(x * 100));
const toPercent = (x: number | null | undefined) => (x === null || x === undefined ? null : Number(x) / 100);

export const rowTargets = (r: ObjectiveRow): ObjectiveTargets => ({
  h1: toPercent(r.target_h1),
  h24: toPercent(r.target_h24),
  d7: toPercent(r.target_d7),
  d30: toPercent(r.target_d30),
});
const targetColumn = (w: ObjectiveWindow) => `target_${w}` as const;

export interface ObjectiveReading {
  /** Hundredths of a percent */
  values: Record<ObjectiveWindow, number | null>;
  reason: ObjectiveNoDataReason | null;
  at: string | null;
}

interface SourceState {
  enabled: number;
  fetch_uptimes: number;
  last_uptimes_at: string | null;
}

/** Reads the Gatus figures Steward has stored; one query per platform and one per endpoint, cached for a listing. */
export function readingCache(now = Date.now()) {
  const sources = new Map<string, SourceState | null>();
  const endpoints = new Map<string, { gatus_uptime: string | null; name: string; group_name: string } | null>();
  const none = { h1: null, h24: null, d7: null, d30: null };
  const endpoint = (platformId: string, key: string) => {
    const k = `${platformId}\n${key}`;
    if (!endpoints.has(k))
      endpoints.set(
        k,
        db().get<{ gatus_uptime: string | null; name: string; group_name: string }>(
          'SELECT gatus_uptime, name, group_name FROM gatus_endpoints WHERE platform_id = ? AND key = ?',
          platformId,
          key,
        ) ?? null,
      );
    return endpoints.get(k)!;
  };
  return {
    endpoint,
    read(platformId: string, key: string): ObjectiveReading {
      if (!sources.has(platformId))
        sources.set(
          platformId,
          db().get<SourceState>('SELECT enabled, fetch_uptimes, last_uptimes_at FROM gatus_sources WHERE platform_id = ?', platformId) ?? null,
        );
      const src = sources.get(platformId);
      if (!src || !src.enabled) return { values: none, reason: 'noSource', at: null };
      if (!src.fetch_uptimes) return { values: none, reason: 'uptimesOff', at: src.last_uptimes_at };
      if (!src.last_uptimes_at || now - Date.parse(src.last_uptimes_at) > OBJECTIVE_LIMITS.staleHours * HOUR)
        return { values: none, reason: 'stale', at: src.last_uptimes_at };
      const e = endpoint(platformId, key);
      if (!e) return { values: none, reason: 'noEndpoint', at: src.last_uptimes_at };
      const up = parseJson<Partial<Record<ObjectiveWindow, unknown>> | null>(e.gatus_uptime, null);
      const values = Object.fromEntries(
        OBJECTIVE_WINDOWS.map((w) => {
          const v = up?.[w];
          return [w, typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v * 100) : null];
        }),
      ) as Record<ObjectiveWindow, number | null>;
      return { values, reason: OBJECTIVE_WINDOWS.some((w) => values[w] !== null) ? null : 'noValue', at: src.last_uptimes_at };
    },
  };
}
export type ReadingCache = ReturnType<typeof readingCache>;

/** The status of each targeted window and of the objective, from values in hundredths. */
export function judge(r: ObjectiveRow, values: Record<ObjectiveWindow, number | null>): { windows: ObjectiveWindowState[]; status: ObjectiveStatus } {
  const windows: ObjectiveWindowState[] = [];
  for (const w of OBJECTIVE_WINDOWS) {
    const t = r[targetColumn(w)];
    if (t === null || t === undefined) continue;
    const v = values[w];
    windows.push({ window: w, target: Number(t) / 100, value: toPercent(v), status: v === null ? 'noData' : v >= Number(t) ? 'met' : 'below' });
  }
  const status: ObjectiveStatus = windows.some((x) => x.status === 'below') ? 'below' : windows.some((x) => x.status === 'noData') ? 'noData' : 'met';
  return { windows, status };
}

// ---------- rows and permissions ----------

export function objectiveRow(objectiveId: string): ObjectiveRow {
  const r = db().get<ObjectiveRow>('SELECT * FROM availability_objectives WHERE id = ?', objectiveId);
  if (!r) throw new HttpError(404, `Objective ${objectiveId} not found`, 'OBJECTIVE_NOT_FOUND', { id: objectiveId });
  return r;
}

function serviceRef(serviceId: string): ServiceRef {
  const s = db().get<ServiceRef>('SELECT id, name, owners, archived FROM services WHERE id = ?', serviceId);
  if (!s) throw new HttpError(404, `Service ${serviceId} not found`, 'SERVICE_NOT_FOUND', { id: serviceId });
  return s;
}

const canEdit = (u: AuthUser | null, s: ServiceRef) => canEditService(u, parseJson<string[]>(s.owners, []));

interface PlatformRef {
  id: string;
  name: string;
  kind: string;
  acl: string;
}

/** Platforms by id, and whether a user may see one (any right on it). */
export function platformLookup() {
  const rows = new Map(
    db()
      .all<PlatformRef>('SELECT id, name, kind, acl FROM platforms')
      .map((p) => [p.id, p]),
  );
  const seen = new Map<string, boolean>();
  return {
    get: (pid: string) => rows.get(pid),
    visible(u: AuthUser | null, pid: string): boolean {
      const p = rows.get(pid);
      if (!p || !u) return false;
      const k = `${u.username}\n${pid}`;
      if (!seen.has(k)) seen.set(k, platformPermissions(u, { acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).length > 0);
      return seen.get(k)!;
    },
  };
}

// ---------- views ----------

const toBreach = (b: BreachRow): ObjectiveBreach => ({
  id: b.id,
  startedAt: b.started_at,
  endedAt: b.ended_at,
  windows: parseJson<ObjectiveWindow[]>(b.windows, []),
  notified: !!b.notified_at,
});

export interface ObjectiveView {
  row: ObjectiveRow;
  summary: ObjectiveSummary;
}

interface ViewCtx {
  u: AuthUser | null;
  cache: ReadingCache;
  platforms: ReturnType<typeof platformLookup>;
  services: Map<string, ServiceRef>;
  apps: Map<string, string>;
  breaches: Map<string, BreachRow>;
}

function viewCtx(now: number): ViewCtx {
  return {
    u: currentUser(),
    cache: readingCache(now),
    platforms: platformLookup(),
    services: new Map(
      db()
        .all<ServiceRef>('SELECT id, name, owners, archived FROM services')
        .map((s) => [s.id, s]),
    ),
    apps: new Map(
      db()
        .all<{ id: string; name: string }>('SELECT id, name FROM applications')
        .map((a) => [a.id, a.name]),
    ),
    breaches: new Map(
      db()
        .all<BreachRow>('SELECT * FROM objective_breaches WHERE ended_at IS NULL')
        .map((b) => [b.objective_id, b]),
    ),
  };
}

function build(r: ObjectiveRow, c: ViewCtx): ObjectiveView {
  const s = c.services.get(r.service_id)!;
  const reading = c.cache.read(r.platform_id, r.endpoint_key);
  const { windows, status } = judge(r, reading.values);
  const visible = c.platforms.visible(c.u, r.platform_id);
  const e = visible ? c.cache.endpoint(r.platform_id, r.endpoint_key) : null;
  const open = c.breaches.get(r.id);
  return {
    row: r,
    summary: {
      id: r.id,
      serviceId: r.service_id,
      serviceName: s.name,
      applicationId: r.application_id,
      applicationName: r.application_id ? (c.apps.get(r.application_id) ?? null) : null,
      name: r.name,
      description: r.description,
      platformVisible: visible,
      platformId: visible ? r.platform_id : null,
      platformName: visible ? (c.platforms.get(r.platform_id)?.name ?? null) : null,
      endpointKey: visible ? r.endpoint_key : null,
      endpointName: visible ? (e ? (e.group_name ? `${e.group_name}/${e.name}` : e.name) : null) : null,
      targets: rowTargets(r),
      windows,
      status,
      noDataReason: status === 'noData' ? (reading.reason ?? 'noValue') : null,
      valuesAt: reading.at,
      notify: !!r.notify,
      breach: open ? toBreach(open) : null,
      createdAt: r.created_at,
      createdBy: r.created_by,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
      canEdit: canEdit(c.u, s),
    },
  };
}

export interface ObjectiveFilter {
  serviceId?: string;
  applicationId?: string;
  /** Objectives of archived services too */
  archived?: boolean;
}

/** Objectives with their current status, ordered by service and name (the reader's view). */
export function listObjectiveViews(f: ObjectiveFilter = {}, now = Date.now()): ObjectiveView[] {
  me();
  const c = viewCtx(now);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.serviceId) (where.push('service_id = ?'), args.push(f.serviceId));
  if (f.applicationId) (where.push('application_id = ?'), args.push(f.applicationId));
  return db()
    .all<ObjectiveRow>(`SELECT * FROM availability_objectives${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name, id`, ...args)
    .filter((r) => {
      const s = c.services.get(r.service_id);
      return !!s && (f.archived || !s.archived);
    })
    .map((r) => build(r, c))
    .sort((a, b) => a.summary.serviceName.localeCompare(b.summary.serviceName) || a.summary.name.localeCompare(b.summary.name));
}

export const listObjectives = (f: ObjectiveFilter = {}, now = Date.now()): ObjectiveSummary[] => listObjectiveViews(f, now).map((v) => v.summary);

const sampleOf = (r: SampleRow): ObjectiveSample => ({
  at: r.bucket,
  values: { h1: toPercent(r.value_h1), h24: toPercent(r.value_h24), d7: toPercent(r.value_d7), d30: toPercent(r.value_d30) } as ObjectiveValues,
  status: r.status,
});

/** Stored hourly samples of an objective, newest first. */
export function objectiveSamples(objectiveId: string, o: { from?: string; to?: string; limit?: number } = {}): ObjectiveSample[] {
  const where = ['objective_id = ?'];
  const args: unknown[] = [objectiveId];
  if (o.from) (where.push('bucket >= ?'), args.push(o.from));
  if (o.to) (where.push('bucket < ?'), args.push(o.to));
  return db()
    .all<SampleRow>(
      `SELECT * FROM objective_samples WHERE ${where.join(' AND ')} ORDER BY bucket DESC LIMIT ${Math.max(1, Math.min(o.limit ?? 24 * OBJECTIVE_LIMITS.sampleRetentionDays, 24 * OBJECTIVE_LIMITS.sampleRetentionDays))}`,
      ...args,
    )
    .map(sampleOf);
}

export function objectiveBreaches(objectiveId: string): ObjectiveBreach[] {
  return db().all<BreachRow>('SELECT * FROM objective_breaches WHERE objective_id = ? ORDER BY started_at DESC LIMIT 500', objectiveId).map(toBreach);
}

export function getObjective(objectiveId: string, now = Date.now()): ObjectiveDetail {
  me();
  const r = objectiveRow(objectiveId);
  const v = build(r, viewCtx(now));
  return { ...v.summary, samples: objectiveSamples(r.id, { limit: 24 * 30 }), breaches: objectiveBreaches(r.id) };
}

// ---------- changes ----------

function checkReferences(u: AuthUser, s: ServiceRef, input: Resolved, cur?: ObjectiveRow): void {
  if (input.applicationId && !db().get('SELECT 1 FROM service_applications WHERE service_id = ? AND application_id = ?', s.id, input.applicationId))
    throw new HttpError(400, 'The application is not part of the service', 'OBJECTIVE_APPLICATION_NOT_IN_SERVICE', { id: input.applicationId });
  // an editor who may not see the platform may still change the targets, as long as the endpoint stays
  if (cur && cur.platform_id === input.platformId && cur.endpoint_key === input.endpointKey) return;
  const p = platformLookup();
  const pf = p.get(input.platformId);
  // a platform the user may not see is "unknown" to them (no probing)
  if (!pf || !p.visible(u, input.platformId))
    throw new HttpError(400, `Platform ${input.platformId} not found`, 'OBJECTIVE_PLATFORM_UNKNOWN', { id: input.platformId });
  if (pf.kind !== 'gatus') throw new HttpError(400, 'Objectives need a Gatus platform', 'OBJECTIVE_PLATFORM_NOT_GATUS', { id: input.platformId });
  if (!db().get('SELECT 1 FROM gatus_endpoints WHERE platform_id = ? AND key = ?', input.platformId, input.endpointKey))
    throw new HttpError(400, `Gatus does not report the endpoint "${input.endpointKey}"`, 'OBJECTIVE_ENDPOINT_UNKNOWN', {
      key: input.endpointKey.slice(0, 200),
    });
}

const describeTargets = (t: ObjectiveTargets) =>
  OBJECTIVE_WINDOWS.filter((w) => t[w] !== null)
    .map((w) => `${w.slice(1)}${w[0]} ≥ ${t[w]} %`)
    .join(', ');

export function createObjective(input: ObjectiveInput): ObjectiveDetail {
  const u = me();
  const s = serviceRef(input.serviceId);
  if (!canEdit(u, s)) forbid('define objectives of this service', 'changeService');
  if (s.archived) throw new HttpError(409, 'The service is archived', 'OBJECTIVE_SERVICE_ARCHIVED', { id: s.id });
  checkReferences(u, s, input);
  const n = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM availability_objectives WHERE service_id = ?', s.id)?.n ?? 0;
  if (Number(n) >= OBJECTIVE_LIMITS.perService)
    throw new HttpError(409, `A service has at most ${OBJECTIVE_LIMITS.perService} objectives`, 'OBJECTIVE_LIMIT', { max: OBJECTIVE_LIMITS.perService });
  const objectiveId = newId('obj_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO availability_objectives (id, service_id, application_id, name, description, platform_id, endpoint_key, target_h1, target_h24, target_d7, target_d30,
         notify, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      objectiveId,
      s.id,
      input.applicationId,
      input.name,
      input.description,
      input.platformId,
      input.endpointKey,
      toHundredths(input.targets.h1),
      toHundredths(input.targets.h24),
      toHundredths(input.targets.d7),
      toHundredths(input.targets.d30),
      input.notify ? 1 : 0,
      now,
      u.username,
      now,
      u.username,
    );
    audit({
      action: 'objective.created',
      entityType: 'objective',
      entityId: objectiveId,
      summary: `Availability objective "${input.name}" of service "${s.name}" defined (${describeTargets(input.targets)})`,
      details: {
        serviceId: s.id,
        applicationId: input.applicationId,
        platformId: input.platformId,
        endpointKey: input.endpointKey,
        targets: input.targets,
        notify: input.notify,
      },
    });
  });
  return getObjective(objectiveId);
}

export function updateObjective(objectiveId: string, change: ObjectiveUpdate): ObjectiveDetail {
  const u = me();
  const cur = objectiveRow(objectiveId);
  const input: Resolved = { ...change, platformId: change.platformId ?? cur.platform_id, endpointKey: change.endpointKey ?? cur.endpoint_key };
  const s = serviceRef(cur.service_id);
  if (!canEdit(u, s)) forbid('change objectives of this service', 'changeService');
  checkReferences(u, s, input, cur);
  const next = {
    application_id: input.applicationId,
    name: input.name,
    description: input.description,
    platform_id: input.platformId,
    endpoint_key: input.endpointKey,
    target_h1: toHundredths(input.targets.h1),
    target_h24: toHundredths(input.targets.h24),
    target_d7: toHundredths(input.targets.d7),
    target_d30: toHundredths(input.targets.d30),
    notify: input.notify ? 1 : 0,
  };
  const changes = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (next[k] ?? null) !== (cur[k] === null ? null : cur[k]));
  if (!changes.length) return getObjective(objectiveId);
  db().tx(() => {
    db().run(
      `UPDATE availability_objectives SET application_id = ?, name = ?, description = ?, platform_id = ?, endpoint_key = ?, target_h1 = ?, target_h24 = ?,
         target_d7 = ?, target_d30 = ?, notify = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      next.application_id,
      next.name,
      next.description,
      next.platform_id,
      next.endpoint_key,
      next.target_h1,
      next.target_h24,
      next.target_d7,
      next.target_d30,
      next.notify,
      nowIso(),
      u.username,
      objectiveId,
    );
    audit({
      action: 'objective.updated',
      entityType: 'objective',
      entityId: objectiveId,
      summary: `Availability objective "${input.name}" of service "${s.name}" changed (${changes.join(', ')})`,
      details: { changes, before: Object.fromEntries(changes.map((k) => [k, cur[k]])), after: Object.fromEntries(changes.map((k) => [k, next[k]])) },
    });
  });
  return getObjective(objectiveId);
}

/** Deletes an objective with its samples and breaches (the daily scorecard snapshots keep what it was). */
export function deleteObjective(objectiveId: string): void {
  const u = me();
  const cur = objectiveRow(objectiveId);
  const s = serviceRef(cur.service_id);
  if (!canEdit(u, s)) forbid('delete objectives of this service', 'changeService');
  db().tx(() => {
    const samples = db().run('DELETE FROM objective_samples WHERE objective_id = ?', objectiveId).changes;
    db().run('DELETE FROM objective_breaches WHERE objective_id = ?', objectiveId);
    db().run('DELETE FROM availability_objectives WHERE id = ?', objectiveId);
    audit({
      action: 'objective.deleted',
      entityType: 'objective',
      entityId: objectiveId,
      summary: `Availability objective "${cur.name}" of service "${s.name}" deleted`,
      details: { serviceId: s.id, platformId: cur.platform_id, endpointKey: cur.endpoint_key, targets: rowTargets(cur), samplesDeleted: samples },
    });
  });
}
