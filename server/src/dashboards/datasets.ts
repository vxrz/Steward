import { Cron } from 'croner';
import {
  normalizeStatus,
  type AclEntry,
  type Dataset,
  type DatasetMeta,
  type DatasetRow,
  type DatasetSource,
  type DatasetStatus,
  type MetricSeries,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { emit } from '../events.js';
import { currentUser } from '../auth/context.js';
import { isAdmin, platformPermissions } from '../auth/permissions.js';

/**
 * Datasets are written by "Publish to dashboard" nodes: the latest snapshot of rows plus a compact metric history used
 * for trends. Dashboards only read this store – opening a dashboard never calls a platform API.
 *
 * Partitions (#142): a dataset is split into one partition per source – the platform the rows were read from (a
 * process with one connection: its platform; several: the publish step's `source` connection, else all bound
 * platforms; none: "instance"). A run replaces only its own partition, so the same process run against several
 * tenants keeps every tenant's rows, and metrics are kept per source. `datasets` holds the dataset (owner, title) and
 * all rows together for internal readers; `dataset_parts` holds each source's rows.
 *
 * Visibility: whoever may see the dataset sees a partition, unless one of its platforms has an access list without
 * them (administrators and auditors see all). Hidden partitions are left out of rows, counts and metrics, without a
 * hint. Readers pass a `View`; internal readers (reconciliation, notifications) read everything.
 */

/** Metric history retention */
const KEEP_DAYS = Number(process.env.SM_METRIC_RETENTION_DAYS ?? 400);
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
  stale_after_minutes: number | null;
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

/** The schedule's interval in minutes (from its next two runs). */
function scheduleMinutes(scheduleId: string | null): number | null {
  if (!scheduleId) return null;
  const s = db().get<{ cron: string; timezone: string | null }>('SELECT cron, timezone FROM schedules WHERE id = ?', scheduleId);
  if (!s) return null;
  try {
    const [a, b] = new Cron(s.cron, { paused: true, timezone: s.timezone || undefined }).nextRuns(2);
    return a && b ? Math.max(1, Math.round((b.getTime() - a.getTime()) / 60000)) : null;
  } catch {
    return null;
  }
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

const effectiveStale = (p: Pick<PartDb, 'stale_after_minutes' | 'expected_minutes'>): number =>
  p.stale_after_minutes ?? (p.expected_minutes ? Math.max(15, Math.ceil(p.expected_minutes * 2.5)) : DEFAULT_STALE_MINUTES);

/** Whether the reader may see a partition: none of its platforms has an access list without them. */
function partVisible(platformIds: string[], info: Map<string, PlatformInfo>): boolean {
  const u = currentUser();
  if (!u) return true; // internal readers (jobs) – routes always have a user
  if (isAdmin(u) || u.roles.includes('auditor')) return true;
  return platformIds.every((id) => {
    const p = info.get(id);
    if (!p || !p.acl.length) return true; // a deleted platform, or one without an access list
    return platformPermissions(u, p).includes('use');
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
      scheduleMinutes(scheduleId),
    );
    db().run('UPDATE dataset_metrics SET source = ? WHERE dataset_key = ? AND source IS NULL', src.id, key);
  });
}

const PART_META =
  'dataset_key, source, platform_ids, run_id, schedule_id, dry_run, updated_at, row_count, columns, status_counts, metrics, stale_after_minutes, expected_minutes';

function partsOf(key: string, withRows: boolean): PartDb[] {
  ensureParts(key);
  return db().all<PartDb>(`SELECT ${withRows ? '*' : PART_META} FROM dataset_parts WHERE dataset_key = ? ORDER BY source`, key);
}

function toSource(p: PartDb, info: Map<string, PlatformInfo>): DatasetSource {
  const ids = parseJson<string[]>(p.platform_ids, []);
  const stale = effectiveStale(p);
  return {
    id: p.source,
    platformIds: ids,
    name: ids.length ? ids.map((id) => info.get(id)?.name ?? id).join(' + ') : 'This instance',
    environment: [...new Set(ids.map((id) => info.get(id)?.environment ?? '').filter(Boolean))].join(', '),
    runId: p.run_id,
    scheduleId: p.schedule_id,
    updatedAt: p.updated_at,
    rowCount: p.row_count,
    dryRun: !!p.dry_run,
    statusCounts: parseJson(p.status_counts, {}),
    metrics: parseJson(p.metrics, {}),
    staleAfterMinutes: stale,
    expectedMinutes: p.expected_minutes,
    stale: Date.now() - Date.parse(p.updated_at) > stale * 60000,
  };
}

/** The partitions a reader sees, after the source filter of the view. */
function visibleParts(key: string, view: View | undefined, withRows: boolean): { parts: PartDb[]; info: Map<string, PlatformInfo> } {
  const all = partsOf(key, withRows);
  const info = platformInfo([...new Set(all.flatMap((p) => parseJson<string[]>(p.platform_ids, [])))]);
  const parts = all.filter((p) => partVisible(parseJson<string[]>(p.platform_ids, []), info) && (!view?.sources?.length || view.sources.includes(p.source)));
  return { parts, info };
}

function metaOf(d: DatasetRowDb, parts: PartDb[], info: Map<string, PlatformInfo>): DatasetMeta {
  const sources = parts.map((p) => toSource(p, info));
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
  return db()
    .all<DatasetRowDb>(`SELECT ${HEADER} FROM datasets ORDER BY key`)
    .map((d) => {
      const { parts, info } = visibleParts(d.key, view, false);
      return parts.length ? metaOf(d, parts, info) : null;
    })
    .filter((m): m is DatasetMeta => !!m);
}

const notFound = (key: string) => new HttpError(404, `Dataset "${key}" has no data yet – run the process that publishes it`);

export function getDatasetMeta(key: string, view?: View): DatasetMeta {
  const d = db().get<DatasetRowDb>(`SELECT ${HEADER} FROM datasets WHERE key = ?`, key);
  if (!d) throw notFound(key);
  const { parts, info } = visibleParts(key, view, false);
  if (!parts.length && currentUser() && !view?.sources?.length) throw notFound(key);
  return metaOf(d, parts, info);
}

/** The rows of the visible partitions, each with its `_source`. */
export function getDataset(key: string, view?: View): Dataset {
  const d = db().get<DatasetRowDb>(`SELECT ${HEADER} FROM datasets WHERE key = ?`, key);
  if (!d) throw notFound(key);
  const { parts, info } = visibleParts(key, view, true);
  if (!parts.length && currentUser() && !view?.sources?.length) throw notFound(key);
  const meta = metaOf(d, parts, info);
  const rows: DatasetRow[] = [];
  parts.forEach((p, i) => {
    const src = rowSource(p, meta.sources[i]!);
    for (const r of parseJson<DatasetRow[]>(p.rows, [])) rows.push({ ...r, _source: src });
  });
  return { ...meta, rows };
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
  staleAfterMinutes?: number;
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
  const counts: Partial<Record<DatasetStatus, number>> = {};
  // the stored rows carry no _source: it is added when they are read (names change)
  const rows = input.rows.map(({ _source: _s, ...r }) => r as DatasetRow);
  for (const r of rows) if (r._status) counts[r._status] = (counts[r._status] ?? 0) + 1;
  const ts = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dataset_parts (dataset_key, source, platform_ids, run_id, schedule_id, dry_run, updated_at, row_count, columns, rows, status_counts, metrics, stale_after_minutes, expected_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dataset_key, source) DO UPDATE SET platform_ids = excluded.platform_ids, run_id = excluded.run_id, schedule_id = excluded.schedule_id,
         dry_run = excluded.dry_run, updated_at = excluded.updated_at, row_count = excluded.row_count, columns = excluded.columns, rows = excluded.rows,
         status_counts = excluded.status_counts, metrics = excluded.metrics, stale_after_minutes = excluded.stale_after_minutes,
         expected_minutes = excluded.expected_minutes`,
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
      input.staleAfterMinutes ?? null,
      scheduleMinutes(scheduleId),
    );
    // the dataset: all partitions together (internal readers), with each row's source
    const parts = db().all<PartDb>('SELECT * FROM dataset_parts WHERE dataset_key = ?', input.key);
    const all: DatasetRow[] = parts.flatMap((p) =>
      parseJson<DatasetRow[]>(p.rows, []).map((r) => ({ ...r, _source: { platformId: p.source, platform: '', environment: '', run: p.run_id } })),
    );
    const allCounts: Partial<Record<DatasetStatus, number>> = {};
    for (const r of all) if (r._status) allCounts[r._status] = (allCounts[r._status] ?? 0) + 1;
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
      all.length,
      JSON.stringify(columns),
      JSON.stringify(all),
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
  return metaOf(d, [part], platformInfo(src.platformIds));
}

// ---------- metrics ----------

/** Metric history per source, downsampled to at most `maxPoints` per series (last value per bucket). */
export function metricSeries(key: string, names: string[] | undefined, days: number, maxPoints = 200, view?: View): MetricSeries[] {
  const { parts, info } = visibleParts(key, view, false);
  const sources = new Map(parts.map((p) => [p.source, toSource(p, info)]));
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
    return { name: s.name, source: s.source, sourceName: sources.get(s.source)?.name ?? s.source, points };
  });
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
  const info = platformInfo([...new Set(parts.flatMap((p) => parseJson<string[]>(p.platform_ids, [])))]);
  return parts
    .filter((p) => heads.has(p.dataset_key))
    .map((p) => {
      const d = heads.get(p.dataset_key)!;
      // messages only when the step asks for it or a schedule feeds the partition (the 24-hour default is shown, not sent)
      return {
        key: d.key,
        title: d.title,
        processId: d.process_id,
        processName: d.process_name,
        source: toSource(p, info),
        notify: !!(p.stale_after_minutes || p.expected_minutes),
      };
    });
}

export { normalizeStatus };
