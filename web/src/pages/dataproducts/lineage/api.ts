import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { DataLineageProposalPage, DataLineageProposalStatus, DataLineageSource, DataLineageToken } from '@sm/shared';
import { get } from '../../../api';

/**
 * The reads of lineage from tools (0.24.0, ADR 0036 phase 2): keys under `dataProducts`, so a change anywhere in the
 * module (useInvalidateDataProducts) reads them again too.
 */

const enc = encodeURIComponent;

export const lineageKeys = {
  all: ['dataProducts', 'lineage'] as const,
  sources: ['dataProducts', 'lineage', 'sources'] as const,
  source: (id: string) => ['dataProducts', 'lineage', 'source', id] as const,
  tokens: (id: string) => ['dataProducts', 'lineage', 'source', id, 'tokens'] as const,
  proposals: (q: string) => ['dataProducts', 'lineage', 'proposals', q] as const,
};

export const useLineageSources = () => useQuery({ queryKey: lineageKeys.sources, queryFn: () => get<DataLineageSource[]>('/data-products/lineage-sources') });

export const useLineageSource = (id: string) =>
  useQuery({ queryKey: lineageKeys.source(id), queryFn: () => get<DataLineageSource>(`/data-products/lineage-sources/${enc(id)}`), retry: false });

export const useLineageTokens = (id: string, enabled: boolean) =>
  useQuery({ queryKey: lineageKeys.tokens(id), queryFn: () => get<DataLineageToken[]>(`/data-products/lineage-sources/${enc(id)}/tokens`), enabled });

/** Proposals of one source (or all the reader sees) in one status, newest seen first, a page of 100 at a time. */
export function useProposals(q: { sourceId?: string; status: DataLineageProposalStatus }) {
  const params = new URLSearchParams({ status: q.status, ...(q.sourceId ? { sourceId: q.sourceId } : {}) }).toString();
  return useInfiniteQuery({
    queryKey: lineageKeys.proposals(params),
    initialPageParam: '',
    queryFn: ({ pageParam }) => get<DataLineageProposalPage>(`/data-products/lineage-proposals?${params}${pageParam ? `&cursor=${enc(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next ?? undefined,
  });
}
