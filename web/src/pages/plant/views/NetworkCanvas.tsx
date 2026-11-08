import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, useComputedColorScheme } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { IconAlertTriangle, IconArrowsMaximize, IconArrowsMinimize, IconX, type Icon } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantFlowEdge, PlantFlowGraph, PlantFlowNode, ZoneLevel } from '@sm/shared';
import { LIVE_ICON } from './common';
import { KIND_ICON, edgePill, edgeWidth, nodeAria, useNodeText } from './FlowGraph';
import type { EdgeGeom, NetLayout, Rect } from './networkLayout';
import { useMotion } from './prefs';
import './networkDiagram.css';

/**
 * The OT network diagram's canvas (#230): the layout of networkLayout.ts drawn with React Flow – bands by level,
 * zones and VLANs as areas, small chips for the parts (their details when zoomed in), conduits as gates on the
 * boundary between two zones. It opens fitted to the frame. Labels of the ways show on pointing at them or when a
 * part or path is selected, so they do not cover each other. Every part is focusable and labelled; Enter opens its
 * page, Space selects it, Escape clears the selection. Nothing moves with reduced motion or "Animation off", and the
 * moving dashes pause while the picture is panned.
 */

/** Below this zoom the chips show their names only, larger */
const COMPACT_ZOOM = 0.62;
/** A small site is fitted up to this zoom, so its names are easy to read */
const FIT_MAX_ZOOM = 1.3;

export interface Highlight {
  nodes: Set<string>;
  edges: Set<string>;
  /** Show the labels of the highlighted ways (a path or a part, not a whole zone) */
  labels: boolean;
}

type ChipData = { node: PlantFlowNode; dim: boolean; hl: boolean; sel: boolean; liveWord: string; w?: number };
type AreaData = ChipData & { w: number; h: number; tags: string[] };
type BandData = { level: ZoneLevel; short: string; name: string; w: number; h: number };
type OutsideData = { text: string; w: number; h: number };
type NetNode = Node<ChipData, 'chip'> | Node<ChipData, 'gate'> | Node<AreaData, 'area'> | Node<BandData, 'band'> | Node<OutsideData, 'outside'>;

const useCompact = () => useStore((s) => s.transform[2] < COMPACT_ZOOM);

const Handles = () => (
  <>
    <Handle type="target" position={Position.Bottom} isConnectable={false} />
    <Handle type="source" position={Position.Top} isConnectable={false} />
  </>
);

const Chip = memo(function Chip({ data }: NodeProps<Node<ChipData, 'chip'>>) {
  const { node, dim, hl, sel, liveWord } = data;
  const text = useNodeText();
  const compact = useCompact();
  const I = KIND_ICON[node.kind];
  const state = node.live?.state ?? null;
  const L: Icon | null = state ? LIVE_ICON[state] : null;
  return (
    <div
      className="nd-chip"
      data-kind={node.kind}
      data-dim={dim || undefined}
      data-hl={hl || undefined}
      data-sel={sel || undefined}
      data-compact={compact || undefined}
      data-testid={`flow-node-${node.id}`}
      style={state ? ({ '--pv-state': `var(--pv-${state})` } as CSSProperties) : undefined}
    >
      <Handles />
      {!compact && (
        <div className="nd-chip-top">
          <I size={12} stroke={1.8} aria-hidden />
          <span className="nd-kind">{text.kind(node)}</span>
          {L && (
            <span className="nd-live" data-live={state}>
              <L size={12} aria-hidden />
              {liveWord}
            </span>
          )}
        </div>
      )}
      <div className="nd-name" data-hidden={node.hidden || undefined}>
        {compact && L && (
          <span className="nd-live" data-live={state}>
            <L size={18} aria-hidden />
          </span>
        )}
        {text.label(node)}
      </div>
      {!compact && node.detail && <div className="nd-detail">{node.detail.split('\n')[0]}</div>}
    </div>
  );
});

const Gate = memo(function Gate({ data }: NodeProps<Node<ChipData, 'gate'>>) {
  const { node, dim, hl, sel, w } = data;
  const text = useNodeText();
  const compact = useCompact();
  const I = KIND_ICON.zone;
  return (
    <div
      className="nd-gate"
      style={{ width: w }}
      data-dim={dim || undefined}
      data-hl={hl || undefined}
      data-sel={sel || undefined}
      data-compact={compact || undefined}
      data-testid={`flow-node-${node.id}`}
    >
      <Handles />
      <I size={compact ? 18 : 14} stroke={1.8} aria-hidden />
      <span className="nd-gate-name">{text.label(node)}</span>
    </div>
  );
});

const Area = memo(function Area({ data }: NodeProps<Node<AreaData, 'area'>>) {
  const { node, dim, hl, sel, w, h, tags } = data;
  const text = useNodeText();
  const compact = useCompact();
  const I = KIND_ICON[node.kind];
  return (
    <div
      className="nd-area"
      data-kind={node.kind}
      data-dim={dim || undefined}
      data-hl={hl || undefined}
      data-sel={sel || undefined}
      data-compact={compact || undefined}
      data-testid={`flow-area-${node.id}`}
      style={{ width: w, height: h }}
    >
      <Handles />
      <div className="nd-area-label">
        <I size={compact ? 16 : 13} stroke={1.8} aria-hidden />
        {!compact && <span className="nd-kind">{text.kind(node)}</span>}
        <span className="nd-area-name">{text.label(node)}</span>
        {tags.map((x) => (
          <span key={x} className="nd-area-tag">
            {x}
          </span>
        ))}
      </div>
    </div>
  );
});

const Band = memo(function Band({ data }: NodeProps<Node<BandData, 'band'>>) {
  const compact = useCompact();
  return (
    <div
      className="nd-band"
      data-level={data.level}
      data-compact={compact || undefined}
      style={{ width: data.w, height: data.h }}
      data-testid={`band-${data.level}`}
    >
      <div className="nd-band-label">
        <span className="nd-band-short">{data.short}</span>
        <span className="nd-band-name">{data.name}</span>
      </div>
    </div>
  );
});

const Outside = memo(function Outside({ data }: NodeProps<Node<OutsideData, 'outside'>>) {
  const compact = useCompact();
  return (
    <div className="nd-outside" data-compact={compact || undefined} style={{ width: data.w, height: data.h }}>
      <span className="nd-outside-label">{data.text}</span>
    </div>
  );
});

type WayData = {
  edge: PlantFlowEdge;
  geom: EdgeGeom;
  dim: boolean;
  hl: boolean;
  animate: boolean;
  label: string;
  showLabel: boolean;
  warn: boolean;
};

function Way({ id, data, markerEnd, markerStart }: EdgeProps<Edge<WayData, 'way'>>) {
  if (!data) return null;
  const { edge: e, geom, dim, hl, animate, label, showLabel, warn } = data;
  const w = edgeWidth(e) + (hl ? 1 : 0);
  const offline = e.live === 'offline';
  const moving = animate && !e.inactive && !e.problem && !e.both && !offline && !e.conduit;
  return (
    <>
      <g
        className="pv-edge"
        data-dim={dim || undefined}
        data-testid={`flow-edge-${id}`}
        data-conduit={e.conduit || undefined}
        data-live={e.live ?? undefined}
        data-no-conduit={e.noConduit || undefined}
        data-hl={hl || undefined}
      >
        <path d={geom.d} className="nd-edge-hit" />
        <path
          d={geom.d}
          className="pv-edge-base"
          data-inactive={e.inactive || undefined}
          data-problem={e.problem || offline || undefined}
          data-no-conduit={e.noConduit || undefined}
          data-conduit={e.conduit || undefined}
          data-online={e.live === 'online' || undefined}
          data-hl={hl || undefined}
          strokeWidth={e.conduit ? 8 : w}
          markerEnd={markerEnd}
          markerStart={markerStart}
        />
        {moving && <path d={geom.d} className="pv-edge-flow" data-hl={hl || undefined} strokeWidth={w + 0.8} />}
      </g>
      {showLabel && label && (
        <EdgeLabelRenderer>
          <div
            className="pv-edge-pill nd-pill nodrag nopan"
            data-problem={warn || undefined}
            style={{ transform: `translate(-50%, -50%) translate(${geom.mx}px, ${geom.my}px)` }}
            aria-hidden
            data-testid={`edge-label-${id}`}
          >
            {warn && <IconAlertTriangle size={11} aria-hidden />}
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { chip: Chip, gate: Gate, area: Area, band: Band, outside: Outside };
const edgeTypes = { way: Way };

export interface NetworkCanvasProps {
  graph: PlantFlowGraph;
  layout: NetLayout;
  /** The accessible name of the picture */
  label: string;
  height: number | string;
  /** What is pointed at or selected (null: nothing) – the rest is dimmed */
  focus: Highlight | null;
  /** What the filters let through (null: no filter) – the rest is dimmed */
  scope: { nodes: Set<string>; edges: Set<string> } | null;
  selected: string | null;
  /** The name of what is selected (a part or a path), for the clear button */
  selectedName: string | null;
  onHover: (id: string | null) => void;
  /** A click (or Space) on a part: select it, or clear when it was selected */
  onSelect: (id: string | null) => void;
  onClear: () => void;
  onOpen: (path: string) => void;
  /** Centre on a part (a new `n` each time) */
  centerOn: { id: string; n: number } | null;
  /** Fit the picture again when this changes (full screen, the side panel folded) */
  fitKey: string;
  fullscreen: boolean;
  onFullscreen: (on: boolean) => void;
  miniMap: boolean;
  levelWords: (l: ZoneLevel) => { short: string; name: string };
  liveWord: (n: PlantFlowNode) => string;
}

export function NetworkCanvas(props: NetworkCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

const rough = (s: string) => s.length * 6.2 + 22;

function CanvasInner({
  graph,
  layout,
  label,
  height,
  focus,
  scope,
  selected,
  selectedName,
  onHover,
  onSelect,
  onClear,
  onOpen,
  centerOn,
  fitKey,
  fullscreen,
  onFullscreen,
  miniMap,
  levelWords,
  liveWord,
}: NetworkCanvasProps) {
  const { t } = useTranslation('plantViews');
  const scheme = useComputedColorScheme('light');
  const { animate } = useMotion();
  const rf = useReactFlow();
  const { ref: frame, width: fw, height: fh } = useElementSize();
  const wrap = useRef<HTMLDivElement | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  const nodes: NetNode[] = useMemo(() => {
    // an area that holds a highlighted part stays clear (without being highlighted itself)
    const holders = (set: Set<string>) => {
      const out = new Set<string>();
      for (const id of set) for (let p = byId.get(id)?.parent, i = 0; p && i < 8; p = byId.get(p)?.parent, i++) out.add(p);
      return out;
    };
    const fh = focus ? holders(focus.nodes) : null;
    const sh = scope ? holders(scope.nodes) : null;
    const flags = (n: PlantFlowNode) => ({
      dim: (!!focus && !focus.nodes.has(n.id) && !fh!.has(n.id)) || (!!scope && !scope.nodes.has(n.id) && !sh!.has(n.id)),
      hl: !!focus && focus.nodes.has(n.id),
      sel: selected === n.id,
    });
    const common = { draggable: false, selectable: false, connectable: false } as const;
    const out: NetNode[] = [];
    for (const b of layout.bands) {
      const w = levelWords(b.level);
      out.push({
        id: `band:${b.level}`,
        type: 'band',
        position: { x: 0, y: b.y - 34 },
        data: { level: b.level, short: w.short, name: w.name, w: layout.width, h: b.h + 68 },
        ...common,
        focusable: false,
        zIndex: -2,
        width: layout.width,
        height: b.h + 68,
      });
    }
    if (layout.outside) {
      const o = layout.outside;
      out.push({
        id: 'outside',
        type: 'outside',
        position: { x: o.x, y: o.y },
        data: { text: t('network.outside'), w: o.w, h: o.h },
        ...common,
        focusable: false,
        zIndex: -1,
        width: o.w,
        height: o.h,
      });
    }
    // areas outer before inner, then the parts above the ways
    const areas = graph.nodes.filter((n) => (n.kind === 'zone' || n.kind === 'vlan') && layout.rects.has(n.id));
    areas.sort((a, b) => (a.kind === 'zone' ? 0 : 1) - (b.kind === 'zone' ? 0 : 1));
    for (const n of areas) {
      const r = layout.rects.get(n.id)!;
      out.push({
        id: n.id,
        type: 'area',
        position: { x: r.x, y: r.y },
        data: { node: n, ...flags(n), liveWord: '', w: r.w, h: r.h, tags: n.tags ?? [] },
        ...common,
        zIndex: 0,
        width: r.w,
        height: r.h,
        ariaLabel: nodeAria(t, n),
      });
    }
    for (const n of graph.nodes) {
      if (n.kind === 'zone' || n.kind === 'vlan') continue;
      const r: Rect | undefined = layout.rects.get(n.id);
      if (!r) continue;
      out.push({
        id: n.id,
        type: n.kind === 'conduit' ? 'gate' : 'chip',
        position: { x: r.x, y: r.y },
        data: { node: n, ...flags(n), liveWord: n.live ? liveWord(n) : '', w: r.w },
        ...common,
        zIndex: 2,
        width: r.w,
        height: r.h,
        ariaLabel: nodeAria(t, n),
      });
    }
    return out;
  }, [graph, layout, focus, scope, selected, byId, t, levelWords, liveWord]);

  // many ways: only the highlighted ones move (the arrows still show the direction of all)
  const many = graph.edges.length > 60;
  const edges: Edge<WayData, 'way'>[] = useMemo(() => {
    // labels where they are wanted, without covering each other
    const taken: { x: number; y: number; w: number }[] = [];
    const free = (x: number, y: number, w: number) => !taken.some((o) => Math.abs(o.x - x) < (o.w + w) / 2 + 4 && Math.abs(o.y - y) < 20);
    const list = graph.edges.filter((e) => layout.edges.has(e.id));
    // the pointed-at way first: its label always shows
    list.sort((a, b) => (a.id === hoverEdge ? -1 : b.id === hoverEdge ? 1 : 0));
    return list.map((e) => {
      const geom = layout.edges.get(e.id)!;
      const hl = !!focus && focus.edges.has(e.id);
      const dim = (!!focus && !hl) || (!!scope && !scope.edges.has(e.id));
      const warn = !!(e.problem || e.noConduit || e.live === 'offline');
      const label = e.conduit
        ? ''
        : e.noConduit
          ? [t('edge.noConduit'), e.label].filter(Boolean).join(' · ')
          : [e.live === 'offline' ? t('edge.offline') : '', edgePill(t, e, 'paths', false)].filter(Boolean).join(' · ');
      let showLabel = !!label && (e.id === hoverEdge || (hl && !!focus?.labels));
      if (showLabel) {
        const w = rough(label);
        if (e.id === hoverEdge || free(geom.mx, geom.my, w)) taken.push({ x: geom.mx, y: geom.my, w });
        else showLabel = false;
      }
      const color =
        e.problem || e.live === 'offline'
          ? 'var(--pv-problem)'
          : e.noConduit
            ? 'var(--pv-warn)'
            : hl
              ? 'var(--pv-hl)'
              : e.conduit
                ? 'var(--pv-conduit)'
                : e.live === 'online'
                  ? 'var(--pv-ok)'
                  : 'var(--pv-edge)';
      const marker = { type: MarkerType.ArrowClosed, color, width: e.conduit ? 18 : 14, height: e.conduit ? 18 : 14, markerUnits: 'userSpaceOnUse' };
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'way' as const,
        markerEnd: marker,
        markerStart: e.both ? marker : undefined,
        data: { edge: e, geom, dim, hl, animate: animate && (!many || hl), label, showLabel, warn },
        selectable: false,
        focusable: false,
        zIndex: 1,
        ariaLabel: edgeAria(t, e, byId),
      };
    });
  }, [graph, layout, focus, scope, hoverEdge, animate, many, t, byId]);

  // the mini map only while zoomed in beyond the whole picture
  const fitZoom = useRef(1);
  const [zoomedIn, setZoomedIn] = useState(false);
  // the whole picture, centred – from the layout's own size, so it does not wait for the parts to be measured
  const fit = (duration = 0) => {
    const el = wrap.current;
    if (!el || !el.clientWidth || !el.clientHeight) return;
    const pad = 16;
    const zoom = Math.max(0.05, Math.min(FIT_MAX_ZOOM, (el.clientWidth - 2 * pad) / layout.width, (el.clientHeight - 2 * pad) / layout.height));
    fitZoom.current = zoom;
    setZoomedIn(false);
    void rf.setViewport({ x: (el.clientWidth - layout.width * zoom) / 2, y: (el.clientHeight - layout.height * zoom) / 2, zoom }, { duration });
  };
  // fitted again when the frame changes (its size, full screen, the side panel) or the picture is laid out anew
  const firstFit = useRef(true);
  useEffect(() => {
    if (firstFit.current) {
      firstFit.current = false;
      return;
    }
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
  }, [fitKey, layout, fw, fh]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the frame or the layout changes
  // centre on a part that was searched for
  useEffect(() => {
    if (!centerOn) return;
    const r = layout.rects.get(centerOn.id);
    if (!r) return;
    const zoom = Math.max(rf.getZoom(), 0.9);
    void rf.setCenter(r.x + r.w / 2, r.y + r.h / 2, { zoom: Math.min(zoom, 1.2), duration: animate ? 350 : 0 });
  }, [centerOn]); // eslint-disable-line react-hooks/exhaustive-deps -- only on a new request

  const nodeIdOf = (el: EventTarget | null) => (el instanceof Element ? el.closest('.react-flow__node')?.getAttribute('data-id') : null) ?? null;
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      if (selectedName) onClear();
      else if (fullscreen) onFullscreen(false);
      else return;
      ev.preventDefault();
      return;
    }
    const id = nodeIdOf(ev.target);
    const n = id ? byId.get(id) : undefined;
    if (!n) return;
    if (ev.key === 'Enter' && n.path) {
      ev.preventDefault();
      onOpen(n.path);
    } else if (ev.key === ' ') {
      ev.preventDefault();
      onSelect(selected === n.id ? null : n.id);
    }
  };
  // the moving dashes pause while the picture moves (smooth panning on large sites)
  const moving = (on: boolean) => wrap.current?.toggleAttribute('data-moving', on);
  const leaves = graph.nodes.filter((n) => !n.group).length;
  return (
    <div
      ref={(el) => {
        frame(el);
        wrap.current = el;
      }}
      className={animate ? 'pv-graph nd-graph' : 'pv-graph nd-graph pv-static'}
      style={{ height }}
      data-testid="flow-graph"
      data-animated={animate || undefined}
      data-many={many || undefined}
      role="figure"
      aria-label={label}
      onKeyDown={onKeyDown}
      onFocus={(ev) => {
        const id = nodeIdOf(ev.target);
        if (id && byId.has(id)) onHover(id);
      }}
      onBlur={() => onHover(null)}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        onlyRenderVisibleElements={leaves > 150}
        onNodeClick={(_e, n) => {
          if (!byId.has(n.id)) return;
          onSelect(selected === n.id ? null : n.id);
        }}
        onNodeDoubleClick={(_e, n) => {
          const p = byId.get(n.id)?.path;
          if (p) onOpen(p);
        }}
        onPaneClick={() => selectedName && onClear()}
        onNodeMouseEnter={(_e, n) => byId.has(n.id) && onHover(n.id)}
        onNodeMouseLeave={() => onHover(null)}
        onEdgeMouseEnter={(_e, e) => setHoverEdge(e.id)}
        onEdgeMouseLeave={() => setHoverEdge(null)}
        onMoveStart={() => moving(true)}
        onMoveEnd={(_e, v) => {
          moving(false);
          setZoomedIn(v.zoom > fitZoom.current * 1.2);
        }}
        key={fw > 0 ? 'sized' : 'unsized'}
        onInit={() => fit()}
        zoomOnDoubleClick={false}
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode={scheme}
        deleteKeyCode={null}
        ariaLabelConfig={{
          'node.a11yDescription.default': t('network.nodeHelp'),
          'node.a11yDescription.keyboardDisabled': t('network.nodeHelp'),
          'edge.a11yDescription.default': t('graph.edgeHelp'),
          'controls.ariaLabel': t('graph.controls'),
          'controls.zoomIn.ariaLabel': t('graph.zoomIn'),
          'controls.zoomOut.ariaLabel': t('graph.zoomOut'),
          'controls.fitView.ariaLabel': t('graph.fitView'),
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} fitViewOptions={{ padding: 0.04, maxZoom: FIT_MAX_ZOOM, minZoom: 0.05 }}>
          <ControlButton
            onClick={() => onFullscreen(!fullscreen)}
            aria-label={fullscreen ? t('network.exitFullscreen') : t('network.fullscreen')}
            title={fullscreen ? t('network.exitFullscreen') : t('network.fullscreen')}
            aria-pressed={fullscreen}
            data-testid="nd-fullscreen"
          >
            {fullscreen ? <IconArrowsMinimize size={14} /> : <IconArrowsMaximize size={14} />}
          </ControlButton>
        </Controls>
        {miniMap && zoomedIn && (
          <MiniMap
            pannable
            zoomable
            ariaLabel={t('network.miniMap')}
            nodeColor={(n) =>
              n.type === 'band' || n.type === 'outside' ? 'transparent' : n.type === 'area' ? 'var(--nd-minimap-area)' : 'var(--nd-minimap-part)'
            }
            nodeStrokeWidth={0}
            style={{ width: 180, height: 120 }}
            data-testid="nd-minimap"
          />
        )}
        {selectedName && (
          <Panel position="top-left">
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<IconX size={12} aria-hidden />}
              onClick={onClear}
              data-testid="nd-clear-selection"
              title={t('network.clearSelectionHint')}
            >
              {t('network.clearSelection', { name: selectedName })}
            </Button>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

type T = ReturnType<typeof useTranslation<'plantViews'>>['t'];

function edgeAria(t: T, e: PlantFlowEdge, byId: Map<string, PlantFlowNode>): string {
  const name = (id: string) => {
    const n = byId.get(id);
    return n ? (n.hidden ? t('node.hidden') : n.label) : id;
  };
  return [
    t('edge.from', { from: name(e.from), to: name(e.to) }),
    edgePill(t, e, 'paths', true),
    e.both ? t('edge.both') : '',
    e.noConduit ? t('edge.noConduit') : '',
    e.live === 'offline' ? t('edge.offline') : '',
  ]
    .filter(Boolean)
    .join(', ');
}
