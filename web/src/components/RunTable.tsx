import { Badge, Table, Text } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RunSummary } from '@sm/shared';
import { fmtDate, runDuration } from '../format';
import { StatusBadge } from './common';

export function RunTable({ runs, compact = false }: { runs: RunSummary[]; compact?: boolean }) {
  const { t } = useTranslation('runs');
  const navigate = useNavigate();
  if (!runs.length)
    return (
      <Text c="dimmed" size="sm">
        {t('table.empty')}
      </Text>
    );
  return (
    <div className="table-scroll">
      <Table highlightOnHover fz="sm" verticalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('table.status')}</Table.Th>
            <Table.Th>{t('table.process')}</Table.Th>
            <Table.Th>{t('table.started')}</Table.Th>
            {!compact && <Table.Th>{t('table.duration')}</Table.Th>}
            {!compact && <Table.Th>{t('table.by')}</Table.Th>}
            <Table.Th>{t('table.result')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {runs.map((r) => (
            <Table.Tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.id}`)}>
              <Table.Td>
                <StatusBadge status={r.status} />
                {r.dryRun && (
                  <Badge ml={4} size="xs" color="yellow" variant="light">
                    {t('table.dry')}
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="sm" fw={500}>
                  {r.processName}
                </Text>
              </Table.Td>
              <Table.Td className="nowrap">{fmtDate(r.startedAt)}</Table.Td>
              {!compact && <Table.Td className="nowrap">{runDuration(r.startedAt, r.finishedAt)}</Table.Td>}
              {!compact && (
                <Table.Td>
                  {r.actor}
                  {r.trigger === 'schedule' && (
                    <Badge ml={4} size="xs" variant="outline">
                      {t('table.scheduled')}
                    </Badge>
                  )}
                  {r.trigger === 'webhook' && (
                    <Badge ml={4} size="xs" variant="outline" color="teal" title={r.triggerName ?? undefined}>
                      {t('table.webhook')}
                    </Badge>
                  )}
                  {r.trigger === 'monitor' && (
                    <Badge ml={4} size="xs" variant="outline" color="pink" title={r.triggerName ?? undefined}>
                      {t('table.monitor')}
                    </Badge>
                  )}
                  {r.trigger === 'subprocess' && (
                    <Badge ml={4} size="xs" variant="outline" color="violet">
                      {t('table.subprocess')}
                    </Badge>
                  )}
                </Table.Td>
              )}
              <Table.Td>
                <Text size="xs" c={r.stats.checksFailed || r.stats.failedSteps ? 'red' : 'dimmed'}>
                  {[
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
                    (r.error ?? '')}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}
