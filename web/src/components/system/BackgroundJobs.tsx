import { Badge, Button, Card, Code, Group, Table, Text, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { BackgroundJob } from '../../../../shared/src/system';
import { get, notifyError, notifyOk, post } from '../../api';
import { fmtDate, fmtDuration, fmtRelative } from '../../format';
import { QueryState } from '../common';

const RESULT_COLOR = { succeeded: 'green', failed: 'red', timedOut: 'orange' } as const;

function useEvery(): (j: BackgroundJob) => string {
  const { t } = useTranslation('system');
  return (j) => {
    if (j.cron) return j.cron;
    const s = j.everySeconds ?? 0;
    if (s % 3600 === 0) return t('status.jobs.everyHours', { count: s / 3600 });
    if (s % 60 === 0) return t('status.jobs.everyMinutes', { count: s / 60 });
    return t('status.jobs.everySeconds', { count: s });
  };
}

/** System status (administrators): the background jobs, how their last run went, and "Run now". */
export function BackgroundJobs() {
  const { t } = useTranslation('system');
  const every = useEvery();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['system-jobs'],
    queryFn: () => get<{ jobs: BackgroundJob[]; running: boolean }>('/system/jobs'),
    refetchInterval: 15000,
  });
  const runNow = async (name: string) => {
    try {
      await post(`/system/jobs/${encodeURIComponent(name)}/run`);
      notifyOk(t('status.jobs.started', { name }));
      await qc.invalidateQueries({ queryKey: ['system-jobs'] });
    } catch (e) {
      notifyError(e, t('status.jobs.notStarted'));
    }
  };
  const jobs = q.data?.jobs ?? [];
  return (
    <Card withBorder>
      <Title order={5} mb={4}>
        {t('status.jobs.title')}
      </Title>
      <Text size="sm" c="dimmed" mb="xs">
        {t('status.jobs.intro')}
      </Text>
      <QueryState query={q} />
      {q.data && !q.data.running && (
        <Text size="sm" c="orange" mb="xs">
          {t('status.jobs.stopped')}
        </Text>
      )}
      {q.data && !jobs.length && (
        <Text size="sm" c="dimmed">
          {t('status.jobs.none')}
        </Text>
      )}
      {!!jobs.length && (
        <div className="table-scroll">
          <Table fz="sm" verticalSpacing={4} data-testid="background-jobs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('status.jobs.name')}</Table.Th>
                <Table.Th>{t('status.jobs.every')}</Table.Th>
                <Table.Th>{t('status.jobs.lastRun')}</Table.Th>
                <Table.Th>{t('status.jobs.duration')}</Table.Th>
                <Table.Th>{t('status.jobs.result')}</Table.Th>
                <Table.Th>{t('status.jobs.nextRun')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {jobs.map((j) => (
                <Table.Tr key={j.name} data-job={j.name}>
                  <Table.Td>
                    <Code>{j.name}</Code>
                    <Text size="xs" c="dimmed">
                      {t(`status.jobs.names.${j.name}`, { defaultValue: '' })}
                    </Text>
                  </Table.Td>
                  <Table.Td>{every(j)}</Table.Td>
                  <Table.Td>
                    {j.lastStartedAt ? (
                      <span title={fmtDate(j.lastStartedAt)}>
                        {fmtRelative(j.lastStartedAt)}
                        {j.lastTrigger === 'manual' ? ` · ${t('status.jobs.manual')}` : ''}
                      </span>
                    ) : (
                      t('status.never')
                    )}
                  </Table.Td>
                  <Table.Td>{j.lastDurationMs !== null ? fmtDuration(j.lastDurationMs) : '–'}</Table.Td>
                  <Table.Td>
                    {j.running ? (
                      <Badge variant="light" color="blue" size="sm">
                        {t('status.jobs.running')}
                      </Badge>
                    ) : j.lastResult ? (
                      <Tooltip label={j.lastError ?? ''} disabled={!j.lastError} multiline maw={420}>
                        <Badge variant="light" color={RESULT_COLOR[j.lastResult]} size="sm">
                          {t(`status.jobs.results.${j.lastResult}`)}
                        </Badge>
                      </Tooltip>
                    ) : (
                      '–'
                    )}
                    {j.lastError && (
                      <Text size="xs" c="dimmed" lineClamp={2} style={{ wordBreak: 'break-word' }}>
                        {j.lastError}
                      </Text>
                    )}
                    {(j.failures > 0 || j.skipped > 0) && (
                      <Text size="xs" c="dimmed">
                        {t('status.jobs.counts', { runs: j.runs, failures: j.failures, skipped: j.skipped })}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{j.nextRunAt ? <span title={fmtDate(j.nextRunAt)}>{fmtRelative(j.nextRunAt)}</span> : '–'}</Table.Td>
                  <Table.Td>
                    <Group justify="flex-end" wrap="nowrap">
                      <Button
                        size="compact-xs"
                        variant="default"
                        leftSection={<IconPlayerPlay size={12} />}
                        disabled={j.running}
                        onClick={() => void runNow(j.name)}
                        aria-label={t('status.jobs.runNowLabel', { name: j.name })}
                      >
                        {t('status.jobs.runNow')}
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
