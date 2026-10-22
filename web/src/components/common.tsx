import { useState, type ReactNode } from 'react';
import { ActionIcon, Badge, Box, Button, Code, CopyButton, Group, ScrollArea, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

const STATUS_COLORS: Record<string, string> = {
  succeeded: 'green',
  failed: 'red',
  running: 'blue',
  waiting: 'violet',
  queued: 'gray',
  cancelled: 'gray',
  interrupted: 'orange',
  skipped: 'gray',
  dryrun: 'yellow',
  open: 'violet',
  completed: 'green',
};

/** Display label of a run, step or task status (unknown values are shown as they are). */
export function statusLabel(status: string): string {
  return i18n.t(`common:status.${status}` as 'common:status.running', { defaultValue: status });
}

export function StatusBadge({ status, size = 'sm' }: { status: string; size?: 'xs' | 'sm' | 'md' }) {
  useTranslation();
  return (
    <Badge color={STATUS_COLORS[status] ?? 'gray'} variant="light" size={size}>
      {statusLabel(status)}
    </Badge>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" mb="md" wrap="wrap" gap="sm">
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Title order={2} fz={{ base: 'h3', sm: 'h2' }}>
          {title}
        </Title>
        {description && (
          <Text c="dimmed" size="sm" mt={4}>
            {description}
          </Text>
        )}
      </Box>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

export function JsonView({ value, maxHeight = 360 }: { value: unknown; maxHeight?: number }) {
  const { t } = useTranslation();
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <Box pos="relative">
      <ScrollArea.Autosize mah={maxHeight}>
        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {text ?? 'undefined'}
        </Code>
      </ScrollArea.Autosize>
      <CopyButton value={text ?? ''}>
        {({ copied, copy }) => (
          <ActionIcon size="sm" variant="subtle" onClick={copy} pos="absolute" top={4} right={14} aria-label={t('copy')}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        )}
      </CopyButton>
    </Box>
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Small, safe markdown subset (text is escaped before formatting). */
export function Markdown({ text }: { text?: string }) {
  if (!text) return null;
  const lines = escapeHtml(text).split('\n');
  const out: string[] = [];
  let list = false;
  const inline = (s: string) =>
    s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  for (const l of lines) {
    const li = /^\s*[-*]\s+(.*)$/.exec(l);
    if (li) {
      if (!list) out.push('<ul>'), (list = true);
      out.push(`<li>${inline(li[1]!)}</li>`);
      continue;
    }
    if (list) out.push('</ul>'), (list = false);
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) out.push(`<p><strong>${inline(h[2]!)}</strong></p>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push('</ul>');
  return <div className="md" dangerouslySetInnerHTML={{ __html: out.join('') }} />;
}

export function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Parse what the user typed back into a value: JSON objects/arrays/numbers stay typed when they look like JSON. */
export function fromText(s: string): unknown {
  const t = s.trim();
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return s;
    }
  }
  return s;
}

export function KeyValueEditor({
  value,
  onChange,
  keyLabel: keyLabelProp,
  valueLabel: valueLabelProp,
  valuePlaceholder,
  addLabel: addLabelProp,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (v: Record<string, unknown> | undefined) => void;
  keyLabel?: string;
  valueLabel?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const { t } = useTranslation();
  const keyLabel = keyLabelProp ?? t('name');
  const valueLabel = valueLabelProp ?? t('value');
  const addLabel = addLabelProp ?? t('add');
  const entries = Object.entries(value ?? {});
  const [draftKey, setDraftKey] = useState('');
  const update = (list: [string, unknown][]) => onChange(list.length ? Object.fromEntries(list) : undefined);
  return (
    <Stack gap={6}>
      {entries.map(([k, v], i) => (
        <Group key={i} gap={6} wrap="nowrap" align="flex-start">
          <TextInput
            size="xs"
            w={160}
            value={k}
            aria-label={keyLabel}
            onChange={(e) => {
              const copy = [...entries];
              copy[i] = [e.currentTarget.value, v];
              update(copy);
            }}
          />
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            classNames={{ input: 'mono' }}
            value={asText(v)}
            aria-label={valueLabel}
            placeholder={valuePlaceholder}
            onChange={(e) => {
              const copy = [...entries];
              copy[i] = [k, fromText(e.currentTarget.value)];
              update(copy);
            }}
          />
          <ActionIcon variant="subtle" color="red" onClick={() => update(entries.filter((_, j) => j !== i))} aria-label={t('remove')}>
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group gap={6}>
        <TextInput size="xs" w={160} placeholder={keyLabel} value={draftKey} onChange={(e) => setDraftKey(e.currentTarget.value)} />
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

export function Hint({ children }: { children: ReactNode }) {
  return (
    <Text size="xs" c="dimmed">
      {children}
    </Text>
  );
}

export function IconTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip label={label} withArrow>
      <span>{children}</span>
    </Tooltip>
  );
}
