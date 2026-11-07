import { useCallback, useState } from 'react';
import { ActionIcon, Anchor, Badge, Group, Select, SimpleGrid, Stack, Table, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link, useSearchParams } from 'react-router-dom';
import { IconBuildingFactory2, IconMap, IconMapPin } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PLANT_MAP_STATES, type PlantMapSite, type PlantMapState } from '@sm/shared';
import { QueryState } from '../components/common';
import { ListPage } from '../components/page/ListPage';
import { MapLink, PreviewBadge, useNameOf, usePlantConfig, usePlantLabel } from '../components/plant/common';
import { MapLegend, MapPanel, useMapUnavailable } from '../components/plant/map/MapPanel';
import { MapStateLabel, useMapSites } from '../components/plant/map/mapShared';
import { StatusBar, ViewToolbar } from './plant/views/common';
import { useViewMode } from './plant/views/prefs';

type StateFilter = 'all' | 'problems' | PlantMapState;

/**
 * Plant → Map (#234, ADR 0015): the sites the reader may see, as a list and on a map side by side (phones start with
 * the list). The search and the state filter apply to both; pins are in list order. The map is off until an
 * administrator turns it on; without WebGL 2, or when the source fails, the list stays with the reason.
 */
export function PlantMapPage() {
  const { t } = useTranslation(['plantMap', 'plant', 'common', 'plantViews']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const cfg = usePlantConfig();
  const sites = useMapSites();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [state, setState] = useState<StateFilter>('all');
  const [mode, setMode] = useViewMode('plant-map');
  const [failed, setFailed] = useState(false);
  const wide = useMediaQuery('(min-width: 62em)') ?? true;
  const focus = params.get('site');
  const clearFocus = useCallback(() => {
    setParams(
      (p) => {
        p.delete('site');
        return p;
      },
      { replace: true },
    );
  }, [setParams]);
  const map = cfg.data?.map;
  const unavailable = useMapUnavailable(map) ?? (failed ? 'load' : null);
  const needle = q.trim().toLowerCase();
  const all = sites.data?.sites ?? [];
  const list = all.filter(
    (s) =>
      (state === 'all' || (state === 'problems' ? s.state === 'fail' || s.state === 'warn' : s.state === state)) &&
      (!needle || [s.id, s.code, s.name, nameOf(s)].some((x) => x.toLowerCase().includes(needle))),
  );
  const plural = label('site', true);
  // on wide screens list and map side by side; narrower: one of them, the list first on phones
  const showMap = !unavailable && (wide || mode === 'picture');
  const showList = wide || mode === 'table' || !!unavailable;
  const show = (id: string) => {
    if (!wide) setMode('picture');
    setParams(
      (p) => {
        p.set('site', id);
        return p;
      },
      { replace: true },
    );
  };

  const table = (
    <div className="table-scroll">
      <Table highlightOnHover fz="sm" aria-label={t('listLabel', { type: plural })} data-testid="map-site-list">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('plant:form.name')}</Table.Th>
            <Table.Th>{t('column.state')}</Table.Th>
            <Table.Th>{label('asset', true)}</Table.Th>
            <Table.Th>
              <VisuallyHidden>{t('column.position')}</VisuallyHidden>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.map((s: PlantMapSite) => (
            <Table.Tr key={s.id} data-testid={`map-row-${s.id}`}>
              <Table.Td miw={140}>
                <Stack gap={2} align="flex-start">
                  <Anchor component={Link} to={`/plant/sites/${encodeURIComponent(s.id)}`} fw={500} size="sm">
                    {nameOf(s)}
                  </Anchor>
                  {s.code && (
                    <Badge variant="default" size="xs" style={{ minWidth: 'max-content' }}>
                      {s.code}
                    </Badge>
                  )}
                </Stack>
              </Table.Td>
              <Table.Td miw={110}>
                <Stack gap={2}>
                  <MapStateLabel state={s.state} size="xs" />
                  {s.checks > 0 && (
                    <Text size="xs" c="dimmed">
                      {t('plantViews:tiles.checks', { count: s.checks })}
                    </Text>
                  )}
                </Stack>
              </Table.Td>
              <Table.Td miw={90}>
                <Stack gap={2}>
                  <Text size="sm">{s.total}</Text>
                  <StatusBar counts={s.counts} height={6} />
                </Stack>
              </Table.Td>
              <Table.Td className="nowrap">
                {s.geo ? (
                  !unavailable ? (
                    <Tooltip label={t('showNamed', { name: nameOf(s) })} withArrow>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => show(s.id)}
                        aria-label={t('showNamed', { name: nameOf(s) })}
                        data-testid={`show-on-map-${s.id}`}
                      >
                        <IconMapPin size={18} />
                      </ActionIcon>
                    </Tooltip>
                  ) : (
                    <MapLink geo={s.geo} name={nameOf(s)} />
                  )
                ) : (
                  <Text size="xs" c="dimmed">
                    {t('noPosition')}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );

  return (
    <ListPage
      testId="plant-map"
      title={
        <Group gap="sm" component="span">
          <span>{t('title')}</span>
          <PreviewBadge />
        </Group>
      }
      description={t('description', { type: label('site', true, true) })}
      search={all.length ? { value: q, onChange: setQ, placeholder: t('search') } : undefined}
      filters={
        all.length ? (
          <Select
            label={t('filter.state')}
            size="sm"
            w={200}
            value={state}
            onChange={(v) => setState((v as StateFilter | null) ?? 'all')}
            allowDeselect={false}
            data={[
              { value: 'all', label: t('filter.all') },
              { value: 'problems', label: t('filter.problems') },
              ...PLANT_MAP_STATES.map((x) => ({ value: x, label: t(`state.${x}`) })),
            ]}
            data-testid="map-state-filter"
          />
        ) : undefined
      }
      activeFilters={state === 'all' ? 0 : 1}
      empty={{
        show: sites.isSuccess && all.length === 0,
        icon: IconBuildingFactory2,
        title: t('emptyTitle', { type: label('site', true, true) }),
        text: t('emptyText'),
        whoCanAct: t('common:whoCanAct.plantSites'),
      }}
    >
      <QueryState query={sites} />
      {all.length > 0 && (
        <Stack gap="sm">
          {!wide && !unavailable && <ViewToolbar mode={mode} onMode={setMode} pictureIcon={IconMap} />}
          {all.length > 0 && list.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('noMatch')}
            </Text>
          )}
          <SimpleGrid
            cols={showMap && showList ? 2 : 1}
            spacing="md"
            style={showMap && showList ? { gridTemplateColumns: 'minmax(360px, 2fr) minmax(0, 3fr)' } : undefined}
          >
            {showList && <div>{table}</div>}
            {(showMap || unavailable) && (
              <Stack gap="xs" style={{ minWidth: 0 }}>
                <MapPanel
                  config={map}
                  sites={list}
                  height={wide ? 'max(420px, calc(100vh - 300px))' : 420}
                  label={t('mapLabel', { type: plural })}
                  focus={focus}
                  onFocused={clearFocus}
                  onFailed={() => setFailed(true)}
                />
                {!unavailable && <MapLegend />}
              </Stack>
            )}
          </SimpleGrid>
        </Stack>
      )}
    </ListPage>
  );
}
