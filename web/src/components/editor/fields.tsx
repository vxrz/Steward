import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import YAML from 'yaml';
import {
  ActionIcon,
  Box,
  Button,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { BROWSER_ACTIONS, HTTP_METHODS, type BrowserAction, type Column, type ConnectionSlot, type FieldMeta, type Paginate, type Subject } from '@sm/shared';
import { KeyValueEditor, asText, fromText } from '../common';
import { get } from '../../api';
import { useExprContext } from './ExprContext';
import { ExpressionInput } from './ExpressionInput';
import { useProcesses } from './editorApi';
import i18n from '../../i18n';
import { browserActionLabel, type LocalizedField } from '../../i18n/meta';
import { subjectOptionLabel } from '../AccessEditor';

/** "{{ expression }}" as a value, so i18next does not read it as a placeholder of its own. */
const EXPR = { expr: '{{ expression }}' };

export const exprHint = (): string => i18n.t('editor:fields.exprHint', { example: 'vars.users.body[active]' });

interface FieldProps {
  field: LocalizedField;
  value: unknown;
  onChange: (v: unknown) => void;
  connections: ConnectionSlot[];
}

const clean = (s: string) => (s === '' ? undefined : s);

function Label({ field }: { field: FieldMeta }) {
  return (
    <>
      {field.label}
      {field.required && <span style={{ color: 'var(--mantine-color-red-filled)' }}> *</span>}
    </>
  );
}

/** Renders one field of a step form based on its FieldMeta kind. */
export function FieldInput({ field, value, onChange, connections }: FieldProps) {
  const { t } = useTranslation(['editor', 'common']);
  const expr = useExprContext();
  const label = <Label field={field} />;
  const description = field.help;
  switch (field.kind) {
    case 'text':
    case 'identifier':
      return (
        <TextInput
          label={label}
          description={description}
          placeholder={field.placeholder}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(clean(e.currentTarget.value))}
          className={field.kind === 'identifier' ? 'mono' : undefined}
        />
      );
    case 'template':
    case 'expr':
    case 'templateArea': {
      const isExpr = field.kind === 'expr';
      const area = field.kind === 'templateArea';
      const desc = isExpr
        ? description
          ? `${description} · ${exprHint()}`
          : exprHint()
        : field.kind === 'template'
          ? (description ?? t('fields.templateHint', EXPR))
          : description;
      if (!expr.enabled) {
        return (
          <Textarea
            label={label}
            description={desc}
            placeholder={field.placeholder}
            autosize
            minRows={area ? 3 : 1}
            maxRows={area ? 16 : 10}
            classNames={{ input: 'mono' }}
            value={(value as string) ?? ''}
            onChange={(e) => onChange(clean(e.currentTarget.value))}
          />
        );
      }
      return (
        <ExpressionInput
          label={label}
          description={desc}
          placeholder={field.placeholder}
          template={!isExpr}
          minRows={area ? 3 : 1}
          maxRows={area ? 16 : 10}
          value={(value as string) ?? ''}
          onChange={(v) => onChange(clean(v))}
        />
      );
    }
    case 'number':
      return (
        <NumberInput
          label={label}
          description={description}
          value={(value as number) ?? ''}
          onChange={(v) => onChange(v === '' || v === undefined ? undefined : Number(v))}
        />
      );
    case 'boolean':
      return (
        <Box>
          <Text size="sm" fw={500}>
            {label}
          </Text>
          {description && (
            <Text size="xs" c="dimmed">
              {description}
            </Text>
          )}
          <SegmentedControl
            size="xs"
            mt={4}
            value={value === true ? 'yes' : value === false ? 'no' : 'default'}
            onChange={(v) => onChange(v === 'yes' ? true : v === 'no' ? false : undefined)}
            data={[
              { value: 'default', label: t('fields.default') },
              { value: 'yes', label: t('common:yes') },
              { value: 'no', label: t('common:no') },
            ]}
          />
        </Box>
      );
    case 'select':
      return (
        <Select
          label={label}
          description={description}
          data={(field.options ?? []).map((o) => ({ value: o, label: field.optionLabels?.[o] ?? o }))}
          clearable={!field.required}
          value={(value as string) ?? null}
          onChange={(v) => onChange(v ?? undefined)}
        />
      );
    case 'connection':
      return (
        <Select
          label={label}
          description={description ?? (connections.length ? undefined : t('fields.declareConnections'))}
          data={connections.map((c) => ({ value: c.slot, label: c.kind ? `${c.slot} (${c.kind})` : c.slot }))}
          clearable={!field.required}
          value={(value as string) ?? null}
          onChange={(v) => onChange(v ?? undefined)}
        />
      );
    case 'method':
      return <Select label={label} data={[...HTTP_METHODS]} value={(value as string) ?? 'GET'} onChange={(v) => onChange(v ?? 'GET')} allowDeselect={false} />;
    case 'keyValue':
      return (
        <Box>
          <Text size="sm" fw={500} mb={4}>
            {label}
          </Text>
          {description && (
            <Text size="xs" c="dimmed" mb={4}>
              {description}
            </Text>
          )}
          {expr.enabled ? (
            <ExprKeyValueEditor value={value as Record<string, unknown> | undefined} onChange={onChange} template={field.key !== 'metrics'} />
          ) : (
            <KeyValueEditor value={value as Record<string, unknown> | undefined} onChange={onChange} valuePlaceholder={t('fields.valueOrExpr', EXPR)} />
          )}
        </Box>
      );
    case 'json':
      return <JsonField label={label} description={description} value={value} onChange={onChange} />;
    case 'columns':
      return <ColumnsEditor label={label} value={value as Column[] | undefined} onChange={onChange} />;
    case 'paginate':
      return <PaginateEditor value={value as Paginate | undefined} onChange={onChange} />;
    case 'statusList':
      return <StatusListField label={label} description={description} value={value as number[] | undefined} onChange={onChange} />;
    case 'actions':
      return <ActionsEditor value={(value as BrowserAction[] | undefined) ?? []} onChange={onChange} />;
    case 'subjects':
      return <SubjectsField label={label} description={description} value={value as string[] | undefined} onChange={onChange} />;
    case 'process':
      return <ProcessField label={label} description={description} value={value as string | undefined} onChange={onChange} required={field.required} />;
    default:
      return null;
  }
}

/** JSON or YAML typed by the user, parsed on blur. */
function JsonField({ label, description, value, onChange }: { label: React.ReactNode; description?: string; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation('editor');
  const toText = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : YAML.stringify(v, { lineWidth: 0 }).trimEnd());
  const [text, setText] = useState(() => toText(value));
  const [error, setError] = useState<string | null>(null);
  const committed = useRef(value);
  // pick up values set from elsewhere (e.g. "Insert example body")
  useEffect(() => {
    if (JSON.stringify(value) !== JSON.stringify(committed.current)) {
      committed.current = value;
      setText(toText(value));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = () => {
    if (!text.trim()) {
      setError(null);
      committed.current = undefined;
      return onChange(undefined);
    }
    try {
      const parsed = YAML.parse(text);
      setError(null);
      committed.current = parsed;
      onChange(parsed);
    } catch (e) {
      setError((e as Error).message.split('\n')[0] ?? t('fields.invalidYamlJson'));
    }
  };
  return (
    <ExpressionInput
      label={label}
      description={description ?? t('fields.jsonHint', { exprs: '{{ expressions }}' })}
      template
      preview={false}
      minRows={3}
      maxRows={16}
      value={text}
      error={error}
      onChange={setText}
      onBlur={commit}
      placeholder={'type: USER\nvalue: "{{ vars.user.id }}"'}
    />
  );
}

function StatusListField({ label, description, value, onChange }: { label: React.ReactNode; description?: string; value?: number[]; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => (value ?? []).join(', '));
  const committed = useRef(value);
  useEffect(() => {
    if (JSON.stringify(value) !== JSON.stringify(committed.current)) {
      committed.current = value;
      setText((value ?? []).join(', '));
    }
  }, [value]);
  return (
    <TextInput
      label={label}
      description={description}
      placeholder="200, 201, 409"
      value={text}
      onChange={(e) => {
        const t = e.currentTarget.value;
        setText(t);
        const nums = t
          .split(/[,\s]+/)
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n >= 100 && n < 600);
        committed.current = nums.length ? nums : undefined;
        onChange(committed.current);
      }}
    />
  );
}

function move<T>(list: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const copy = [...list];
  [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  return copy;
}

export function ColumnsEditor({ label, value, onChange }: { label: React.ReactNode; value?: Column[]; onChange: (v: unknown) => void }) {
  const { t } = useTranslation(['editor', 'common']);
  const cols = value ?? [];
  const set = (next: Column[]) => onChange(next.length ? next : undefined);
  return (
    <Box>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <Text size="xs" c="dimmed" mb={4}>
        {t('fields.columnsHint', { example: "userName, $join(groups.display, ', ')" })}
      </Text>
      <Stack gap={6}>
        {cols.map((c, i) => (
          <Group key={i} gap={6} wrap="nowrap">
            <TextInput size="xs" w={130} placeholder={t('fields.columnLabel')} aria-label={t('fields.columnLabel')} value={c.label} onChange={(e) => set(cols.map((x, j) => (j === i ? { ...x, label: e.currentTarget.value } : x)))} />
            <ExpressionInput
              size="xs"
              style={{ flex: 1, minWidth: 0 }}
              placeholder={t('fields.expression')}
              aria-label={t('fields.columnValue')}
              preview={false}
              value={c.value}
              onChange={(v) => set(cols.map((x, j) => (j === i ? { ...x, value: v } : x)))}
            />
            <ActionIcon size="sm" variant="subtle" onClick={() => set(move(cols, i, -1))} disabled={i === 0} aria-label={t('fields.up')}>
              <IconArrowUp size={14} />
            </ActionIcon>
            <ActionIcon size="sm" variant="subtle" color="red" onClick={() => set(cols.filter((_, j) => j !== i))} aria-label={t('common:remove')}>
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
        <Group>
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => set([...cols, { label: '', value: '' }])}>
            {t('fields.addColumn')}
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}

const PAGINATE_DEFAULTS: Record<string, { pageParam: string; sizeParam: string }> = {
  scim: { pageParam: 'startIndex', sizeParam: 'count' },
  page: { pageParam: 'page', sizeParam: 'size' },
  offset: { pageParam: 'offset', sizeParam: 'limit' },
};

function PaginateEditor({ value, onChange }: { value?: Paginate; onChange: (v: unknown) => void }) {
  const { t } = useTranslation('editor');
  const mode = value?.mode ?? 'none';
  const set = (patch: Partial<Paginate>) => {
    const next: Record<string, unknown> = { ...(value ?? { mode: 'none' }), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange(next as Paginate);
  };
  const txt = (k: keyof Paginate, label: string, placeholder?: string) => (
    <TextInput
      size="xs"
      label={label}
      placeholder={placeholder}
      classNames={{ input: 'mono' }}
      value={(value?.[k] as string) ?? ''}
      onChange={(e) => set({ [k]: e.currentTarget.value || undefined } as Partial<Paginate>)}
    />
  );
  const num = (k: keyof Paginate, label: string, placeholder?: string) => (
    <NumberInput
      size="xs"
      label={label}
      placeholder={placeholder}
      value={(value?.[k] as number) ?? ''}
      onChange={(v) => set({ [k]: v === '' ? undefined : Number(v) } as Partial<Paginate>)}
    />
  );
  return (
    <Paper withBorder p="xs">
      <Select
        size="xs"
        label={t('paginate.label')}
        description={t('paginate.hint')}
        data={[
          { value: 'none', label: t('paginate.none') },
          { value: 'scim', label: t('paginate.scim') },
          { value: 'page', label: t('paginate.page') },
          { value: 'offset', label: t('paginate.offset') },
          { value: 'nextLink', label: t('paginate.nextLink') },
        ]}
        value={mode}
        allowDeselect={false}
        onChange={(m) => (m === 'none' ? onChange(undefined) : set({ mode: m as Paginate['mode'] }))}
      />
      {mode !== 'none' && (
        <SimpleGrid cols={{ base: 1, xs: 2 }} mt="xs" spacing="xs">
          {num('pageSize', t('paginate.pageSize'), '100')}
          {txt('itemsPath', t('paginate.itemsPath'), mode === 'scim' ? 'resources' : '_embedded.assets')}
          {mode !== 'nextLink' && txt('pageParam', t('paginate.pageParam'), PAGINATE_DEFAULTS[mode]?.pageParam)}
          {mode !== 'nextLink' && txt('sizeParam', t('paginate.sizeParam'), PAGINATE_DEFAULTS[mode]?.sizeParam)}
          {mode === 'page' && txt('totalPagesPath', t('paginate.totalPagesPath'), 'page.totalPages')}
          {mode === 'page' && num('firstPage', t('paginate.firstPage'), '0')}
          {mode === 'nextLink' && txt('nextPath', t('paginate.nextPath'), '_links.next.href')}
          {num('maxPages', t('paginate.maxPages'), '500')}
        </SimpleGrid>
      )}
    </Paper>
  );
}

type ActionField = 'selector' | 'value' | 'as' | 'attribute' | 'name';
const actionFieldLabel = (f: ActionField): string => i18n.t(`editor:actions.fields.${f}`);

function valueLabel(action: string): string {
  switch (action) {
    case 'goto':
    case 'press':
    case 'expectText':
    case 'wait':
    case 'evaluate':
      return i18n.t(`editor:actions.valueLabels.${action}`);
    default:
      return actionFieldLabel('value');
  }
}

function ActionsEditor({ value, onChange }: { value: BrowserAction[]; onChange: (v: unknown) => void }) {
  const { t } = useTranslation(['editor', 'common']);
  const set = (next: BrowserAction[]) => onChange(next);
  const patch = (i: number, p: Partial<BrowserAction>) =>
    set(
      value.map((a, j) => {
        if (j !== i) return a;
        const next: Record<string, unknown> = { ...a, ...p };
        for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
        return next as BrowserAction;
      }),
    );
  return (
    <Box>
      <Text size="sm" fw={500}>
        {t('actions.label')} <span style={{ color: 'var(--mantine-color-red-filled)' }}>*</span>
      </Text>
      <Text size="xs" c="dimmed" mb={6}>
        {t('actions.hint', {
          selectors: 'CSS (#id, .class), text=Sign in, role=button[name="Save"]',
          exprs: '{{ expressions }}',
          example: "{{ $secret('portal','password') }}",
        })}
      </Text>
      <Stack gap={6}>
        {value.map((a, i) => {
          const meta = BROWSER_ACTIONS.find((b) => b.action === a.action);
          return (
            <Paper withBorder p="xs" key={i}>
              <Group gap={6} wrap="nowrap" align="flex-end">
                <Text size="xs" c="dimmed" w={18}>
                  {i + 1}.
                </Text>
                <Select
                  size="xs"
                  style={{ flex: 1, minWidth: 0 }}
                  data={BROWSER_ACTIONS.map((b) => ({ value: b.action, label: browserActionLabel(b.action, b.label) }))}
                  aria-label={t('actions.action', { n: i + 1 })}
                  value={a.action}
                  allowDeselect={false}
                  onChange={(v) => v && patch(i, { action: v as BrowserAction['action'] })}
                />
                <ActionIcon size="sm" variant="subtle" disabled={i === 0} onClick={() => set(move(value, i, -1))} aria-label={t('fields.up')}>
                  <IconArrowUp size={14} />
                </ActionIcon>
                <ActionIcon size="sm" variant="subtle" disabled={i === value.length - 1} onClick={() => set(move(value, i, 1))} aria-label={t('fields.down')}>
                  <IconArrowDown size={14} />
                </ActionIcon>
                <ActionIcon size="sm" variant="subtle" color="red" onClick={() => set(value.filter((_, j) => j !== i))} aria-label={t('common:remove')}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
              <SimpleGrid cols={{ base: 1, xs: 2 }} spacing={6} mt={6}>
                {(meta?.fields ?? []).map((f) =>
                  f === 'value' && a.action !== 'evaluate' ? (
                    <ExpressionInput
                      key={f}
                      size="xs"
                      template
                      preview={false}
                      label={valueLabel(a.action)}
                      value={(a[f] as string) ?? ''}
                      onChange={(v) => patch(i, { [f]: v || undefined } as Partial<BrowserAction>)}
                    />
                  ) : (
                    <TextInput
                      key={f}
                      size="xs"
                      label={f === 'value' ? valueLabel(a.action) : actionFieldLabel(f)}
                      classNames={{ input: 'mono' }}
                      value={(a[f] as string) ?? ''}
                      onChange={(e) => patch(i, { [f]: e.currentTarget.value || undefined } as Partial<BrowserAction>)}
                    />
                  ),
                )}
                {a.action === 'screenshot' && (
                  <Switch size="xs" mt={6} label={t('actions.fullPage')} checked={!!a.fullPage} onChange={(e) => patch(i, { fullPage: e.currentTarget.checked || undefined })} />
                )}
                {a.action === 'extract' && (
                  <Switch size="xs" mt={6} label={t('actions.allMatches')} checked={!!a.all} onChange={(e) => patch(i, { all: e.currentTarget.checked || undefined })} />
                )}
                {['click', 'fill', 'waitFor', 'expectText', 'goto'].includes(a.action) && (
                  <NumberInput
                    size="xs"
                    label={t('actions.timeout')}
                    placeholder={t('actions.timeoutDefault')}
                    value={a.timeoutMs ?? ''}
                    onChange={(v) => patch(i, { timeoutMs: v === '' ? undefined : Number(v) })}
                  />
                )}
              </SimpleGrid>
            </Paper>
          );
        })}
        <Group>
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => set([...value, { action: 'click', selector: '' }])}>
            {t('actions.add')}
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}

/** Users, teams and roles (suggestions from /api/subjects; free text allowed). */
function SubjectsField({ label, description, value, onChange }: { label: React.ReactNode; description?: string; value?: string[]; onChange: (v: unknown) => void }) {
  useTranslation('editor');
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => get<Subject[]>('/subjects'), retry: false, staleTime: 60000 });
  const labels = new Map((subjects.data ?? []).map((s) => [s.value, subjectOptionLabel(s)]));
  return (
    <TagsInput
      label={label}
      description={description}
      placeholder="user:alice, team:service-desk, role:approver"
      splitChars={[',', ' ']}
      data={(subjects.data ?? []).map((s) => s.value)}
      renderOption={({ option }) => (
        <div>
          <Text size="xs" className="mono">
            {option.value}
          </Text>
          {labels.get(option.value) && labels.get(option.value) !== option.value && (
            <Text size="10px" c="dimmed">
              {labels.get(option.value)}
            </Text>
          )}
        </div>
      )}
      value={value ?? []}
      onChange={(v) => onChange(v.length ? v : undefined)}
    />
  );
}

/** Key/value rows whose values are templates (or expressions) with the expression assistant. */
export function ExprKeyValueEditor({
  value,
  onChange,
  template = true,
  keyLabel: keyLabelProp,
  addLabel: addLabelProp,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (v: Record<string, unknown> | undefined) => void;
  template?: boolean;
  keyLabel?: string;
  addLabel?: string;
}) {
  const { t } = useTranslation(['editor', 'common']);
  const keyLabel = keyLabelProp ?? t('common:name');
  const addLabel = addLabelProp ?? t('common:add');
  const entries = Object.entries(value ?? {});
  const [draftKey, setDraftKey] = useState('');
  const update = (list: [string, unknown][]) => onChange(list.length ? Object.fromEntries(list) : undefined);
  return (
    <Stack gap={6}>
      {entries.map(([k, v], i) => (
        <Group key={i} gap={6} wrap="nowrap" align="flex-start">
          <TextInput
            size="xs"
            w={120}
            style={{ flexShrink: 0 }}
            classNames={{ input: 'mono' }}
            value={k}
            aria-label={keyLabel}
            onChange={(e) => {
              const copy = [...entries];
              copy[i] = [e.currentTarget.value, v];
              update(copy);
            }}
          />
          <ExpressionInput
            size="xs"
            style={{ flex: 1, minWidth: 0 }}
            template={template}
            aria-label={t('fields.valueOf', { key: k })}
            placeholder={template ? t('fields.valueOrExpr', EXPR) : t('fields.expression')}
            value={asText(v)}
            onChange={(text) => {
              const copy = [...entries];
              copy[i] = [k, template ? fromText(text) : text];
              update(copy);
            }}
          />
          <ActionIcon variant="subtle" color="red" mt={4} onClick={() => update(entries.filter((_, j) => j !== i))} aria-label={t('fields.removeKey', { key: k })}>
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group gap={6}>
        <TextInput size="xs" w={120} placeholder={keyLabel} aria-label={t('fields.newKey', { label: keyLabel })} value={draftKey} onChange={(e) => setDraftKey(e.currentTarget.value)} />
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={!draftKey.trim() || entries.some(([k]) => k === draftKey.trim())}
          onClick={() => {
            update([...entries, [draftKey.trim(), '']]);
            setDraftKey('');
          }}
        >
          {addLabel}
        </Button>
      </Group>
    </Stack>
  );
}

/** Select of other processes (for sub-process nodes). */
function ProcessField({
  label,
  description,
  value,
  onChange,
  required,
}: {
  label: React.ReactNode;
  description?: string;
  value?: string;
  onChange: (v: unknown) => void;
  required?: boolean;
}) {
  const { t } = useTranslation(['editor', 'common']);
  const { processId } = useExprContext();
  const processes = useProcesses();
  const options = (processes.data ?? []).filter((p) => p.id !== processId).map((p) => ({ value: p.id, label: p.name }));
  if (value && !options.some((o) => o.value === value) && value !== processId) options.push({ value, label: t('fields.notFound', { value }) });
  return (
    <Select
      label={label}
      description={description ?? t('fields.processHint')}
      placeholder={processes.isLoading ? t('common:loading') : t('fields.chooseProcess')}
      data={options}
      searchable
      clearable={!required}
      nothingFoundMessage={t('fields.noOtherProcess')}
      value={value || null}
      error={value && value === processId ? t('fields.selfReference') : undefined}
      onChange={(v) => onChange(v ?? '')}
    />
  );
}
