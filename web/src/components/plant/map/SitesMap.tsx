import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, Badge, Button, Group, Popover, Stack, Text, useComputedColorScheme } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconArrowRight } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { LngLatBounds, Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { coveragePct, PLANT_MAP_LIMITS, type PlantMapClient, type PlantMapSite, type PlantMapState } from '@sm/shared';
import { useNameOf } from '../common';
import { StatusBar } from '../../../pages/plant/views/common';
import { useMotion } from '../../../pages/plant/views/prefs';
import { MapAttribution, MapStateLabel, pinName, STATE_ICON, STATE_VAR, styleUrl, transformRequest } from './mapShared';
import './map.css';

/**
 * The map of sites (#234, ADR 0015), loaded on demand (its own chunk with MapLibre GL JS). The tiles come from Steward
 * only (transformRequest refuses anything else); the worker is MapLibre's own module file served from Steward's origin,
 * so the content security policy needs nothing new (no eval, no blob: worker).
 *
 * Pins and clusters are HTML buttons over the map, in list order: Tab moves through them, Enter opens a site's card or
 * zooms into a cluster. Only what is in view is drawn (and focusable); clusters count only the sites given – the sites
 * the reader may see. prefers-reduced-motion or "Animation off" turns every camera animation into a jump.
 */

setWorkerUrl(new URL(workerUrl, document.baseURI).href);

export interface SitesMapProps {
  sites: PlantMapSite[];
  config: PlantMapClient;
  height: number | string;
  /** The region's name for screen readers */
  label: string;
  /** A site to show with its own zoom (Show on map) */
  focus?: string | null;
  onFocused?: () => void;
  /** The map could not be drawn (the style or every tile failed): the parent shows the list */
  onFailed?: (why: 'load') => void;
  /** Smaller pins without the code (the dashboard widget) */
  compact?: boolean;
  testId?: string;
}

interface Placed {
  key: string;
  members: PlantMapSite[];
  x: number;
  y: number;
}

/** Sites closer than this (px) are drawn as one cluster */
const NEAR = 56;
const worldX = (lon: number, zoom: number) => ((lon + 180) / 360) * 512 * 2 ** zoom;
const worldY = (lat: number, zoom: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 512 * 2 ** zoom;
};
const RANK: Record<PlantMapState, number> = { fail: 0, warn: 1, unknown: 2, ok: 3, none: 4 };
const worst = (list: PlantMapSite[]): PlantMapState => list.reduce<PlantMapState>((w, s) => (RANK[s.state] < RANK[w] ? s.state : w), 'none');

/**
 * Groups the sites in view: a site closer than 56 px (at the whole zoom level, in world pixels – so panning does not
 * regroup) to the first site of a group joins it. In list order, so each group sits where its first site is in the list.
 */
function placeSites(map: MapLibreMap, sites: PlantMapSite[]): Placed[] {
  const zoom = Math.floor(map.getZoom());
  const b = map.getBounds();
  const groups: { x: number; y: number; members: PlantMapSite[] }[] = [];
  for (const s of sites) {
    const g = s.geo!;
    if (!b.contains([g.lon, g.lat])) continue;
    const x = worldX(g.lon, zoom);
    const y = worldY(g.lat, zoom);
    const near = groups.find((c) => Math.abs(c.x - x) < NEAR && Math.abs(c.y - y) < NEAR);
    if (near) near.members.push(s);
    else groups.push({ x, y, members: [s] });
  }
  return groups.map(({ members }) => {
    // a group sits where its sites are on average
    const lon = members.reduce((a, s) => a + s.geo!.lon, 0) / members.length;
    const lat = members.reduce((a, s) => a + s.geo!.lat, 0) / members.length;
    const p = map.project([lon, lat]);
    return { key: members.length === 1 ? members[0]!.id : `c:${members[0]!.id}`, members, x: p.x, y: p.y };
  });
}

export function SitesMap({ sites, config, height, label, focus, onFocused, onFailed, compact, testId = 'sites-map' }: SitesMapProps) {
  const { t, i18n } = useTranslation(['plantMap', 'plant']);
  const nameOf = useNameOf();
  const scheme = useComputedColorScheme('light');
  const { animate } = useMotion();
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const drawn = useMemo(() => sites.filter((s) => s.geo).slice(0, PLANT_MAP_LIMITS.sites), [sites]);
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  const animateRef = useRef(animate);
  animateRef.current = animate;

  const replace = useCallback(() => {
    const m = mapRef.current;
    if (m) setPlaced(placeSites(m, drawnRef.current));
  }, []);

  // ---------- the map itself: once ----------
  useEffect(() => {
    if (!box.current) return;
    const first = drawnRef.current;
    const m = new MapLibreMap({
      container: box.current,
      style: styleUrl(config, scheme, i18n.language),
      transformRequest,
      attributionControl: false,
      maxZoom: config.maxZoom,
      minZoom: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      cooperativeGestures: compact ?? false,
      center: [10, 50],
      zoom: 3,
      locale: {
        'NavigationControl.ZoomIn': t('plantMap:controls.zoomIn'),
        'NavigationControl.ZoomOut': t('plantMap:controls.zoomOut'),
        'NavigationControl.ResetBearing': t('plantMap:controls.north'),
        'Map.Title': label,
        'CooperativeGesturesHandler.WindowsHelpText': t('plantMap:controls.cooperative'),
        'CooperativeGesturesHandler.MacHelpText': t('plantMap:controls.cooperativeMac'),
        'CooperativeGesturesHandler.MobileHelpText': t('plantMap:controls.cooperativeMobile'),
      },
    });
    m.touchZoomRotate.disableRotation();
    m.keyboard.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = m;
    // where the sites are: all of them in view (a single one with its own zoom)
    const pts = first.map((s) => [s.geo!.lon, s.geo!.lat] as [number, number]);
    if (pts.length === 1) m.jumpTo({ center: pts[0], zoom: Math.min(first[0]!.geo!.zoom ?? 14, config.maxZoom) });
    else if (pts.length > 1) {
      const bounds = pts.reduce((b, p) => b.extend(p), new LngLatBounds(pts[0], pts[0]));
      m.fitBounds(bounds, { padding: { top: 80, bottom: 56, left: 72, right: 72 }, maxZoom: Math.min(12, config.maxZoom), duration: 0 });
    }
    let tileOk = false;
    let tileErrors = 0;
    m.on('load', () => {
      setReady(true);
      replace();
    });
    m.on('data', (e) => {
      if ((e as { tile?: unknown }).tile) tileOk = true;
    });
    m.on('error', (e) => {
      const err = e.error as (Error & { status?: number; url?: string }) | undefined;
      // a missing tile is no failure (the file or source has none there)
      if (err?.status === 404) return;
      const isTile = !!(e as { tile?: unknown }).tile || !!(e as { sourceId?: unknown }).sourceId;
      if (!isTile) return failedRef.current?.('load');
      tileErrors++;
      if (!tileOk && tileErrors >= 3) failedRef.current?.('load');
    });
    let frame = 0;
    const onMove = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(replace);
    };
    m.on('move', onMove);
    m.on('resize', onMove);
    // a card belongs to where it was opened: moving the map closes it
    m.on('dragstart', () => setOpen(null));
    m.on('zoomstart', (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) setOpen(null);
    });
    return () => {
      cancelAnimationFrame(frame);
      m.remove();
      mapRef.current = null;
    };
    // the map is made once; theme, sites and focus follow below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- the theme: the light or dark style ----------
  const firstStyle = useRef(true);
  useEffect(() => {
    if (firstStyle.current) {
      firstStyle.current = false;
      return;
    }
    mapRef.current?.setStyle(styleUrl(config, scheme, i18n.language));
  }, [config, scheme, i18n.language]);

  // ---------- the sites (filters of the list) ----------
  useEffect(() => {
    if (ready) replace();
  }, [drawn, ready, replace]);

  // ---------- Show on map ----------
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready || !focus) return;
    const s = drawnRef.current.find((x) => x.id === focus);
    if (!s) return;
    const opts = { center: [s.geo!.lon, s.geo!.lat] as [number, number], zoom: Math.min(s.geo!.zoom ?? 15, config.maxZoom) };
    const done = () => {
      replace();
      setOpen(s.id);
      onFocused?.();
    };
    if (animateRef.current) {
      m.once('moveend', done);
      m.flyTo({ ...opts, duration: 900 });
    } else {
      m.jumpTo(opts);
      done();
    }
  }, [focus, ready, config.maxZoom, onFocused, replace]);

  const zoomInto = (members: PlantMapSite[]) => {
    const m = mapRef.current;
    if (!m) return;
    const pts = members.map((s) => [s.geo!.lon, s.geo!.lat] as [number, number]);
    const bounds = pts.reduce((b, p) => b.extend(p), new LngLatBounds(pts[0], pts[0]));
    const z = Math.min(m.getZoom() + 2, config.maxZoom);
    const same = pts.every((p) => p[0] === pts[0]![0] && p[1] === pts[0]![1]);
    if (same) m.easeTo({ center: pts[0], zoom: Math.min(m.getZoom() + 3, config.maxZoom), duration: animateRef.current ? 500 : 0 });
    else m.fitBounds(bounds, { padding: 80, maxZoom: Math.max(z, Math.min(16, config.maxZoom)), duration: animateRef.current ? 600 : 0 });
  };

  const visibleCount = placed.reduce((a, p) => a + p.members.length, 0);
  return (
    <div className="pm-wrap" style={{ height }} data-testid={testId} data-ready={ready || undefined}>
      <div ref={box} className="pm-map" />
      <div className="pm-pins" role="group" aria-label={t('plantMap:pinsLabel', { count: visibleCount })} data-testid="map-pins">
        {placed.map((p) => {
          const state = worst(p.members);
          const I = STATE_ICON[state];
          if (p.members.length > 1)
            return (
              <button
                key={p.key}
                type="button"
                className="pm-cluster"
                data-state={state}
                style={{ transform: `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)` }}
                aria-label={t('plantMap:cluster', { count: p.members.length, state: t(`plantMap:state.${state}`) })}
                onClick={() => zoomInto(p.members)}
                data-testid="map-cluster"
              >
                <I size={14} aria-hidden style={{ color: STATE_VAR[state] }} />
                <span>{p.members.length}</span>
              </button>
            );
          const s = p.members[0]!;
          const name = nameOf(s);
          return (
            <Popover
              key={p.key}
              opened={open === s.id}
              onChange={(o) => setOpen(o ? s.id : null)}
              position="top"
              withArrow
              shadow="md"
              trapFocus
              returnFocus
              closeOnEscape
              width={280}
              withinPortal
            >
              <Popover.Target>
                <button
                  type="button"
                  className="pm-pin"
                  data-state={state}
                  data-compact={compact || undefined}
                  style={{ transform: `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)` }}
                  aria-label={pinName(t, s, name)}
                  aria-expanded={open === s.id}
                  aria-haspopup="dialog"
                  onClick={() => setOpen(open === s.id ? null : s.id)}
                  data-testid={`map-pin-${s.id}`}
                >
                  <I size={compact ? 14 : 16} aria-hidden style={{ color: STATE_VAR[state] }} />
                  {!compact && <span className="pm-pin-text">{s.code || name}</span>}
                </button>
              </Popover.Target>
              <Popover.Dropdown role="dialog" aria-label={name} data-testid="map-card">
                <SiteCard site={s} name={name} />
              </Popover.Dropdown>
            </Popover>
          );
        })}
      </div>
      <MapAttribution cfg={config} />
    </div>
  );
}

/** The card of a pin: name, code, assets by status, KPI coverage, open checks, links into the site and its views. */
function SiteCard({ site, name }: { site: PlantMapSite; name: string }) {
  const { t } = useTranslation(['plantMap', 'plantViews']);
  const pct = coveragePct(site.coverage);
  const base = `/plant/sites/${encodeURIComponent(site.id)}`;
  return (
    <Stack gap={8}>
      <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
        <Anchor component={Link} to={base} fw={600} style={{ overflowWrap: 'anywhere' }} data-autofocus>
          {name}
        </Anchor>
        {site.code && (
          <Badge variant="default" size="sm">
            {site.code}
          </Badge>
        )}
      </Group>
      <MapStateLabel state={site.state} />
      <Stack gap={4}>
        <Text size="xs" c="dimmed">
          {t('plantMap:card.assets', { count: site.total })}
        </Text>
        <StatusBar counts={site.counts} height={6} />
      </Stack>
      <Group gap="md">
        <Text size="xs">{pct === null ? t('plantMap:card.noCoverage') : t('plantMap:card.coverage', { pct })}</Text>
        <Text size="xs">{t('plantViews:tiles.checks', { count: site.checks })}</Text>
      </Group>
      <Group gap="xs">
        <Button size="compact-xs" variant="light" component={Link} to={base} rightSection={<IconArrowRight size={12} aria-hidden />}>
          {t('plantMap:card.open')}
        </Button>
        <Button size="compact-xs" variant="default" component={Link} to={`${base}/structure`}>
          {t('plantMap:card.structure')}
        </Button>
        <Button size="compact-xs" variant="default" component={Link} to={`${base}/network`}>
          {t('plantMap:card.network')}
        </Button>
      </Group>
    </Stack>
  );
}

export default SitesMap;
