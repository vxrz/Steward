import { useMemo, useState } from 'react';
import {
  Accordion,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconApi, IconSearch } from '@tabler/icons-react';
import { COMMON_FIELDS, STEP_META, type ApiOperation, type ConnectionSlot, type HttpStep, type Platform, type Step } from '@sm/shared';
import { get } from '../../api';
import { FieldInput } from './fields';
import { STEP_ICONS, stepColor } from './StepTree';

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
              Scope: <Code>inputs.*</Code> run inputs · <Code>vars.*</Code> step results (saveAs, set, loop items) · <Code>const.*</Code> constants ·{' '}
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

export function StepForm({
  step,
  onChange,
  otherIds,
  connections,
}: {
  step: Step;
  onChange: (s: Step) => void;
  otherIds: Set<string>;
  connections: ConnectionSlot[];
}) {
  const meta = STEP_META[step.type];
  const rec = step as unknown as Record<string, unknown>;
  const set = (key: string, v: unknown) => {
    const next: Record<string, unknown> = { ...rec };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next as unknown as Step);
  };
  const [idDraft, setIdDraft] = useState(step.id);
  const idError = !ID_RE.test(idDraft) ? 'Letters, digits and _ only' : otherIds.has(idDraft) ? 'Id already used by another step' : null;
  const Icon = STEP_ICONS[step.type];

  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="nowrap">
        <Badge size="lg" variant="light" color={stepColor(step.type)} leftSection={<Icon size={14} />}>
          {meta.label}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed">
        {meta.description}
      </Text>
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
        <TextInput
          label="Step id"
          description="Unique; used for run protocol keys"
          classNames={{ input: 'mono' }}
          value={idDraft}
          error={idError}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setIdDraft(v);
            if (ID_RE.test(v) && !otherIds.has(v)) set('id', v);
          }}
        />
        <TextInput label="Name" description="Shown in the protocol" value={step.name ?? ''} onChange={(e) => set('name', e.currentTarget.value || undefined)} />
      </SimpleGrid>
      <Textarea
        label="Description"
        autosize
        minRows={1}
        maxRows={4}
        value={step.description ?? ''}
        onChange={(e) => set('description', e.currentTarget.value || undefined)}
      />
      {step.type === 'http' && <SpecPicker step={step} connections={connections} onPick={(p) => onChange({ ...step, ...p })} />}
      {meta.fields.map((f) => (
        <FieldInput key={f.key} field={f} value={rec[f.key]} onChange={(v) => set(f.key, v)} connections={connections} />
      ))}
      {meta.blocks && (
        <Text size="xs" c="dimmed">
          Nested steps ({meta.blocks.map((b) => b.label).join(' / ')}) are edited in the step tree.
        </Text>
      )}
      <Divider label="Execution" labelPosition="left" />
      {COMMON_FIELDS.map((f) => (
        <FieldInput key={f.key} field={f} value={rec[f.key]} onChange={(v) => set(f.key, v)} connections={connections} />
      ))}
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
        <NumberInput
          label="Retry attempts"
          description="Total attempts incl. the first (1–10)"
          min={1}
          max={10}
          value={step.retry?.attempts ?? ''}
          onChange={(v) => set('retry', v === '' || Number(v) <= 1 ? undefined : { ...(step.retry ?? {}), attempts: Number(v) })}
        />
        <NumberInput
          label="Retry delay (ms)"
          min={0}
          disabled={!step.retry}
          value={step.retry?.delayMs ?? ''}
          onChange={(v) => step.retry && set('retry', { ...step.retry, delayMs: v === '' ? undefined : Number(v) })}
        />
      </SimpleGrid>
    </Stack>
  );
}

/** Pick an operation from an imported OpenAPI spec of a platform. */
function SpecPicker({ step, connections, onPick }: { step: HttpStep; connections: ConnectionSlot[]; onPick: (p: Partial<HttpStep>) => void }) {
  const [opened, setOpened] = useState(false);
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const slot = connections.find((c) => c.slot === step.connection);
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms'), enabled: opened });
  const candidates = (platforms.data ?? []).filter((p) => !slot?.kind || p.kind === slot.kind);
  const ops = useQuery({
    queryKey: ['operations', platformId],
    queryFn: () => get<ApiOperation[]>(`/platforms/${platformId}/operations`),
    enabled: !!platformId && opened,
  });
  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return (ops.data ?? [])
      .filter((o) => !needle || [o.method, o.path, o.summary, o.operationId, o.tag].some((x) => x?.toLowerCase().includes(needle)))
      .slice(0, 150);
  }, [ops.data, q]);

  const pick = (o: ApiOperation) => {
    const path = o.path.replace(/\{([^}]+)\}/g, (_m, p: string) => `{{ vars.${p.replace(/[^A-Za-z0-9_]/g, '_')} }}`);
    const requiredQuery = (o.parameters ?? []).filter((p) => p.in === 'query' && p.required);
    const query = { ...(step.query ?? {}) };
    for (const p of requiredQuery) if (!(p.name in query)) query[p.name] = '';
    onPick({
      method: o.method as HttpStep['method'],
      path,
      operationId: o.operationId,
      ...(Object.keys(query).length ? { query } : {}),
      ...(!step.name && o.summary ? { name: o.summary.slice(0, 80) } : {}),
    });
    setOpened(false);
  };

  return (
    <>
      <Group gap="xs">
        <Button size="xs" variant="light" leftSection={<IconApi size={14} />} onClick={() => setOpened(true)} disabled={!step.connection}>
          Pick from API spec
        </Button>
        {step.operationId && (
          <Text size="xs" c="dimmed" className="mono">
            operationId: {step.operationId}
          </Text>
        )}
        {!step.connection && (
          <Text size="xs" c="dimmed">
            Select a connection first
          </Text>
        )}
      </Group>
      <Modal opened={opened} onClose={() => setOpened(false)} title="Pick an API operation" size="xl">
        <Stack>
          <Select
            label="Platform with an imported specification"
            description={slot?.kind ? `Platforms of kind ${slot.kind}` : undefined}
            data={candidates.map((p) => ({ value: p.id, label: p.name }))}
            value={platformId}
            onChange={setPlatformId}
            placeholder={platforms.isLoading ? 'Loading…' : candidates.length ? 'Select platform' : 'No matching platforms'}
          />
          {platformId && (
            <>
              <TextInput leftSection={<IconSearch size={14} />} placeholder="Search path, summary, operationId…" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
              {ops.data && ops.data.length === 0 && (
                <Text size="sm" c="dimmed">
                  This platform has no API specification yet. Upload one on the platform page (tab "API specs").
                </Text>
              )}
              <ScrollArea.Autosize mah={420}>
                <Stack gap={4}>
                  {filtered.map((o, i) => (
                    <UnstyledButton key={`${o.specId}-${o.method}-${o.path}-${i}`} onClick={() => pick(o)}>
                      <Paper withBorder p={6}>
                        <Group gap={6} wrap="nowrap">
                          <Badge size="sm" variant="light" w={64} style={{ flexShrink: 0 }}>
                            {o.method}
                          </Badge>
                          <Box style={{ minWidth: 0 }}>
                            <Text size="xs" className="mono" truncate>
                              {o.path}
                            </Text>
                            {(o.summary || o.operationId) && (
                              <Text size="xs" c="dimmed" truncate>
                                {o.summary ?? ''} {o.operationId ? `· ${o.operationId}` : ''}
                              </Text>
                            )}
                          </Box>
                        </Group>
                      </Paper>
                    </UnstyledButton>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            </>
          )}
        </Stack>
      </Modal>
    </>
  );
}
