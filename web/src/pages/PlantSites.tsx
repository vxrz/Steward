import { useState } from 'react';
import { Anchor, Badge, Button, Group, Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconBuildingFactory2, IconDownload, IconFileImport, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ASSET_STATUSES, type PlantSiteSummary } from '@sm/shared';
import { apiUrl, get } from '../api';
import { QueryState, useCreateParam } from '../components/common';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { fmtRelative } from '../format';
import { plantKeys } from '../queryKeys';
import { AssetStatusBadge, MapLink, NotInSourceBadge, PreviewBadge, useNameOf, usePlantConfig, usePlantLabel } from '../components/plant/common';
import { BulkBar, SelectAllBox, SelectBox, useSelection } from '../components/plant/bulk';
import { SiteFormModal } from '../components/plant/forms';
import { SiteTileStats } from './plant/views/SiteTiles';

/** The sites of the enterprise (#218): the plant registry's start page. */
export function PlantSitesPage() {
  const { t } = useTranslation(['plant', 'common', 'plantViews']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cfg = usePlantConfig();
  const sites = useQuery({ queryKey: plantKeys.sites, queryFn: () => get<PlantSiteSummary[]>('/plant/sites') });
  const [q, setQ] = useState('');
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
  const canBulk = !!cfg.data?.canManageSome;
  const shownIds = list.map((s) => s.id);
  const sel = useSelection(shownIds);
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
        </>
      }
      search={sites.data?.length ? { value: q, onChange: setQ, placeholder: t('sites.search') } : undefined}
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
        <div className="table-scroll">
          <Table highlightOnHover fz="sm" aria-label={plural} data-testid="plant-site-table">
            <Table.Thead>
              <Table.Tr>
                {canBulk && (
                  <Table.Th w={36}>
                    <SelectAllBox sel={sel} ids={shownIds} />
                  </Table.Th>
                )}
                <Table.Th>{t('form.name')}</Table.Th>
                <Table.Th>{label('area', true)}</Table.Th>
                <Table.Th>{label('building', true)}</Table.Th>
                <Table.Th>{label('asset', true)}</Table.Th>
                <Table.Th>{t('plantViews:tiles.title')}</Table.Th>
                <Table.Th>{t('sites.map')}</Table.Th>
                <Table.Th>{t('updated')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((s) => (
                <Table.Tr key={s.id} className="clickable" onClick={() => navigate(`/plant/sites/${encodeURIComponent(s.id)}`)}>
                  {canBulk && (
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <SelectBox sel={sel} id={s.id} name={nameOf(s)} />
                    </Table.Td>
                  )}
                  <Table.Td>
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
                  </Table.Td>
                  <Table.Td>{s.areaCount}</Table.Td>
                  <Table.Td>{s.buildingCount}</Table.Td>
                  <Table.Td>
                    <Stack gap={2}>
                      <Text size="sm">{s.assetCount}</Text>
                      {statuses(s)}
                    </Stack>
                  </Table.Td>
                  <Table.Td onClick={(e) => e.stopPropagation()} miw={220}>
                    <SiteTileStats siteId={s.id} compact />
                  </Table.Td>
                  <Table.Td onClick={(e) => e.stopPropagation()}>
                    <MapLink geo={s.geo} name={nameOf(s)} />
                  </Table.Td>
                  <Table.Td className="nowrap">{fmtRelative(s.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
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
