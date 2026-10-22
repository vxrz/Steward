import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Badge, Box, Group, Text, Tooltip, useComputedColorScheme } from '@mantine/core';
import { CHECK_TYPE_INFO, type CheckDef, type CheckState, type MonitorDefinition, type MonitorStatus } from '@sm/shared';
import { CHECK_ICONS } from './checkMeta';
import { MONITOR_COLORS, MONITOR_LABELS } from './status';

export const NODE_W = 250;
export const NODE_H = 86;

type CheckNodeData = {
  check: CheckDef;
  state?: CheckState;
  root: boolean;
  editable: boolean;
};
type CheckRfNode = Node<CheckNodeData, 'check'>;

const CheckNode = memo(function CheckNode({ data, selected }: NodeProps<CheckRfNode>) {
  const { check, state, root } = data;
  const status: MonitorStatus | undefined = state?.status;
  const color = status ? MONITOR_COLORS[status] : 'gray';
  const Icon = CHECK_ICONS[check.type];
  const caused = !!state?.causedBy.length;
  return (
    <Box
      data-testid={`monitor-node-${check.id}`}
      data-status={status ?? 'none'}
      style={{
        width: NODE_W,
        minHeight: NODE_H,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--mantine-color-body)',
        border: `${root ? 3 : 1}px ${caused ? 'dashed' : 'solid'} var(--mantine-color-${color}-${root ? 7 : 5})`,
        borderLeft: `6px solid var(--mantine-color-${color}-6)`,
        boxShadow: selected ? '0 0 0 3px var(--mantine-color-blue-4)' : '0 1px 3px rgba(0,0,0,.15)',
        opacity: check.enabled === false ? 0.55 : 1,
      }}
    >
      <Handle type="target" position={Position.Top} isConnectable={data.editable} />
      <Group gap={6} wrap="nowrap" justify="space-between">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Icon size={16} stroke={1.6} aria-hidden />
          <Text size="sm" fw={600} lineClamp={2} title={check.name} style={{ lineHeight: 1.25 }}>
            {check.name}
          </Text>
        </Group>
        {status && (
          <Badge size="xs" color={color} variant="filled" style={{ flexShrink: 0 }}>
            {MONITOR_LABELS[status]}
          </Badge>
        )}
      </Group>
      <Text size="xs" c="dimmed" truncate>
        {CHECK_TYPE_INFO[check.type].label}
        {check.critical === false ? ' · non-critical' : ''}
        {check.enabled === false ? ' · disabled' : ''}
      </Text>
      {state?.last && (
        <Tooltip label={state.last.message} multiline w={320} withArrow openDelay={300}>
          <Text size="xs" lineClamp={1} c={status === 'down' ? 'red' : undefined}>
            {state.last.message}
          </Text>
        </Tooltip>
      )}
      {root && (
        <Text size="xs" fw={700} c="red">
          Root cause
        </Text>
      )}
      {caused && (
        <Text size="xs" c="orange" truncate>
          Likely caused by {state!.causedBy.map((c) => c.checkName).join(', ')}
        </Text>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={data.editable} />
    </Box>
  );
});

const nodeTypes = { check: CheckNode };

/** Positions for checks without coordinates: rows by dependency depth. */
export function autoLayout(def: MonitorDefinition): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const parents = new Map<string, string[]>();
  for (const l of def.links) parents.set(l.to, [...(parents.get(l.to) ?? []), l.from]);
  const d = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const v = Math.max(-1, ...(parents.get(id) ?? []).map((p) => d(p, seen))) + 1;
    depth.set(id, v);
    return v;
  };
  const rows = new Map<number, string[]>();
  for (const c of def.checks) {
    const k = d(c.id);
    rows.set(k, [...(rows.get(k) ?? []), c.id]);
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [k, ids] of rows) ids.forEach((id, i) => out.set(id, { x: (i - (ids.length - 1) / 2) * (NODE_W + 40), y: k * (NODE_H + 70) }));
  return out;
}

export interface MonitorGraphProps {
  def: MonitorDefinition;
  states?: CheckState[];
  rootCauseIds?: string[];
  selected?: string | null;
  onSelect?: (checkId: string | null) => void;
  /** Editing: positions, new links, link mode / removal */
  onChange?: (def: MonitorDefinition) => void;
  onLinkClick?: (index: number) => void;
  height?: number | string;
}

export function MonitorGraph(props: MonitorGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

const NO_ROOTS: string[] = [];

function GraphInner({ def, states, rootCauseIds = NO_ROOTS, selected, onSelect, onChange, onLinkClick, height = 460 }: MonitorGraphProps) {
  const scheme = useComputedColorScheme('light');
  const editable = !!onChange;
  const layout = useMemo(() => autoLayout(def), [def]);
  const stateOf = useMemo(() => new Map((states ?? []).map((s) => [s.checkId, s])), [states]);
  const rootKey = rootCauseIds.join('|');
  const build = useCallback(
    (prev: CheckRfNode[] = []): CheckRfNode[] => {
      const before = new Map(prev.map((n) => [n.id, n]));
      return def.checks.map((c) => ({
        id: c.id,
        type: 'check',
        position: c.x !== undefined && c.y !== undefined ? { x: c.x, y: c.y } : layout.get(c.id)!,
        data: { check: c, state: stateOf.get(c.id), root: rootKey.split('|').includes(c.id), editable },
        selected: c.id === selected,
        draggable: editable,
        deletable: false,
        // keep the measured size, otherwise the node is hidden until it is measured again
        measured: before.get(c.id)?.measured,
      }));
    },
    [def, layout, stateOf, rootKey, selected, editable],
  );
  const [nodes, setNodes] = useState<CheckRfNode[]>(() => build());
  useEffect(() => setNodes((prev) => build(prev)), [build]);

  const failing = (id: string) => ['down', 'blocked'].includes(stateOf.get(id)?.status ?? '');
  const edges: Edge[] = def.links.map((l, i) => {
    const hot = failing(l.from) && !!stateOf.get(l.to)?.causedBy.length;
    const stroke = hot ? 'var(--mantine-color-red-6)' : scheme === 'dark' ? 'var(--mantine-color-gray-5)' : 'var(--mantine-color-gray-6)';
    return {
      id: `l${i}`,
      source: l.from,
      target: l.to,
      label: l.mode === 'hard' ? 'hard' : undefined,
      style: { stroke, strokeWidth: hot ? 2.5 : 1.6, strokeDasharray: l.mode === 'hard' ? undefined : '6 4' },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      data: { index: i, mode: l.mode },
      ariaLabel: `${l.mode} link from ${l.from} to ${l.to}`,
    };
  });

  const onNodesChange = (changes: NodeChange<CheckRfNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (!onChange) return;
    const moved = changes.filter((c) => c.type === 'position' && c.dragging === false && c.position);
    if (!moved.length) return;
    const pos = new Map(moved.map((c) => [(c as { id: string }).id, (c as { position: { x: number; y: number } }).position]));
    onChange({ ...def, checks: def.checks.map((c) => (pos.has(c.id) ? { ...c, x: Math.round(pos.get(c.id)!.x), y: Math.round(pos.get(c.id)!.y) } : c)) });
  };
  const onConnect = (c: Connection) => {
    if (!onChange || !c.source || !c.target || c.source === c.target) return;
    if (def.links.some((l) => l.from === c.source && l.to === c.target)) return;
    onChange({ ...def, links: [...def.links, { from: c.source, to: c.target, mode: 'soft' }] });
  };
  const onEdgeClick: EdgeMouseHandler = (_e, edge) => onLinkClick?.((edge.data as { index: number }).index);

  return (
    <Box h={height} style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }} data-testid="monitor-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgeClick={onEdgeClick}
        onNodeClick={(_e, n) => onSelect?.(n.id)}
        onPaneClick={() => onSelect?.(null)}
        nodesConnectable={editable}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        colorMode={scheme}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </Box>
  );
}
