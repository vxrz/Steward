import { Fragment, useEffect, useState } from 'react';
import { Accordion, Badge, Code, Divider, Group, NumberInput, Paper, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { COMMON_FIELDS, STEP_META, nodePorts, type ConnectionSlot, type FlowNode } from '@sm/shared';
import { FieldInput } from './fields';
import { ApiOperationSection } from './ApiOperation';
import { ExprNodeScope } from './ExprContext';
import { SubprocessSection } from './SubprocessSection';
import { NODE_ICONS, PORT_HELP, nodeColor } from '../flow/meta';

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function ExpressionHelp() {
  return (
    <Accordion variant="contained" chevronPosition="left">
      <Accordion.Item value="help">
        <Accordion.Control>
          <Text size="sm">Expression & template help</Text>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap={4}>
            <Text size="xs">
              Expressions use <b>JSONata</b>. Template fields accept <Code>{'{{ expression }}'}</Code> placeholders; a field that is exactly one
              placeholder keeps the raw value (list, object, number).
            </Text>
            <Text size="xs">
              Start typing (or press <Code>Ctrl+Space</Code>) for suggestions; the value below a field is a live preview using the latest run. Scope: <Code>inputs.*</Code> run inputs · <Code>vars.*</Code> node results (saveAs, set, loop items) · <Code>const.*</Code> constants ·{' '}
              <Code>run.id / run.dryRun / run.actor</Code> · <Code>conn.&lt;slot&gt;.vars.*</Code> platform variables.
            </Text>
            <Text size="xs">
              Inside filters <Code>[...]</Code> the context is the current item – use <Code>$inputs</Code>, <Code>$vars</Code>, <Code>$const</Code> there,
              e.g. <Code>vars.users.body[$not(userName in $inputs.exempt)]</Code>. Append <Code>[]</Code> to always get a list.
            </Text>
            <Text size="xs">
              Helpers: <Code>$daysSince(ts)</Code> <Code>$daysAgo(n)</Code> <Code>$ts(value)</Code> <Code>$uuid()</Code>{' '}
              <Code>$pvar(slot, name, default)</Code> <Code>$secret(slot, key)</Code> (value is redacted in logs) plus all JSONata functions ($count,
              $join, $filter, $lookup, $distinct, …).
            </Text>
            <Text size="xs">
              Per-item fields (columns, preselect) are evaluated against the item itself: <Code>userName</Code>, <Code>$item</Code>.
            </Text>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export function NodeForm({
  node,
  onChange,
  onRename,
  otherIds,
  connections,
}: {
  node: FlowNode;
  onChange: (n: FlowNode) => void;
  onRename: (newId: string) => void;
  otherIds: Set<string>;
  connections: ConnectionSlot[];
}) {
  const meta = STEP_META[node.type];
  const rec = node as unknown as Record<string, unknown>;
  const set = (key: string, v: unknown) => {
    const next: Record<string, unknown> = { ...rec };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next as unknown as FlowNode);
  };
  const [idDraft, setIdDraft] = useState(node.id);
  useEffect(() => setIdDraft(node.id), [node.id]);
  const idError = !ID_RE.test(idDraft) ? 'Letters, digits and _ only' : otherIds.has(idDraft) ? 'Id already used by another node' : null;
  const Icon = NODE_ICONS[node.type];
  const ports = nodePorts(node as never);
  const executable = node.type !== 'note' && node.type !== 'start';
  const commonFields = COMMON_FIELDS.filter((f) => !(node.type === 'if' && f.key === 'when'));

  return (
    <ExprNodeScope nodeId={node.id} enabled={node.type !== 'note'}>
    <Stack gap="sm">
      <Group gap="xs" wrap="nowrap">
        <Badge size="lg" variant="light" color={nodeColor(node.type)} leftSection={<Icon size={14} />}>
          {meta.label}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed">
        {meta.description}
      </Text>
      {node.type === 'start' && (
        <Text size="xs">
          Inputs (asked when a run starts) and connection slots (which platforms the process uses) are defined in the <b>Settings</b> tab.
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
        <TextInput
          label="Node id"
          description="Unique; used in run protocols"
          classNames={{ input: 'mono' }}
          value={idDraft}
          error={idDraft !== node.id ? idError : null}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setIdDraft(v);
            if (ID_RE.test(v) && !otherIds.has(v) && v !== node.id) onRename(v);
          }}
        />
        {node.type !== 'note' && (
          <TextInput label="Name" description="Shown on the canvas and in protocols" value={node.name ?? ''} onChange={(e) => set('name', e.currentTarget.value || undefined)} />
        )}
      </SimpleGrid>
      {executable && (
        <Textarea label="Description" autosize minRows={1} maxRows={4} value={node.description ?? ''} onChange={(e) => set('description', e.currentTarget.value || undefined)} />
      )}
      {meta.fields.map((f) => (
        <Fragment key={f.key}>
          {!(node.type === 'subprocess' && (f.key === 'inputs' || f.key === 'connections')) && (
            <FieldInput field={f} value={rec[f.key]} onChange={(v) => set(f.key, v)} connections={connections} />
          )}
          {node.type === 'subprocess' && f.key === 'inputs' && (
            <SubprocessSection
              node={node}
              connections={connections}
              onChange={(patch) => {
                const next: Record<string, unknown> = { ...node, ...patch };
                for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete next[k];
                onChange(next as unknown as FlowNode);
              }}
            />
          )}
          {node.type === 'http' && f.key === 'connection' && (
            <ApiOperationSection
              node={node}
              connections={connections}
              onChange={(patch) => {
                const next: Record<string, unknown> = { ...node, ...patch };
                for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete next[k];
                onChange(next as unknown as FlowNode);
              }}
            />
          )}
        </Fragment>
      ))}
      {ports.length > 0 && (
        <Paper withBorder p="xs">
          <Text size="xs" fw={600} mb={4}>
            Outputs
          </Text>
          <Stack gap={4}>
            {ports.map((p) => (
              <Group key={p.id} gap={6} wrap="nowrap" align="flex-start">
                <Badge size="xs" variant="outline" color={p.id === 'error' ? 'red' : 'gray'} style={{ flexShrink: 0 }}>
                  {p.label || p.id}
                </Badge>
                <Text size="xs" c="dimmed">
                  {PORT_HELP[p.id] ?? ''}
                </Text>
              </Group>
            ))}
          </Stack>
        </Paper>
      )}
      {executable && (
        <>
          <Divider label="Execution" labelPosition="left" />
          {commonFields.map((f) => (
            <FieldInput key={f.key} field={f} value={rec[f.key]} onChange={(v) => set(f.key, v)} connections={connections} />
          ))}
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
            <NumberInput
              label="Retry attempts"
              description="Total attempts incl. the first (1–10)"
              min={1}
              max={10}
              value={node.retry?.attempts ?? ''}
              onChange={(v) => set('retry', v === '' || Number(v) <= 1 ? undefined : { ...(node.retry ?? {}), attempts: Number(v) })}
            />
            <NumberInput
              label="Retry delay (ms)"
              min={0}
              disabled={!node.retry}
              value={node.retry?.delayMs ?? ''}
              onChange={(v) => node.retry && set('retry', { ...node.retry, delayMs: v === '' ? undefined : Number(v) })}
            />
          </SimpleGrid>
        </>
      )}
    </Stack>
    </ExprNodeScope>
  );
}
