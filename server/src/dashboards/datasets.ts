import { Cron } from 'croner';
import {
  normalizeStatus,
  type AclEntry,
  type Dataset,
  type DatasetMeta,
  type DatasetRow,
  type DatasetSource,
  type DatasetStaleReason,
  type DatasetStatus,
  type MetricLimit,
  type MetricSeries,
  type PlatformPermission,
  TREND_LIMITS,
  forecastTo,
  trendOf,
  windowMs,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { emit } from '../events.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { platformDataVisible } from '../auth/policy.js';
import { permissionsFor } from '../processes/service.js';
import { env } from '../config.js';

/**
 * Datasets are written by "Publish to dashboard" nodes: the latest snapshot of rows plus a compact metric history used
 * for trends. Dashboards only read this store – opening a dashboard never calls a platform API.
 *
 * Partitions (#142): a dataset is split into one partition per source – the platform the rows were read from (a
 * process with one connection: its platform; several: the publish step's `source` connection, else all bound
 * platforms; none: "instance"). A run replaces only its own partition, so the same process run against several
 * tenants keeps every tenant's rows, and metrics are kept per source. `datasets` holds the dataset (owner, title,
 * totals); `dataset_parts` holds each source's rows – the only copy (0.4.0: the combined rows are no longer stored
 * in `datasets.rows`, which stays '[]'; readers put them together from the partitions, see partRows).
 *
 * Visibility: whoever may see the dataset sees a partition, unless one of its platforms has an access list without
 * them (administrators and auditors see all). Hidden partitions are left out of rows, counts and metrics, without a
 * hint. Readers pass a `View`; internal readers (reconciliation, notifications) read everything.
 *
 * Freshness (0.3.1): a partition written by a run that a schedule started (or a sub-process of such a run) is stale
 * after 2.5 × the schedule's interval (at least 15 minutes) – the publish step's `staleAfterMinutes` applies to runs
 * without a schedule, and to scheduled ones only with `staleAfterFixed`. The interval and the next run are read from
 * the schedule's current cron when the partition is read (the interval stored at write time is the fallback for a
 * deleted schedule), so changing a schedule takes effect at once.
 */

/** Metric history retention */
const KEEP_DAYS = env.SM_METRIC_RETENTION_DAYS;
const MAX_POINTS_PER_SERIES = 20000;
/** Without a setting and without a schedule a partition counts as stale after a day */
const DEFAULT_STALE_MINUTES = 24 * 60;
export const INSTANCE_SOURCE = 'instance';

interface DatasetRowDb {
  key: string;
  title: string;
  process_id: string;
  process_name: string;
  run_id: string;
  dry_run: number;
  updated_at: string;
  row_count: number;
  columns: string;
  rows?: string;
  status_counts: string;
  metrics: string;
  stale_after_minutes: number | null;
}

interface PartDb {
  dataset_key: string;
  source: string;
  platform_ids: string;
  run_id: string;
  schedule_id: string | null;
  dry_run: number;
  updated_at: string;
  row_count: number;
  columns: string;
  rows?: string;
  status_counts: string;
  metrics: string;
  limits?: string | null;
  stale_after_minutes: number | null;
  /** 1: `stale_after_minutes` applies to scheduled runs too (the step's `staleAfterFixed`) */
  stale_fixed?: number | null;
  expected_minutes: number | null;
}

/** Who reads, and which sources they asked for. Missing: everything (internal readers). */
export interface View {
  /** Only these source ids (dashboard or widget filter) */
  sources?: string[];
}

// ---------- sources ----------

interface PlatformInfo {
  name: string;
  environment: string;
  acl: AclEntry<PlatformPermission>[];
}

function platformInfo(ids: string[]): Map<string, PlatformInfo> {
  const out = new Map<string, PlatformInfo>();
  if (!ids.length) return out;
  for (const r of db().all<{ id: string; name: string; environment: string | null; acl: string }>(
    `SELECT id, name, environment, acl FROM platforms WHERE id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  ))
    out.set(r.id, { name: r.name, environment: r.environment ?? '', acl: parseJson(r.acl, []) });
  return out;
}

/** A schedule as freshness needs it. */
interface ScheduleFacts {
  name: string;
  processId: string;
  processName: string;
  /** Interval in minutes (between its next two runs); null: the cron no longer parses */
  minutes: number | null;
  /** Next run; null when disabled */
  nextRunAt: string | null;
}

/**
 * Schedules read once per request (a list of datasets shares them): each cron is parsed once. `null`: the schedule
 * is gone.
 */
type Schedules = Map<string, ScheduleFacts | null>;

function cronFacts(cron: string, timezone: string | null, enabled: boolean): Pick<ScheduleFacts, 'minutes' | 'nextRunAt'> {
  try {
    const c = new Cron(cron, { paused: true, timezone: timezone || undefined });
    const [a, b] = c.nextRuns(2);
    c.stop();
    return {
      minutes: a && b ? Math.max(1, Math.round((b.getTime() - a.getTime()) / 60000)) : null,
      nextRunAt: enabled && a ? a.toISOString() : null,
    };
  } catch {
    return { minutes: null, nextRunAt: null };
  }
}

/** Loads the schedules of these ids that are not in `cache` yet. */
function loadSchedules(ids: (string | null)[], cache: Schedules = new Map()): Schedules {
  const missing = [...new Set(ids.filter((id): id is string => !!id && !cache.has(id)))];
  if (!missing.length) return cache;
  for (const r of db().all<{
    id: string;
    name: string;
    process_id: string;
    process_name: string | null;
    cron: string;
    timezone: string | null;
    enabled: number;
  }>(
    `SELECT s.id, s.name, s.process_id, p.name AS process_name, s.cron, s.timezone, s.enabled
       FROM schedules s LEFT JOIN processes p ON p.id = s.process_id WHERE s.id IN (${missing.map(() => '?').join(',')})`,
    ...missing,
  ))
    cache.set(r.id, { name: r.name, processId: r.process_id, processName: r.process_name ?? r.process_id, ...cronFacts(r.cron, r.timezone, !!r.enabled) });
  for (const id of missing) if (!cache.has(id)) cache.set(id, null);
  return cache;
}

/** The schedule a run belongs to (a sub-process: its first parent's). */
function scheduleOfRun(runId: string): string | null {
  let id: string | null = runId;
  for (let i = 0; id && i < 20; i++) {
    const r: { schedule_id: string | null; parent_run_id: string | null } | undefined = db().get(
      'SELECT schedule_id, parent_run_id FROM runs WHERE id = ?',
      id,
    );
    if (!r) return null;
    if (r.parent_run_id) id = r.parent_run_id;
    else return r.schedule_id;
  }
  return null;
}

/**
 * The source of a run's rows: the platform of the `slot` connection, of the only connection, or all bound platforms
 * together; "instance" for a run without connections (or no run: monitor datasets).
 */
export function sourceOfRun(runId: string, slot?: string): { id: string; platformIds: string[] } {
  const r = runId ? db().get<{ bindings: string }>('SELECT bindings FROM runs WHERE id = ?', runId) : undefined;
  const bindings = parseJson<Record<string, { platformId?: string }>>(r?.bindings, {});
  const bySlot = slot ? bindings[slot]?.platformId : undefined;
  const ids = bySlot
    ? [bySlot]
    : [
        ...new Set(
          Object.values(bindings)
            .map((b) => b?.platformId)
            .filter((x): x is string => !!x),
        ),
      ].sort();
  return ids.length ? { id: ids.join('+'), platformIds: ids } : { id: INSTANCE_SOURCE, platformIds: [] };
}

/**
 * When a partition is stale, and why: a scheduled run follows its schedule (2.5 × the current interval, at least 15
 * minutes; the stored interval when the schedule is gone), unless the step fixes its limit for scheduled runs too; a
 * run without a schedule the step's limit, else 24 hours.
 */
export function freshnessOf(
  p: Pick<PartDb, 'schedule_id' | 'stale_after_minutes' | 'stale_fixed' | 'expected_minutes'>,
  schedule: ScheduleFacts | null | undefined,
): { staleAfterMinutes: number; staleReason: DatasetStaleReason; expectedMinutes: number | null } {
  const expectedMinutes = p.schedule_id ? (schedule?.minutes ?? p.expected_minutes ?? null) : null;
  if (p.stale_after_minutes && (!expectedMinutes || p.stale_fixed)) return { staleAfterMinutes: p.stale_after_minutes, staleReason: 'fixed', expectedMinutes };
  if (expectedMinutes) return { staleAfterMinutes: Math.max(15, Math.ceil(expectedMinutes * 2.5)), staleReason: 'schedule', expectedMinutes };
  return { staleAfterMinutes: DEFAULT_STALE_MINUTES, staleReason: 'default', expectedMinutes };
}

/** Whether the reader may see a partition: none of its platforms has an access list without them. */
function partVisible(platformIds: string[], info: Map<string, PlatformInfo>): boolean {
  const u = currentUser();
  if (!u) return true; // internal readers (jobs) – routes always have a user
  if (isAdmin(u) || u.roles.includes('auditor')) return true;
  return platformIds.every((id) => {
    const p = info.get(id);
    if (!p) return true; // a deleted platform
    return platformDataVisible(u, { id, acl: p.acl });
  });
}

// ---------- partitions ----------

/** Existing datasets (before 0.2.4, or from a migration package) become one partition of their last run's source. */
function ensureParts(key: string): void {
  const any = db().get('SELECT 1 FROM dataset_parts WHERE dataset_key = ? LIMIT 1', key);
  if (any) return;
  const d = db().get<DatasetRowDb>('SELECT * FROM datasets WHERE key = ?', key);
  if (!d) return;
  const src = sourceOfRun(d.run_id);
  const scheduleId = d.run_id ? scheduleOfRun(d.run_id) : null;
  db().tx(() => {
    db().run(
      `INSERT INTO dataset_parts (dataset_key, source, platform_ids, run_id, schedule_id, dry_run, updated_at, row_count, columns, rows, status_counts, metrics, stale_after_minutes, expected_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key,
      src.id,
      JSON.stringify(src.platformIds),
      d.run_id,
      scheduleId,
      d.dry_run,
      d.updated_at,
      d.row_count,
      d.columns,
      d.rows ?? '[]',
      d.status_counts,
      d.metrics,
      d.stale_after_minutes,
      scheduleId ? (loadSchedules([scheduleId]).get(scheduleId)?.minutes ?? null) : null,
    );
    db().run('UPDATE dataset_metrics SET source = ? WHERE dataset_key = ? AND source IS NULL', src.id, key);
    // the rows now live in the partition only
    db().run("UPDATE datasets SET rows = '[]' WHERE key = ?", key);
  });
}

// ---------- rows of a partition (parsed once, while unchanged) ----------

/**
 * Parsed rows of recently read partitions, keyed by dataset, source and the run and time that wrote them – a new
 * publish changes the key, so an entry is never stale. Bounded by the number of rows held; dashboards that several
 * people open, and readers that ask twice in one request (MCP, reconciliation), parse a partition once.
 */
const ROW_CACHE_MAX_ROWS = env.SM_DATASET_CACHE_ROWS;
const rowCache = new Map<string, DatasetRow[]>();
let rowCacheSize = 0;

function partRows(p: Pick<PartDb, 'dataset_key' | 'source' | 'run_id' | 'updated_at'> & { rows?: string }): DatasetRow[] {
  const k = `${p.dataset_key}\u0000${p.source}\u0000${p.run_id}\u0000${p.updated_at}`;
  const hit = rowCache.get(k);
  if (hit) {
    rowCache.delete(k); // most recently used last
    rowCache.set(k, hit);
    return hit;
  }
  const text = p.rows ?? db().get<{ rows: string }>('SELECT rows FROM dataset_parts WHERE dataset_key = ? AND source = ?', p.dataset_key, p.source)?.rows;
  const rows = parseJson<DatasetRow[]>(text, []);
  if (rows.length <= ROW_CACHE_MAX_ROWS) {
    rowCache.set(k, rows);
    rowCacheSize += rows.length;
    for (const [old, v] of rowCache) {
      if (rowCacheSize <= ROW_CACHE_MAX_ROWS) break;
      rowCache.delete(old);
      rowCacheSize -= v.length;
    }
  }
  return rows;
}

/** Tests: forget the parsed rows. */
export function clearDatasetRowCache(): void {
  rowCache.clear();
  rowCacheSize = 0;
}

const PART_META =
  'dataset_key, source, platform_ids, run_id, schedule_id, dry_run, updated_at, row_count, columns, status_counts, metrics, limits, stale_after_minutes, stale_fixed, expected_minutes';

function partsOf(key: string, withRows: boolean): PartDb[] {
  ensureParts(key);
  return db().all<PartDb>(`SELECT ${withRows ? '*' : PART_META} FROM dataset_parts WHERE dataset_key = ? ORDER BY source`, key);
}

/** Whether the reader may see a process's name (internal readers: always). */
const processVisible = (processId: string, cache: Map<string, boolean>): boolean => {
  if (!currentUser()) return true;
  let v = cache.get(processId);
  if (v === undefined) cache.set(processId, (v = permissionsFor(processId).includes('view')));
  return v;
};

/** What one read shares between its partitions: platforms, schedules, process visibility. */
interface ReadCtx {
  info: Map<string, PlatformInfo>;
  schedules: Schedules;
  processes: Map<string, boolean>;
}

function toSource(p: PartDb, ctx: ReadCtx, datasetProcessId: string): DatasetSource {
  const ids = parseJson<string[]>(p.platform_ids, []);
  const schedule = p.schedule_id ? loadSchedules([p.schedule_id], ctx.schedules).get(p.schedule_id) : null;
  const f = freshnessOf(p, schedule);
  const shown = !!schedule && processVisible(schedule.processId, ctx.processes);
  return {
    id: p.source,
    platformIds: ids,
    name: ids.length ? ids.map((id) => ctx.info.get(id)?.name ?? id).join(' + ') : 'This instance',
    environment: [...new Set(ids.map((id) => ctx.info.get(id)?.environment ?? '').filter(Boolean))].join(', '),
    runId: p.run_id,
    scheduleId: p.schedule_id,
    updatedAt: p.updated_at,
    rowCount: p.row_count,
    dryRun: !!p.dry_run,
    statusCounts: parseJson(p.status_counts, {}),
    metrics: parseJson(p.metrics, {}),
    limits: parseJson(p.limits ?? '{}', {}),
    staleAfterMinutes: f.staleAfterMinutes,
    staleReason: f.staleReason,
    expectedMinutes: f.expectedMinutes,
    nextRunAt: schedule?.nextRunAt ?? null,
    scheduleName: shown ? schedule.name : null,
    viaProcess: shown && schedule.processId !== datasetProcessId ? { id: schedule.processId, name: schedule.processName } : null,
    stale: Date.now() - Date.parse(p.updated_at) > f.staleAfterMinutes * 60000,
  };
}

/** The partitions a reader sees, after the source filter of the view. */
function visibleParts(
  key: string,
  view: View | undefined,
  withRows: boolean,
  shared?: Pick<ReadCtx, 'schedules' | 'processes'>,
): { parts: PartDb[]; ctx: ReadCtx } {
  const all = partsOf(key, withRows);
  const info = platformInfo([...new Set(all.flatMap((p) => parseJson<string[]>(p.platform_ids, [])))]);
  const parts = all.filter((p) => partVisible(parseJson<string[]>(p.platform_ids, []), info) && (!view?.sources?.length || view.sources.includes(p.source)));
  const ctx: ReadCtx = { info, schedules: shared?.schedules ?? new Map(), processes: shared?.processes ?? new Map() };
  loadSchedules(
    parts.map((p) => p.schedule_id),
    ctx.schedules,
  );
  return { parts, ctx };
}

function metaOf(d: DatasetRowDb, parts: PartDb[], ctx: ReadCtx): DatasetMeta {
  const sources = parts.map((p) => toSource(p, ctx, d.process_id));
  const counts: Partial<Record<DatasetStatus, number>> = {};
  for (const s of sources) for (const [k, n] of Object.entries(s.statusCounts)) counts[k as DatasetStatus] = (counts[k as DatasetStatus] ?? 0) + (n ?? 0);
  const latest = [...parts].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const columns = [...new Set(parts.flatMap((p) => parseJson<string[]>(p.columns, [])))];
  return {
    key: d.key,
    title: d.title,
    processId: d.process_id,
    processName: d.process_name,
    runId: latest?.run_id ?? d.run_id,
    dryRun: latest ? !!latest.dry_run : !!d.dry_run,
    updatedAt: latest?.updated_at ?? d.updated_at,
    rowCount: sources.reduce((n, s) => n + s.rowCount, 0),
    columns: columns.length ? columns : parseJson<string[]>(d.columns, []),
    statusCounts: counts,
    // one source: its metrics; several: the latest one's (per source in `sources`)
    metrics: latest ? parseJson(latest.metrics, {}) : {},
    limits: latest ? parseJson(latest.limits ?? '{}', {}) : {},
    staleAfterMinutes: d.stale_after_minutes ?? undefined,
    stale: sources.some((s) => s.stale),
    sources,
  };
}

const rowSource = (p: PartDb, s: DatasetSource) => ({ platformId: s.id, platform: s.name, environment: s.environment, run: p.run_id });

// ---------- read ----------

const HEADER = 'key, title, process_id, process_name, run_id, dry_run, updated_at, row_count, columns, status_counts, metrics, stale_after_minutes';

/** All datasets with their visible partitions; a dataset without any is left out. */
export function listDatasets(view?: View): DatasetMeta[] {
  const shared = { schedules: new Map() as Schedules, processes: new Map<string, boolean>() };
  return db()
    .all<DatasetRowDb>(`SELECT ${HEADER} FROM datasets ORDER BY key`)
    .map((d) => {
      const { parts, ctx } = visibleParts(d.key, view, false, shared);
      return parts.length ? metaOf(d, parts, ctx) : null;
    })
    .filter((m): m is DatasetMeta => !!m);
}

const notFound = (key: string) => new HttpError(404, `Dataset "${key}" has no data yet – run the process that publishes it`);

export function getDatasetMeta(key: string, view?: View): DatasetMeta {
  const d = db().get<DatasetRowDb>(`SELECT ${HEADER} FROM datasets WHERE key = ?`, key);
  if (!d) throw notFound(key);
  const { parts, ctx } = visibleParts(key, view, false);
  if (!parts.length && currentUser() && !view?.sources?.length) throw notFound(key);
  return metaOf(d, parts, ctx);
}

/** The rows of the visible partitions, each with its `_source`. */
export function getDataset(key: string, view?: View): Dataset {
  const d = db().get<DatasetRowDb>(`SELECT ${HEADER} FROM datasets WHERE key = ?`, key);
  if (!d) throw notFound(key);
  const { parts, ctx } = visibleParts(key, view, false);
  if (!parts.length && currentUser() && !view?.sources?.length) throw notFound(key);
  const meta = metaOf(d, parts, ctx);
  const rows: DatasetRow[] = [];
  parts.forEach((p, i) => {
    const src = rowSource(p, meta.sources[i]!);
    for (const r of partRows(p)) rows.push({ ...r, _source: src });
  });
  return { ...meta, rows };
}

/**
 * All rows of a dataset (every partition; internal readers such as access reconciliation), each with the source it
 * came from, put together from the partitions. Undefined when the dataset has no data.
 */
export function datasetRows(key: string): { rows: DatasetRow[]; runId: string; dryRun: boolean; processId: string } | undefined {
  const d = db().get<DatasetRowDb>(`SELECT ${HEADER} FROM datasets WHERE key = ?`, key);
  if (!d) return undefined;
  const parts = partsOf(key, false);
  const rows = parts.flatMap((p) => partRows(p).map((r) => ({ ...r, _source: { platformId: p.source, platform: '', environment: '', run: p.run_id } })));
  return { rows, runId: d.run_id, dryRun: !!d.dry_run, processId: d.process_id };
}

/** The process that owns a dataset key (first publisher), or undefined if it has no data yet. */
export function datasetOwner(key: string): string | undefined {
  return db().get<{ process_id: string }>('SELECT process_id FROM datasets WHERE key = ?', key)?.process_id;
}

export function deleteDataset(key: string): void {
  db().tx(() => {
    db().run('DELETE FROM datasets WHERE key = ?', key);
    db().run('DELETE FROM dataset_parts WHERE dataset_key = ?', key);
    db().run('DELETE FROM dataset_metrics WHERE dataset_key = ?', key);
  });
}

// ---------- write ----------

export function publishDataset(input: {
  key: string;
  title: string;
  processId: string;
  processName: string;
  runId: string;
  dryRun: boolean;
  columns: string[];
  rows: DatasetRow[];
  metrics: Record<string, number>;
  /** Limits of metrics (#145) */
  limits?: Record<string, MetricLimit>;
  staleAfterMinutes?: number;
  /** `staleAfterMinutes` applies to scheduled runs too (instead of the schedule's interval) */
  staleAfterFixed?: boolean;
  /** The connection whose platform is the source (#142) */
  sourceSlot?: string;
}): DatasetMeta {
  // A dataset key is owned by the process that first published it; another process
  // may not overwrite it (that would poison a dashboard and reassign its visibility).
  // An administrator resets ownership by deleting the dataset (DELETE /api/datasets/:key).
  const owner = db().get<{ process_id: string; process_name: string }>('SELECT process_id, process_name FROM datasets WHERE key = ?', input.key);
  if (owner && owner.process_id !== input.processId) {
    throw new HttpError(
      409,
      `Dataset "${input.key}" is owned by process "${owner.process_name}". Another process may not overwrite it. ` +
        `Use a different dataset key, or ask an administrator to delete the dataset first (Dashboards → dataset → Delete).`,
    );
  }
  if (owner) ensureParts(input.key);
  const src = sourceOfRun(input.runId, input.sourceSlot);
  const scheduleId = input.runId ? scheduleOfRun(input.runId) : null;
  const schedules = loadSchedules([scheduleId]);
  const counts: Partial<Record<DatasetStatus, number>> = {};
  // the stored rows carry no _source: it is added when they are read (names change)
  const rows = input.rows.map(({ _source: _s, ...r }) => r as DatasetRow);
  for (const r of rows) if (r._status) counts[r._status] = (counts[r._status] ?? 0) + 1;
  const ts = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dataset_parts (dataset_key, source, platform_ids, run_id, schedule_id, dry_run, updated_at, row_count, columns, rows, status_counts, metrics, limits, stale_after_minutes, stale_fixed, expected_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dataset_key, source) DO UPDATE SET platform_ids = excluded.platform_ids, run_id = excluded.run_id, schedule_id = excluded.schedule_id,
         dry_run = excluded.dry_run, updated_at = excluded.updated_at, row_count = excluded.row_count, columns = excluded.columns, rows = excluded.rows,
         status_counts = excluded.status_counts, metrics = excluded.metrics, limits = excluded.limits,
         stale_after_minutes = excluded.stale_after_minutes, stale_fixed = excluded.stale_fixed, expected_minutes = excluded.expected_minutes`,
      input.key,
      src.id,
      JSON.stringify(src.platformIds),
      input.runId,
      scheduleId,
      input.dryRun ? 1 : 0,
      ts,
      rows.length,
      JSON.stringify(input.columns),
      JSON.stringify(rows),
      JSON.stringify(counts),
      JSON.stringify(input.metrics),
      JSON.stringify(input.limits ?? {}),
      input.staleAfterMinutes ?? null,
      input.staleAfterFixed ? 1 : 0,
      // the fallback for when the schedule is deleted; readers use the schedule's current interval
      scheduleId ? (schedules.get(scheduleId)?.minutes ?? null) : null,
    );
    // the dataset's totals from the partitions' metadata – their rows are not read again (0.4.0: the combined rows
    // are put together when read, datasets.rows stays '[]')
    const parts = db().all<PartDb>(`SELECT ${PART_META} FROM dataset_parts WHERE dataset_key = ?`, input.key);
    const allCounts: Partial<Record<DatasetStatus, number>> = {};
    for (const p of parts)
      for (const [k, n] of Object.entries(parseJson<Partial<Record<DatasetStatus, number>>>(p.status_counts, {})))
        allCounts[k as DatasetStatus] = (allCounts[k as DatasetStatus] ?? 0) + (n ?? 0);
    const total = parts.reduce((n, p) => n + Number(p.row_count), 0);
    const columns = [...new Set(parts.flatMap((p) => parseJson<string[]>(p.columns, [])))];
    db().run(
      `INSERT INTO datasets (key, title, process_id, process_name, run_id, dry_run, updated_at, row_count, columns, rows, status_counts, metrics, stale_after_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET title = excluded.title, process_id = excluded.process_id, process_name = excluded.process_name,
         run_id = excluded.run_id, dry_run = excluded.dry_run, updated_at = excluded.updated_at, row_count = excluded.row_count,
         columns = excluded.columns, rows = excluded.rows, status_counts = excluded.status_counts, metrics = excluded.metrics,
         stale_after_minutes = excluded.stale_after_minutes`,
      input.key,
      input.title,
      input.processId,
      input.processName,
      input.runId,
      input.dryRun ? 1 : 0,
      ts,
      total,
      JSON.stringify(columns),
      '[]',
      JSON.stringify(allCounts),
      JSON.stringify(input.metrics),
      input.staleAfterMinutes ?? null,
    );
    for (const [name, value] of Object.entries(input.metrics)) {
      db().run(
        'INSERT INTO dataset_metrics (dataset_key, name, ts, value, run_id, source) VALUES (?, ?, ?, ?, ?, ?)',
        input.key,
        name,
        ts,
        value,
        input.runId,
        src.id,
      );
    }
    // retention: age limit, and a hard cap per series
    db().run('DELETE FROM dataset_metrics WHERE dataset_key = ? AND ts < ?', input.key, new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
    for (const name of Object.keys(input.metrics)) {
      db().run(
        `DELETE FROM dataset_metrics WHERE dataset_key = ? AND name = ? AND source = ? AND id NOT IN
         (SELECT id FROM dataset_metrics WHERE dataset_key = ? AND name = ? AND source = ? ORDER BY ts DESC LIMIT ?)`,
        input.key,
        name,
        src.id,
        input.key,
        name,
        src.id,
        MAX_POINTS_PER_SERIES,
      );
    }
  });
  emit('dataset.published', { key: input.key, title: input.title, processId: input.processId, staleAfterMinutes: input.staleAfterMinutes });
  // the partition just written, whoever runs the process
  const d = db().get<DatasetRowDb>(`SELECT ${HEADER} FROM datasets WHERE key = ?`, input.key)!;
  const part = db().get<PartDb>(`SELECT ${PART_META} FROM dataset_parts WHERE dataset_key = ? AND source = ?`, input.key, src.id)!;
  return metaOf(d, [part], { info: platformInfo(src.platformIds), schedules, processes: new Map() });
}

// ---------- metrics ----------

/** Metric history per source, downsampled to at most `maxPoints` per series (last value per bucket). */
export function metricSeries(key: string, names: string[] | undefined, days: number, maxPoints = 200, view?: View): MetricSeries[] {
  const d = db().get<{ process_id: string }>('SELECT process_id FROM datasets WHERE key = ?', key);
  const { parts, ctx } = visibleParts(key, view, false);
  const sources = new Map(parts.map((p) => [p.source, toSource(p, ctx, d?.process_id ?? '')]));
  if (!sources.size) return [];
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const ids = [...sources.keys()];
  const rows = db().all<{ name: string; source: string | null; ts: string; value: number }>(
    `SELECT name, source, ts, value FROM dataset_metrics WHERE dataset_key = ? AND ts >= ?
       AND source IN (${ids.map(() => '?').join(',')})
       ${names?.length ? `AND name IN (${names.map(() => '?').join(',')})` : ''} ORDER BY ts`,
    key,
    since,
    ...ids,
    ...(names ?? []),
  );
  const bySeries = new Map<string, { name: string; source: string; points: { ts: string; value: number }[] }>();
  for (const r of rows) {
    const k = `${r.name}\u0000${r.source}`;
    let s = bySeries.get(k);
    if (!s) bySeries.set(k, (s = { name: r.name, source: r.source ?? '', points: [] }));
    s.points.push({ ts: r.ts, value: r.value });
  }
  return [...bySeries.values()].map((s) => {
    const points =
      s.points.length <= maxPoints
        ? s.points
        : s.points.filter((_, i, a) => i % Math.ceil(a.length / maxPoints) === Math.ceil(a.length / maxPoints) - 1 || i === a.length - 1);
    const src = sources.get(s.source);
    return { name: s.name, source: s.source, sourceName: src?.name ?? s.source, points, limit: src?.limits[s.name] ?? null };
  });
}

/**
 * One metric of a dataset for an expression of a run (`$trend`, `$daysUntil`, #145): `ref` is `dataset/metric`
 * (e.g. `ih.assets/attributes`). The series of the run's own source (the platform it is bound to), else the dataset's
 * only one. `mayRead(processId)` decides whether the run may read a dataset another process publishes.
 */
export function metricForRun(
  ref: string,
  window: string,
  run: { runId: string; processId: string; mayRead: (datasetProcessId: string) => boolean },
): MetricSeries | null {
  const i = ref.indexOf('/');
  if (i < 1) throw new HttpError(400, `Name the metric as dataset/metric, e.g. ih.assets/attributes (got "${ref}")`, 'METRIC_REF');
  const key = ref.slice(0, i);
  const name = ref.slice(i + 1);
  const ms = windowMs(window);
  if (!ms) throw new HttpError(400, `Use a window such as 24h, 7d or 30d (got "${window}")`, 'TREND_WINDOW');
  const d = db().get<{ process_id: string }>('SELECT process_id FROM datasets WHERE key = ?', key);
  if (!d || (d.process_id !== run.processId && !run.mayRead(d.process_id))) return null;
  const parts = partsOf(key, false).map((p) => p.source);
  const own = sourceOfRun(run.runId).id;
  const source = parts.includes(own) ? own : parts.length === 1 ? parts[0]! : null;
  if (!source) return null;
  const [s] = metricTrends(key, [name], window, { sources: [source] });
  return s ?? null;
}

/** Series of a chart with the trend (and forecast) of each over `window` (#145). */
export function withTrends(series: MetricSeries[], key: string, window: string | undefined, view?: View): MetricSeries[] {
  if (!window) return series;
  const trends = new Map(metricTrends(key, [...new Set(series.map((s) => s.name))], window, view).map((t) => [`${t.name}\u0000${t.source}`, t]));
  return series.map((s) => {
    const t = trends.get(`${s.name}\u0000${s.source}`);
    return { ...s, trend: t?.trend ?? null, forecast: t?.forecast ?? null };
  });
}

/**
 * Trends of metric series over a window (#145), and when a limit is reached: from all points of the window (not the
 * thinned ones of a chart), per source.
 */
export function metricTrends(key: string, names: string[] | undefined, window: string, view?: View, now = Date.now()): MetricSeries[] {
  const ms = windowMs(window);
  if (!ms) throw new HttpError(400, 'Use a window such as 24h, 7d or 30d', 'TREND_WINDOW');
  return metricSeries(key, names, Math.ceil(ms / 86400000), TREND_LIMITS.maxPoints, view).map((s) => ({
    ...s,
    trend: trendOf(s.points, window, now),
    forecast: s.limit ? forecastTo(s.points, s.limit.value, { window, lower: s.limit.lower, now }) : null,
  }));
}

/** Partitions for the stale check (all of them; internal). */
export function allParts(): { key: string; title: string; processId: string; processName: string; source: DatasetSource; notify: boolean }[] {
  const heads = new Map(
    db()
      .all<DatasetRowDb>(`SELECT ${HEADER} FROM datasets`)
      .map((d) => [d.key, d]),
  );
  for (const k of heads.keys()) ensureParts(k);
  const parts = db().all<PartDb>(`SELECT ${PART_META} FROM dataset_parts`);
  const ctx: ReadCtx = {
    info: platformInfo([...new Set(parts.flatMap((p) => parseJson<string[]>(p.platform_ids, [])))]),
    schedules: loadSchedules(parts.map((p) => p.schedule_id)),
    processes: new Map(),
  };
  return parts
    .filter((p) => heads.has(p.dataset_key))
    .map((p) => {
      const d = heads.get(p.dataset_key)!;
      const source = toSource(p, ctx, d.process_id);
      // messages only when the step asks for it or a schedule feeds the partition (the 24-hour default is shown, not sent)
      return { key: d.key, title: d.title, processId: d.process_id, processName: d.process_name, source, notify: source.staleReason !== 'default' };
    });
}

export { normalizeStatus };
