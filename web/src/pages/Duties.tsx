import { useState } from 'react';
import { Anchor, Group, Paper, Select, Stack, Switch, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconCalendarCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DUTY_LEVELS, type DutySummary } from '@sm/shared';
import { get } from '../api';
import { EmptyState, PageHeader, QueryState, subjectLabel } from '../components/common';
import { DutyLevelBadge, DutyStatusBadge, PeriodLine } from '../components/duties/common';

/** Due (current period not done, or the last one in its grace period) or missed/failed (the last period). */
const needsAttention = (d: DutySummary) =>
  d.current?.status === 'due' ||
  (!!d.previous &&
    (d.previous.status === 'missed' || d.previous.status === 'failed' || d.previous.status === 'ended' || (d.previous.status === 'due' && d.previous.inGrace)));

/** Every duty of every service, with the status of the current and the last period. The start page tile links here. */
export function DutiesPage() {
  const { t } = useTranslation(['duties', 'common']);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [archived, setArchived] = useState(false);
  const level = params.get('level');
  const status = params.get('status');
  const q = useQuery({ queryKey: ['duties', 'all', archived], queryFn: () => get<DutySummary[]>(`/duties${archived ? '?archived=1' : ''}`) });
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const list = (q.data ?? []).filter((d) => (!level || d.level === level) && (status !== 'attention' || needsAttention(d)));
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Group gap="sm" mb="md" align="flex-end" wrap="wrap">
        <Select
          label={t('filters.level')}
          placeholder={t('filters.allLevels')}
          data={DUTY_LEVELS.map((x) => ({ value: x, label: t(`levels.${x}`) }))}
          value={level}
          onChange={(v) => set('level', v)}
          clearable
          w={200}
        />
        <Select
          label={t('filters.status')}
          placeholder={t('filters.allStatuses')}
          data={[{ value: 'attention', label: t('filters.attention') }]}
          value={status}
          onChange={(v) => set('status', v)}
          clearable
          w={220}
        />
        <Switch size="sm" mb={8} label={t('showArchived')} checked={archived} onChange={(e) => setArchived(e.currentTarget.checked)} />
      </Group>
      <QueryState query={q} />
      {q.isSuccess && list.length === 0 && (
        <EmptyState icon={IconCalendarCheck} title={t('emptyList')}>
          {t('emptyListHint')}
        </EmptyState>
      )}
      {list.length > 0 &&
        (narrow ? (
          <Stack gap="xs" role="list" aria-label={t('title')}>
            {list.map((d) => (
              <Paper key={d.id} withBorder p="sm" role="listitem">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={2} style={{ minWidth: 0 }}>
                    <Anchor component={Link} to={`/duties/${d.id}`} fw={600} size="sm">
                      {d.name}
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {d.serviceName} · {t(`intervals.${d.interval}`)}
                    </Text>
                    {d.current && <PeriodLine period={d.current} tz={d.timeZone} />}
                  </Stack>
                  <Stack gap={4} align="flex-end">
                    <DutyStatusBadge period={d.current ?? d.previous} size="xs" />
                    <DutyLevelBadge level={d.level} />
                  </Stack>
                </Group>
              </Paper>
            ))}
          </Stack>
        ) : (
          <div className="table-scroll">
            <Table highlightOnHover fz="sm" aria-label={t('title')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('name')}</Table.Th>
                  <Table.Th>{t('service')}</Table.Th>
                  <Table.Th>{t('level')}</Table.Th>
                  <Table.Th>{t('interval')}</Table.Th>
                  <Table.Th>{t('current')}</Table.Th>
                  <Table.Th>{t('previous')}</Table.Th>
                  <Table.Th>{t('owners')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((d) => (
                  <Table.Tr key={d.id} className="clickable" onClick={() => navigate(`/duties/${d.id}`)} data-inactive={d.archived || undefined}>
                    <Table.Td>
                      <Anchor component={Link} to={`/duties/${d.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                        {d.name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      <Anchor component={Link} to={`/services/${d.serviceId}`} size="sm" onClick={(e) => e.stopPropagation()}>
                        {d.serviceName}
                      </Anchor>
                      {d.applicationName && (
                        <Text size="xs" c="dimmed">
                          {d.applicationName}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <DutyLevelBadge level={d.level} />
                    </Table.Td>
                    <Table.Td>{t(`intervals.${d.interval}`)}</Table.Td>
                    <Table.Td>
                      <DutyStatusBadge period={d.current} size="xs" />
                      {d.current && <PeriodLine period={d.current} tz={d.timeZone} />}
                    </Table.Td>
                    <Table.Td>
                      <DutyStatusBadge period={d.previous} size="xs" />
                      {d.previous && <PeriodLine period={d.previous} tz={d.timeZone} />}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{d.owners.map(subjectLabel).join(', ') || '–'}</Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        ))}
    </>
  );
}
