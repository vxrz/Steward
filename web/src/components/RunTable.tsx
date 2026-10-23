import type { ReactNode } from 'react';
import { Anchor, Badge, Group, Paper, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RunSummary } from '@sm/shared';
import { fmtDate, runDuration } from '../format';
import { StatusBadge, statusLabel } from './common';
import { DataTable, type DataColumn } from './DataTable';

/** "3 changes · checks 4/5 ok" – or the error of a failed run. */
function useResultText() {
  const { t } = useTranslation('runs');
  return (r: RunSummary) =>
    [
      r.stats.openTasks ? t('table.tasksWaiting', { count: r.stats.openTasks }) : '',
      r.stats.writes ? t('table.changes', { count: r.stats.writes }) : '',
      r.stats.skippedWrites ? t('table.simulated', { count: r.stats.skippedWrites }) : '',
      r.stats.checksPassed + r.stats.checksFailed
        ? t('table.checksOk', { passed: r.stats.checksPassed, total: r.stats.checksPassed + r.stats.checksFailed })
        : '',
      r.stats.failedSteps ? t('table.failedSteps', { count: r.stats.failedSteps }) : '',
    ]
      .filter(Boolean)
      .join(' · ') ||
    (r.error ?? '');
}

/** "scheduled", "webhook" … next to the person who started the run. */
function TriggerBadge({ r }: { r: RunSummary }) {
  const { t } = useTranslation('runs');
  if (r.trigger === 'schedule')
    return (
      <Badge ml={4} size="xs" variant="outline">
        {t('table.scheduled')}
      </Badge>
    );
  if (r.trigger === 'webhook')
    return (
      <Badge ml={4} size="xs" variant="outline" color="teal" title={r.triggerName ?? undefined}>
        {t('table.webhook')}
      </Badge>
    );
  if (r.trigger === 'monitor')
    return (
      <Badge ml={4} size="xs" variant="outline" color="pink" title={r.triggerName ?? undefined}>
        {t('table.monitor')}
      </Badge>
    );
  if (r.trigger === 'subprocess')
    return (
      <Badge ml={4} size="xs" variant="outline" color="violet">
        {t('table.subprocess')}
      </Badge>
    );
  return null;
}

const durationMs = (r: RunSummary) => (r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now()) - new Date(r.startedAt).getTime();

/** The runs list (Runs page, start page): sortable table on wide screens, cards on phones. */
export function RunTable({ runs, compact = false, footer }: { runs: RunSummary[]; compact?: boolean; footer?: ReactNode }) {
  const { t } = useTranslation('runs');
  const result = useResultText();
  if (!runs.length)
    return (
      <Text c="dimmed" size="sm">
        {t('table.empty')}
      </Text>
    );
  const processLink = (r: RunSummary) => (
    // a real link, so the row is reachable with the keyboard
    <Anchor
      component={Link}
      to={`/runs/${r.id}`}
      size="sm"
      fw={500}
      c="var(--mantine-color-text)"
      underline="hover"
      onClick={(e) => e.stopPropagation()}
      style={{ overflowWrap: 'anywhere' }}
    >
      {r.processName}
    </Anchor>
  );
  const resultCell = (r: RunSummary) => (
    <Text size="xs" c={r.stats.checksFailed || r.stats.failedSteps ? 'red' : 'dimmed'}>
      {result(r)}
    </Text>
  );
  const extra: DataColumn<RunSummary>[] = compact
    ? []
    : [
        { key: 'duration', header: t('table.duration'), sortValue: durationMs, nowrap: true, cell: (r) => runDuration(r.startedAt, r.finishedAt) },
        {
          key: 'by',
          header: t('table.by'),
          sortValue: (r) => r.actor,
          cell: (r) => (
            <>
              {r.actor}
              <TriggerBadge r={r} />
            </>
          ),
        },
      ];
  const columns: DataColumn<RunSummary>[] = [
    {
      key: 'status',
      header: t('table.status'),
      sortValue: (r) => statusLabel(r.status),
      cell: (r) => (
        <>
          <StatusBadge status={r.status} />
          {r.dryRun && (
            <Badge ml={4} size="xs" color="yellow" variant="light">
              {t('table.dry')}
            </Badge>
          )}
        </>
      ),
    },
    { key: 'process', header: t('table.process'), sortValue: (r) => r.processName, cell: processLink },
    { key: 'started', header: t('table.started'), sortValue: (r) => r.startedAt, nowrap: true, cell: (r) => fmtDate(r.startedAt) },
    ...extra,
    { key: 'result', header: t('table.result'), cell: resultCell },
  ];
  return (
    <DataTable
      rows={runs}
      columns={columns}
      rowKey={(r) => r.id}
      ariaLabel={t('list.title')}
      rowHref={(r) => `/runs/${r.id}`}
      verticalSpacing={6}
      footer={footer}
      testId="run-list"
      card={(r) => (
        <Paper withBorder p="sm">
          <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
            <div style={{ minWidth: 0 }}>{processLink(r)}</div>
            <Group gap={4} wrap="nowrap">
              {r.dryRun && (
                <Badge size="xs" color="yellow" variant="light">
                  {t('table.dry')}
                </Badge>
              )}
              <StatusBadge status={r.status} size="xs" />
            </Group>
          </Group>
          <Text size="xs" c="dimmed">
            {fmtDate(r.startedAt)} · {runDuration(r.startedAt, r.finishedAt)} · {r.actor}
            <TriggerBadge r={r} />
          </Text>
          {result(r) && resultCell(r)}
        </Paper>
      )}
    />
  );
}
