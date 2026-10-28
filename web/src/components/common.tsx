import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMediaQuery } from '@mantine/hooks';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Collapse,
  CopyButton,
  Group,
  Paper,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconFilter,
  IconPlus,
  IconRefresh,
  IconTrash,
  type Icon as TablerIcon,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { errorText } from '../i18n/errors';
import { NAV_GROUPS, type NavKey } from './AppNav';

/**
 * One colour vocabulary for every status badge (runs, tasks, monitors, credentials, check severities):
 * green = good / done, red = failed / down / expired, orange = needs attention (overdue, interrupted,
 * blocked, warning), yellow = soon / degraded / simulated, blue = in progress / maintenance,
 * violet = waiting for a person, gray = neutral / unknown. The label always says the status as well,
 * so colour is never the only signal.
 */
export const TONE = {
  ok: 'green',
  bad: 'red',
  attention: 'orange',
  soon: 'yellow',
  active: 'blue',
  person: 'violet',
  neutral: 'gray',
} as const;

const STATUS_COLORS: Record<string, string> = {
  succeeded: TONE.ok,
  failed: TONE.bad,
  running: TONE.active,
  waiting: TONE.person,
  queued: TONE.neutral,
  cancelled: TONE.neutral,
  interrupted: TONE.attention,
  skipped: TONE.neutral,
  dryrun: TONE.soon,
  open: TONE.person,
  completed: TONE.ok,
};

const SEVERITY_COLORS: Record<string, string> = { error: TONE.bad, warning: TONE.attention, info: TONE.neutral };

/** Display label of a run, step or task status (unknown values are shown as they are). */
export function statusLabel(status: string): string {
  return i18n.t(`common:status.${status}` as 'common:status.running', { defaultValue: status });
}

/** "user:jdoe" → "jdoe", "team:service desk" → "Team service desk", "role:operator" → "Role: Operator" */
export function subjectLabel(subject: string): string {
  const i = subject.indexOf(':');
  const kind = subject.slice(0, i);
  const name = subject.slice(i + 1);
  if (kind === 'user') return name;
  if (kind === 'team') return i18n.t('common:subjects.team', { name });
  if (kind === 'role') return i18n.t('common:subjects.role', { role: i18n.t(`common:roles.${name}` as 'common:roles.admin', { defaultValue: name }) });
  return subject;
}

/** Check severity (error / warning / info) for display. */
export function severityLabel(severity: string): string {
  return i18n.t(`common:severity.${severity}` as 'common:severity.error', { defaultValue: severity });
}

export function StatusBadge({ status, size = 'sm' }: { status: string; size?: 'xs' | 'sm' | 'md' }) {
  useTranslation();
  return (
    <Badge color={STATUS_COLORS[status] ?? TONE.neutral} variant="light" size={size} style={{ minWidth: 'max-content' }}>
      {statusLabel(status)}
    </Badge>
  );
}

/** A parent page shown above a detail page's title ("‹ Runs"): a sidebar page by its key, or any link. */
export type Crumb = NavKey | { to: string; label: ReactNode };

/**
 * The header every page starts with: title (h2), optional description, the page's actions on the right
 * and, on detail pages, the way back to the parent pages (`back`). On narrow screens the actions wrap
 * below the title instead of squeezing it.
 */
/**
 * Filters of a list: shown as they are on wide screens; on phones folded behind a "Filters" button
 * (with the number of active filters) so the list itself stays on the first screen.
 */
export function FilterPanel({ active, children }: { active: number; children: ReactNode }) {
  const { t } = useTranslation();
  const narrow = useMediaQuery('(max-width: 36em)');
  const [open, setOpen] = useState(false);
  if (!narrow) return <>{children}</>;
  return (
    <Box mb="md">
      <Button
        size="xs"
        variant={active ? 'light' : 'default'}
        leftSection={<IconFilter size={14} />}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="list-filters"
        mb={open ? 'xs' : 0}
      >
        {active ? t('filtersActive', { count: active }) : t('filters')}
      </Button>
      <Collapse in={open} id="list-filters">
        {children}
      </Collapse>
    </Box>
  );
}

/** Severity of a failed check (error / warning / info). */
export function SeverityBadge({ severity, size = 'xs' }: { severity: string; size?: 'xs' | 'sm' }) {
  useTranslation();
  return (
    <Badge color={SEVERITY_COLORS[severity] ?? TONE.neutral} variant="light" size={size}>
      {severityLabel(severity)}
    </Badge>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: Crumb | Crumb[] }) {
  const crumbs = back ? (Array.isArray(back) ? back : [back]) : [];
  return (
    <>
      {crumbs.length > 0 && <BackLinks crumbs={crumbs} />}
      <Group justify="space-between" align="flex-start" mb="md" wrap="wrap" gap="sm">
        <Box style={{ minWidth: 0, flex: '1 1 18rem' }}>
          <Title order={2} fz={{ base: 'h3', sm: 'h2' }} style={{ overflowWrap: 'anywhere' }}>
            {title}
          </Title>
          {description && (
            <Text c="dimmed" size="sm" mt={4} component="div">
              {description}
            </Text>
          )}
        </Box>
        {actions && (
          <Group gap="xs" wrap="wrap">
            {actions}
          </Group>
        )}
      </Group>
    </>
  );
}

const NAV_PATHS = Object.fromEntries(NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.to]))) as Record<NavKey, string>;

function BackLinks({ crumbs }: { crumbs: Crumb[] }) {
  const { t } = useTranslation(['common', 'nav']);
  const links = crumbs.map((c) => (typeof c === 'string' ? { to: NAV_PATHS[c], label: t(`nav:items.${c}`) } : c));
  return (
    <nav aria-label={t('breadcrumb')} data-testid="breadcrumb">
      <Group gap={4} mb={4} wrap="wrap">
        {links.map((c, i) => (
          <Group key={c.to} gap={4} wrap="nowrap">
            {i > 0 && <IconChevronRight size={12} color="var(--mantine-color-dimmed)" aria-hidden />}
            <Anchor component={Link} to={c.to} size="sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              {i === 0 && <IconChevronLeft size={14} aria-hidden />}
              {c.label}
            </Anchor>
          </Group>
        ))}
      </Group>
    </nav>
  );
}

/**
 * What a list shows when it has no entries yet: an icon, a short title, one or two sentences of guidance
 * and – for users who may – the primary action. `compact` is for an empty section inside a card (no border).
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  compact,
  testId = 'empty-state',
}: {
  icon?: TablerIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  testId?: string;
}) {
  return (
    <Paper withBorder={!compact} p={compact ? 'sm' : 'xl'} mb={compact ? 0 : 'md'} data-testid={testId}>
      <Stack align="center" gap={6}>
        {Icon && <Icon size={compact ? 28 : 40} stroke={1.3} color="var(--mantine-color-dimmed)" aria-hidden />}
        <Text fw={600} ta="center">
          {title}
        </Text>
        {children && (
          <Text size="sm" c="dimmed" ta="center" maw={560} component="div">
            {children}
          </Text>
        )}
        {action && (
          <Group mt="xs" gap="xs" justify="center">
            {action}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

/** Placeholder rows while a list loads (instead of an empty page). */
export function LoadingState({ rows = 4 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <Stack gap="xs" aria-busy="true" aria-label={t('loading')} role="status" mb="md">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={36} radius="sm" />
      ))}
    </Stack>
  );
}

/** A list or page could not be loaded: the reason and a retry button. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert color="red" icon={<IconAlertTriangle size={18} />} title={t('loadFailed')} mb="md">
      <Text size="sm">{errorText(error)}</Text>
      {onRetry && (
        <Button size="xs" variant="light" color="red" mt="xs" leftSection={<IconRefresh size={14} />} onClick={onRetry}>
          {t('retry')}
        </Button>
      )}
    </Alert>
  );
}

/**
 * A detail page before its entry is there: a skeleton of breadcrumb, title and content while it loads;
 * the reason, _Try again_ and the way back when it could not be loaded.
 */
export function DetailState({ query, back }: { query: { isLoading: boolean; error: unknown; refetch: () => unknown }; back?: Crumb | Crumb[] }) {
  const { t } = useTranslation();
  const crumbs = back ? (Array.isArray(back) ? back : [back]) : [];
  if (query.error)
    return (
      <>
        {crumbs.length > 0 && <BackLinks crumbs={crumbs} />}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </>
    );
  return (
    <Stack gap="sm" aria-busy="true" aria-label={t('loading')} role="status" data-testid="detail-loading">
      <Skeleton height={14} width={120} radius="sm" />
      <Skeleton height={30} width="min(420px, 80%)" radius="sm" />
      <Skeleton height={14} width="min(560px, 95%)" radius="sm" mb="sm" />
      <Group gap="sm" grow wrap="wrap">
        <Skeleton height={72} radius="sm" miw={160} />
        <Skeleton height={72} radius="sm" miw={160} />
        <Skeleton height={72} radius="sm" miw={160} />
      </Group>
      <Skeleton height={220} radius="sm" />
    </Stack>
  );
}

/** Loading → skeleton, error → message with retry; otherwise nothing (the page renders its data). */
export function QueryState({ query, rows }: { query: { isLoading: boolean; error: unknown; refetch: () => unknown }; rows?: number }) {
  if (query.isLoading) return <LoadingState rows={rows} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return null;
}

/**
 * Opens a page's "create" dialog when the URL carries ?new=1 (links from the command palette and the
 * getting-started checklist). The parameter is removed again; `allowed` undefined means "not known yet".
 */
export function useCreateParam(allowed: boolean | undefined, open: () => void) {
  const [params, setParams] = useSearchParams();
  const wanted = params.get('new') === '1';
  useEffect(() => {
    if (!wanted || allowed === undefined) return;
    if (allowed) open();
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per ?new=1
  }, [wanted, allowed]);
}

/**
 * Inline validation of a dialog: the submit button stays enabled; on submit the fields that are
 * missing or wrong show their message (Mantine `error`) and the first one gets the focus.
 * `checks` maps a field to its problem (a text) or to nothing when it is fine.
 */
export function useFieldErrors<K extends string>(checks: Record<K, string | false | null | undefined>) {
  const [shown, setShown] = useState(false);
  const error = (k: K): string | undefined => (shown && checks[k]) || undefined;
  /** true when every field is fine; otherwise shows the messages. */
  const validate = (): boolean => {
    if (Object.values(checks).every((v) => !v)) return true;
    setShown(true);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
    return false;
  };
  return { error, validate };
}

export function JsonView({ value, maxHeight = 360 }: { value: unknown; maxHeight?: number }) {
  const { t } = useTranslation();
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <Box pos="relative">
      {/* focusable, so the content can be scrolled with the keyboard */}
      <ScrollArea.Autosize mah={maxHeight} viewportProps={{ tabIndex: 0 }}>
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
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  for (const l of lines) {
    const li = /^\s*[-*]\s+(.*)$/.exec(l);
    if (li) {
      if (!list) (out.push('<ul>'), (list = true));
      out.push(`<li>${inline(li[1]!)}</li>`);
      continue;
    }
    if (list) (out.push('</ul>'), (list = false));
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
