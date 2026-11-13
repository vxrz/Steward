import { useState } from 'react';
import { Anchor, Badge, Button, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconBuildingFactory2, IconDownload, IconFileImport, IconPlus, IconSettings } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ASSET_STATUSES, type PlantSiteSummary } from '@sm/shared';
import { apiUrl, get } from '../api';
import { QueryState, useCreateParam } from '../components/common';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { fmtDate, fmtRelative } from '../format';
import { useListParams } from '../components/page/params';
import { DataTable, type DataColumn } from '../components/DataTable';
import { plantKeys } from '../queryKeys';
import { AssetStatusBadge, MapLink, NotInSourceBadge, PreviewBadge, useNameOf, usePlantConfig, usePlantLabel } from '../components/plant/common';
import { BulkBar, SelectAllBox, SelectBox, useSelection } from '../components/plant/bulk';
import { SiteFormModal } from '../components/plant/forms';
import { SiteTileStats } from './plant/views/SiteTiles';
import { useMe } from '../auth';

/** The sites of the enterprise (#218): the plant registry's start page. */
export function PlantSitesPage() {
  const { t } = useTranslation(['plant', 'common', 'plantViews', 'plantIds']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cfg = usePlantConfig();
  const { caps } = useMe();
  const sites = useQuery({ queryKey: plantKeys.sites, queryFn: () => get<PlantSiteSummary[]>('/plant/sites') });
  // the search lives in the address (?q=), like the other plant lists
  const { params, set } = useListParams();
  const q = params.get('q') ?? '';
  const [creating, setCreating] = useState(false);
  const canCreate = cfg.data?.canCreateSites;
  useCreateParam(canCreate, () => setCreating(true));
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const view = useStoredListView('plant-sites', narrow);
  const needle = q.trim().toLowerCase();
  const list = (sites.data ?? []).filter((s) => !needle || [s.id, s.code, s.name, nameOf(s), s.description].some((x) => x.toLowerCase().includes(needle)));
  const plural = label('site', true);
  const statuses = (s: PlantSiteSummary) => (
    <Group gap={4}>
      {ASSET_STATUSES.filter((x) => s.statusCounts[x]).map((x) => (
        <Group key={x} gap={2} wrap="nowrap">
          <AssetStatusBadge status={x} size="xs" />
          <Text size="xs">{s.statusCounts[x]}</Text>
        </Group>
      ))}
    </Group>
  );
  const exportLink = (
    <Button
      size="xs"
      variant="default"
      component="a"
      href={apiUrl('/plant/export')}
      download
      leftSection={<IconDownload size={14} />}
      data-testid="plant-export"
    >
      {t('export.all')}
    </Button>
  );
  // Edit selected / Remove selected (0.11.0)
  // 0.13.0: who may propose selects too – the change goes into their draft
  const canBulk = !!cfg.data?.canManageSome || !!cfg.data?.changeSets?.canPropose;
  const shownIds = list.map((s) => s.id);
  const sel = useSelection(shownIds);
  const stop = () => ({ onClick: (e: { stopPropagation: () => void }) => e.stopPropagation() });
  const columns: DataColumn<PlantSiteSummary>[] = [
    ...(canBulk
      ? [
          {
            key: 'select',
            header: <SelectAllBox sel={sel} ids={shownIds} />,
            label: t('plantIds:bulk.selectAll'),
            tdProps: stop,
            cell: (s: PlantSiteSummary) => <SelectBox sel={sel} id={s.id} name={nameOf(s)} />,
          },
        ]
      : []),
    {
      key: 'name',
      header: t('form.name'),
      sortValue: (s) => nameOf(s),
      cell: (s) => (
        <>
          <Group gap="xs" wrap="nowrap">
            <Anchor component={Link} to={`/plant/sites/${encodeURIComponent(s.id)}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
              {nameOf(s)}
            </Anchor>
            {s.code && (
              <Badge variant="default" size="xs">
                {s.code}
              </Badge>
            )}
            {s.notInSource && <NotInSourceBadge size="xs" />}
          </Group>
          {s.description && (
            <Text size="xs" c="dimmed" lineClamp={1}>
              {s.description}
            </Text>
          )}
        </>
      ),
    },
    { key: 'areas', header: label('area', true), sortValue: (s) => s.areaCount, cell: (s) => s.areaCount },
    { key: 'buildings', header: label('building', true), sortValue: (s) => s.buildingCount, cell: (s) => s.buildingCount },
    {
      key: 'assets',
      header: label('asset', true),
      sortValue: (s) => s.assetCount,
      cell: (s) => (
        <Stack gap={2}>
          <Text size="sm">{s.assetCount}</Text>
          {statuses(s)}
        </Stack>
      ),
    },
    {
      key: 'tiles',
      header: t('plantViews:tiles.title'),
      tdProps: () => ({ ...stop(), miw: 220 }),
      cell: (s) => <SiteTileStats siteId={s.id} compact />,
    },
    { key: 'map', header: t('sites.map'), tdProps: stop, cell: (s) => <MapLink geo={s.geo} name={nameOf(s)} /> },
    {
      key: 'updated',
      header: t('updated'),
      sortValue: (s) => s.updatedAt,
      nowrap: true,
      tdProps: (s) => ({ title: fmtDate(s.updatedAt) }),
      cell: (s) => fmtRelative(s.updatedAt),
    },
  ];
  return (
    <ListPage
      testId="plant-sites"
      title={
        <Group gap="sm" component="span">
          <span>{plural}</span>
          <PreviewBadge />
        </Group>
      }
      description={cfg.data?.enterprise ? t('sites.descriptionOf', { enterprise: cfg.data.enterprise }) : t('sites.description')}
      primaryAction={
        canCreate && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            {t('sites.new', { type: label('site', false, true) })}
          </Button>
        )
      }
      actions={
        <>
          {cfg.data?.canManageSome && (
            <Button size="xs" variant="default" component={Link} to="/plant/import" leftSection={<IconFileImport size={14} />}>
              {t('import.button')}
            </Button>
          )}
          {!!sites.data?.length && exportLink}
          {/* a granted manager changes the registry's content settings (0.23.0); administrators do it in Settings → Modules */}
          {caps.moduleSettings?.includes('plant') && !caps.manageSettings && (
            <Button size="xs" variant="default" component={Link} to="/plant/settings" leftSection={<IconSettings size={14} />} data-testid="plant-manager-settings">
              {t('settings.managerTitle')}
            </Button>
          )}
        </>
      }
      search={sites.data?.length ? { value: q, onChange: (v) => set('q', v), placeholder: t('sites.search') } : undefined}
      view={sites.data?.length ? 'plant-sites' : undefined}
      viewState={view}
      empty={{
        show: sites.isSuccess && sites.data.length === 0,
        icon: IconBuildingFactory2,
        title: t('sites.emptyTitle', { type: label('site', true, true) }),
        text: t('sites.emptyText'),
        whoCanAct: !canCreate ? t('common:whoCanAct.plantSites') : undefined,
        action: canCreate && (
          <>
            <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
              {t('sites.new', { type: label('site', false, true) })}
            </Button>
            <Button variant="default" component={Link} to="/plant/import" leftSection={<IconFileImport size={16} />}>
              {t('import.button')}
            </Button>
          </>
        ),
      }}
    >
      <QueryState query={sites} />
      {sites.isSuccess && sites.data.length > 0 && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('sites.noMatch')}
        </Text>
      )}
      {canBulk && list.length > 0 && (
        <BulkBar kind="site" sel={sel} visible={shownIds} selectAll={view.cards} entries={list.map((x) => ({ id: x.id, name: nameOf(x) }))} />
      )}
      {list.length > 0 && view.cards && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} data-testid="plant-site-cards">
          {list.map((s) => (
            <Paper key={s.id} withBorder p="md" component="article" aria-labelledby={`site-${s.id}`}>
              <Stack gap={6}>
                <Group gap="xs" justify="space-between" wrap="nowrap">
                  {canBulk && <SelectBox sel={sel} id={s.id} name={nameOf(s)} />}
                  <Anchor id={`site-${s.id}`} component={Link} to={`/plant/sites/${encodeURIComponent(s.id)}`} fw={600} style={{ overflowWrap: 'anywhere' }}>
                    {nameOf(s)}
                  </Anchor>
                  {s.code && (
                    <Badge variant="default" size="sm">
                      {s.code}
                    </Badge>
                  )}
                </Group>
                {s.notInSource && <NotInSourceBadge size="xs" />}
                {s.description && (
                  <Text size="sm" c="dimmed" lineClamp={2}>
                    {s.description}
                  </Text>
                )}
                <Text size="sm">{t('sites.counts', { areas: s.areaCount, buildings: s.buildingCount, assets: s.assetCount })}</Text>
                {statuses(s)}
                <SiteTileStats siteId={s.id} />
                <MapLink geo={s.geo} name={nameOf(s)} />
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {list.length > 0 && !view.cards && (
        <DataTable
          rows={list}
          columns={columns}
          rowKey={(s) => s.id}
          ariaLabel={plural}
          rowHref={(s) => `/plant/sites/${encodeURIComponent(s.id)}`}
          testId="plant-site-table"
          rememberSort="plant-sites"
          defaultSort={{ key: 'name', dir: 'asc' }}
        />
      )}
      {creating && (
        <SiteFormModal
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            void qc.invalidateQueries({ queryKey: plantKeys.all });
            navigate(`/plant/sites/${encodeURIComponent(s.id)}`);
          }}
        />
      )}
    </ListPage>
  );
}
