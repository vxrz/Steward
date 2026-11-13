import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { DataLineageView, DataPipelineView, DataProductLifecycle, DataProductMapView, DataProductType } from '@sm/shared';
import { get } from '../../../api';

/**
 * The reads of the data products pictures (ADR 0036 part 19): one request per picture, the graph built on the server
 * with the reader's rights. A page and the view in it share the request (the same key).
 */

export const viewKeys = {
  all: ['dataProductViews'] as const,
  pipeline: (id: string, environment: string | null) => ['dataProductViews', 'pipeline', id, environment ?? ''] as const,
  map: (f: MapFilters) => ['dataProductViews', 'map', f] as const,
  lineage: (id: string, depth: number) => ['dataProductViews', 'lineage', id, depth] as const,
};

const qs = (o: Record<string, string | number | null | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
};

export function usePipelineView(productId: string, environment: string | null) {
  return useQuery({
    queryKey: viewKeys.pipeline(productId, environment),
    queryFn: () => get<DataPipelineView>(`/data-products/${encodeURIComponent(productId)}/views/pipeline?${qs({ environment })}`),
    // another environment of the same product: the picture stays until the new one is there
    placeholderData: (prev, q) => (q?.queryKey[2] === productId ? prev : undefined),
  });
}

export interface MapFilters {
  environment?: string | null;
  domain?: string | null;
  type?: DataProductType | null;
  lifecycle?: DataProductLifecycle | null;
}

export function useMapView(f: MapFilters) {
  return useQuery({
    queryKey: viewKeys.map(f),
    queryFn: () => get<DataProductMapView>(`/data-products/map?${qs({ environment: f.environment, domain: f.domain, type: f.type, lifecycle: f.lifecycle })}`),
    placeholderData: keepPreviousData,
  });
}

export function useLineageView(elementId: string, depth: number) {
  return useQuery({
    queryKey: viewKeys.lineage(elementId, depth),
    queryFn: () => get<DataLineageView>(`/data-elements/${encodeURIComponent(elementId)}/lineage?${qs({ depth })}`),
    placeholderData: (prev, q) => (q?.queryKey[2] === elementId ? prev : undefined),
  });
}
