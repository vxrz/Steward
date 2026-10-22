import { useQuery } from '@tanstack/react-query';
import type { EvaluateRequest, EvaluateResult, NodeInspection, ProcessDetail, ProcessSummary, RunDetail, RunSummary, ScopeHints } from '@sm/shared';
import { ApiError, api } from '../../api';

/** Editor support endpoints (expression assistant, live preview, node inspector, version diff). */

export const fetchScope = (processId: string, runId?: string) =>
  api<ScopeHints>('GET', `/processes/${encodeURIComponent(processId)}/scope${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);

export const evaluateExpression = (processId: string, req: EvaluateRequest) =>
  api<EvaluateResult>('POST', `/processes/${encodeURIComponent(processId)}/evaluate`, req);

export const inspectNode = (runId: string, nodeId: string) =>
  api<NodeInspection>('GET', `/runs/${encodeURIComponent(runId)}/inspect/${encodeURIComponent(nodeId)}`);

export const fetchProcessVersion = (processId: string, version?: number) =>
  api<ProcessDetail>('GET', `/processes/${encodeURIComponent(processId)}${version ? `?version=${version}` : ''}`);

export const isNotFound = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

/** Scope hints for the expression assistant. Errors (e.g. endpoint missing) are tolerated – static hints still work. */
export function useScopeHints(processId: string | undefined) {
  return useQuery({
    queryKey: ['scope', processId],
    queryFn: () => fetchScope(processId!),
    enabled: !!processId,
    retry: false,
    staleTime: 15000,
  });
}

/** Latest run of a process (shares the cache with useLastRun). */
export function useLatestRun(processId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['runs', 'latest', processId],
    queryFn: () => api<RunSummary[]>('GET', `/runs?processId=${encodeURIComponent(processId!)}&limit=1`),
    enabled: enabled && !!processId,
    staleTime: 5000,
  });
}

export function useRunDetail(runId: string | undefined) {
  return useQuery({ queryKey: ['run', runId], queryFn: () => api<RunDetail>('GET', `/runs/${runId}`), enabled: !!runId });
}

export function useProcesses() {
  return useQuery({ queryKey: ['processes'], queryFn: () => api<ProcessSummary[]>('GET', '/processes'), staleTime: 30000 });
}

export function useProcessVersion(processId: string | undefined, version?: number) {
  return useQuery({
    queryKey: ['process', processId, 'version', version ?? 'current'],
    queryFn: () => fetchProcessVersion(processId!, version),
    enabled: !!processId,
    retry: false,
    staleTime: 60000,
  });
}
