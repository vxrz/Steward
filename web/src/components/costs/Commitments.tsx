import { useState, type ReactNode } from 'react';
import { Alert, Anchor, Badge, Button, Group, Paper, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle, IconCalendarDollar, IconPlus } from '@tabler/icons-react';
import type { CostCommitment, CostCommitments, CostScheduleList } from '@sm/shared';
import { get } from '../../api';
import { DataTable, type DataColumn } from '../DataTable';
import { costKeys } from '../../queryKeys';
import { fmtDay, listFormat } from '../../format';
import { fmtMoney, fmtMonth } from './common';
import { ScheduleDialog } from './ContractPayments';

/**
 * Commitments (0.18.0, ADR 0030 part 5, docs/COSTS.md#commitments): what the payment schedules still owe – scheduled
 * payments dated today or later, to contract end and to the earliest exit, per fiscal year and per currency (never
 * converted, entries not subtracted). Three places: a service's cost plan (its Contracts), Costs → Commitments and the
 * supplier page.
 */

/** "Notice by 2 Nov 2027 – FY 2027/28 not planned yet": orange within 90 days, like the supplier's notice state. */
export function NoticeWarning({ r }: { r: Pick<CostCommitment, 'warning' | 'noticeBy'> }) {
  const { t } = useTranslation('costs');
  if (r.warning)
    return (
      <Badge
        size="sm"
        variant="light"
        color={r.warning.soon ? 'orange' : 'yellow'}
        leftSection={<IconAlertTriangle size={12} aria-hidden />}
        data-testid="commitment-warning"
        style={{ whiteSpace: 'normal', height: 'auto' }}
      >
        {t('commitments.warning', { date: fmtDay(r.warning.noticeBy), label: r.warning.label })}
      </Badge>
    );
  return r.noticeBy ? (
    <Text span size="sm">
      {fmtDay(r.noticeBy)}
    </Text>
  ) : (
    <Text span size="sm" c="dimmed">
      –
    </Text>
  );
}

/** The supplier – contract of a row, or "a contract of a supplier you may not see". */
export function ContractName({ r }: { r: CostCommitment }) {
  const { t } = useTranslation('costs');
  if (r.contractHidden)
    return (
      <Text span size="xs" c="dimmed">
        {t('commitments.hiddenContract')}
      </Text>
    );
  return (
    <Text span size="xs" c="dimmed">
      {r.supplier ? (
        <Anchor component={Link} to={`/suppliers/${r.supplier.id}`} size="xs">
          {r.supplier.name}
        </Anchor>
      ) : null}
      {r.contract ? ` – ${r.contract.title}` : ''}
    </Text>
  );
}

const money = (r: CostCommitment, v: string | null) => <span className="viz-num">{r.amountsVisible ? fmtMoney(v, r.currency) : '–'}</span>;

/** Badges of a row: Contract changed, the months not booked. */
function RowHints({ r }: { r: CostCommitment }) {
  const { t } = useTranslation('costs');
  return (
    <>
      {r.changed && (
        <Badge size="xs" color="orange" variant="light">
          {t('contractLines.changed')}
        </Badge>
      )}
      {r.notBooked.length > 0 && (
        <Badge size="xs" color="orange" variant="light">
          {t('plan.book.notBooked', { months: listFormat().format(r.notBooked.map((m) => fmtMonth(m))) })}
        </Badge>
      )}
    </>
  );
}

/** The commitments as a table (cards on a phone): per schedule the fiscal-year columns, later, the totals and the notice. */
export function CommitmentsTable({ c, withService = true, testId = 'commitment-rows' }: { c: CostCommitments; withService?: boolean; testId?: string }) {
  const { t } = useTranslation('costs');
  const columns: DataColumn<CostCommitment>[] = [
    {
      key: 'schedule',
      header: t('commitments.columns.schedule'),
      sortValue: (r) => r.title,
      cell: (r) => (
        <Stack gap={2}>
          <Group gap={6} wrap="wrap">
            <Text size="sm" fw={500}>
              {r.title}
            </Text>
            <RowHints r={r} />
          </Group>
          <ContractName r={r} />
          {withService && (
            <Anchor component={Link} to={`/services/${r.serviceId}?tab=costs`} size="xs">
              {r.serviceName}
            </Anchor>
          )}
        </Stack>
      ),
    },
    { key: 'billing', header: t('commitments.columns.billing'), cell: (r) => `${t(`schedules.billings.${r.billing}`)} · ${r.currency}`, nowrap: true },
    {
      key: 'next',
      header: t('commitments.columns.next'),
      cell: (r) => (r.nextPayment ? `${fmtDay(r.nextPayment.date)} · ${r.amountsVisible ? fmtMoney(r.nextPayment.amount, r.currency) : '–'}` : '–'),
      sortValue: (r) => r.nextPayment?.date ?? '',
      nowrap: true,
    },
    ...c.years.map((y, i) => ({
      key: `fy${i}`,
      header: i === 0 ? t('commitments.columns.thisYear', { label: y.label }) : y.label,
      cell: (r: CostCommitment) => money(r, r.years[i] ?? null),
      sortValue: (r: CostCommitment) => Number(r.years[i] ?? ''),
      nowrap: true,
    })),
    { key: 'later', header: t('commitments.columns.later'), cell: (r) => money(r, r.later), nowrap: true },
    {
      key: 'toEnd',
      header: t('commitments.columns.toContractEnd'),
      cell: (r) => (
        <Tooltip label={r.contractEnd ? t('commitments.until', { date: fmtDay(r.contractEnd) }) : t('commitments.hiddenDates')} withArrow>
          {money(r, r.toContractEnd)}
        </Tooltip>
      ),
      sortValue: (r) => Number(r.toContractEnd ?? ''),
      nowrap: true,
    },
    {
      key: 'toExit',
      header: t('commitments.columns.toEarliestExit'),
      cell: (r) => (
        <Tooltip label={r.earliestExit ? t('commitments.until', { date: fmtDay(r.earliestExit) }) : t('commitments.hiddenDates')} withArrow>
          {money(r, r.toEarliestExit)}
        </Tooltip>
      ),
      sortValue: (r) => Number(r.toEarliestExit ?? ''),
      nowrap: true,
    },
    { key: 'notice', header: t('commitments.columns.noticeBy'), cell: (r) => <NoticeWarning r={r} />, sortValue: (r) => r.noticeBy ?? '' },
  ];
  const card = (r: CostCommitment) => (
    <Stack gap={4} data-testid="commitment-card">
      <Group gap={6} wrap="wrap">
        <Text size="sm" fw={500}>
          {r.title}
        </Text>
        <RowHints r={r} />
      </Group>
      <ContractName r={r} />
      {withService && (
        <Anchor component={Link} to={`/services/${r.serviceId}?tab=costs`} size="xs">
          {r.serviceName}
        </Anchor>
      )}
      <SimpleGrid cols={2} spacing={4} verticalSpacing={2}>
        <Text size="xs" c="dimmed">
          {t('commitments.columns.thisYear', { label: c.years[0]?.label ?? '' })}
        </Text>
        <Text size="xs" ta="right">
          {money(r, r.owedThisYear)}
        </Text>
        <Text size="xs" c="dimmed">
          {t('commitments.columns.toContractEnd')}
        </Text>
        <Text size="xs" ta="right">
          {money(r, r.toContractEnd)}
        </Text>
        <Text size="xs" c="dimmed">
          {t('commitments.columns.toEarliestExit')}
        </Text>
        <Text size="xs" ta="right">
          {money(r, r.toEarliestExit)}
        </Text>
      </SimpleGrid>
      <NoticeWarning r={r} />
    </Stack>
  );
  return <DataTable rows={c.rows} columns={columns} rowKey={(r) => r.scheduleId} ariaLabel={t('commitments.title')} card={card} testId={testId} />;
}

/** Totals per currency (only the amounts the reader sees). */
export function CommitmentTotals({ c }: { c: CostCommitments }) {
  const { t } = useTranslation('costs');
  if (!c.totals.length) return null;
  return (
    <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
      {c.totals.map((x) => (
        <Paper key={x.currency} withBorder p="sm" data-testid="commitment-total">
          <Text size="xs" c="dimmed">
            {t('commitments.total', { currency: x.currency })}
          </Text>
          <Text fw={600} className="viz-num">
            {fmtMoney(x.toContractEnd, x.currency)}
          </Text>
          <Text size="xs" c="dimmed">
            {t('commitments.totalExit', { amount: fmtMoney(x.toEarliestExit, x.currency), thisYear: fmtMoney(x.owedThisYear, x.currency) })}
          </Text>
        </Paper>
      ))}
    </SimpleGrid>
  );
}

/** A service's cost plan, section Contracts: the contracts the service pays, what they owe, and "Add payments". */
export function ServiceContracts({ serviceId, canEdit }: { serviceId: string; canEdit: boolean }) {
  const { t } = useTranslation('costs');
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const q = useQuery({
    queryKey: costKeys.commitments(`serviceId=${serviceId}`),
    queryFn: () => get<CostCommitments>(`/costs/commitments?serviceId=${encodeURIComponent(serviceId)}`),
  });
  const c = q.data;
  if (!c || (!c.rows.length && !canEdit)) return null;
  return (
    <Stack gap="sm" data-testid="service-contracts">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Title order={3} size="h5">
          {t('commitments.serviceTitle')}
        </Title>
        {canEdit && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} data-testid="service-contracts-add">
            {t('schedules.add')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('commitments.help')}
      </Text>
      {c.rows.length ? (
        <>
          <CommitmentsTable c={c} withService={false} testId="service-contract-rows" />
          <CommitmentTotals c={c} />
        </>
      ) : (
        <Text size="sm" c="dimmed">
          {t('commitments.noneForService')}
        </Text>
      )}
      {adding && (
        <ScheduleDialog
          serviceId={serviceId}
          schedule={null}
          onClose={() => setAdding(false)}
          onSaved={(_l: CostScheduleList) => void qc.invalidateQueries({ queryKey: costKeys.all })}
        />
      )}
    </Stack>
  );
}

/** The supplier page: per contract its schedules and what they owe, the supplier's total, and what was incurred with it. */
export function SupplierCosts({ supplierId }: { supplierId: string }) {
  const { t } = useTranslation('costs');
  const q = useQuery({
    queryKey: costKeys.commitments(`supplierId=${supplierId}`),
    queryFn: () => get<CostCommitments>(`/costs/commitments?supplierId=${encodeURIComponent(supplierId)}`),
  });
  const c = q.data;
  if (!c || (!c.rows.length && !c.incurred?.length)) return null;
  return (
    <Stack gap="xs" data-testid="supplier-costs">
      <Group gap="xs">
        <IconCalendarDollar size={16} aria-hidden />
        <Text fw={600}>{t('commitments.supplierTitle')}</Text>
      </Group>
      <Text size="xs" c="dimmed">
        {t('commitments.supplierHelp')}
      </Text>
      {c.rows.length > 0 && <CommitmentsTable c={c} testId="supplier-commitment-rows" />}
      <CommitmentTotals c={c} />
      {c.incurred && c.incurred.length > 0 && (
        <Stack gap={2} data-testid="supplier-incurred">
          <Text size="sm" fw={500}>
            {t('commitments.incurred')}
          </Text>
          {c.incurred.map((x) => (
            <Text key={`${x.fiscalYear}|${x.currency}`} size="sm">
              {x.label}: <span className="viz-num">{fmtMoney(x.amount, x.currency)}</span>
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** A note above the tables: scheduled payments, not liabilities. */
export function CommitmentsNote({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('costs');
  return (
    <Alert color="gray" variant="light" icon={<IconCalendarDollar size={16} />}>
      {t('commitments.note')}
      {children}
    </Alert>
  );
}
