import { z } from 'zod';
import {
  OBJECTIVE_LIMITS,
  OBJECTIVE_WINDOW_MS,
  OBJECTIVE_WINDOWS,
  type AclEntry,
  type ObjectiveBreach,
  type ObjectiveBreachEndReason,
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
import { plannedMinutes } from '../catalogue/maintenance.js';

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
  archived_at: string | null;
  archived_by: string | null;
}

interface BreachRow {
  id: string;
  objective_id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: ObjectiveBreachEndReason | null;
  windows: string;
  notified_at: string | null;
}

export interface SampleRow {
  objective_id: string;
  bucket: string;
  value_h1: number | null;
  value_h24: number | null;
  value_d7: number | null;
  value_d30: number | null;
  status: ObjectiveStatus;
  sampled_at: string;
}

export interface ServiceRef {
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
  const kinds = new Map<string, string | null>();
  const kindOf = (platformId: string) => {
    if (!kinds.has(platformId)) kinds.set(platformId, db().get<{ kind: string }>('SELECT kind FROM platforms WHERE id = ?', platformId)?.kind ?? null);
    return kinds.get(platformId);
  };
  return {
    endpoint,
    read(platformId: string, key: string): ObjectiveReading {
      // a PromQL query (#110): the figures the background job read (readPromObjectives)
      if (kindOf(platformId) === 'prometheus') {
        const p = db().get<{ figures: string | null; error: string | null; read_at: string }>(
          'SELECT figures, error, read_at FROM prom_objective_readings WHERE platform_id = ? AND query = ?',
          platformId,
          key,
        );
        if (!p) return { values: none, reason: 'noSource', at: null };
        if (now - Date.parse(p.read_at) > OBJECTIVE_LIMITS.staleHours * HOUR) return { values: none, reason: 'stale', at: p.read_at };
        const f = parseJson<Partial<Record<ObjectiveWindow, unknown>> | null>(p.figures, null);
        const values = Object.fromEntries(OBJECTIVE_WINDOWS.map((w) => [w, typeof f?.[w] === 'number' ? (f[w] as number) : null])) as Record<
          ObjectiveWindow,
          number | null
        >;
        return { values, reason: OBJECTIVE_WINDOWS.some((w) => values[w] !== null) ? null : 'noValue', at: p.read_at };
      }
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

// ---------- state (live, or the last sample of an archived objective) ----------

/** Per objective: the newest sample with data, and the newest sample (archived objectives show it). Read in bulk. */
export function sampleFacts(): { lastData: Map<string, string>; last: Map<string, SampleRow> } {
  const lastData = new Map(
    db()
      .all<{ objective_id: string; last_bucket: string }>(
        "SELECT objective_id, MAX(bucket) AS last_bucket FROM objective_samples WHERE status <> 'noData' GROUP BY objective_id",
      )
      .map((r) => [r.objective_id, r.last_bucket]),
  );
  const last = new Map(
    db()
      .all<SampleRow>(
        `SELECT s.* FROM objective_samples s JOIN (SELECT objective_id, MAX(bucket) AS b FROM objective_samples GROUP BY objective_id) m
         ON m.objective_id = s.objective_id AND m.b = s.bucket`,
      )
      .map((r) => [r.objective_id, r]),
  );
  return { lastData, last };
}
export type SampleFacts = ReturnType<typeof sampleFacts>;

export interface ObjectiveState {
  windows: ObjectiveWindowState[];
  status: ObjectiveStatus;
  reason: ObjectiveNoDataReason | null;
  at: string | null;
  noDataSince: string | null;
  noDataTooLong: boolean;
}

/** The longest window an objective has a target for (an archived objective counts on the scorecard that long). */
export const longestWindowMs = (r: ObjectiveRow): number =>
  Math.max(0, ...OBJECTIVE_WINDOWS.filter((w) => r[targetColumn(w)] !== null && r[targetColumn(w)] !== undefined).map((w) => OBJECTIVE_WINDOW_MS[w]));

/**
 * The state of an objective: live from the figures Steward read from Gatus; an archived objective has the status of
 * its last sample. "No data" counts since the hour after the last sample with data (or since it was defined).
 */
export function objectiveState(r: ObjectiveRow, cache: ReadingCache, facts: SampleFacts, now: number): ObjectiveState {
  if (r.archived_at) {
    // the final sample taken when it was archived (sampling.ts); "no data" is measured up to the archive
    const x = facts.last.get(r.id);
    const values = { h1: x?.value_h1 ?? null, h24: x?.value_h24 ?? null, d7: x?.value_d7 ?? null, d30: x?.value_d30 ?? null };
    const j = judge(r, values);
    if (j.status !== 'noData') return { ...j, reason: null, at: x?.bucket ?? null, noDataSince: null, noDataTooLong: false };
    const lastData = facts.lastData.get(r.id);
    const since = Math.max(Date.parse(r.created_at), lastData ? Date.parse(lastData) + HOUR : 0);
    const end = Date.parse(r.archived_at);
    return {
      ...j,
      reason: 'noValue',
      at: x?.bucket ?? null,
      noDataSince: new Date(since).toISOString(),
      noDataTooLong: end - since > OBJECTIVE_LIMITS.noDataAttentionHours * HOUR,
    };
  }
  const reading = cache.read(r.platform_id, r.endpoint_key);
  const j = judge(r, reading.values);
  const planned = plannedMinutes(r, OBJECTIVE_WINDOW_MS, now);
  j.windows = j.windows.map((w) => ({ ...w, plannedMinutes: planned[w.window] }));
  if (j.status !== 'noData') return { ...j, reason: null, at: reading.at, noDataSince: null, noDataTooLong: false };
  const last = facts.lastData.get(r.id);
  const since = Math.max(Date.parse(r.created_at), last ? Date.parse(last) + HOUR : 0);
  return {
    ...j,
    reason: reading.reason ?? 'noValue',
    at: reading.at,
    noDataSince: new Date(since).toISOString(),
    noDataTooLong: now - since > OBJECTIVE_LIMITS.noDataAttentionHours * HOUR,
  };
}

// ---------- rows and permissions ----------

export function objectiveRow(objectiveId: string): ObjectiveRow {
  const r = db().get<ObjectiveRow>('SELECT * FROM availability_objectives WHERE id = ?', objectiveId);
  if (!r) throw new HttpError(404, `Objective ${objectiveId} not found`, 'OBJECTIVE_NOT_FOUND', { id: objectiveId });
  return r;
}

export function serviceRef(serviceId: string): ServiceRef {
  const s = db().get<ServiceRef>('SELECT id, name, owners, archived FROM services WHERE id = ?', serviceId);
  if (!s) throw new HttpError(404, `Service ${serviceId} not found`, 'SERVICE_NOT_FOUND', { id: serviceId });
  return s;
}

export const canEdit = (u: AuthUser | null, s: ServiceRef) => canEditService(u, { kind: 'service', id: s.id, owners: parseJson<string[]>(s.owners, []) });

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
      if (!seen.has(k)) seen.set(k, platformPermissions(u, { id: pid, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).length > 0);
      return seen.get(k)!;
    },
  };
}

// ---------- views ----------

const toBreach = (b: BreachRow): ObjectiveBreach => ({
  id: b.id,
  startedAt: b.started_at,
  endedAt: b.ended_at,
  // breaches ended before end reasons were stored ended by a sample that met every target
  endReason: b.ended_at ? (b.end_reason ?? 'recovered') : null,
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
  facts: SampleFacts;
  now: number;
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
    facts: sampleFacts(),
    now,
  };
}

function build(r: ObjectiveRow, c: ViewCtx): ObjectiveView {
  const s = c.services.get(r.service_id)!;
  const st = objectiveState(r, c.cache, c.facts, c.now);
  const { windows, status } = st;
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
      noDataReason: status === 'noData' ? (st.reason ?? 'noValue') : null,
      valuesAt: st.at,
      notify: !!r.notify,
      breach: open && !r.archived_at ? toBreach(open) : null,
      noDataSince: st.noDataSince,
      noDataTooLong: st.noDataTooLong,
      archived: !!r.archived_at,
      archivedAt: r.archived_at,
      archivedBy: r.archived_by,
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
  /** Archived objectives, and objectives of archived services, too */
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
      return !!s && (f.archived || (!s.archived && !r.archived_at));
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
  if (pf.kind === 'prometheus') {
    // a PromQL query with $window, which Steward sets to 1h, 24h, 7d and 30d (#110)
    if (!input.endpointKey.includes('$window'))
      throw new HttpError(400, 'The PromQL query needs $window for the time window, e.g. avg_over_time(up{job="shop"}[$window])', 'OBJECTIVE_PROMQL_WINDOW');
    return;
  }
  if (pf.kind !== 'gatus') throw new HttpError(400, 'Objectives need a Gatus or Prometheus platform', 'OBJECTIVE_PLATFORM_NOT_GATUS', { id: input.platformId });
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
  const n = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM availability_objectives WHERE service_id = ? AND archived_at IS NULL', s.id)?.n ?? 0;
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
  if (cur.archived_at) throw new HttpError(409, 'The objective is archived – restore it first', 'OBJECTIVE_ARCHIVED', { id: objectiveId });
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

// ---------- Prometheus figures (#110) ----------

/** Read again when older than this (the objectives are sampled hourly). */
const PROM_REFRESH_MS = 50 * 60_000;

/**
 * Reads the figures of objectives on Prometheus platforms: per platform and query, the query once per window with
 * $window set to 1h, 24h, 7d and 30d. The result is a fraction (avg_over_time(up[…]) gives 0–1); with several series
 * the lowest counts. Read with the rights of whoever last changed the objective. Returns the number of queries read.
 */
export async function readPromObjectives(now = Date.now(), force = false): Promise<number> {
  const { vault } = await import('../vault.js');
  if (!vault().unlocked) return 0;
  const { promInstant } = await import('../platforms/prometheus.js');
  const { platformFor } = await import('../monitors/platforms.js');
  const rows = db().all<{ platform_id: string; endpoint_key: string; updated_by: string | null; created_by: string }>(
    `SELECT o.platform_id, o.endpoint_key, o.updated_by, o.created_by FROM availability_objectives o JOIN platforms p ON p.id = o.platform_id
     WHERE o.archived_at IS NULL AND p.kind = 'prometheus' ORDER BY o.updated_at DESC`,
  );
  const seen = new Set<string>();
  let read = 0;
  for (const r of rows) {
    const k = `${r.platform_id}\n${r.endpoint_key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const last = db().get<{ read_at: string }>(
      'SELECT read_at FROM prom_objective_readings WHERE platform_id = ? AND query = ?',
      r.platform_id,
      r.endpoint_key,
    );
    if (!force && last && now - Date.parse(last.read_at) < PROM_REFRESH_MS) continue;
    const figures: Partial<Record<ObjectiveWindow, number | null>> = {};
    let error: string | null = null;
    try {
      const { platform, secrets } = platformFor(r.updated_by ?? r.created_by, r.platform_id);
      for (const w of OBJECTIVE_WINDOWS) {
        const series = await promInstant(platform, secrets, r.endpoint_key.replaceAll('$window', w.slice(1) + w[0]));
        const vals = series.map((s) => s.value).filter((v) => Number.isFinite(v) && v >= 0 && v <= 1);
        figures[w] = vals.length ? Math.round(Math.min(...vals) * 10000) : null;
      }
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
    }
    db().run(
      `INSERT INTO prom_objective_readings (platform_id, query, figures, error, read_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (platform_id, query) DO UPDATE SET figures = excluded.figures, error = excluded.error, read_at = excluded.read_at`,
      r.platform_id,
      r.endpoint_key,
      error ? null : JSON.stringify(figures),
      error,
      new Date(now).toISOString(),
    );
    read++;
  }
  return read;
}
