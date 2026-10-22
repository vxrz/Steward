import { useState } from 'react';
import { SegmentedControl, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TaskRecord } from '@sm/shared';
import { get } from '../api';
import { PageHeader } from '../components/common';
import { TaskPanel } from '../components/TaskPanel';

export function TasksPage() {
  const { t } = useTranslation('tasks');
  const [filter, setFilter] = useState('mine');
  const url = filter === 'mine' ? '/tasks?status=open&mine=1' : filter === 'open' ? '/tasks?status=open' : '/tasks?status=completed';
  const tasks = useQuery({ queryKey: ['tasks', filter], queryFn: () => get<TaskRecord[]>(url), refetchInterval: 5000 });
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={setFilter}
            data={[
              { value: 'mine', label: t('filter.mine') },
              { value: 'open', label: t('filter.open') },
              { value: 'completed', label: t('filter.completed') },
            ]}
          />
        }
      />
      <Stack>
        {tasks.data?.length === 0 && (
          <Text c="dimmed" size="sm">
            {filter === 'mine' ? t('emptyMine') : t('empty')}
          </Text>
        )}
        {tasks.data?.map((task) => <TaskPanel key={`${task.id}-${task.status}`} task={task} />)}
      </Stack>
    </>
  );
}
