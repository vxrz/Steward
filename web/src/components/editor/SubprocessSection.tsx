import { ActionIcon, Alert, Anchor, Badge, Box, Code, Group, Loader, Paper, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconArrowRight, IconExternalLink, IconTrash } from '@tabler/icons-react';
import type { ConnectionSlot, FlowNode, NodeOf } from '@sm/shared';
import { asText, fromText } from '../common';
import { ExpressionInput } from './ExpressionInput';
import { ExprKeyValueEditor } from './fields';
import { useProcessVersion } from './editorApi';

type SubNode = NodeOf<'subprocess'>;

/** Inputs + connection mapping of a sub-process node, driven by the chosen child process. */
export function SubprocessSection({
  node,
  connections,
  onChange,
}: {
  node: SubNode;
  connections: ConnectionSlot[];
  onChange: (patch: Partial<FlowNode>) => void;
}) {
  const child = useProcessVersion(node.process || undefined, node.version);
  const inputs = (node.inputs ?? {}) as Record<string, unknown>;
  const conns = node.connections ?? {};
  const setInputs = (next: Record<string, unknown>) => onChange({ inputs: next } as Partial<FlowNode>);
  const setConns = (next: Record<string, string>) => onChange({ connections: Object.keys(next).length ? next : undefined } as Partial<FlowNode>);

  if (!node.process) {
    return (
      <Text size="xs" c="dimmed">
        Choose a process to fill in its inputs and connections.
      </Text>
    );
  }
  if (child.isLoading) {
    return (
      <Group gap={6}>
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          Loading process…
        </Text>
      </Group>
    );
  }

  const openLink = (
    <Anchor href={`/processes/${encodeURIComponent(node.process)}`} target="_blank" size="xs" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
      <Group gap={4} wrap="nowrap">
        <IconExternalLink size={12} />
        Open process
      </Group>
    </Anchor>
  );

  if (child.error || !child.data) {
    // child unknown or not readable: plain editors
    return (
      <Stack gap="xs">
        <Alert color="orange" p="xs">
          <Text size="xs">Could not load the chosen process{node.version ? ` (v${node.version})` : ''}: {(child.error as Error)?.message ?? 'not found'}</Text>
        </Alert>
        <Text size="sm" fw={500}>
          Inputs (child input → template)
        </Text>
        <ExprKeyValueEditor value={inputs} onChange={(v) => setInputs(v ?? {})} />
        <Text size="sm" fw={500}>
          Connections (child slot → this process&apos; slot)
        </Text>
        <ExprKeyValueEditor value={conns} onChange={(v) => setConns((v ?? {}) as Record<string, string>)} keyLabel="Child slot" />
      </Stack>
    );
  }

  const d = child.data.definition;
  const childInputs = d.inputs ?? [];
  const childSlots = d.connections ?? [];
  const known = new Set(childInputs.map((i) => i.name));
  const unknown = Object.keys(inputs).filter((k) => !known.has(k));
  const parentSlots = new Set(connections.map((c) => c.slot));
  const outputs = Object.keys(d.outputs ?? {});

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed" truncate>
          {child.data.name} · v{node.version ?? child.data.currentVersion}
          {node.version ? ' (pinned)' : ' (current)'}
        </Text>
        {openLink}
      </Group>

      <Box>
        <Text size="sm" fw={500}>
          Inputs
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          Values passed to the child run. Templates are evaluated in this process. Empty = child default.
        </Text>
        {childInputs.length === 0 && (
          <Text size="xs" c="dimmed">
            The process has no inputs.
          </Text>
        )}
        <Stack gap={8}>
          {childInputs.map((inp) => {
            const v = asText(inputs[inp.name]);
            const missing = inp.required && inp.default === undefined && !v;
            return (
              <ExpressionInput
                key={inp.name}
                size="xs"
                template
                label={
                  <>
                    <span className="mono">{inp.name}</span>
                    {inp.label && inp.label !== inp.name ? ` – ${inp.label}` : ''}
                    {inp.required && <span style={{ color: 'var(--mantine-color-red-filled)' }}> *</span>}
                  </>
                }
                description={[inp.type, inp.description, inp.default !== undefined ? `default: ${asText(inp.default)}` : ''].filter(Boolean).join(' · ')}
                placeholder={inp.default !== undefined ? asText(inp.default) : '{{ inputs.something }}'}
                error={missing ? 'Required by the child process' : undefined}
                value={v}
                onChange={(t) => {
                  const next = { ...inputs };
                  if (t === '') delete next[inp.name];
                  else next[inp.name] = fromText(t);
                  setInputs(next);
                }}
              />
            );
          })}
          {unknown.map((k) => (
            <Group key={k} gap={6} wrap="nowrap">
              <Badge color="orange" variant="light" size="sm" className="mono">
                {k}
              </Badge>
              <Text size="xs" c="orange" style={{ flex: 1 }}>
                Not an input of this process – ignored
              </Text>
              <Tooltip label="Remove">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label={`Remove input ${k}`}
                  onClick={() => {
                    const next = { ...inputs };
                    delete next[k];
                    setInputs(next);
                  }}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
        </Stack>
      </Box>

      <Box>
        <Text size="sm" fw={500}>
          Connections
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          Which of this process&apos; connections the child uses. Empty = same slot name.
        </Text>
        {childSlots.length === 0 && (
          <Text size="xs" c="dimmed">
            The process uses no connections.
          </Text>
        )}
        <Stack gap={6}>
          {childSlots.map((c) => {
            const mapped = conns[c.slot];
            const unresolved = !mapped && !parentSlots.has(c.slot);
            return (
              <Group key={c.slot} gap={6} wrap="nowrap" align="flex-start">
                <Box w={120} style={{ flexShrink: 0 }} pt={4}>
                  <Text size="xs" className="mono" truncate>
                    {c.slot}
                  </Text>
                  {c.kind && (
                    <Text size="10px" c="dimmed" truncate>
                      {c.kind}
                    </Text>
                  )}
                </Box>
                <IconArrowRight size={14} style={{ marginTop: 8, flexShrink: 0 }} />
                <Select
                  size="xs"
                  style={{ flex: 1, minWidth: 0 }}
                  aria-label={`Connection for child slot ${c.slot}`}
                  data={connections.map((p) => ({ value: p.slot, label: p.kind ? `${p.slot} (${p.kind})` : p.slot }))}
                  placeholder={parentSlots.has(c.slot) ? `same name (${c.slot})` : 'choose a connection'}
                  clearable
                  value={mapped ?? null}
                  error={unresolved ? `This process has no connection "${c.slot}"` : mapped && !parentSlots.has(mapped) ? 'Unknown connection' : undefined}
                  onChange={(v) => {
                    const next = { ...conns };
                    if (v) next[c.slot] = v;
                    else delete next[c.slot];
                    setConns(next);
                  }}
                />
              </Group>
            );
          })}
        </Stack>
      </Box>

      <Paper withBorder p="xs">
        <Text size="xs" fw={600} mb={2}>
          Result
        </Text>
        {outputs.length ? (
          <Text size="xs" c="dimmed">
            The child returns {outputs.map((o, i) => (
              <span key={o}>
                {i > 0 && ', '}
                <Code>{o}</Code>
              </span>
            ))}
            {node.saveAs ? (
              <>
                {' '}
                – available as <Code>vars.{node.saveAs}.&lt;name&gt;</Code>
              </>
            ) : (
              ' – set "Save result as" to use them'
            )}
            .
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            The child process declares no outputs (Settings → Outputs).
          </Text>
        )}
      </Paper>
    </Stack>
  );
}
