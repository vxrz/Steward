import { useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconCalendarDue,
  IconCashRegister,
  IconCoin,
  IconCopy,
  IconDownload,
  IconEyeOff,
  IconFileImport,
  IconPencil,
  IconPlus,
  IconReceipt,
  IconTrash,
} from '@tabler/icons-react';
import {
  COST_PLAN_CADENCES,
  COST_PLAN_CATEGORIES,
  COST_PLAN_LIMITS,
  ISO_4217_CODES,
  lastDayOf,
  type CostEntry,
  type CostPlanCadence,
  type CostPlanCategory,
  type CostPlanCurrency,
  type CostPlanLine,
  type CostPlanTarget,
  type CostPlanTargetKind,
  type CostPlanYear,
  type Platform,
} from '@sm/shared';
import { apiUrl, del, get, notifyError, notifyOk, post, put } from '../../api';
import { EmptyState, QueryState, useFieldErrors } from '../common';
import { DataTable, type DataColumn } from '../DataTable';
import { confirmDanger, confirmDialog } from '../confirm';
import { compact, niceTicks } from '../dashboard/format';
import { costKeys, platformKeys } from '../../queryKeys';
import { fmtDay, listFormat, localToday } from '../../format';
import { fmtMonth, fmtMonthOnly, fmtMoney, SCOPE_PATH, tooManyDecimals } from './common';
import '../dashboard/viz.css';
import { SupplierPicker, SupplierText, useSupplierChoice, useSupplierOptions } from '../suppliers/SupplierPicker';
import { ScheduleBadge } from './ContractPayments';
import { ChangesPanel, PrepaidRows, ProposalsPanel } from './ContractLines';
import { ServiceContracts } from './Commitments';
import { EntryImportDialog, EntryImports } from './EntryImport';
import { FormModal, FormModalCancel } from '../FormModal';

/**
 * The cost plan of a service (0.16.0, ADR 0026, docs/COSTS.md#planning-per-service): per fiscal year the plan lines,
 * the cost entries and what was read from the cloud and platform costs; planned, to date, incurred, expected and the
 * difference per currency, a month chart with its table twin, the lines by category or by application and system,
 * renewals in the next 90 days and unplanned entries. Who may change the service changes the plan.
 */
export function ServiceCostPlan({ serviceId }: { serviceId: string }) {
  const { t } = useTranslation(['costs', 'common']);
  const qc = useQueryClient();
  const [year, setYear] = useState<number | null>(null);
  const [group, setGroup] = useState<'category' | 'target'>('category');
  const [lineDialog, setLineDialog] = useState<CostPlanLine | 'new' | null>(null);
  const [entryDialog, setEntryDialog] = useState<CostEntry | 'new' | null>(null);
  const [bookDialog, setBookDialog] = useState<CostPlanLine | null>(null);
  const [importing, setImporting] = useState(false);
  const q = useQuery({
    queryKey: costKeys.plan(serviceId, year),
    queryFn: () => get<CostPlanYear>(`/costs/plans/${encodeURIComponent(serviceId)}${year ? `?fiscalYear=${year}` : ''}`),
  });
  const d = q.data;
  /** Shows the year an answer is about (a change answers with the year view of its year). */
  const show = (y: CostPlanYear) => {
    qc.setQueryData(costKeys.plan(serviceId, y.fiscalYear), y);
    if (y.fiscalYear !== d?.fiscalYear || year !== null) setYear(y.fiscalYear);
    else qc.setQueryData(costKeys.plan(serviceId, null), y);
    void qc.invalidateQueries({ queryKey: costKeys.planOf(serviceId) });
  };
  if (!d) return <QueryState query={q} />;
  const nextLabel = d.years.find((y) => y.fiscalYear === d.fiscalYear + 1)?.label ?? String(d.fiscalYear + 1);
  const copy = async () => {
    if (
      !(await confirmDialog({
        action: 'confirm',
        title: t('plan.copy.title'),
        message: t('plan.copy.message', { from: d.label, to: nextLabel }),
        confirmLabel: t('plan.copy.button', { to: nextLabel }),
        danger: false,
      }))
    )
      return;
    try {
      const y = await post<CostPlanYear>(`/costs/plans/${encodeURIComponent(serviceId)}/copy`, { fiscalYear: d.fiscalYear });
      show(y);
      const r = y.copyResult;
      notifyOk(
        r
          ? t('plan.copy.result', {
              to: nextLabel,
              copied: r.copied.length + r.shortened.length,
              proposed: r.proposed.length,
              shortened: r.shortened.length,
              leftOut: r.leftOut.length,
            })
          : t('plan.copy.done', { to: nextLabel }),
      );
    } catch (e) {
      notifyError(e, t('plan.copy.failed'));
    }
  };
  const removeLine = async (l: CostPlanLine) => {
    const message = l.entries ? t('plan.line.removeWithEntries', { title: l.title, count: l.entries }) : t('plan.line.removeConfirm', { title: l.title });
    if (!(await confirmDanger({ action: 'remove', message }))) return;
    try {
      show(await del<CostPlanYear>(`/costs/plans/${encodeURIComponent(serviceId)}/lines/${encodeURIComponent(l.id)}`));
      notifyOk(t('plan.line.removed'));
    } catch (e) {
      notifyError(e);
    }
  };
  const removeEntry = async (e: CostEntry) => {
    if (!(await confirmDanger({ action: 'remove', message: t('plan.entry.removeConfirm', { date: fmtDay(e.date) }) }))) return;
    try {
      show(await del<CostPlanYear>(`/costs/plans/${encodeURIComponent(serviceId)}/entries/${encodeURIComponent(e.id)}`));
      notifyOk(t('plan.entry.removed'));
    } catch (err) {
      notifyError(err);
    }
  };
  const exportUrl = (what: 'plan' | 'entries') => apiUrl(`/costs/plans/${encodeURIComponent(serviceId)}/export?fiscalYear=${d.fiscalYear}&what=${what}`);
  const unplanned = d.entries.filter((e) => e.unplanned);
  return (
    <Stack gap="lg" data-testid="service-cost-plan">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <div style={{ minWidth: 0 }}>
          <Title order={2} size="h4">
            {t('plan.title')}
          </Title>
          <Text size="xs" c="dimmed" maw={720}>
            {t('plan.help')}
          </Text>
        </div>
        <Select
          label={t('plan.year')}
          w={170}
          allowDeselect={false}
          data={d.years.map((y) => ({ value: String(y.fiscalYear), label: y.label }))}
          value={String(d.fiscalYear)}
          onChange={(v) => v && setYear(Number(v))}
          data-testid="plan-year"
        />
      </Group>
      <Group gap="xs" wrap="wrap">
        {d.canEdit && (
          <>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setLineDialog('new')} data-testid="plan-add-line">
              {t('plan.line.add')}
            </Button>
            <Button size="xs" variant="default" leftSection={<IconReceipt size={14} />} onClick={() => setEntryDialog('new')} data-testid="plan-add-entry">
              {t('plan.entry.add')}
            </Button>
            <Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} onClick={() => setImporting(true)} data-testid="plan-import-entries">
              {t('entryImport.button')}
            </Button>
            {d.lines.length > 0 && (
              <Button size="xs" variant="default" leftSection={<IconCopy size={14} />} onClick={copy} data-testid="plan-copy">
                {t('plan.copy.button', { to: nextLabel })}
              </Button>
            )}
          </>
        )}
        <Menu position="bottom-start">
          <Menu.Target>
            <Button size="xs" variant="subtle" leftSection={<IconDownload size={14} />}>
              {t('plan.export')}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item component="a" href={exportUrl('plan')}>
              {t('plan.exportPlan')}
            </Menu.Item>
            <Menu.Item component="a" href={exportUrl('entries')}>
              {t('plan.exportEntries')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Tooltip label={t('plan.costsReadHint')} withArrow events={{ hover: true, focus: true, touch: true }}>
          <Button
            size="xs"
            variant="subtle"
            component={Link}
            to={SCOPE_PATH('service', serviceId)}
            leftSection={<IconCoin size={14} />}
            data-testid="plan-costs-read"
          >
            {t('plan.costsRead')}
          </Button>
        </Tooltip>
      </Group>
      <Text size="xs" c="dimmed">
        {t('plan.yearRange', { label: d.label, from: fmtDay(d.from), to: fmtDay(d.to) })}
      </Text>
      {!d.amountsVisible && (
        <Alert icon={<IconEyeOff size={16} />} color="gray" variant="light">
          {t('plan.amountsHidden')}
        </Alert>
      )}
      {d.cloud === 'hidden' && (
        <Alert icon={<IconEyeOff size={16} />} color="gray" variant="light" data-testid="plan-cloud-hidden">
          {t('plan.cloudHidden')}
        </Alert>
      )}
      {d.renewals.length > 0 && (
        <Alert icon={<IconCalendarDue size={16} />} color="blue" variant="light" title={t('plan.renewals.title')} data-testid="plan-renewals">
          <Stack gap={2}>
            {d.renewals.map((r) => (
              <Text key={r.lineId} size="sm">
                {t('plan.renewals.line', { title: r.title, date: fmtDay(r.renewalDate), count: r.days })}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      {d.canEdit && d.proposals > 0 && <ProposalsPanel d={d} onSaved={show} />}
      <ChangesPanel d={d} onSaved={show} />
      <PrepaidRows d={d} />
      {!d.lines.length && !d.entries.length && !d.currencies.length ? (
        <EmptyState icon={IconReceipt} title={t('plan.empty.title', { label: d.label })} whoCanAct={t('plan.empty.who')}>
          {t('plan.empty.body')}
        </EmptyState>
      ) : (
        d.currencies.map((c) => <PlanCurrency key={c.currency} c={c} d={d} />)
      )}
      {d.lines.length > 0 && (
        <Stack gap="sm">
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Title order={3} size="h5">
              {t('plan.lines.title')}
            </Title>
            <SegmentedControl
              size="xs"
              aria-label={t('plan.groupBy')}
              value={group}
              onChange={(v) => setGroup(v as 'category' | 'target')}
              data={[
                { value: 'category', label: t('plan.groups.category') },
                { value: 'target', label: t('plan.groups.target') },
              ]}
              data-testid="plan-group"
            />
          </Group>
          <LineGroups d={d} group={group} onEdit={(l) => setLineDialog(l)} onRemove={removeLine} onBook={(l) => setBookDialog(l)} />
        </Stack>
      )}
      <ServiceContracts serviceId={d.serviceId} canEdit={d.canEdit} />
      {(d.lines.length > 0 || d.entries.length > 0) && (
        <EntriesSection d={d} onEdit={(e) => setEntryDialog(e)} onRemove={removeEntry} unplanned={unplanned.length} />
      )}
      {lineDialog && <LineDialog d={d} line={lineDialog === 'new' ? null : lineDialog} onClose={() => setLineDialog(null)} onSaved={show} />}
      {entryDialog && <EntryDialog d={d} entry={entryDialog === 'new' ? null : entryDialog} onClose={() => setEntryDialog(null)} onSaved={show} />}
      {bookDialog && <BookDialog d={d} line={bookDialog} onClose={() => setBookDialog(null)} onSaved={show} />}
      <EntryImports serviceId={serviceId} onChanged={() => void qc.invalidateQueries({ queryKey: costKeys.planOf(serviceId) })} />
      {importing && <EntryImportDialog d={d} onClose={() => setImporting(false)} onSaved={show} />}
    </Stack>
  );
}

// ---------- figures ----------

/** A signed amount: over the plan with "+" and a quiet orange, under it plain; what it means is also read out. */
export function Difference({ v, currency }: { v: string | null; currency: string }) {
  const { t } = useTranslation('costs');
  if (v === null)
    return (
      <Text span size="sm" c="dimmed">
        –
      </Text>
    );
  const n = Number(v);
  const over = n > 0.004;
  const meaning = over ? t('plan.over') : n < -0.004 ? t('plan.under') : t('plan.onPlan');
  return (
    <Tooltip label={meaning} withArrow events={{ hover: true, focus: false, touch: true }}>
      <Text span size="sm" className="viz-num" c={over ? 'orange' : undefined} fw={over ? 600 : undefined} data-testid="plan-difference">
        {over ? '+' : ''}
        {fmtMoney(v, currency)}
        <VisuallyHidden> ({meaning})</VisuallyHidden>
      </Text>
    </Tooltip>
  );
}

function Stat({ label, value, extra, testId }: { label: string; value: ReactNode; extra?: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600} className="viz-num" component="div" style={{ overflowWrap: 'anywhere' }}>
        {value}
      </Text>
      {extra}
    </div>
  );
}

function PlanCurrency({ c, d }: { c: CostPlanCurrency; d: CostPlanYear }) {
  const { t } = useTranslation('costs');
  const [table, setTable] = useState(false);
  return (
    <Paper withBorder p="md" data-testid={`plan-currency-${c.currency}`}>
      <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
        <Title order={3} size="h5">
          {t('plan.currencyTitle', { currency: c.currency, label: d.label })}
        </Title>
        <Button size="compact-xs" variant="subtle" onClick={() => setTable((v) => !v)} aria-pressed={table}>
          {table ? t('chart.showChart') : t('chart.showTable')}
        </Button>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 5 }} mb="md" spacing="sm">
        <Stat label={t('plan.columns.planned')} value={fmtMoney(c.planned, c.currency)} testId="plan-total-planned" />
        <Stat label={t('plan.columns.plannedToDate')} value={fmtMoney(c.plannedToDate, c.currency)} />
        <Stat label={t('plan.columns.incurredToDate')} value={fmtMoney(c.incurredToDate, c.currency)} testId="plan-total-incurred" />
        <Stat label={t('plan.columns.expected')} value={fmtMoney(c.expected, c.currency)} testId="plan-total-expected" />
        <Stat label={t('plan.columns.difference')} value={<Difference v={c.difference} currency={c.currency} />} />
      </SimpleGrid>
      {table ? <PlanMonthsTable c={c} d={d} /> : <PlanChart c={c} d={d} />}
      {(c.read || c.unplanned.count > 0) && (
        <Stack gap={4} mt="sm">
          {c.read && (
            <Text size="sm" data-testid="plan-read">
              {t('plan.readLine', { soFar: fmtMoney(c.read.incurredToDate, c.currency), expected: fmtMoney(c.read.expected, c.currency) })}{' '}
              <Anchor component={Link} to={SCOPE_PATH('service', d.serviceId)} size="sm" data-testid="plan-read-link">
                {t('plan.costsRead')}
              </Anchor>
            </Text>
          )}
          {c.unplanned.count > 0 && (
            <Text size="sm" data-testid="plan-unplanned-total">
              {t('plan.unplannedLine', {
                count: c.unplanned.count,
                soFar: fmtMoney(c.unplanned.incurredToDate, c.currency),
                all: fmtMoney(c.unplanned.expected, c.currency),
              })}
            </Text>
          )}
        </Stack>
      )}
    </Paper>
  );
}

/**
 * Planned and incurred per month of the fiscal year as pairs of bars: planned in the first series colour, incurred in
 * the second, with a legend; months to come have no incurred bar. Hover or the arrow keys show a month; the table twin
 * lists every month.
 */
function PlanChart({ c, d, height = 220 }: { c: CostPlanCurrency; d: CostPlanYear; height?: number }) {
  const { t } = useTranslation('costs');
  const { ref, width } = useElementSize();
  const [hover, setHover] = useState<number | null>(null);
  const months = c.months;
  const num = (v: string | null) => (v === null ? null : Number(v));
  const planned = months.map((x) => num(x.planned));
  const incurred = months.map((x) => num(x.incurred));
  const max = Math.max(0, ...planned.map((v) => v ?? 0), ...incurred.map((v) => v ?? 0));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]! || 1;
  const labelW = Math.max(...ticks.map((x) => compact(x).length)) * 7 + 10;
  const m = { l: labelW, r: 8, t: 10, b: 24 };
  const w = Math.max(width, 220);
  const plotW = w - m.l - m.r;
  const plotH = height - m.t - m.b;
  const slot = plotW / 12;
  const barW = Math.max(3, Math.min(18, (slot - 6) / 2));
  const x0 = (i: number) => m.l + i * slot + (slot - 2 * barW - 2) / 2;
  const y = (v: number) => m.t + plotH - (v / top) * plotH;
  const every = slot < 34 ? 3 : slot < 52 ? 2 : 1;
  const bar = (x: number, v: number) => {
    const h = Math.max(0, y(0) - y(v));
    const r = Math.min(4, barW / 2, h);
    const y0 = y(v);
    return `M${x},${y(0)}V${y0 + r}Q${x},${y0} ${x + r},${y0}H${x + barW - r}Q${x + barW},${y0} ${x + barW},${y0 + r}V${y(0)}Z`;
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? 12) - 1));
    else if (e.key === 'ArrowRight') setHover((h) => Math.min(11, (h ?? -1) + 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };
  if (!d.amountsVisible) return null;
  return (
    <div className="viz-root">
      <div ref={ref} style={{ position: 'relative', width: '100%' }}>
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={t('plan.chart.label', { currency: c.currency, label: d.label })}
          tabIndex={0}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          style={{ display: 'block', touchAction: 'pan-y' }}
          data-testid="plan-chart"
        >
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={m.l} x2={w - m.r} y1={y(tk)} y2={y(tk)} stroke={tk === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
              <text x={m.l - 6} y={y(tk)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--viz-muted)" className="viz-num">
                {compact(tk)}
              </text>
            </g>
          ))}
          {months.map((mo, i) => {
            const p = planned[i] ?? 0;
            const inc = incurred[i] ?? null;
            const dim = hover !== null && hover !== i ? 0.55 : 1;
            return (
              <g key={mo.month} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
                <rect x={m.l + i * slot} y={m.t} width={slot} height={plotH} fill="transparent" />
                {i === d.currentIndex && <rect x={m.l + i * slot} y={m.t} width={slot} height={plotH} fill="var(--viz-grid)" opacity={0.35} />}
                {p > 0 && <path d={bar(x0(i), p)} fill="var(--viz-series-1)" opacity={dim} />}
                {inc !== null && inc > 0 && <path d={bar(x0(i) + barW + 2, inc)} fill="var(--viz-series-2)" opacity={dim} />}
                {i % every === 0 && (
                  <text x={m.l + i * slot + slot / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--viz-muted)">
                    {fmtMonthOnly(mo.month)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="viz-tooltip" style={{ top: 4, ...(x0(hover) > w * 0.6 ? { right: w - x0(hover) + 6 } : { left: x0(hover) + 2 * barW + 8 }) }}>
            <div className="viz-tt-label">{fmtMonth(months[hover]!.month, 'long')}</div>
            <div className="viz-tt-label">{t('plan.chart.plannedTip', { amount: fmtMoney(months[hover]!.planned, c.currency) })}</div>
            <div className="viz-tt-value viz-num">{t('plan.chart.incurredTip', { amount: fmtMoney(months[hover]!.incurred, c.currency) })}</div>
          </div>
        )}
      </div>
      <Group gap="md" mt={4} wrap="wrap">
        {(
          [
            ['var(--viz-series-1)', t('plan.chart.planned')],
            ['var(--viz-series-2)', t('plan.chart.incurred')],
          ] as const
        ).map(([color, label]) => (
          <Group key={label} gap={6} wrap="nowrap">
            <svg width={14} height={10} aria-hidden>
              <rect width={14} height={10} rx={2} fill={color} />
            </svg>
            <Text size="xs" c="var(--viz-text-secondary)">
              {label}
            </Text>
          </Group>
        ))}
        {d.currentIndex >= 0 && d.currentIndex < 12 && (
          <Text size="xs" c="var(--viz-text-secondary)">
            {t('plan.chart.current')}
          </Text>
        )}
      </Group>
    </div>
  );
}

function PlanMonthsTable({ c, d }: { c: CostPlanCurrency; d: CostPlanYear }) {
  const { t } = useTranslation('costs');
  return (
    <Table.ScrollContainer minWidth={320}>
      <Table striped withTableBorder fz="sm" data-testid="plan-months">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('table.month')}</Table.Th>
            <Table.Th ta="right">{t('plan.chart.planned')}</Table.Th>
            <Table.Th ta="right">{t('plan.chart.incurred')}</Table.Th>
            {d.cloud === 'shown' && <Table.Th ta="right">{t('plan.chart.read')}</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {c.months.map((mo, i) => (
            <Table.Tr key={mo.month}>
              <Table.Td>
                {fmtMonth(mo.month, 'long')}
                {i === d.currentIndex ? ` (${t('table.soFar')})` : ''}
              </Table.Td>
              <Table.Td ta="right" className="viz-num">
                {fmtMoney(mo.planned, c.currency)}
              </Table.Td>
              <Table.Td ta="right" className="viz-num">
                {fmtMoney(mo.incurred, c.currency)}
              </Table.Td>
              {d.cloud === 'shown' && (
                <Table.Td ta="right" className="viz-num">
                  {fmtMoney(mo.read, c.currency)}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

// ---------- lines ----------

function TargetText({ target, size = 'sm' }: { target: CostPlanTarget | null; size?: 'sm' | 'xs' }) {
  const { t } = useTranslation('costs');
  if (!target)
    return (
      <Text span size={size} c="dimmed">
        –
      </Text>
    );
  if (!target.visible)
    return (
      <Text span size={size} c="dimmed">
        {t(`plan.targetHidden.${target.kind}`)}
      </Text>
    );
  const to = target.kind === 'application' ? `/applications/${target.id}` : target.kind === 'system' ? `/systems/${target.id}` : `/platforms/${target.id}`;
  return (
    <span>
      <Anchor component={Link} to={to} size={size}>
        {target.name}
      </Anchor>
      {target.gone && (
        <Text span size="xs" c="orange">
          {' '}
          ({t('plan.targetGone')})
        </Text>
      )}
    </span>
  );
}

function ReadBadge({ l }: { l: CostPlanLine }) {
  const { t } = useTranslation('costs');
  if (l.read === 'none') return null;
  return (
    <Tooltip label={t(`plan.read.${l.read}Hint`)} withArrow multiline w={260} events={{ hover: true, focus: false, touch: true }}>
      <Badge size="xs" variant="light" color={l.read === 'matched' ? 'blue' : 'gray'} data-testid="plan-read-badge">
        {t(`plan.read.${l.read}`)}
        <VisuallyHidden>: {t(`plan.read.${l.read}Hint`)}</VisuallyHidden>
      </Badge>
    </Tooltip>
  );
}

const cadenceText = (t: (k: string, o?: Record<string, unknown>) => string, l: CostPlanLine) =>
  l.cadence === 'once' && l.onceMonth
    ? t('plan.cadenceOnceIn', { month: fmtMonth(l.onceMonth) })
    : l.fromMonth && l.toMonth
      ? t('plan.cadenceSpan', { cadence: t(`plan.cadences.${l.cadence}`), from: fmtMonth(l.fromMonth), to: fmtMonth(l.toMonth) })
      : t(`plan.cadences.${l.cadence}`);

/** "Not booked: Oct 2026, Nov 2026" – payments of months up to now with no entry on their line (0.18.0). */
function NotBooked({ l }: { l: CostPlanLine }) {
  const { t } = useTranslation('costs');
  if (!l.notBooked.length) return null;
  return (
    <Badge size="xs" variant="light" color="orange" data-testid="plan-not-booked">
      {t('plan.book.notBooked', { months: listFormat().format(l.notBooked.map((mo) => fmtMonth(mo))) })}
    </Badge>
  );
}

/** The contract of a line (0.18.0): made from a schedule (Contract changed), two lines for one contract, its end in the year. */
function ContractHints({ l }: { l: CostPlanLine }) {
  const { t } = useTranslation('costs');
  return (
    <>
      {l.schedule && <ScheduleBadge changed={l.schedule.changed} title={l.schedule.title} />}
      {l.twoLines && (
        <Badge size="xs" variant="light" color="yellow" data-testid="plan-two-lines">
          {t('contractLines.twoLines')}
        </Badge>
      )}
      {l.contractEnds && (
        <Badge size="xs" variant="light" color="gray" data-testid="plan-contract-ends">
          {t('contractLines.ends', { date: fmtDay(l.contractEnds) })}
        </Badge>
      )}
    </>
  );
}

/** What a line says besides its title: supplier and contract (or the vendor), the days a prepaid payment covers, the renewal. */
function lineDetails(t: (k: string, o?: Record<string, unknown>) => string, l: CostPlanLine): string {
  return [
    l.supplier ? [l.supplier.name, l.supplierContract?.title].filter(Boolean).join(' – ') : l.supplierHidden ? t('plan.supplierHidden') : l.vendor,
    l.coversFrom && l.coversTo ? t('plan.covers', { from: fmtDay(l.coversFrom), to: fmtDay(l.coversTo) }) : '',
    l.renewalDate && !l.schedule ? t('plan.renewsOn', { date: fmtDay(l.renewalDate) }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function LineGroups({
  d,
  group,
  onEdit,
  onRemove,
  onBook,
}: {
  d: CostPlanYear;
  group: 'category' | 'target';
  onEdit: (l: CostPlanLine) => void;
  onRemove: (l: CostPlanLine) => void;
  onBook: (l: CostPlanLine) => void;
}) {
  const { t } = useTranslation(['costs', 'common']);
  const tt = t as unknown as (k: string, o?: Record<string, unknown>) => string;
  const groups = useMemo(() => {
    const out = new Map<string, { label: ReactNode; lines: CostPlanLine[] }>();
    const keyOf = (l: CostPlanLine) => (group === 'category' ? l.category : l.target ? `${l.target.kind}:${l.target.id}` : '');
    const order = group === 'category' ? [...COST_PLAN_CATEGORIES] : [];
    for (const k of order) out.set(k, { label: t(`plan.categories.${k}`), lines: [] });
    for (const l of d.lines) {
      const k = keyOf(l);
      if (!out.has(k))
        out.set(k, {
          label: group === 'target' && !l.target ? t('plan.groups.none') : <TargetText target={l.target} />,
          lines: [],
        });
      out.get(k)!.lines.push(l);
    }
    return [...out.entries()].filter(([, g]) => g.lines.length > 0);
  }, [d.lines, group, t]);
  const money = (l: CostPlanLine, v: string | null) => <span className="viz-num">{fmtMoney(v, l.currency)}</span>;
  const columns: DataColumn<CostPlanLine>[] = [
    {
      key: 'title',
      header: t('plan.columns.line'),
      sortValue: (l) => l.title,
      cell: (l) => (
        <div>
          <Group gap={6} wrap="wrap">
            <Text size="sm" fw={500}>
              {l.title}
            </Text>
            <ReadBadge l={l} />
            <NotBooked l={l} />
            <ContractHints l={l} />
          </Group>
          {lineDetails(tt, l) && (
            <Text size="xs" c="dimmed">
              {lineDetails(tt, l)}
            </Text>
          )}
        </div>
      ),
    },
    group === 'category'
      ? { key: 'for', header: t('plan.columns.for'), cell: (l) => <TargetText target={l.target} /> }
      : { key: 'category', header: t('plan.columns.category'), cell: (l) => t(`plan.categories.${l.category}`), sortValue: (l) => l.category },
    { key: 'cadence', header: t('plan.columns.cadence'), cell: (l) => cadenceText(tt, l), nowrap: true },
    { key: 'planned', header: t('plan.columns.planned'), cell: (l) => money(l, l.planned), sortValue: (l) => Number(l.planned ?? ''), nowrap: true },
    { key: 'toDate', header: t('plan.columns.plannedToDate'), cell: (l) => money(l, l.plannedToDate), nowrap: true },
    {
      key: 'incurred',
      header: t('plan.columns.incurredToDate'),
      cell: (l) => money(l, l.incurredToDate),
      sortValue: (l) => Number(l.incurredToDate ?? ''),
      nowrap: true,
    },
    { key: 'expected', header: t('plan.columns.expected'), cell: (l) => money(l, l.expected), sortValue: (l) => Number(l.expected ?? ''), nowrap: true },
    {
      key: 'difference',
      header: t('plan.columns.difference'),
      cell: (l) => <Difference v={l.difference} currency={l.currency} />,
      sortValue: (l) => Number(l.difference ?? ''),
      nowrap: true,
    },
    ...(d.canEdit
      ? [
          {
            key: 'actions',
            header: <VisuallyHidden>{t('plan.actions')}</VisuallyHidden>,
            label: t('plan.actions'),
            cell: (l: CostPlanLine) => <LineActions l={l} onEdit={onEdit} onRemove={onRemove} onBook={onBook} />,
          },
        ]
      : []),
  ];
  const card = (l: CostPlanLine) => (
    <Stack gap={4} data-testid="plan-line-card">
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
              {l.title}
            </Text>
            <ReadBadge l={l} />
            <NotBooked l={l} />
            <ContractHints l={l} />
          </Group>
          {lineDetails(tt, l) && (
            <Text size="xs" c="dimmed">
              {lineDetails(tt, l)}
            </Text>
          )}
          <Text size="xs" c="dimmed" component="div">
            {t(`plan.categories.${l.category}`)} · {cadenceText(tt, l)}
            {l.target && (
              <>
                {' · '}
                <TargetText target={l.target} size="xs" />
              </>
            )}
          </Text>
        </div>
        {d.canEdit && <LineActions l={l} onEdit={onEdit} onRemove={onRemove} onBook={onBook} />}
      </Group>
      <SimpleGrid cols={2} spacing={4} verticalSpacing={2}>
        {(
          [
            ['planned', l.planned],
            ['incurredToDate', l.incurredToDate],
            ['expected', l.expected],
          ] as const
        ).map(([k, v]) => (
          <Group key={k} justify="space-between" gap={4} wrap="nowrap" style={{ gridColumn: '1 / -1' }}>
            <Text size="xs" c="dimmed">
              {t(`plan.columns.${k}`)}
            </Text>
            <Text size="xs" className="viz-num">
              {fmtMoney(v, l.currency)}
            </Text>
          </Group>
        ))}
        <Group justify="space-between" gap={4} wrap="nowrap" style={{ gridColumn: '1 / -1' }}>
          <Text size="xs" c="dimmed">
            {t('plan.columns.difference')}
          </Text>
          <Difference v={l.difference} currency={l.currency} />
        </Group>
      </SimpleGrid>
    </Stack>
  );
  return (
    <Stack gap="md" data-testid="plan-lines">
      {groups.map(([k, g]) => (
        <Paper key={k || 'none'} withBorder p="sm" data-testid="plan-group-section">
          <Text fw={600} size="sm" mb={4} component="div">
            {g.label}
          </Text>
          <DataTable rows={g.lines} columns={columns} rowKey={(l) => l.id} ariaLabel={t('plan.lines.title')} card={card} testId="plan-line-rows" />
        </Paper>
      ))}
    </Stack>
  );
}

function LineActions({
  l,
  onEdit,
  onRemove,
  onBook,
}: {
  l: CostPlanLine;
  onEdit: (l: CostPlanLine) => void;
  onRemove: (l: CostPlanLine) => void;
  onBook: (l: CostPlanLine) => void;
}) {
  const { t } = useTranslation('costs');
  return (
    <Group gap={2} wrap="nowrap">
      {l.bookable && (
        <Tooltip label={t('plan.book.action', { title: l.title })} withArrow>
          <ActionIcon variant="subtle" aria-label={t('plan.book.action', { title: l.title })} onClick={() => onBook(l)} data-testid="plan-line-book">
            <IconCashRegister size={16} />
          </ActionIcon>
        </Tooltip>
      )}
      <ActionIcon variant="subtle" aria-label={t('plan.line.edit', { title: l.title })} onClick={() => onEdit(l)}>
        <IconPencil size={16} />
      </ActionIcon>
      <ActionIcon variant="subtle" color="red" aria-label={t('plan.line.remove', { title: l.title })} onClick={() => onRemove(l)}>
        <IconTrash size={16} />
      </ActionIcon>
    </Group>
  );
}

// ---------- entries ----------

function EntriesSection({
  d,
  onEdit,
  onRemove,
  unplanned,
}: {
  d: CostPlanYear;
  onEdit: (e: CostEntry) => void;
  onRemove: (e: CostEntry) => void;
  unplanned: number;
}) {
  const { t } = useTranslation(['costs', 'common']);
  const [only, setOnly] = useState(false);
  const rows = only ? d.entries.filter((e) => e.unplanned) : d.entries;
  const lineCell = (e: CostEntry) =>
    e.unplanned ? (
      <Stack gap={2} align="flex-start">
        <Badge size="sm" variant="light" color="orange" data-testid="entry-unplanned">
          {t('plan.entry.unplanned')}
        </Badge>
        {e.planLineYear && (
          <Text size="xs" c="dimmed" data-testid="entry-other-year">
            {t('plan.entry.otherYear', { label: e.planLineYear.label, title: e.planLineTitle ?? '' })}
          </Text>
        )}
      </Stack>
    ) : (
      <Text span size="sm">
        {e.planLineTitle}
      </Text>
    );
  const columns: DataColumn<CostEntry>[] = [
    { key: 'date', header: t('plan.entry.date'), cell: (e) => fmtDay(e.date), sortValue: (e) => e.date, nowrap: true },
    {
      key: 'amount',
      header: t('plan.entry.amount'),
      cell: (e) => <span className="viz-num">{fmtMoney(e.amount, e.currency)}</span>,
      sortValue: (e) => Number(e.amount ?? ''),
      nowrap: true,
    },
    { key: 'line', header: t('plan.entry.line'), cell: lineCell, sortValue: (e) => e.planLineTitle ?? '' },
    { key: 'for', header: t('plan.columns.for'), cell: (e) => <TargetText target={e.target} /> },
    { key: 'supplier', header: t('plan.entry.supplier'), cell: (e) => <EntrySupplier e={e} /> },
    { key: 'reference', header: t('plan.entry.reference'), cell: (e) => e.reference || '–', sortValue: (e) => e.reference },
    { key: 'note', header: t('plan.entry.note'), cell: (e) => e.note || '–' },
    ...(d.canEdit
      ? [
          {
            key: 'actions',
            header: <VisuallyHidden>{t('plan.actions')}</VisuallyHidden>,
            label: t('plan.actions'),
            cell: (e: CostEntry) => <EntryActions e={e} onEdit={onEdit} onRemove={onRemove} />,
          },
        ]
      : []),
  ];
  const card = (e: CostEntry) => (
    <Stack gap={4} data-testid="plan-entry-card">
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={500} className="viz-num">
            {fmtMoney(e.amount, e.currency)}
          </Text>
          <Text size="xs" c="dimmed">
            {fmtDay(e.date)}
            {e.reference ? ` · ${e.reference}` : ''}
          </Text>
        </div>
        {d.canEdit && <EntryActions e={e} onEdit={onEdit} onRemove={onRemove} />}
      </Group>
      <Group gap={6} wrap="wrap">
        {lineCell(e)}
        {e.target && <TargetText target={e.target} size="xs" />}
      </Group>
      {e.note && (
        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {e.note}
        </Text>
      )}
    </Stack>
  );
  return (
    <Stack gap="sm" data-testid="plan-entries">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Title order={3} size="h5">
          {t('plan.entries.title')}
        </Title>
        {unplanned > 0 && (
          <SegmentedControl
            size="xs"
            aria-label={t('plan.entries.show')}
            value={only ? 'unplanned' : 'all'}
            onChange={(v) => setOnly(v === 'unplanned')}
            data={[
              { value: 'all', label: t('plan.entries.all') },
              { value: 'unplanned', label: t('plan.entries.unplannedOnly', { count: unplanned }) },
            ]}
          />
        )}
      </Group>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('plan.entries.none')}
        </Text>
      ) : (
        <DataTable rows={rows} columns={columns} rowKey={(e) => e.id} ariaLabel={t('plan.entries.title')} card={card} testId="plan-entry-rows" />
      )}
    </Stack>
  );
}

/** The supplier and contract of an entry (0.18.0); one the reader may not see is said, not named. */
function EntrySupplier({ e }: { e: CostEntry }) {
  const { t } = useTranslation('costs');
  if (e.supplierHidden)
    return (
      <Text span size="sm" c="dimmed">
        {t('plan.supplierHidden')}
      </Text>
    );
  if (!e.supplier)
    return (
      <Text span size="sm" c="dimmed">
        –
      </Text>
    );
  return (
    <span>
      <SupplierText supplier={e.supplier} />
      {e.supplierContract && (
        <Text span size="xs" c="dimmed">
          {' '}
          · {e.supplierContract.title}
        </Text>
      )}
    </span>
  );
}

function EntryActions({ e, onEdit, onRemove }: { e: CostEntry; onEdit: (e: CostEntry) => void; onRemove: (e: CostEntry) => void }) {
  const { t } = useTranslation('costs');
  return (
    <Group gap={2} wrap="nowrap">
      <ActionIcon variant="subtle" aria-label={t('plan.entry.edit', { date: fmtDay(e.date) })} onClick={() => onEdit(e)}>
        <IconPencil size={16} />
      </ActionIcon>
      <ActionIcon variant="subtle" color="red" aria-label={t('plan.entry.remove', { date: fmtDay(e.date) })} onClick={() => onRemove(e)}>
        <IconTrash size={16} />
      </ActionIcon>
    </Group>
  );
}

// ---------- dialogs ----------

const NONE = '';
const targetValue = (t: { kind: string; id: string } | null) => (t ? `${t.kind}:${t.id}` : NONE);
const parseTarget = (v: string | null): { kind: CostPlanTargetKind; id: string } | null => {
  if (!v) return null;
  const i = v.indexOf(':');
  return { kind: v.slice(0, i) as CostPlanTargetKind, id: v.slice(i + 1) };
};
const amountOk = (v: string) => /^-?\d{1,12}([.,]\d{1,6})?$/.test(v.trim());
/** Today in the browser's time zone (YYYY-MM-DD) – not the UTC date, which is yesterday's after midnight in Europe. */
/** A form's submit (Enter in a field) runs the save. */
const submit = (save: () => Promise<void>) => (e: FormEvent) => {
  e.preventDefault();
  void save();
};
const amountText = (v: string) => v.trim().replace(',', '.');

/** The form error of an amount with more decimals than its currency has (no decimals for JPY, 0.18.0), or null. */
function useDecimalsError(): (amount: string, currency: string) => string | null {
  const { t } = useTranslation('common');
  return (amount, currency) => {
    const x = tooManyDecimals(amount, currency);
    return x && (x.digits ? t('validation.currencyDecimals', x) : t('validation.currencyWhole', x));
  };
}

/** The targets to choose from: the service's applications and systems (and a platform for cloud lines), plus the current one. */
function useTargetOptions(d: CostPlanYear, current: CostPlanTarget | null, withPlatforms: boolean) {
  const { t } = useTranslation('costs');
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms'), enabled: withPlatforms });
  const groups: { group: string; items: { value: string; label: string }[] }[] = [];
  const apps = d.targets.filter((x) => x.kind === 'application').map((x) => ({ value: targetValue(x), label: x.name }));
  const systems = d.targets.filter((x) => x.kind === 'system').map((x) => ({ value: targetValue(x), label: x.name }));
  if (apps.length) groups.push({ group: t('plan.targetKinds.application'), items: apps });
  if (systems.length) groups.push({ group: t('plan.targetKinds.system'), items: systems });
  if (withPlatforms && platforms.data?.length)
    groups.push({ group: t('plan.targetKinds.platform'), items: platforms.data.map((p) => ({ value: `platform:${p.id}`, label: p.name })) });
  // keep what the entry has (e.g. an application removed from the service since)
  if (current && !groups.some((g) => g.items.some((i) => i.value === targetValue(current))))
    groups.push({
      group: t('plan.targetKinds.current'),
      items: [{ value: targetValue(current), label: current.name || t(`plan.targetHidden.${current.kind}`) }],
    });
  return [{ value: NONE, label: t('plan.form.noTarget') }, ...groups];
}

/** A contract line's own title: the server puts the contract's title in front for who may see it, and stores the rest. */
function ownTitle(l: CostPlanLine): string {
  const prefix = l.schedule && l.supplierContract ? `${l.supplierContract.title} – ` : '';
  return prefix && l.title.startsWith(prefix) ? l.title.slice(prefix.length) : l.title;
}

function LineDialog({ d, line, onClose, onSaved }: { d: CostPlanYear; line: CostPlanLine | null; onClose: () => void; onSaved: (y: CostPlanYear) => void }) {
  const { t } = useTranslation(['costs', 'common']);
  const { t: tSup } = useTranslation('suppliers');
  const [title, setTitle] = useState(line ? ownTitle(line) : '');
  const [category, setCategory] = useState<CostPlanCategory>(line?.category ?? 'licence');
  const [target, setTarget] = useState(targetValue(line?.target ?? null));
  const [vendor, setVendor] = useState(line?.vendor ?? '');
  const supplier = useSupplierChoice(line?.supplier);
  const [contract, setContract] = useState<string | null | undefined>(undefined);
  const supplierOptions = useSupplierOptions();
  const contractValue = contract === undefined ? (supplier.value === (line?.supplier?.id ?? null) ? (line?.supplierContract?.id ?? null) : null) : contract;
  const contracts = supplierOptions.data?.find((o) => o.id === supplier.value)?.contracts ?? [];
  const [amount, setAmount] = useState(line?.amount ?? '');
  const [currency, setCurrency] = useState(line?.currency ?? d.currencies[0]?.currency ?? 'EUR');
  const [cadence, setCadence] = useState<CostPlanCadence>(line?.cadence ?? 'yearly');
  const [onceMonth, setOnceMonth] = useState<string | null>(line?.onceMonth ?? d.months[0]!);
  // only part of the year (0.18.0): monthly, quarterly and yearly lines
  const [part, setPart] = useState(!!line?.fromMonth);
  const [fromMonth, setFromMonth] = useState<string | null>(line?.fromMonth ?? d.months[0]!);
  const [toMonth, setToMonth] = useState<string | null>(line?.toMonth ?? d.months[11]!);
  // a one-off payment that covers more than its month (prepaid)
  const [prepaid, setPrepaid] = useState(!!line?.coversFrom);
  const [coversFrom, setCoversFrom] = useState(line?.coversFrom ?? '');
  const [coversTo, setCoversTo] = useState(line?.coversTo ?? '');
  const [renewal, setRenewal] = useState(line?.renewalDate ?? '');
  const [unlink, setUnlink] = useState(false);
  const [note, setNote] = useState(line?.note ?? '');
  const [busy, setBusy] = useState(false);
  const options = useTargetOptions(d, line?.target ?? null, category === 'cloud');
  const decimals = useDecimalsError();
  const check = useFieldErrors({
    title: !title.trim() && t('common:validation.required'),
    amount: (!amount.trim() && t('common:validation.required')) || (!amountOk(amount) && t('common:validation.invalid')) || decimals(amount, currency),
    currency: !ISO_4217_CODES.has(currency.trim().toUpperCase()) && t('common:validation.currency'),
    toMonth: cadence !== 'once' && part && !!fromMonth && !!toMonth && toMonth < fromMonth && t('plan.form.toBeforeFrom'),
    coversTo:
      cadence === 'once' &&
      prepaid &&
      (((!coversFrom || !coversTo) && t('common:validation.required')) || (coversTo < coversFrom && t('plan.form.toBeforeFrom'))),
  });
  const save = async () => {
    if (!check.validate()) return;
    setBusy(true);
    const span = cadence !== 'once' && part;
    const covers = cadence === 'once' && prepaid;
    const body = {
      title: title.trim(),
      category,
      target: parseTarget(target),
      vendor: vendor.trim(),
      ...(supplier.body !== undefined ? { supplierId: supplier.body } : {}),
      ...(contract !== undefined || supplier.body !== undefined ? { supplierContractId: supplier.value ? contractValue : null } : {}),
      amount: amountText(amount),
      currency: currency.trim().toUpperCase(),
      cadence,
      onceMonth: cadence === 'once' ? onceMonth : null,
      fromMonth: span ? fromMonth : null,
      toMonth: span ? toMonth : null,
      coversFrom: covers ? coversFrom : null,
      coversTo: covers ? coversTo : null,
      renewalDate: renewal || null,
      note: note.trim(),
      ...(unlink ? { scheduleId: null } : {}),
    };
    try {
      const base = `/costs/plans/${encodeURIComponent(d.serviceId)}/lines`;
      onSaved(
        line ? await put<CostPlanYear>(`${base}/${encodeURIComponent(line.id)}`, body) : await post<CostPlanYear>(base, { ...body, fiscalYear: d.fiscalYear }),
      );
      notifyOk(t('plan.line.saved'));
      onClose();
    } catch (e) {
      notifyError(e, t('plan.line.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal onClose={onClose} title={line ? t('plan.line.editTitle', { label: d.label }) : t('plan.line.addTitle', { label: d.label })} size="lg">
      <form onSubmit={submit(save)} noValidate>
        <Stack>
          <TextInput
            label={t('plan.form.title')}
            required
            data-autofocus
            maxLength={COST_PLAN_LIMITS.titleChars}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            error={check.error('title')}
            data-testid="plan-line-title"
          />
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <Select
              label={t('plan.form.category')}
              allowDeselect={false}
              data={COST_PLAN_CATEGORIES.map((c) => ({ value: c, label: t(`plan.categories.${c}`) }))}
              value={category}
              onChange={(v) => v && setCategory(v as CostPlanCategory)}
              data-testid="plan-line-category"
            />
            <Select
              label={t('plan.form.for')}
              description={t('plan.form.forHint')}
              data={options}
              value={target}
              onChange={(v) => setTarget(v ?? NONE)}
              searchable
              data-testid="plan-line-target"
            />
          </SimpleGrid>
          {category === 'cloud' && (
            <Text size="xs" c="dimmed">
              {t('plan.form.cloudHint')}
            </Text>
          )}
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <SupplierPicker
              value={supplier.value}
              onChange={(v) => {
                supplier.set(v);
                setContract(null);
              }}
              initial={line?.supplier}
              testId="plan-line-supplier"
            >
              <TextInput
                label={t('plan.form.vendor')}
                description={t('plan.form.vendorHint')}
                maxLength={COST_PLAN_LIMITS.vendorChars}
                value={vendor}
                onChange={(e) => setVendor(e.currentTarget.value)}
              />
            </SupplierPicker>
            {supplier.value && (
              <Select
                label={tSup('picker.contract')}
                description={tSup('picker.contractHint')}
                placeholder={tSup('picker.noContract')}
                data={[
                  ...contracts.map((c) => ({ value: c.id, label: c.reference ? `${c.title} (${c.reference})` : c.title })),
                  ...(line?.supplierContract && !contracts.some((c) => c.id === line.supplierContract!.id) && supplier.value === line.supplier?.id
                    ? [{ value: line.supplierContract.id, label: line.supplierContract.title }]
                    : []),
                ]}
                value={contractValue}
                onChange={(v) => setContract(v)}
                clearable
                data-testid="plan-line-contract"
              />
            )}
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, xs: 3 }}>
            <Select
              label={t('plan.form.cadence')}
              allowDeselect={false}
              data={COST_PLAN_CADENCES.map((c) => ({ value: c, label: t(`plan.cadences.${c}`) }))}
              value={cadence}
              onChange={(v) => v && setCadence(v as CostPlanCadence)}
              data-testid="plan-line-cadence"
            />
            <TextInput
              label={t(`plan.form.amount.${cadence}`)}
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.currentTarget.value)}
              error={check.error('amount')}
              data-testid="plan-line-amount"
            />
            <TextInput
              label={t('plan.form.currency')}
              maxLength={3}
              required
              value={currency}
              onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
              error={check.error('currency')}
              data-testid="plan-line-currency"
            />
          </SimpleGrid>
          {cadence === 'once' && (
            <Select
              label={t('plan.form.onceMonth')}
              allowDeselect={false}
              data={d.months.map((mo) => ({ value: mo, label: fmtMonth(mo, 'long') }))}
              value={onceMonth}
              onChange={setOnceMonth}
            />
          )}
          {cadence !== 'once' ? (
            <Stack gap="xs">
              <Checkbox
                label={t('plan.form.partOfYear')}
                description={t(`plan.form.partOfYearHint.${cadence}`)}
                checked={part}
                onChange={(e) => setPart(e.currentTarget.checked)}
                data-testid="plan-line-part"
              />
              {part && (
                <SimpleGrid cols={{ base: 1, xs: 2 }}>
                  <Select
                    label={t('plan.form.fromMonth')}
                    allowDeselect={false}
                    data={d.months.map((mo) => ({ value: mo, label: fmtMonth(mo, 'long') }))}
                    value={fromMonth}
                    onChange={setFromMonth}
                    data-testid="plan-line-from"
                  />
                  <Select
                    label={t('plan.form.toMonth')}
                    allowDeselect={false}
                    data={d.months.map((mo) => ({ value: mo, label: fmtMonth(mo, 'long') }))}
                    value={toMonth}
                    onChange={setToMonth}
                    error={check.error('toMonth')}
                    data-testid="plan-line-to"
                  />
                </SimpleGrid>
              )}
            </Stack>
          ) : (
            <Stack gap="xs">
              <Checkbox
                label={t('plan.form.prepaid')}
                description={t('plan.form.prepaidHint')}
                checked={prepaid}
                onChange={(e) => setPrepaid(e.currentTarget.checked)}
                data-testid="plan-line-prepaid"
              />
              {prepaid && (
                <SimpleGrid cols={{ base: 1, xs: 2 }}>
                  <TextInput
                    type="date"
                    label={t('plan.form.coversFrom')}
                    value={coversFrom}
                    onChange={(e) => setCoversFrom(e.currentTarget.value)}
                    data-testid="plan-line-covers-from"
                  />
                  <TextInput
                    type="date"
                    label={t('plan.form.coversTo')}
                    value={coversTo}
                    onChange={(e) => setCoversTo(e.currentTarget.value)}
                    error={check.error('coversTo')}
                    data-testid="plan-line-covers-to"
                  />
                </SimpleGrid>
              )}
            </Stack>
          )}
          {line?.schedule ? (
            <Group justify="space-between" wrap="wrap" gap="xs">
              <Text size="xs" c="dimmed" maw={420}>
                {unlink ? t('contractLines.unlinkPending') : t('plan.form.renewalFromContract')}
              </Text>
              {!unlink && (
                <Button size="compact-xs" variant="subtle" onClick={() => setUnlink(true)} data-testid="plan-line-unlink">
                  {t('contractLines.unlink')}
                </Button>
              )}
            </Group>
          ) : (
            <TextInput
              type="date"
              label={t('plan.form.renewal')}
              description={t('plan.form.renewalHint')}
              w={220}
              value={renewal}
              onChange={(e) => setRenewal(e.currentTarget.value)}
            />
          )}
          <Textarea
            label={t('plan.form.note')}
            autosize
            minRows={2}
            maxLength={COST_PLAN_LIMITS.noteChars}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Text size="xs" c="dimmed">
            {t('plan.form.noEffort')}
          </Text>
          <Group justify="flex-end">
            <FormModalCancel />
            <Button type="submit" loading={busy} data-testid="plan-line-save">
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

function EntryDialog({ d, entry, onClose, onSaved }: { d: CostPlanYear; entry: CostEntry | null; onClose: () => void; onSaved: (y: CostPlanYear) => void }) {
  const { t } = useTranslation(['costs', 'common']);
  const today = localToday();
  const inYear = today >= d.from && today <= d.to;
  const [date, setDate] = useState(entry?.date ?? (inYear ? today : d.from));
  const [amount, setAmount] = useState(entry?.amount ?? '');
  const [currency, setCurrency] = useState(entry?.currency ?? d.currencies[0]?.currency ?? 'EUR');
  const [lineId, setLineId] = useState<string>(entry?.planLineId ?? NONE);
  const [target, setTarget] = useState(targetValue(entry?.target ?? null));
  const [reference, setReference] = useState(entry?.reference ?? '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [busy, setBusy] = useState(false);
  const options = useTargetOptions(d, entry?.target ?? null, false);
  const { t: tSup } = useTranslation('suppliers');
  // the supplier and contract (0.18.0): untouched, a new entry with a plan line takes the line's (the server does)
  const [supplierTouched, setSupplierTouched] = useState(false);
  const [supplierId, setSupplierId] = useState<string | null>(entry?.supplier?.id ?? null);
  const [contractId, setContractId] = useState<string | null>(entry?.supplierContract?.id ?? null);
  const supplierOptions = useSupplierOptions();
  const chosenLine = d.lines.find((x) => x.id === lineId);
  const shownSupplier = supplierTouched ? supplierId : entry ? (entry.supplier?.id ?? null) : (chosenLine?.supplier?.id ?? null);
  const shownContract = supplierTouched ? contractId : entry ? (entry.supplierContract?.id ?? null) : (chosenLine?.supplierContract?.id ?? null);
  const initialSupplier = entry ? entry.supplier : (chosenLine?.supplier ?? null);
  const initialContract = entry ? entry.supplierContract : (chosenLine?.supplierContract ?? null);
  const entryContracts = [
    ...(supplierOptions.data?.find((o) => o.id === shownSupplier)?.contracts ?? []),
    ...(initialContract && shownSupplier === initialSupplier?.id && !supplierOptions.data?.some((o) => o.contracts.some((c) => c.id === initialContract.id))
      ? [{ ...initialContract }]
      : []),
  ];
  // a plan line sets the currency (the entry must be in the line's) and, when nothing is chosen yet, what it is for
  const lineCurrency = (id: string) => d.lines.find((x) => x.id === id)?.currency ?? (id && id === entry?.planLineId ? entry.currency : null);
  const decimals = useDecimalsError();
  const check = useFieldErrors({
    date: !date && t('common:validation.required'),
    amount:
      (!amount.trim() && t('common:validation.required')) ||
      (!amountOk(amount) && t('common:validation.invalid')) ||
      decimals(amount, lineCurrency(lineId) ?? currency),
    currency: !ISO_4217_CODES.has(currency.trim().toUpperCase()) && t('common:validation.currency'),
  });
  const chooseLine = (v: string | null) => {
    setLineId(v ?? NONE);
    const l = d.lines.find((x) => x.id === v);
    if (l) {
      setCurrency(l.currency);
      if (target === NONE && l.target && l.target.kind !== 'platform' && l.target.visible && !l.target.gone) setTarget(targetValue(l.target));
    }
  };
  const fromLine = lineCurrency(lineId);
  const save = async () => {
    if (!check.validate()) return;
    setBusy(true);
    const body = {
      date,
      amount: amountText(amount),
      currency: (fromLine ?? currency).trim().toUpperCase(),
      planLineId: lineId || null,
      target: parseTarget(target),
      ...(supplierTouched ? { supplierId, supplierContractId: supplierId ? contractId : null } : {}),
      reference: reference.trim(),
      note: note.trim(),
    };
    try {
      const base = `/costs/plans/${encodeURIComponent(d.serviceId)}/entries`;
      onSaved(entry ? await put<CostPlanYear>(`${base}/${encodeURIComponent(entry.id)}`, body) : await post<CostPlanYear>(base, body));
      notifyOk(t('plan.entry.saved'));
      onClose();
    } catch (e) {
      notifyError(e, t('plan.entry.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal onClose={onClose} title={entry ? t('plan.entry.editTitle') : t('plan.entry.addTitle')} size="lg">
      <form onSubmit={submit(save)} noValidate>
        <Stack>
          <SimpleGrid cols={{ base: 1, xs: 3 }}>
            <TextInput
              type="date"
              label={t('plan.entry.date')}
              required
              value={date}
              onChange={(e) => setDate(e.currentTarget.value)}
              error={check.error('date')}
              data-testid="plan-entry-date"
            />
            <TextInput
              label={t('plan.entry.amount')}
              description={t('plan.entry.amountHint')}
              inputMode="decimal"
              required
              data-autofocus
              value={amount}
              onChange={(e) => setAmount(e.currentTarget.value)}
              error={check.error('amount')}
              data-testid="plan-entry-amount"
            />
            <TextInput
              label={t('plan.form.currency')}
              description={fromLine ? t('plan.entry.currencyFromLine') : undefined}
              maxLength={3}
              required
              readOnly={!!fromLine}
              value={fromLine ?? currency}
              onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
              error={check.error('currency')}
              data-testid="plan-entry-currency"
            />
          </SimpleGrid>
          <Select
            label={t('plan.entry.line')}
            description={t('plan.entry.lineHint', { label: d.label })}
            data={[
              { value: NONE, label: t('plan.entry.unplannedOption') },
              ...d.lines.map((l) => ({ value: l.id, label: `${l.title} (${l.currency})` })),
              // a plan line of another fiscal year (the start month changed since): kept while it is not changed
              ...(entry?.planLineYear && entry.planLineId
                ? [{ value: entry.planLineId, label: t('plan.entry.otherYearOption', { title: entry.planLineTitle ?? '', label: entry.planLineYear.label }) }]
                : []),
            ]}
            value={lineId}
            onChange={chooseLine}
            searchable
            data-testid="plan-entry-line"
          />
          <Select label={t('plan.form.for')} data={options} value={target} onChange={(v) => setTarget(v ?? NONE)} searchable data-testid="plan-entry-target" />
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <SupplierPicker
              value={shownSupplier}
              onChange={(v) => {
                setSupplierTouched(true);
                setSupplierId(v);
                setContractId(null);
              }}
              initial={initialSupplier}
              description={entry?.supplierHidden && !supplierTouched ? t('plan.supplierHidden') : t('plan.entry.supplierHint')}
              testId="plan-entry-supplier"
            />
            {shownSupplier && (
              <Select
                label={tSup('picker.contract')}
                placeholder={tSup('picker.noContract')}
                data={entryContracts.map((c) => ({ value: c.id, label: c.reference ? `${c.title} (${c.reference})` : c.title }))}
                value={shownContract}
                onChange={(v) => {
                  if (!supplierTouched) {
                    setSupplierTouched(true);
                    setSupplierId(shownSupplier);
                  }
                  setContractId(v);
                }}
                clearable
                data-testid="plan-entry-contract"
              />
            )}
          </SimpleGrid>
          <TextInput
            label={t('plan.entry.reference')}
            description={t('plan.entry.referenceHint')}
            maxLength={COST_PLAN_LIMITS.referenceChars}
            value={reference}
            onChange={(e) => setReference(e.currentTarget.value)}
            data-testid="plan-entry-reference"
          />
          <Textarea
            label={t('plan.entry.note')}
            autosize
            minRows={2}
            maxLength={COST_PLAN_LIMITS.noteChars}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <FormModalCancel />
            <Button type="submit" loading={busy} data-testid="plan-entry-save">
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

/**
 * Book (0.18.0, ADR 0030): one entry from a line's payment in a month – the month (the current one, or an earlier
 * one without an entry), the date, the planned amount; reference and note optional; Enter saves. A month with an
 * entry on the line already asks first. Never automatic: an entry says money was spent.
 */
function BookDialog({ d, line, onClose, onSaved }: { d: CostPlanYear; line: CostPlanLine; onClose: () => void; onSaved: (y: CostPlanYear) => void }) {
  const { t } = useTranslation(['costs', 'common']);
  const upto = Math.min(d.currentIndex, 11);
  const offered = d.months.map((mo, i) => ({ mo, i })).filter(({ i }) => i <= upto && Number(line.months[i] ?? 0) !== 0);
  const bookedIn = (mo: string) => d.entries.filter((e) => e.planLineId === line.id && e.date.startsWith(mo));
  const first =
    offered.find(({ i }) => i === d.currentIndex && !bookedIn(d.months[i]!).length) ??
    [...offered].reverse().find(({ mo }) => !bookedIn(mo).length) ??
    offered[offered.length - 1];
  const [month, setMonth] = useState<string | null>(first?.mo ?? null);
  const today = localToday();
  const dateFor = (mo: string) => line.paymentDates?.[d.months.indexOf(mo)] ?? (today.startsWith(mo) ? today : lastDayOf(mo));
  const [date, setDate] = useState(month ? dateFor(month) : today);
  const [amount, setAmount] = useState(month ? (line.months[d.months.indexOf(month)] ?? '') : '');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decimals = useDecimalsError();
  const check = useFieldErrors({
    month: !month && t('common:validation.required'),
    date: !date && t('common:validation.required'),
    amount:
      (!(amount ?? '').trim() && t('common:validation.required')) ||
      (!amountOk(amount ?? '') && t('common:validation.invalid')) ||
      decimals(amount ?? '', line.currency),
  });
  const chooseMonth = (mo: string | null) => {
    setMonth(mo);
    if (!mo) return;
    setDate(dateFor(mo));
    setAmount(line.months[d.months.indexOf(mo)] ?? '');
  };
  const save = async () => {
    if (!check.validate() || !month) return;
    const already = bookedIn(month);
    let again = false;
    if (already.length) {
      const sum = already.reduce((a, e) => a + Number(e.amount ?? 0), 0);
      if (
        !(await confirmDialog({
          action: 'confirm',
          title: t('plan.book.againTitle'),
          message: t('plan.book.again', { month: fmtMonth(month, 'long'), amount: fmtMoney(String(sum), line.currency) }),
          confirmLabel: t('plan.book.againButton'),
          danger: false,
        }))
      )
        return;
      again = true;
    }
    setBusy(true);
    try {
      onSaved(
        await post<CostPlanYear>(`/costs/plans/${encodeURIComponent(d.serviceId)}/lines/${encodeURIComponent(line.id)}/book`, {
          month,
          date,
          amount: amountText(amount ?? ''),
          reference: reference.trim(),
          note: note.trim(),
          again,
        }),
      );
      notifyOk(t('plan.book.done'));
      onClose();
    } catch (e) {
      notifyError(e, t('plan.book.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal onClose={onClose} title={t('plan.book.title', { title: line.title })} size="lg">
      <form onSubmit={submit(save)} noValidate>
        <Stack>
          <Text size="xs" c="dimmed">
            {t('plan.book.help')}
          </Text>
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <Select
              label={t('plan.book.month')}
              allowDeselect={false}
              data={offered.map(({ mo }) => ({
                value: mo,
                label: bookedIn(mo).length ? t('plan.book.monthBooked', { month: fmtMonth(mo, 'long') }) : fmtMonth(mo, 'long'),
              }))}
              value={month}
              onChange={chooseMonth}
              error={check.error('month')}
              data-testid="plan-book-month"
            />
            <TextInput
              type="date"
              label={t('plan.entry.date')}
              required
              value={date}
              onChange={(e) => setDate(e.currentTarget.value)}
              error={check.error('date')}
              data-testid="plan-book-date"
            />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <TextInput
              label={t('plan.entry.amount')}
              inputMode="decimal"
              required
              data-autofocus
              rightSection={
                <Text size="xs" c="dimmed">
                  {line.currency}
                </Text>
              }
              rightSectionWidth={48}
              value={amount ?? ''}
              onChange={(e) => setAmount(e.currentTarget.value)}
              error={check.error('amount')}
              data-testid="plan-book-amount"
            />
            <TextInput
              label={t('plan.entry.reference')}
              description={t('plan.entry.referenceHint')}
              maxLength={COST_PLAN_LIMITS.referenceChars}
              value={reference}
              onChange={(e) => setReference(e.currentTarget.value)}
              data-testid="plan-book-reference"
            />
          </SimpleGrid>
          <TextInput label={t('plan.entry.note')} maxLength={COST_PLAN_LIMITS.noteChars} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          <Group justify="flex-end">
            <FormModalCancel />
            <Button type="submit" loading={busy} disabled={!offered.length} data-testid="plan-book-save">
              {t('plan.book.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}
