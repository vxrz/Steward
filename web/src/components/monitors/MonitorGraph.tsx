import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useTranslation } from 'react-i18next';
import { type CheckDef, type CheckState, type MonitorDefinition, type MonitorStatus } from '@sm/shared';
import { CHECK_ICONS } from './checkMeta';
import { MONITOR_COLORS, checkTypeLabel, monitorStatusLabel } from './status';

export const NODE_W = 250;
export const NODE_H = 86;

type CheckNodeData = {
  check: CheckDef;
  state?: CheckState;
  root: boolean;
  /** The check deviates from its state's expectation while the settle time runs (it does not count yet) */
  settling?: boolean;
  editable: boolean;
  /** The editor found a problem on this card */
  problem?: boolean;
};
type CheckRfNode = Node<CheckNodeData, 'check'>;

const CheckNode = memo(function CheckNode({ data, selected }: NodeProps<CheckRfNode>) {
  const { check, state, root, problem, settling } = data;
  const { t } = useTranslation('monitors');
  const status: MonitorStatus | undefined = state?.status;
  // settling: amber, not red – the deviation does not count until the settle time ends
  const color = settling ? 'orange' : status ? MONITOR_COLORS[status] : 'gray';
  const Icon = CHECK_ICONS[check.type];
  const caused = !!state?.causedBy.length;
  return (
    <Box
      data-testid={`monitor-node-${check.id}`}
      data-status={status ?? 'none'}
      data-settling={settling ? 'true' : undefined}
      data-problem={problem ? 'true' : undefined}
      style={{
        width: NODE_W,
        minHeight: NODE_H,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--mantine-color-body)',
        border: `${root ? 3 : 1}px ${caused ? 'dashed' : 'solid'} var(--mantine-color-${color}-${root ? 7 : 5})`,
        borderLeft: `6px solid var(--mantine-color-${color}-6)`,
        boxShadow: selected ? '0 0 0 3px var(--mantine-color-accent-4)' : problem ? '0 0 0 2px var(--mantine-color-red-6)' : '0 1px 3px rgba(0,0,0,.15)',
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
          <Badge size="xs" color={color} variant={settling ? 'outline' : 'filled'} style={{ flexShrink: 0 }}>
            {monitorStatusLabel(status)}
          </Badge>
        )}
        {problem && (
          <Badge size="xs" color="red" variant="light" style={{ flexShrink: 0 }}>
            {t('editor.problemBadge')}
          </Badge>
        )}
      </Group>
      <Text size="xs" c="dimmed" truncate>
        {checkTypeLabel(check.type)}
        {check.critical === false ? ` · ${t('graph.nonCritical')}` : ''}
        {check.enabled === false ? ` · ${t('list.disabled')}` : ''}
      </Text>
      {state?.last && (
        <Tooltip label={state.last.message} multiline w={320} withArrow openDelay={300}>
          <Text size="xs" lineClamp={1} c={status === 'down' && !settling ? 'red' : undefined}>
            {state.last.message}
          </Text>
        </Tooltip>
      )}
      {settling && (
        <Text size="xs" fw={700} c="orange.8" data-testid="check-settling">
          {t('states.settlingCard')}
        </Text>
      )}
      {root && (
        <Text size="xs" fw={700} c="red">
          {t('list.rootCause')}
        </Text>
      )}
      {caused && (
        <Text size="xs" c="orange" truncate>
          {t('detail.likelyCausedBy', { causes: state!.causedBy.map((c) => (c.hidden ? t('detail.hiddenMonitor') : c.checkName)).join(', ') })}
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
  /** Checks that deviate while the state settles: drawn amber with "settling", not red */
  settlingIds?: string[];
  selected?: string | null;
  onSelect?: (checkId: string | null) => void;
  /** Editing: positions, new links, link mode / removal */
  onChange?: (def: MonitorDefinition) => void;
  onLinkClick?: (index: number) => void;
  height?: number | string;
  /**
   * Editing: a stable key per check (same order as `def.checks`), so two cards with the same id stay two cards
   * (#141). `selected` and `onSelect` use these keys then; without them the check ids are the keys.
   */
  nodeKeys?: string[];
  /** Editing: keys of the cards with a problem */
  problems?: Set<string>;
  /**
   * Editing: several cards selected (shift-click, or shift-drag a box): their keys. `onMultiSelect` hears every change
   * of the selection (one card, several, none).
   */
  multiSelected?: string[];
  onMultiSelect?: (keys: string[]) => void;
}

export function MonitorGraph(props: MonitorGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

const NO_ROOTS: string[] = [];
const NO_KEYS: string[] = [];

function GraphInner({
  def,
  states,
  rootCauseIds = NO_ROOTS,
  settlingIds = NO_ROOTS,
  selected,
  onSelect,
  onChange,
  onLinkClick,
  height = 460,
  nodeKeys,
  problems,
  multiSelected = NO_KEYS,
  onMultiSelect,
}: MonitorGraphProps) {
  const scheme = useComputedColorScheme('light');
  const { t } = useTranslation('monitors');
  const editable = !!onChange;
  const layout = useMemo(() => autoLayout(def), [def]);
  const stateOf = useMemo(() => new Map((states ?? []).map((s) => [s.checkId, s])), [states]);
  const rootKey = rootCauseIds.join('|');
  const settlingKey = settlingIds.join('|');
  const multiKey = multiSelected.join('|');
  // node key per check: the editor's stable keys, otherwise the check ids
  const keys = useMemo(() => def.checks.map((c, i) => nodeKeys?.[i] ?? c.id), [def.checks, nodeKeys]);
  const indexOfKey = useMemo(() => new Map(keys.map((k, i) => [k, i])), [keys]);
  // links name check ids: the first card with that id
  const keyOfId = useMemo(() => {
    const m = new Map<string, string>();
    def.checks.forEach((c, i) => !m.has(c.id) && m.set(c.id, keys[i]!));
    return m;
  }, [def.checks, keys]);
  // What the person selected in the graph itself (a click, shift-click, a box): React Flow shows that already, so a
  // rebuild keeps its selection. A selection the editor sets (a new card, a problem it leads to) is applied.
  const clicked = useRef<string | null | undefined>(undefined);
  const reported = useRef<string | undefined>(undefined);
  const build = useCallback(
    (prev: CheckRfNode[] = []): CheckRfNode[] => {
      const before = new Map(prev.map((n) => [n.id, n]));
      const own = editable && prev.length > 0 && (selected === clicked.current || (!!multiKey && multiKey === reported.current));
      return def.checks.map((c, i) => {
        const id = keys[i]!;
        return {
          id,
          type: 'check',
          position: c.x !== undefined && c.y !== undefined ? { x: c.x, y: c.y } : (layout.get(c.id) ?? { x: 0, y: i * (NODE_H + 70) }),
          data: {
            check: c,
            state: stateOf.get(c.id),
            root: rootKey.split('|').includes(c.id),
            settling: settlingKey.split('|').includes(c.id),
            editable,
            problem: problems?.has(id),
          },
          selected: own && before.has(id) ? !!before.get(id)!.selected : id === selected || (!!multiKey && multiKey.split('|').includes(id)),
          draggable: editable,
          deletable: false,
          // keep the measured size, otherwise the node is hidden until it is measured again
          measured: before.get(id)?.measured,
        };
      });
    },
    [def, keys, layout, stateOf, rootKey, settlingKey, selected, editable, problems, multiKey],
  );
  // one handler for the whole life of the graph: React Flow reports the selection again whenever its handler changes
  const multiRef = useRef(onMultiSelect);
  useEffect(() => {
    multiRef.current = onMultiSelect;
  });
  const hasMulti = !!onMultiSelect;
  const onSelectionChange = useCallback(({ nodes: ns }: { nodes: Node[] }) => {
    reported.current = ns.map((n) => n.id).join('|');
    multiRef.current?.(ns.map((n) => n.id));
  }, []);
  const [nodes, setNodes] = useState<CheckRfNode[]>(() => build());
  useEffect(() => setNodes((prev) => build(prev)), [build]);

  const failing = (id: string) => ['down', 'blocked'].includes(stateOf.get(id)?.status ?? '');
  const edges: Edge[] = def.links.map((l, i) => {
    const hot = failing(l.from) && !!stateOf.get(l.to)?.causedBy.length;
    const stroke = hot ? 'var(--mantine-color-red-6)' : scheme === 'dark' ? 'var(--mantine-color-gray-5)' : 'var(--mantine-color-gray-6)';
    return {
      id: `l${i}`,
      source: keyOfId.get(l.from) ?? l.from,
      target: keyOfId.get(l.to) ?? l.to,
      label: l.mode === 'hard' ? t('graph.hard') : undefined,
      style: { stroke, strokeWidth: hot ? 2.5 : 1.6, strokeDasharray: l.mode === 'hard' ? undefined : '6 4' },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      data: { index: i, mode: l.mode },
      ariaLabel: t(l.mode === 'hard' ? 'graph.hardLinkAria' : 'graph.softLinkAria', { from: l.from, to: l.to }),
    };
  });

  const onNodesChange = (changes: NodeChange<CheckRfNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (!onChange) return;
    const moved = changes.filter((c) => c.type === 'position' && c.dragging === false && c.position);
    if (!moved.length) return;
    const pos = new Map(moved.map((c) => [indexOfKey.get((c as { id: string }).id), (c as { position: { x: number; y: number } }).position]));
    onChange({ ...def, checks: def.checks.map((c, i) => (pos.has(i) ? { ...c, x: Math.round(pos.get(i)!.x), y: Math.round(pos.get(i)!.y) } : c)) });
  };
  const onConnect = (c: Connection) => {
    if (!onChange || !c.source || !c.target || c.source === c.target) return;
    const from = def.checks[indexOfKey.get(c.source) ?? -1]?.id;
    const to = def.checks[indexOfKey.get(c.target) ?? -1]?.id;
    if (!from || !to || from === to || def.links.some((l) => l.from === from && l.to === to)) return;
    onChange({ ...def, links: [...def.links, { from, to, mode: 'soft' }] });
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
        onNodeClick={(_e, n) => ((clicked.current = n.id), onSelect?.(n.id))}
        onPaneClick={() => ((clicked.current = null), onSelect?.(null))}
        onSelectionChange={hasMulti ? onSelectionChange : undefined}
        // several cards: shift-click (or the usual Ctrl/Cmd), or shift-drag a box around them (React Flow's default)
        multiSelectionKeyCode={editable ? ['Shift', 'Meta', 'Control'] : undefined}
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
