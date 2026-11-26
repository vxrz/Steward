import { useState } from 'react';
import { Anchor, Button, Group, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconListCheck, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantBlueprintDetail, PlantBlueprintSummary } from '@sm/shared';
import { get, post } from '../api';
import { QueryState, useCreateParam } from '../components/common';
import { ListPage } from '../components/page/ListPage';
import { plantKeys } from '../queryKeys';
import { NotInSourceBadge, PreviewBadge, usePlantConfig } from '../components/plant/common';
import { BlueprintFormModal } from '../components/plant/blueprints';
import { DataTable, type DataColumn } from '../components/DataTable';

/** The machine blueprints of the installation (0.30.0, ADR 0041): what one kind of machine should deliver. */
export function PlantBlueprintsPage() {
  const { t } = useTranslation(['plantBlueprints', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cfg = usePlantConfig();
  const list = useQuery({ queryKey: plantKeys.blueprints, queryFn: () => get<PlantBlueprintSummary[]>('/plant/blueprints') });
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [creating, setCreating] = useState(false);
  const canManage = cfg.data?.canManageCatalogue;
  useCreateParam(canManage, () => setCreating(true));
  const all = list.data ?? [];
  const needle = q.trim().toLowerCase();
  const rows = all.filter((b) => !needle || [b.id, b.name, b.reference].some((x) => x.toLowerCase().includes(needle)));
  const none = list.isSuccess && all.length === 0;
  const to = (b: PlantBlueprintSummary) => `/plant/blueprints/${encodeURIComponent(b.id)}`;
  const columns: DataColumn<PlantBlueprintSummary>[] = [
    {
      key: 'name',
      header: t('list.name'),
      sortValue: (b) => b.name,
      cell: (b) => (
        <>
          <Anchor component={Link} to={to(b)} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
            {b.name}
          </Anchor>
          <Group gap={4}>
            <Text size="xs" c="dimmed" className="mono">
              {b.id}
            </Text>
            {b.notInSource && <NotInSourceBadge size="xs" />}
          </Group>
        </>
      ),
    },
    {
      key: 'reference',
      header: t('list.reference'),
      sortValue: (b) => b.reference,
      cell: (b) => (
        <>
          {b.reference || '–'}
          {b.version && (
            <Text size="xs" c="dimmed">
              {t('page.versionIs', { version: b.version })}
            </Text>
          )}
        </>
      ),
    },
    {
      key: 'signals',
      header: t('list.signals'),
      sortValue: (b) => b.signalCount,
      cell: (b) => (
        <>
          {b.signalCount}
          {b.byImportance.must > 0 && (
            <Text size="xs" c="dimmed">
              {t('list.must', { count: b.byImportance.must })}
            </Text>
          )}
        </>
      ),
    },
    { key: 'profiles', header: t('list.profiles'), sortValue: (b) => b.profileCount, cell: (b) => b.profileCount },
    { key: 'assets', header: t('list.assets'), sortValue: (b) => b.assetCount, cell: (b) => b.assetCount },
  ];
  const make = (
    <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="blueprint-new">
      {t('list.new')}
    </Button>
  );
  return (
    <ListPage
      testId="plant-blueprints"
      title={
        <Group gap="sm" component="span">
          <span>{t('list.title')}</span>
          <PreviewBadge />
        </Group>
      }
      description={t('list.description')}
      primaryAction={canManage && make}
      search={
        none
          ? undefined
          : {
              value: q,
              onChange: (v) => {
                const next = new URLSearchParams(params);
                if (v) next.set('q', v);
                else next.delete('q');
                setParams(next, { replace: true });
              },
              placeholder: t('list.search'),
            }
      }
      activeFilters={needle ? 1 : 0}
      empty={{
        show: none,
        icon: IconListCheck,
        title: t('list.emptyTitle'),
        text: t('list.emptyText'),
        whoCanAct: canManage ? undefined : t('list.whoCanAct'),
        action: canManage && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            {t('list.new')}
          </Button>
        ),
      }}
    >
      <QueryState query={list} />
      {!none && list.isSuccess && rows.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('list.noMatch')}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(b) => b.id}
          ariaLabel={t('list.title')}
          rowHref={to}
          testId="plant-blueprint-table"
          rememberSort="plant-blueprints"
          defaultSort={{ key: 'name', dir: 'asc' }}
        />
      )}
      {creating && (
        <BlueprintFormModal
          onClose={() => setCreating(false)}
          onSave={async (v) => {
            const made = await post<PlantBlueprintDetail>('/plant/blueprints', { ...v, signals: [] });
            void qc.invalidateQueries({ queryKey: plantKeys.all });
            navigate(`/plant/blueprints/${encodeURIComponent(made.id)}`);
          }}
        />
      )}
    </ListPage>
  );
}
