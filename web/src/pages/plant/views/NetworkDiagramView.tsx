import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, MultiSelect, Paper, Popover, ScrollArea, Select, Stack, Switch, Text, Title, Tooltip } from '@mantine/core';
import { useElementSize, useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  IconFilter,
  IconInfoCircle,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconNetwork,
  IconSearch,
  IconShieldLock,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { fmtDay } from '../../../format';
import {
  zoneLevels,
  type PlantFlowGraph,
  type PlantFlowNode,
  type PlantFlowPath,
  type PlantHostPlacement,
  type PlantSiteNetwork,
  type ZoneLevel,
} from '@sm/shared';
import { get } from '../../../api';
import { EmptyState, QueryState } from '../../../components/common';
import { readPref, writePref } from '../../../components/page/prefs';
import { plantKeys } from '../../../queryKeys';
import { usePlantLabel } from '../../../components/plant/common';
import { LegendItem, LineMark, LiveBadge, ViewLegend, ViewToolbar, liveWord } from './common';
import { FlowTables, PathStatus } from './FlowView';
import { edgePill, statusSentence, useNodeText } from './FlowGraph';
import { NetworkCanvas, type Highlight } from './NetworkCanvas';
import { networkGraph, type NetworkWords } from './networkGraph';
import { networkLayout, type NetLayout } from './networkLayout';
import { networkSvg } from './networkExport';
import { LIVE_REFRESH_MS, useMotion, useViewMode } from './prefs';

/**
 * The OT network of a site as a picture (#230, view 5 – OT network → Diagram): IEC 62443-3-2 zones in bands by their
 * level in the Purdue model, with their IEEE 802.1Q VLANs and the assets on them, the conduits as gates between the
 * zones, and the data paths drawn through them in the direction they run. Opens fitted to the frame; a search finds
 * and centres a part or a data path, filters narrow the paths, a click selects a part (and dims the rest). The side
 * panel with the data paths folds (remembered per user); full screen for large sites. Live status only from the
 * checks #220 links; the rest is documentation, with direction only. The table says the same in words.
 */

type LiveFilter = 'online' | 'offline' | 'unknown' | 'notWatched';
interface Filters {
  zones: string[];
  protocols: string[];
  live: LiveFilter[];
  crossing: boolean;
  noConduit: boolean;
}
const NO_FILTERS: Filters = { zones: [], protocols: [], live: [], crossing: false, noConduit: false };
const PANEL_PREF = 'plant.networkDiagram.panel';

export function NetworkDiagramView({ siteId }: { siteId: string }) {
  const { t } = useTranslation(['plantViews', 'plantNetwork', 'plant']);
  const label = usePlantLabel();
  const q = useQuery({
    queryKey: plantKeys.network(siteId),
    queryFn: () => get<PlantSiteNetwork>(`/plant/sites/${encodeURIComponent(siteId)}/network`),
    refetchInterval: LIVE_REFRESH_MS,
  });
  const placement = useQuery({
    queryKey: plantKeys.placement(siteId),
    queryFn: () => get<PlantHostPlacement>(`/plant/sites/${encodeURIComponent(siteId)}/network/placement`),
  });
  const n = q.data;
  // the level of every zone: its own, or derived for the picture (zones with assets lowest, a DMZ above them …)
  const levels = useMemo(() => {
    if (!n) return null;
    const vlanZones = new Map<string, string>();
    for (const z of n.zones) for (const v of z.vlans) if (!vlanZones.has(v)) vlanZones.set(v, z.id);
    const withAssets = new Set(n.devices.map((d) => (d.vlan ? vlanZones.get(d.vlan) : undefined)).filter((x): x is string => !!x));
    return zoneLevels(n.zones, { vlanType: new Map(n.vlans.map((v) => [v.id, v.type])), withAssets, conduits: n.conduits });
  }, [n]);
  const words: NetworkWords = useMemo(
    () => ({
      vid: (vid) => t('network.vid', { vid }),
      criticality: (c) => t(`plantNetwork:criticality.${c as 'low'}`),
      sl: (level) => (level ? t('plantNetwork:zone.sl', { level }) : t('plantNetwork:zone.slOpen')),
      direction: (d, a, b) => t(`plantNetwork:directions.${d as 'both'}`, { a, b }),
      devices: (count) => t('network.devices', { count }),
      paths: (count) => t('network.paths', { count }),
      deviceLine: (d) =>
        [d.address || t('network.noAddress'), d.vlan, t(`plantNetwork:deviceStates.${d.state as 'active'}`), t(`network.liveWords.${d.live as 'online'}`)].join(
          ' · ',
        ),
      collectorKind: (k) => t(`plantNetwork:collectorKinds.${k as 'job'}`),
      mode: (m) => t(`plantNetwork:modes.${m as 'pull'}`),
      on: (host) => t('network.on', { host }),
      level: (l) => t(`network.levelSource.${l.source}`, { level: t(`plantNetwork:levels.${l.level}`) }),
      label: {
        devices: t('plantNetwork:device.title'),
        subnets: t('network.subnets'),
        owner: t('plantNetwork:owner'),
        vlans: t('plantNetwork:zone.vlans'),
        items: t('plantNetwork:zone.items'),
        protocols: t('plantNetwork:conduit.protocols'),
        controls: t('network.controls'),
        assessment: t('network.assessment'),
        managedBy: t('network.managedBy'),
        segment: t('network.segment'),
        restricted: t('network.restricted'),
        level: t('network.level'),
        apps: t('plantNetwork:edge.apps'),
      },
      yes: t('plant:yes'),
      hidden: t('node.hidden'),
      noVlan: t('network.noVlan'),
      hiddenApps: (count: number) => t('plantNetwork:edge.appsHidden', { count }),
    }),
    [t],
  );
  const graph = useMemo(() => (n && levels ? networkGraph(n, placement.data, words, levels) : null), [n, placement.data, words, levels]);
  const zoneLevel = useMemo(() => new Map([...(levels ?? [])].map(([id, l]) => [id, l.level])), [levels]);
  const base = `/plant/sites/${encodeURIComponent(siteId)}/network`;
  const notDrawn = n ? n.assets.filter((a) => !a.devices && !a.paths).length : 0;
  return (
    <Stack gap="sm" data-testid="ot-network-diagram">
      <div>
        <Title order={2} fz="h4">
          {t('network.title')}
        </Title>
        <Text size="xs" c="dimmed">
          {t('network.help', { type: label('asset', true, true) })}
        </Text>
      </div>
      <QueryState query={q} />
      {graph && graph.nodes.length === 0 ? (
        <EmptyState
          icon={IconNetwork}
          title={t('network.emptyTitle')}
          whoCanAct={n?.canManage ? undefined : t('plantNetwork:whoCanAct')}
          action={
            n?.canManage && (
              <Group gap="xs" justify="center">
                <Button variant="default" component={Link} to={`${base}/zones`}>
                  {t('plantNetwork:tabs.zones')}
                </Button>
                <Button variant="default" component={Link} to={`${base}/vlans`}>
                  {t('plantNetwork:tabs.vlans')}
                </Button>
              </Group>
            )
          }
          testId="network-diagram-empty"
        >
          {t('network.emptyText', { type: label('asset', true, true) })}
        </EmptyState>
      ) : (
        graph &&
        n && (
          <>
            <Diagram graph={graph} network={n} levels={zoneLevel} />
            {notDrawn > 0 && (
              <Text size="xs" c="dimmed" data-testid="network-not-drawn">
                {t('network.notDrawn', { count: notDrawn, type: label('asset', notDrawn !== 1, true) })}
              </Text>
            )}
          </>
        )
      )}
    </Stack>
  );
}

/** What a path touches, for the filters. */
interface PathFacts {
  zones: Set<string>;
  protocols: Set<string>;
  live: LiveFilter;
  crossing: boolean;
  noConduit: boolean;
}

function Diagram({ graph, network: n, levels }: { graph: PlantFlowGraph; network: PlantSiteNetwork; levels: Map<string, ZoneLevel> }) {
  const { t } = useTranslation(['plantViews', 'plantNetwork']);
  const { t: tv } = useTranslation('plantViews');
  const navigate = useNavigate();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const wide = useMediaQuery('(min-width: 100em)') ?? false;
  const motion = useMotion();
  const text = useNodeText();
  const [mode, setMode] = useViewMode('ot-network');
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ kind: 'node' | 'path'; id: string } | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // the filter panel keeps the focus when "Clear filters" disables itself (Escape closes the panel from there)
  const filterPanel = useRef<HTMLDivElement | null>(null);
  const [centerOn, setCenterOn] = useState<{ id: string; n: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // the side panel: open on wide screens unless folded, folded on smaller ones unless opened – remembered per user
  const [panelPref, setPanelPref] = useState(() => readPref(PANEL_PREF));
  const panelOpen = panelPref ? panelPref === 'open' : wide;
  const togglePanel = () => {
    const v = panelOpen ? 'folded' : 'open';
    writePref(PANEL_PREF, v);
    setPanelPref(v);
  };

  // laid out for the frame it is shown in (in steps, so a small change does not move the picture)
  const { ref: canvasRef, width: cw, height: ch } = useElementSize();
  // (on a phone the frame's height follows the picture: laid out as narrow as it gets)
  const aspect = narrow ? 0.75 : cw && ch ? Math.max(0.5, Math.min(3, Math.round((cw / ch) * 4) / 4)) : 1.75;
  // the same picture as before stays the same object: a refresh that changes only live statuses (every minute while a
  // linked check reports) neither fits the picture again nor moves it under the pointer
  const lastLayout = useRef<NetLayout | null>(null);
  const layout = useMemo(() => {
    const next = networkLayout(graph, levels, aspect);
    return lastLayout.current && sameLayout(lastLayout.current, next) ? lastLayout.current : next;
  }, [graph, levels, aspect]);
  lastLayout.current = layout;
  const byId = useMemo(() => new Map(graph.nodes.map((x) => [x.id, x])), [graph]);
  const pathById = useMemo(() => new Map(graph.paths.map((p) => [p.id, p])), [graph]);
  const title = t('network.exportTitle', { site: n.site.name });
  const labelOf = useCallback((id: string) => (byId.get(id) ? text.label(byId.get(id)!) : id), [byId, text]);

  // ---------- what each path touches (zones, protocols, live status), for the filters ----------
  const facts = useMemo(() => {
    const zoneOf = (id: string): string[] => {
      if (byId.get(id)?.kind === 'conduit')
        return graph.edges.filter((e) => e.conduit && (e.from === id || e.to === id)).map((e) => (e.from === id ? e.to : e.from));
      for (let p: string | undefined = id, i = 0; p && i < 6; p = byId.get(p)?.parent, i++) if (p.startsWith('zone:')) return [p];
      return [];
    };
    const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
    const protocols = new Map(
      n.dataPaths.map((dp) => [`${dp.assetId}/${dp.id}`, new Set(dp.transfers.map((x) => x.protocol.trim().toLowerCase()).filter(Boolean))]),
    );
    const out = new Map<string, PathFacts>();
    for (const p of graph.paths) {
      const edges = p.edges.map((id) => edgeById.get(id)).filter((e) => !!e);
      out.set(p.id, {
        zones: new Set(p.nodes.flatMap(zoneOf)),
        protocols: protocols.get(p.id) ?? new Set(),
        live: (p.live ?? 'notWatched') as LiveFilter,
        crossing: p.nodes.some((id) => byId.get(id)?.kind === 'conduit') || edges.some((e) => e.noConduit),
        noConduit: edges.some((e) => e.noConduit),
      });
    }
    return out;
  }, [graph, n, byId]);
  const allProtocols = useMemo(() => [...new Set([...facts.values()].flatMap((f) => [...f.protocols]))].sort(), [facts]);
  const active = filters.zones.length + filters.protocols.length + filters.live.length + (filters.crossing ? 1 : 0) + (filters.noConduit ? 1 : 0);
  const shownPaths = useMemo(() => {
    if (!active) return graph.paths;
    return graph.paths.filter((p) => {
      const f = facts.get(p.id)!;
      return (
        (!filters.zones.length || filters.zones.some((z) => f.zones.has(z))) &&
        (!filters.protocols.length || filters.protocols.some((x) => f.protocols.has(x))) &&
        (!filters.live.length || filters.live.includes(f.live)) &&
        (!filters.crossing || f.crossing) &&
        (!filters.noConduit || f.noConduit)
      );
    });
  }, [graph, facts, filters, active]);
  // what the filters let through: the paths' parts and ways (and the zones chosen), the rest is dimmed
  const scope = useMemo(() => {
    if (!active) return null;
    const nodes = new Set<string>(filters.zones);
    const edges = new Set<string>();
    for (const p of shownPaths) {
      p.nodes.forEach((x) => nodes.add(x));
      p.edges.forEach((x) => edges.add(x));
    }
    // the pipes of the conduits the paths run through
    for (const e of graph.edges) if (e.conduit && nodes.has(byId.get(e.from)?.kind === 'conduit' ? e.from : e.to)) edges.add(e.id);
    return { nodes, edges };
  }, [active, shownPaths, graph, filters.zones, byId]);

  // ---------- what is pointed at or selected ----------
  const focus: Highlight | null = useMemo(() => {
    const pathId = hoverPath ?? (!hoverNode && selected?.kind === 'path' ? selected.id : null);
    const p = pathId ? pathById.get(pathId) : undefined;
    if (p) return { nodes: new Set(p.nodes), edges: new Set(p.edges), labels: true };
    const nodeId = hoverNode ?? (selected?.kind === 'node' ? selected.id : null);
    if (!nodeId) return null;
    // an area (a zone, a VLAN) stands for everything in it
    const inside = new Set([nodeId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of graph.nodes)
        if (x.parent && inside.has(x.parent) && !inside.has(x.id)) {
          inside.add(x.id);
          grew = true;
        }
    }
    const nodes = new Set(inside);
    const edges = new Set<string>();
    for (const x of graph.paths)
      if (x.nodes.some((id) => inside.has(id))) {
        x.nodes.forEach((id) => nodes.add(id));
        x.edges.forEach((id) => edges.add(id));
      }
    for (const e of graph.edges)
      if (inside.has(e.from) || inside.has(e.to)) {
        edges.add(e.id);
        nodes.add(e.from);
        nodes.add(e.to);
      }
    // the labels of the ways of one part (not of a whole zone: too many)
    return { nodes, edges, labels: !byId.get(nodeId)?.group };
  }, [hoverNode, hoverPath, selected, pathById, graph, byId]);

  const selectedName = selected
    ? selected.kind === 'path'
      ? (pathById.get(selected.id)?.label ?? null)
      : byId.has(selected.id)
        ? labelOf(selected.id)
        : null
    : null;
  const clear = useCallback(() => setSelected(null), []);
  const selectNode = useCallback((id: string | null) => setSelected(id ? { kind: 'node', id } : null), []);
  const shownNode = hoverNode ? byId.get(hoverNode) : selected?.kind === 'node' ? byId.get(selected.id) : undefined;

  // ---------- size: the picture fills the screen below its top; full screen fills all ----------
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(620);
  useLayoutEffect(() => {
    const measure = () => {
      const el = frameRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      // a phone: no taller than the picture needs at the width of the screen
      const phone = Math.round(Math.min(window.innerHeight * 0.7, Math.max(320, (el.clientWidth * layout.height) / layout.width + 40)));
      setAvail(narrow ? phone : Math.max(440, Math.round(window.innerHeight - top - 20)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [narrow, mode, fullscreen, layout]);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.mantine-Popover-dropdown, .mantine-Combobox-dropdown')) return;
      setFullscreen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const levelWords = useCallback((l: ZoneLevel) => ({ short: t(`network.levelShort.${l}`), name: t(`network.levelName.${l}`) }), [t]);
  const nodeLive = useCallback((x: PlantFlowNode) => (x.live ? liveWord(tv, x.live) : ''), [tv]);

  // ---------- search: a part or a data path ----------
  const searchData = useMemo(() => {
    const kinds = ['asset', 'collector', 'host', 'application', 'platform', 'peer', 'dataset', 'zone', 'vlan', 'conduit'] as const;
    const groups = kinds
      .map((k) => ({
        group: t(`kinds.${k}`),
        items: graph.nodes
          .filter((x) => x.kind === k && !x.hidden)
          .map((x) => ({ value: x.id, label: x.kind === 'vlan' && x.tags?.[0] ? `${x.label} (${x.tags[0]})` : x.label })),
      }))
      .filter((g) => g.items.length);
    if (graph.paths.length)
      groups.push({ group: t('plantNetwork:path.title'), items: graph.paths.map((p) => ({ value: `path:${p.id}`, label: `${p.label} – ${p.detail}` })) });
    return groups;
  }, [graph, t]);
  const [searchText, setSearchText] = useState('');
  const onSearch = (v: string | null) => {
    if (!v) return;
    setSearchText('');
    if (v.startsWith('path:')) {
      const id = v.slice(5);
      setSelected({ kind: 'path', id });
      const first = pathById.get(id)?.nodes[0];
      if (first) setCenterOn({ id: first, n: Date.now() });
    } else {
      setSelected({ kind: 'node', id: v });
      setCenterOn({ id: v, n: Date.now() });
    }
  };

  const exportSvg = () => ({
    ...networkSvg(graph, layout, {
      title,
      subtitle: t('export.subtitle', { date: fmtDay(new Date()) }),
      kind: (x) => text.kind(x),
      status: (x) => statusSentence(tv, x),
      pill: (e) =>
        e.noConduit
          ? [t('edge.noConduit'), e.label].filter(Boolean).join(' · ')
          : [e.live === 'offline' ? t('edge.offline') : '', edgePill(tv, e, 'paths', false)].filter(Boolean).join(' · '),
      hidden: t('node.hidden'),
      outside: t('network.outside'),
      level: levelWords,
    }),
    title,
  });
  const legend = (
    <ViewLegend live={t('network.live')}>
      <LegendItem mark={<LineMark kind="flow" />}>{motion.animate ? t('legend.flowMoving') : t('legend.flowStatic')}</LegendItem>
      <LegendItem mark={<LineMark kind="online" />}>{t('network.legendOnline')}</LegendItem>
      <LegendItem mark={<LineMark kind="offline" />}>{t('network.legendOffline')}</LegendItem>
      <LegendItem mark={<IconShieldLock size={14} style={{ color: 'var(--pv-conduit)' }} />}>{t('network.legendZone')}</LegendItem>
      <LegendItem mark={<IconNetwork size={14} />}>{t('network.legendVlan')}</LegendItem>
      <LegendItem mark={<GateMark />}>{t('network.legendConduit')}</LegendItem>
      <LegendItem mark={<NoConduitMark />}>{t('network.legendNoConduit')}</LegendItem>
      <LegendItem mark={<BandMark />}>{t('network.legendLevels')}</LegendItem>
      <LegendItem mark={<IconInfoCircle size={14} />}>{t('network.legendLabels')}</LegendItem>
    </ViewLegend>
  );

  const zoneNodes = graph.nodes.filter((x) => x.kind === 'zone');
  const tools = mode === 'picture' && (
    <>
      <Select
        size="xs"
        w={narrow ? '100%' : 260}
        searchable
        clearable
        value={null}
        onChange={onSearch}
        searchValue={searchText}
        onSearchChange={setSearchText}
        selectFirstOptionOnChange
        data={searchData}
        limit={60}
        leftSection={<IconSearch size={14} aria-hidden />}
        placeholder={t('network.searchPlaceholder')}
        aria-label={t('network.search')}
        nothingFoundMessage={t('network.searchNothing')}
        comboboxProps={{ zIndex: 400 }}
        data-testid="nd-search"
      />
      <Popover position="bottom-start" shadow="md" withinPortal zIndex={400} trapFocus returnFocus>
        <Popover.Target>
          <Button
            size="xs"
            variant={active ? 'light' : 'default'}
            leftSection={<IconFilter size={14} aria-hidden />}
            rightSection={
              active ? (
                <Badge size="xs" className="count-badge">
                  {active}
                </Badge>
              ) : undefined
            }
            data-testid="nd-filters"
          >
            {t('network.filters')}
          </Button>
        </Popover.Target>
        <Popover.Dropdown ref={filterPanel} tabIndex={-1} maw={360} data-testid="nd-filter-panel" aria-label={t('network.filters')}>
          <Stack gap="xs">
            <MultiSelect
              size="xs"
              label={t('network.filterZones')}
              data={zoneNodes.map((z) => ({ value: z.id, label: z.label }))}
              value={filters.zones}
              onChange={(zones) => setFilters((f) => ({ ...f, zones }))}
              clearable
              comboboxProps={{ withinPortal: false }}
              data-testid="nd-filter-zones"
            />
            <MultiSelect
              size="xs"
              label={t('network.filterProtocols')}
              data={allProtocols}
              value={filters.protocols}
              onChange={(protocols) => setFilters((f) => ({ ...f, protocols }))}
              clearable
              comboboxProps={{ withinPortal: false }}
              data-testid="nd-filter-protocols"
            />
            <MultiSelect
              size="xs"
              label={t('network.filterLive')}
              data={(['online', 'offline', 'unknown', 'notWatched'] as const).map((x) => ({ value: x, label: t(`path.live.${x}`) }))}
              value={filters.live}
              onChange={(live) => setFilters((f) => ({ ...f, live: live as LiveFilter[] }))}
              clearable
              comboboxProps={{ withinPortal: false }}
              data-testid="nd-filter-live"
            />
            <Switch
              size="xs"
              label={t('network.filterCrossing')}
              checked={filters.crossing}
              onChange={(e) => {
                const crossing = e.currentTarget.checked;
                setFilters((f) => ({ ...f, crossing }));
              }}
              data-testid="nd-filter-crossing"
            />
            <Switch
              size="xs"
              label={t('network.filterNoConduit')}
              checked={filters.noConduit}
              onChange={(e) => {
                const noConduit = e.currentTarget.checked;
                setFilters((f) => ({ ...f, noConduit }));
              }}
              data-testid="nd-filter-no-conduit"
            />
            <Button
              size="xs"
              variant="subtle"
              disabled={!active}
              onClick={() => {
                setFilters(NO_FILTERS);
                filterPanel.current?.focus();
              }}
              data-testid="nd-filter-clear"
            >
              {t('network.clearFilters')}
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
      <Popover position="bottom-start" shadow="md" withinPortal zIndex={400} width={narrow ? 320 : 460} trapFocus returnFocus>
        <Popover.Target>
          <Button size="xs" variant="default" leftSection={<IconInfoCircle size={14} aria-hidden />} data-testid="nd-legend-button">
            {t('network.legend')}
          </Button>
        </Popover.Target>
        <Popover.Dropdown p={0} aria-label={t('network.legend')}>
          {legend}
        </Popover.Dropdown>
      </Popover>
    </>
  );

  const info = (shownNode || selected?.kind === 'path') && (
    <NodeInfo
      node={shownNode}
      path={!shownNode && selected?.kind === 'path' ? pathById.get(selected.id) : undefined}
      labelOf={labelOf}
      selected={!!selected && !hoverNode}
      onClear={clear}
      floating={!narrow}
    />
  );
  const panel = (
    <PathList
      paths={shownPaths}
      total={graph.paths.length}
      title={t('plantNetwork:path.title')}
      pinned={selected?.kind === 'path' ? selected.id : null}
      onPin={(id) => setSelected((s) => (s?.kind === 'path' && s.id === id ? null : { kind: 'path', id }))}
      onHover={setHoverPath}
      labelOf={labelOf}
      onClearFilters={active ? () => setFilters(NO_FILTERS) : null}
      onFold={togglePanel}
    />
  );
  return (
    <div className={fullscreen ? 'nd-full' : undefined} data-testid="network-diagram-view" data-mode={mode} data-fullscreen={fullscreen || undefined}>
      <ViewToolbar mode={mode} onMode={setMode} onExport={graph.nodes.length ? exportSvg : null}>
        {tools}
      </ViewToolbar>
      {mode === 'picture' ? (
        <>
          {active > 0 && (
            <Group gap="xs" mt="xs" data-testid="nd-shown-count">
              <Text size="xs" c="dimmed">
                {t('network.shown', { shown: shownPaths.length, count: graph.paths.length })}
              </Text>
              <Anchor component="button" type="button" size="xs" onClick={() => setFilters(NO_FILTERS)}>
                {t('network.clearFilters')}
              </Anchor>
            </Group>
          )}
          <div
            className="nd-frame"
            ref={frameRef}
            style={fullscreen ? undefined : { height: narrow ? undefined : avail, marginTop: 'var(--mantine-spacing-sm)' }}
          >
            <div className="nd-canvas" ref={canvasRef}>
              <NetworkCanvas
                graph={graph}
                layout={layout}
                label={t('graph.label', { title })}
                height={narrow && !fullscreen ? avail : '100%'}
                focus={focus}
                scope={scope}
                selected={selected?.kind === 'node' ? selected.id : null}
                selectedName={selectedName}
                onHover={setHoverNode}
                onSelect={selectNode}
                onClear={clear}
                onOpen={(p) => navigate(p)}
                centerOn={centerOn}
                fitKey={`${fullscreen}:${panelOpen}`}
                fullscreen={fullscreen}
                onFullscreen={setFullscreen}
                miniMap={!narrow && graph.nodes.filter((x) => !x.group).length > 24}
                levelWords={levelWords}
                liveWord={nodeLive}
              />
              {!narrow && info}
            </div>
            {narrow && info}
            {panelOpen || narrow ? (
              <div className="nd-panel" id="nd-panel" data-testid="nd-panel">
                {panel}
              </div>
            ) : (
              <div className="nd-strip" data-testid="nd-panel-strip">
                <Tooltip label={t('network.showPanel')} position="left">
                  <ActionIcon variant="subtle" onClick={togglePanel} aria-label={t('network.showPanel')} aria-expanded={false} data-testid="nd-panel-show">
                    <IconLayoutSidebarRightExpand size={18} />
                  </ActionIcon>
                </Tooltip>
                <Text size="xs" c="dimmed" className="nd-strip-text">
                  {t('network.pathsCount', { count: shownPaths.length })}
                </Text>
              </div>
            )}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 'var(--mantine-spacing-sm)' }}>
          <FlowTables graph={graph} pathsTitle={t('plantNetwork:path.title')} narrow={narrow} nodeText={text} />
        </div>
      )}
    </div>
  );
}

/** The part pointed at or selected, with its details (an asset's devices, a VLAN's subnets …), or the selected path. */
function NodeInfo({
  node,
  path,
  labelOf,
  selected,
  onClear,
  floating,
}: {
  node: PlantFlowNode | undefined;
  path: PlantFlowPath | undefined;
  labelOf: (id: string) => string;
  selected: boolean;
  onClear: () => void;
  floating: boolean;
}) {
  const { t } = useTranslation('plantViews');
  const text = useNodeText();
  return (
    <Paper
      withBorder
      shadow={floating ? 'md' : undefined}
      p="xs"
      radius="md"
      data-testid="flow-node-info"
      aria-live="polite"
      className={floating ? 'nd-info nd-info-floating' : 'nd-info'}
      data-interactive={selected || undefined}
    >
      {node ? (
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            {text.kind(node)}: {text.label(node)}
          </Text>
          {node.live && (
            <div>
              <LiveBadge live={node.live} size="xs" withSource focusable={false} />
            </div>
          )}
          {node.info?.map((x, i) => (
            <Group key={i} gap={6} wrap="nowrap" align="flex-start">
              <Text size="xs" c="dimmed" style={{ flexShrink: 0, minWidth: 76 }}>
                {x.label}
              </Text>
              <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                {x.value}
              </Text>
            </Group>
          ))}
          {!node.info?.length && node.detail && (
            <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
              {node.detail}
            </Text>
          )}
          {selected && (
            <Group gap="xs" mt={4}>
              {node.path && (
                <Button size="compact-xs" variant="light" component={Link} to={node.path} data-testid="nd-open">
                  {t('network.openPage')}
                </Button>
              )}
              <Button size="compact-xs" variant="subtle" onClick={onClear}>
                {t('network.clearSelectionShort')}
              </Button>
            </Group>
          )}
        </Stack>
      ) : path ? (
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            {path.label}
          </Text>
          <Text size="xs" c="dimmed">
            {path.detail}
          </Text>
          <PathStatus p={path} />
          <Text size="xs">{path.nodes.map(labelOf).join(' → ')}</Text>
          <Group gap="xs" mt={4}>
            <Button size="compact-xs" variant="subtle" onClick={onClear}>
              {t('network.clearSelectionShort')}
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Paper>
  );
}

/** The data paths beside the picture: pointing at one highlights its way, a click selects it. */
function PathList({
  paths,
  total,
  title,
  pinned,
  onPin,
  onHover,
  labelOf,
  onClearFilters,
  onFold,
}: {
  paths: PlantFlowPath[];
  total: number;
  title: string;
  pinned: string | null;
  onPin: (id: string) => void;
  onHover: (id: string | null) => void;
  labelOf: (id: string) => string;
  onClearFilters: (() => void) | null;
  onFold: () => void;
}) {
  const { t } = useTranslation('plantViews');
  const [limit, setLimit] = useState(100);
  return (
    <Paper withBorder p="xs" radius="md" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }} data-testid="flow-paths">
      <Group justify="space-between" gap="xs" mb={4} wrap="nowrap">
        <Title order={3} fz="sm">
          {title}
        </Title>
        <Group gap={4} wrap="nowrap">
          <Text size="xs" c="dimmed">
            {paths.length === total ? total : t('network.shownShort', { shown: paths.length, count: total })}
          </Text>
          <Tooltip label={t('network.foldPanel')}>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={onFold}
              aria-label={t('network.foldPanel')}
              aria-expanded
              aria-controls="nd-panel"
              data-testid="nd-panel-fold"
              visibleFrom="sm"
            >
              <IconLayoutSidebarRightCollapse size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <Text size="xs" c="dimmed" mb={6}>
        {t('network.pathsHelp')}
      </Text>
      {paths.length === 0 ? (
        <Stack gap={4} align="flex-start">
          <Text size="sm" c="dimmed">
            {t('path.none')}
          </Text>
          {onClearFilters && (
            <Button size="compact-xs" variant="subtle" onClick={onClearFilters}>
              {t('network.clearFilters')}
            </Button>
          )}
        </Stack>
      ) : (
        <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
          <Stack gap={2} role="list" aria-label={title}>
            {paths.slice(0, limit).map((p) => (
              <div role="listitem" key={p.id}>
                <button
                  type="button"
                  className="pv-path"
                  data-active={pinned === p.id || undefined}
                  aria-pressed={pinned === p.id}
                  onMouseEnter={() => onHover(p.id)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onHover(p.id)}
                  onBlur={() => onHover(null)}
                  onClick={() => onPin(p.id)}
                  data-testid={`flow-path-${p.id}`}
                >
                  <Group justify="space-between" gap={6} wrap="nowrap">
                    <Text size="sm" fw={500} lineClamp={1}>
                      {p.label}
                    </Text>
                    <PathStatus p={p} />
                  </Group>
                  {p.detail && (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {p.detail}
                    </Text>
                  )}
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {p.nodes.slice(1).map(labelOf).join(' → ') || t('path.nowhere')}
                  </Text>
                </button>
              </div>
            ))}
          </Stack>
          {paths.length > limit && (
            <Button size="xs" variant="subtle" mt={4} onClick={() => setLimit((l) => l + 100)}>
              {t('path.more', { count: Math.min(100, paths.length - limit) })}
            </Button>
          )}
        </ScrollArea>
      )}
    </Paper>
  );
}

/** Whether two layouts place everything the same. */
function sameLayout(a: NetLayout, b: NetLayout): boolean {
  const sig = (l: NetLayout) => JSON.stringify([l.width, l.height, l.bands, l.outside, [...l.rects], [...l.edges]]);
  return sig(a) === sig(b);
}

function NoConduitMark() {
  return (
    <svg width={34} height={10} viewBox="0 0 34 10" aria-hidden>
      <path d="M1 5 H27" className="pv-edge-base" data-no-conduit="true" strokeWidth={2} />
      <path d="M27 1 L33 5 L27 9 Z" fill="var(--pv-warn)" />
    </svg>
  );
}
function GateMark() {
  return (
    <svg width={34} height={14} viewBox="0 0 34 14" aria-hidden>
      <rect x={1} y={2} width={32} height={10} rx={5} fill="var(--mantine-color-body)" stroke="var(--pv-conduit)" strokeWidth={2} />
    </svg>
  );
}
function BandMark() {
  return (
    <svg width={34} height={14} viewBox="0 0 34 14" aria-hidden>
      <rect x={0} y={1} width={34} height={5} fill="var(--nd-band)" stroke="var(--mantine-color-default-border)" strokeDasharray="2 2" />
      <rect x={0} y={8} width={34} height={5} fill="none" stroke="var(--mantine-color-default-border)" strokeDasharray="2 2" />
    </svg>
  );
}
