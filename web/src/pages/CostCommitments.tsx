import { useMemo, useState } from 'react';
import { Button, Group, NumberInput, Paper, SegmentedControl, Select, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconArrowLeft, IconCalendarDollar, IconDownload } from '@tabler/icons-react';
import type { CostCommitment, CostCommitments, CostOverview, ServiceSummary } from '@sm/shared';
import { apiUrl, get } from '../api';
import { QueryState } from '../components/common';
import { ListPage } from '../components/page/ListPage';
import { ServiceTabs } from '../components/page/LinkTabs';
import { CommitmentsNote, CommitmentsTable, CommitmentTotals } from '../components/costs/Commitments';
import { useSupplierOptions } from '../components/suppliers/SupplierPicker';
import { costKeys } from '../queryKeys';
import '../components/dashboard/viz.css';

type Group = 'supplier' | 'service' | 'team';

/**
 * Costs → Commitments (0.18.0, ADR 0030, docs/COSTS.md#commitments): every payment schedule of the services the reader
 * may see – grouped by supplier, service or team, columns for the current and the next four fiscal years and later,
 * totals per currency, the notice warnings first; filters team, service, supplier and "ending within … days"; CSV.
 */
export function CostCommitmentsPage() {
  const { t } = useTranslation('costs');
  const [team, setTeam] = useState<string | null>(null);
  const [service, setService] = useState<string | null>(null);
  const [supplier, setSupplier] = useState<string | null>(null);
  const [days, setDays] = useState<string | number>('');
  const [group, setGroup] = useState<Group>('supplier');
  const [search, setSearch] = useState('');
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (team) p.set('teamId', team);
    if (service) p.set('serviceId', service);
    if (supplier) p.set('supplierId', supplier);
    if (days !== '' && Number(days) > 0) p.set('endingWithinDays', String(days));
    return p.toString();
  }, [team, service, supplier, days]);
  const q = useQuery({ queryKey: costKeys.commitments(qs), queryFn: () => get<CostCommitments>(`/costs/commitments${qs ? `?${qs}` : ''}`) });
  const teams = useQuery({ queryKey: costKeys.overview('team'), queryFn: () => get<CostOverview>('/costs?scope=team') });
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const suppliers = useSupplierOptions();
  const c = q.data;
  const needle = search.trim().toLowerCase();
  const rows = (c?.rows ?? []).filter(
    (r) => !needle || [r.title, r.serviceName, r.supplier?.name ?? '', r.contract?.title ?? ''].some((x) => x.toLowerCase().includes(needle)),
  );
  const groups = useMemo(() => {
    const out = new Map<string, { label: string; rows: CostCommitment[] }>();
    const keys = (r: CostCommitment): { key: string; label: string }[] =>
      group === 'supplier'
        ? [{ key: r.supplier?.id ?? '', label: r.supplier?.name ?? t('commitments.hiddenSupplier') }]
        : group === 'service'
          ? [{ key: r.serviceId, label: r.serviceName }]
          : r.teams.length
            ? r.teams.map((x) => ({ key: x.id, label: x.name }))
            : [{ key: '', label: t('commitments.noTeam') }];
    for (const r of rows)
      for (const k of keys(r)) {
        const g = out.get(k.key) ?? { label: k.label, rows: [] };
        g.rows.push(r);
        out.set(k.key, g);
      }
    return [...out.entries()].sort(
      ([, a], [, b]) => Number(b.rows.some((r) => r.warning)) - Number(a.rows.some((r) => r.warning)) || a.label.localeCompare(b.label),
    );
  }, [rows, group, t]);
  const active = [team, service, supplier, days !== '' ? days : null].filter((x) => x !== null).length;
  return (
    <ListPage
      tabs={<ServiceTabs active="/costs" />}
      testId="commitments-page"
      title={t('commitments.title')}
      description={t('commitments.description')}
      actions={
        <Group gap="xs">
          <Button size="xs" variant="subtle" component={Link} to="/costs" leftSection={<IconArrowLeft size={14} />}>
            {t('commitments.back')}
          </Button>
          <Button
            size="xs"
            variant="default"
            component="a"
            href={apiUrl(`/costs/commitments/export${qs ? `?${qs}` : ''}`)}
            leftSection={<IconDownload size={14} />}
          >
            {t('commitments.export')}
          </Button>
        </Group>
      }
      search={{ value: search, onChange: setSearch, label: t('commitments.search') }}
      activeFilters={active}
      filters={
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Select
            label={t('commitments.filters.team')}
            clearable
            searchable
            w={200}
            data={(teams.data?.rows ?? []).filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i).map((r) => ({ value: r.id, label: r.name }))}
            value={team}
            onChange={setTeam}
          />
          <Select
            label={t('commitments.filters.service')}
            clearable
            searchable
            w={220}
            data={(services.data ?? []).filter((x) => !x.archived).map((x) => ({ value: x.id, label: x.name }))}
            value={service}
            onChange={setService}
          />
          <Select
            label={t('commitments.filters.supplier')}
            clearable
            searchable
            w={220}
            data={(suppliers.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
            value={supplier}
            onChange={setSupplier}
          />
          <NumberInput label={t('commitments.filters.ending')} min={1} max={3650} w={170} value={days} onChange={setDays} />
        </Group>
      }
    >
      <Stack gap="md">
        <CommitmentsNote />
        <QueryState query={q} />
        {c && (
          <>
            <Group justify="space-between" wrap="wrap" gap="xs">
              <SegmentedControl
                size="xs"
                aria-label={t('commitments.groupBy')}
                value={group}
                onChange={(v) => setGroup(v as Group)}
                data={[
                  { value: 'supplier', label: t('commitments.groups.supplier') },
                  { value: 'service', label: t('commitments.groups.service') },
                  { value: 'team', label: t('commitments.groups.team') },
                ]}
                data-testid="commitments-group"
              />
              {c.warnings > 0 && (
                <Text size="sm" c="orange" data-testid="commitments-warnings">
                  {t('commitments.warnings', { count: c.warnings })}
                </Text>
              )}
            </Group>
            <CommitmentTotals c={c} />
            {rows.length === 0 ? (
              <Paper withBorder p="lg">
                <Group gap="xs">
                  <IconCalendarDollar size={18} aria-hidden />
                  <Text size="sm" c="dimmed">
                    {t('commitments.empty')}
                  </Text>
                </Group>
              </Paper>
            ) : (
              groups.map(([k, g]) => (
                <Paper key={k || 'none'} withBorder p="sm" data-testid="commitment-group">
                  <Text fw={600} size="sm" mb={4}>
                    {g.label}
                  </Text>
                  <CommitmentsTable c={{ ...c, rows: g.rows }} withService={group !== 'service'} />
                </Paper>
              ))
            )}
          </>
        )}
      </Stack>
    </ListPage>
  );
}
