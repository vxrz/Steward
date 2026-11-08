import { useState } from 'react';
import { Anchor, Badge, Button, FileButton, Group, MultiSelect, Paper, Select, SimpleGrid, Stack, Switch, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconContract, IconFileImport, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DATA_CONTRACT_RESULTS, type DataContractImportResult, type DataContractSummary } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../api';
import { QueryState } from '../components/common';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { DataTable } from '../components/DataTable';
import { dataContractKeys } from '../queryKeys';
import { useMe } from '../auth';
import { fmtDate, fmtRelative } from '../format';
import { OdcsStatusBadge, ResultBadge } from '../components/contracts/parts';

/** Reads a file the person picked (a contract is at most 1 MB of YAML). */
export const readText = (f: File): Promise<string> => f.text();

/** The data contracts of the installation (#221): ODCS v3, with their versions, links and tests. */
export function DataContractsPage() {
  const { t } = useTranslation(['contracts', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { caps } = useMe();
  const canCreate = caps.createProcesses;
  const list = useQuery({ queryKey: dataContractKeys.list, queryFn: () => get<DataContractSummary[]>('/data-contracts') });
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const statuses = params.getAll('status');
  const result = params.get('result');
  const findingsOnly = params.get('findings') === '1';
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const view = useStoredListView('data-contracts', narrow);
  const set = (k: string, v: string | string[] | null) => {
    const next = new URLSearchParams(params);
    next.delete(k);
    for (const x of Array.isArray(v) ? v : v ? [v] : []) next.append(k, x);
    setParams(next, { replace: true });
  };
  const all = list.data ?? [];
  const needle = q.trim().toLowerCase();
  const rows = all.filter(
    (c) =>
      (!needle || [c.name, c.key, c.status, ...c.owningTeams.map((x) => x.name)].some((x) => x.toLowerCase().includes(needle))) &&
      (!statuses.length || statuses.includes(c.status)) &&
      (!result || (result === 'never' ? !c.lastRun : c.lastRun?.result === result)) &&
      (!findingsOnly || c.findingCount > 0),
  );
  const none = list.isSuccess && all.length === 0;
  const active = statuses.length + (result ? 1 : 0) + (findingsOnly ? 1 : 0) + (needle ? 1 : 0);
  const to = (c: DataContractSummary) => `/data-contracts/${encodeURIComponent(c.id)}`;
  const importFile = async (f: File | null) => {
    if (!f) return;
    try {
      const r = await post<DataContractImportResult>('/data-contracts/import', { yaml: await readText(f) });
      void qc.invalidateQueries({ queryKey: dataContractKeys.all });
      notifyOk(t(`import.${r.action}`, { name: r.contract.name }));
      navigate(to(r.contract));
    } catch (e) {
      notifyError(e, t('import.failed'));
    }
  };
  const make = (
    <Button size="xs" leftSection={<IconPlus size={14} />} component={Link} to="/data-contracts/new">
      {t('list.new')}
    </Button>
  );
  const importButton = (size: 'xs' | 'sm') => (
    <FileButton onChange={(f) => void importFile(f)} accept=".yaml,.yml,application/yaml,text/yaml">
      {(props) => (
        <Button size={size} variant="default" leftSection={<IconFileImport size={14} />} {...props} data-testid="contract-import">
          {t('list.import')}
        </Button>
      )}
    </FileButton>
  );
  const statusOptions = [...new Set(all.map((c) => c.status).filter(Boolean))].sort();
  return (
    <ListPage
      area="dataContracts"
      testId="data-contracts"
      title={t('list.title')}
      description={t('list.description')}
      primaryAction={canCreate && make}
      actions={canCreate && !none && importButton('xs')}
      search={none ? undefined : { value: q, onChange: setQ, placeholder: t('list.search') }}
      activeFilters={active}
      filters={
        none ? undefined : (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="contract-filters">
            <MultiSelect
              size="xs"
              label={t('list.status')}
              data={statusOptions.map((s) => ({ value: s, label: t(`odcsStatus.${s}`, { defaultValue: s }) }))}
              value={statuses}
              onChange={(v) => set('status', v)}
              clearable
              w={{ base: '100%', xs: 220 }}
            />
            <Select
              size="xs"
              label={t('list.lastTest')}
              data={[...DATA_CONTRACT_RESULTS, 'never' as const].map((r) => ({ value: r, label: t(`results.${r}`) }))}
              value={result}
              onChange={(v) => set('result', v)}
              clearable
              w={{ base: '100%', xs: 180 }}
            />
            <Switch
              size="sm"
              label={t('list.withFindings')}
              checked={findingsOnly}
              onChange={(e) => set('findings', e.currentTarget.checked ? '1' : null)}
              mb={6}
            />
          </Group>
        )
      }
      view={none ? undefined : 'data-contracts'}
      viewState={view}
      empty={{
        show: none,
        icon: IconContract,
        title: t('list.emptyTitle'),
        text: t('list.emptyText'),
        whoCanAct: canCreate ? undefined : t('list.whoCanAct'),
        action: canCreate && (
          <>
            <Button leftSection={<IconPlus size={16} />} component={Link} to="/data-contracts/new">
              {t('list.new')}
            </Button>
            {importButton('sm')}
          </>
        ),
      }}
    >
      <QueryState query={list} />
      {!none && list.isSuccess && rows.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('list.noMatch')}
        </Text>
      )}
      {rows.length > 0 && view.cards && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} data-testid="contract-cards">
          {rows.map((c) => (
            <Paper key={c.id} withBorder p="md" component="article" aria-labelledby={`contract-${c.id}`}>
              <Stack gap={6}>
                <Anchor id={`contract-${c.id}`} component={Link} to={to(c)} fw={600} style={{ overflowWrap: 'anywhere' }}>
                  {c.name}
                </Anchor>
                <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {c.key} · {c.version || '–'} · v{c.currentVersion}
                </Text>
                <Group gap={6}>
                  <OdcsStatusBadge status={c.status} />
                  <ResultBadge result={c.lastRun?.result} size="sm" />
                  {c.findingCount > 0 && (
                    <Badge color="orange" variant="light" size="sm">
                      {t('list.findingCount', { count: c.findingCount })}
                    </Badge>
                  )}
                </Group>
                <Text size="sm" c="dimmed">
                  {c.lastRun ? t('list.testedAgo', { when: fmtRelative(c.lastRun.startedAt) }) : t('list.notTested')}
                </Text>
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {rows.length > 0 && !view.cards && (
        <DataTable
          testId="contract-table"
          ariaLabel={t('list.title')}
          rows={rows}
          rowKey={(c) => c.id}
          rowHref={to}
          columns={[
            {
              key: 'name',
              header: t('list.name'),
              sortValue: (c) => c.name,
              cell: (c) => (
                <>
                  <Anchor component={Link} to={to(c)} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                    {c.name}
                  </Anchor>
                  <Text size="xs" c="dimmed" className="mono">
                    {c.key}
                  </Text>
                </>
              ),
            },
            { key: 'status', header: t('list.status'), sortValue: (c) => c.status, nowrap: true, cell: (c) => <OdcsStatusBadge status={c.status} /> },
            { key: 'version', header: t('list.version'), sortValue: (c) => c.version, nowrap: true, cell: (c) => `${c.version || '–'} · v${c.currentVersion}` },
            {
              key: 'lastTest',
              header: t('list.lastTest'),
              sortValue: (c) => c.lastRun?.startedAt ?? '',
              nowrap: true,
              cell: (c) => (
                <Group gap={6} wrap="nowrap">
                  <ResultBadge result={c.lastRun?.result} size="xs" />
                  {c.lastRun && (
                    <Text size="xs" c="dimmed" title={fmtDate(c.lastRun.startedAt)}>
                      {fmtRelative(c.lastRun.startedAt)}
                    </Text>
                  )}
                </Group>
              ),
            },
            {
              key: 'findings',
              header: t('list.findings'),
              sortValue: (c) => c.findingCount,
              nowrap: true,
              cell: (c) =>
                c.findingCount ? (
                  <Badge color="orange" variant="light" size="sm">
                    {c.findingCount}
                  </Badge>
                ) : (
                  '–'
                ),
            },
            {
              key: 'teams',
              header: t('list.teams'),
              sortValue: (c) => c.owningTeams.map((x) => x.name).join(', '),
              cell: (c) => c.owningTeams.map((x) => x.name).join(', ') || t('list.instance'),
            },
            { key: 'updated', header: t('list.updated'), sortValue: (c) => c.updatedAt, nowrap: true, cell: (c) => fmtRelative(c.updatedAt) },
          ]}
        />
      )}
    </ListPage>
  );
}
