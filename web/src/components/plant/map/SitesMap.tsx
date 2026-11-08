import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
 * zooms into a cluster. Only what is in view is shown (and focusable); half a view around it is drawn hidden, so pins
 * do not come late while panning. Their positions follow the map in its own `move`, outside React: React renders only
 * when the groups change. Clusters count only the sites given – the sites the reader may see. prefers-reduced-motion
 * or "Animation off" turns every camera animation into a jump.
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

/** A pin (one site) or a cluster, anchored where its sites are on average. Its pixel position is never React state. */
interface Group {
  key: string;
  members: PlantMapSite[];
  lon: number;
  lat: number;
}
interface Layout {
  groups: Group[];
  /** Sites of the groups whose anchor is in view (the name of the pins' region) */
  inView: number;
}
/** Where the groups were made: the zoom, the view's centre in world pixels at that zoom, and the view's size */
interface Made {
  z: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
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
const inside = (p: { x: number; y: number }, w: number, h: number) => p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h;

/**
 * Groups the sites in view and half a view around it (so panning does not show pins late): a site closer than 56 px
 * (at the whole zoom level, in world pixels – so panning does not regroup) to the first site of a group joins it. In
 * list order, so each group sits where its first site is in the list.
 */
function groupSites(map: MapLibreMap, sites: PlantMapSite[], w: number, h: number): Layout {
  const zoom = Math.floor(map.getZoom());
  const found: { x: number; y: number; members: PlantMapSite[] }[] = [];
  for (const s of sites) {
    const g = s.geo!;
    const p = map.project([g.lon, g.lat]);
    if (p.x < -w / 2 || p.y < -h / 2 || p.x > w * 1.5 || p.y > h * 1.5) continue;
    const x = worldX(g.lon, zoom);
    const y = worldY(g.lat, zoom);
    const near = found.find((c) => Math.abs(c.x - x) < NEAR && Math.abs(c.y - y) < NEAR);
    if (near) near.members.push(s);
    else found.push({ x, y, members: [s] });
  }
  let inView = 0;
  const groups = found.map(({ members }) => {
    // a group sits where its sites are on average
    const lon = members.reduce((a, s) => a + s.geo!.lon, 0) / members.length;
    const lat = members.reduce((a, s) => a + s.geo!.lat, 0) / members.length;
    if (inside(map.project([lon, lat]), w, h)) inView += members.length;
    return { key: members.length === 1 ? members[0]!.id : `c:${members[0]!.id}`, members, lon, lat };
  });
  return { groups, inView };
}

const sameLayout = (a: Layout, b: Layout) =>
  a.inView === b.inView &&
  a.groups.length === b.groups.length &&
  a.groups.every((g, i) => {
    const o = b.groups[i]!;
    return g.key === o.key && g.members.length === o.members.length && g.members.every((s, j) => s === o.members[j]);
  });

/**
 * Whether the groups can have changed since they were made: another whole zoom level, or the view has moved (or grown)
 * more than a quarter of a view – half a view of sites around it is drawn, so the next pins are there before they show.
 */
function regroupDue(map: MapLibreMap, made: Made | null): boolean {
  if (!made) return true;
  const z = map.getZoom();
  if (Math.floor(z) !== Math.floor(made.z)) return true;
  const k = 2 ** (made.z - z);
  const c = map.getCenter();
  const dx = Math.abs(worldX(c.lng, made.z) - made.cx);
  const dy = Math.abs(worldY(c.lat, made.z) - made.cy);
  return dx + (made.w / 2) * k > made.w * 0.75 || dy + (made.h / 2) * k > made.h * 0.75;
}

/** UI tests set `window.__stewardTestHooks = true` before the page loads; then the map element carries the map. */
const testHooks = () => (window as { __stewardTestHooks?: unknown }).__stewardTestHooks === true;

export function SitesMap({ sites, config, height, label, focus, onFocused, onFailed, compact, testId = 'sites-map' }: SitesMapProps) {
  const { t, i18n } = useTranslation(['plantMap', 'plant']);
  const nameOf = useNameOf();
  const scheme = useComputedColorScheme('light');
  const { animate } = useMotion();
  const cardId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [layout, setLayout] = useState<Layout>({ groups: [], inView: 0 });
  const layoutRef = useRef(layout);
  const madeRef = useRef<Made | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  /** The pins and clusters in the DOM, by key, with what they show */
  const pinsRef = useRef(new Map<string, { el: HTMLButtonElement; g: Group }>());
  const [open, setOpen] = useState<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  /** The open site's pin: the card's anchor lives inside it, so the card goes where the pin goes */
  const [host, setHost] = useState<{ id: string; el: HTMLButtonElement } | null>(null);
  const commits = useRef(0);
  const drawn = useMemo(() => sites.filter((s) => s.geo).slice(0, PLANT_MAP_LIMITS.sites), [sites]);
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  const animateRef = useRef(animate);
  animateRef.current = animate;

  /**
   * Puts every pin where its sites are, straight in the DOM – called in the map's own `move`, so the pins move in the
   * frame the map is drawn in (as MapLibre's markers do). A pin whose anchor is out of view is hidden: not focusable,
   * not announced. Whole pixels once the map stands still (sharp text), fractions while it moves (smooth).
   */
  const position = useCallback((round: boolean) => {
    const m = mapRef.current;
    if (!m) return;
    const { w, h } = sizeRef.current;
    for (const { el, g } of pinsRef.current.values()) {
      const p = m.project([g.lon, g.lat]);
      const x = round ? Math.round(p.x) : p.x;
      const y = round ? Math.round(p.y) : p.y;
      el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, ${g.members.length > 1 ? '-50%' : '-100%'})`;
      const off = !inside(p, w, h);
      if (el.hasAttribute('data-off') !== off) el.toggleAttribute('data-off', off);
    }
  }, []);

  /** Makes the groups anew; React renders only when they differ (which sites, which clusters, how many in view). */
  const regroup = useCallback(() => {
    const m = mapRef.current;
    if (!m) return;
    const { w, h } = sizeRef.current;
    const c = m.getCenter();
    const z = m.getZoom();
    madeRef.current = { z, cx: worldX(c.lng, z), cy: worldY(c.lat, z), w, h };
    const next = groupSites(m, drawnRef.current, w, h);
    if (sameLayout(layoutRef.current, next)) return;
    layoutRef.current = next;
    setLayout(next);
  }, []);

  /** Closes the card; focus goes back to its pin when it would be lost otherwise (Escape, a link inside that is gone). */
  const closeCard = useCallback(() => {
    const id = openRef.current;
    if (!id) return;
    const pin = pinsRef.current.get(id)?.el;
    setOpen(null);
    window.setTimeout(() => {
      const a = document.activeElement;
      if (pin?.isConnected && (!a || a === document.body)) pin.focus({ preventScroll: true });
    }, 10);
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
    const measure = () => {
      const c = m.getContainer();
      sizeRef.current = { w: c.clientWidth, h: c.clientHeight };
    };
    measure();
    if (testHooks() && wrap.current)
      Object.defineProperty(wrap.current, '__steward', { value: { map: m, commits: () => commits.current }, configurable: true });
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
      measure();
      regroup();
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
    // the pins follow in the same frame; the groups are made anew at most once a frame, and only when they can change
    let frame = 0;
    m.on('move', () => {
      position(false);
      if (!frame && regroupDue(m, madeRef.current))
        frame = requestAnimationFrame(() => {
          frame = 0;
          regroup();
        });
    });
    m.on('moveend', () => {
      cancelAnimationFrame(frame);
      frame = 0;
      regroup();
      position(true);
    });
    m.on('resize', () => {
      measure();
      regroup();
      position(!m.isMoving());
    });
    // a card belongs to where it was opened: moving the map closes it
    m.on('dragstart', closeCard);
    m.on('zoomstart', (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) closeCard();
    });
    return () => {
      cancelAnimationFrame(frame);
      m.remove();
      mapRef.current = null;
    };
    // the map is made once; theme, sites and focus follow below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- new pins: where they belong before they are painted; the open site's pin ----------
  useLayoutEffect(() => {
    position(!mapRef.current?.isMoving());
    const el = open ? pinsRef.current.get(open)?.el : undefined;
    setHost((h) => (h?.el === el ? h : open && el ? { id: open, el } : null));
  }, [layout, open, position]);
  useEffect(() => {
    if (testHooks()) commits.current++;
  });

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
    if (ready) regroup();
  }, [drawn, ready, regroup]);

  // ---------- Show on map ----------
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready || !focus) return;
    const s = drawnRef.current.find((x) => x.id === focus);
    if (!s) return;
    const opts = { center: [s.geo!.lon, s.geo!.lat] as [number, number], zoom: Math.min(s.geo!.zoom ?? 15, config.maxZoom) };
    const done = () => {
      regroup();
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
  }, [focus, ready, config.maxZoom, onFocused, regroup]);

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

  /** Registers a pin's element for `position` (React 19 ref cleanup when it goes) */
  const pinRef = (g: Group) => (el: HTMLButtonElement | null) => {
    if (!el) return;
    pinsRef.current.set(g.key, { el, g });
    return () => {
      if (pinsRef.current.get(g.key)?.el === el) pinsRef.current.delete(g.key);
    };
  };

  const openSite = open ? layout.groups.find((g) => g.key === open && g.members.length === 1)?.members[0] : undefined;
  return (
    <div ref={wrap} className="pm-wrap" style={{ height }} data-testid={testId} data-ready={ready || undefined}>
      <div ref={box} className="pm-map" />
      <div className="pm-pins" role="group" aria-label={t('plantMap:pinsLabel', { count: layout.inView })} data-testid="map-pins">
        {layout.groups.map((g) => {
          const state = worst(g.members);
          const I = STATE_ICON[state];
          if (g.members.length > 1)
            return (
              <button
                key={g.key}
                ref={pinRef(g)}
                type="button"
                className="pm-cluster"
                data-state={state}
                aria-label={t('plantMap:cluster', { count: g.members.length, state: t(`plantMap:state.${state}`) })}
                onClick={() => zoomInto(g.members)}
                data-testid="map-cluster"
              >
                <I size={14} aria-hidden style={{ color: STATE_VAR[state] }} />
                <span>{g.members.length}</span>
              </button>
            );
          const s = g.members[0]!;
          const name = nameOf(s);
          const isOpen = open === s.id;
          return (
            <button
              key={g.key}
              ref={pinRef(g)}
              type="button"
              className="pm-pin"
              data-state={state}
              data-compact={compact || undefined}
              aria-label={pinName(t, s, name)}
              aria-expanded={isOpen}
              aria-haspopup="dialog"
              aria-controls={isOpen && host?.id === s.id ? cardId : undefined}
              onClick={() => (isOpen ? closeCard() : setOpen(s.id))}
              data-testid={`map-pin-${s.id}`}
            >
              <I size={compact ? 14 : 16} aria-hidden style={{ color: STATE_VAR[state] }} />
              {!compact && <span className="pm-pin-text">{s.code || name}</span>}
            </button>
          );
        })}
        {/* one card for the open site, its anchor portalled into that pin (covering it: a click on the pin closes it) */}
        {openSite &&
          host?.id === openSite.id &&
          createPortal(
            <Popover
              opened
              onChange={(o) => !o && closeCard()}
              position="top"
              withArrow
              shadow="md"
              trapFocus
              closeOnEscape
              width={280}
              withinPortal
              withRoles={false}
            >
              <Popover.Target>
                <span className="pm-anchor" aria-hidden onClick={closeCard} />
              </Popover.Target>
              <Popover.Dropdown id={cardId} role="dialog" aria-label={nameOf(openSite)} data-testid="map-card">
                <SiteCard site={openSite} name={nameOf(openSite)} />
              </Popover.Dropdown>
            </Popover>,
            host.el,
            openSite.id,
          )}
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
