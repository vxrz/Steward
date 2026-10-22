import { useState } from 'react';
import { SegmentedControl, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { TaskRecord } from '@sm/shared';
import { get } from '../api';
import { PageHeader } from '../components/common';
import { TaskPanel } from '../components/TaskPanel';

export function TasksPage() {
  const [filter, setFilter] = useState('mine');
  const url = filter === 'mine' ? '/tasks?status=open&mine=1' : filter === 'open' ? '/tasks?status=open' : '/tasks?status=completed';
  const tasks = useQuery({ queryKey: ['tasks', filter], queryFn: () => get<TaskRecord[]>(url), refetchInterval: 5000 });
  return (
    <>
      <PageHeader
        title="My tasks"
        description="Decisions and approvals requested by running processes. “Mine” shows what you may decide; every decision is recorded in the run protocol and the audit log."
        actions={
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={setFilter}
            data={[
              { value: 'mine', label: 'Mine' },
              { value: 'open', label: 'All open' },
              { value: 'completed', label: 'Done' },
            ]}
          />
        }
      />
      <Stack>
        {tasks.data?.length === 0 && (
          <Text c="dimmed" size="sm">
            {filter === 'mine' ? 'Nothing for you to decide right now.' : 'No tasks.'}
          </Text>
        )}
        {tasks.data?.map((t) => <TaskPanel key={`${t.id}-${t.status}`} task={t} />)}
      </Stack>
    </>
  );
}
