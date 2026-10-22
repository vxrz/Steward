import { useState } from 'react';
import { Button, Group, Select } from '@mantine/core';
import { IconReportAnalytics } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ProcessSummary, RunSummary } from '@sm/shared';
import { get } from '../api';
import { PageHeader, statusLabel } from '../components/common';
import { RunTable } from '../components/RunTable';
import { SummaryReportDialog } from '../components/reports/SummaryReportDialog';

export function RunsPage() {
  const { t } = useTranslation('runs');
  const [status, setStatus] = useState<string | null>(null);
  const [processId, setProcessId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const qs = new URLSearchParams({ limit: '200', ...(status ? { status } : {}), ...(processId ? { processId } : {}) });
  const runs = useQuery({ queryKey: ['runs', status, processId], queryFn: () => get<RunSummary[]>(`/runs?${qs}`), refetchInterval: 4000 });
  return (
    <>
      <PageHeader
        title={t('list.title')}
        description={t('list.description')}
        actions={
          <Group gap="xs">
            <Select
              size="xs"
              placeholder={t('list.allProcesses')}
              clearable
              searchable
              data={(processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={processId}
              onChange={setProcessId}
              w={220}
            />
            <Select
              size="xs"
              placeholder={t('list.anyStatus')}
              clearable
              data={['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'].map((s) => ({ value: s, label: statusLabel(s) }))}
              value={status}
              onChange={setStatus}
              w={160}
            />
            <Button size="xs" variant="light" leftSection={<IconReportAnalytics size={14} />} onClick={() => setSummaryOpen(true)}>
              {t('list.summaryReport')}
            </Button>
          </Group>
        }
      />
      <RunTable runs={runs.data ?? []} />
      <SummaryReportDialog opened={summaryOpen} onClose={() => setSummaryOpen(false)} processIds={processId ? [processId] : undefined} />
    </>
  );
}
