import { normalizeStatus, type Dataset, type DatasetMeta, type DatasetRow, type DatasetStatus, type MetricSeries } from '@sm/shared';
import { db } from '../db.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { emit } from '../events.js';

/**
 * Datasets are written by "Publish to dashboard" nodes: the latest snapshot of
 * rows (one JSON document per dataset) plus a compact metric history used for
 * trends. Dashboards only read this store – opening a dashboard never calls a
 * platform API.
 */

/** Metric history retention */
const KEEP_DAYS = Number(process.env.SM_METRIC_RETENTION_DAYS ?? 400);
const MAX_POINTS_PER_SERIES = 20000;

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

function toMeta(r: DatasetRowDb): DatasetMeta {
  const stale = r.stale_after_minutes ? Date.now() - Date.parse(r.updated_at) > r.stale_after_minutes * 60000 : false;
  return {
    key: r.key,
    title: r.title,
    processId: r.process_id,
    processName: r.process_name,
    runId: r.run_id,
    dryRun: !!r.dry_run,
    updatedAt: r.updated_at,
    rowCount: r.row_count,
    columns: parseJson<string[]>(r.columns, []),
    statusCounts: parseJson(r.status_counts, {}),
    metrics: parseJson(r.metrics, {}),
    staleAfterMinutes: r.stale_after_minutes ?? undefined,
    stale,
  };
}

const META_COLS = 'key, title, process_id, process_name, run_id, dry_run, updated_at, row_count, columns, status_counts, metrics, stale_after_minutes';

export function listDatasets(): DatasetMeta[] {
  return db().all<DatasetRowDb>(`SELECT ${META_COLS} FROM datasets ORDER BY key`).map(toMeta);
}

export function getDatasetMeta(key: string): DatasetMeta {
  const r = db().get<DatasetRowDb>(`SELECT ${META_COLS} FROM datasets WHERE key = ?`, key);
  if (!r) throw new HttpError(404, `Dataset "${key}" has no data yet – run the process that publishes it`);
  return toMeta(r);
}

export function getDataset(key: string): Dataset {
  const r = db().get<DatasetRowDb>('SELECT * FROM datasets WHERE key = ?', key);
  if (!r) throw new HttpError(404, `Dataset "${key}" has no data yet – run the process that publishes it`);
  return { ...toMeta(r), rows: parseJson<DatasetRow[]>(r.rows, []) };
}

export function deleteDataset(key: string): void {
  db().tx(() => {
    db().run('DELETE FROM datasets WHERE key = ?', key);
    db().run('DELETE FROM dataset_metrics WHERE dataset_key = ?', key);
  });
}

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
}): DatasetMeta {
  const counts: Partial<Record<DatasetStatus, number>> = {};
  for (const r of input.rows) if (r._status) counts[r._status] = (counts[r._status] ?? 0) + 1;
  const ts = nowIso();
  db().tx(() => {
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
      input.rows.length,
      JSON.stringify(input.columns),
      JSON.stringify(input.rows),
      JSON.stringify(counts),
      JSON.stringify(input.metrics),
      input.staleAfterMinutes ?? null,
    );
    for (const [name, value] of Object.entries(input.metrics)) {
      db().run('INSERT INTO dataset_metrics (dataset_key, name, ts, value, run_id) VALUES (?, ?, ?, ?, ?)', input.key, name, ts, value, input.runId);
    }
    // retention: age limit, and a hard cap per series
    db().run('DELETE FROM dataset_metrics WHERE dataset_key = ? AND ts < ?', input.key, new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
    for (const name of Object.keys(input.metrics)) {
      db().run(
        `DELETE FROM dataset_metrics WHERE dataset_key = ? AND name = ? AND id NOT IN
         (SELECT id FROM dataset_metrics WHERE dataset_key = ? AND name = ? ORDER BY ts DESC LIMIT ?)`,
        input.key,
        name,
        input.key,
        name,
        MAX_POINTS_PER_SERIES,
      );
    }
  });
  emit('dataset.published', { key: input.key, title: input.title, processId: input.processId, staleAfterMinutes: input.staleAfterMinutes });
  return getDatasetMeta(input.key);
}

/** Metric history, downsampled to at most `maxPoints` per series (last value per bucket). */
export function metricSeries(key: string, names: string[] | undefined, days: number, maxPoints = 200): MetricSeries[] {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db().all<{ name: string; ts: string; value: number }>(
    `SELECT name, ts, value FROM dataset_metrics WHERE dataset_key = ? AND ts >= ? ${names?.length ? `AND name IN (${names.map(() => '?').join(',')})` : ''} ORDER BY ts`,
    key,
    since,
    ...(names ?? []),
  );
  const byName = new Map<string, { ts: string; value: number }[]>();
  for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), { ts: r.ts, value: r.value }]);
  return [...byName.entries()].map(([name, points]) => {
    if (points.length <= maxPoints) return { name, points };
    const bucket = Math.ceil(points.length / maxPoints);
    return { name, points: points.filter((_, i) => i % bucket === bucket - 1 || i === points.length - 1) };
  });
}

export { normalizeStatus };
