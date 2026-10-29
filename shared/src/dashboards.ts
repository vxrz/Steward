import { z } from 'zod';

// ---------- Datasets (fed by "Publish to dashboard" nodes) ----------

export const DATASET_STATUSES = ['good', 'warning', 'serious', 'critical', 'unknown'] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];

/** Map free-form status words to the canonical set. */
export function normalizeStatus(v: unknown): DatasetStatus {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if ((DATASET_STATUSES as readonly string[]).includes(s)) return s as DatasetStatus;
  if (['ok', 'pass', 'passed', 'healthy', 'online', 'active', 'success', 'succeeded', 'up', 'green'].includes(s)) return 'good';
  if (['warn', 'degraded', 'stale', 'yellow'].includes(s)) return 'warning';
  if (['major', 'orange'].includes(s)) return 'serious';
  if (['error', 'fail', 'failed', 'critical', 'offline', 'down', 'red'].includes(s)) return 'critical';
  return 'unknown';
}

/**
 * Where a row comes from (#142): the platform it was read from. A dataset is split into one partition per source, so
 * the same process run against several tenants keeps every tenant's rows. `platformId` is the source id: a platform
 * id, several joined with "+", or "instance" for a process without connections.
 */
export interface DatasetRowSource {
  platformId: string;
  /** Current name of the platform(s) */
  platform: string;
  environment: string;
  /** The run that wrote the partition */
  run: string;
}

export interface DatasetRow {
  _key?: string;
  _status?: DatasetStatus;
  _statusText?: string;
  _source?: DatasetRowSource;
  [column: string]: unknown;
}

/** One partition of a dataset: the rows of one source (#142). */
export interface DatasetSource {
  /** Platform id, ids joined with "+", or "instance" */
  id: string;
  platformIds: string[];
  /** Current name(s) of the platform(s); "This instance" for "instance" */
  name: string;
  environment: string;
  runId: string;
  /** The schedule that fed it, when a schedule did */
  scheduleId: string | null;
  updatedAt: string;
  rowCount: number;
  dryRun: boolean;
  statusCounts: Partial<Record<DatasetStatus, number>>;
  metrics: Record<string, number>;
  /** Stale after this many minutes: the publish step's setting, else 2.5 × the schedule interval (at least 15), else 24 h */
  staleAfterMinutes: number;
  /** The schedule's interval, when a schedule fed it */
  expectedMinutes: number | null;
  stale: boolean;
}

export interface DatasetMeta {
  key: string;
  title: string;
  processId: string;
  processName: string;
  runId: string;
  dryRun: boolean;
  updatedAt: string;
  rowCount: number;
  columns: string[];
  statusCounts: Partial<Record<DatasetStatus, number>>;
  /** Latest value per metric */
  metrics: Record<string, number>;
  staleAfterMinutes?: number;
  /** Any visible partition is stale */
  stale: boolean;
  /** The visible partitions (#142); rows, counts and metrics above cover these */
  sources: DatasetSource[];
}

export interface Dataset extends DatasetMeta {
  rows: DatasetRow[];
}

export interface MetricPoint {
  ts: string;
  value: number;
}

export interface MetricSeries {
  name: string;
  /** The partition the series belongs to (#142) */
  source?: string;
  sourceName?: string;
  points: MetricPoint[];
}

// ---------- Dashboards ----------

export const WIDGET_TYPES = ['kpi', 'trend', 'status', 'table', 'checks', 'freshness', 'markdown'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_INFO: Record<WidgetType, string> = {
  kpi: 'Stat tile: latest value of a metric (or the row count) with change and sparkline',
  trend: 'Line chart of up to three metrics over time',
  status: 'Distribution of row statuses (good / warning / serious / critical)',
  table: 'Rows of a dataset with status badges, search and a problems-only filter',
  checks: 'Check results of the latest run of a process',
  freshness: 'Age of every dataset on this dashboard and the next scheduled refresh',
  markdown: 'Free text (markdown subset)',
};

export const dashboardWidgetSchema = z.object({
  id: z.string().min(1),
  type: z.enum(WIDGET_TYPES),
  title: z.string().optional(),
  /** Width in 12ths of the row (3 = quarter, 6 = half, 12 = full) */
  width: z.number().int().min(2).max(12).optional(),
  dataset: z.string().optional(),
  /** kpi: metric name, or "_rows" for the row count */
  metric: z.string().optional(),
  /** trend: metric names (max 3) */
  metrics: z.array(z.string()).max(3).optional(),
  /** kpi: which direction is good for the change indicator */
  goodWhen: z.enum(['up', 'down']).optional(),
  /** kpi / trend: history window in days (default 30) */
  days: z.number().int().min(1).max(365).optional(),
  /** table: columns to show (default all) */
  columns: z.array(z.string()).max(100).optional(),
  /** table: show only rows whose status is not good */
  problemsOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  /** checks: process id */
  process: z.string().optional(),
  /** markdown */
  text: z.string().optional(),
  /** Only these sources (platform ids), whatever the dashboard's source filter says (#142) */
  source: z.array(z.string().max(300)).max(50).optional(),
});
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;

export const dashboardDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** How often the open dashboard re-reads stored data (default 1 minute) */
  refreshSeconds: z.number().int().min(10).max(3600).optional(),
  widgets: z.array(dashboardWidgetSchema).max(200).default([]),
});
export type DashboardDefinition = z.infer<typeof dashboardDefinitionSchema>;

export interface Dashboard {
  id: string;
  name: string;
  description: string;
  definition: DashboardDefinition;
  owner?: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

/** Bundle for exporting/importing processes, dashboards and connector types together. */
/** File format ids. Imports also accept the legacy ids from before the rename. */
export const BUNDLE_FORMATS = ['steward-bundle', 'service-manager-bundle'] as const;
export const CONNECTOR_FORMATS = ['steward-connector', 'service-manager-connector'] as const;

export interface ExportBundle {
  format: (typeof BUNDLE_FORMATS)[number];
  version: 1;
  exportedAt: string;
  processes: { id: string; definition: unknown }[];
  dashboards: { id: string; definition: DashboardDefinition }[];
}
