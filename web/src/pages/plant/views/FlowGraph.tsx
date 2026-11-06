import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Badge, Group, Text, useComputedColorScheme } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconBuildingFactory2,
  IconCloudUpload,
  IconCpu,
  IconDatabase,
  IconLayoutDashboard,
  IconMathFunction,
  IconNetwork,
  IconPlugConnected,
  IconPlugConnectedX,
  IconPoint,
  IconRouter,
  IconServer,
  IconShieldLock,
  IconWorld,
  type Icon,
} from '@tabler/icons-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { compoundLayout, layeredLayout, type PlantFlowEdge, type PlantFlowGraph, type PlantFlowNode, type PlantFlowNodeKind } from '@sm/shared';
import { ProtocolBadge } from '../../../components/plant/data';
import { LiveBadge, liveVar } from './common';
import { useMotion } from './prefs';

/**
 * A graph of the plant registry (#230): the data flow of an asset, the lineage of a data point – and later the OT
 * network (#220) – drawn with React Flow and laid out left to right by dagre, as the process canvas. Edges animate in
 * the direction of the documented flow (never with reduced motion or "Animation off"); inactive ways and failing checks
 * are dashed and say so in words. Every node is focusable and labelled; Enter opens its page.
 */

export const NODE_W = 232;
export const NODE_H = 104;
export const NODE_H_SMALL = 68;

export const KIND_ICON: Record<PlantFlowNodeKind, Icon> = {
  asset: IconCpu,
  point: IconPoint,
  site: IconBuildingFactory2,
  interface: IconPlugConnected,
  collector: IconRouter,
  target: IconCloudUpload,
  kpi: IconMathFunction,
  dataset: IconDatabase,
  dashboard: IconLayoutDashboard,
  zone: IconShieldLock,
  vlan: IconNetwork,
  conduit: IconArrowsExchange,
  host: IconServer,
  peer: IconWorld,
};

/** Kinds whose second line is an identifier (an endpoint, a path, a job): set in monospace. */
const MONO = new Set<PlantFlowNodeKind>(['interface', 'target', 'kpi', 'point', 'vlan', 'conduit']);

/** The height of a node (a small one: an empty VLAN, a party outside the zones). */
export const nodeHeight = (n: Pick<PlantFlowNode, 'small'>) => (n.small ? NODE_H_SMALL : NODE_H);

// ---------- layout, computed once per graph ----------

export interface FlowLayout {
  /** Left to right, or top to bottom: whichever fits the frame better */
  dir: 'LR' | 'TB';
  pos: Map<string, { x: number; y: number }>;
  /** Areas (zones, VLANs): their boxes */
  boxes: Map<string, { x: number; y: number; width: number; height: number }>;
  width: number;
  height: number;
}

const layouts = new Map<string, FlowLayout>();

function layoutIn(g: Pick<PlantFlowGraph, 'nodes' | 'edges'>, dir: 'LR' | 'TB'): FlowLayout {
  const opts = dir === 'LR' ? { direction: 'LR' as const, rankSep: 84, nodeSep: 26 } : { direction: 'TB' as const, rankSep: 64, nodeSep: 28 };
  const leaves = g.nodes.filter((n) => !n.group);
  let pos: Map<string, { x: number; y: number }>;
  let boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  if (leaves.length === g.nodes.length)
    pos = layeredLayout(
      g.nodes.map((n) => ({ id: n.id, width: NODE_W, height: nodeHeight(n) })),
      g.edges,
      opts,
    );
  else
    ({ pos, boxes } = compoundLayout(
      leaves.map((n) => ({ id: n.id, width: NODE_W, height: nodeHeight(n), parent: n.parent })),
      g.nodes.filter((n) => n.group).map((n) => ({ id: n.id, parent: n.parent })),
      g.edges,
      { ...opts, rankSep: opts.rankSep + 24 },
    ));
  const rects = [...leaves.map((n) => ({ ...(pos.get(n.id) ?? { x: 0, y: 0 }), width: NODE_W, height: nodeHeight(n) })), ...boxes.values()];
  return {
    dir,
    pos,
    boxes,
    width: Math.max(NODE_W, ...rects.map((r) => r.x + r.width)) - Math.min(0, ...rects.map((r) => r.x)),
    height: Math.max(NODE_H, ...rects.map((r) => r.y + r.height)) - Math.min(0, ...rects.map((r) => r.y)),
  };
}

/**
 * The positions of a graph's nodes for a frame of the given aspect (width / height): the flow runs left to right
 * when that shows it larger, else top to bottom. Cached: the same graph in the same frame is laid out once.
 */
export function flowLayout(g: Pick<PlantFlowGraph, 'nodes' | 'edges'>, aspect = 1.5): FlowLayout {
  const key = `${aspect > 1 ? 'w' : 'n'}#${g.nodes.map((n) => n.id).join('|')}#${g.edges.map((e) => e.id).join('|')}`;
  const hit = layouts.get(key);
  if (hit) return hit;
  const fit = (l: FlowLayout) => Math.min(aspect / l.width, 1 / l.height);
  const lr = layoutIn(g, 'LR');
  const tb = layoutIn(g, 'TB');
  // a little preference for left to right, the way a flow is read
  const best = fit(tb) > fit(lr) * 1.15 ? tb : lr;
  if (layouts.size > 40) layouts.delete(layouts.keys().next().value!);
  layouts.set(key, best);
  return best;
}

/** Below this zoom the picture opens at it, at its start (the rest is a drag away), so names stay readable. */
const READABLE_ZOOM = 0.8;

// ---------- nodes ----------

/** The words of a node: its kind, its label, and its status as a sentence (for the label of the node and the table). */
export function useNodeText() {
  const { t } = useTranslation('plantViews');
  return {
    // a KPI node of the lineage is the definition (with its jobs), in the asset flow one job
    kind: (n: Pick<PlantFlowNode, 'kind' | 'instances'>) => (n.kind === 'kpi' && n.instances !== undefined ? t('kinds.kpiDefinition') : t(`kinds.${n.kind}`)),
    label: (n: Pick<PlantFlowNode, 'label' | 'hidden'>) => (n.hidden ? t('node.hidden') : n.label),
  };
}

type FlowNodeData = { node: PlantFlowNode; dim: boolean; hl: boolean; dir: 'LR' | 'TB' };
type FlowRfNode = Node<FlowNodeData, 'part'>;

const PartNode = memo(function PartNode({ data }: NodeProps<FlowRfNode>) {
  const { node, dim, hl, dir } = data;
  const { t } = useTranslation('plantViews');
  const text = useNodeText();
  // level of detail: below this zoom only the icon and the name
  const compact = useStore((s) => s.transform[2] < 0.55);
  const state = node.live?.state ?? null;
  // a soft pulse when a live status changes (not on the first drawing)
  const [seen, setSeen] = useState(state);
  const [pulse, setPulse] = useState(0);
  if (seen !== state) {
    setSeen(state);
    setPulse((p) => p + 1);
  }
  const I = KIND_ICON[node.kind];
  const badges = !!(node.protocol || node.inactive || node.checks.length || node.count || node.instances || node.tags?.length) && !node.small;
  const accent = state ? liveVar(state) : node.checks.length ? 'var(--pv-problem)' : undefined;
  return (
    <div
      key={pulse}
      className={pulse ? 'pv-node pv-pulse' : 'pv-node'}
      data-inactive={node.inactive || undefined}
      data-dim={dim || undefined}
      data-hl={hl || undefined}
      data-compact={compact || undefined}
      data-testid={`flow-node-${node.id}`}
      data-kind={node.kind}
      data-small={node.small || undefined}
      style={accent ? ({ '--pv-state': accent } as CSSProperties) : undefined}
    >
      <Handle type="target" position={dir === 'LR' ? Position.Left : Position.Top} isConnectable={false} />
      <Group gap={6} justify="space-between" wrap="nowrap" h={20}>
        <Group gap={5} wrap="nowrap" style={{ minWidth: 0 }}>
          <I size={15} stroke={1.7} aria-hidden style={{ flexShrink: 0 }} />
          <span className="pv-node-kind">{text.kind(node)}</span>
        </Group>
        {node.live && <LiveBadge live={node.live} size="xs" focusable={false} />}
      </Group>
      <Text className="pv-node-label" size="sm" fw={600} lineClamp={compact ? 2 : 1} title={text.label(node)} fs={node.hidden ? 'italic' : undefined}>
        {text.label(node)}
      </Text>
      {node.detail && (
        <Text
          className={MONO.has(node.kind) ? 'pv-node-detail mono' : 'pv-node-detail'}
          size="xs"
          c="dimmed"
          lineClamp={badges ? 1 : 2}
          title={node.detail}
          style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}
        >
          {node.detail}
        </Text>
      )}
      {badges && (
        <Group className="pv-node-badges" gap={4} wrap="nowrap" mt={4} style={{ overflow: 'hidden' }}>
          {node.protocol && <ProtocolBadge protocol={node.protocol} size="xs" />}
          {node.inactive && (
            <Badge size="xs" color="gray" variant="outline" leftSection={<IconPlugConnectedX size={10} aria-hidden />} style={{ textTransform: 'none' }}>
              {t('node.inactive')}
            </Badge>
          )}
          {node.checks.length > 0 && (
            <Badge size="xs" color="red" variant="light" leftSection={<IconAlertTriangle size={10} aria-hidden />} style={{ textTransform: 'none' }}>
              {t('node.checks', { count: node.checks.length })}
            </Badge>
          )}
          {node.count && (
            <Badge size="xs" color="gray" variant="light" style={{ textTransform: 'none' }}>
              {t('node.delivering', { count: node.count.delivering, total: node.count.total })}
            </Badge>
          )}
          {node.tags?.map((x) => (
            <Badge key={x} size="xs" color="gray" variant="light" style={{ textTransform: 'none' }}>
              {x}
            </Badge>
          ))}
          {node.instances !== undefined && (
            <Badge size="xs" color="gray" variant="light" style={{ textTransform: 'none' }}>
              {t('node.instances', { count: node.instances })}
            </Badge>
          )}
        </Group>
      )}
      <Handle type="source" position={dir === 'LR' ? Position.Right : Position.Bottom} isConnectable={false} />
    </div>
  );
});

/** An area: an IEC 62443-3-2 zone or an IEEE 802.1Q VLAN, drawn around its members; its name sits on its border. */
type AreaNodeData = { node: PlantFlowNode; dim: boolean; hl: boolean; dir: 'LR' | 'TB'; width: number; height: number };
type AreaRfNode = Node<AreaNodeData, 'area'>;

const AreaNode = memo(function AreaNode({ data }: NodeProps<AreaRfNode>) {
  const { node, dim, hl, dir, width, height } = data;
  const text = useNodeText();
  const I = KIND_ICON[node.kind];
  return (
    <div
      className="pv-area"
      data-kind={node.kind}
      data-dim={dim || undefined}
      data-hl={hl || undefined}
      data-testid={`flow-area-${node.id}`}
      style={{ width, height }}
    >
      <Handle type="target" position={dir === 'LR' ? Position.Left : Position.Top} isConnectable={false} />
      <div className="pv-area-label">
        <I size={13} stroke={1.8} aria-hidden style={{ flexShrink: 0 }} />
        <span className="pv-node-kind">{text.kind(node)}</span>
        <span className="pv-area-name">{text.label(node)}</span>
        {node.tags?.map((x) => (
          <span key={x} className="pv-area-tag">
            {x}
          </span>
        ))}
      </div>
      <Handle type="source" position={dir === 'LR' ? Position.Right : Position.Bottom} isConnectable={false} />
    </div>
  );
});

// ---------- edges ----------

type FlowEdgeData = {
  edge: PlantFlowEdge;
  dim: boolean;
  hl: boolean;
  animate: boolean;
  pill: string;
  problemText: string;
  inactiveText: string;
  noConduitText: string;
  offlineText: string;
};
type FlowRfEdge = Edge<FlowEdgeData, 'way'>;

export const edgeWidth = (e: Pick<PlantFlowEdge, 'points' | 'assets' | 'paths' | 'conduit'>) =>
  e.conduit ? 6 : 1.4 + Math.min(3, Math.log2((e.points || e.assets || e.paths || 1) + 1) * 0.7);

function WayEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, markerStart }: EdgeProps<FlowRfEdge>) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  if (!data) return null;
  const { edge: e, dim, hl, animate } = data;
  const w = edgeWidth(e) + (hl ? 1 : 0);
  const offline = e.live === 'offline';
  // nothing moves where nothing flows: not active, a failing check, offline, or both ways at once
  const moving = animate && !e.inactive && !e.problem && !e.both && !offline;
  const pill = e.problem
    ? data.problemText
    : e.inactive
      ? data.inactiveText
      : e.noConduit
        ? data.noConduitText
        : offline
          ? [data.offlineText, data.pill].filter(Boolean).join(' · ')
          : data.pill;
  const warn = e.problem || e.noConduit || offline;
  return (
    <>
      <g
        className="pv-edge"
        data-dim={dim || undefined}
        data-testid={`flow-edge-${id}`}
        data-inactive={e.inactive || undefined}
        data-problem={e.problem || undefined}
        data-conduit={e.conduit || undefined}
        data-live={e.live ?? undefined}
        data-no-conduit={e.noConduit || undefined}
      >
        <path
          id={id}
          d={path}
          className="pv-edge-base"
          data-inactive={e.inactive || undefined}
          data-problem={e.problem || offline || undefined}
          data-no-conduit={e.noConduit || undefined}
          data-conduit={e.conduit || undefined}
          data-online={e.live === 'online' || undefined}
          data-hl={hl || undefined}
          strokeWidth={w}
          markerEnd={markerEnd}
          markerStart={markerStart}
        />
        {moving && <path d={path} className="pv-edge-flow" data-hl={hl || undefined} strokeWidth={w + 0.8} />}
      </g>
      {pill && (
        <EdgeLabelRenderer>
          <div
            className="pv-edge-pill nodrag nopan"
            data-problem={warn || undefined}
            data-dim={dim || undefined}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            aria-hidden
          >
            {warn && <IconAlertTriangle size={11} aria-hidden />}
            {!e.problem && e.inactive && <IconPlugConnectedX size={11} aria-hidden />}
            {pill}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { part: PartNode, area: AreaNode };
const edgeTypes = { way: WayEdge };

// ---------- the graph ----------

export interface FlowGraphProps {
  graph: PlantFlowGraph;
  /** What the graph shows (its accessible name) */
  label: string;
  height: number | string;
  /** Highlighted nodes and edges (null: nothing highlighted) */
  highlight: { nodes: Set<string>; edges: Set<string> } | null;
  /** Zoom to the highlighted part (a pinned path), not on hover */
  focusKey?: string | null;
  /** A node is hovered or focused (null: none) */
  onHover?: (nodeId: string | null) => void;
  /** Lineage counts assets on the edges, the asset flow data points, the OT network data paths */
  counts: FlowCounts;
}

export type FlowCounts = 'points' | 'assets' | 'paths';

/** The number an edge carries in a view. */
export const edgeCount = (e: PlantFlowEdge, counts: FlowCounts) => (counts === 'points' ? e.points : counts === 'assets' ? e.assets : (e.paths ?? 0));

/** The text on an edge (its count, the protocol it carries). */
export function edgePill(t: T, e: PlantFlowEdge, counts: FlowCounts, grouped: boolean): string {
  const n = edgeCount(e, counts);
  if (counts === 'paths') return [e.label, n > 1 ? t('edge.paths', { count: n }) : ''].filter(Boolean).join(' · ');
  if (e.result || n === 0) return e.files ? t('edge.files', { count: e.files }) : '';
  if (counts === 'points') return t('edge.points', { count: n });
  return grouped || n > 1 ? t('edge.assets', { count: n }) : '';
}

export function FlowGraph(props: FlowGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphInner({ graph, label, height, highlight, focusKey, onHover, counts }: FlowGraphProps) {
  const { t } = useTranslation('plantViews');
  const scheme = useComputedColorScheme('light');
  const navigate = useNavigate();
  const { animate } = useMotion();
  const rf = useReactFlow();
  const { ref: frame, width: fw, height: fh } = useElementSize();
  const aspect = fw && fh ? fw / fh : typeof height === 'number' ? 1.5 : 1.5;
  const wide = aspect > 1;
  const layout = useMemo(() => flowLayout(graph, wide ? 1.5 : 0.85), [graph, wide]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const hasAreas = graph.nodes.some((n) => n.group);
  const nodes: (FlowRfNode | AreaRfNode)[] = useMemo(() => {
    // an area that holds a highlighted part stays clear (without being highlighted itself)
    const holds = new Set<string>();
    if (highlight) for (const id of highlight.nodes) for (let p = byId.get(id)?.parent, i = 0; p && i < 8; p = byId.get(p)?.parent, i++) holds.add(p);
    const flags = (n: PlantFlowNode) => ({
      dim: !!highlight && !highlight.nodes.has(n.id) && !holds.has(n.id),
      hl: !!highlight && highlight.nodes.has(n.id),
      dir: layout.dir,
    });
    const common = { draggable: false, selectable: false, connectable: false };
    // areas first (outer before inner), so their members are drawn on top of them
    const depth = (n: PlantFlowNode) => {
      let d = 0;
      for (let p = n.parent; p && d < 8; p = byId.get(p)?.parent) d++;
      return d;
    };
    const areas: AreaRfNode[] = graph.nodes
      .filter((n) => n.group && layout.boxes.has(n.id))
      .sort((a, b) => depth(a) - depth(b))
      .map((n) => {
        const b = layout.boxes.get(n.id)!;
        return {
          id: n.id,
          type: 'area',
          position: { x: b.x, y: b.y },
          data: { node: n, ...flags(n), width: b.width, height: b.height },
          ...common,
          // areas below the ways, the ways below the parts: a way into a zone stays visible
          zIndex: 0,
          width: b.width,
          height: b.height,
          ariaLabel: nodeAria(t, n),
        };
      });
    const parts: FlowRfNode[] = graph.nodes
      .filter((n) => !n.group)
      .map((n) => ({
        id: n.id,
        type: 'part',
        position: layout.pos.get(n.id) ?? { x: 0, y: 0 },
        data: { node: n, ...flags(n) },
        ...common,
        zIndex: hasAreas ? 2 : undefined,
        width: NODE_W,
        height: nodeHeight(n),
        ariaLabel: nodeAria(t, n),
      }));
    return [...areas, ...parts];
  }, [graph, layout, highlight, t, byId, hasAreas]);
  const edges: FlowRfEdge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const hl = !!highlight && highlight.edges.has(e.id);
        const color =
          e.problem || e.live === 'offline'
            ? 'var(--pv-problem)'
            : e.noConduit
              ? 'var(--pv-warn)'
              : hl
                ? 'var(--pv-hl)'
                : e.conduit
                  ? 'var(--pv-conduit)'
                  : 'var(--pv-edge)';
        const pill = edgePill(t, e, counts, graph.grouped);
        const marker = { type: MarkerType.ArrowClosed, color, width: e.conduit ? 22 : 16, height: e.conduit ? 22 : 16, markerUnits: 'userSpaceOnUse' };
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: 'way',
          markerEnd: marker,
          markerStart: e.both ? marker : undefined,
          data: {
            edge: e,
            dim: !!highlight && !hl,
            hl,
            animate,
            pill,
            problemText: t('edge.problem'),
            inactiveText: t('edge.inactive'),
            noConduitText: t('edge.noConduit'),
            offlineText: t('edge.offline'),
          },
          selectable: false,
          focusable: false,
          zIndex: hasAreas ? 1 : undefined,
          ariaLabel: edgeAria(t, e, byId, counts),
        };
      }),
    [graph, highlight, animate, counts, t, byId, hasAreas],
  );
  const nodeIdOf = (el: EventTarget | null) => (el instanceof Element ? el.closest('.react-flow__node')?.getAttribute('data-id') : null) ?? null;
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter') return;
    const n = byId.get(nodeIdOf(ev.target) ?? '');
    if (n?.path) navigate(n.path);
  };
  const big = graph.nodes.length > 120;
  // the first view: everything, unless that is too small to read – then the start of the flow at a readable zoom
  const [partial, setPartial] = useState(false);
  const onInit = () => {
    if (!fw || !fh) return;
    const fit = Math.min((fw - 32) / layout.width, (fh - 32) / layout.height, 1);
    if (fit >= READABLE_ZOOM) {
      void rf.fitView({ padding: 0.08, maxZoom: 1 });
      return;
    }
    const z = READABLE_ZOOM;
    setPartial(true);
    void rf.setViewport(
      layout.dir === 'LR'
        ? { x: 16, y: Math.max(16, (fh - layout.height * z) / 2), zoom: z }
        : { x: Math.max(16, (fw - layout.width * z) / 2), y: 16, zoom: z },
    );
  };
  // zoom to a pinned path (smoothly, unless motion is reduced)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (focusKey && highlight)
      void rf.fitView({ nodes: [...highlight.nodes].map((id) => ({ id })), padding: 0.2, minZoom: READABLE_ZOOM, maxZoom: 1, duration: animate ? 450 : 0 });
    else onInit();
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the pinned path changes
  return (
    <div
      ref={frame}
      className={animate ? 'pv-graph' : 'pv-graph pv-static'}
      style={{ height }}
      data-testid="flow-graph"
      data-animated={animate || undefined}
      role="figure"
      aria-label={label}
      onKeyDown={onKeyDown}
      onFocus={(ev: FocusEvent) => {
        const id = nodeIdOf(ev.target);
        if (id) onHover?.(id);
      }}
      onBlur={() => onHover?.(null)}
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
        onlyRenderVisibleElements={big}
        onNodeClick={(_e, n) => {
          const p = byId.get(n.id)?.path;
          if (p) navigate(p);
        }}
        onNodeMouseEnter={(_e, n) => onHover?.(n.id)}
        onNodeMouseLeave={() => onHover?.(null)}
        key={`${layout.dir}:${fw > 0}`}
        onInit={onInit}
        minZoom={0.15}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        colorMode={scheme}
        deleteKeyCode={null}
        ariaLabelConfig={{
          'node.a11yDescription.default': t('graph.nodeHelp'),
          'node.a11yDescription.keyboardDisabled': t('graph.nodeHelp'),
          'edge.a11yDescription.default': t('graph.edgeHelp'),
          'controls.ariaLabel': t('graph.controls'),
          'controls.zoomIn.ariaLabel': t('graph.zoomIn'),
          'controls.zoomOut.ariaLabel': t('graph.zoomOut'),
          'controls.fitView.ariaLabel': t('graph.fitView'),
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
        {partial && (
          <Panel position="top-right">
            <Text size="xs" c="dimmed" className="pv-hint" data-testid="graph-partial">
              {t('graph.partial')}
            </Text>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

type T = TFunction<'plantViews'>;

/** A node as a sentence: "Interface: OPC UA server, opc.tcp://… Not active. 1 problem." */
export function nodeAria(t: T, n: PlantFlowNode): string {
  const kind = n.kind === 'kpi' && n.instances !== undefined ? t('kinds.kpiDefinition') : t(`kinds.${n.kind}`);
  const parts = [`${kind}: ${n.hidden ? t('node.hidden') : n.label}${n.detail ? `, ${n.detail.replace(/\n/g, ', ')}` : ''}.`];
  parts.push(statusSentence(t, n));
  if (n.path) parts.push(t('node.opens'));
  return parts.join(' ');
}

/** The status of a node in words: live status, not active, failing checks – or documentation only. */
export function statusSentence(t: T, n: PlantFlowNode): string {
  const out: string[] = [];
  if (n.live)
    out.push(
      t('node.liveSentence', {
        source: t(`live.sourceName.${n.live.source}`),
        status: t(`live.${n.live.source}.${n.live.status}`, { defaultValue: n.live.status }),
      }),
    );
  if (n.inactive) out.push(t('node.inactiveSentence'));
  if (n.checks.length) out.push(t('node.checks', { count: n.checks.length }));
  if (!out.length) out.push(t('node.docOnly'));
  return out.join(' · ');
}

function edgeAria(t: T, e: PlantFlowEdge, byId: Map<string, PlantFlowNode>, counts: FlowCounts): string {
  const name = (id: string) => {
    const n = byId.get(id);
    return n ? (n.hidden ? t('node.hidden') : n.label) : id;
  };
  const what = e.result ? t('edge.result') : edgePill(t, e, counts, true);
  return [
    t('edge.from', { from: name(e.from), to: name(e.to) }),
    what,
    e.both ? t('edge.both') : '',
    e.inactive ? t('edge.inactive') : '',
    e.problem ? t('edge.problem') : '',
    e.noConduit ? t('edge.noConduit') : '',
    e.live === 'offline' ? t('edge.offline') : '',
  ]
    .filter(Boolean)
    .join(', ');
}
