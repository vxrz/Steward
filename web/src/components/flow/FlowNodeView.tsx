import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Badge, Box, Group, Text, Tooltip } from '@mantine/core';
import { IconEyeCheck, IconFilter, IconUsers } from '@tabler/icons-react';
import { NODE_HEIGHT, NODE_WIDTH, STEP_META, hasInput, nodePorts, type FlowNode } from '@sm/shared';
import { Markdown } from '../common';
import { NODE_ICONS, nodeColor, nodeSummary } from './meta';

export interface NodeRunStatus {
  counts: Record<string, number>;
  /** Dominant status for the dot color */
  status: string;
}

export type FlowNodeData = {
  node: FlowNode;
  issue?: string;
  warning?: string;
  run?: NodeRunStatus;
};

export type FlowRfNode = Node<FlowNodeData, 'flow'>;

const STATUS_COLOR: Record<string, string> = {
  succeeded: 'green',
  failed: 'red',
  dryrun: 'yellow',
  waiting: 'violet',
  running: 'blue',
  skipped: 'gray',
};
const STATUS_LABEL: Record<string, string> = {
  succeeded: 'ok',
  failed: 'failed',
  dryrun: 'dry run',
  waiting: 'waiting',
  running: 'running',
  skipped: 'skipped',
};

function runText(r: NodeRunStatus): string {
  const entries = Object.entries(r.counts).filter(([, n]) => n > 0);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 1) return STATUS_LABEL[entries[0]![0]] ?? entries[0]![0];
  return entries.map(([s, n]) => `${n}× ${STATUS_LABEL[s] ?? s}`).join(', ');
}

function NoteView({ node, selected }: { node: Extract<FlowNode, { type: 'note' }>; selected: boolean }) {
  return (
    <Box
      style={{
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        padding: 8,
        background: 'var(--mantine-color-yellow-1)',
        color: 'var(--mantine-color-dark-7)',
        border: `1px solid ${selected ? 'var(--mantine-color-blue-6)' : 'var(--mantine-color-yellow-4)'}`,
        boxShadow: selected ? '0 0 0 2px var(--mantine-color-blue-3)' : '0 1px 3px rgba(0,0,0,.15)',
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      <Markdown text={node.text} />
    </Box>
  );
}

function FlowNodeViewImpl({ data, selected }: NodeProps<FlowRfNode>) {
  const { node, issue, warning, run } = data;
  if (node.type === 'note') return <NoteView node={node} selected={!!selected} />;
  const meta = STEP_META[node.type];
  const color = nodeColor(node.type);
  const Icon = NODE_ICONS[node.type];
  const ports = nodePorts(node as never);
  const outline = issue ? 'var(--mantine-color-red-6)' : selected ? 'var(--mantine-color-blue-6)' : 'var(--mantine-color-default-border)';
  const height = Math.max(NODE_HEIGHT, ports.length * 22 + 10);

  const box = (
    <Box
      style={{
        width: NODE_WIDTH,
        height,
        display: 'flex',
        borderRadius: 8,
        border: `1px solid ${outline}`,
        boxShadow: selected ? '0 0 0 2px var(--mantine-color-blue-3)' : issue ? '0 0 0 2px var(--mantine-color-red-2)' : '0 1px 3px rgba(0,0,0,.12)',
        background: 'var(--mantine-color-body)',
        overflow: 'hidden',
      }}
    >
      <Box
        style={{
          width: 30,
          flexShrink: 0,
          background: `var(--mantine-color-${color}-6)`,
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon size={16} />
      </Box>
      <Box style={{ flex: 1, minWidth: 0, padding: '6px 8px', paddingRight: ports.length > 1 ? 44 : 10 }}>
        <Group gap={4} wrap="nowrap">
          <Text size="10px" tt="uppercase" fw={700} c={`${color}.7`} style={{ letterSpacing: 0.3 }} truncate>
            {meta.label}
          </Text>
          {node.when && <IconFilter size={11} color="var(--mantine-color-dimmed)" />}
          {node.type === 'userTask' && (node.assignees?.length ?? 0) > 0 && <IconUsers size={11} color="var(--mantine-color-dimmed)" />}
          {node.type === 'userTask' && node.fourEyes && <IconEyeCheck size={11} color="var(--mantine-color-dimmed)" />}
          {node.type === 'forEach' && (node.concurrency ?? 1) > 1 && (
            <Tooltip label={`Up to ${node.concurrency} items run at the same time`} withArrow>
              <Badge size="xs" variant="light" color={color} px={4} style={{ flexShrink: 0, textTransform: 'none' }} data-testid="parallel-badge">
                ×{node.concurrency} parallel
              </Badge>
            </Tooltip>
          )}
        </Group>
        <Text size="sm" fw={600} lh={1.25} truncate>
          {node.name || node.id}
        </Text>
        <Text size="11px" c="dimmed" className="mono" truncate>
          {nodeSummary(node)}
        </Text>
      </Box>
    </Box>
  );

  return (
    <Box pos="relative">
      {hasInput(node.type) && (
        <Handle type="target" position={Position.Left} style={{ width: 10, height: 10, background: 'var(--mantine-color-gray-5)', border: '2px solid var(--mantine-color-body)' }} />
      )}
      {issue || warning ? (
        <Tooltip label={issue ?? warning} multiline w={260} withArrow color={issue ? 'red' : 'orange'}>
          {box}
        </Tooltip>
      ) : (
        box
      )}
      {ports.map((p, i) => {
        const top = ((i + 1) / (ports.length + 1)) * height;
        const isError = p.id === 'error';
        return (
          <Box key={p.id}>
            {p.label && (
              <Text
                size="9px"
                c={isError ? 'red.7' : 'dimmed'}
                fw={600}
                style={{ position: 'absolute', right: 8, top: top - 7, pointerEvents: 'none', whiteSpace: 'nowrap' }}
              >
                {p.label}
              </Text>
            )}
            <Handle
              id={p.id}
              type="source"
              position={Position.Right}
              style={{
                top,
                width: 10,
                height: 10,
                background: isError ? 'var(--mantine-color-red-6)' : `var(--mantine-color-${color}-6)`,
                border: '2px solid var(--mantine-color-body)',
              }}
            />
          </Box>
        );
      })}
      {run && (
        <Group gap={4} wrap="nowrap" style={{ position: 'absolute', left: 4, top: height + 3, width: NODE_WIDTH + 40 }}>
          <Box
            style={{
              width: 8,
              height: 8,
              borderRadius: 8,
              flexShrink: 0,
              background: `var(--mantine-color-${STATUS_COLOR[run.status] ?? 'gray'}-6)`,
            }}
          />
          <Text size="10px" c="dimmed" truncate>
            {runText(run)}
          </Text>
        </Group>
      )}
    </Box>
  );
}

export const FlowNodeView = memo(FlowNodeViewImpl);
