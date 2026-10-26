import type { ReactNode } from 'react';
import { Anchor, Badge, Group, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TaskRecord } from '@sm/shared';
import { fmtDate } from '../format';
import { StatusBadge, subjectLabel } from './common';

/** Title, status, process and run, assignees: the top of every task panel. */
export function TaskHeader({ task, showRunLink, badges }: { task: TaskRecord; showRunLink: boolean; badges?: ReactNode }) {
  const { t } = useTranslation(['tasks', 'common']);
  return (
    <Group justify="space-between" align="flex-start" wrap="wrap">
      <div style={{ minWidth: 0, flex: 1 }}>
        <Group gap="xs">
          <Title order={4}>{task.title}</Title>
          <StatusBadge status={task.status} />
          {task.dryRun && (
            <Badge color="yellow" variant="light">
              {t('common:status.dryrun')}
            </Badge>
          )}
          {task.fourEyes && (
            <Badge color="grape" variant="light" title={t('panel.fourEyesHint')}>
              {t('panel.fourEyes')}
            </Badge>
          )}
          {badges}
        </Group>
        <Text size="xs" c="dimmed">
          {task.processName}
          {showRunLink && (
            <>
              {' · '}
              <Anchor component={Link} to={`/runs/${task.runId}`} size="xs">
                {t('panel.openRun')}
              </Anchor>
            </>
          )}
          {' · '}
          {t('panel.created', { date: fmtDate(task.createdAt) })}
          {task.startedBy ? ` · ${t('panel.startedBy', { user: task.startedBy })}` : ''}
        </Text>
        {task.assignees?.length > 0 && (
          <Group gap={4} mt={4}>
            <Text size="xs" c="dimmed">
              {t('panel.assignedTo')}
            </Text>
            {task.assignees.map((a) => (
              <Badge key={a} size="xs" variant="outline" tt="none" color={a.startsWith('user:') ? 'blue' : a.startsWith('team:') ? 'grape' : 'gray'}>
                {subjectLabel(a)}
              </Badge>
            ))}
          </Group>
        )}
      </div>
    </Group>
  );
}
