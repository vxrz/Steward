import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { Anchor, Badge, Box, Group, Paper, SegmentedControl, SimpleGrid, Stack, Table, Text, Title, UnstyledButton } from '@mantine/core';
import { useElementSize, useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { IconChartTreemap, IconChevronRight, IconSitemap } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ASSET_STATUSES, LEVEL_RECORD_TYPE, type AssetStatus, type PlantStructure, type PlantStructureAsset, type PlantStructureNode } from '@sm/shared';
import { get } from '../../../api';
import { EmptyState, QueryState } from '../../../components/common';
import { plantKeys } from '../../../queryKeys';
import { AssetStatusBadge, useNameOf, usePlantLabel } from '../../../components/plant/common';
import { LegendItem, LiveBadge, LIVE_ICON, StatusBar, StatusRing, ViewLegend, ViewToolbar, liveVar, ringArcs, statusVar, useLiveCounts } from './common';
import { clip, cssColor, escapeXml, exportTheme, svgDocument } from './exportImage';
import { LIVE_REFRESH_MS, useMotion, useViewMode } from './prefs';
import { inset, squarify, type Rect } from './treemap';

/**
 * The structure of a site (#230, site page → Structure): the ISA-95 hierarchy (areas → work centers → work units) as a
 * zoomable treemap – each tile sized by its assets, with their count and a status ring (documented lifecycle status;
 * an inner ring for linked monitors where there are any) – or the buildings as the other grouping (IEC 81346: location
 * instead of function). A click drills down, the breadcrumb goes back; the table says the same in rows.
 */

type By = 'function' | 'location';
const UNPLACED = '__unplaced';

interface Tile {
  id: string;
  name: string;
  levelText: string;
  node: PlantStructureNode | null;
  counts: Partial<Record<AssetStatus, number>>;
  total: number;
  live: PlantStructureNode['live'];
  childCount: number;
  value: number;
}

const sum = (c: Partial<Record<string, number>>) => Object.values(c).reduce<number>((a, b) => a + (b ?? 0), 0);

export function SiteStructureView({ siteId }: { siteId: string }) {
  const { t } = useTranslation(['plantViews', 'plant']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const liveCounts = useLiveCounts();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [params, setParams] = useSearchParams();
  const by: By = params.get('by') === 'location' ? 'location' : 'function';
  const focus = params.get('node');
  const [mode, setMode] = useViewMode('site-structure');
  const q = useQuery({
    queryKey: plantKeys.structure(siteId),
    queryFn: () => get<PlantStructure>(`/plant/sites/${encodeURIComponent(siteId)}/structure`),
    refetchInterval: LIVE_REFRESH_MS,
  });
  const s = q.data;
  const nodes = useMemo(() => new Map((s ? s[by] : []).map((n) => [n.id, n])), [s, by]);
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'by') next.delete('node');
    setParams(next, { replace: k === 'by' });
  };
  const levelText = (n: PlantStructureNode) =>
    n.level === 'building' ? t(`plant:buildingKinds.${n.type as 'hall'}`, { defaultValue: label('building') }) : label(LEVEL_RECORD_TYPE[n.level]);
  if (!s) return <QueryState query={q} />;
  const current = focus === UNPLACED ? null : focus ? (nodes.get(focus) ?? null) : null;
  const roots = s[by].filter((n) => (by === 'function' ? n.level === 'area' && !n.parentId : !n.parentId || !nodes.has(n.parentId)));
  const children = current ? current.childIds.map((id) => nodes.get(id)!).filter(Boolean) : focus === UNPLACED ? [] : roots;
  const unplaced = s.unplaced[by];
  const tileOf = (n: PlantStructureNode): Tile => ({
    id: n.id,
    name: nameOf(n),
    levelText: levelText(n),
    node: n,
    counts: n.counts,
    total: n.total,
    live: n.live,
    childCount: n.childIds.length,
    value: 0,
  });
  const tiles: Tile[] = children.map(tileOf);
  const unplacedName = by === 'function' ? t('structure.unplacedFunction') : t('structure.unplacedLocation', { type: label('building', false, true) });
  if (!current && focus !== UNPLACED && sum(unplaced) > 0)
    tiles.push({
      id: UNPLACED,
      name: unplacedName,
      levelText: '',
      node: null,
      counts: unplaced,
      total: sum(unplaced),
      live: {},
      childCount: 0,
      value: 0,
    });
  const max = Math.max(1, ...tiles.map((x) => x.total));
  const floor = Math.max(0.5, max * 0.07);
  for (const x of tiles) x.value = Math.max(x.total, floor);
  // the way back: the site, then the parents of the focus
  const trail: { id: string | null; name: string }[] = [{ id: null, name: nameOf(s.site) }];
  if (focus === UNPLACED) trail.push({ id: UNPLACED, name: unplacedName });
  else {
    const up: PlantStructureNode[] = [];
    for (let n = current; n && up.length < 12; n = n.parentId ? (nodes.get(n.parentId) ?? null) : null) up.unshift(n);
    trail.push(...up.map((n) => ({ id: n.id, name: nameOf(n) })));
  }
  // the assets of a node and everything below it (the dots of a tile)
  const byNode = new Map<string, PlantStructureAsset[]>();
  for (const a of s.assets) {
    const at = by === 'function' ? a.nodeId : a.buildingId;
    if (at) byNode.set(at, [...(byNode.get(at) ?? []), a]);
  }
  const assetsUnder = (id: string): PlantStructureAsset[] => {
    if (id === UNPLACED) return s.assets.filter((a) => (by === 'function' ? a.nodeId : a.buildingId) === null);
    const out: PlantStructureAsset[] = [];
    const walk = (nid: string, depth: number) => {
      out.push(...(byNode.get(nid) ?? []));
      if (depth < 10) for (const c of nodes.get(nid)?.childIds ?? []) walk(c, depth + 1);
    };
    walk(id, 0);
    return out;
  };
  const leafAssets = s.assets.filter((a) => {
    const at = by === 'function' ? a.nodeId : a.buildingId;
    return focus === UNPLACED ? at === null : !!current && at === current.id;
  });
  const empty = s[by].length === 0 && s.total === 0;
  const scope = current ?? null;
  const scopeCounts = scope ? scope.counts : focus === UNPLACED ? unplaced : s.counts;
  const scopeTotal = scope ? scope.total : focus === UNPLACED ? sum(unplaced) : s.total;
  const scopeLive = scope ? scope.live : focus === UNPLACED ? {} : s.live;
  const statusText = (c: Partial<Record<AssetStatus, number>>) =>
    ASSET_STATUSES.filter((x) => c[x])
      .map((x) => `${t(`plant:status.${x}`)} ${c[x]}`)
      .join(', ');
  const tileAria = (x: Tile) =>
    [
      `${x.levelText ? `${x.levelText} ` : ''}${x.name}`,
      t('structure.assets', { count: x.total }),
      statusText(x.counts),
      sum(x.live) ? `${t('structure.liveWord')}: ${liveCounts(x.live)}` : '',
      x.node?.childIds.length ? t('structure.contains', { names: x.node.childIds.map((id) => nameOf(nodes.get(id))).join(', ') }) : '',
      x.childCount ? t('structure.drill') : '',
    ]
      .filter(Boolean)
      .join('. ');
  return (
    <Stack gap="sm" data-testid="site-structure">
      <div>
        <Title order={2} fz="h4">
          {t('structure.title')}
        </Title>
        <Text size="xs" c="dimmed">
          {t('structure.help', { type: label('asset', true, true) })}
        </Text>
      </div>
      {empty ? (
        <EmptyState icon={IconSitemap} title={t('structure.emptyTitle')} testId="structure-empty">
          {t('structure.emptyText', { areas: label('area', true, true), assets: label('asset', true, true) })}
        </EmptyState>
      ) : (
        <>
          <ViewToolbar mode={mode} onMode={setMode} motion={false} pictureIcon={IconChartTreemap} onExport={mode === 'picture' ? () => exportMap() : null}>
            <SegmentedControl
              size="xs"
              value={by}
              onChange={(v) => setParam('by', v === 'location' ? 'location' : null)}
              aria-label={t('structure.groupBy')}
              data={[
                { value: 'function', label: t('structure.byFunction') },
                { value: 'location', label: t('structure.byLocation', { type: label('building', true) }) },
              ]}
              data-testid="structure-by"
            />
          </ViewToolbar>
          <Group gap={4} component="nav" aria-label={t('structure.trail')} data-testid="structure-trail" wrap="wrap">
            {trail.map((c, i) => (
              <Group key={c.id ?? 'site'} gap={4} wrap="nowrap">
                {i > 0 && <IconChevronRight size={12} aria-hidden />}
                {i === trail.length - 1 ? (
                  <Text size="sm" fw={600} aria-current="location">
                    {c.name}
                  </Text>
                ) : (
                  <Anchor component="button" type="button" size="sm" onClick={() => setParam('node', c.id)}>
                    {c.name}
                  </Anchor>
                )}
              </Group>
            ))}
          </Group>
          <Paper withBorder p="sm" radius="md">
            <Group justify="space-between" gap="sm" wrap="wrap" mb={6}>
              <Text size="sm" fw={600}>
                {t('structure.assets', { count: scopeTotal })}
              </Text>
              <Group gap="sm" wrap="wrap">
                {sum(scopeLive) > 0 && <LiveSummary live={scopeLive} />}
                <Text size="xs" c="dimmed">
                  {statusText(scopeCounts) || t('noAssets')}
                </Text>
              </Group>
            </Group>
            <StatusBar counts={scopeCounts} />
          </Paper>
          {mode === 'picture' ? (
            <>
              {tiles.length > 0 && (
                <TreeMap
                  tiles={tiles}
                  height={narrow ? 340 : 440}
                  zoomKey={`${by}:${focus ?? ''}`}
                  onDrill={(id) => setParam('node', id)}
                  onUp={() => setParam('node', trail.length > 1 ? (trail[trail.length - 2]!.id ?? null) : null)}
                  aria={tileAria}
                  label={t('structure.mapLabel', { name: trail[trail.length - 1]!.name })}
                  liveText={liveCounts}
                  assetsText={(n) => t('structure.assets', { count: n })}
                  childOf={(id) => nodes.get(id)}
                  assetsUnder={assetsUnder}
                  statusWord={(st) => t(`plant:status.${st}`)}
                  nameOf={(n) => nameOf(n)}
                />
              )}
              {(leafAssets.length > 0 || (!!current && tiles.length === 0)) && (
                <LeafAssets
                  assets={leafAssets}
                  title={tiles.length ? t('structure.directly', { type: label('asset', true) }) : label('asset', true)}
                  siteId={siteId}
                  nodeId={by === 'function' && current ? current.id : null}
                  truncated={s.assetsTruncated}
                />
              )}
            </>
          ) : (
            <StructureTable
              s={s}
              by={by}
              nodes={nodes}
              roots={roots}
              levelText={levelText}
              statusText={statusText}
              narrow={narrow}
              onOpen={(id) => {
                setMode('picture');
                setParam('node', id);
              }}
            />
          )}
          <ViewLegend live={t('structure.live')} testId="structure-legend">
            {ASSET_STATUSES.map((x) => (
              <LegendItem key={x} mark={<span style={{ width: 10, height: 10, borderRadius: 2, background: statusVar(x), display: 'inline-block' }} />}>
                {t(`plant:status.${x}`)}
              </LegendItem>
            ))}
            <LegendItem mark={<StatusRing counts={{ operational: 3, maintenance: 1 }} live={{ ok: 1, fail: 1 }} size={22} label="" />}>
              {t('structure.ringLegend')}
            </LegendItem>
          </ViewLegend>
        </>
      )}
    </Stack>
  );

  function exportMap() {
    const width = 960;
    const height = 560;
    const th = exportTheme();
    const laid = squarify(tiles, { x: 16, y: 8, w: width - 32, h: height - 16 });
    const body = laid
      .map((x) => {
        const r = inset(x.rect, 3);
        const arcs = ringArcs(
          ASSET_STATUSES.map((st) => ({ value: x.counts[st] ?? 0, color: cssColor(`--pv-${st}`) })),
          14,
        );
        const ring =
          r.w > 110 && r.h > 60
            ? `<g transform="translate(${r.x + r.w - 24} ${r.y + 24})">${arcs.map((a) => `<path d="${a.d}" fill="none" stroke="${a.color}" stroke-width="5"/>`).join('')}</g>`
            : '';
        const chars = Math.max(4, Math.floor((r.w - (ring ? 56 : 16)) / 7.2));
        return [
          `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="8" fill="${cssColor('--pv-tile', th.surface)}" stroke="${th.border}"/>`,
          r.h > 30 ? `<text x="${r.x + 10}" y="${r.y + 21}" font-size="13" font-weight="600" fill="${th.text}">${escapeXml(clip(x.name, chars))}</text>` : '',
          r.h > 48
            ? `<text x="${r.x + 10}" y="${r.y + 38}" font-size="11" fill="${th.dimmed}">${escapeXml(clip(`${t('structure.assets', { count: x.total })}${x.levelText ? ` · ${x.levelText}` : ''}`, chars + 6))}</text>`
            : '',
          ring,
        ].join('');
      })
      .join('');
    const title = t('structure.exportTitle', { name: trail.map((c) => c.name).join(' › ') });
    return {
      svg: svgDocument({
        width,
        height,
        title,
        subtitle: `${statusText(scopeCounts)} · ${t(by === 'function' ? 'structure.byFunction' : 'structure.byLocationPlain')}`,
        body,
      }),
      width,
      height: height + 44,
      title,
    };
  }
}

function LiveSummary({ live }: { live: PlantStructureNode['live'] }) {
  const { t } = useTranslation('plantViews');
  return (
    <Group gap={8} wrap="wrap" data-testid="structure-live">
      {(['fail', 'warn', 'unknown', 'ok'] as const)
        .filter((x) => live[x])
        .map((x) => {
          const I = LIVE_ICON[x];
          return (
            <Group key={x} gap={3} wrap="nowrap">
              <I size={14} aria-hidden style={{ color: liveVar(x) }} />
              <Text size="xs">{t(`liveCount.${x}`, { count: live[x] })}</Text>
            </Group>
          );
        })}
    </Group>
  );
}

/** The tiles of one level: squarified, focusable, a click or Enter drills down (with a short zoom, unless reduced). */
function TreeMap({
  tiles,
  height,
  zoomKey,
  onDrill,
  onUp,
  aria,
  label,
  liveText,
  assetsText,
  childOf,
  nameOf,
  assetsUnder,
  statusWord,
}: {
  tiles: Tile[];
  /** A child of a tile (its inner preview) */
  childOf: (id: string) => PlantStructureNode | undefined;
  nameOf: (n: PlantStructureNode) => string;
  assetsUnder: (id: string) => PlantStructureAsset[];
  statusWord: (s: AssetStatus) => string;
  height: number;
  zoomKey: string;
  onDrill: (id: string) => void;
  onUp: () => void;
  aria: (x: Tile) => string;
  label: string;
  liveText: (l: Tile['live']) => string;
  assetsText: (n: number) => string;
}) {
  const { ref, width } = useElementSize();
  const { animate } = useMotion();
  const stage = useRef<SVGGElement>(null);
  const from = useRef<Rect | null>(null);
  const firstTile = useRef<SVGRectElement>(null);
  const viaKeyboard = useRef(false);
  const w = Math.max(width, 1);
  const laid = useMemo(() => squarify(tiles, { x: 0, y: 0, w, h: height }), [tiles, w, height]);
  // zoom in: the new level grows out of the tile that was opened
  useLayoutEffect(() => {
    const g = stage.current;
    const r = from.current;
    from.current = null;
    if (!g || !r || !animate || r.w <= 0) return;
    g.style.transition = 'none';
    g.style.transform = `translate(${r.x}px, ${r.y}px) scale(${r.w / w}, ${r.h / height})`;
    const raf = requestAnimationFrame(() => {
      g.style.transition = '';
      g.style.transform = '';
    });
    return () => cancelAnimationFrame(raf);
  }, [zoomKey]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the level changes
  useEffect(() => {
    if (viaKeyboard.current) firstTile.current?.focus();
    viaKeyboard.current = false;
  }, [zoomKey]);
  const drillable = (x: Tile) => x.childCount > 0 || x.id === UNPLACED || !!x.node?.own;
  const firstDrillable = laid.find(drillable)?.id;
  const open = (x: Tile & { rect: Rect }, keyboard: boolean) => {
    if (!drillable(x)) return;
    from.current = x.rect;
    viaKeyboard.current = keyboard;
    onDrill(x.id);
  };
  const onKey = (ev: KeyboardEvent<SVGRectElement>, x: Tile & { rect: Rect }) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      open(x, true);
    }
  };
  return (
    <Box
      ref={ref}
      className="pv-map"
      h={height}
      data-testid="structure-map"
      onKeyDown={(ev) => {
        if (ev.key === 'Escape' || ev.key === 'Backspace') {
          viaKeyboard.current = true;
          onUp();
        }
      }}
    >
      {width > 0 && (
        <svg width={w} height={height} role="group" aria-label={label} style={{ display: 'block' }}>
          <g ref={stage} className="pv-map-stage">
            {laid.map((x) => {
              const r = inset(x.rect, 3);
              const leaf = !drillable(x);
              const big = r.w > 120 && r.h > 76;
              const ring = r.w > 96 && r.h > 56;
              const chars = Math.max(3, Math.floor((r.w - (ring ? 58 : 18)) / 7.4));
              const live = liveText(x.live);
              const inner =
                big && x.node && x.childCount > 0
                  ? squarify(
                      x.node.childIds.map((id) => ({ id, value: Math.max(childOf(id)?.total ?? 0, 0.5) })),
                      { x: r.x + 10, y: r.y + 58, w: r.w - 20, h: r.h - 68 },
                    )
                  : [];
              return (
                <g key={x.id} className="pv-tile" data-leaf={leaf || undefined} onClick={() => open(x, false)}>
                  {/* the tile's stop for the keyboard and its name: the background, so its texts are only the picture */}
                  <rect
                    ref={x.id === firstDrillable ? firstTile : undefined}
                    className="pv-tile-bg"
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.h}
                    rx={8}
                    role={leaf ? 'img' : 'button'}
                    tabIndex={leaf ? undefined : 0}
                    aria-label={aria(x)}
                    onKeyDown={(ev) => onKey(ev, x)}
                    data-testid={`tile-${x.id}`}
                  />
                  {inner.map((c) => {
                    const ir = inset(c.rect, 2);
                    const child = childOf(c.id);
                    if (!child || ir.w < 6 || ir.h < 6) return null;
                    let bx = ir.x + 4;
                    const bw = Math.max(0, ir.w - 8);
                    return (
                      <g
                        key={c.id}
                        className="pv-inner-tile"
                        aria-hidden
                        onClick={(ev) => {
                          ev.stopPropagation();
                          from.current = c.rect;
                          onDrill(c.id);
                        }}
                        data-testid={`inner-${c.id}`}
                      >
                        <rect className="pv-inner" x={ir.x} y={ir.y} width={ir.w} height={ir.h} rx={5} />
                        {ir.w > 56 && ir.h > 22 && (
                          <text aria-hidden x={ir.x + 7} y={ir.y + 15} fontSize={11} fontWeight={500}>
                            {clip(nameOf(child), Math.floor((ir.w - 12) / 6.4))}
                          </text>
                        )}
                        {ir.w > 56 && ir.h > 40 && (
                          <text aria-hidden x={ir.x + 7} y={ir.y + 29} fontSize={10} className="pv-dim">
                            {assetsText(child.total)}
                          </text>
                        )}
                        {ir.w > 30 && ir.h > 52 && (
                          <AssetDots assets={assetsUnder(c.id)} box={{ x: ir.x + 7, y: ir.y + 36, w: ir.w - 14, h: ir.h - 48 }} word={statusWord} />
                        )}
                        {ir.h > 18 &&
                          child.total > 0 &&
                          ASSET_STATUSES.filter((st) => child.counts[st]).map((st) => {
                            const w2 = (bw * (child.counts[st] ?? 0)) / child.total;
                            const el = <rect key={st} x={bx} y={ir.y + ir.h - 7} width={Math.max(0, w2 - 1)} height={3} rx={1.5} fill={statusVar(st)} />;
                            bx += w2;
                            return el;
                          })}
                      </g>
                    );
                  })}
                  {r.h > 26 && r.w > 34 && (
                    <text aria-hidden x={r.x + 10} y={r.y + 21} fontSize={13} fontWeight={600}>
                      {clip(x.name, chars)}
                    </text>
                  )}
                  {r.h > 44 && r.w > 60 && (
                    <text aria-hidden x={r.x + 10} y={r.y + 38} fontSize={11} className="pv-dim">
                      {clip(`${assetsText(x.total)}${x.levelText ? ` · ${x.levelText}` : ''}`, chars + 6)}
                    </text>
                  )}
                  {big && live && !inner.length && (
                    <text aria-hidden x={r.x + 10} y={r.y + 54} fontSize={11}>
                      {clip(live, chars + 6)}
                    </text>
                  )}
                  {big && !inner.length && (
                    <AssetDots
                      assets={assetsUnder(x.id)}
                      box={{ x: r.x + 10, y: r.y + (live ? 64 : 50), w: r.w - 20, h: r.h - (live ? 74 : 60) }}
                      word={statusWord}
                    />
                  )}
                  {ring && (
                    <g transform={`translate(${r.x + r.w - 26} ${r.y + 26})`}>
                      {ringArcs(
                        ASSET_STATUSES.map((st) => ({ value: x.counts[st] ?? 0, color: statusVar(st) })),
                        15,
                      ).map((a, j) => (
                        <path key={j} d={a.d} fill="none" stroke={a.color} strokeWidth={5} />
                      ))}
                      {!x.total && <circle r={15} fill="none" stroke="var(--mantine-color-default-border)" strokeWidth={5} />}
                      {ringArcs(
                        (['ok', 'warn', 'fail', 'unknown'] as const).map((st) => ({ value: x.live[st] ?? 0, color: liveVar(st) })),
                        8,
                      ).map((a, j) => (
                        <path key={`l${j}`} d={a.d} fill="none" stroke={a.color} strokeWidth={3} />
                      ))}
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </Box>
  );
}

/** The assets of a tile as small squares in their status colour (level of detail: names on hover and in the list). */
function AssetDots({ assets, box, word }: { assets: PlantStructureAsset[]; box: Rect; word: (s: AssetStatus) => string }) {
  const size = 10;
  const gap = 4;
  const cols = Math.max(1, Math.floor((box.w + gap) / (size + gap)));
  const rows = Math.max(0, Math.floor((box.h + gap) / (size + gap)));
  const fit = cols * rows;
  if (!fit || !assets.length) return null;
  const shown = assets.length > fit ? assets.slice(0, fit - 1) : assets;
  return (
    <g aria-hidden>
      {shown.map((a, i) => (
        <rect
          key={a.id}
          x={box.x + (i % cols) * (size + gap)}
          y={box.y + Math.floor(i / cols) * (size + gap)}
          width={size}
          height={size}
          rx={3}
          fill={statusVar(a.status)}
          stroke={a.live === 'fail' ? 'var(--pv-fail)' : a.live === 'warn' ? 'var(--pv-warn)' : 'none'}
          strokeWidth={a.live === 'fail' || a.live === 'warn' ? 2 : 0}
        >
          <title>{`${a.name} – ${word(a.status)}`}</title>
        </rect>
      ))}
      {assets.length > fit && (
        <text
          aria-hidden
          x={box.x + ((fit - 1) % cols) * (size + gap)}
          y={box.y + Math.floor((fit - 1) / cols) * (size + gap) + 9}
          fontSize={9}
          className="pv-dim"
        >
          +{assets.length - fit + 1}
        </text>
      )}
    </g>
  );
}

const LEAF_LIMIT = 120;

/** The assets of the innermost level: cards with their status (documented) and live status (where linked). */
function LeafAssets({
  assets,
  title,
  siteId,
  nodeId,
  truncated,
}: {
  assets: PlantStructureAsset[];
  title: string;
  siteId: string;
  nodeId: string | null;
  truncated: boolean;
}) {
  const { t } = useTranslation('plantViews');
  return (
    <Stack gap={6} data-testid="structure-assets">
      <Group justify="space-between" gap="xs">
        <Title order={3} fz="sm">
          {title}
        </Title>
        {nodeId && (
          <Anchor component={Link} size="xs" to={`/plant/assets?site=${encodeURIComponent(siteId)}&node=${encodeURIComponent(nodeId)}`}>
            {t('structure.inList')}
          </Anchor>
        )}
      </Group>
      {assets.length === 0 ? (
        <Text size="sm" c="dimmed">
          {truncated ? t('structure.truncated') : t('noAssets')}
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="xs" role="list" aria-label={title}>
          {assets.slice(0, LEAF_LIMIT).map((a) => (
            <Paper key={a.id} withBorder p="xs" radius="md" role="listitem">
              <Stack gap={4}>
                <UnstyledButton component={Link} to={`/plant/assets/${encodeURIComponent(a.id)}/flow`} fw={500} fz="sm" c="var(--mantine-color-anchor)">
                  {a.name}
                </UnstyledButton>
                <Group gap={4}>
                  <AssetStatusBadge status={a.status} size="xs" />
                  {a.live && <LiveBadge live={{ source: 'monitor', state: a.live, status: LIVE_STATUS[a.live], label: '', path: null, at: null }} size="xs" />}
                </Group>
              </Stack>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {assets.length > LEAF_LIMIT && (
        <Text size="xs" c="dimmed">
          {t('structure.more', { count: assets.length - LEAF_LIMIT })}
        </Text>
      )}
    </Stack>
  );
}

/** A monitor's word for a reduced state (the structure counts states, not the monitors' own words). */
const LIVE_STATUS = { ok: 'up', warn: 'degraded', fail: 'down', unknown: 'unknown' } as const;

/** The hierarchy as rows: name (indented), level, assets, their status in words, live status where linked. */
function StructureTable({
  s,
  by,
  nodes,
  roots,
  levelText,
  statusText,
  narrow,
  onOpen,
}: {
  s: PlantStructure;
  by: By;
  nodes: Map<string, PlantStructureNode>;
  roots: PlantStructureNode[];
  levelText: (n: PlantStructureNode) => string;
  statusText: (c: Partial<Record<AssetStatus, number>>) => string;
  narrow: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation('plantViews');
  const nameOf = useNameOf();
  const liveCounts = useLiveCounts();
  const rows: { n: PlantStructureNode; depth: number }[] = [];
  const walk = (n: PlantStructureNode, depth: number) => {
    rows.push({ n, depth });
    if (depth < 10) for (const id of n.childIds) if (nodes.has(id)) walk(nodes.get(id)!, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  // a row opens the assets list of that part (function); the buildings open the picture at that building
  const name = (n: PlantStructureNode) =>
    by === 'function' ? (
      <Anchor
        component={Link}
        to={`/plant/assets?site=${encodeURIComponent(s.site.id)}&node=${encodeURIComponent(n.id)}`}
        size="sm"
        fw={n.parentId ? 500 : 600}
      >
        {nameOf(n)}
      </Anchor>
    ) : (
      <Anchor component="button" type="button" size="sm" fw={n.parentId ? 500 : 600} onClick={() => onOpen(n.id)} style={{ textAlign: 'left' }}>
        {nameOf(n)}
      </Anchor>
    );
  if (!rows.length)
    return (
      <Text size="sm" c="dimmed">
        {by === 'function' ? t('structure.noNodes') : t('structure.noBuildings')}
      </Text>
    );
  if (narrow)
    return (
      <Stack gap="xs" role="list" aria-label={t('structure.title')} data-testid="structure-table">
        {rows.map(({ n, depth }) => (
          <Paper key={n.id} withBorder p="sm" role="listitem" ml={Math.min(depth, 3) * 12}>
            <Stack gap={4}>
              <Group justify="space-between" gap="xs" wrap="nowrap">
                {name(n)}
                <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                  {levelText(n)}
                </Badge>
              </Group>
              <Text size="xs">{t('structure.assets', { count: n.total })}</Text>
              <StatusBar counts={n.counts} height={6} />
              <Text size="xs" c="dimmed">
                {statusText(n.counts) || t('noAssets')}
              </Text>
              {Object.keys(n.live).length > 0 && <Text size="xs">{liveCounts(n.live)}</Text>}
            </Stack>
          </Paper>
        ))}
      </Stack>
    );
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={t('structure.title')}>
      <Table fz="sm" aria-label={t('structure.title')} data-testid="structure-table">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('table.name')}</Table.Th>
            <Table.Th>{t('structure.level')}</Table.Th>
            <Table.Th>{t('structure.assetsHeader')}</Table.Th>
            <Table.Th miw={180}>{t('structure.statusHeader')}</Table.Th>
            <Table.Th>{t('structure.liveHeader')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map(({ n, depth }) => (
            <Table.Tr key={n.id}>
              <Table.Td style={{ paddingLeft: 8 + depth * 18 }}>{name(n)}</Table.Td>
              <Table.Td>{levelText(n)}</Table.Td>
              <Table.Td>{n.total}</Table.Td>
              <Table.Td>
                <Stack gap={3}>
                  <StatusBar counts={n.counts} height={6} />
                  <Text size="xs" c="dimmed">
                    {statusText(n.counts) || '–'}
                  </Text>
                </Stack>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c={Object.keys(n.live).length ? undefined : 'dimmed'}>
                  {liveCounts(n.live) || t('structure.docOnly')}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
          {s.total > 0 && sum(s.unplaced[by]) > 0 && (
            <Table.Tr>
              <Table.Td fs="italic">{by === 'function' ? t('structure.unplacedFunction') : t('structure.unplacedLocationShort')}</Table.Td>
              <Table.Td>–</Table.Td>
              <Table.Td>{sum(s.unplaced[by])}</Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {statusText(s.unplaced[by])}
                </Text>
              </Table.Td>
              <Table.Td>–</Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </div>
  );
}
