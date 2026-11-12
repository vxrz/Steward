import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconCalendarDollar, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import {
  COST_PLAN_CATEGORIES,
  COST_SCHEDULE_BILLINGS,
  COST_SCHEDULE_LIMITS,
  COST_VOLUME_BILLINGS,
  COST_VOLUME_COMMITTED,
  ISO_4217_CODES,
  fromMicros,
  toMicros,
  yearAmountsFromPercent,
  type CostPlanCategory,
  type CostSchedule,
  type CostScheduleBilling,
  type CostScheduleList,
  type CostVolumeBilling,
  type CostVolumeCommitted,
  type CostVolumeConsumption,
  type CostVolumePer,
  type Platform,
  type ServiceSummary,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';
import { costKeys, platformKeys } from '../../queryKeys';
import { fmtDay } from '../../format';
import { fmtMoney, tooManyDecimals, type PlanOwner } from './common';
import { useSupplierOptions } from '../suppliers/SupplierPicker';
import { FormModal, FormModalCancel } from '../FormModal';

/**
 * Payment schedules of a contract (0.18.0, ADR 0030, docs/COSTS.md#contract-payments-and-commitments): the "Payments"
 * of a contract on the supplier page – per schedule the paying service, billing, amount and term – and the dialog that
 * adds or changes one (also from a service's cost plan, with the service filled in). Schedules of services the reader
 * may not see are not listed.
 */
export function ContractPayments({ contractId, contractTitle }: { contractId: string; contractTitle: string }) {
  const { t } = useTranslation(['costs', 'common']);
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<CostSchedule | 'new' | null>(null);
  const q = useQuery({
    queryKey: costKeys.schedules('contract', contractId),
    queryFn: () => get<CostScheduleList>(`/costs/schedules?contractId=${encodeURIComponent(contractId)}`),
  });
  const list = q.data;
  if (!list) return null;
  const remove = async (x: CostSchedule) => {
    if (!(await confirmDanger({ action: 'remove', message: t('schedules.removeConfirm', { title: x.title, service: x.payer.name }) }))) return;
    try {
      qc.setQueryData(costKeys.schedules('contract', contractId), await del<CostScheduleList>(`/costs/schedules/${encodeURIComponent(x.id)}`));
      void qc.invalidateQueries({ queryKey: costKeys.all });
      notifyOk(t('schedules.removed'));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap={4} mt="xs" data-testid="contract-payments">
      {/* the contract page heads the section "Payments" itself; "Add payments" follows the list, as "Add service" does */}
      {list.schedules.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t('schedules.none')}
        </Text>
      ) : (
        list.schedules.map((x) => (
          <Group key={x.id} justify="space-between" wrap="nowrap" gap="xs" data-testid="contract-schedule">
            <div style={{ minWidth: 0 }}>
              <Text size="sm">
                {x.title} · {x.payer.kind === 'platform' ? t('schedules.paidByPlatform', { name: x.payer.name }) : x.payer.name}
              </Text>
              <Text size="xs" c="dimmed">
                {scheduleSummary(t as unknown as Tt, x)}
              </Text>
            </div>
            {x.canEdit && (
              <Group gap={2} wrap="nowrap">
                <ActionIcon variant="subtle" aria-label={t('schedules.edit', { title: x.title })} onClick={() => setDialog(x)}>
                  <IconPencil size={14} />
                </ActionIcon>
                <ActionIcon variant="subtle" color="red" aria-label={t('schedules.remove', { title: x.title })} onClick={() => void remove(x)}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            )}
          </Group>
        ))
      )}
      {list.canAdd && (
        <Group>
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setDialog('new')} data-testid="contract-payments-add">
            {t('schedules.add')}
          </Button>
        </Group>
      )}
      {dialog && (
        <ScheduleDialog
          contract={{ id: contractId, title: contractTitle }}
          schedule={dialog === 'new' ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={(l) => {
            qc.setQueryData(costKeys.schedules('contract', contractId), l);
            void qc.invalidateQueries({ queryKey: costKeys.all });
          }}
        />
      )}
    </Stack>
  );
}

type Tt = (k: string, o?: Record<string, unknown>) => string;

/** "1,000.00 EUR monthly from 1 Feb 2026 to 31 Jan 2029 · next 1 Dec 2026" */
export function scheduleSummary(t: Tt, x: CostSchedule): string {
  if (x.volume) {
    const term =
      x.effectiveStart || x.effectiveEnd
        ? t('schedules.term', { from: x.effectiveStart ? fmtDay(x.effectiveStart) : '…', to: x.effectiveEnd ? fmtDay(x.effectiveEnd) : '…' })
        : '';
    return [
      t(`volumes.summary.${x.volume.per}`, { amount: fmtMoney(x.amount, x.currency) }),
      t(`volumes.billing.${x.volume.billing}`),
      t(`volumes.committed.${x.volume.committed}`),
      term,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  const amount = x.billing === 'dates' ? t('schedules.datedCount', { count: x.payments.length }) : fmtMoney(x.amount, x.currency);
  const term =
    x.effectiveStart || x.effectiveEnd
      ? t('schedules.term', { from: x.effectiveStart ? fmtDay(x.effectiveStart) : '…', to: x.effectiveEnd ? fmtDay(x.effectiveEnd) : '…' })
      : '';
  return [
    `${amount} ${t(`schedules.billings.${x.billing}`)}`,
    term,
    x.nextPayment ? t('schedules.next', { date: fmtDay(x.nextPayment.date), amount: fmtMoney(x.nextPayment.amount, x.currency) }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const amountOk = (v: string) => /^\d{1,12}([.,]\d{1,6})?$/.test(v.trim());
const amountText = (v: string) => v.trim().replace(',', '.');

/**
 * Adds or changes a payment schedule. `contract` fixed (the supplier page) or chosen here (a cost plan: supplier, then
 * contract); `payer` fills in who pays – a service, or (0.19.0) a platform. The billing "volume" (ADR 0032) asks how
 * the volume is billed and committed and where its use comes from.
 */
export function ScheduleDialog({
  contract,
  payer,
  schedule,
  onClose,
  onSaved,
}: {
  contract?: { id: string; title: string };
  payer?: PlanOwner;
  schedule: CostSchedule | null;
  onClose: () => void;
  onSaved: (l: CostScheduleList) => void;
}) {
  const { t } = useTranslation(['costs', 'common', 'suppliers']);
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const supplierOptions = useSupplierOptions();
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [contractId, setContractId] = useState<string | null>(contract?.id ?? schedule?.contractId ?? null);
  const [payerKind, setPayerKind] = useState<'service' | 'platform'>(schedule?.payer.kind ?? payer?.kind ?? 'service');
  const [service, setService] = useState<string | null>(schedule?.payer.id ?? payer?.id ?? null);
  const [volPer, setVolPer] = useState<CostVolumePer>(schedule?.volume?.per ?? 'year');
  const [volBilling, setVolBilling] = useState<CostVolumeBilling>(schedule?.volume?.billing ?? 'byUse');
  const [volCommitted, setVolCommitted] = useState<CostVolumeCommitted>(schedule?.volume?.committed ?? 'full');
  const [minKind, setMinKind] = useState<'amount' | 'pct'>(schedule?.volume?.minimumAmount ? 'amount' : 'pct');
  const [minAmount, setMinAmount] = useState(schedule?.volume?.minimumAmount ?? '');
  const [minPct, setMinPct] = useState<string | number>(schedule?.volume?.minimumPct ?? 50);
  const [consumption, setConsumption] = useState<CostVolumeConsumption | null>(schedule?.volume?.consumption ?? null);
  const [title, setTitle] = useState(schedule?.title ?? '');
  const [category, setCategory] = useState<CostPlanCategory>(schedule?.category ?? 'support');
  const [amount, setAmount] = useState(schedule?.amount ?? '');
  const [currency, setCurrency] = useState(schedule?.currency ?? 'EUR');
  const [billing, setBilling] = useState<CostScheduleBilling>(schedule?.billing ?? 'monthly');
  const [firstPaymentOn, setFirstPaymentOn] = useState(schedule?.firstPaymentOn ?? '');
  const [startsOn, setStartsOn] = useState(schedule?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(schedule?.endsOn ?? '');
  const [years, setYears] = useState<string[]>(schedule?.yearAmounts.map((v) => v ?? '') ?? []);
  const [pct, setPct] = useState<string | number>('');
  const [payments, setPayments] = useState<{ date: string; amount: string; coversUntil: string }[]>(
    schedule?.payments.map((p) => ({ date: p.date, amount: p.amount ?? '', coversUntil: p.coversUntil ?? '' })) ?? [{ date: '', amount: '', coversUntil: '' }],
  );
  const [note, setNote] = useState(schedule?.note ?? '');
  const [busy, setBusy] = useState(false);
  const periodic = billing === 'monthly' || billing === 'quarterly' || billing === 'yearly' || (billing === 'volume' && volPer === 'year');
  const volume = billing === 'volume';
  const minimum = volume && volBilling === 'byUse' && volCommitted === 'minimum';
  const code = currency.trim().toUpperCase();
  const decimals = (v: string) => {
    const x = tooManyDecimals(v, code);
    return x && (x.digits ? t('common:validation.currencyDecimals', x) : t('common:validation.currencyWhole', x));
  };
  const check = useFieldErrors({
    contract: !contractId && t('common:validation.required'),
    service: !service && t('common:validation.required'),
    title: !title.trim() && t('common:validation.required'),
    amount:
      billing !== 'dates' && ((!amount.trim() && t('common:validation.required')) || (!amountOk(amount) && t('common:validation.invalid')) || decimals(amount)),
    currency: !ISO_4217_CODES.has(code) && t('common:validation.currency'),
    minimum:
      minimum &&
      (minKind === 'amount'
        ? (!amountOk(minAmount) && t('common:validation.invalid')) || decimals(minAmount)
        : !(Number(minPct) >= 1 && Number(minPct) <= 100) && t('common:validation.invalid')),
    payments:
      billing === 'dates' &&
      (payments.some((p) => !p.date || !amountOk(p.amount) || !!decimals(p.amount)) || !payments.length) &&
      t('schedules.form.paymentsInvalid'),
  });
  const fill = () => {
    const base = toMicros(amountText(amount));
    const p = Number(pct);
    if (base === null || !Number.isFinite(p)) return;
    setYears(yearAmountsFromPercent(base, p, code).map((v) => fromMicros(v)));
  };
  const save = async () => {
    if (!check.validate()) return;
    setBusy(true);
    const lastYear = years.reduce((n, v, i) => (v.trim() ? i + 1 : n), 0);
    const body = {
      title: title.trim(),
      category,
      amount: billing === 'dates' ? '0' : amountText(amount),
      currency: code,
      billing,
      firstPaymentOn: periodic || billing === 'once' ? firstPaymentOn || null : null,
      startsOn: startsOn || null,
      endsOn: endsOn || null,
      yearAmounts: periodic ? years.slice(0, lastYear).map((v) => (v.trim() ? amountText(v) : null)) : [],
      payments: billing === 'dates' ? payments.map((p) => ({ date: p.date, amount: amountText(p.amount), coversUntil: p.coversUntil || null })) : [],
      note: note.trim(),
      volume: volume
        ? {
            per: volPer,
            billing: volBilling,
            committed: volBilling === 'prepaid' ? 'full' : volCommitted,
            minimumAmount: minimum && minKind === 'amount' ? amountText(minAmount) : null,
            minimumPct: minimum && minKind === 'pct' ? Number(minPct) : null,
            consumption: payerKind === 'platform' ? consumption : 'entries',
          }
        : null,
    };
    try {
      onSaved(
        schedule
          ? await put<CostScheduleList>(`/costs/schedules/${encodeURIComponent(schedule.id)}`, body)
          : await post<CostScheduleList>('/costs/schedules', {
              ...body,
              contractId,
              ...(payerKind === 'service' ? { serviceId: service } : { platformId: service }),
            }),
      );
      notifyOk(t('schedules.saved'));
      onClose();
    } catch (e) {
      notifyError(e, t('schedules.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  const contracts = supplierOptions.data?.find((o) => o.id === supplierId)?.contracts ?? [];
  return (
    <FormModal onClose={onClose} size="lg" title={schedule ? t('schedules.editTitle') : t('schedules.addTitle', { contract: contract?.title ?? '' })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack>
          {!contract && !schedule && (
            <SimpleGrid cols={{ base: 1, xs: 2 }}>
              <Select
                label={t('suppliers:picker.label')}
                data={(supplierOptions.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
                value={supplierId}
                onChange={(v) => {
                  setSupplierId(v);
                  setContractId(null);
                }}
                searchable
                data-testid="schedule-supplier"
              />
              <Select
                label={t('suppliers:picker.contract')}
                data={contracts.map((c) => ({ value: c.id, label: c.reference ? `${c.title} (${c.reference})` : c.title }))}
                value={contractId}
                onChange={setContractId}
                error={check.error('contract')}
                disabled={!supplierId}
                data-testid="schedule-contract"
              />
            </SimpleGrid>
          )}
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <TextInput
              label={t('schedules.form.title')}
              description={t('schedules.form.titleHint')}
              required
              data-autofocus
              maxLength={COST_SCHEDULE_LIMITS.titleChars}
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              error={check.error('title')}
              data-testid="schedule-title"
            />
            <Stack gap={4}>
              <SegmentedControl
                size="xs"
                aria-label={t('schedules.form.payer')}
                value={payerKind}
                onChange={(v) => {
                  setPayerKind(v as 'service' | 'platform');
                  setService(null);
                }}
                disabled={!!schedule || !!payer}
                data={[
                  { value: 'service', label: t('schedules.form.payerService') },
                  { value: 'platform', label: t('schedules.form.payerPlatform') },
                ]}
                data-testid="schedule-payer-kind"
              />
              <Select
                label={payerKind === 'service' ? t('schedules.form.service') : t('schedules.form.platform')}
                description={payerKind === 'service' ? t('schedules.form.serviceHint') : t('schedules.form.platformHint')}
                data={
                  payerKind === 'service'
                    ? (services.data ?? []).filter((x) => !x.archived || x.id === service).map((x) => ({ value: x.id, label: x.name }))
                    : (platforms.data ?? []).map((x) => ({ value: x.id, label: x.name }))
                }
                value={service}
                onChange={setService}
                disabled={!!schedule || !!payer}
                searchable
                error={check.error('service')}
                data-testid="schedule-service"
              />
            </Stack>
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, xs: 3 }}>
            <Select
              label={t('schedules.form.billing')}
              allowDeselect={false}
              data={COST_SCHEDULE_BILLINGS.map((b) => ({ value: b, label: t(`commitments.billingCell.${b}`) }))}
              value={billing}
              onChange={(v) => v && setBilling(v as CostScheduleBilling)}
              data-testid="schedule-billing"
            />
            {billing !== 'dates' && (
              <TextInput
                label={volume ? t('volumes.form.amount') : t('schedules.form.amount')}
                description={volume ? t('volumes.form.amountHint') : periodic ? t('schedules.form.amountHint') : undefined}
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.currentTarget.value)}
                error={check.error('amount')}
                data-testid="schedule-amount"
              />
            )}
            <TextInput
              label={t('plan.form.currency')}
              maxLength={3}
              required
              value={currency}
              onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
              error={check.error('currency')}
              data-testid="schedule-currency"
            />
          </SimpleGrid>
          {volume && (
            <Paper withBorder p="sm" data-testid="schedule-volume">
              <Stack gap="xs">
                <Text size="xs" c="dimmed">
                  {t('volumes.form.help')}
                </Text>
                <SimpleGrid cols={{ base: 1, xs: 2 }}>
                  <Select
                    label={t('volumes.form.per')}
                    allowDeselect={false}
                    data={(['year', 'term'] as const).map((v) => ({ value: v, label: t(`volumes.form.perOptions.${v}`) }))}
                    value={volPer}
                    onChange={(v) => v && setVolPer(v as CostVolumePer)}
                    data-testid="schedule-volume-per"
                  />
                  <Select
                    label={t('volumes.form.billing')}
                    allowDeselect={false}
                    data={COST_VOLUME_BILLINGS.map((v) => ({ value: v, label: t(`volumes.form.billingOptions.${v}`) }))}
                    value={volBilling}
                    onChange={(v) => v && setVolBilling(v as CostVolumeBilling)}
                    data-testid="schedule-volume-billing"
                  />
                </SimpleGrid>
                {volBilling === 'byUse' && (
                  <Select
                    label={t('volumes.form.committed')}
                    allowDeselect={false}
                    data={COST_VOLUME_COMMITTED.map((v) => ({ value: v, label: t(`volumes.form.committedOptions.${v}`) }))}
                    value={volCommitted}
                    onChange={(v) => v && setVolCommitted(v as CostVolumeCommitted)}
                    data-testid="schedule-volume-committed"
                  />
                )}
                {minimum && (
                  <Group gap="xs" align="flex-end" wrap="wrap">
                    <SegmentedControl
                      size="xs"
                      aria-label={t('volumes.form.minimumAs')}
                      value={minKind}
                      onChange={(v) => setMinKind(v as 'amount' | 'pct')}
                      data={[
                        { value: 'pct', label: t('volumes.form.minimumPct') },
                        { value: 'amount', label: t('volumes.form.minimumAmount') },
                      ]}
                    />
                    {minKind === 'pct' ? (
                      <NumberInput
                        label={t('volumes.form.minimumPct')}
                        w={140}
                        min={1}
                        max={100}
                        value={minPct}
                        onChange={setMinPct}
                        error={check.error('minimum')}
                        data-testid="schedule-volume-pct"
                      />
                    ) : (
                      <TextInput
                        label={t('volumes.form.minimumAmount')}
                        w={160}
                        inputMode="decimal"
                        value={minAmount}
                        onChange={(e) => setMinAmount(e.currentTarget.value)}
                        error={check.error('minimum')}
                        data-testid="schedule-volume-minimum"
                      />
                    )}
                  </Group>
                )}
                {payerKind === 'platform' && (
                  <Select
                    label={t('volumes.form.consumption')}
                    description={t('volumes.form.consumptionHint')}
                    allowDeselect={false}
                    data={(['read', 'entries'] as const).map((v) => ({ value: v, label: t(`volumes.consumption.${v}`) }))}
                    value={consumption ?? 'read'}
                    onChange={(v) => v && setConsumption(v as CostVolumeConsumption)}
                    data-testid="schedule-volume-consumption"
                  />
                )}
              </Stack>
            </Paper>
          )}
          <SimpleGrid cols={{ base: 1, xs: 3 }}>
            {billing !== 'dates' && (volume ? volBilling === 'prepaid' : true) && (
              <TextInput
                type="date"
                label={t('schedules.form.firstPayment')}
                description={t('schedules.form.firstPaymentHint')}
                value={firstPaymentOn}
                onChange={(e) => setFirstPaymentOn(e.currentTarget.value)}
                data-testid="schedule-first"
              />
            )}
            <TextInput
              type="date"
              label={t('schedules.form.startsOn')}
              description={t('schedules.form.startsOnHint')}
              value={startsOn}
              onChange={(e) => setStartsOn(e.currentTarget.value)}
            />
            <TextInput
              type="date"
              label={t('schedules.form.endsOn')}
              description={t('schedules.form.endsOnHint')}
              value={endsOn}
              onChange={(e) => setEndsOn(e.currentTarget.value)}
              data-testid="schedule-ends"
            />
          </SimpleGrid>
          {periodic && (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                <Text size="sm" fw={500}>
                  {t('schedules.form.yearAmounts')}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('schedules.form.yearAmountsHint')}
                </Text>
                <Group gap="xs" align="flex-end" wrap="wrap">
                  <NumberInput
                    label={t('schedules.form.percent')}
                    w={160}
                    decimalScale={3}
                    min={-100}
                    max={1000}
                    value={pct}
                    onChange={setPct}
                    data-testid="schedule-percent"
                  />
                  <Button variant="default" onClick={fill} disabled={pct === '' || !amountOk(amount)} data-testid="schedule-fill">
                    {t('schedules.form.fill')}
                  </Button>
                </Group>
                <SimpleGrid cols={{ base: 2, xs: 3 }}>
                  {Array.from({ length: COST_SCHEDULE_LIMITS.yearAmounts }, (_, i) => (
                    <TextInput
                      key={i}
                      size="xs"
                      label={t('schedules.form.year', { year: i + 2 })}
                      placeholder={t('schedules.form.yearBefore')}
                      inputMode="decimal"
                      value={years[i] ?? ''}
                      onChange={(e) => {
                        const v = e.currentTarget.value;
                        setYears((ys) => {
                          const next = [...ys];
                          while (next.length <= i) next.push('');
                          next[i] = v;
                          return next;
                        });
                      }}
                      data-testid={`schedule-year-${i + 2}`}
                    />
                  ))}
                </SimpleGrid>
              </Stack>
            </Paper>
          )}
          {billing === 'dates' && (
            <Stack gap="xs" data-testid="schedule-payments">
              <Text size="sm" fw={500}>
                {t('schedules.form.payments')}
              </Text>
              {payments.map((p, i) => (
                <Group key={i} gap="xs" align="flex-end" wrap="wrap">
                  <TextInput
                    type="date"
                    size="xs"
                    label={t('schedules.form.paymentDate')}
                    value={p.date}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setPayments((ps) => ps.map((x, k) => (k === i ? { ...x, date: v } : x)));
                    }}
                  />
                  <TextInput
                    size="xs"
                    w={130}
                    label={t('schedules.form.paymentAmount')}
                    inputMode="decimal"
                    value={p.amount}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setPayments((ps) => ps.map((x, k) => (k === i ? { ...x, amount: v } : x)));
                    }}
                  />
                  <TextInput
                    type="date"
                    size="xs"
                    label={t('schedules.form.coversUntil')}
                    value={p.coversUntil}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setPayments((ps) => ps.map((x, k) => (k === i ? { ...x, coversUntil: v } : x)));
                    }}
                  />
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t('schedules.form.removePayment')}
                    onClick={() => setPayments((ps) => ps.filter((_, k) => k !== i))}
                    mb={4}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Group>
              ))}
              {check.error('payments') && (
                <Text size="xs" c="red">
                  {check.error('payments')}
                </Text>
              )}
              {payments.length < COST_SCHEDULE_LIMITS.payments && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconPlus size={12} />}
                  onClick={() => setPayments((ps) => [...ps, { date: '', amount: '', coversUntil: '' }])}
                  w="fit-content"
                >
                  {t('schedules.form.addPayment')}
                </Button>
              )}
            </Stack>
          )}
          <Select
            label={t('plan.form.category')}
            allowDeselect={false}
            data={COST_PLAN_CATEGORIES.map((c) => ({ value: c, label: t(`plan.categories.${c}`) }))}
            value={category}
            onChange={(v) => v && setCategory(v as CostPlanCategory)}
          />
          <Textarea
            label={t('plan.form.note')}
            autosize
            minRows={2}
            maxLength={COST_SCHEDULE_LIMITS.noteChars}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Text size="xs" c="dimmed">
            {t('schedules.form.noProRata')}
          </Text>
          <Group justify="flex-end">
            <FormModalCancel />
            <Button type="submit" loading={busy} data-testid="schedule-save">
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

/** A small badge for a contract line of the cost plan: "Contract changed", or the schedule it was made from. */
export function ScheduleBadge({ changed, title }: { changed: boolean; title: string }) {
  const { t } = useTranslation('costs');
  return changed ? (
    <Badge size="xs" color="orange" variant="light" data-testid="plan-contract-changed">
      {t('contractLines.changed')}
    </Badge>
  ) : (
    <Tooltip label={t('contractLines.fromSchedule', { title })} withArrow events={{ hover: true, focus: true, touch: true }}>
      <Badge size="xs" color="blue" variant="light" leftSection={<IconCalendarDollar size={10} aria-hidden />}>
        {t('contractLines.contract')}
      </Badge>
    </Tooltip>
  );
}
