import { useMemo, useState } from 'react';
import YAML from 'yaml';
import { structuredPatch } from 'diff';
import { Alert, Badge, Box, Center, Group, Loader, Paper, Select, SimpleGrid, Stack, Switch, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { FlowNode, ProcessDefinition, ProcessVersion } from '@sm/shared';
import { useProcessVersion } from './editorApi';

type Def = ProcessDefinition;

export const WORKING = 'working';

const toYaml = (d: Def) => YAML.stringify(JSON.parse(JSON.stringify(d)), { lineWidth: 0 });
const nodeName = (n: FlowNode) => (n.name && n.name !== n.id ? `${n.id} (${n.name})` : n.id);
const strip = ({ x: _x, y: _y, ...rest }: FlowNode) => JSON.stringify(rest);

export interface DiffSummary {
  added: FlowNode[];
  removed: FlowNode[];
  changed: FlowNode[];
  moved: FlowNode[];
  wiresAdded: number;
  wiresRemoved: number;
  settings: string[];
}

export function summarize(a: Def, b: Def): DiffSummary {
  const ia = new Map(a.nodes.map((n) => [n.id, n]));
  const ib = new Map(b.nodes.map((n) => [n.id, n]));
  const added = b.nodes.filter((n) => !ia.has(n.id));
  const removed = a.nodes.filter((n) => !ib.has(n.id));
  const changed: FlowNode[] = [];
  const moved: FlowNode[] = [];
  for (const n of b.nodes) {
    const o = ia.get(n.id);
    if (!o) continue;
    if (strip(o) !== strip(n)) changed.push(n);
    else if (o.x !== n.x || o.y !== n.y) moved.push(n);
  }
  const wk = (d: Def) => new Set(d.wires.map((w) => `${w.from}|${w.port}|${w.to}`));
  const wa = wk(a);
  const wb = wk(b);
  const settings: string[] = [];
  for (const k of ['name', 'description', 'tags', 'inputs', 'connections', 'constants', 'outputs'] as const) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) settings.push(k);
  }
  return {
    added,
    removed,
    changed,
    moved,
    wiresAdded: [...wb].filter((w) => !wa.has(w)).length,
    wiresRemoved: [...wa].filter((w) => !wb.has(w)).length,
    settings,
  };
}

type Change = 'added' | 'removed' | 'changed';

function SummaryView({ s }: { s: DiffSummary }) {
  const { t } = useTranslation('editor');
  const nothing = !s.added.length && !s.removed.length && !s.changed.length && !s.moved.length && !s.wiresAdded && !s.wiresRemoved && !s.settings.length;
  if (nothing) return <Text size="sm">{t('diff.none')}</Text>;
  const line = (sign: string, color: string, n: FlowNode, what: Change) => (
    <Text key={`${sign}${n.id}`} size="xs" className="mono" c={color}>
      {sign} {nodeName(n)}
      <Text span size="xs" c="dimmed">
        {' '}
        · {n.type} {t(`diff.node.${what}`)}
      </Text>
    </Text>
  );
  return (
    <Stack gap={4}>
      <Group gap={6}>
        {s.added.length > 0 && (
          <Badge color="green" variant="light">
            {t('diff.added', { count: s.added.length })}
          </Badge>
        )}
        {s.removed.length > 0 && (
          <Badge color="red" variant="light">
            {t('diff.removed', { count: s.removed.length })}
          </Badge>
        )}
        {s.changed.length > 0 && (
          <Badge color="orange" variant="light">
            {t('diff.changed', { count: s.changed.length })}
          </Badge>
        )}
        {s.moved.length > 0 && (
          <Badge color="gray" variant="light">
            {t('diff.moved', { count: s.moved.length })}
          </Badge>
        )}
        {(s.wiresAdded > 0 || s.wiresRemoved > 0) && (
          <Badge color="blue" variant="light">
            {t('diff.wires', { added: s.wiresAdded, removed: s.wiresRemoved })}
          </Badge>
        )}
        {s.settings.length > 0 && (
          <Badge color="grape" variant="light">
            {t('diff.settings', { list: s.settings.join(', ') })}
          </Badge>
        )}
      </Group>
      {s.added.map((n) => line('+', 'green', n, 'added'))}
      {s.removed.map((n) => line('−', 'red', n, 'removed'))}
      {s.changed.map((n) => line('~', 'orange', n, 'changed'))}
    </Stack>
  );
}

const ROW_BG: Record<string, string | undefined> = {
  '+': 'var(--mantine-color-green-light)',
  '-': 'var(--mantine-color-red-light)',
  '@': 'var(--mantine-color-blue-light)',
};

function UnifiedDiff({ oldText, newText, oldName, newName, context }: { oldText: string; newText: string; oldName: string; newName: string; context: number }) {
  const patch = useMemo(() => structuredPatch(oldName, newName, oldText, newText, '', '', { context }), [oldText, newText, oldName, newName, context]);
  if (!patch.hunks.length) return null;
  const rows: { kind: string; a?: number; b?: number; text: string }[] = [];
  for (const h of patch.hunks) {
    rows.push({ kind: '@', text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    let a = h.oldStart;
    let b = h.newStart;
    for (const l of h.lines) {
      const sign = l[0];
      const text = l.slice(1);
      if (sign === '\\') continue;
      if (sign === '+') rows.push({ kind: '+', b: b++, text });
      else if (sign === '-') rows.push({ kind: '-', a: a++, text });
      else rows.push({ kind: ' ', a: a++, b: b++, text });
    }
  }
  const num = { width: 38, flexShrink: 0, textAlign: 'right' as const, paddingRight: 6, color: 'var(--mantine-color-dimmed)', userSelect: 'none' as const };
  return (
    <Box
      data-testid="version-diff"
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 6,
        overflow: 'auto',
        maxHeight: '60vh',
        fontFamily: 'var(--mantine-font-family-monospace)',
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <Box style={{ width: 'max-content', minWidth: '100%' }}>
        <Box px={6} style={{ color: 'var(--mantine-color-dimmed)', borderBottom: '1px solid var(--mantine-color-default-border)' }}>
          --- {oldName} · +++ {newName}
        </Box>
        {rows.map((r, i) => (
          <Box key={i} style={{ display: 'flex', background: ROW_BG[r.kind] }}>
            {r.kind === '@' ? (
              <Box px={6} style={{ color: 'var(--mantine-color-blue-text)', whiteSpace: 'pre' }}>
                {r.text}
              </Box>
            ) : (
              <>
                <span style={num}>{r.a ?? ''}</span>
                <span style={num}>{r.b ?? ''}</span>
                <span
                  style={{
                    width: 14,
                    flexShrink: 0,
                    userSelect: 'none',
                    color: r.kind === '+' ? 'var(--mantine-color-green-text)' : r.kind === '-' ? 'var(--mantine-color-red-text)' : undefined,
                  }}
                >
                  {r.kind === ' ' ? '' : r.kind === '-' ? '−' : '+'}
                </span>
                <span style={{ whiteSpace: 'pre', paddingRight: 8 }}>{r.text}</span>
              </>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

const parseSel = (v: string | null) => (v && v !== WORKING ? Number(v) : undefined);

/** Compare two versions (or a version and the unsaved working copy). */
export function VersionCompare({
  processId,
  versions,
  currentVersion,
  workingCopy,
}: {
  processId: string;
  versions: ProcessVersion[];
  currentVersion: number;
  workingCopy?: Def;
}) {
  const { t } = useTranslation('editor');
  const sorted = [...versions].sort((x, y) => y.version - x.version);
  const prev = sorted.find((v) => v.version < currentVersion)?.version;
  const [from, setFrom] = useState<string | null>(workingCopy ? String(currentVersion) : prev ? String(prev) : null);
  const [to, setTo] = useState<string | null>(workingCopy ? WORKING : String(currentVersion));
  const [context, setContext] = useState(true);
  const fa = useProcessVersion(from && from !== WORKING ? processId : undefined, parseSel(from));
  const fb = useProcessVersion(to && to !== WORKING ? processId : undefined, parseSel(to));
  const options = [
    ...(workingCopy ? [{ value: WORKING, label: t('diff.workingCopyUnsaved') }] : []),
    ...sorted.map((v) => ({
      value: String(v.version),
      label: `${v.version === currentVersion ? t('versions.current', { version: v.version }) : `v${v.version}`}${v.comment ? ` – ${v.comment}` : ''}`,
    })),
  ];
  const defA = from === WORKING ? workingCopy : fa.data?.definition;
  const defB = to === WORKING ? workingCopy : fb.data?.definition;
  const label = (v: string | null) => (v === WORKING ? t('diff.workingCopy') : `v${v}`);
  const loading = (from !== WORKING && fa.isLoading) || (to !== WORKING && fb.isLoading);
  const error = (fa.error ?? fb.error) as Error | null;
  const texts = useMemo(() => (defA && defB ? { a: toYaml(defA), b: toYaml(defB), s: summarize(defA, defB) } : null), [defA, defB]);

  if (options.length < 2) {
    return (
      <Text size="sm" c="dimmed">
        {t('diff.onlyOne')}
      </Text>
    );
  }
  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
        <Select size="xs" label={t('diff.from')} data={options} value={from} onChange={setFrom} allowDeselect={false} />
        <Select size="xs" label={t('diff.to')} data={options} value={to} onChange={setTo} allowDeselect={false} />
      </SimpleGrid>
      {error && <Alert color="red">{t('diff.loadFailed', { error: error.message })}</Alert>}
      {loading && (
        <Center py="sm">
          <Loader size="sm" />
        </Center>
      )}
      {texts && !loading && (
        <>
          <Paper withBorder p="xs">
            <SummaryView s={texts.s} />
          </Paper>
          {texts.a !== texts.b && (
            <>
              <Switch size="xs" label={t('diff.contextOnly')} checked={context} onChange={(e) => setContext(e.currentTarget.checked)} />
              <UnifiedDiff oldText={texts.a} newText={texts.b} oldName={label(from)} newName={label(to)} context={context ? 3 : 100000} />
            </>
          )}
        </>
      )}
    </Stack>
  );
}
