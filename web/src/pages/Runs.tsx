import { useState } from 'react';
import { Group, Select } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ProcessSummary, RunSummary } from '@sm/shared';
import { get } from '../api';
import { PageHeader } from '../components/common';
import { RunTable } from '../components/RunTable';

export function RunsPage() {
  const [status, setStatus] = useState<string | null>(null);
  const [processId, setProcessId] = useState<string | null>(null);
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const qs = new URLSearchParams({ limit: '200', ...(status ? { status } : {}), ...(processId ? { processId } : {}) });
  const runs = useQuery({ queryKey: ['runs', status, processId], queryFn: () => get<RunSummary[]>(`/runs?${qs}`), refetchInterval: 4000 });
  return (
    <>
      <PageHeader
        title="Runs"
        description="Every execution of a process with its full protocol."
        actions={
          <Group gap="xs">
            <Select
              size="xs"
              placeholder="All processes"
              clearable
              searchable
              data={(processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={processId}
              onChange={setProcessId}
              w={220}
            />
            <Select
              size="xs"
              placeholder="Any status"
              clearable
              data={['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted']}
              value={status}
              onChange={setStatus}
              w={140}
            />
          </Group>
        }
      />
      <RunTable runs={runs.data ?? []} />
    </>
  );
}
