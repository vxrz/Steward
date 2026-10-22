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
}
export const DashboardContext = createContext<DashboardCtx>({ refreshMs: 60000, statusFilter: null, setStatusFilter: () => undefined });
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

export function useDataset(key: string | undefined) {
  const { refreshMs } = useDashboardCtx();
  return useQuery({
    queryKey: ['dataset', key],
    queryFn: () => get<Dataset>(`/datasets/${encodeURIComponent(key!)}`),
    enabled: !!key,
    ...opts(refreshMs),
  });
}

export function useMetrics(key: string | undefined, names: string[], days: number) {
  const { refreshMs } = useDashboardCtx();
  return useQuery({
    queryKey: ['dataset-metrics', key, names.join(','), days],
    queryFn: () =>
      get<MetricSeries[]>(`/datasets/${encodeURIComponent(key!)}/metrics?days=${days}&points=200${names.length ? `&names=${encodeURIComponent(names.join(','))}` : ''}`),
    enabled: !!key && names.length > 0,
    ...opts(refreshMs),
  });
}

export const isNotFound = (e: unknown) => e instanceof ApiError && e.status === 404;
