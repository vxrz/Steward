import { useState } from 'react';
import { SegmentedControl, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { TaskRecord } from '@sm/shared';
import { get } from '../api';
import { PageHeader } from '../components/common';
import { TaskPanel } from '../components/TaskPanel';

export function TasksPage() {
  const [status, setStatus] = useState('open');
  const tasks = useQuery({
    queryKey: ['tasks', status],
    queryFn: () => get<TaskRecord[]>(`/tasks${status === 'all' ? '' : `?status=${status}`}`),
    refetchInterval: 5000,
  });
  return (
    <>
      <PageHeader
        title="My tasks"
        description="Decisions and approvals requested by running processes. Every decision is recorded in the run protocol and the audit log."
        actions={
          <SegmentedControl
            size="xs"
            value={status}
            onChange={setStatus}
            data={[
              { value: 'open', label: 'Open' },
              { value: 'completed', label: 'Done' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      />
      <Stack>
        {tasks.data?.length === 0 && (
          <Text c="dimmed" size="sm">
            {status === 'open' ? 'Nothing to decide right now.' : 'No tasks.'}
          </Text>
        )}
        {tasks.data?.map((t) => <TaskPanel key={`${t.id}-${t.status}`} task={t} />)}
      </Stack>
    </>
  );
}
