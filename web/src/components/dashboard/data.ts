import { createContext, useContext } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Dataset, DatasetMeta, DatasetStatus, MetricSeries } from '@sm/shared';
import { ApiError, get } from '../../api';

/** Dashboard-wide settings shared with widgets. */
export interface DashboardCtx {
  refreshMs: number;
  /** Click on a status segment filters tables of the same dataset */
  statusFilter: { dataset: string; status: DatasetStatus } | null;
  setStatusFilter: (f: { dataset: string; status: DatasetStatus } | null) => void;
  /** The dashboard's source filter (#142): only these sources (platform ids); null = all visible */
  sources: string[] | null;
}
export const DashboardContext = createContext<DashboardCtx>({ refreshMs: 60000, statusFilter: null, setStatusFilter: () => undefined, sources: null });
export const useDashboardCtx = () => useContext(DashboardContext);

const opts = (refreshMs: number) => ({
  refetchInterval: refreshMs,
  placeholderData: keepPreviousData,
  retry: (n: number, e: unknown) => !(e instanceof ApiError && e.status === 404) && n < 2,
});

export function useDatasetMetas() {
  const { refreshMs } = useDashboardCtx();
  return useQuery({ queryKey: ['datasets'], queryFn: () => get<DatasetMeta[]>('/datasets'), ...opts(refreshMs) });
}

/** The sources a widget shows: its own pinned ones, else the dashboard's filter (#142). */
export function useScope(w?: { source?: string[] }): string[] | null {
  const { sources } = useDashboardCtx();
  return w?.source?.length ? w.source : sources;
}
const sourceQuery = (scope: string[] | null | undefined) => (scope?.length ? `source=${encodeURIComponent(scope.join(','))}` : '');

/** A dataset's meta for the sources in scope: counts, rows, metrics and freshness of those partitions only. */
export function scopeMeta(meta: DatasetMeta | undefined, scope: string[] | null): DatasetMeta | undefined {
  if (!meta || !scope?.length) return meta;
  const sources = meta.sources.filter((s) => scope.includes(s.id));
  const counts: DatasetMeta['statusCounts'] = {};
  for (const s of sources) for (const [k, n] of Object.entries(s.statusCounts)) counts[k as DatasetStatus] = (counts[k as DatasetStatus] ?? 0) + (n ?? 0);
  const latest = [...sources].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return {
    ...meta,
    sources,
    statusCounts: counts,
    rowCount: sources.reduce((n, s) => n + s.rowCount, 0),
    metrics: latest?.metrics ?? {},
    updatedAt: latest?.updatedAt ?? meta.updatedAt,
    runId: latest?.runId ?? meta.runId,
    dryRun: latest?.dryRun ?? meta.dryRun,
    stale: sources.some((s) => s.stale),
  };
}

/**
 * Series of several sources become one line per metric and source ("total · Tenant EU"), at most six (#142).
 * One source: unchanged.
 */
export function perSource(series: MetricSeries[], names: string[]): { series: MetricSeries[]; names: string[] } {
  const sources = new Set(series.map((s) => s.source ?? ''));
  if (sources.size <= 1) return { series, names };
  const out = series
    .filter((s) => names.includes(s.name))
    .sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name) || (a.sourceName ?? '').localeCompare(b.sourceName ?? ''))
    .slice(0, 6)
    .map((s) => ({ ...s, name: `${s.name} · ${s.sourceName ?? s.source}` }));
  return { series: out, names: out.map((s) => s.name) };
}

export function useDataset(key: string | undefined, scope?: string[] | null) {
  const { refreshMs } = useDashboardCtx();
  const qs = sourceQuery(scope);
  return useQuery({
    queryKey: ['dataset', key, qs],
    queryFn: () => get<Dataset>(`/datasets/${encodeURIComponent(key!)}${qs ? `?${qs}` : ''}`),
    enabled: !!key,
    ...opts(refreshMs),
  });
}

export function useMetrics(key: string | undefined, names: string[], days: number, scope?: string[] | null) {
  const { refreshMs } = useDashboardCtx();
  const qs = sourceQuery(scope);
  return useQuery({
    queryKey: ['dataset-metrics', key, names.join(','), days, qs],
    queryFn: () =>
      get<MetricSeries[]>(
        `/datasets/${encodeURIComponent(key!)}/metrics?days=${days}&points=200${names.length ? `&names=${encodeURIComponent(names.join(','))}` : ''}${qs ? `&${qs}` : ''}`,
      ),
    enabled: !!key && names.length > 0,
    ...opts(refreshMs),
  });
}

export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;
