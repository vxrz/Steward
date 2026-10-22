import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RunDetail, RunSummary } from '@sm/shared';
import { get } from '../../api';
import type { NodeRunStatus } from './FlowNodeView';

const PRIORITY = ['failed', 'waiting', 'running', 'dryrun', 'succeeded', 'skipped'];
const ACTIVE = ['running', 'waiting', 'queued'];

/** Latest run of a process, mapped to a status per node id (Node-RED style status). */
export function useLastRun(processId: string, enabled: boolean) {
  const latest = useQuery({
    queryKey: ['runs', 'latest', processId],
    queryFn: () => get<RunSummary[]>(`/runs?processId=${encodeURIComponent(processId)}&limit=1`),
    enabled,
    refetchInterval: enabled ? 5000 : false,
  });
  const runId = latest.data?.[0]?.id;
  const detail = useQuery({
    queryKey: ['run', runId],
    queryFn: () => get<RunDetail>(`/runs/${runId}`),
    enabled: enabled && !!runId,
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.status) ? 2000 : false),
  });
  const statusByNode = useMemo(() => {
    if (!enabled || !detail.data) return undefined;
    const m = new Map<string, NodeRunStatus>();
    for (const s of detail.data.steps) {
      const cur = m.get(s.stepId) ?? { counts: {}, status: s.status };
      cur.counts[s.status] = (cur.counts[s.status] ?? 0) + 1;
      m.set(s.stepId, cur);
    }
    for (const v of m.values()) v.status = PRIORITY.find((p) => (v.counts[p] ?? 0) > 0) ?? v.status;
    return m;
  }, [enabled, detail.data]);
  return { run: detail.data, statusByNode, loading: latest.isLoading || detail.isLoading, none: latest.data?.length === 0 };
}
