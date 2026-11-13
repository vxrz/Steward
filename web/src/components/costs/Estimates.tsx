import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Modal, Select, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconCalculator, IconPlus } from '@tabler/icons-react';
import { ISO_4217_CODES, type CostCalculatorSummary, type CostEstimate, type CostEstimateSummary, type CostRange, type CostSettings } from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { DataTable, type DataColumn } from '../DataTable';
import { costKeys } from '../../queryKeys';
import { fmtMoney, type PlanOwner } from './common';

/**
 * Estimates of a service or a platform (0.21.0, ADR 0035 part 6) in its cost plan, the range of an amount (low,
 * expected, high) as text and as a bar, and the badge of a plan line made from an estimate (Estimate changed).
 */

export const estimateKeys = {
  list: (o: PlanOwner) => ['costs', 'estimates', o.kind, o.id] as const,
  one: (id: string) => ['costs', 'estimate', id] as const,
  proposals: (id: string, fy: number | null) => ['costs', 'estimate', id, 'proposals', fy ?? 'current'] as const,
  calculators: ['costs', 'calculators'] as const,
  calculator: (id: string) => ['costs', 'calculator', id] as const,
  books: ['costs', 'price-books'] as const,
  book: (id: string, q: string, offset: number) => ['costs', 'price-book', id, q, offset] as const,
  fx: ['costs', 'fx-rates'] as const,
};

export const estimatePath = (id: string): string => `/costs/estimates/${encodeURIComponent(id)}`;

const flat = (r: CostRange) => r.low === r.expected && r.expected === r.high;

/** "1,840.00 $" – or, for a range, the expected amount with low–high beside it. */
export function RangeText({ range, currency, size = 'sm' }: { range: CostRange | null; currency: string; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('costs');
  if (!range)
    return (
      <Text span size={size} c="dimmed">
        –
      </Text>
    );
  if (flat(range))
    return (
      <Text span size={size} className="viz-num">
        {fmtMoney(range.expected, currency)}
      </Text>
    );
  return (
    <Stack gap={0} component="span">
      <Text span size={size} className="viz-num" fw={500}>
        {fmtMoney(range.expected, currency)}
      </Text>
      <Text span size="xs" c="dimmed" className="viz-num">
        {t('estimates.range', { low: fmtMoney(range.low, currency), high: fmtMoney(range.high, currency) })}
      </Text>
    </Stack>
  );
}

/**
 * The span low–high as a bar with a tick at the expected amount, on a scale up to `max` (the largest high of the
 * table). Decorative: the figures are in the text beside it.
 */
export function RangeBar({ range, max, width = 140 }: { range: CostRange | null; max: number; width?: number }) {
  if (!range || max <= 0) return null;
  const x = (v: string) => Math.max(0, Math.min(width, (Number(v) / max) * width));
  const lo = x(range.low);
  const hi = x(range.high);
  const ex = x(range.expected);
  return (
    <svg width={width} height={14} aria-hidden="true" focusable="false" className="range-bar" style={{ display: 'block' }}>
      <rect x={0} y={6} width={width} height={2} rx={1} fill="var(--mantine-color-default-border)" />
      <rect x={lo} y={3} width={Math.max(2, hi - lo)} height={8} rx={3} fill="var(--mantine-color-blue-filled)" opacity={0.35} />
      <rect x={Math.max(0, ex - 1.5)} y={1} width={3} height={12} rx={1} fill="var(--mantine-color-blue-filled)" />
    </svg>
  );
}

/** The badge of a plan line made from an estimate: a link to it, orange "Estimate changed" when it no longer says the same. */
export function EstimateBadge({ estimate }: { estimate: { id: string; title: string; changed: boolean } }) {
  const { t } = useTranslation('costs');
  return (
    <Tooltip label={t('estimates.fromEstimate', { title: estimate.title })} withArrow events={{ hover: true, focus: true, touch: true }}>
      <Badge
        size="xs"
        variant="light"
        color={estimate.changed ? 'orange' : 'blue'}
        component={Link}
        to={estimatePath(estimate.id)}
        style={{ cursor: 'pointer' }}
        leftSection={<IconCalculator size={10} aria-hidden />}
        data-testid={estimate.changed ? 'plan-estimate-changed' : 'plan-estimate'}
      >
        {estimate.changed ? t('estimates.changed') : t('estimates.badge')}
      </Badge>
    </Tooltip>
  );
}

/** The estimates of a cost plan's owner: a list and "New estimate". */
export function EstimatesSection({ owner, canEdit }: { owner: PlanOwner; canEdit: boolean }) {
  const { t } = useTranslation('costs');
  const [adding, setAdding] = useState(false);
  const q = useQuery({
    queryKey: estimateKeys.list(owner),
    queryFn: () => get<CostEstimateSummary[]>(`/costs/estimates?ownerKind=${owner.kind}&ownerId=${encodeURIComponent(owner.id)}`),
  });
  const rows = q.data ?? [];
  const max = Math.max(0, ...rows.map((r) => Number(r.monthly?.high ?? 0)));
  const columns: DataColumn<CostEstimateSummary>[] = [
    {
      key: 'title',
      header: t('estimates.columns.title'),
      cell: (r) => (
        <Stack gap={2}>
          <Anchor component={Link} to={estimatePath(r.id)} size="sm" fw={500}>
            {r.title}
          </Anchor>
          <Group gap={4}>
            {r.calculator && (
              <Text size="xs" c="dimmed">
                {r.calculator.name}
              </Text>
            )}
            <EstimateFlags r={r} />
          </Group>
        </Stack>
      ),
      sortValue: (r) => r.title,
    },
    {
      key: 'monthly',
      header: t('estimates.columns.monthly'),
      cell: (r) => (
        <Group gap="xs" wrap="nowrap">
          <RangeText range={r.monthly} currency={r.currency} />
          <RangeBar range={r.monthly} max={max} width={90} />
        </Group>
      ),
      sortValue: (r) => Number(r.monthly?.expected ?? 0),
    },
    { key: 'oneOff', header: t('estimates.columns.oneOff'), cell: (r) => <RangeText range={r.oneOff} currency={r.currency} />, nowrap: true },
    { key: 'from', header: t('estimates.columns.from'), cell: (r) => r.appliesFrom, nowrap: true },
    { key: 'lines', header: t('estimates.columns.planLines'), cell: (r) => r.planLines, nowrap: true },
  ];
  return (
    <Stack gap="sm" data-testid="cost-estimates">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Title order={3} size="h5">
          {t('estimates.title')}
        </Title>
        {canEdit && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} data-testid="estimate-add">
            {t('estimates.add')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('estimates.help')}
      </Text>
      {rows.length > 0 && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          ariaLabel={t('estimates.title')}
          card={(r) => (
            <Stack gap={4}>
              <Anchor component={Link} to={estimatePath(r.id)} size="sm" fw={500}>
                {r.title}
              </Anchor>
              <EstimateFlags r={r} />
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  {t('estimates.columns.monthly')}
                </Text>
                <RangeText range={r.monthly} currency={r.currency} size="xs" />
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  {t('estimates.columns.oneOff')}
                </Text>
                <RangeText range={r.oneOff} currency={r.currency} size="xs" />
              </Group>
            </Stack>
          )}
          testId="estimates-table"
        />
      )}
      {adding && <NewEstimateDialog owner={owner} onClose={() => setAdding(false)} />}
    </Stack>
  );
}

function EstimateFlags({ r }: { r: Pick<CostEstimateSummary, 'ranged' | 'adjusted' | 'atListPrice' | 'pending'> }) {
  const { t } = useTranslation('costs');
  return (
    <>
      {r.ranged && (
        <Badge size="xs" variant="light" color="gray">
          {t('estimates.flags.ranged')}
        </Badge>
      )}
      {r.adjusted && (
        <Badge size="xs" variant="light" color="grape">
          {t('estimates.flags.adjusted')}
        </Badge>
      )}
      {r.atListPrice && (
        <Badge size="xs" variant="light" color="yellow">
          {t('estimates.flags.atListPrice')}
        </Badge>
      )}
      {r.pending && (
        <Badge size="xs" variant="light" color="orange">
          {t('estimates.flags.pending')}
        </Badge>
      )}
    </>
  );
}

const CURRENCIES = [...ISO_4217_CODES].sort();

function NewEstimateDialog({ owner, onClose }: { owner: PlanOwner; onClose: () => void }) {
  const { t } = useTranslation('costs');
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: costKeys.settings, queryFn: () => get<CostSettings>('/costs/settings') });
  const calcs = useQuery({ queryKey: estimateKeys.calculators, queryFn: () => get<CostCalculatorSummary[]>('/costs/calculators') });
  const [title, setTitle] = useState('');
  const [calculator, setCalculator] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cur = currency ?? settings.data?.defaultCurrency ?? 'USD';
  const save = async () => {
    setBusy(true);
    try {
      const e = await post<CostEstimate>('/costs/estimates', {
        title: title.trim(),
        ownerKind: owner.kind,
        ownerId: owner.id,
        currency: cur,
        calculatorId: calculator,
      });
      navigate(estimatePath(e.id));
    } catch (err) {
      notifyError(err);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('estimates.new.title')} centered>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('estimates.new.name')}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            required
            data-autofocus
            data-testid="estimate-title"
          />
          <Select
            label={t('estimates.new.calculator')}
            description={t('estimates.new.calculatorHint')}
            placeholder={t('estimates.new.byHand')}
            clearable
            data={(calcs.data ?? []).filter((c) => c.version > 0).map((c) => ({ value: c.id, label: c.name }))}
            value={calculator}
            onChange={setCalculator}
            data-testid="estimate-calculator"
          />
          <Select label={t('estimates.new.currency')} searchable data={CURRENCIES} value={cur} onChange={setCurrency} />
          <Alert color="gray" variant="light">
            {t('estimates.new.note')}
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('estimates.cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!title.trim()} data-testid="estimate-create">
              {t('estimates.new.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
