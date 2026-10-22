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
import { BROWSER_ACTIONS, HTTP_METHODS, type BrowserAction, type Column, type ConnectionSlot, type FieldMeta, type Paginate, type Subject } from '@sm/shared';
import { KeyValueEditor } from '../common';
import { get } from '../../api';

export const EXPR_HINT = 'JSONata expression, e.g. vars.users.body[active]';

interface FieldProps {
  field: FieldMeta;
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
      return (
        <Textarea
          label={label}
          description={field.kind === 'expr' ? (description ? `${description} · ${EXPR_HINT}` : EXPR_HINT) : (description ?? 'Text with {{ expression }} placeholders')}
          placeholder={field.placeholder}
          autosize
          minRows={1}
          maxRows={10}
          classNames={{ input: 'mono' }}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(clean(e.currentTarget.value))}
        />
      );
    case 'templateArea':
      return (
        <Textarea
          label={label}
          description={description}
          placeholder={field.placeholder}
          autosize
          minRows={3}
          maxRows={16}
          classNames={{ input: 'mono' }}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(clean(e.currentTarget.value))}
        />
      );
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
              { value: 'default', label: 'Default' },
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
          />
        </Box>
      );
    case 'select':
      return (
        <Select
          label={label}
          description={description}
          data={field.options ?? []}
          clearable={!field.required}
          value={(value as string) ?? null}
          onChange={(v) => onChange(v ?? undefined)}
        />
      );
    case 'connection':
      return (
        <Select
          label={label}
          description={description ?? (connections.length ? undefined : 'Declare connections in the "Settings" tab first')}
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
          <KeyValueEditor value={value as Record<string, unknown> | undefined} onChange={onChange} valuePlaceholder="value or {{ expression }}" />
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
    default:
      return null;
  }
}

/** JSON or YAML typed by the user, parsed on blur. */
function JsonField({ label, description, value, onChange }: { label: React.ReactNode; description?: string; value: unknown; onChange: (v: unknown) => void }) {
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
      setError((e as Error).message.split('\n')[0] ?? 'Invalid YAML/JSON');
    }
  };
  return (
    <Textarea
      label={label}
      description={description ?? 'JSON or YAML. Strings may contain {{ expressions }}.'}
      autosize
      minRows={3}
      maxRows={16}
      classNames={{ input: 'mono' }}
      value={text}
      error={error}
      onChange={(e) => setText(e.currentTarget.value)}
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
  const cols = value ?? [];
  const set = (next: Column[]) => onChange(next.length ? next : undefined);
  return (
    <Box>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <Text size="xs" c="dimmed" mb={4}>
        Value is an expression evaluated against each item (e.g. userName, $join(groups.display, ', ')).
      </Text>
      <Stack gap={6}>
        {cols.map((c, i) => (
          <Group key={i} gap={6} wrap="nowrap">
            <TextInput size="xs" w={130} placeholder="Label" value={c.label} onChange={(e) => set(cols.map((x, j) => (j === i ? { ...x, label: e.currentTarget.value } : x)))} />
            <TextInput
              size="xs"
              style={{ flex: 1, minWidth: 0 }}
              classNames={{ input: 'mono' }}
              placeholder="expression"
              value={c.value}
              onChange={(e) => set(cols.map((x, j) => (j === i ? { ...x, value: e.currentTarget.value } : x)))}
            />
            <ActionIcon size="sm" variant="subtle" onClick={() => set(move(cols, i, -1))} disabled={i === 0} aria-label="Up">
              <IconArrowUp size={14} />
            </ActionIcon>
            <ActionIcon size="sm" variant="subtle" color="red" onClick={() => set(cols.filter((_, j) => j !== i))} aria-label="Remove">
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
        <Group>
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => set([...cols, { label: '', value: '' }])}>
            Add column
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
        label="Pagination"
        description="Fetch all pages and return the combined items as body"
        data={[
          { value: 'none', label: 'None (single request)' },
          { value: 'scim', label: 'SCIM (startIndex / count, e.g. Identity Management)' },
          { value: 'page', label: 'Page number (page / size, e.g. Asset Management)' },
          { value: 'offset', label: 'Offset / limit' },
          { value: 'nextLink', label: 'Next link in response' },
        ]}
        value={mode}
        allowDeselect={false}
        onChange={(m) => (m === 'none' ? onChange(undefined) : set({ mode: m as Paginate['mode'] }))}
      />
      {mode !== 'none' && (
        <SimpleGrid cols={{ base: 1, xs: 2 }} mt="xs" spacing="xs">
          {num('pageSize', 'Page size', '100')}
          {txt('itemsPath', 'Items path (expression)', mode === 'scim' ? 'resources' : '_embedded.assets')}
          {mode !== 'nextLink' && txt('pageParam', 'Page parameter', PAGINATE_DEFAULTS[mode]?.pageParam)}
          {mode !== 'nextLink' && txt('sizeParam', 'Size parameter', PAGINATE_DEFAULTS[mode]?.sizeParam)}
          {mode === 'page' && txt('totalPagesPath', 'Total pages path', 'page.totalPages')}
          {mode === 'page' && num('firstPage', 'First page number', '0')}
          {mode === 'nextLink' && txt('nextPath', 'Next URL path', '_links.next.href')}
          {num('maxPages', 'Max pages (safety)', '500')}
        </SimpleGrid>
      )}
    </Paper>
  );
}

const ACTION_FIELD_LABELS: Record<string, string> = {
  selector: 'Selector',
  value: 'Value',
  as: 'Save as',
  attribute: 'Attribute',
  name: 'Name',
};

function valueLabel(action: string): string {
  switch (action) {
    case 'goto':
      return 'URL or path';
    case 'press':
      return 'Key (e.g. Enter)';
    case 'expectText':
      return 'Expected text';
    case 'wait':
      return 'Milliseconds';
    case 'evaluate':
      return 'JavaScript';
    default:
      return 'Value';
  }
}

function ActionsEditor({ value, onChange }: { value: BrowserAction[]; onChange: (v: unknown) => void }) {
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
        Actions <span style={{ color: 'var(--mantine-color-red-filled)' }}>*</span>
      </Text>
      <Text size="xs" c="dimmed" mb={6}>
        Playwright selectors: CSS (#id, .class), text=Sign in, role=button[name="Save"]. Values may contain {'{{ expressions }}'}, e.g. {"{{ $secret('portal','password') }}"}.
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
                  data={BROWSER_ACTIONS.map((b) => ({ value: b.action, label: b.label }))}
                  value={a.action}
                  allowDeselect={false}
                  onChange={(v) => v && patch(i, { action: v as BrowserAction['action'] })}
                />
                <ActionIcon size="sm" variant="subtle" disabled={i === 0} onClick={() => set(move(value, i, -1))} aria-label="Up">
                  <IconArrowUp size={14} />
                </ActionIcon>
                <ActionIcon size="sm" variant="subtle" disabled={i === value.length - 1} onClick={() => set(move(value, i, 1))} aria-label="Down">
                  <IconArrowDown size={14} />
                </ActionIcon>
                <ActionIcon size="sm" variant="subtle" color="red" onClick={() => set(value.filter((_, j) => j !== i))} aria-label="Remove">
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
              <SimpleGrid cols={{ base: 1, xs: 2 }} spacing={6} mt={6}>
                {(meta?.fields ?? []).map((f) => (
                  <TextInput
                    key={f}
                    size="xs"
                    label={f === 'value' ? valueLabel(a.action) : ACTION_FIELD_LABELS[f]}
                    classNames={{ input: 'mono' }}
                    value={(a[f] as string) ?? ''}
                    onChange={(e) => patch(i, { [f]: e.currentTarget.value || undefined } as Partial<BrowserAction>)}
                  />
                ))}
                {a.action === 'screenshot' && (
                  <Switch size="xs" mt={6} label="Full page" checked={!!a.fullPage} onChange={(e) => patch(i, { fullPage: e.currentTarget.checked || undefined })} />
                )}
                {a.action === 'extract' && (
                  <Switch size="xs" mt={6} label="All matches (list)" checked={!!a.all} onChange={(e) => patch(i, { all: e.currentTarget.checked || undefined })} />
                )}
                {['click', 'fill', 'waitFor', 'expectText', 'goto'].includes(a.action) && (
                  <NumberInput
                    size="xs"
                    label="Timeout (ms)"
                    placeholder="default"
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
            Add action
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}

/** Users, teams and roles (suggestions from /api/subjects; free text allowed). */
function SubjectsField({ label, description, value, onChange }: { label: React.ReactNode; description?: string; value?: string[]; onChange: (v: unknown) => void }) {
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => get<Subject[]>('/subjects'), retry: false, staleTime: 60000 });
  const labels = new Map((subjects.data ?? []).map((s) => [s.value, s.label]));
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
