/** /api/v1 routes for datasets and dashboard definitions. */
import type { DatasetRow } from '@sm/shared';
import * as processes from '../../processes/service.js';
import * as datasets from '../../dashboards/datasets.js';
import * as dashboards from '../../dashboards/service.js';
import { monitorDatasetVisible } from '../../monitors/datasets.js';
import { HttpError } from '../../util.js';
import { ProblemError } from './problem.js';
import { decodeCursor, encodeCursor, pageArray } from './pagination.js';
import * as S from './schemas.js';
import { notFound, paged, params, query, visibleProcessIds, type Get } from './helpers.js';

function visibleDataset(key: string) {
  let meta;
  try {
    meta = datasets.getDatasetMeta(key);
  } catch {
    throw notFound(`Dataset ${key}`);
  }
  if (!(monitorDatasetVisible(meta.processId) ?? processes.permissionsFor(meta.processId).includes('view'))) throw notFound(`Dataset ${key}`);
  return meta;
}

const mapDataset = (d: ReturnType<typeof datasets.getDatasetMeta>) => ({
  key: d.key,
  title: d.title,
  processId: d.processId,
  processName: d.processName,
  runId: d.runId,
  dryRun: d.dryRun,
  updatedAt: d.updatedAt,
  rowCount: d.rowCount,
  columns: d.columns,
  statusCounts: d.statusCounts,
  metrics: d.metrics,
  staleAfterMinutes: d.staleAfterMinutes ?? null,
  stale: d.stale,
  sources: d.sources.map((x) => ({
    id: x.id,
    name: x.name,
    environment: x.environment,
    runId: x.runId,
    scheduleId: x.scheduleId,
    updatedAt: x.updatedAt,
    rowCount: x.rowCount,
    metrics: x.metrics,
    staleAfterMinutes: x.staleAfterMinutes,
    expectedMinutes: x.expectedMinutes,
    stale: x.stale,
  })),
});

const mapDashboard = (d: ReturnType<typeof dashboards.getDashboard>) => ({
  id: d.id,
  name: d.name,
  description: d.description ?? '',
  definition: d.definition,
  owner: d.owner ?? null,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

export function dashboardRoutes(get: Get): void {
  get(
    '/datasets',
    {
      operationId: 'listDatasets',
      tag: 'Dashboards',
      summary: 'List datasets',
      description: 'Datasets published by processes you may view, ordered by key.',
      query: S.PageQuery,
      paginated: true,
      response: S.pageOf('Dataset', 'A page of datasets'),
    },
    async (req, reply) => {
      const q = query<{ cursor?: string; limit: number }>(req);
      const visible = new Set(visibleProcessIds());
      const list = datasets
        .listDatasets()
        .filter((d) => monitorDatasetVisible(d.processId) ?? visible.has(d.processId))
        .map(mapDataset);
      return paged(
        req,
        reply,
        pageArray(list, (d) => [d.key], q, q),
      );
    },
  );

  get(
    '/datasets/:datasetKey',
    {
      operationId: 'getDataset',
      tag: 'Dashboards',
      summary: 'Get dataset metadata',
      params: { datasetKey: 'Dataset key, e.g. iem.devices' },
      response: S.ref('Dataset'),
    },
    async (req) => mapDataset(visibleDataset(params(req).datasetKey!)),
  );

  get(
    '/datasets/:datasetKey/rows',
    {
      operationId: 'listDatasetRows',
      tag: 'Dashboards',
      summary: 'List the rows of a dataset snapshot',
      description:
        'In published order. When the dataset is re-published while you page through it, the next page answers 409 (dataset-changed) – start again without a cursor.',
      params: { datasetKey: 'Dataset key' },
      query: S.DatasetRowsQuery,
      paginated: true,
      errors: [409],
      response: S.pageOf('DatasetRow', 'A page of rows'),
    },
    async (req, reply) => {
      const meta = visibleDataset(params(req).datasetKey!);
      const q = query<{ status?: string[]; source?: string[]; cursor?: string; limit: number }>(req);
      const filters = { ...q, key: meta.key };
      const after = decodeCursor(q.cursor, filters);
      if (after && after[1] !== meta.updatedAt) {
        throw new ProblemError(409, {
          type: 'dataset-changed',
          title: 'Dataset changed',
          detail: 'The dataset was re-published since the first page – start again without a cursor',
        });
      }
      const rows: DatasetRow[] = datasets
        .getDataset(meta.key, q.source?.length ? { sources: q.source } : {})
        .rows.filter((r) => !q.status?.length || q.status.includes(r._status ?? 'unknown'));
      const offset = after ? Number(after[0]) : 0;
      const items = rows.slice(offset, offset + q.limit);
      const next = offset + q.limit < rows.length ? encodeCursor([offset + q.limit, meta.updatedAt], filters) : null;
      return paged(req, reply, { items, nextCursor: next });
    },
  );

  get(
    '/datasets/:datasetKey/metrics',
    {
      operationId: 'getDatasetMetrics',
      tag: 'Dashboards',
      summary: 'Metric history of a dataset',
      params: { datasetKey: 'Dataset key' },
      query: S.MetricsQuery,
      response: {
        type: 'object',
        required: ['key', 'days', 'series'],
        additionalProperties: false,
        properties: { key: { type: 'string' }, days: { type: 'integer' }, series: { type: 'array', items: S.ref('MetricSeries') } },
      },
    },
    async (req) => {
      const meta = visibleDataset(params(req).datasetKey!);
      const q = query<{ names?: string[]; source?: string[]; days: number; points: number; trend?: string }>(req);
      const view = q.source?.length ? { sources: q.source } : {};
      const series = datasets.metricSeries(meta.key, q.names?.length ? q.names : undefined, q.days, q.points, view);
      return { key: meta.key, days: q.days, series: datasets.withTrends(series, meta.key, q.trend, view) };
    },
  );

  get(
    '/dashboards',
    {
      operationId: 'listDashboards',
      tag: 'Dashboards',
      summary: 'List dashboard definitions',
      description: 'Ordered by name.',
      query: S.PageQuery,
      paginated: true,
      response: S.pageOf('Dashboard', 'A page of dashboards'),
    },
    async (req, reply) => {
      const q = query<{ cursor?: string; limit: number }>(req);
      return paged(
        req,
        reply,
        pageArray(dashboards.listDashboards().map(mapDashboard), (d) => [d.name.toLowerCase(), d.id], q, q),
      );
    },
  );

  get(
    '/dashboards/:dashboardId',
    {
      operationId: 'getDashboard',
      tag: 'Dashboards',
      summary: 'Get a dashboard definition',
      params: { dashboardId: 'Dashboard id' },
      response: S.ref('Dashboard'),
    },
    async (req) => {
      try {
        return mapDashboard(dashboards.getDashboard(params(req).dashboardId!));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Dashboard ${params(req).dashboardId}`);
        throw e;
      }
    },
  );
}
