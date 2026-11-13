import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Paper, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import {
  COST_CONDITION_KINDS,
  COST_CONDITION_LIMITS,
  COST_CONDITION_SCOPES_OF,
  COST_DERIVATION_KINDS,
  COST_LIST_CONDITION_KINDS,
  ISO_4217_CODES,
  costConditionInput,
  type CostCondition,
  type CostConditionInput,
  type CostConditionKind,
  type CostConditionScope,
  type CostConditionView,
  type CostContractConditions,
} from '@sm/shared';
import { get, isUnavailable, notifyError, notifyOk, put } from '../../api';
import { ApiError } from '../../apiError';
import { FormModal, FormModalCancel } from '../FormModal';
import { fmtDayOnly, fmtDecimal, fmtNumber } from '../../format';

/**
 * The "Prices" of a supplier contract (0.23.0, ADR 0035 parts 3 and 4, docs/PRICE-BOOKS.md#contract-conditions): its
 * conditions – percent off list per scope, negotiated unit prices, commitments read from a volume schedule – and the
 * terms of derived books naming it (discount on the base, markup, fee per unit, fixed fee). Only for who sees the
 * contract with its amounts: everyone else sees no section at all. An order form without conditions of its own shows its
 * master's, read-only.
 */

const CURRENCIES = [...ISO_4217_CODES].sort();
export const conditionKeys = { contract: (id: string) => ['costs', 'contract-conditions', id] as const };

type T = (k: string, o?: Record<string, unknown>) => string;

/** One condition in words: "12 % off – service Compute of Invented Cloud AG". */
export function conditionText(t: T, c: CostCondition): string {
  const scope =
    c.on === 'provider'
      ? t('conditions.scopeText.provider', { provider: c.provider })
      : t(`conditions.scopeText.${c.on}`, { provider: c.provider, target: c.target });
  const value =
    c.kind === 'percentOff' || c.kind === 'baseDiscount' || c.kind === 'markup'
      ? t(`conditions.value.${c.kind}`, { percent: fmtDecimal(c.percent ?? '0') })
      : c.kind === 'negotiatedPrice' || c.kind === 'feePerUnit'
        ? t(`conditions.value.${c.kind}`, {
            price: fmtDecimal(c.price ?? '0'),
            currency: c.currency ?? '',
            block: fmtNumber(c.block),
            unit: (c.unit ?? '').replace(/[{}]/g, ''),
          })
        : c.kind === 'fixedFee'
          ? t('conditions.value.fixedFee', { price: fmtDecimal(c.price ?? '0'), currency: c.currency ?? '' })
          : t('conditions.value.commitment', { bands: (c.bands ?? []).map((b) => `${fmtDecimal(b.from)}: ${fmtDecimal(b.percent)} %`).join(', ') });
  return `${value} – ${scope}`;
}

const validText = (t: T, c: Pick<CostCondition, 'validFrom' | 'validTo'>) =>
  c.validFrom || c.validTo
    ? t('conditions.validRange', { from: c.validFrom ? fmtDayOnly(c.validFrom) : '…', to: c.validTo ? fmtDayOnly(c.validTo) : '…' })
    : t('conditions.validTerm');

function ConditionsTable({ list, testId }: { list: CostConditionView[]; testId: string }) {
  const { t } = useTranslation('costs');
  return (
    <Table.ScrollContainer minWidth={420}>
      <Table striped data-testid={testId}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('conditions.columns.kind')}</Table.Th>
            <Table.Th>{t('conditions.columns.what')}</Table.Th>
            <Table.Th>{t('conditions.columns.valid')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td>
                <Badge size="xs" variant="light" color={COST_DERIVATION_KINDS.includes(c.kind) ? 'grape' : 'blue'}>
                  {t(`conditions.kinds.${c.kind}`)}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{conditionText(t, c)}</Text>
                {c.flag && (
                  <Text size="xs" c="orange">
                    {t('conditions.flag.contractedBook')}
                  </Text>
                )}
                {c.note && (
                  <Text size="xs" c="dimmed">
                    {c.note}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="xs">{validText(t, c)}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function ContractPrices({ contractId }: { contractId: string }) {
  const { t } = useTranslation('costs');
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const q = useQuery({
    queryKey: conditionKeys.contract(contractId),
    queryFn: () => get<CostContractConditions>(`/costs/contracts/${encodeURIComponent(contractId)}/conditions`),
    retry: (n, e) => !isUnavailable(e) && n < 2,
  });
  // who may not see the prices sees no section: like a contract without one
  if (!q.data) return null;
  const d = q.data;
  const save = async (conditions: CostConditionInput[]) => {
    await put<CostContractConditions>(`/costs/contracts/${encodeURIComponent(contractId)}/conditions`, { conditions });
    notifyOk(t('conditions.saved'));
    void qc.invalidateQueries({ queryKey: ['costs'] });
  };
  return (
    <Stack gap="xs" data-testid="contract-prices">
      <Group justify="space-between">
        <Text fw={600}>{t('conditions.title')}</Text>
        {d.canEdit && (
          <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)} data-testid="contract-prices-edit">
            {t('conditions.edit')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('conditions.help')}
      </Text>
      {d.conditions.length > 0 ? (
        <ConditionsTable list={d.conditions} testId="contract-conditions" />
      ) : d.inherited ? (
        <Stack gap={4}>
          <Text size="sm" c="dimmed">
            {t('conditions.inherited', { title: d.inherited.title })}
          </Text>
          <ConditionsTable list={d.inherited.conditions} testId="contract-conditions-inherited" />
        </Stack>
      ) : (
        <Text size="sm" c="dimmed">
          {t('conditions.none')}
        </Text>
      )}
      {d.books.length > 0 && (
        <Text size="xs">
          {t('conditions.books')}:{' '}
          {d.books.map((b, i) => (
            <span key={b.id}>
              {i > 0 && ', '}
              <Anchor component={Link} to={`/costs/price-books/${encodeURIComponent(b.id)}`} size="xs">
                {b.name}
              </Anchor>
            </span>
          ))}
        </Text>
      )}
      {editing && (
        <ConditionsDialog
          title={t('conditions.editTitle', { title: d.contract.title })}
          initial={d.conditions}
          kinds={COST_CONDITION_KINDS}
          schedules={d.schedules}
          provider={d.books[0]?.provider ?? ''}
          onSave={save}
          onClose={() => setEditing(false)}
        />
      )}
    </Stack>
  );
}

interface Row {
  id?: string;
  kind: CostConditionKind;
  provider: string;
  on: CostConditionScope;
  target: string;
  priceId: string;
  percent: string;
  price: string;
  block: 1 | 1000 | 1000000;
  currency: string;
  unit: string;
  bands: string;
  scheduleId: string | null;
  validFrom: string;
  validTo: string;
  note: string;
}

const rowOf = (c: CostCondition): Row => ({
  id: c.id,
  kind: c.kind,
  provider: c.provider,
  on: c.on,
  target: c.target,
  priceId: c.priceId,
  percent: c.percent ?? '',
  price: c.price ?? '',
  block: c.block,
  currency: c.currency ?? 'USD',
  unit: c.unit ?? '',
  bands: (c.bands ?? []).map((b) => `${b.from}:${b.percent}`).join(';'),
  scheduleId: c.scheduleId,
  validFrom: c.validFrom ?? '',
  validTo: c.validTo ?? '',
  note: c.note,
});

/** A number as typed – "12,5" in German as "12.5" (as the payment and plan forms take amounts). */
const decimalText = (v: string) => v.trim().replace(',', '.');

const inputOf = (r: Row): CostConditionInput => {
  const base = { ...(r.id ? { id: r.id } : {}), kind: r.kind, provider: r.provider.trim(), on: r.on, target: r.on === 'provider' ? '' : r.target.trim() };
  const valid = { validFrom: r.validFrom.trim() || null, validTo: r.validTo.trim() || null, note: r.note.trim() };
  if (r.kind === 'percentOff' || r.kind === 'baseDiscount' || r.kind === 'markup') return { ...base, ...valid, percent: decimalText(r.percent) };
  if (r.kind === 'negotiatedPrice') return { ...base, ...valid, priceId: r.priceId.trim(), price: decimalText(r.price), block: r.block, currency: r.currency };
  if (r.kind === 'feePerUnit') return { ...base, ...valid, price: decimalText(r.price), block: r.block, currency: r.currency, unit: r.unit.trim() };
  if (r.kind === 'fixedFee') return { ...base, ...valid, price: decimalText(r.price), currency: r.currency };
  const bands = r.bands
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const at = x.indexOf(':');
      return { from: decimalText(at < 0 ? x : x.slice(0, at)), percent: at < 0 ? '' : decimalText(x.slice(at + 1)) };
    });
  return { ...base, ...valid, bands, scheduleId: r.scheduleId };
};

/** Messages per condition and field ("percent", "provider" …), in the UI's language. */
type FieldErrors = Record<number, Partial<Record<string, string>>>;

/** The message of a field: by the field (the server's own text is English and names its path). */
function fieldMessage(t: T, field: string, kind: CostConditionKind): string {
  if (field === 'percent') return t(kind === 'markup' ? 'conditions.errors.percentMarkup' : 'conditions.errors.percent');
  const known = ['provider', 'on', 'target', 'price', 'currency', 'unit', 'scheduleId', 'bands', 'validFrom', 'validTo'];
  return t(`conditions.errors.${known.includes(field) ? field : 'other'}`);
}

/** The fields of each condition that are not right, checked as the server checks them (before anything is sent). */
function checkRows(t: T, rows: Row[]): FieldErrors {
  const out: FieldErrors = {};
  rows.forEach((r, i) => {
    const res = costConditionInput.safeParse(inputOf(r));
    if (res.success) return;
    for (const issue of res.error.issues) {
      const field = String(issue.path[0] ?? 'kind');
      (out[i] ??= {})[field] ??= fieldMessage(t, field, r.kind);
    }
  });
  return out;
}

/** The server's refusal as field messages: its issues name `conditions.<n>.<field>`. Empty when none does. */
function serverErrors(t: T, rows: Row[], err: unknown): FieldErrors {
  const out: FieldErrors = {};
  if (!(err instanceof ApiError)) return out;
  for (const issue of err.issues ?? []) {
    const m = /^conditions\.(\d+)\.(\w+)/.exec(issue.path);
    const i = m ? Number(m[1]) : -1;
    if (!m || !rows[i]) continue;
    (out[i] ??= {})[m[2]!] ??= fieldMessage(t, m[2]!, rows[i].kind);
  }
  return out;
}

/** The conditions of a contract, or the terms of a rate card (kinds: the derivation kinds only). */
export function ConditionsDialog({
  title,
  initial,
  kinds,
  schedules = [],
  provider,
  onSave,
  onClose,
}: {
  title: string;
  initial: CostCondition[];
  kinds: readonly CostConditionKind[];
  schedules?: { id: string; title: string; currency: string }[];
  provider: string;
  onSave: (c: CostConditionInput[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation('costs');
  const [rows, setRows] = useState<Row[]>(() => initial.map(rowOf));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  /** The message of a field of condition `i` (shown after a save was tried) */
  const err = (i: number, field: string): string | undefined => errors[i]?.[field];
  const set = (i: number, patch: Partial<Row>) => {
    setDirty(true);
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    // a changed field is checked again on the next save
    const fields = Object.keys(patch);
    if (errors[i] && fields.some((f) => errors[i]![f]))
      setErrors({ ...errors, [i]: Object.fromEntries(Object.entries(errors[i]!).filter(([f]) => !fields.includes(f))) });
  };
  const showErrors = (e: FieldErrors) => {
    setErrors(e);
    // the first marked field gets the focus (WCAG 3.3.1)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="conditions-form"] [aria-invalid="true"]')?.focus());
  };
  const add = () => {
    setDirty(true);
    const kind = kinds.includes('percentOff') ? 'percentOff' : kinds[0]!;
    setRows([
      ...rows,
      {
        kind,
        provider: rows[rows.length - 1]?.provider ?? provider,
        on: 'provider',
        target: '',
        priceId: '',
        percent: '',
        price: '',
        block: 1,
        currency: 'USD',
        unit: '',
        bands: '',
        scheduleId: schedules[0]?.id ?? null,
        validFrom: '',
        validTo: '',
        note: '',
      },
    ]);
  };
  const submit = async () => {
    const found = checkRows(t, rows);
    if (Object.keys(found).length) return showErrors(found);
    setBusy(true);
    try {
      await onSave(rows.map(inputOf));
      onClose();
    } catch (e) {
      const marked = serverErrors(t, rows, e);
      if (Object.keys(marked).length) {
        showErrors(marked);
        // the fields say what is wrong – not the server's paths ("conditions.0.percent: …")
        notifyError(new Error(t('conditions.errors.checkFields')));
      } else notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const groups = [
    { group: t('conditions.groups.list'), items: kinds.filter((k) => COST_LIST_CONDITION_KINDS.includes(k)) },
    { group: t('conditions.groups.derived'), items: kinds.filter((k) => COST_DERIVATION_KINDS.includes(k)) },
  ]
    .filter((g) => g.items.length)
    .map((g) => ({ group: g.group, items: g.items.map((k) => ({ value: k, label: t(`conditions.kinds.${k}`) })) }));
  return (
    <FormModal title={title} onClose={onClose} size="xl" dirty={dirty}>
      <form
        data-testid="conditions-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            {t('conditions.dialogHelp')}
          </Text>
          {rows.map((r, i) => (
            <Paper key={r.id ?? `new-${i}`} withBorder p="sm" data-testid={`condition-${i}`}>
              <Stack gap="xs">
                <Group justify="space-between" wrap="nowrap" align="flex-end">
                  <SimpleGrid cols={{ base: 1, sm: 3 }} style={{ flex: 1 }}>
                    <Select
                      label={t('conditions.columns.kind')}
                      data={groups}
                      value={r.kind}
                      allowDeselect={false}
                      onChange={(v) => {
                        const k = (v ?? r.kind) as CostConditionKind;
                        set(i, { kind: k, on: COST_CONDITION_SCOPES_OF[k].includes(r.on) ? r.on : COST_CONDITION_SCOPES_OF[k][0]! });
                      }}
                      data-testid={`condition-${i}-kind`}
                      error={err(i, 'kind')}
                    />
                    <TextInput
                      label={t('conditions.provider')}
                      value={r.provider}
                      required
                      onChange={(e) => set(i, { provider: e.currentTarget.value })}
                      data-testid={`condition-${i}-provider`}
                      error={err(i, 'provider')}
                    />
                    <Select
                      label={t('conditions.on')}
                      data={COST_CONDITION_SCOPES_OF[r.kind].map((s) => ({ value: s, label: t(`conditions.scopes.${s}`) }))}
                      value={r.on}
                      allowDeselect={false}
                      onChange={(v) => set(i, { on: (v ?? r.on) as CostConditionScope })}
                      data-testid={`condition-${i}-on`}
                      error={err(i, 'on')}
                    />
                  </SimpleGrid>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t('conditions.remove', { n: i + 1 })}
                    onClick={() => {
                      setDirty(true);
                      setRows(rows.filter((_, j) => j !== i));
                      setErrors({});
                    }}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  {r.on !== 'provider' && (
                    <TextInput
                      label={t(`conditions.targets.${r.on}`)}
                      value={r.target}
                      required
                      onChange={(e) => set(i, { target: e.currentTarget.value })}
                      data-testid={`condition-${i}-target`}
                      error={err(i, 'target')}
                    />
                  )}
                  {(r.kind === 'percentOff' || r.kind === 'baseDiscount' || r.kind === 'markup') && (
                    <TextInput
                      label={t('conditions.percent')}
                      value={r.percent}
                      required
                      inputMode="decimal"
                      onChange={(e) => set(i, { percent: e.currentTarget.value })}
                      data-testid={`condition-${i}-percent`}
                      error={err(i, 'percent')}
                    />
                  )}
                  {(r.kind === 'negotiatedPrice' || r.kind === 'feePerUnit' || r.kind === 'fixedFee') && (
                    <>
                      <TextInput
                        label={t(r.kind === 'fixedFee' ? 'conditions.amountPerMonth' : 'conditions.price')}
                        value={r.price}
                        required
                        inputMode="decimal"
                        onChange={(e) => set(i, { price: e.currentTarget.value })}
                        data-testid={`condition-${i}-price`}
                        error={err(i, 'price')}
                      />
                      <Select
                        label={t('conditions.currency')}
                        searchable
                        data={CURRENCIES}
                        value={r.currency}
                        onChange={(v) => v && set(i, { currency: v })}
                        error={err(i, 'currency')}
                      />
                    </>
                  )}
                  {(r.kind === 'negotiatedPrice' || r.kind === 'feePerUnit') && (
                    <Select
                      label={t('conditions.block')}
                      data={['1', '1000', '1000000'].map((b) => ({ value: b, label: fmtNumber(Number(b)) }))}
                      value={String(r.block)}
                      allowDeselect={false}
                      onChange={(v) => set(i, { block: Number(v ?? 1) as Row['block'] })}
                    />
                  )}
                  {r.kind === 'feePerUnit' && (
                    <TextInput
                      label={t('conditions.unit')}
                      description={t('conditions.unitHint')}
                      value={r.unit}
                      required
                      onChange={(e) => set(i, { unit: e.currentTarget.value })}
                      error={err(i, 'unit')}
                    />
                  )}
                  {r.kind === 'commitment' && (
                    <>
                      <Select
                        label={t('conditions.schedule')}
                        data={schedules.map((s) => ({ value: s.id, label: `${s.title} (${s.currency})` }))}
                        value={r.scheduleId}
                        onChange={(v) => set(i, { scheduleId: v })}
                        description={schedules.length ? undefined : t('conditions.noSchedules')}
                        error={err(i, 'scheduleId')}
                      />
                      <TextInput
                        label={t('conditions.bands')}
                        description={t('conditions.bandsHint')}
                        value={r.bands}
                        required
                        onChange={(e) => set(i, { bands: e.currentTarget.value })}
                        error={err(i, 'bands')}
                      />
                    </>
                  )}
                  <TextInput
                    type="date"
                    label={t('conditions.validFrom')}
                    value={r.validFrom}
                    onChange={(e) => set(i, { validFrom: e.currentTarget.value })}
                    error={err(i, 'validFrom')}
                  />
                  <TextInput
                    type="date"
                    label={t('conditions.validTo')}
                    value={r.validTo}
                    onChange={(e) => set(i, { validTo: e.currentTarget.value })}
                    error={err(i, 'validTo')}
                  />
                  <TextInput label={t('conditions.note')} value={r.note} onChange={(e) => set(i, { note: e.currentTarget.value })} error={err(i, 'note')} />
                </SimpleGrid>
              </Stack>
            </Paper>
          ))}
          <Group justify="space-between">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              onClick={add}
              disabled={rows.length >= COST_CONDITION_LIMITS.perContract}
              data-testid="condition-add"
            >
              {t('conditions.add')}
            </Button>
            <Group gap="xs">
              <FormModalCancel />
              <Button type="submit" loading={busy} data-testid="conditions-save">
                {t('conditions.save')}
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}
