import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconArrowsDiff, IconInfoCircle, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import {
  ISO_4217_CODES,
  type CostAdjustmentInput,
  type CostCalculatorDetail,
  type CostCalculatorInputDef,
  type CostDryRunResult,
  type CostEstimate,
  type CostEstimateHandLine,
  type CostEstimateLine,
  type CostEstimateProposals,
  type CostEstimateResult,
  type CostInputValue,
  type CostPriceBook,
  type CostRange,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { QueryState } from '../../components/common';
import { DetailPage } from '../../components/page/DetailPage';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { confirmDialog } from '../../components/confirm';
import { fmtMoney, fmtMonth, planPath } from '../../components/costs/common';
import { estimateKeys, RangeBar, RangeText } from '../../components/costs/Estimates';
import { numberFormat } from '../../format';
import { useModuleOn } from '../../modules';
import '../../components/dashboard/viz.css';

/**
 * One estimate (0.21.0, ADR 0035 part 6): its inputs (values or ranges), lines by hand, ad-hoc adjustments and the
 * books per provider; the result as lines with low–high bars and totals, the 36 months ahead when a price changes,
 * Compare with up to four more variants (the dry run), plan lines proposed and confirmed, the history.
 */

type InputValue = CostInputValue;
interface Draft {
  title: string;
  currency: string;
  appliesFrom: string;
  inputs: Map<string, InputValue>;
  lines: CostEstimateHandLine[];
  adjustments: CostAdjustmentInput[];
  books: { provider: string; bookId: string }[];
  contracts: { provider: string; contractId: string | null }[];
  /** The data product the estimate is for (ADR 0035 part 6; null: none, or another target kept as it is) */
  forProduct: string | null;
}

const CURRENCIES = [...ISO_4217_CODES].sort();
const isRange = (v: unknown): v is { low: number; expected: number; high: number } => !!v && typeof v === 'object' && !Array.isArray(v) && 'expected' in v;

function draftOf(e: CostEstimate): Draft {
  return {
    title: e.title,
    currency: e.currency,
    appliesFrom: e.appliesFrom,
    inputs: new Map(e.inputs.map((i) => [i.key, i.value])),
    lines: e.lines,
    adjustments: e.adjustments.map(({ by: _b, at: _a, ...a }) => a),
    books: e.books,
    contracts: e.contracts ?? [],
    forProduct: e.for?.kind === 'dataProduct' ? e.for.id : null,
  };
}

const bodyOf = (e: CostEstimate, d: Draft) => ({
  title: d.title.trim() || e.title,
  description: e.description,
  for: d.forProduct ? { kind: 'dataProduct', id: d.forProduct } : e.for && e.for.kind !== 'dataProduct' ? { kind: e.for.kind, id: e.for.id } : null,
  calculatorId: e.calculator?.id ?? null,
  calculatorVersion: null,
  inputs: [...d.inputs].map(([key, value]) => ({ key, value })),
  lines: d.lines,
  adjustments: d.adjustments,
  books: d.books,
  contracts: d.contracts,
  currency: d.currency,
  appliesFrom: d.appliesFrom,
});

export function EstimatePage() {
  const { t } = useTranslation('costs');
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: estimateKeys.one(id), queryFn: () => get<CostEstimate>(`/costs/estimates/${encodeURIComponent(id)}`) });
  const e = q.data;
  const calc = useQuery({
    queryKey: estimateKeys.calculator(e?.calculator?.id ?? ''),
    queryFn: () => get<CostCalculatorDetail>(`/costs/calculators/${encodeURIComponent(e!.calculator!.id)}`),
    enabled: !!e?.calculator,
  });
  const books = useQuery({ queryKey: estimateKeys.books, queryFn: () => get<CostPriceBook[]>('/costs/price-books') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (e) setDraft(draftOf(e));
  }, [e]);
  if (!e || !draft) return <QueryState query={q} />;
  const refresh = (next: CostEstimate) => {
    qc.setQueryData(estimateKeys.one(id), next);
    void qc.invalidateQueries({ queryKey: ['costs', 'estimates'] });
    void qc.invalidateQueries({ queryKey: ['costs', 'plan'] });
  };
  const run = async (fn: () => Promise<CostEstimate | void>, ok?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r) refresh(r);
      if (ok) notifyOk(ok);
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(() => put<CostEstimate>(`/costs/estimates/${encodeURIComponent(id)}`, bodyOf(e, draft)), t('estimates.saved'));
  const remove = async () => {
    if (!(await confirmDialog({ action: 'delete', message: t('estimates.removeConfirm', { title: e.title }) }))) return;
    try {
      await del(`/costs/estimates/${encodeURIComponent(id)}`);
      void qc.invalidateQueries({ queryKey: ['costs'] });
      navigate(planPath(e.owner));
    } catch (err) {
      notifyError(err);
    }
  };
  const defs = calc.data?.parsed?.inputs ?? [];
  const r = e.result;
  return (
    <DetailPage
      back={[
        { to: '/costs', label: t('title') },
        { to: planPath(e.owner), label: e.owner.name },
      ]}
      title={e.title}
      status={
        <Group gap={4}>
          <Badge variant="light" color="gray">
            {t('estimates.label')}
          </Badge>
          {r?.ranged && (
            <Badge variant="light" color="gray">
              {t('estimates.flags.ranged')}
            </Badge>
          )}
          {r?.adjusted && (
            <Badge variant="light" color="grape">
              {t('estimates.flags.adjusted')}
            </Badge>
          )}
        </Group>
      }
      description={t('estimates.pageHelp', { owner: e.owner.name })}
      actions={
        e.canEdit ? (
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconRefresh size={14} />}
              loading={busy}
              onClick={() => void run(() => post<CostEstimate>(`/costs/estimates/${encodeURIComponent(id)}/recalculate`))}
              data-testid="estimate-recalculate"
            >
              {t('estimates.recalculate')}
            </Button>
            <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => void remove()}>
              {t('estimates.remove')}
            </Button>
          </Group>
        ) : undefined
      }
    >
      <Stack gap="lg" data-testid="estimate-page">
        {e.pending && (
          <Alert
            color="orange"
            title={t('estimates.pending.title', {
              pct: e.pending.changePct === null ? '–' : numberFormat({ signDisplay: 'exceptZero', maximumFractionDigits: 1 }).format(e.pending.changePct),
            })}
            data-testid="estimate-pending"
          >
            <Stack gap="xs">
              <Text size="sm">
                {t('estimates.pending.body', {
                  before: fmtMoney(r?.totals.monthly.expected, e.currency),
                  after: fmtMoney(e.pending.totals.monthly.expected, e.currency),
                })}
              </Text>
              {e.canEdit && (
                <Group>
                  <Button
                    size="xs"
                    onClick={() => void run(() => post<CostEstimate>(`/costs/estimates/${encodeURIComponent(id)}/accept`), t('estimates.pending.accepted'))}
                    data-testid="estimate-accept"
                  >
                    {t('estimates.pending.accept')}
                  </Button>
                </Group>
              )}
            </Stack>
          </Alert>
        )}
        {!e.amountsVisible && <Alert color="gray">{t('estimates.amountsHidden')}</Alert>}
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Title order={3} size="h5">
              {t('estimates.inputs.title')}
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <TextInput
                label={t('estimates.inputs.name')}
                value={draft.title}
                disabled={!e.canEdit}
                onChange={(ev) => setDraft({ ...draft, title: ev.currentTarget.value })}
              />
              <Select
                label={t('estimates.new.currency')}
                searchable
                data={CURRENCIES}
                value={draft.currency}
                disabled={!e.canEdit}
                onChange={(v) => v && setDraft({ ...draft, currency: v })}
              />
              <TextInput
                label={t('estimates.inputs.appliesFrom')}
                description={t('estimates.inputs.appliesFromHint')}
                value={draft.appliesFrom}
                disabled={!e.canEdit}
                onChange={(ev) => setDraft({ ...draft, appliesFrom: ev.currentTarget.value })}
              />
            </SimpleGrid>
            <ForDataProduct e={e} value={draft.forProduct} onChange={(forProduct) => setDraft({ ...draft, forProduct })} />
            {e.calculator && (
              <Text size="xs" c="dimmed">
                {t('estimates.inputs.calculator', { name: e.calculator.name, version: e.calculator.version })}{' '}
                <Anchor component={Link} to={`/costs/calculators/${encodeURIComponent(e.calculator.id)}`} size="xs">
                  {t('estimates.inputs.openCalculator')}
                </Anchor>
              </Text>
            )}
            <InputsForm defs={defs} values={draft.inputs} disabled={!e.canEdit} onChange={(inputs) => setDraft({ ...draft, inputs })} />
            <HandLines lines={draft.lines} disabled={!e.canEdit} onChange={(lines) => setDraft({ ...draft, lines })} />
            <BookChoices draft={draft} result={r} books={books.data ?? []} disabled={!e.canEdit} onChange={(b) => setDraft({ ...draft, books: b })} />
            <ContractChoices draft={draft} result={r} disabled={!e.canEdit} onChange={(c) => setDraft({ ...draft, contracts: c })} />
            <Adjustments draft={draft} result={r} disabled={!e.canEdit} onChange={(adjustments) => setDraft({ ...draft, adjustments })} />
            {e.canEdit && (
              <Group justify="flex-end">
                <Button onClick={() => void save()} loading={busy} data-testid="estimate-save">
                  {t('estimates.calculate')}
                </Button>
              </Group>
            )}
          </Stack>
        </Paper>
        {r && <ResultView r={r} />}
        {r && r.months && <MonthsChart r={r} />}
        {r && <Compare e={e} draft={draft} defs={defs} />}
        {r && <PlanLines e={e} onChanged={() => void qc.invalidateQueries({ queryKey: estimateKeys.one(id) })} />}
        {e.history.length > 0 && (
          <Stack gap="xs">
            <Title order={3} size="h5">
              {t('estimates.history.title')}
            </Title>
            {e.history.map((h) => (
              <Text key={`${h.at}${h.by}`} size="sm">
                {t('estimates.history.line', {
                  at: h.at.slice(0, 16).replace('T', ' '),
                  by: h.by,
                  monthly: fmtMoney(h.monthly, e.currency),
                  oneOff: fmtMoney(h.oneOff, e.currency),
                })}
              </Text>
            ))}
          </Stack>
        )}
      </Stack>
    </DetailPage>
  );
}

// ---------- inputs ----------

function NumberOrRange({
  def,
  value,
  disabled,
  onChange,
}: {
  def: CostCalculatorInputDef;
  value: InputValue | undefined;
  disabled: boolean;
  onChange: (v: InputValue) => void;
}) {
  const { t } = useTranslation('costs');
  const ranged = isRange(value);
  const base = typeof value === 'number' ? value : typeof def.default === 'number' ? def.default : 0;
  const unit = def.unit ? ` (${def.unit.replace(/[{}]/g, '')})` : '';
  const n = (label: string, v: number, set: (x: number) => void, testId?: string) => (
    <NumberInput
      label={label}
      value={v}
      min={def.min}
      max={def.max}
      allowDecimal={def.type !== 'integer'}
      disabled={disabled}
      onChange={(x) => set(typeof x === 'number' ? x : Number(x) || 0)}
      w={130}
      data-testid={testId}
    />
  );
  return (
    <Stack gap={4}>
      <Group gap="xs" align="flex-end" wrap="wrap">
        {ranged ? (
          <>
            {n(`${def.label}${unit} – ${t('estimates.inputs.low')}`, value.low, (x) => onChange({ ...value, low: x }))}
            {n(t('estimates.inputs.expected'), value.expected, (x) => onChange({ ...value, expected: x }))}
            {n(t('estimates.inputs.high'), value.high, (x) => onChange({ ...value, high: x }))}
          </>
        ) : (
          n(`${def.label}${unit}`, base, (x) => onChange(x), `input-${def.key}`)
        )}
        {def.range !== false && (
          <Switch
            size="xs"
            label={t('estimates.inputs.range')}
            checked={ranged}
            disabled={disabled}
            onChange={(ev) => onChange(ev.currentTarget.checked ? { low: base, expected: base, high: base } : ranged ? value.expected : base)}
            data-testid={`range-${def.key}`}
          />
        )}
      </Group>
      {def.help && (
        <Text size="xs" c="dimmed">
          {def.help}
        </Text>
      )}
    </Stack>
  );
}

export function InputsForm({
  defs,
  values,
  disabled,
  onChange,
}: {
  defs: CostCalculatorInputDef[];
  values: Map<string, InputValue>;
  disabled: boolean;
  onChange: (m: Map<string, InputValue>) => void;
}) {
  const { t } = useTranslation('costs');
  if (!defs.length) return null;
  const set = (k: string, v: InputValue) => onChange(new Map(values).set(k, v));
  return (
    <Stack gap="sm" data-testid="estimate-inputs">
      {defs.map((d) => {
        const v = values.get(d.key);
        if (d.type === 'number' || d.type === 'integer')
          return <NumberOrRange key={d.key} def={d} value={v} disabled={disabled} onChange={(x) => set(d.key, x)} />;
        if (d.type === 'boolean')
          return (
            <Switch
              key={d.key}
              label={d.label}
              checked={typeof v === 'boolean' ? v : d.default === true}
              disabled={disabled}
              onChange={(ev) => set(d.key, ev.currentTarget.checked)}
            />
          );
        if (d.type === 'select')
          return (
            <Select
              key={d.key}
              label={d.label}
              description={d.help}
              data={(d.options ?? []).map(String)}
              value={String(v ?? d.default ?? d.options?.[0] ?? '')}
              disabled={disabled}
              onChange={(x) => x !== null && set(d.key, x)}
              w={220}
              data-testid={`input-${d.key}`}
            />
          );
        // a table: one row per item
        const rows = Array.isArray(v) ? (v as Record<string, string | number>[]) : [];
        const cols = d.columns ?? [];
        return (
          <Stack key={d.key} gap={4}>
            <Text size="sm" fw={500}>
              {d.label}
            </Text>
            {d.help && (
              <Text size="xs" c="dimmed">
                {d.help}
              </Text>
            )}
            {rows.map((row, i) => (
              <Group key={i} gap="xs" align="flex-end" wrap="wrap">
                {cols.map((c) =>
                  c.type === 'number' ? (
                    <NumberInput
                      key={c.key}
                      label={c.label}
                      w={110}
                      value={Number(row[c.key] ?? c.default ?? 0)}
                      disabled={disabled}
                      onChange={(x) =>
                        set(
                          d.key,
                          rows.map((r, j) => (j === i ? { ...r, [c.key]: Number(x) || 0 } : r)),
                        )
                      }
                    />
                  ) : (
                    <TextInput
                      key={c.key}
                      label={c.label}
                      w={150}
                      value={String(row[c.key] ?? c.default ?? '')}
                      disabled={disabled}
                      onChange={(ev) => {
                        const val = ev.currentTarget.value;
                        set(
                          d.key,
                          rows.map((r, j) => (j === i ? { ...r, [c.key]: val } : r)),
                        );
                      }}
                    />
                  ),
                )}
                {!disabled && (
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t('estimates.removeRow')}
                    onClick={() =>
                      set(
                        d.key,
                        rows.filter((_, j) => j !== i),
                      )
                    }
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                )}
              </Group>
            ))}
            {!disabled && (
              <Group>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => set(d.key, [...rows, Object.fromEntries(cols.map((c) => [c.key, c.default ?? (c.type === 'number' ? 0 : '')]))])}
                >
                  {t('estimates.addRow')}
                </Button>
              </Group>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

function HandLines({ lines, disabled, onChange }: { lines: CostEstimateHandLine[]; disabled: boolean; onChange: (l: CostEstimateHandLine[]) => void }) {
  const { t } = useTranslation('costs');
  const set = (i: number, patch: Partial<CostEstimateHandLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const qText = (q: CostEstimateHandLine['quantity']) => (typeof q === 'string' ? q : q.expected);
  return (
    <Stack gap={4} data-testid="estimate-hand-lines">
      <Text size="sm" fw={500}>
        {t('estimates.hand.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('estimates.hand.help')}
      </Text>
      {lines.map((l, i) => (
        <Group key={i} gap="xs" align="flex-end" wrap="wrap">
          <TextInput
            label={t('estimates.hand.provider')}
            w={150}
            value={l.provider}
            disabled={disabled}
            onChange={(e) => set(i, { provider: e.currentTarget.value })}
          />
          <TextInput label={t('estimates.hand.sku')} w={150} value={l.sku} disabled={disabled} onChange={(e) => set(i, { sku: e.currentTarget.value })} />
          <TextInput
            label={t('estimates.hand.quantity')}
            w={120}
            value={qText(l.quantity)}
            disabled={disabled}
            onChange={(e) => set(i, { quantity: e.currentTarget.value })}
          />
          <TextInput label={t('estimates.hand.unit')} w={110} value={l.unit} disabled={disabled} onChange={(e) => set(i, { unit: e.currentTarget.value })} />
          <TextInput
            label={t('estimates.hand.group')}
            w={120}
            value={l.group ?? ''}
            disabled={disabled}
            onChange={(e) => set(i, { group: e.currentTarget.value })}
          />
          {!disabled && (
            <ActionIcon variant="subtle" color="red" aria-label={t('estimates.removeRow')} onClick={() => onChange(lines.filter((_, j) => j !== i))}>
              <IconTrash size={14} />
            </ActionIcon>
          )}
        </Group>
      ))}
      {!disabled && (
        <Group>
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconPlus size={14} />}
            onClick={() => onChange([...lines, { key: `h${Date.now() % 100000}`, provider: '', sku: '', quantity: '1', unit: '1' }])}
            data-testid="hand-line-add"
          >
            {t('estimates.hand.add')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function BookChoices({
  draft,
  result,
  books,
  disabled,
  onChange,
}: {
  draft: Draft;
  result: CostEstimateResult | null;
  books: CostPriceBook[];
  disabled: boolean;
  onChange: (b: Draft['books']) => void;
}) {
  const { t } = useTranslation('costs');
  const providers = [...new Set([...(result?.lines ?? []).map((l) => l.provider), ...draft.lines.map((l) => l.provider).filter(Boolean)])];
  if (!providers.length) return null;
  const norm = (s: string) => s.trim().toLowerCase();
  return (
    <SimpleGrid cols={{ base: 1, sm: 3 }}>
      {providers.map((p) => {
        const options = books.filter((b) => norm(b.provider) === norm(p));
        const chosen = draft.books.find((b) => norm(b.provider) === norm(p))?.bookId ?? null;
        return (
          <Select
            key={p}
            label={t('estimates.books.label', { provider: p })}
            placeholder={t('estimates.books.default')}
            clearable
            disabled={disabled}
            data={options.map((b) => ({ value: b.id, label: `${b.name} (${t(`prices.kinds.${b.kind}`)})` }))}
            value={chosen}
            onChange={(v) => onChange([...draft.books.filter((b) => norm(b.provider) !== norm(p)), ...(v ? [{ provider: p, bookId: v }] : [])])}
          />
        );
      })}
    </SimpleGrid>
  );
}

/**
 * The contract whose conditions apply per provider (0.23.0, ADR 0035 part 3): only providers with contracts whose
 * prices the person sees are offered; default – a contract covering the estimate's service or platform first.
 */
function ContractChoices({
  draft,
  result,
  disabled,
  onChange,
}: {
  draft: Draft;
  result: CostEstimateResult | null;
  disabled: boolean;
  onChange: (c: Draft['contracts']) => void;
}) {
  const { t } = useTranslation('costs');
  const q = useQuery({
    queryKey: ['costs', 'condition-contracts'],
    queryFn: () => get<{ id: string; title: string; reference: string; supplierName: string; providers: string[] }[]>('/costs/contracts'),
  });
  const norm = (s: string) => s.trim().toLowerCase();
  const providers = [...new Set([...(result?.lines ?? []).map((l) => l.provider), ...draft.lines.map((l) => l.provider).filter(Boolean)])].filter((p) =>
    (q.data ?? []).some((c) => c.providers.some((x) => norm(x) === norm(p))),
  );
  if (!providers.length) return null;
  const NONE = '__none';
  return (
    <SimpleGrid cols={{ base: 1, sm: 3 }}>
      {providers.map((p) => {
        const options = (q.data ?? []).filter((c) => c.providers.some((x) => norm(x) === norm(p)));
        const chosen = draft.contracts.find((c) => norm(c.provider) === norm(p));
        return (
          <Select
            key={p}
            label={t('estimates.contracts.label', { provider: p })}
            placeholder={t('estimates.contracts.default')}
            clearable
            disabled={disabled}
            data={[
              { value: NONE, label: t('estimates.contracts.none') },
              ...options.map((c) => ({ value: c.id, label: `${c.title}${c.reference ? ` (${c.reference})` : ''} – ${c.supplierName}` })),
            ]}
            value={chosen ? (chosen.contractId ?? NONE) : null}
            onChange={(v) =>
              onChange([...draft.contracts.filter((c) => norm(c.provider) !== norm(p)), ...(v ? [{ provider: p, contractId: v === NONE ? null : v }] : [])])
            }
            data-testid={`estimate-contract-${norm(p)}`}
          />
        );
      })}
    </SimpleGrid>
  );
}

function Adjustments({
  draft,
  result,
  disabled,
  onChange,
}: {
  draft: Draft;
  result: CostEstimateResult | null;
  disabled: boolean;
  onChange: (a: CostAdjustmentInput[]) => void;
}) {
  const { t } = useTranslation('costs');
  const lineOptions = [
    { value: '', label: t('estimates.adjust.whole') },
    ...(result?.lines ?? []).map((l) => ({ value: l.key, label: `${l.label || l.name || l.sku} (${l.key})` })),
  ];
  const set = (i: number, patch: Partial<CostAdjustmentInput>) => onChange(draft.adjustments.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <Stack gap={4} data-testid="estimate-adjustments">
      <Text size="sm" fw={500}>
        {t('estimates.adjust.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('estimates.adjust.help')}
      </Text>
      {draft.adjustments.map((a, i) => (
        <Group key={i} gap="xs" align="flex-end" wrap="wrap">
          <Select
            label={t('estimates.adjust.scope')}
            w={200}
            data={lineOptions}
            value={a.line ?? ''}
            disabled={disabled}
            onChange={(v) => set(i, { line: v || null })}
          />
          <Select
            label={t('estimates.adjust.kind')}
            w={150}
            data={[
              { value: 'percent', label: t('estimates.adjust.percent') },
              { value: 'price', label: t('estimates.adjust.price') },
            ]}
            value={a.kind}
            disabled={disabled}
            onChange={(v) => v && set(i, { kind: v as 'percent' | 'price' })}
          />
          {a.kind === 'percent' ? (
            <TextInput
              label={t('estimates.adjust.value')}
              w={100}
              value={String(a.percent ?? '')}
              disabled={disabled}
              onChange={(e) => set(i, { percent: e.currentTarget.value })}
            />
          ) : (
            <>
              <TextInput
                label={t('estimates.adjust.unitPrice')}
                w={110}
                value={a.price ?? ''}
                disabled={disabled}
                onChange={(e) => set(i, { price: e.currentTarget.value })}
              />
              <Select
                label={t('estimates.new.currency')}
                w={100}
                searchable
                data={CURRENCIES}
                value={a.currency ?? draft.currency}
                disabled={disabled}
                onChange={(v) => v && set(i, { currency: v })}
              />
            </>
          )}
          <TextInput
            label={t('estimates.adjust.reason')}
            w={240}
            maxLength={200}
            value={a.reason}
            disabled={disabled}
            onChange={(e) => set(i, { reason: e.currentTarget.value })}
            required
          />
          {!disabled && (
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={t('estimates.removeRow')}
              onClick={() => onChange(draft.adjustments.filter((_, j) => j !== i))}
            >
              <IconTrash size={14} />
            </ActionIcon>
          )}
        </Group>
      ))}
      {!disabled && (
        <Group>
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconPlus size={14} />}
            onClick={() => onChange([...draft.adjustments, { line: null, kind: 'percent', percent: '-10', reason: '' }])}
            data-testid="adjustment-add"
          >
            {t('estimates.adjust.add')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

// ---------- the result ----------

/** How the price of a line was found (ADR 0035 part 3), as far as the reader may see it. */
function howFound(t: (k: string, o?: Record<string, unknown>) => string, l: CostEstimateLine): string {
  if (l.missing) return t(`estimates.missing.${l.missing}`);
  const parts: string[] = [];
  if (l.priceHidden) parts.push(t('estimates.priceHidden'));
  const f = l.foundBy;
  if (l.book && f) {
    const contract = f.contract ? f.contract.reference || f.contract.title : '';
    parts.push(t(`estimates.foundBy.${f.kind}`, { book: l.book.name, version: l.book.version, percent: f.percent ?? '', contract }));
    if (f.contract?.inherited) parts.push(t('estimates.foundBy.inherited'));
    if (f.conditionIgnored) parts.push(t('estimates.foundBy.ignored'));
  } else if (l.book) parts.push(t('estimates.how', { kind: t(`prices.kinds.${l.book.kind}`), book: l.book.name, version: l.book.version }));
  if (l.fx) parts.push(t('estimates.fx', { from: l.fx.from, rate: l.fx.rate, date: l.fx.date }));
  return parts.join(' · ');
}

/** A derived book's base, discount, markup and fee – only sent to who sees the provider's terms and the base book. */
function Breakdown({ l, currency }: { l: CostEstimateLine; currency: string }) {
  const { t } = useTranslation('costs');
  const b = l.breakdown;
  if (!b) return null;
  return (
    <Stack gap={0} data-testid="line-breakdown">
      <Text size="xs" c="dimmed">
        {t('estimates.breakdown.base', { amount: fmtMoney(b.baseAmount.expected, currency), book: `${b.base.name} v${b.base.version}` })}
      </Text>
      <Text size="xs" c="dimmed">
        {t('estimates.breakdown.discount', { percent: b.discountPct, amount: fmtMoney(b.discount.expected, currency) })}
      </Text>
      <Text size="xs" c="dimmed">
        {t('estimates.breakdown.markup', { percent: b.markupPct, amount: fmtMoney(b.markup.expected, currency) })}
      </Text>
      {Number(b.fee.expected) !== 0 && (
        <Text size="xs" c="dimmed">
          {t('estimates.breakdown.fee', { amount: fmtMoney(b.fee.expected, currency) })}
        </Text>
      )}
    </Stack>
  );
}

export function ResultView({ r }: { r: CostEstimateResult }) {
  const { t } = useTranslation('costs');
  const max = Math.max(0, ...r.lines.map((l) => Number(l.amount?.high ?? 0)));
  const unit = (u: string) => u.replace(/[{}]/g, '');
  const qty = (q: CostRange) =>
    q.low === q.high
      ? numberFormat({ maximumFractionDigits: 3 }).format(Number(q.expected))
      : t('estimates.qtyRange', {
          expected: numberFormat({ maximumFractionDigits: 3 }).format(Number(q.expected)),
          low: numberFormat({ maximumFractionDigits: 3 }).format(Number(q.low)),
          high: numberFormat({ maximumFractionDigits: 3 }).format(Number(q.high)),
        });
  const columns: DataColumn<CostEstimateLine>[] = [
    {
      key: 'item',
      header: t('estimates.columns.item'),
      cell: (l) => (
        <Stack gap={2}>
          <Text size="sm" fw={500}>
            {l.label || l.name || l.sku}
          </Text>
          <Text size="xs" c="dimmed">
            {[l.provider, l.sku, l.group].filter(Boolean).join(' · ')}
          </Text>
        </Stack>
      ),
      sortValue: (l) => l.label || l.name || l.sku,
    },
    {
      key: 'quantity',
      header: t('estimates.columns.quantity'),
      cell: (l) => (
        <Stack gap={0}>
          <Text size="sm" className="viz-num">
            {qty(l.quantity)} {unit(l.unit)}
          </Text>
          {l.credits && (
            <Text size="xs" c="dimmed" className="viz-num">
              {t('estimates.credits', { credits: qty(l.credits), item: l.creditSku })}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: 'price',
      header: t('estimates.columns.price'),
      cell: (l) => (
        <Stack gap={0}>
          {l.unitPrice && (
            <Text size="sm" className="viz-num">
              {t('estimates.unitPrice', {
                price: l.unitPrice,
                currency: unit(l.priceCurrency ?? ''),
                block: numberFormat().format(l.block),
                unit: unit(l.unit),
              })}
              {l.tiered ? ` ${t('estimates.tiered')}` : ''}
            </Text>
          )}
          <Text size="xs" c={l.missing || l.priceHidden ? 'orange' : 'dimmed'} data-testid="line-found">
            {howFound(t, l)}
          </Text>
          <Breakdown l={l} currency={r.currency} />
          {l.adjustment && (
            <Text size="xs" c="grape" data-testid="line-adjustment">
              {t(l.adjustment.kind === 'percent' ? 'estimates.adjust.shownPercent' : 'estimates.adjust.shownPrice', {
                value: l.adjustment.value,
                currency: l.adjustment.currency ?? '',
                reason: l.adjustment.reason,
              })}
              {l.found ? ` – ${t('estimates.adjust.found', { amount: fmtMoney(l.found.expected, r.currency) })}` : ''}
            </Text>
          )}
          {l.fixedMoved && (
            <Text size="xs" c="orange">
              {t('estimates.adjust.moved', { was: l.fixedMoved.was, now: l.fixedMoved.now })}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: 'amount',
      header: t('estimates.columns.amount'),
      cell: (l) => (
        <Group gap="xs" wrap="nowrap">
          <RangeText range={l.amount} currency={r.currency} />
          <RangeBar range={l.amount} max={max} width={100} />
        </Group>
      ),
      sortValue: (l) => Number(l.amount?.expected ?? 0),
    },
    { key: 'charge', header: t('estimates.columns.charge'), cell: (l) => (l.charge ? t(`prices.charges.${l.charge}`) : '–'), nowrap: true },
  ];
  return (
    <Stack gap="sm" data-testid="estimate-result">
      <Title order={3} size="h5">
        {t('estimates.result.title')}
      </Title>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Paper withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t('estimates.result.monthly')}
          </Text>
          <RangeText range={r.totals.monthly} currency={r.currency} />
        </Paper>
        <Paper withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t('estimates.result.oneOff')}
          </Text>
          <RangeText range={r.totals.oneOff} currency={r.currency} />
        </Paper>
        <Paper withBorder p="sm">
          <Text size="xs" c="dimmed">
            {t('estimates.result.basis')}
          </Text>
          <Text size="sm">{t('estimates.result.basisText', { hours: r.hoursPerMonth, from: fmtMonth(r.appliesFrom) })}</Text>
        </Paper>
      </SimpleGrid>
      <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
        <Stack gap={2}>
          <Text size="xs">{t('estimates.result.notQuote')}</Text>
          {r.ranged && <Text size="xs">{t('estimates.result.rangeNote')}</Text>}
          {r.adjusted && <Text size="xs">{t('estimates.result.adjusted')}</Text>}
          {r.atListPrice && <Text size="xs">{t('estimates.result.atListPrice')}</Text>}
          {r.incomplete && <Text size="xs">{t('estimates.result.incomplete')}</Text>}
          {r.missing > 0 && <Text size="xs">{t('estimates.result.missing', { count: r.missing })}</Text>}
        </Stack>
      </Alert>
      <DataTable
        rows={r.lines}
        columns={columns}
        rowKey={(l) => l.key}
        ariaLabel={t('estimates.result.title')}
        testId="estimate-lines"
        card={(l) => (
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              {l.label || l.name || l.sku}
            </Text>
            <Text size="xs" c="dimmed">
              {qty(l.quantity)} {unit(l.unit)} · {howFound(t, l)}
            </Text>
            <Breakdown l={l} currency={r.currency} />
            {l.adjustment && (
              <Text size="xs" c="grape" data-testid="line-adjustment">
                {t(l.adjustment.kind === 'percent' ? 'estimates.adjust.shownPercent' : 'estimates.adjust.shownPrice', {
                  value: l.adjustment.value,
                  currency: l.adjustment.currency ?? '',
                  reason: l.adjustment.reason,
                })}
              </Text>
            )}
            <Group justify="space-between">
              <RangeText range={l.amount} currency={r.currency} size="xs" />
              <RangeBar range={l.amount} max={max} width={90} />
            </Group>
          </Stack>
        )}
      />
    </Stack>
  );
}

/** The 36 months ahead (a price changes within them): the expected amount with its low–high band, and the table twin. */
function MonthsChart({ r }: { r: CostEstimateResult }) {
  const { t } = useTranslation('costs');
  const [table, setTable] = useState(false);
  const months = r.months ?? [];
  const max = Math.max(1, ...months.map((m) => Number(m.monthly.high)));
  const W = 720;
  const H = 140;
  const x = (i: number) => (i / Math.max(1, months.length - 1)) * (W - 20) + 10;
  const y = (v: string) => H - 10 - (Number(v) / max) * (H - 20);
  const band =
    months.map((m, i) => `${x(i)},${y(m.monthly.high)}`).join(' ') +
    ' ' +
    [...months]
      .reverse()
      .map((m, i) => `${x(months.length - 1 - i)},${y(m.monthly.low)}`)
      .join(' ');
  return (
    <Stack gap="xs" data-testid="estimate-months">
      <Group justify="space-between">
        <Title order={3} size="h5">
          {t('estimates.months.title')}
        </Title>
        <Switch size="xs" label={t('estimates.months.asTable')} checked={table} onChange={(e) => setTable(e.currentTarget.checked)} />
      </Group>
      <Text size="xs" c="dimmed">
        {t('estimates.months.help')}
      </Text>
      {table ? (
        <Table.ScrollContainer minWidth={480}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('estimates.months.month')}</Table.Th>
                <Table.Th>{t('estimates.inputs.low')}</Table.Th>
                <Table.Th>{t('estimates.inputs.expected')}</Table.Th>
                <Table.Th>{t('estimates.inputs.high')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {months.map((m) => (
                <Table.Tr key={m.month}>
                  <Table.Td>{fmtMonth(m.month)}</Table.Td>
                  <Table.Td className="viz-num">{fmtMoney(m.monthly.low, r.currency)}</Table.Td>
                  <Table.Td className="viz-num">{fmtMoney(m.monthly.expected, r.currency)}</Table.Td>
                  <Table.Td className="viz-num">{fmtMoney(m.monthly.high, r.currency)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={t('estimates.months.aria', { first: fmtMonth(months[0]!.month), last: fmtMonth(months[months.length - 1]!.month) })}
        >
          <polygon points={band} fill="var(--mantine-color-blue-filled)" opacity={0.15} />
          <polyline
            points={months.map((m, i) => `${x(i)},${y(m.monthly.expected)}`).join(' ')}
            fill="none"
            stroke="var(--mantine-color-blue-filled)"
            strokeWidth={2}
          />
          <line x1={10} x2={W - 10} y1={H - 10} y2={H - 10} stroke="var(--mantine-color-default-border)" />
        </svg>
      )}
    </Stack>
  );
}

// ---------- Compare (the dry run) ----------

function Compare({ e, draft, defs }: { e: CostEstimate; draft: Draft; defs: CostCalculatorInputDef[] }) {
  const { t } = useTranslation('costs');
  const [variants, setVariants] = useState<{ name: string; inputs: Map<string, InputValue> }[]>([]);
  const [result, setResult] = useState<CostDryRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const base = bodyOf(e, draft);
  const run = async () => {
    setBusy(true);
    try {
      const body = {
        variants: [
          {
            name: t('estimates.compare.current'),
            calculatorId: base.calculatorId,
            inputs: base.inputs,
            lines: base.lines,
            adjustments: base.adjustments,
            books: base.books,
            contracts: base.contracts,
            currency: base.currency,
            appliesFrom: base.appliesFrom,
          },
          ...variants.map((v) => ({
            name: v.name,
            calculatorId: base.calculatorId,
            inputs: [...v.inputs].map(([key, value]) => ({ key, value })),
            lines: base.lines,
            adjustments: base.adjustments,
            books: base.books,
            contracts: base.contracts,
            currency: base.currency,
            appliesFrom: base.appliesFrom,
          })),
        ],
      };
      setResult(await post<CostDryRunResult>('/costs/calculate', body));
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const max = result ? Math.max(1, ...result.variants.map((v) => Number(v.result.totals.monthly.high))) : 1;
  return (
    <Stack gap="sm" data-testid="estimate-compare">
      <Group justify="space-between" wrap="wrap">
        <Title order={3} size="h5">
          {t('estimates.compare.title')}
        </Title>
        <Group gap="xs">
          {defs.length > 0 && variants.length < 4 && (
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              onClick={() => setVariants([...variants, { name: t('estimates.compare.variant', { n: variants.length + 2 }), inputs: new Map(draft.inputs) }])}
              data-testid="compare-add"
            >
              {t('estimates.compare.add')}
            </Button>
          )}
          <Button size="xs" leftSection={<IconArrowsDiff size={14} />} loading={busy} onClick={() => void run()} data-testid="compare-run">
            {t('estimates.compare.run')}
          </Button>
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        {t('estimates.compare.help')}
      </Text>
      {variants.map((v, i) => (
        <Paper key={i} withBorder p="sm">
          <Stack gap="xs">
            <Group justify="space-between">
              <TextInput
                value={v.name}
                aria-label={t('estimates.compare.name')}
                onChange={(ev) => {
                  const name = ev.currentTarget.value;
                  setVariants(variants.map((x, j) => (j === i ? { ...x, name } : x)));
                }}
                w={220}
              />
              <ActionIcon variant="subtle" color="red" aria-label={t('estimates.removeRow')} onClick={() => setVariants(variants.filter((_, j) => j !== i))}>
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
            <InputsForm
              defs={defs}
              values={v.inputs}
              disabled={false}
              onChange={(inputs) => setVariants(variants.map((x, j) => (j === i ? { ...x, inputs } : x)))}
            />
          </Stack>
        </Paper>
      ))}
      {result && (
        <Stack gap="xs" data-testid="compare-result">
          <svg viewBox={`0 0 600 ${result.variants.length * 34 + 10}`} width="100%" role="img" aria-label={t('estimates.compare.aria')}>
            {result.variants.map((v, i) => {
              const m = v.result.totals.monthly;
              const sx = (s: string) => 170 + (Number(s) / max) * 400;
              const yy = i * 34 + 8;
              return (
                <g key={i}>
                  <text x={0} y={yy + 14} fontSize={12} fill="currentColor">
                    {v.name.slice(0, 24)}
                  </text>
                  <rect
                    x={170}
                    y={yy + 4}
                    width={Math.max(1, sx(m.expected) - 170)}
                    height={14}
                    rx={2}
                    fill={i === result.cheapest.expected ? 'var(--mantine-color-teal-filled)' : 'var(--mantine-color-blue-filled)'}
                    opacity={0.7}
                  />
                  <line x1={sx(m.low)} x2={sx(m.high)} y1={yy + 11} y2={yy + 11} stroke="currentColor" strokeWidth={1.5} />
                  <line x1={sx(m.low)} x2={sx(m.low)} y1={yy + 6} y2={yy + 16} stroke="currentColor" />
                  <line x1={sx(m.high)} x2={sx(m.high)} y1={yy + 6} y2={yy + 16} stroke="currentColor" />
                </g>
              );
            })}
          </svg>
          <Table.ScrollContainer minWidth={480}>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('estimates.compare.variantCol')}</Table.Th>
                  <Table.Th>{t('estimates.result.monthly')}</Table.Th>
                  <Table.Th>{t('estimates.compare.difference')}</Table.Th>
                  <Table.Th>{t('estimates.result.oneOff')}</Table.Th>
                  <Table.Th>{t('estimates.compare.lines')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {result.variants.map((v, i) => {
                  const c = result.comparison[i]!;
                  return (
                    <Table.Tr key={i}>
                      <Table.Td>
                        {v.name}{' '}
                        {i === result.cheapest.expected && (
                          <Badge size="xs" color="teal" variant="light">
                            {t('estimates.compare.cheapest')}
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <RangeText range={v.result.totals.monthly} currency={v.result.currency} />
                      </Table.Td>
                      <Table.Td className="viz-num">{i === 0 ? '–' : fmtMoney(c.monthly.expected, v.result.currency)}</Table.Td>
                      <Table.Td>
                        <RangeText range={v.result.totals.oneOff} currency={v.result.currency} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">
                          {i === 0
                            ? '–'
                            : c.lines
                                .slice(0, 3)
                                .map((l) => `${l.sku}: ${fmtMoney(l.difference, v.result.currency)}`)
                                .join(', ')}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      )}
    </Stack>
  );
}

// ---------- plan lines ----------

function PlanLines({ e, onChanged }: { e: CostEstimate; onChanged: () => void }) {
  const { t } = useTranslation('costs');
  const qc = useQueryClient();
  const [fy, setFy] = useState<number | null>(null);
  const q = useQuery({
    queryKey: estimateKeys.proposals(e.id, fy),
    queryFn: () => get<CostEstimateProposals>(`/costs/estimates/${encodeURIComponent(e.id)}/proposals${fy ? `?fiscalYear=${fy}` : ''}`),
  });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const p = q.data;
  const years = useMemo(() => {
    const y = p?.fiscalYear ?? new Date().getFullYear();
    return [y - 1, y, y + 1, y + 2].map((n) => ({ value: String(n), label: String(n) }));
  }, [p?.fiscalYear]);
  const add = async () => {
    if (!p) return;
    if (p.hiddenRates && !(await confirmDialog({ action: 'confirm', message: t('estimates.plan.hiddenConfirm'), danger: false }))) return;
    try {
      const r = await post<{ added: number }>(`/costs/estimates/${encodeURIComponent(e.id)}/proposals`, {
        fiscalYear: p.fiscalYear,
        keys: [...chosen],
        confirmHidden: p.hiddenRates,
      });
      notifyOk(t('estimates.plan.added', { count: r.added }));
      setChosen(new Set());
      void qc.invalidateQueries({ queryKey: ['costs'] });
      onChanged();
    } catch (err) {
      notifyError(err);
    }
  };
  const update = async () => {
    try {
      const r = await post<{ updated: number; kept: number }>(`/costs/estimates/${encodeURIComponent(e.id)}/update-lines`, {});
      notifyOk(t('estimates.plan.updated', { count: r.updated, kept: r.kept }));
      void qc.invalidateQueries({ queryKey: ['costs'] });
      onChanged();
    } catch (err) {
      notifyError(err);
    }
  };
  const changed = e.planLines.some((l) => l.changed);
  return (
    <Stack gap="sm" data-testid="estimate-plan">
      <Group justify="space-between" wrap="wrap">
        <Title order={3} size="h5">
          {t('estimates.plan.title')}
        </Title>
        <Select
          size="xs"
          w={110}
          aria-label={t('estimates.plan.year')}
          data={years}
          value={String(p?.fiscalYear ?? '')}
          onChange={(v) => v && setFy(Number(v))}
        />
      </Group>
      {e.planLines.length > 0 && (
        <Stack gap={4}>
          {e.planLines.map((l) => (
            <Group key={l.id} gap="xs">
              <Anchor
                component={Link}
                to={`${planPath(e.owner)}${e.owner.kind === 'service' ? `?fiscalYear=${l.fiscalYear}` : `&fiscalYear=${l.fiscalYear}`}`}
                size="sm"
              >
                {l.title}
              </Anchor>
              {l.changed && (
                <Badge size="xs" color="orange" variant="light">
                  {t('estimates.changed')}
                </Badge>
              )}
            </Group>
          ))}
          {changed && e.canEdit && (
            <Group>
              <Button size="xs" color="orange" onClick={() => void update()} data-testid="estimate-update-lines">
                {t('estimates.plan.update')}
              </Button>
            </Group>
          )}
        </Stack>
      )}
      {p && p.lines.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            {t('estimates.plan.help', { year: p.label })}
          </Text>
          {p.adjusted && (
            <Text size="xs" c="grape">
              {t('estimates.plan.adjusted')}
            </Text>
          )}
          {p.lines.map((l) => (
            <Checkbox
              key={l.key}
              disabled={!e.canEdit}
              checked={chosen.has(l.key)}
              onChange={(ev) => {
                const next = new Set(chosen);
                if (ev.currentTarget.checked) next.add(l.key);
                else next.delete(l.key);
                setChosen(next);
              }}
              label={t(l.cadence === 'once' ? 'estimates.plan.once' : 'estimates.plan.monthly', {
                title: l.title,
                amount: fmtMoney(l.amount, p.currency),
                from: fmtMonth(l.fromMonth),
                to: fmtMonth(l.toMonth),
              })}
              data-testid={`proposal-${l.key}`}
            />
          ))}
          {e.canEdit && (
            <Group>
              <Button size="xs" disabled={!chosen.size} onClick={() => void add()} data-testid="estimate-add-to-plan">
                {t('estimates.plan.add')}
              </Button>
            </Group>
          )}
        </Stack>
      )}
      {p && !p.lines.length && (
        <Text size="sm" c="dimmed">
          {t('estimates.plan.none', { year: p.label })}
        </Text>
      )}
    </Stack>
  );
}

/**
 * What the estimate is for – a data product (ADR 0035 part 6, the data products module on): its Costs tab sets the
 * estimate against what is attributed to it. Products are searched on the server as you type; a product the reader may
 * not see is never named.
 */
function ForDataProduct({ e, value, onChange }: { e: CostEstimate; value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useTranslation('costs');
  const on = useModuleOn('dataProducts');
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['dataProducts', 'estimatePicker', search],
    queryFn: () => get<{ items: { id: string; key: string; name: string }[] }>(`/data-products?limit=20&q=${encodeURIComponent(search)}`),
    enabled: on && e.canEdit,
  });
  if (!on) return null;
  const current = e.for?.kind === 'dataProduct' ? e.for : null;
  if (!e.canEdit)
    return current ? (
      <Text size="sm">
        {t('estimates.forProduct.label')}:{' '}
        {current.visible ? (
          <Anchor component={Link} to={`/data-products/${encodeURIComponent(current.id)}/costs`} size="sm">
            {current.name}
          </Anchor>
        ) : (
          t('estimates.forProduct.hidden')
        )}
      </Text>
    ) : null;
  const options = [
    ...(current && current.visible && !(q.data?.items ?? []).some((x) => x.id === current.id) ? [{ value: current.id, label: current.name }] : []),
    ...(q.data?.items ?? []).map((x) => ({ value: x.id, label: `${x.name} (${x.key})` })),
  ];
  return (
    <Select
      label={t('estimates.forProduct.label')}
      description={t('estimates.forProduct.hint')}
      placeholder={current && !current.visible ? t('estimates.forProduct.hidden') : undefined}
      data={options}
      value={value}
      onChange={onChange}
      searchable
      clearable
      searchValue={search}
      onSearchChange={setSearch}
      nothingFoundMessage={t('estimates.forProduct.none')}
      maw={420}
      data-testid="estimate-for-product"
    />
  );
}
