import type { ReactNode } from 'react';
import { Anchor, Badge, Group, Paper, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle } from '@tabler/icons-react';
import { outcomeOf, type RunFindings, type RunSummary } from '@sm/shared';
import type { TFunction } from 'i18next';
import { fmtDate, runDuration } from '../format';
import { StatusBadge, statusLabel } from './common';
import { DataTable, type DataColumn } from './DataTable';

/** A run's findings, falling back to the failed checks for summaries without them (all counted as errors). */
export const findingsOf = (r: Pick<RunSummary, 'findings' | 'stats'>): RunFindings =>
  r.findings ?? { total: r.stats.checksFailed, error: r.stats.checksFailed, warning: 0, info: 0 };

/** "3 findings (1 error, 2 warnings)" – empty without findings. */
export function findingsText(t: TFunction<'runs'>, f: RunFindings): string {
  if (!f.total) return '';
  const split = (['error', 'warning', 'info'] as const).filter((s) => f[s]).map((s) => t(`table.severity.${s}`, { count: f[s] }));
  return split.length ? t('table.findingsSplit', { count: f.total, split: split.join(', ') }) : t('table.findings', { count: f.total });
}

/** Failed steps that are not check findings: what went wrong while executing. */
export const errorSteps = (r: Pick<RunSummary, 'stats'>): number => Math.max(0, r.stats.failedSteps - r.stats.checksFailed);

/** "3 changes · 2 findings (1 error, 1 warning) · checks 4/6 ok" – or the error of a failed run. */
function useResultText() {
  const { t } = useTranslation('runs');
  return (r: RunSummary) =>
    [
      r.stats.openTasks ? t('table.tasksWaiting', { count: r.stats.openTasks }) : '',
      r.stats.writes ? t('table.changes', { count: r.stats.writes }) : '',
      r.stats.skippedWrites ? t('table.simulated', { count: r.stats.skippedWrites }) : '',
      findingsText(t, findingsOf(r)),
      r.stats.checksPassed + r.stats.checksFailed
        ? t('table.checksOk', { passed: r.stats.checksPassed, total: r.stats.checksPassed + r.stats.checksFailed })
        : '',
      // check findings are no failed steps: only what failed while executing
      errorSteps(r) ? t('table.failedSteps', { count: errorSteps(r) }) : '',
    ]
      .filter(Boolean)
      .join(' · ') ||
    (r.error ?? '');
}

/** Colour of the result text: red for errors while executing, orange for findings. */
const resultColor = (r: RunSummary) => (r.status === 'failed' || errorSteps(r) ? 'red' : findingsOf(r).total ? 'var(--mantine-color-orange-text)' : 'dimmed');

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
  // a problem is not told by the colour alone (WCAG 1.4.1): a warning icon goes with the coloured text
  const resultCell = (r: RunSummary) => {
    const color = resultColor(r);
    return (
      <Text size="xs" c={color}>
        {color !== 'dimmed' && <IconAlertTriangle size={12} aria-hidden style={{ verticalAlign: '-1px', marginInlineEnd: 3 }} />}
        {result(r)}
      </Text>
    );
  };
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
      sortValue: (r) => statusLabel(outcomeOf(r)),
      cell: (r) => (
        <>
          <StatusBadge status={outcomeOf(r)} />
          {r.dryRun && (
            <Badge ml={4} size="xs" color="yellow" variant="light">
              {r.recorded ? t('table.test') : t('table.dry')}
            </Badge>
          )}
          {r.debug && (
            <Badge ml={4} size="xs" color="grape" variant="light">
              {t('trigger.debug')}
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
                  {r.recorded ? t('table.test') : t('table.dry')}
                </Badge>
              )}
              {r.debug && (
                <Badge size="xs" color="grape" variant="light">
                  {t('trigger.debug')}
                </Badge>
              )}
              <StatusBadge status={outcomeOf(r)} size="xs" />
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
