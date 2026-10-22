import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ActionIcon, Box, Button, Drawer, Group, Paper, ScrollArea, Stack, Tabs, Text, Tooltip, useComputedColorScheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconArrowBackUp, IconArrowForwardUp, IconCopy, IconLayoutDistributeHorizontal, IconPlus, IconTrash } from '@tabler/icons-react';
import { NODE_HEIGHT, NODE_WIDTH, type FlowNode, type NodeType, type ProcessDefinition, type Wire } from '@sm/shared';
import { notifyOk } from '../../api';
import { NodeForm, ExpressionHelp } from '../editor/NodeForm';
import { NodeInspector } from '../editor/NodeInspector';
import { isMac, isTextTarget, modKey } from '../editor/useDefHistory';
import { copyNodes, pasteNodes, readClipboard, writeClipboard } from './clipboard';
import { FlowNodeView, type FlowNodeData, type FlowRfNode, type NodeRunStatus } from './FlowNodeView';
import { DND_TYPE, Palette } from './Palette';
import { nodeColor } from './meta';
import {
  addNode,
  addWire,
  allIds,
  createNode,
  duplicateNode,
  moveNodes,
  removeNodes,
  removeWires,
  renameNode,
  tidy,
  updateNode,
  wireError,
  wireId,
} from './graphOps';

type Def = ProcessDefinition;

export interface FlowEditorProps {
  def: Def;
  /** coalesceKey: changes with the same key in quick succession form one undo step */
  onChange: (d: Def, coalesceKey?: string) => void;
  /** Saved process id (live preview, node inspector) */
  processId?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Changes on undo/redo (forms are re-created) */
  historySeq?: number;
  issuesByNode: Map<string, string>;
  warningsByNode: Map<string, string>;
  runStatus?: Map<string, NodeRunStatus>;
  /** Select and center a node (seq changes trigger the focus). */
  focus?: { id: string; seq: number } | null;
  /** Extra controls shown in the canvas toolbar. */
  toolbar?: ReactNode;
  height: string;
  /** View only: no dragging, wiring, adding or deleting; properties are shown disabled. */
  readOnly?: boolean;
}

const nodeTypes: NodeTypes = { flow: FlowNodeView };

export function FlowEditor(props: FlowEditorProps) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function toRfNode(n: FlowNode, data: Omit<FlowNodeData, 'node'>, prev?: Node): FlowRfNode {
  return {
    id: n.id,
    type: 'flow',
    position: { x: n.x, y: n.y },
    data: { node: n, ...data },
    selected: prev?.selected ?? false,
    measured: prev?.measured,
    zIndex: n.type === 'note' ? -1 : 0,
    deletable: n.type !== 'start',
  };
}

function FlowEditorInner({
  def,
  onChange,
  processId,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  historySeq = 0,
  issuesByNode,
  warningsByNode,
  runStatus,
  focus,
  toolbar,
  height,
  readOnly = false,
}: FlowEditorProps) {
  const rf = useReactFlow();
  const isMobile = useMediaQuery('(max-width: 62em)') ?? false;
  const scheme = useComputedColorScheme('light');
  const wrapper = useRef<HTMLDivElement>(null);
  const defRef = useRef(def);
  defRef.current = def;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [panelTab, setPanelTab] = useState<string>('props');
  /** Node id(s) to select after the next definition change. */
  const pendingSelect = useRef<string | string[] | null>(null);
  /** New id of a node being renamed – selection events caused by the id swap are ignored. */
  const renaming = useRef<string | null>(null);

  const dataFor = useCallback(
    (id: string) => ({ issue: issuesByNode.get(id), warning: warningsByNode.get(id), run: runStatus?.get(id) }),
    [issuesByNode, warningsByNode, runStatus],
  );

  const [rfNodes, setRfNodes] = useState<FlowRfNode[]>(() => def.nodes.map((n) => toRfNode(n, dataFor(n.id))));

  // keep React Flow's node list in sync with the definition (preserving measurements / selection)
  useEffect(() => {
    setRfNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      const sel = pendingSelect.current;
      pendingSelect.current = null;
      const selSet = sel === null ? null : new Set(Array.isArray(sel) ? sel : [sel]);
      return def.nodes.map((n) => {
        const node = toRfNode(n, dataFor(n.id), byId.get(n.id));
        if (selSet) node.selected = selSet.has(n.id);
        return node;
      });
    });
  }, [def.nodes, dataFor]);

  const select = (id: string | null) => {
    setSelectedId(id);
    setFormKey((k) => k + 1);
  };

  const edges: Edge[] = useMemo(
    () =>
      def.wires.map((w) => {
        const id = wireId(w);
        const err = w.port === 'error';
        return {
          id,
          source: w.from,
          sourceHandle: w.port,
          target: w.to,
          selected: selectedEdges.has(id),
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: err ? 'var(--mantine-color-red-6)' : undefined },
          style: err ? { stroke: 'var(--mantine-color-red-6)', strokeDasharray: '5 4' } : undefined,
        };
      }),
    [def.wires, selectedEdges],
  );

  const onNodesChange = useCallback((changes: NodeChange<FlowRfNode>[]) => {
    setRfNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setSelectedEdges((prev) => {
      let next: Set<string> | null = null;
      for (const c of changes) {
        if (c.type === 'select') {
          next ??= new Set(prev);
          if (c.selected) next.add(c.id);
          else next.delete(c.id);
        }
      }
      return next ?? prev;
    });
  }, []);

  const onSelectionChange = useCallback(({ nodes }: { nodes: Node[] }) => {
    const id = nodes.length === 1 ? nodes[0]!.id : null;
    if (renaming.current) {
      if (id === renaming.current) renaming.current = null;
      return;
    }
    setSelectedId((cur) => {
      if (cur !== id) setFormKey((k) => k + 1);
      return id;
    });
  }, []);

  const onNodeDragStop = useCallback(
    (_e: unknown, _node: Node, nodes: Node[]) => {
      const pos = new Map(nodes.map((n) => [n.id, n.position]));
      onChange(moveNodes(defRef.current, pos));
    },
    [onChange],
  );

  const onBeforeDelete = useCallback(async ({ nodes, edges: es }: { nodes: FlowRfNode[]; edges: Edge[] }) => {
    return { nodes: nodes.filter((n) => n.data.node.type !== 'start'), edges: es };
  }, []);

  const onDelete = useCallback(
    ({ nodes, edges: es }: { nodes: Node[]; edges: Edge[] }) => {
      let d = removeWires(defRef.current, es.map((e) => e.id));
      d = removeNodes(d, nodes.map((n) => n.id));
      if (nodes.some((n) => n.id === selectedId)) select(null);
      setSelectedEdges(new Set());
      onChange(d);
    },
    [onChange, selectedId],
  );

  const toWire = (c: Connection | Edge): Wire => ({ from: c.source, port: c.sourceHandle ?? 'out', to: c.target });
  const isValidConnection = useCallback((c: Connection | Edge) => !wireError(defRef.current, toWire(c)), []);
  const onConnect = useCallback((c: Connection) => onChange(addWire(defRef.current, toWire(c))), [onChange]);

  const place = (type: NodeType, x: number, y: number) => {
    let px = x;
    let py = y;
    while (defRef.current.nodes.some((n) => Math.abs(n.x - px) < 20 && Math.abs(n.y - py) < 20)) {
      px += 30;
      py += 30;
    }
    const node = createNode(defRef.current, type, px, py);
    pendingSelect.current = node.id;
    select(node.id);
    onChange(addNode(defRef.current, node));
  };

  const addAtCenter = (type: NodeType) => {
    const r = wrapper.current?.getBoundingClientRect();
    const p = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
    place(type, p.x - NODE_WIDTH / 2, p.y - NODE_HEIGHT / 2);
    setPaletteOpen(false);
  };

  const onDrop = (e: React.DragEvent) => {
    const type = e.dataTransfer.getData(DND_TYPE) as NodeType;
    if (!type) return;
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    place(type, p.x - NODE_WIDTH / 2, p.y - NODE_HEIGHT / 2);
  };

  /** Fit the whole flow if it stays readable, otherwise start at the Start node. */
  const initialView = useCallback(() => {
    const nodes = defRef.current.nodes;
    const r = wrapper.current?.getBoundingClientRect();
    if (!nodes.length || !r) return;
    const minX = Math.min(...nodes.map((n) => n.x));
    const maxX = Math.max(...nodes.map((n) => n.x)) + NODE_WIDTH;
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxY = Math.max(...nodes.map((n) => n.y)) + NODE_HEIGHT;
    const fitZoom = Math.min(r.width / ((maxX - minX) * 1.15), r.height / ((maxY - minY) * 1.3 + 80));
    if (fitZoom >= 0.5) {
      rf.fitView({ padding: 0.15, maxZoom: 1.1 });
      return;
    }
    // Too big to fit readably: fit the width (within limits) and show the top of the flow.
    const zoom = Math.max(0.45, Math.min(1, r.width / (maxX - minX + 80)));
    const x = Math.max(20 - minX * zoom, (r.width - (maxX - minX) * zoom) / 2 - minX * zoom);
    rf.setViewport({ x, y: 40 - minY * zoom, zoom });
  }, [rf]);

  // focus requests (e.g. clicking a validation issue)
  useEffect(() => {
    if (!focus) return;
    const n = defRef.current.nodes.find((x) => x.id === focus.id);
    if (!n) return;
    setRfNodes((nds) => nds.map((x) => ({ ...x, selected: x.id === n.id })));
    select(n.id);
    rf.setCenter(n.x + NODE_WIDTH / 2, n.y + NODE_HEIGHT / 2, { zoom: 1.1, duration: 400 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  // undo/redo: re-create the form (it keeps local drafts) and drop a selection that no longer exists
  useEffect(() => {
    if (!historySeq) return;
    setFormKey((k) => k + 1);
    setSelectedId((cur) => (cur && defRef.current.nodes.some((n) => n.id === cur) ? cur : null));
  }, [historySeq]);

  // copy / paste of selected nodes (also across processes, via localStorage)
  const rfNodesRef = useRef(rfNodes);
  rfNodesRef.current = rfNodes;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const k = e.key.toLowerCase();
      if (k !== 'c' && k !== 'v') return;
      if (isTextTarget(e.target) || window.getSelection()?.toString()) return;
      if (document.querySelector('.mantine-Modal-content')) return;
      if (k === 'c') {
        const ids = rfNodesRef.current.filter((n) => n.selected).map((n) => n.id);
        const clip = copyNodes(defRef.current, ids);
        if (!clip) return;
        e.preventDefault();
        writeClipboard(clip);
        notifyOk(`${clip.nodes.length} node(s) copied – paste with ${modKey}V, also in another process`);
      } else {
        if (readOnly) return;
        const clip = readClipboard();
        if (!clip) return;
        e.preventDefault();
        const [d, ids] = pasteNodes(defRef.current, clip);
        if (!ids.length) return;
        pendingSelect.current = ids;
        select(ids.length === 1 ? ids[0]! : null);
        onChange(d);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange, readOnly]);

  const selectedNode = selectedId ? def.nodes.find((n) => n.id === selectedId) : undefined;
  const otherIds = useMemo(() => {
    const s = allIds(def);
    if (selectedId) s.delete(selectedId);
    return s;
  }, [def, selectedId]);

  const deleteSelected = () => {
    if (!selectedNode || selectedNode.type === 'start') return;
    onChange(removeNodes(def, [selectedNode.id]));
    select(null);
  };
  const duplicateSelected = () => {
    if (!selectedNode) return;
    const [d, id] = duplicateNode(def, selectedNode.id);
    if (id) {
      pendingSelect.current = id;
      select(id);
    }
    onChange(d);
  };

  const form = selectedNode ? (
    <Stack gap="sm">
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <NodeForm
          key={formKey}
          node={selectedNode}
          otherIds={otherIds}
          connections={def.connections ?? []}
          onChange={(n) => onChange(updateNode(defRef.current, selectedNode.id, n), `form:${formKey}`)}
          onRename={(newId) => {
            pendingSelect.current = newId;
            renaming.current = newId;
            setTimeout(() => {
              if (renaming.current === newId) renaming.current = null;
            }, 300);
            setSelectedId(newId);
            onChange(renameNode(defRef.current, selectedNode.id, newId), `form:${formKey}`);
          }}
        />
      </fieldset>
      <ExpressionHelp />
    </Stack>
  ) : null;

  const properties = selectedNode ? (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" fw={700} tt="uppercase" c="dimmed">
          Properties
        </Text>
        <Group gap={4}>
          <Tooltip label="Duplicate">
            <ActionIcon variant="subtle" size="sm" onClick={duplicateSelected} disabled={readOnly || selectedNode.type === 'start'} aria-label="Duplicate">
              <IconCopy size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete (Del)">
            <ActionIcon variant="subtle" color="red" size="sm" onClick={deleteSelected} disabled={readOnly || selectedNode.type === 'start'} aria-label="Delete">
              <IconTrash size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {selectedNode.type === 'note' ? (
        form
      ) : (
        <Tabs value={panelTab} onChange={(v) => setPanelTab(v ?? 'props')} keepMounted={false}>
          <Tabs.List grow>
            <Tabs.Tab value="props">Properties</Tabs.Tab>
            <Tabs.Tab value="run" rightSection={runStatus?.get(selectedNode.id) ? <RunDot status={runStatus.get(selectedNode.id)!.status} /> : undefined}>
              Last run
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="props" pt="sm">
            {form}
          </Tabs.Panel>
          <Tabs.Panel value="run" pt="sm">
            <NodeInspector processId={processId} nodeId={selectedNode.id} />
          </Tabs.Panel>
        </Tabs>
      )}
    </Stack>
  ) : (
    <Stack gap="sm">
      <Text size="xs" fw={700} tt="uppercase" c="dimmed">
        Properties
      </Text>
      <Text size="sm" c="dimmed">
        {readOnly
          ? 'Read-only: select a node to see its configuration.'
          : `Select a node to edit it. Drag from an output (right) to an input (left) to connect nodes. Select a wire or node and press Delete to remove it. ${modKey}C / ${modKey}V copy and paste selected nodes; ${modKey}Z undoes.`}
      </Text>
      <Text size="xs" c="dimmed">
        The run starts at the Start node and follows the wires. Where one output has several wires, they run one after another, top to bottom.
      </Text>
      <ExpressionHelp />
    </Stack>
  );

  const canvas = (
    <Box ref={wrapper} style={{ flex: 1, minWidth: 0, height: '100%', position: 'relative' }} onDragOver={(e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }} onDrop={readOnly ? undefined : onDrop}>
      <ReactFlow<FlowRfNode, Edge>
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onNodeDragStop={onNodeDragStop}
        onBeforeDelete={onBeforeDelete}
        onDelete={onDelete}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={!readOnly}
        colorMode={scheme}
        onInit={initialView}
        minZoom={0.15}
        snapToGrid
        snapGrid={[10, 10]}
        defaultEdgeOptions={{ type: 'default' }}
        onPaneClick={() => isMobile && select(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        {!isMobile && (
          <MiniMap pannable zoomable nodeColor={(n) => `var(--mantine-color-${nodeColor((n.data as FlowNodeData).node.type)}-5)`} style={{ height: 90, width: 140 }} />
        )}
        <Panel position="top-right">
          <Group gap={6}>
            {toolbar}
            {!readOnly && (onUndo || onRedo) && (
              <Group gap={2} wrap="nowrap" px={2} py={1} style={{ background: 'var(--mantine-color-body)', borderRadius: 6, border: '1px solid var(--mantine-color-default-border)' }}>
                <Tooltip label={`Undo (${modKey}Z)`}>
                  <ActionIcon size="sm" variant="subtle" color="gray" onClick={onUndo} disabled={!canUndo} aria-label="Undo">
                    <IconArrowBackUp size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={`Redo (${modKey}${isMac ? '⇧' : 'Shift+'}Z)`}>
                  <ActionIcon size="sm" variant="subtle" color="gray" onClick={onRedo} disabled={!canRedo} aria-label="Redo">
                    <IconArrowForwardUp size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            )}
            {!readOnly && (
            <Tooltip label="Arrange nodes automatically">
              <Button
                size="compact-xs"
                variant="default"
                leftSection={<IconLayoutDistributeHorizontal size={14} />}
                onClick={() => {
                  onChange(tidy(defRef.current));
                  setTimeout(() => rf.fitView({ padding: 0.2, maxZoom: 1.1, duration: 300 }), 60);
                }}
              >
                Tidy up
              </Button>
            </Tooltip>
            )}
          </Group>
        </Panel>
        {isMobile && !readOnly && (
          <Panel position="top-left">
            <Button size="compact-xs" leftSection={<IconPlus size={14} />} onClick={() => setPaletteOpen(true)}>
              Add node
            </Button>
          </Panel>
        )}
      </ReactFlow>
    </Box>
  );

  if (isMobile) {
    return (
      <Paper withBorder style={{ height, minHeight: 420, overflow: 'hidden', display: 'flex' }}>
        {canvas}
        <Drawer opened={paletteOpen} onClose={() => setPaletteOpen(false)} position="bottom" size="70%" title="Add node">
          <Box h="55vh">
            <Palette onAdd={addAtCenter} compact />
          </Box>
        </Drawer>
        <Drawer
          opened={!!selectedNode}
          onClose={() => {
            setRfNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
            select(null);
          }}
          position="right"
          size="100%"
          title={selectedNode ? selectedNode.name || selectedNode.id : ''}
        >
          {properties}
        </Drawer>
      </Paper>
    );
  }

  return (
    <Paper withBorder style={{ height, minHeight: 480, overflow: 'hidden', display: 'flex' }}>
      {!readOnly && (
        <Box p="xs" style={{ width: 180, flexShrink: 0, borderRight: '1px solid var(--mantine-color-default-border)', height: '100%' }}>
          <Palette onAdd={addAtCenter} />
        </Box>
      )}
      {canvas}
      <ScrollArea style={{ width: 380, flexShrink: 0, borderLeft: '1px solid var(--mantine-color-default-border)', height: '100%' }} type="auto">
        <Box p="sm">{properties}</Box>
      </ScrollArea>
    </Paper>
  );
}

const DOT_COLOR: Record<string, string> = { succeeded: 'green', failed: 'red', dryrun: 'yellow', waiting: 'violet', running: 'blue', skipped: 'gray' };
function RunDot({ status }: { status: string }) {
  return <Box style={{ width: 8, height: 8, borderRadius: 8, background: `var(--mantine-color-${DOT_COLOR[status] ?? 'gray'}-6)` }} />;
}
