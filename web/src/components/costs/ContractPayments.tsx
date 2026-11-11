import { useState } from 'react';
import { ActionIcon, Badge, Button, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconCalendarDollar, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import {
  COST_PLAN_CATEGORIES,
  COST_SCHEDULE_BILLINGS,
  COST_SCHEDULE_LIMITS,
  ISO_4217_CODES,
  fromMicros,
  toMicros,
  yearAmountsFromPercent,
  type CostPlanCategory,
  type CostSchedule,
  type CostScheduleBilling,
  type CostScheduleList,
  type ServiceSummary,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';
import { costKeys } from '../../queryKeys';
import { fmtDay } from '../../format';
import { fmtMoney, tooManyDecimals } from './common';
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
    if (!(await confirmDanger({ action: 'remove', message: t('schedules.removeConfirm', { title: x.title, service: x.serviceName }) }))) return;
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
      {/* the contract page heads the section "Payments" itself */}
      <Group justify="flex-end" wrap="nowrap">
        {list.canAdd && (
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setDialog('new')} data-testid="contract-payments-add">
            {t('schedules.add')}
          </Button>
        )}
      </Group>
      {list.schedules.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t('schedules.none')}
        </Text>
      ) : (
        list.schedules.map((x) => (
          <Group key={x.id} justify="space-between" wrap="nowrap" gap="xs" data-testid="contract-schedule">
            <div style={{ minWidth: 0 }}>
              <Text size="sm">
                {x.title} · {x.serviceName}
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
 * Adds or changes a payment schedule. `contract` fixed (the supplier page) or chosen here (a service's cost plan:
 * supplier, then contract); `serviceId` fills in the paying service.
 */
export function ScheduleDialog({
  contract,
  serviceId,
  schedule,
  onClose,
  onSaved,
}: {
  contract?: { id: string; title: string };
  serviceId?: string;
  schedule: CostSchedule | null;
  onClose: () => void;
  onSaved: (l: CostScheduleList) => void;
}) {
  const { t } = useTranslation(['costs', 'common', 'suppliers']);
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const supplierOptions = useSupplierOptions();
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [contractId, setContractId] = useState<string | null>(contract?.id ?? schedule?.contractId ?? null);
  const [service, setService] = useState<string | null>(schedule?.serviceId ?? serviceId ?? null);
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
  const periodic = billing === 'monthly' || billing === 'quarterly' || billing === 'yearly';
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
    };
    try {
      onSaved(
        schedule
          ? await put<CostScheduleList>(`/costs/schedules/${encodeURIComponent(schedule.id)}`, body)
          : await post<CostScheduleList>('/costs/schedules', { ...body, contractId, serviceId: service }),
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
            <Select
              label={t('schedules.form.service')}
              description={t('schedules.form.serviceHint')}
              data={(services.data ?? []).filter((x) => !x.archived || x.id === service).map((x) => ({ value: x.id, label: x.name }))}
              value={service}
              onChange={setService}
              disabled={!!schedule || !!serviceId}
              searchable
              error={check.error('service')}
              data-testid="schedule-service"
            />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, xs: 3 }}>
            <Select
              label={t('schedules.form.billing')}
              allowDeselect={false}
              data={COST_SCHEDULE_BILLINGS.map((b) => ({ value: b, label: t(`schedules.billings.${b}`) }))}
              value={billing}
              onChange={(v) => v && setBilling(v as CostScheduleBilling)}
              data-testid="schedule-billing"
            />
            {billing !== 'dates' && (
              <TextInput
                label={t('schedules.form.amount')}
                description={periodic ? t('schedules.form.amountHint') : undefined}
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
          <SimpleGrid cols={{ base: 1, xs: 3 }}>
            {billing !== 'dates' && (
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
