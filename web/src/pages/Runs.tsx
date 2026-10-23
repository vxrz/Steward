import { useState } from 'react';
import { Button, Group, Select, Text } from '@mantine/core';
import { Link, useSearchParams } from 'react-router-dom';
import { IconPlayerPlay, IconReportAnalytics, IconSitemap } from '@tabler/icons-react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ProcessSummary, RunSummary } from '@sm/shared';
import { get } from '../api';
import { EmptyState, FilterPanel, PageHeader, QueryState, statusLabel } from '../components/common';
import { ListFooter } from '../components/DataTable';
import { RunTable } from '../components/RunTable';
import { SummaryReportDialog } from '../components/reports/SummaryReportDialog';

/** Runs per request; "Load more" fetches the next, older page (`before` = start of the oldest run shown). */
export const RUNS_PAGE = 200;

export function RunsPage() {
  const { t } = useTranslation('runs');
  // ?status=failed and ?processId=… (links from the start page) preset the filters
  const [params] = useSearchParams();
  const [status, setStatus] = useState<string | null>(params.get('status'));
  const [processId, setProcessId] = useState<string | null>(params.get('processId'));
  // ?limit=50: a smaller page (1–1000)
  const pageSize = Math.min(Math.max(Number(params.get('limit')) || RUNS_PAGE, 1), 1000);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const runs = useInfiniteQuery({
    queryKey: ['runs', status, processId, pageSize],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({
        limit: String(pageSize),
        ...(status ? { status } : {}),
        ...(processId ? { processId } : {}),
        ...(pageParam ? { before: pageParam } : {}),
      });
      return get<RunSummary[]>(`/runs?${qs}`);
    },
    getNextPageParam: (last) => (last.length >= pageSize ? last[last.length - 1]!.startedAt : undefined),
    refetchInterval: 4000,
  });
  const list = runs.data?.pages.flat() ?? [];
  return (
    <>
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={
          <Button size="xs" variant="light" leftSection={<IconReportAnalytics size={14} />} onClick={() => setSummaryOpen(true)}>
            {t('list.summaryReport')}
          </Button>
        }
      />
      <FilterPanel active={[status, processId].filter(Boolean).length}>
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
            data={['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'].map((s) => ({ value: s, label: statusLabel(s) }))}
            value={status}
            onChange={setStatus}
            w={{ base: '100%', xs: 180 }}
          />
        </Group>
      </FilterPanel>
      <QueryState query={runs} />
      {runs.isSuccess &&
        list.length === 0 &&
        (status || processId ? (
          <Text c="dimmed" size="sm">
            {t('emptyState.noMatch')}
          </Text>
        ) : (
          <EmptyState
            icon={IconPlayerPlay}
            title={t('emptyState.title')}
            action={
              <Button component={Link} to="/processes" leftSection={<IconSitemap size={16} />}>
                {t('emptyState.action')}
              </Button>
            }
          >
            {t('emptyState.text')}
          </EmptyState>
        ))}
      {list.length > 0 && (
        <RunTable
          runs={list}
          footer={<ListFooter shown={list.length} hasMore={runs.hasNextPage} onLoadMore={() => void runs.fetchNextPage()} loading={runs.isFetchingNextPage} />}
        />
      )}
      <SummaryReportDialog opened={summaryOpen} onClose={() => setSummaryOpen(false)} processIds={processId ? [processId] : undefined} />
    </>
  );
}
