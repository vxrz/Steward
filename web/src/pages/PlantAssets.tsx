import { useMemo, useState } from 'react';
import { Anchor, Badge, Button, CloseButton, Group, Paper, Select, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconBuilding, IconPlus, IconEngine } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ASSET_STATUSES, type AssetLocation, type PlantAssetSummary, type PlantProfileSummary } from '@sm/shared';
import { get } from '../api';
import { QueryState, useCreateParam } from '../components/common';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { plantKeys } from '../queryKeys';
import { AssetStatusBadge, NotInSourceBadge, PreviewBadge, useNameOf, usePlantConfig, usePlantLabel } from '../components/plant/common';
import { AssetFormModal, flatNodes, nodePath, useHierarchy } from '../components/plant/forms';

// profile and data point (#219): "which assets deliver data point X" lands here from a data point or the search
const FILTERS = ['site', 'node', 'domain', 'status', 'tag', 'profile', 'dataPoint'] as const;
type Filter = (typeof FILTERS)[number];

/** Where an asset is, as one line: site › area › work center › work unit. */
export function LocationLine({ location, withSite = true }: { location: AssetLocation; withSite?: boolean }) {
  const nameOf = useNameOf();
  const parts = [withSite ? location.site : null, location.area, location.workCenter, location.workUnit].filter((x): x is NonNullable<typeof x> => !!x);
  return (
    <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
      {parts.map((p) => nameOf(p)).join(' › ') || '–'}
    </Text>
  );
}

/** Assets of the sites the person may see (#218), filtered by site, place, domain, status and tag (kept in the address). */
export function PlantAssetsPage() {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cfg = usePlantConfig();
  const tree = useHierarchy();
  const [params, setParams] = useSearchParams();
  const filter = Object.fromEntries(FILTERS.map((f) => [f, params.get(f)])) as Record<Filter, string | null>;
  const [q, setQ] = useState(params.get('q') ?? '');
  const [creating, setCreating] = useState(false);
  useCreateParam(cfg.data?.canManageSome, () => setCreating(true));
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  const assets = useQuery({ queryKey: plantKeys.assets(qs), queryFn: () => get<PlantAssetSummary[]>(`/plant/assets${qs ? `?${qs}` : ''}`) });
  // every asset (unfiltered) for the choices of domain and tag
  const all = useQuery({ queryKey: plantKeys.assets(''), queryFn: () => get<PlantAssetSummary[]>('/plant/assets') });
  const profiles = useQuery({ queryKey: plantKeys.profiles, queryFn: () => get<PlantProfileSummary[]>('/plant/profiles') });
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const view = useStoredListView('plant-assets', narrow);
  const set = (f: Filter, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(f, v);
    else next.delete(f);
    // a place belongs to a site: choosing another site clears it; a data point belongs to its profile
    if (f === 'site') next.delete('node');
    if (f === 'profile') next.delete('dataPoint');
    setParams(next, { replace: true });
  };
  const sites = useMemo(() => tree.data ?? [], [tree.data]);
  const nodeOptions = useMemo(
    () =>
      sites
        .filter((s) => !filter.site || s.id === filter.site)
        .map((s) => ({
          group: nameOf(s),
          items: flatNodes(s.areas).map((n, _i, all) => ({ value: n.id, label: nodePath(all, n, nameOf) })),
        }))
        .filter((g) => g.items.length),
    [sites, filter.site, nameOf],
  );
  const domains = [...new Set([...(all.data ?? []).map((a) => a.domain), ...sites.flatMap((s) => s.areas.map((a) => a.domain))].filter(Boolean))].sort();
  const tags = [...new Set((all.data ?? []).flatMap((a) => a.tags))].sort((a, b) => a.localeCompare(b));
  const needle = q.trim().toLowerCase();
  const list = (assets.data ?? []).filter(
    (a) => !needle || [a.id, a.name, a.manufacturer, a.model, a.role, a.domain, ...a.tags].some((x) => x.toLowerCase().includes(needle)),
  );
  const active = FILTERS.filter((f) => filter[f]).length + (needle ? 1 : 0);
  const plural = label('asset', true);
  const none = all.isSuccess && all.data.length === 0;
  const building = (a: PlantAssetSummary) =>
    a.location.building ? (
      <Group gap={4} wrap="nowrap">
        <IconBuilding size={13} aria-hidden />
        <Text size="sm">{nameOf(a.location.building)}</Text>
      </Group>
    ) : (
      '–'
    );
  return (
    <ListPage
      testId="plant-assets"
      title={
        <Group gap="sm" component="span">
          <span>{plural}</span>
          <PreviewBadge />
        </Group>
      }
      description={t('assets.description')}
      primaryAction={
        cfg.data?.canManageSome && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            {t('assets.new', { type: label('asset', false, true) })}
          </Button>
        )
      }
      search={none ? undefined : { value: q, onChange: setQ, placeholder: t('assets.search') }}
      activeFilters={active}
      filters={
        none ? undefined : (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="asset-filters">
            <Select
              size="xs"
              label={label('site')}
              data={sites.map((s) => ({ value: s.id, label: nameOf(s) }))}
              value={filter.site}
              onChange={(v) => set('site', v)}
              clearable
              searchable
              w={{ base: '100%', xs: 190 }}
            />
            <Select
              size="xs"
              label={t('assets.place')}
              data={nodeOptions}
              value={filter.node}
              onChange={(v) => set('node', v)}
              clearable
              searchable
              w={{ base: '100%', xs: 220 }}
            />
            <Select
              size="xs"
              label={t('asset.domain')}
              data={domains}
              value={filter.domain}
              onChange={(v) => set('domain', v)}
              clearable
              w={{ base: '100%', xs: 160 }}
            />
            <Select
              size="xs"
              label={t('asset.status')}
              data={ASSET_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
              value={filter.status}
              onChange={(v) => set('status', v)}
              clearable
              w={{ base: '100%', xs: 170 }}
            />
            <Select
              size="xs"
              label={t('asset.tag')}
              data={tags}
              value={filter.tag}
              onChange={(v) => set('tag', v)}
              clearable
              searchable
              w={{ base: '100%', xs: 150 }}
            />
            {(profiles.data?.length ?? 0) > 0 && (
              <Select
                size="xs"
                label={t('assignment.profile')}
                data={(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
                value={filter.profile}
                onChange={(v) => set('profile', v)}
                clearable
                searchable
                w={{ base: '100%', xs: 220 }}
              />
            )}
            {filter.profile && filter.dataPoint && (
              <Badge
                size="lg"
                variant="light"
                tt="none"
                rightSection={<CloseButton size="xs" aria-label={t('assets.clearDataPoint')} onClick={() => set('dataPoint', null)} />}
                data-testid="filter-data-point"
              >
                {t('assets.deliversPoint', { point: filter.dataPoint })}
              </Badge>
            )}
          </Group>
        )
      }
      view={none ? undefined : 'plant-assets'}
      viewState={view}
      empty={{
        show: none,
        icon: IconEngine,
        title: t('assets.emptyTitle', { type: label('asset', true, true) }),
        text: t('assets.emptyText'),
        whoCanAct: cfg.data?.canManageSome ? undefined : t('common:whoCanAct.plantAssets'),
        action: cfg.data?.canManageSome && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            {t('assets.new', { type: label('asset', false, true) })}
          </Button>
        ),
      }}
    >
      <QueryState query={assets} />
      {!none && assets.isSuccess && list.length === 0 && (
        <Text size="sm" c="dimmed" data-testid="assets-no-match">
          {t('assets.noMatch')}
        </Text>
      )}
      {list.length > 0 && (
        <Text size="xs" c="dimmed" mb="xs" aria-live="polite">
          {t('assets.count', { count: list.length })}
        </Text>
      )}
      {list.length > 0 && view.cards && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} data-testid="plant-asset-cards">
          {list.map((a) => (
            <Paper key={a.id} withBorder p="md" component="article" aria-labelledby={`asset-${a.id}`}>
              <Stack gap={6}>
                <Group gap="xs" justify="space-between" wrap="nowrap" align="flex-start">
                  <Anchor id={`asset-${a.id}`} component={Link} to={`/plant/assets/${encodeURIComponent(a.id)}`} fw={600} style={{ overflowWrap: 'anywhere' }}>
                    {a.name}
                  </Anchor>
                  <AssetStatusBadge status={a.status} size="xs" />
                </Group>
                <LocationLine location={a.location} />
                {building(a)}
                {(a.manufacturer || a.model) && (
                  <Text size="sm" c="dimmed">
                    {[a.manufacturer, a.model].filter(Boolean).join(' · ')}
                  </Text>
                )}
                <Group gap={4}>
                  {a.notInSource && <NotInSourceBadge size="xs" />}
                  {a.tags.map((x) => (
                    <Badge key={x} size="xs" variant="default">
                      {x}
                    </Badge>
                  ))}
                </Group>
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {list.length > 0 && !view.cards && (
        <div className="table-scroll">
          <Table highlightOnHover fz="sm" aria-label={plural} data-testid="plant-asset-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('form.name')}</Table.Th>
                <Table.Th>{t('asset.status')}</Table.Th>
                <Table.Th>{t('asset.location')}</Table.Th>
                <Table.Th>{label('building')}</Table.Th>
                <Table.Th>{t('asset.manufacturerModel')}</Table.Th>
                <Table.Th>{t('asset.tags')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((a) => (
                <Table.Tr key={a.id} className="clickable" onClick={() => navigate(`/plant/assets/${encodeURIComponent(a.id)}`)}>
                  <Table.Td>
                    <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(a.id)}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                      {a.name}
                    </Anchor>
                    <Group gap={4}>
                      <Text size="xs" c="dimmed" className="mono">
                        {a.id}
                      </Text>
                      {a.notInSource && <NotInSourceBadge size="xs" />}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <AssetStatusBadge status={a.status} />
                  </Table.Td>
                  <Table.Td>
                    <LocationLine location={a.location} />
                  </Table.Td>
                  <Table.Td>{building(a)}</Table.Td>
                  <Table.Td>{[a.manufacturer, a.model].filter(Boolean).join(' · ') || '–'}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {a.tags.map((x) => (
                        <Badge key={x} size="xs" variant="default">
                          {x}
                        </Badge>
                      ))}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {creating && (
        <AssetFormModal
          defaults={{ siteId: filter.site, nodeId: filter.node }}
          onClose={() => setCreating(false)}
          onSaved={(a) => {
            void qc.invalidateQueries({ queryKey: plantKeys.all });
            navigate(`/plant/assets/${encodeURIComponent(a.id)}`);
          }}
        />
      )}
    </ListPage>
  );
}
