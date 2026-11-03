import { useMemo, useState } from 'react';
import { Button, Group, Select, Text } from '@mantine/core';
import { Link, useSearchParams } from 'react-router-dom';
import { IconPlayerPlay, IconReportAnalytics, IconSitemap } from '@tabler/icons-react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ProcessSummary, RunSummary } from '@sm/shared';
import { get } from '../api';
import { QueryState, statusLabel } from '../components/common';
import { ListPage } from '../components/page/ListPage';
import { ListFooter } from '../components/DataTable';
import { RunTable } from '../components/RunTable';
import { SummaryReportDialog } from '../components/reports/SummaryReportDialog';
import { processKeys, runKeys } from '../queryKeys';

/** Runs per request; "Load more" fetches the next, older page (`before` = start of the oldest run shown). */
export const RUNS_PAGE = 200;

const PERIODS = ['24h', '7d'] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_MS: Record<Period, number> = { '24h': 86400000, '7d': 7 * 86400000 };

export function RunsPage() {
  const { t } = useTranslation(['runs', 'common']);
  // ?status=failed (or =findings: completed with findings), ?processId=… and ?within=24h (links from the start page) preset the filters
  const [params] = useSearchParams();
  const [status, setStatus] = useState<string | null>(params.get('status'));
  const [processId, setProcessId] = useState<string | null>(params.get('processId'));
  // ?checks=failed: only runs with a failed check (the start page's "Failed checks")
  const [checks, setChecks] = useState<string | null>(params.get('checks') === 'failed' ? 'failed' : null);
  // ?within=24h (the start page's "Failed runs (24 h)" tile): runs started since then, fixed when chosen
  const [period, setPeriod] = useState<Period | null>(PERIODS.find((p) => p === params.get('within')) ?? null);
  const since = useMemo(() => (period ? new Date(Date.now() - PERIOD_MS[period]).toISOString() : null), [period]);
  // ?limit=50: a smaller page (1–1000)
  const pageSize = Math.min(Math.max(Number(params.get('limit')) || RUNS_PAGE, 1), 1000);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const processes = useQuery({ queryKey: processKeys.all, queryFn: () => get<ProcessSummary[]>('/processes') });
  const runs = useInfiniteQuery({
    queryKey: runKeys.list(status, processId, since, checks, pageSize),
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({
        limit: String(pageSize),
        // "succeeded" (without findings) and "findings" are outcomes: succeeded runs without or with failed checks
        ...(status === 'succeeded' || status === 'findings' ? { outcome: status } : status ? { status } : {}),
        ...(processId ? { processId } : {}),
        ...(since ? { since } : {}),
        ...(checks ? { checks } : {}),
        ...(pageParam ? { before: pageParam } : {}),
      });
      return get<RunSummary[]>(`/runs?${qs}`);
    },
    getNextPageParam: (last) => (last.length >= pageSize ? last[last.length - 1]!.startedAt : undefined),
    refetchInterval: 4000,
  });
  const list = runs.data?.pages.flat() ?? [];
  const filtered = !!(status || processId || period || checks);
  return (
    <ListPage
      title={t('list.title')}
      description={t('list.description')}
      actions={
        <Button size="xs" variant="light" leftSection={<IconReportAnalytics size={14} />} onClick={() => setSummaryOpen(true)}>
          {t('list.summaryReport')}
        </Button>
      }
      activeFilters={[status, processId, period, checks].filter(Boolean).length}
      view="runs"
      filters={
        <Group gap="xs" mb="md" align="flex-end" wrap="wrap">
          <Select
            size="xs"
            label={t('list.process')}
            placeholder={t('list.allProcesses')}
            clearable
            searchable
            data={(processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={processId}
            onChange={setProcessId}
            w={{ base: '100%', xs: 240 }}
          />
          <Select
            size="xs"
            label={t('list.status')}
            placeholder={t('list.anyStatus')}
            clearable
            data={['running', 'waiting', 'succeeded', 'findings', 'failed', 'cancelled', 'interrupted'].map((s) => ({ value: s, label: statusLabel(s) }))}
            value={status}
            onChange={setStatus}
            w={{ base: '100%', xs: 220 }}
          />
          <Select
            size="xs"
            label={t('list.period')}
            placeholder={t('list.anyTime')}
            clearable
            data={PERIODS.map((p) => ({ value: p, label: t(`list.periods.${p}`) }))}
            value={period}
            onChange={(v) => setPeriod(v as Period | null)}
            w={{ base: '100%', xs: 180 }}
          />
          <Select
            size="xs"
            label={t('list.checks')}
            placeholder={t('list.anyChecks')}
            clearable
            data={[{ value: 'failed', label: t('list.failedChecks') }]}
            value={checks}
            onChange={setChecks}
            w={{ base: '100%', xs: 200 }}
          />
        </Group>
      }
      empty={{
        show: runs.isSuccess && list.length === 0 && !filtered,
        icon: IconPlayerPlay,
        title: t('emptyState.title'),
        text: t('emptyState.text'),
        whoCanAct: t('common:whoCanAct.runs'),
        action: (
          <Button component={Link} to="/processes" leftSection={<IconSitemap size={16} />}>
            {t('emptyState.action')}
          </Button>
        ),
      }}
    >
      <QueryState query={runs} />
      {runs.isSuccess && list.length === 0 && filtered && (
        <Text c="dimmed" size="sm">
          {t('emptyState.noMatch')}
        </Text>
      )}
      {list.length > 0 && (
        <RunTable
          runs={list}
          footer={<ListFooter shown={list.length} hasMore={runs.hasNextPage} onLoadMore={() => void runs.fetchNextPage()} loading={runs.isFetchingNextPage} />}
        />
      )}
      <SummaryReportDialog opened={summaryOpen} onClose={() => setSummaryOpen(false)} processIds={processId ? [processId] : undefined} />
    </ListPage>
  );
}
