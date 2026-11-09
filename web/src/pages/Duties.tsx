import { Anchor, Group, Paper, Select, Stack, Switch, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { IconCalendarCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DUTY_INTERVALS, DUTY_LEVELS, type DutyPeriodStatus, type DutySummary } from '@sm/shared';
import { get } from '../api';
import { EmptyState, PageHeader, QueryState, subjectLabel } from '../components/common';
import { DutyLevelBadge, DutyStatusBadge, PeriodLine } from '../components/duties/common';
import { RestrictedEmpty, useHiddenByPermissions } from '../components/modules/RestrictedEmpty';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';

/** Sort order of a period's status: not met first, then what is due, then what is done. */
const PERIOD_ORDER: DutyPeriodStatus[] = ['failed', 'missed', 'ended', 'due', 'late', 'skipped', 'done', 'inactive'];

/** Due (current period not done, or the last one in its grace period) or missed/failed (the last period). */
const needsAttention = (d: DutySummary) =>
  d.current?.status === 'due' ||
  (!!d.previous &&
    (d.previous.status === 'missed' || d.previous.status === 'failed' || d.previous.status === 'ended' || (d.previous.status === 'due' && d.previous.inGrace)));

/** Every duty of every service, with the status of the current and the last period. The start page tile links here. */
export function DutiesPage() {
  const { t } = useTranslation(['duties', 'common']);
  const [params, setParams] = useSearchParams();
  const archived = params.get('archived') === '1';
  const level = params.get('level');
  const status = params.get('status');
  const q = useQuery({ queryKey: ['duties', 'all', archived], queryFn: () => get<DutySummary[]>(`/duties${archived ? '?archived=1' : ''}`) });
  // entries the person may not see (U3): "nothing you may see" instead of "nothing yet"
  const hidden = useHiddenByPermissions('duties');
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const list = (q.data ?? []).filter((d) => (!level || d.level === level) && (status !== 'attention' || needsAttention(d)));
  const columns: DataColumn<DutySummary>[] = [
    {
      key: 'name',
      header: t('name'),
      sortValue: (d) => d.name,
      cell: (d) => (
        <Anchor component={Link} to={`/duties/${d.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
          {d.name}
        </Anchor>
      ),
    },
    {
      key: 'service',
      header: t('service'),
      sortValue: (d) => d.serviceName,
      cell: (d) => (
        <>
          <Anchor component={Link} to={`/services/${d.serviceId}`} size="sm" onClick={(e) => e.stopPropagation()}>
            {d.serviceName}
          </Anchor>
          {d.applicationName && (
            <Text size="xs" c="dimmed">
              {d.applicationName}
            </Text>
          )}
        </>
      ),
    },
    { key: 'level', header: t('level'), sortValue: (d) => DUTY_LEVELS.indexOf(d.level), cell: (d) => <DutyLevelBadge level={d.level} /> },
    { key: 'interval', header: t('interval'), sortValue: (d) => DUTY_INTERVALS.indexOf(d.interval), cell: (d) => t(`intervals.${d.interval}`) },
    {
      key: 'current',
      header: t('current'),
      sortValue: (d) => (d.current ? PERIOD_ORDER.indexOf(d.current.status) : null),
      cell: (d) => (
        <>
          <DutyStatusBadge period={d.current} size="xs" />
          {d.current && <PeriodLine period={d.current} tz={d.timeZone} />}
        </>
      ),
    },
    {
      key: 'previous',
      header: t('previous'),
      sortValue: (d) => (d.previous ? PERIOD_ORDER.indexOf(d.previous.status) : null),
      cell: (d) => (
        <>
          <DutyStatusBadge period={d.previous} size="xs" />
          {d.previous && <PeriodLine period={d.previous} tz={d.timeZone} />}
        </>
      ),
    },
    {
      key: 'owners',
      header: t('owners'),
      sortValue: (d) => d.owners.map(subjectLabel).join(', '),
      cell: (d) => <Text size="xs">{d.owners.map(subjectLabel).join(', ') || '–'}</Text>,
    },
  ];
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
        <Switch size="sm" mb={8} label={t('showArchived')} checked={archived} onChange={(e) => set('archived', e.currentTarget.checked ? '1' : null)} />
      </Group>
      <QueryState query={q} />
      {q.isSuccess && list.length === 0 && hidden && <RestrictedEmpty />}
      {q.isSuccess && list.length === 0 && !hidden && (
        <EmptyState icon={IconCalendarCheck} title={t('emptyList')}>
          {t('emptyListHint')}
        </EmptyState>
      )}
      {list.length > 0 && (
        <DataTable
          rows={list}
          columns={columns}
          rowKey={(d) => d.id}
          ariaLabel={t('title')}
          rowHref={(d) => `/duties/${d.id}`}
          rowProps={(d) => ({ 'data-inactive': d.archived || undefined })}
          testId="duty-list"
          rememberSort="duties"
          defaultSort={{ key: 'name', dir: 'asc' }}
          footer={<ListFooter shown={list.length} total={q.data?.length} />}
          card={(d) => (
            <Paper withBorder p="sm">
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
          )}
        />
      )}
    </>
  );
}
