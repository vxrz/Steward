import { useState } from 'react';
import YAML from 'yaml';
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Button,
  Code,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { INPUT_TYPES, type ConnectionSlot, type InputDef, type ProcessDefinition, type ProcessDetail, type ProcessVersion, type ValidationIssue } from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { fmtDate } from '../../format';

type Def = ProcessDefinition;
type SetDef = (d: Def) => void;

const KNOWN_KINDS = ['insights-hub', 'industrial-edge-management', 'generic'];

function move<T>(list: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const copy = [...list];
  [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  return copy;
}

function strip<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === '') delete out[k];
  return out as T;
}

export function GeneralPanel({ def, onChange }: { def: Def; onChange: SetDef }) {
  return (
    <Stack maw={720}>
      <TextInput label="Name" required value={def.name} onChange={(e) => onChange({ ...def, name: e.currentTarget.value })} />
      <Textarea
        label="Description"
        description="Explain what the process does, prerequisites and caveats. Shown when starting a run."
        autosize
        minRows={4}
        maxRows={16}
        value={def.description ?? ''}
        onChange={(e) => onChange(strip({ ...def, description: e.currentTarget.value || undefined }))}
      />
      <TagsInput
        label="Tags"
        description="Press Enter to add"
        value={def.tags ?? []}
        onChange={(tags) => onChange(strip({ ...def, tags: tags.length ? tags : undefined }))}
      />
    </Stack>
  );
}

export function InputsPanel({ def, onChange }: { def: Def; onChange: SetDef }) {
  const inputs = def.inputs ?? [];
  const set = (next: InputDef[]) => onChange({ ...def, inputs: next });
  const patch = (i: number, p: Partial<InputDef>) => set(inputs.map((x, j) => (j === i ? strip({ ...x, ...p }) : x)));
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Inputs are asked when a run is started (or stored in a schedule) and available as <Code>inputs.&lt;name&gt;</Code>.
      </Text>
      {inputs.map((inp, i) => (
        <Paper withBorder p="sm" key={i}>
          <Group justify="space-between" mb="xs" wrap="nowrap">
            <Text fw={600} size="sm" className="mono" truncate>
              {inp.name || '(unnamed)'}
            </Text>
            <Group gap={0} wrap="nowrap">
              <ActionIcon variant="subtle" size="sm" disabled={i === 0} onClick={() => set(move(inputs, i, -1))} aria-label="Up">
                <IconArrowUp size={14} />
              </ActionIcon>
              <ActionIcon variant="subtle" size="sm" disabled={i === inputs.length - 1} onClick={() => set(move(inputs, i, 1))} aria-label="Down">
                <IconArrowDown size={14} />
              </ActionIcon>
              <ActionIcon variant="subtle" size="sm" color="red" onClick={() => set(inputs.filter((_, j) => j !== i))} aria-label="Remove">
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
            <TextInput size="xs" label="Name" classNames={{ input: 'mono' }} value={inp.name} onChange={(e) => patch(i, { name: e.currentTarget.value })} />
            <TextInput size="xs" label="Label" value={inp.label ?? ''} onChange={(e) => patch(i, { label: e.currentTarget.value || undefined })} />
            <Select
              size="xs"
              label="Type"
              data={[...INPUT_TYPES]}
              value={inp.type}
              allowDeselect={false}
              onChange={(t) => t && patch(i, { type: t as InputDef['type'], default: undefined })}
            />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" mt="xs">
            <DefaultField inp={inp} onChange={(v) => patch(i, { default: v })} />
            <Stack gap="xs">
              {inp.type === 'select' && (
                <TagsInput size="xs" label="Options" value={inp.options ?? []} onChange={(o) => patch(i, { options: o.length ? o : undefined })} />
              )}
              {inp.type === 'table' && (
                <TagsInput size="xs" label="Expected CSV columns" value={inp.columns ?? []} onChange={(c) => patch(i, { columns: c.length ? c : undefined })} />
              )}
              <TextInput size="xs" label="Description" value={inp.description ?? ''} onChange={(e) => patch(i, { description: e.currentTarget.value || undefined })} />
              <Switch size="xs" label="Required" checked={!!inp.required} onChange={(e) => patch(i, { required: e.currentTarget.checked || undefined })} />
            </Stack>
          </SimpleGrid>
        </Paper>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => {
            let n = inputs.length + 1;
            while (inputs.some((x) => x.name === `input${n}`)) n++;
            set([...inputs, { name: `input${n}`, type: 'string' }]);
          }}
        >
          Add input
        </Button>
      </Group>
    </Stack>
  );
}

function DefaultField({ inp, onChange }: { inp: InputDef; onChange: (v: unknown) => void }) {
  const v = inp.default;
  switch (inp.type) {
    case 'boolean':
      return (
        <Select
          size="xs"
          label="Default"
          data={['true', 'false']}
          clearable
          value={v === undefined ? null : String(!!v)}
          onChange={(x) => onChange(x === null ? undefined : x === 'true')}
        />
      );
    case 'number':
      return (
        <TextInput
          size="xs"
          label="Default"
          value={v === undefined ? '' : String(v)}
          onChange={(e) => {
            const t = e.currentTarget.value;
            onChange(t === '' ? undefined : Number.isNaN(Number(t)) ? t : Number(t));
          }}
        />
      );
    case 'select':
      return <Select size="xs" label="Default" data={inp.options ?? []} clearable value={(v as string) ?? null} onChange={(x) => onChange(x ?? undefined)} />;
    case 'list':
    case 'table':
    case 'json':
      return (
        <Textarea
          size="xs"
          label={inp.type === 'list' ? 'Default (one per line)' : inp.type === 'table' ? 'Default CSV' : 'Default JSON'}
          autosize
          minRows={3}
          maxRows={10}
          classNames={{ input: 'mono' }}
          value={Array.isArray(v) && inp.type === 'list' ? v.join('\n') : typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v, null, 2)}
          onChange={(e) => onChange(e.currentTarget.value || undefined)}
        />
      );
    default:
      return <TextInput size="xs" label="Default" value={(v as string) ?? ''} onChange={(e) => onChange(e.currentTarget.value || undefined)} />;
  }
}

export function ConnectionsPanel({ def, onChange }: { def: Def; onChange: SetDef }) {
  const conns = def.connections ?? [];
  const set = (next: ConnectionSlot[]) => onChange({ ...def, connections: next });
  const patch = (i: number, p: Partial<ConnectionSlot>) => set(conns.map((c, j) => (j === i ? strip({ ...c, ...p }) : c)));
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Connection slots keep the process platform-agnostic: steps refer to a slot (e.g. <Code>hub</Code>) and the actual platform is chosen when the run
        starts. Optionally restrict a slot to a platform kind.
      </Text>
      {conns.map((c, i) => (
        <Paper withBorder p="sm" key={i}>
          <Group align="flex-end" wrap="wrap" gap="xs">
            <TextInput size="xs" label="Slot" w={140} classNames={{ input: 'mono' }} value={c.slot} onChange={(e) => patch(i, { slot: e.currentTarget.value })} />
            <Autocomplete size="xs" label="Platform kind" w={220} data={KNOWN_KINDS} value={c.kind ?? ''} onChange={(k) => patch(i, { kind: k || undefined })} placeholder="any" />
            <TextInput
              size="xs"
              label="Description"
              style={{ flex: 1, minWidth: 180 }}
              value={c.description ?? ''}
              onChange={(e) => patch(i, { description: e.currentTarget.value || undefined })}
            />
            <ActionIcon variant="subtle" color="red" onClick={() => set(conns.filter((_, j) => j !== i))} aria-label="Remove" mb={4}>
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        </Paper>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => {
            let n = conns.length + 1;
            while (conns.some((x) => x.slot === `conn${n}`)) n++;
            set([...conns, { slot: conns.length ? `conn${n}` : 'hub' }]);
          }}
        >
          Add connection
        </Button>
      </Group>
    </Stack>
  );
}

export function ConstantsPanel({ def, onChange }: { def: Def; onChange: SetDef }) {
  const [text, setText] = useState(() => (def.constants && Object.keys(def.constants).length ? YAML.stringify(def.constants, { lineWidth: 0 }) : ''));
  const [error, setError] = useState<string | null>(null);
  const update = (t: string) => {
    setText(t);
    if (!t.trim()) {
      setError(null);
      const { constants: _c, ...rest } = def;
      return onChange(rest as Def);
    }
    try {
      const parsed = YAML.parse(t);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Constants must be a mapping (key: value)');
      setError(null);
      onChange({ ...def, constants: parsed });
    } catch (e) {
      setError((e as Error).message.split('\n')[0] ?? 'Invalid YAML');
    }
  };
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Static configuration available as <Code>const.*</Code> (or <Code>$const</Code> in filters), e.g. group bundles for onboarding. YAML or JSON.
      </Text>
      <Textarea
        autosize
        minRows={8}
        maxRows={30}
        classNames={{ input: 'mono' }}
        value={text}
        error={error}
        onChange={(e) => update(e.currentTarget.value)}
        placeholder={'bundles:\n  Operator: [mdsp:core:StandardUser, mdsp_usergroup:Operators]'}
      />
    </Stack>
  );
}

export function SourcePanel({ def, onChange }: { def: Def; onChange: SetDef }) {
  const toYaml = (d: Def) => YAML.stringify(JSON.parse(JSON.stringify(d)), { lineWidth: 0 });
  const [text, setText] = useState(() => toYaml(def));
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; issues: ValidationIssue[]; definition?: Def }>('/processes/validate', { text });
      setIssues(r.issues);
      if (r.definition) {
        onChange(r.definition);
        setText(toYaml(r.definition));
      }
    } catch (e) {
      notifyError(e, 'Could not validate');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        The complete process definition as YAML. Edit and click "Apply to editor"; save afterwards to create a new version.
      </Text>
      <Textarea autosize minRows={16} maxRows={60} classNames={{ input: 'mono' }} value={text} onChange={(e) => setText(e.currentTarget.value)} spellCheck={false} />
      {issues && issues.length > 0 && (
        <Alert color="red" title={`${issues.length} issue(s)`}>
          <Stack gap={2}>
            {issues.slice(0, 15).map((i, k) => (
              <Text size="xs" key={k} className="mono">
                {i.path ? `${i.path}: ` : ''}
                {i.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      {issues && issues.length === 0 && <Alert color="green">Applied – the definition is valid.</Alert>}
      <Group>
        <Button onClick={apply} loading={busy}>
          Apply to editor
        </Button>
        <Button
          variant="default"
          onClick={() => {
            setText(toYaml(def));
            setIssues(null);
          }}
        >
          Reset to editor state
        </Button>
      </Group>
    </Stack>
  );
}

export function VersionsPanel({ processId, currentVersion, onRestore }: { processId: string; currentVersion: number; onRestore: (d: Def, version: number) => void }) {
  const versions = useQuery({ queryKey: ['process-versions', processId, currentVersion], queryFn: () => get<ProcessVersion[]>(`/processes/${processId}/versions`) });
  const [viewing, setViewing] = useState<ProcessDetail | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const open = async (v: number) => {
    try {
      setViewVersion(v);
      setViewing(await get<ProcessDetail>(`/processes/${processId}?version=${v}`));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Every save creates a new immutable version. Runs record the exact version and its hash.
      </Text>
      <div className="table-scroll">
        <Table striped highlightOnHover miw={560}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Version</Table.Th>
              <Table.Th>Saved</Table.Th>
              <Table.Th>Author</Table.Th>
              <Table.Th>Comment</Table.Th>
              <Table.Th>Hash</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(versions.data ?? []).map((v) => (
              <Table.Tr key={v.version}>
                <Table.Td>
                  v{v.version}
                  {v.version === currentVersion ? ' (current)' : ''}
                </Table.Td>
                <Table.Td className="nowrap">{fmtDate(v.createdAt)}</Table.Td>
                <Table.Td>{v.author}</Table.Td>
                <Table.Td>{v.comment}</Table.Td>
                <Table.Td className="mono">{v.hash.slice(0, 12)}</Table.Td>
                <Table.Td>
                  <Button size="compact-xs" variant="light" onClick={() => open(v.version)}>
                    View
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <Modal opened={!!viewing} onClose={() => setViewing(null)} title={`Version v${viewVersion}`} size="xl">
        {viewing && (
          <Stack>
            <Text size="xs" c="dimmed" className="mono">
              hash {viewing.definitionHash}
            </Text>
            <ScrollArea.Autosize mah={480}>
              <Code block>{YAML.stringify(viewing.definition, { lineWidth: 0 })}</Code>
            </ScrollArea.Autosize>
            <Group justify="flex-end">
              <Button
                onClick={() => {
                  onRestore(structuredClone(viewing.definition), viewVersion!);
                  setViewing(null);
                }}
              >
                Restore as working copy
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
