import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
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
  IconApi,
  IconArrowsSplit,
  IconBox,
  IconBuildingFactory2,
  IconDatabase,
  IconEyeOff,
  IconFile,
  IconFolders,
  IconStack2,
  IconTable,
  IconTimeline,
  type Icon,
} from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import type { DataGraphEdge, DataGraphNode } from '@sm/shared';
import { useMotion } from '../../plant/views/prefs';
import { HEALTH_ICON, HealthBadge, healthVar } from './health';
import { STEP_H, STEP_W, nodeSize, type GraphLayout } from './graphLayout';
import { useGraphText, type GraphText } from './text';
import './dataProductViews.css';

/**
 * The canvas of the data products pictures (ADR 0036 part 13): React Flow, as the plant registry's graphs, on a layout
 * from graphLayout.ts. Every node is focusable and named in words (kind, name, health, role); Enter opens its page, a
 * click or Space selects it and highlights everything upstream and downstream of it. Edges move in the direction data
 * flows – never with reduced motion or _Animation off_. Health is an icon and a word, never colour alone.
 */

export const KIND_ICON = {
  step: IconArrowsSplit,
  product: IconBox,
  domain: IconFolders,
  plant: IconBuildingFactory2,
  stack: IconStack2,
  topic: IconTimeline,
  api: IconApi,
  file: IconFile,
  database: IconDatabase,
  table: IconTable,
  hidden: IconEyeOff,
} satisfies Record<string, Icon>;

/** The icon of a node: its kind, an element's platform kind. */
export function iconKey(n: Pick<DataGraphNode, 'kind' | 'elementKind' | 'collapsedBy' | 'hidden'>): keyof typeof KIND_ICON {
  if (n.hidden) return 'hidden';
  if (n.kind === 'step' || n.kind === 'product' || n.kind === 'domain' || n.kind === 'plant') return n.kind;
  if (n.kind === 'collapsed') return n.collapsedBy === 'domain' || n.collapsedBy === 'noDomain' ? 'product' : 'stack';
  const k = n.elementKind ?? '';
  if (k.startsWith('kafka.')) return 'topic';
  if (k.startsWith('api.')) return 'api';
  if (k.startsWith('files.') || k === 'snowflake.stage') return 'file';
  if (k.endsWith('.database') || k.endsWith('.schema')) return 'database';
  return 'table';
}

type NodeData = { node: DataGraphNode; dim: boolean; hl: boolean; selected: boolean; match: boolean; text: GraphText };
type PartNode = Node<NodeData, 'part'>;
type StepNode = Node<NodeData, 'step'>;
type AreaNode = Node<NodeData & { width: number; height: number }, 'area'>;
type HeaderNode = Node<{ label: string; width: number }, 'header'>;

const Part = memo(function Part({ data }: NodeProps<PartNode>) {
  const { node: n, dim, hl, selected, match, text } = data;
  const compact = useStore((s) => s.transform[2] < 0.55);
  const I = KIND_ICON[iconKey(n)];
  const H = n.health ? HEALTH_ICON[n.health] : null;
  const badges = !compact && (n.role || n.ports?.length || n.missing || n.lifecycle || (n.products?.length && n.outside) || n.hiddenProducts);
  return (
    <div
      className="pv-node dpv-node"
      data-dim={dim || undefined}
      data-hl={hl || undefined}
      data-selected={selected || undefined}
      data-match={match || undefined}
      data-outside={n.outside || undefined}
      data-hidden={n.hidden || undefined}
      data-compact={compact || undefined}
      data-testid={`graph-node-${n.id}`}
      data-kind={n.kind}
      style={n.health ? ({ '--pv-state': healthVar(n.health) } as CSSProperties) : undefined}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Group gap={6} justify="space-between" wrap="nowrap" h={20}>
        <Group gap={5} wrap="nowrap" style={{ minWidth: 0 }}>
          <I size={15} stroke={1.7} aria-hidden style={{ flexShrink: 0 }} />
          <span className="pv-node-kind" title={text.kind(n)}>
            {text.kind(n)}
          </span>
        </Group>
        {n.health && H && (compact ? <H size={14} aria-hidden style={{ color: healthVar(n.health) }} /> : <HealthBadge status={n.health} size="xs" />)}
      </Group>
      <Text className="pv-node-label" size="sm" fw={600} lineClamp={compact ? 2 : 1} title={text.label(n)} fs={n.hidden ? 'italic' : undefined}>
        {text.label(n)}
      </Text>
      {n.detail && !n.hidden && (
        <Text className="pv-node-detail mono" size="xs" c="dimmed" lineClamp={1} title={n.detail} style={{ overflowWrap: 'anywhere' }}>
          {n.detail}
        </Text>
      )}
      {badges && (
        <Group className="pv-node-badges" gap={4} wrap="nowrap" mt={4} style={{ overflow: 'hidden' }}>
          {n.role && (
            <Badge size="xs" variant="outline" color="gray" style={{ textTransform: 'none' }}>
              {text.t(`roles.${n.role}`)}
            </Badge>
          )}
          {n.ports?.map((p) => (
            <Badge key={p} size="xs" variant="light" color="blue" style={{ textTransform: 'none' }}>
              {p}
            </Badge>
          ))}
          {n.lifecycle && (
            <Badge
              size="xs"
              variant="light"
              color={n.lifecycle === 'deprecated' || n.lifecycle === 'retired' ? 'orange' : 'gray'}
              style={{ textTransform: 'none' }}
            >
              {text.t(`lifecycle.${n.lifecycle}`)}
            </Badge>
          )}
          {n.missing && (
            <Badge size="xs" variant="light" color="orange" leftSection={<IconAlertTriangle size={10} aria-hidden />} style={{ textTransform: 'none' }}>
              {text.t('node.missing')}
            </Badge>
          )}
          {n.outside && !!n.products?.length && (
            <Badge size="xs" variant="light" color="gray" style={{ textTransform: 'none' }}>
              {n.products[0]}
              {n.products.length > 1 ? ` +${n.products.length - 1}` : ''}
            </Badge>
          )}
          {!!n.hiddenProducts && (
            <Badge size="xs" variant="light" color="gray" style={{ textTransform: 'none' }}>
              {text.t('node.hiddenProducts', { count: n.hiddenProducts })}
            </Badge>
          )}
        </Group>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const Step = memo(function Step({ data }: NodeProps<StepNode>) {
  const { node: n, dim, hl, selected, match, text } = data;
  return (
    <div
      className="dpv-step"
      style={{ width: STEP_W, height: STEP_H }}
      data-dim={dim || undefined}
      data-hl={hl || undefined}
      data-selected={selected || undefined}
      data-match={match || undefined}
      data-testid={`graph-node-${n.id}`}
      data-kind="step"
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <IconArrowsSplit size={14} aria-hidden style={{ flexShrink: 0 }} />
      <Text size="xs" fw={600} lineClamp={2} fs={n.hidden ? 'italic' : undefined}>
        {text.label(n)}
      </Text>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const Area = memo(function Area({ data }: NodeProps<AreaNode>) {
  const { node: n, dim, width, height, text } = data;
  const I = KIND_ICON[iconKey(n)];
  return (
    <div className="pv-area dpv-area" data-kind={n.kind} data-dim={dim || undefined} data-testid={`graph-area-${n.id}`} style={{ width, height }}>
      <div className="pv-area-label">
        <I size={13} stroke={1.8} aria-hidden style={{ flexShrink: 0 }} />
        <span className="pv-node-kind">{text.kind(n)}</span>
        <span className="pv-area-name">{text.label(n)}</span>
      </div>
    </div>
  );
});

function Header({ data }: NodeProps<HeaderNode>) {
  return (
    <div className="dpv-col-header" style={{ width: data.width }} aria-hidden>
      {data.label}
    </div>
  );
}

const nodeTypes = { part: Part, step: Step, area: Area, header: Header };

type EdgeData = { edge: DataGraphEdge; dim: boolean; hl: boolean; animate: boolean; pill: string };
type WayEdge = Edge<EdgeData, 'way'>;

function Way({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<WayEdge>) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  if (!data) return null;
  const { edge: e, dim, hl, animate, pill } = data;
  const w = 1.4 + Math.min(3, Math.log2(e.count + 1) * 0.7) + (hl ? 1 : 0);
  return (
    <>
      <g className="pv-edge" data-dim={dim || undefined} data-testid={`graph-edge-${id}`} data-deprecated={e.deprecated || undefined}>
        <path
          id={id}
          d={path}
          className="pv-edge-base"
          data-problem={e.deprecated || undefined}
          data-inactive={e.hidden || undefined}
          data-hl={hl || undefined}
          strokeWidth={w}
          markerEnd={markerEnd}
        />
        {animate && !e.deprecated && <path d={path} className="pv-edge-flow" data-hl={hl || undefined} strokeWidth={w + 0.8} />}
      </g>
      {pill && (
        <EdgeLabelRenderer>
          <div
            className="pv-edge-pill nodrag nopan"
            data-problem={e.deprecated || undefined}
            data-dim={dim || undefined}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            aria-hidden
          >
            {e.deprecated && <IconAlertTriangle size={11} aria-hidden />}
            {pill}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { way: Way };

export interface Highlight {
  nodes: Set<string>;
  edges: Set<string>;
}

export interface DataGraphCanvasProps {
  nodes: DataGraphNode[];
  edges: DataGraphEdge[];
  layout: GraphLayout;
  /** The picture's accessible name */
  label: string;
  height: number | string;
  highlight: Highlight | null;
  selected: string | null;
  /** Nodes that match the search */
  matches: Set<string>;
  onSelect: (id: string | null) => void;
  /** Centre on this node when it changes (a search result) */
  focusId: string | null;
  /** Changes when "Fit to screen" is pressed */
  fitKey: number;
  /** Column names (pipeline) */
  headerText?: (index: number) => string;
}

export function DataGraphCanvas(props: DataGraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

/** Below this zoom the picture opens at it, from its upstream side (the rest is a drag, a scroll or a Tab away), so names stay readable. */
const READABLE_ZOOM = 0.85;

function Canvas({
  nodes: graphNodes,
  edges: graphEdges,
  layout,
  label,
  height,
  highlight,
  selected,
  matches,
  onSelect,
  focusId,
  fitKey,
  headerText,
}: DataGraphCanvasProps) {
  const text = useGraphText();
  const t = text.t;
  const scheme = useComputedColorScheme('light');
  const navigate = useNavigate();
  const { animate } = useMotion();
  const rf = useReactFlow();
  const { ref: frame, width: fw, height: fh } = useElementSize();
  const byId = useMemo(() => new Map(graphNodes.map((n) => [n.id, n])), [graphNodes]);
  const nodes = useMemo(() => {
    const flags = (n: DataGraphNode) => ({
      dim: !!highlight && !highlight.nodes.has(n.id),
      hl: !!highlight && highlight.nodes.has(n.id),
      selected: selected === n.id,
      match: matches.has(n.id),
      text,
    });
    const common = { draggable: false, selectable: false, connectable: false };
    const areas: AreaNode[] = [...layout.boxes]
      .map(([id, b]) => {
        const node: DataGraphNode = byId.get(id) ?? { id, kind: 'product', label: '', detail: '', path: null, health: null, group: true };
        return {
          id: `area:${id}`,
          type: 'area' as const,
          position: { x: b.x, y: b.y },
          data: { node, ...flags(node), dim: false, width: b.width, height: b.height },
          ...common,
          focusable: false,
          zIndex: 0,
          width: b.width,
          height: b.height,
        };
      })
      .sort((a, b) => b.width * b.height - a.width * a.height);
    const headers: HeaderNode[] = layout.headers.map((h) => ({
      id: `header:${h.column.index}`,
      type: 'header' as const,
      position: { x: h.x, y: 8 },
      data: { label: headerText?.(h.column.index) ?? text.column(h.column), width: h.width },
      ...common,
      focusable: false,
      zIndex: 0,
    }));
    const parts = graphNodes
      .filter((n) => !n.group)
      .map((n) => {
        const s = nodeSize(n);
        return {
          id: n.id,
          type: n.kind === 'step' ? ('step' as const) : ('part' as const),
          position: layout.pos.get(n.id) ?? { x: 0, y: 0 },
          data: { node: n, ...flags(n) },
          ...common,
          zIndex: 2,
          width: s.width,
          height: s.height,
          ariaLabel: text.aria(n),
        };
      })
      // the order in the page is the order of the keyboard: upstream to downstream, top to bottom in a column
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y) as (PartNode | StepNode)[];
    return [...areas, ...headers, ...parts];
  }, [graphNodes, layout, highlight, selected, matches, byId, text, headerText]);
  const edges: WayEdge[] = useMemo(
    () =>
      graphEdges.map((e) => {
        const hl = !!highlight && highlight.edges.has(e.id);
        const color = e.deprecated ? 'var(--pv-problem)' : hl ? 'var(--pv-hl)' : 'var(--pv-edge)';
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: 'way',
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16, markerUnits: 'userSpaceOnUse' },
          data: { edge: e, dim: !!highlight && !hl, hl, animate, pill: graphNodes.length > 60 && !hl ? '' : text.edge(e) },
          selectable: false,
          focusable: false,
          zIndex: 1,
          ariaLabel: text.edgeAria(e, (id) => (byId.get(id) ? text.label(byId.get(id)!) : id)),
        };
      }),
    [graphEdges, highlight, animate, text, byId, graphNodes.length],
  );
  const nodeIdOf = (el: EventTarget | null) => (el instanceof Element ? el.closest('.react-flow__node')?.getAttribute('data-id') : null) ?? null;
  const onKeyDown = (ev: KeyboardEvent) => {
    const id = nodeIdOf(ev.target);
    if (!id || !byId.has(id)) {
      if (ev.key === 'Escape') onSelect(null);
      return;
    }
    if (ev.key === 'Enter') {
      const p = byId.get(id)?.path;
      if (p) navigate(p);
      else onSelect(selected === id ? null : id);
    } else if (ev.key === ' ') {
      ev.preventDefault();
      onSelect(selected === id ? null : id);
    } else if (ev.key === 'Escape') onSelect(null);
  };
  // the picture is larger than the frame at a readable size: say how to reach the rest
  const [clipped, setClipped] = useState(false);
  const fit = () => {
    if (!fw || !fh) return;
    const zoom = Math.min((fw - 32) / layout.width, (fh - 32) / layout.height, 1);
    setClipped(zoom < READABLE_ZOOM);
    if (zoom >= READABLE_ZOOM) void rf.fitView({ padding: 0.06, maxZoom: 1 });
    else void rf.setViewport({ x: 16, y: Math.max(8, (fh - layout.height * READABLE_ZOOM) / 2), zoom: READABLE_ZOOM });
  };
  // "Fit to screen": everything, however small
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setClipped(false);
    void rf.fitView({ padding: 0.04, minZoom: 0.05, duration: animate ? 300 : 0 });
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps -- only when asked
  useEffect(() => {
    if (focusId && layout.pos.has(focusId))
      void rf.fitView({ nodes: [{ id: focusId }], padding: 0.6, minZoom: READABLE_ZOOM, maxZoom: 1, duration: animate ? 300 : 0 });
  }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the search picks another node
  return (
    <div
      ref={frame}
      className={animate ? 'pv-graph dpv-graph' : 'pv-graph dpv-graph pv-static'}
      style={{ height }}
      data-testid="data-graph"
      data-animated={animate || undefined}
      role="figure"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {fw > 0 && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          onlyRenderVisibleElements={graphNodes.length > 100}
          onNodeClick={(_e, n) => {
            if (byId.has(n.id) && !byId.get(n.id)!.group) onSelect(selected === n.id ? null : n.id);
          }}
          onPaneClick={() => onSelect(null)}
          onInit={fit}
          minZoom={0.05}
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
          {clipped && (
            <Panel position="top-right" className="dpv-pan-hint" data-testid="graph-pan-hint">
              {t('graph.panHint')}
            </Panel>
          )}
        </ReactFlow>
      )}
    </div>
  );
}
