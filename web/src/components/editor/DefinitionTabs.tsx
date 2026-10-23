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
import { Trans, useTranslation } from 'react-i18next';
import {
  INPUT_TYPES,
  type ConnectionSlot,
  type InputDef,
  type ProcessDefinition,
  type ProcessDetail,
  type ProcessVersion,
  type ValidationIssue,
} from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { fmtDate } from '../../format';
import { ExpressionInput } from './ExpressionInput';
import { VersionCompare } from './VersionDiff';
import { issueText } from '../../i18n/meta';

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
  const { t } = useTranslation('editor');
  return (
    <Stack>
      <TextInput label={t('general.name')} required value={def.name} onChange={(e) => onChange({ ...def, name: e.currentTarget.value })} />
      <Textarea
        label={t('general.description')}
        description={t('general.descriptionHint')}
        autosize
        minRows={4}
        maxRows={16}
        value={def.description ?? ''}
        onChange={(e) => onChange(strip({ ...def, description: e.currentTarget.value || undefined }))}
      />
      <TagsInput
        label={t('general.tags')}
        description={t('general.tagsHint')}
        value={def.tags ?? []}
        onChange={(tags) => onChange(strip({ ...def, tags: tags.length ? tags : undefined }))}
      />
    </Stack>
  );
}

export function InputsPanel({ def, onChange }: { def: Def; onChange: SetDef }) {
  const { t } = useTranslation(['editor', 'common']);
  const inputs = def.inputs ?? [];
  const set = (next: InputDef[]) => onChange({ ...def, inputs: next });
  const patch = (i: number, p: Partial<InputDef>) => set(inputs.map((x, j) => (j === i ? strip({ ...x, ...p }) : x)));
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        <Trans t={t} i18nKey="inputs.hint" components={{ path: <Code>{'inputs.<name>'}</Code> }} />
      </Text>
      {inputs.map((inp, i) => (
        <Paper withBorder p="sm" key={i}>
          <Group justify="space-between" mb="xs" wrap="nowrap">
            <Text fw={600} size="sm" className="mono" truncate>
              {inp.name || t('inputs.unnamed')}
            </Text>
            <Group gap={0} wrap="nowrap">
              <ActionIcon variant="subtle" size="sm" disabled={i === 0} onClick={() => set(move(inputs, i, -1))} aria-label={t('fields.up')}>
                <IconArrowUp size={14} />
              </ActionIcon>
              <ActionIcon variant="subtle" size="sm" disabled={i === inputs.length - 1} onClick={() => set(move(inputs, i, 1))} aria-label={t('fields.down')}>
                <IconArrowDown size={14} />
              </ActionIcon>
              <ActionIcon variant="subtle" size="sm" color="red" onClick={() => set(inputs.filter((_, j) => j !== i))} aria-label={t('common:remove')}>
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
            <TextInput
              size="xs"
              label={t('inputs.name')}
              classNames={{ input: 'mono' }}
              value={inp.name}
              onChange={(e) => patch(i, { name: e.currentTarget.value })}
            />
            <TextInput size="xs" label={t('inputs.label')} value={inp.label ?? ''} onChange={(e) => patch(i, { label: e.currentTarget.value || undefined })} />
            <Select
              size="xs"
              label={t('inputs.type')}
              data={INPUT_TYPES.map((type) => ({ value: type, label: t(`inputTypes.${type}`) }))}
              value={inp.type}
              allowDeselect={false}
              onChange={(type) => type && patch(i, { type: type as InputDef['type'], default: undefined })}
            />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" mt="xs">
            <DefaultField inp={inp} onChange={(v) => patch(i, { default: v })} />
            <Stack gap="xs">
              {inp.type === 'select' && (
                <TagsInput size="xs" label={t('inputs.options')} value={inp.options ?? []} onChange={(o) => patch(i, { options: o.length ? o : undefined })} />
              )}
              {inp.type === 'table' && (
                <TagsInput size="xs" label={t('inputs.columns')} value={inp.columns ?? []} onChange={(c) => patch(i, { columns: c.length ? c : undefined })} />
              )}
              <TextInput
                size="xs"
                label={t('inputs.description')}
                value={inp.description ?? ''}
                onChange={(e) => patch(i, { description: e.currentTarget.value || undefined })}
              />
              <Switch
                size="xs"
                label={t('inputs.required')}
                checked={!!inp.required}
                onChange={(e) => patch(i, { required: e.currentTarget.checked || undefined })}
              />
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
          {t('inputs.add')}
        </Button>
      </Group>
    </Stack>
  );
}

function DefaultField({ inp, onChange }: { inp: InputDef; onChange: (v: unknown) => void }) {
  const { t } = useTranslation('editor');
  const v = inp.default;
  switch (inp.type) {
    case 'boolean':
      return (
        <Select
          size="xs"
          label={t('inputs.default')}
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
          label={t('inputs.default')}
          value={v === undefined ? '' : String(v)}
          onChange={(e) => {
            const text = e.currentTarget.value;
            onChange(text === '' ? undefined : Number.isNaN(Number(text)) ? text : Number(text));
          }}
        />
      );
    case 'select':
      return (
        <Select
          size="xs"
          label={t('inputs.default')}
          data={inp.options ?? []}
          clearable
          value={(v as string) ?? null}
          onChange={(x) => onChange(x ?? undefined)}
        />
      );
    case 'list':
    case 'table':
    case 'json':
      return (
        <Textarea
          size="xs"
          label={inp.type === 'list' ? t('inputs.defaultList') : inp.type === 'table' ? t('inputs.defaultCsv') : t('inputs.defaultJson')}
          autosize
          minRows={3}
          maxRows={10}
          classNames={{ input: 'mono' }}
          value={Array.isArray(v) && inp.type === 'list' ? v.join('\n') : typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v, null, 2)}
          onChange={(e) => onChange(e.currentTarget.value || undefined)}
        />
      );
    default:
      return <TextInput size="xs" label={t('inputs.default')} value={(v as string) ?? ''} onChange={(e) => onChange(e.currentTarget.value || undefined)} />;
  }
}

export function ConnectionsPanel({ def, onChange }: { def: Def; onChange: SetDef }) {
  const { t } = useTranslation(['editor', 'common']);
  const conns = def.connections ?? [];
  const set = (next: ConnectionSlot[]) => onChange({ ...def, connections: next });
  const patch = (i: number, p: Partial<ConnectionSlot>) => set(conns.map((c, j) => (j === i ? strip({ ...c, ...p }) : c)));
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        <Trans t={t} i18nKey="connections.hint" components={{ c: <Code /> }} />
      </Text>
      {conns.map((c, i) => (
        <Paper withBorder p="sm" key={i}>
          <Group align="flex-end" wrap="wrap" gap="xs">
            <TextInput
              size="xs"
              label={t('connections.slot')}
              w={140}
              classNames={{ input: 'mono' }}
              value={c.slot}
              onChange={(e) => patch(i, { slot: e.currentTarget.value })}
            />
            <Autocomplete
              size="xs"
              label={t('connections.kind')}
              w={220}
              data={KNOWN_KINDS}
              value={c.kind ?? ''}
              onChange={(k) => patch(i, { kind: k || undefined })}
              placeholder={t('connections.anyKind')}
            />
            <TextInput
              size="xs"
              label={t('connections.description')}
              style={{ flex: 1, minWidth: 180 }}
              value={c.description ?? ''}
              onChange={(e) => patch(i, { description: e.currentTarget.value || undefined })}
            />
            <ActionIcon variant="subtle" color="red" onClick={() => set(conns.filter((_, j) => j !== i))} aria-label={t('common:remove')} mb={4}>
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
          {t('connections.add')}
        </Button>
      </Group>
    </Stack>
  );
}

export function ConstantsPanel({ def, onChange }: { def: Def; onChange: SetDef }) {
  const { t } = useTranslation('editor');
  const [text, setText] = useState(() => (def.constants && Object.keys(def.constants).length ? YAML.stringify(def.constants, { lineWidth: 0 }) : ''));
  const [error, setError] = useState<string | null>(null);
  const update = (value: string) => {
    setText(value);
    if (!value.trim()) {
      setError(null);
      const { constants: _c, ...rest } = def;
      return onChange(rest as Def);
    }
    try {
      const parsed = YAML.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('constants.notMapping'));
      setError(null);
      onChange({ ...def, constants: parsed });
    } catch (e) {
      setError((e as Error).message.split('\n')[0] ?? t('constants.invalid'));
    }
  };
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        <Trans t={t} i18nKey="constants.hint" components={{ c: <Code /> }} />
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
  const { t } = useTranslation('editor');
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
      notifyError(e, t('source.validateFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        <Trans t={t} i18nKey="source.hint" components={{ c: <Code /> }} />
      </Text>
      <Textarea
        autosize
        minRows={16}
        maxRows={60}
        classNames={{ input: 'mono' }}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        spellCheck={false}
      />
      {issues && issues.length > 0 && (
        <Alert color="red" title={t('issues.count', { count: issues.length })}>
          <Stack gap={2}>
            {issues.slice(0, 15).map((i, k) => (
              <Text size="xs" key={k} className="mono">
                {i.path ? `${i.path}: ` : ''}
                {issueText(i)}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      {issues && issues.length === 0 && <Alert color="green">{t('source.applied')}</Alert>}
      <Group>
        <Button onClick={apply} loading={busy}>
          {t('source.apply')}
        </Button>
        <Button
          variant="default"
          onClick={() => {
            setText(toYaml(def));
            setIssues(null);
          }}
        >
          {t('source.reset')}
        </Button>
      </Group>
    </Stack>
  );
}

export function VersionsPanel({
  processId,
  currentVersion,
  workingCopy,
  onRestore,
}: {
  processId: string;
  currentVersion: number;
  /** Unsaved working copy (offered in the comparison) */
  workingCopy?: Def;
  onRestore: (d: Def, version: number) => void;
}) {
  const { t } = useTranslation('editor');
  const versions = useQuery({
    queryKey: ['process-versions', processId, currentVersion],
    queryFn: () => get<ProcessVersion[]>(`/processes/${processId}/versions`),
  });
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
        {t('versions.hint')}
      </Text>
      {versions.data && (
        <Paper withBorder p="sm">
          <Text fw={600} size="sm" mb="xs">
            {t('versions.compare')}
          </Text>
          <VersionCompare
            key={`${currentVersion}-${!!workingCopy}`}
            processId={processId}
            versions={versions.data}
            currentVersion={currentVersion}
            workingCopy={workingCopy}
          />
        </Paper>
      )}
      <div className="table-scroll">
        <Table striped highlightOnHover miw={560}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('versions.version')}</Table.Th>
              <Table.Th>{t('versions.saved')}</Table.Th>
              <Table.Th>{t('versions.author')}</Table.Th>
              <Table.Th>{t('versions.comment')}</Table.Th>
              <Table.Th>{t('versions.hash')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(versions.data ?? []).map((v) => (
              <Table.Tr key={v.version}>
                <Table.Td>{v.version === currentVersion ? t('versions.current', { version: v.version }) : `v${v.version}`}</Table.Td>
                <Table.Td className="nowrap">{fmtDate(v.createdAt)}</Table.Td>
                <Table.Td>{v.author}</Table.Td>
                <Table.Td>{v.comment}</Table.Td>
                <Table.Td className="mono">{v.hash.slice(0, 12)}</Table.Td>
                <Table.Td>
                  <Button size="compact-xs" variant="light" onClick={() => open(v.version)}>
                    {t('versions.view')}
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <Modal opened={!!viewing} onClose={() => setViewing(null)} title={t('versions.title', { version: viewVersion })} size="xl">
        {viewing && (
          <Stack>
            <Text size="xs" c="dimmed" className="mono">
              {t('versions.hashLine', { hash: viewing.definitionHash })}
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
                {t('versions.restore')}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

/** Values returned when this process runs as a sub-process (definition.outputs: name → expression). */
export function OutputsPanel({ def, onChange }: { def: Def; onChange: SetDef }) {
  const { t } = useTranslation('editor');
  const entries = Object.entries(def.outputs ?? {});
  const update = (list: [string, string][]) => {
    const next = { ...def } as Def;
    if (list.length) next.outputs = Object.fromEntries(list);
    else delete next.outputs;
    onChange(next);
  };
  const nameError = (k: string, i: number) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? t('form.idInvalid') : entries.some(([x], j) => j !== i && x === k) ? t('outputs.duplicate') : null;
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        <Trans t={t} i18nKey="outputs.hint" components={{ example: <Code>vars.users.body</Code>, path: <Code>{'vars.<saveAs>.<name>'}</Code> }} />
      </Text>
      {entries.map(([k, v], i) => (
        <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
          <TextInput
            size="xs"
            w={150}
            style={{ flexShrink: 0 }}
            classNames={{ input: 'mono' }}
            aria-label={t('outputs.name')}
            placeholder={t('outputs.namePlaceholder')}
            value={k}
            error={nameError(k, i)}
            onChange={(e) => update(entries.map((x, j) => (j === i ? [e.currentTarget.value, x[1]] : x)))}
          />
          <ExpressionInput
            size="xs"
            style={{ flex: 1, minWidth: 0 }}
            aria-label={t('outputs.expressionFor', { name: k })}
            placeholder={t('outputs.expressionPlaceholder', { example: 'vars.result' })}
            value={v}
            onChange={(text) => update(entries.map((x, j) => (j === i ? [x[0], text] : x)))}
          />
          <ActionIcon
            variant="subtle"
            color="red"
            mt={4}
            onClick={() => update(entries.filter((_, j) => j !== i))}
            aria-label={t('outputs.remove', { name: k })}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => {
            let n = entries.length + 1;
            while (entries.some(([x]) => x === `output${n}`)) n++;
            update([...entries, [`output${n}`, '']]);
          }}
        >
          {t('outputs.add')}
        </Button>
      </Group>
    </Stack>
  );
}
