import { Fragment, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ActionIcon, Alert, Anchor, Badge, Group, Paper, Select, SimpleGrid, Stack, Switch, Table, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconArrowsLeftRight, IconChevronDown, IconChevronRight, IconLock } from '@tabler/icons-react';
import type { CompareRow, CompareStepSide, CompareValue, RunCompareSide, RunComparison, RunSummary } from '@sm/shared';
import { get } from '../api';
import { DetailState, EmptyState, StatusBadge, statusLabel } from '../components/common';
import { DetailHeader } from '../components/page/DetailPage';
import { fmtDate, fmtDuration, fmtRelative } from '../format';
import { runKeys } from '../queryKeys';
import { TableScroll } from '../components/TableScroll';

/** One value of the comparison: masked, secret (not compared), or the value. */
function Value({ v }: { v: CompareValue | undefined }) {
  const { t } = useTranslation('debug');
  if (!v)
    return (
      <Text size="xs" c="dimmed">
        –
      </Text>
    );
  if ('secret' in v)
    return (
      <Group gap={4} wrap="nowrap">
        <IconLock size={12} aria-hidden />
        <Text size="xs" c="dimmed">
          {t('compare.secret')}
        </Text>
      </Group>
    );
  if ('masked' in v)
    return (
      <Badge size="xs" variant="outline" color="gray">
        {t('compare.masked')}
      </Badge>
    );
  const text = typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
  return (
    <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
      {text.length > 300 ? `${text.slice(0, 300)}…` : text}
    </Text>
  );
}

/** A decision in words: approved or rejected (with the selection), an if's true/false, a loop's item count. */
function decisionText(d: unknown, t: TFunction<'debug'>): string {
  if (typeof d === 'boolean') return String(d);
  if (d && typeof d === 'object') {
    const o = d as { approved?: unknown; selectedKeys?: unknown; items?: unknown; simulated?: unknown };
    if (typeof o.items === 'number') return t('compare.items', { count: o.items });
    if (typeof o.approved === 'boolean') {
      const sel = Array.isArray(o.selectedKeys) && o.selectedKeys.length ? ` (${t('compare.selected', { count: o.selectedKeys.length })})` : '';
      return `${o.approved ? t('compare.approved') : t('compare.rejected')}${sel}${o.simulated ? ` · ${t('simulated')}` : ''}`;
    }
  }
  const text = JSON.stringify(d) ?? '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** What one run did at a step: status, decision, check, request, error. */
function Side({ s }: { s?: CompareStepSide }) {
  const { t } = useTranslation('debug');
  if (!s)
    return (
      <Text size="xs" c="dimmed" fs="italic">
        {t('compare.notReached')}
      </Text>
    );
  const decision = s.task?.decision ?? s.decision;
  return (
    <Stack gap={2}>
      <Group gap={4} wrap="wrap">
        <StatusBadge status={s.status} size="xs" />
        {typeof s.durationMs === 'number' && (
          <Text size="xs" c="dimmed">
            {fmtDuration(s.durationMs)}
          </Text>
        )}
      </Group>
      {s.request && (
        <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
          {[s.request.method, s.request.path, s.request.status !== undefined ? `→ ${s.request.status}` : ''].filter(Boolean).join(' ')}
          {s.request.attempts ? ` (${t('compare.attempts', { count: s.request.attempts })})` : ''}
        </Text>
      )}
      {decision !== undefined && decision !== null && (
        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
          {t('compare.decision')}: <span className="mono">{decisionText(decision, t)}</span>
          {s.task?.decidedBy ? ` · ${s.task.decidedBy}` : ''}
        </Text>
      )}
      {s.check && (
        <Text size="xs" c={s.check.passed ? undefined : 'red'} style={{ overflowWrap: 'anywhere' }}>
          {s.check.passed ? t('compare.passed') : t('compare.notPassed')}
          {s.check.message ? `: ${s.check.message}` : ''}
        </Text>
      )}
      {s.error ? (
        <Text size="xs" c="red" style={{ overflowWrap: 'anywhere' }}>
          {s.error}
        </Text>
      ) : (
        !s.check &&
        !s.request &&
        (decision === undefined || decision === null) &&
        s.summary && (
          <Text size="xs" c="dimmed" lineClamp={2} style={{ overflowWrap: 'anywhere' }}>
            {s.summary}
          </Text>
        )
      )}
    </Stack>
  );
}

function Differs({ row }: { row: CompareRow }) {
  const { t } = useTranslation('debug');
  if (!row.differs.length)
    return (
      <Text size="xs" c="dimmed">
        {t('compare.same')}
      </Text>
    );
  return (
    <Group gap={4} wrap="wrap">
      {row.node && (
        <Badge size="xs" color="grape" variant="light">
          {t(`compare.node.${row.node}`)}
        </Badge>
      )}
      {row.differs.map((d) => (
        <Badge key={d} size="xs" color={d === 'path' || d === 'status' || d === 'error' ? 'orange' : 'yellow'} variant="light">
          {t(`compare.differs.${d}`)}
        </Badge>
      ))}
    </Group>
  );
}

function VarsTable({ vars }: { vars: NonNullable<CompareRow['vars']> }) {
  const { t } = useTranslation('debug');
  return (
    <TableScroll>
      <Table fz="xs" withTableBorder verticalSpacing={4}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('compare.variable')}</Table.Th>
            <Table.Th>A</Table.Th>
            <Table.Th>B</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {Object.entries(vars).map(([name, v]) => (
            <Table.Tr key={name}>
              <Table.Td className="mono">{name}</Table.Td>
              <Table.Td>
                <Value v={v.a} />
              </Table.Td>
              <Table.Td>
                <Value v={v.b} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </TableScroll>
  );
}

function RunCard({ label, side, runs, onPick }: { label: string; side: RunCompareSide; runs: RunSummary[]; onPick: (id: string) => void }) {
  const { t } = useTranslation('debug');
  const options = runs.some((r) => r.id === side.id) ? runs : [{ id: side.id, startedAt: side.startedAt, status: side.status } as RunSummary, ...runs];
  return (
    <Paper withBorder p="sm">
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text fw={700}>{label}</Text>
        <StatusBadge status={side.outcome ?? side.status} />
      </Group>
      <Select
        mt="xs"
        size="xs"
        aria-label={t('compare.pick', { label })}
        data={options.map((r) => ({ value: r.id, label: `${fmtRelative(r.startedAt)} · ${statusLabel(r.outcome ?? r.status)} · ${r.id}` }))}
        value={side.id}
        onChange={(v) => v && onPick(v)}
        searchable
        allowDeselect={false}
      />
      <Stack gap={2} mt="xs">
        <Text size="xs">
          <Anchor component={Link} to={`/runs/${side.id}`} className="mono" size="xs">
            {side.id}
          </Anchor>
        </Text>
        <Text size="xs" c="dimmed">
          {t('compare.sideLine', {
            version: side.processVersion,
            mode: t(`compare.mode.${side.mode}`),
            date: fmtDate(side.startedAt),
            duration: side.durationMs === null ? '–' : fmtDuration(side.durationMs),
            actor: side.actor,
          })}
        </Text>
        {side.cut && (
          <Text size="xs" c="orange">
            {t('compare.cut')}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

/** Compare two runs of a process (ADR 0010): from the stored, redacted record only. */
export function RunComparePage() {
  const { t } = useTranslation('debug');
  const [params, setParams] = useSearchParams();
  const a = params.get('a');
  const b = params.get('b');
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const cmp = useQuery({
    queryKey: runKeys.compare(a, b),
    queryFn: () => get<RunComparison>(`/runs/compare?a=${encodeURIComponent(a!)}&b=${encodeURIComponent(b!)}`),
    enabled: !!a && !!b,
    retry: false,
  });
  // a single run given: compare it with the last good run, or pick the other one
  const single = a && !b ? a : null;
  const base = useQuery({ queryKey: runKeys.detail(single), queryFn: () => get<RunSummary>(`/runs/${single}`), enabled: !!single });
  const processId = cmp.data?.processId ?? base.data?.processId;
  const runs = useQuery({
    queryKey: [...runKeys.latest(processId), 'compare'],
    queryFn: () => get<RunSummary[]>(`/runs?processId=${encodeURIComponent(processId!)}&limit=50`),
    enabled: !!processId,
  });
  const pick = (which: 'a' | 'b', id: string) => {
    const next = new URLSearchParams(params);
    next.set(which, id);
    setParams(next, { replace: true });
  };
  const back = 'runs' as const;

  if (!a || (!b && !base.data)) {
    if (single && (base.isLoading || base.error)) return <DetailState query={base} back={back} />;
    return (
      <>
        <DetailHeader back={back} title={t('compare.title')} />
        <EmptyState icon={IconArrowsLeftRight} title={t('compare.emptyTitle')}>
          {t('compare.emptyText')}
        </EmptyState>
      </>
    );
  }
  if (!b) {
    return (
      <>
        <DetailHeader back={back} title={t('compare.title')} description={base.data?.processName} />
        <Paper withBorder p="sm" maw={560}>
          <Select
            label={t('compare.pickOther')}
            data={(runs.data ?? [])
              .filter((r) => r.id !== a)
              .map((r) => ({ value: r.id, label: `${fmtRelative(r.startedAt)} · ${statusLabel(r.outcome ?? r.status)} · ${r.id}` }))}
            onChange={(v) => v && pick('b', v)}
            searchable
          />
        </Paper>
      </>
    );
  }
  const c = cmp.data;
  if (!c) return <DetailState query={cmp} back={back} />;

  const rows = onlyDiff ? c.rows.filter((r) => r.differs.length) : c.rows;
  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const swap = () => setParams(new URLSearchParams({ a: b, b: a }), { replace: true });
  const inputs = Object.entries(c.inputs);
  const nodeCell = (r: CompareRow): ReactNode => (
    <UnstyledButton onClick={() => r.vars && toggle(r.key)} aria-expanded={r.vars ? open.has(r.key) : undefined} disabled={!r.vars} style={{ minWidth: 0 }}>
      <Group gap={4} wrap="nowrap" align="flex-start">
        {r.vars ? open.has(r.key) ? <IconChevronDown size={14} /> : <IconChevronRight size={14} /> : <span style={{ width: 14 }} />}
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
            {r.nodeName}
          </Text>
          <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
            {r.key} · {r.type}
          </Text>
        </Stack>
      </Group>
    </UnstyledButton>
  );

  return (
    <>
      <DetailHeader
        back={back}
        title={t('compare.title')}
        description={
          <Anchor component={Link} to={`/processes/${c.processId}`} size="sm">
            {c.processName}
          </Anchor>
        }
        actions={
          <Tooltip label={t('compare.swap')}>
            <ActionIcon variant="default" size="input-xs" onClick={swap} aria-label={t('compare.swap')}>
              <IconArrowsLeftRight size={16} />
            </ActionIcon>
          </Tooltip>
        }
      />
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <RunCard label="A" side={c.a} runs={runs.data ?? []} onPick={(id) => pick('a', id)} />
          <RunCard label="B" side={c.b} runs={runs.data ?? []} onPick={(id) => pick('b', id)} />
        </SimpleGrid>

        <Group gap="xs" wrap="wrap" data-testid="compare-summary">
          <Badge variant="light" color="gray">
            {t('compare.summary.steps', { count: c.summary.steps })}
          </Badge>
          <Badge variant="light" color={c.summary.differing ? 'orange' : 'green'}>
            {t('compare.summary.differing', { count: c.summary.differing })}
          </Badge>
          {c.summary.onlyA > 0 && (
            <Badge variant="light" color="orange">
              {t('compare.summary.onlyA', { count: c.summary.onlyA })}
            </Badge>
          )}
          {c.summary.onlyB > 0 && (
            <Badge variant="light" color="orange">
              {t('compare.summary.onlyB', { count: c.summary.onlyB })}
            </Badge>
          )}
          <Switch
            ml={phone ? undefined : 'auto'}
            size="sm"
            label={t('compare.onlyDiff')}
            checked={onlyDiff}
            onChange={(e) => setOnlyDiff(e.currentTarget.checked)}
          />
        </Group>
        <Text size="xs" c="dimmed">
          {t('compare.hint')}
        </Text>

        {inputs.length > 0 && (
          <Paper withBorder p="sm">
            <Text fw={600} size="sm" mb="xs">
              {t('compare.inputs')}
            </Text>
            <TableScroll>
              <Table fz="xs" verticalSpacing={4}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('compare.input')}</Table.Th>
                    <Table.Th>A</Table.Th>
                    <Table.Th>B</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {inputs.map(([name, v]) => (
                    <Table.Tr key={name} style={v.same === false ? { boxShadow: 'inset 3px 0 0 var(--mantine-color-yellow-filled)' } : undefined}>
                      <Table.Td className="mono">{name}</Table.Td>
                      <Table.Td>
                        <Value v={v.a} />
                      </Table.Td>
                      <Table.Td>
                        <Value v={v.b} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </TableScroll>
          </Paper>
        )}

        {rows.length === 0 && (
          <Alert color="green" variant="light" data-testid="compare-no-differences">
            {t('compare.noDifferences')}
          </Alert>
        )}
        {rows.length > 0 && phone && (
          <Stack gap="xs" data-testid="compare-cards">
            {rows.map((r) => (
              <Paper key={r.key} withBorder p="xs">
                {nodeCell(r)}
                <SimpleGrid cols={2} spacing="xs" mt={6}>
                  <Stack gap={2}>
                    <Text size="xs" fw={700}>
                      A
                    </Text>
                    <Side s={r.a} />
                  </Stack>
                  <Stack gap={2}>
                    <Text size="xs" fw={700}>
                      B
                    </Text>
                    <Side s={r.b} />
                  </Stack>
                </SimpleGrid>
                <Group mt={6}>
                  <Differs row={r} />
                </Group>
                {r.vars && open.has(r.key) && (
                  <Stack mt={6}>
                    <VarsTable vars={r.vars} />
                  </Stack>
                )}
              </Paper>
            ))}
          </Stack>
        )}
        {rows.length > 0 && !phone && (
          <TableScroll>
            <Table withTableBorder fz="sm" verticalSpacing={6} data-testid="compare-table">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('compare.step')}</Table.Th>
                  <Table.Th>A</Table.Th>
                  <Table.Th>B</Table.Th>
                  <Table.Th>{t('compare.differences')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
                  <Fragment key={r.key}>
                    <Table.Tr style={r.presence !== 'both' ? { boxShadow: 'inset 3px 0 0 var(--mantine-color-orange-filled)' } : undefined}>
                      <Table.Td style={{ maxWidth: 260 }}>{nodeCell(r)}</Table.Td>
                      <Table.Td style={{ maxWidth: 320 }}>
                        <Side s={r.a} />
                      </Table.Td>
                      <Table.Td style={{ maxWidth: 320 }}>
                        <Side s={r.b} />
                      </Table.Td>
                      <Table.Td>
                        <Differs row={r} />
                      </Table.Td>
                    </Table.Tr>
                    {r.vars && open.has(r.key) && (
                      <Table.Tr>
                        <Table.Td colSpan={4}>
                          <Text size="xs" fw={600} mb={4}>
                            {t('compare.varsBefore')}
                          </Text>
                          <VarsTable vars={r.vars} />
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                ))}
              </Table.Tbody>
            </Table>
          </TableScroll>
        )}
      </Stack>
    </>
  );
}
