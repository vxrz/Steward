import { useState, type ReactNode } from 'react';
import { Alert, Anchor, Badge, Button, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle, IconCalendarDollar, IconPlus } from '@tabler/icons-react';
import type { CostCommitment, CostCommitments, CostScheduleList } from '@sm/shared';
import { get } from '../../api';
import { DataTable, type DataColumn } from '../DataTable';
import { costKeys } from '../../queryKeys';
import { fmtDay, listFormat } from '../../format';
import { fmtMoney, fmtMonth, planPath, type PlanOwner } from './common';
import { ScheduleDialog } from './ContractPayments';
import { VolumeUse, VolumeWarningBadge } from './Volumes';

/**
 * Commitments (0.18.0, ADR 0030 part 5, docs/COSTS.md#commitments): what supplier contracts still owe under their
 * payment schedules – scheduled payments dated today or later, to contract end and to the earliest exit, per fiscal
 * year and per currency (never converted, entries not subtracted). Three places: a service's or (0.19.0) a platform's
 * cost plan (its Contracts), Costs → Commitments and the supplier page. A volume (ADR 0032) owes only what is committed;
 * what it may bill beyond that is "up to …", never part of what is owed.
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
        className="badge-wrap"
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

/** Who pays a row: the service's cost plan, or (0.19.0) the platform's. */
export function PayerLink({ r }: { r: CostCommitment }) {
  return (
    <Anchor component={Link} to={planPath(r.payer)} size="xs" data-testid="commitment-payer">
      {r.payer.name}
    </Anchor>
  );
}

/** Badges of a row: Contract changed, the months not booked, the warnings of a volume. */
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
      {r.volume?.warnings.map((w) => (
        <VolumeWarningBadge key={w} w={w} runsOutOn={r.volume?.runsOutOn ?? null} />
      ))}
    </>
  );
}

/** An amount with the day it runs to as a dimmed second line (no tooltip: keyboard and touch read it too). */
function UntilCell({ r, v, until }: { r: CostCommitment; v: string | null; until: string | null }) {
  const { t } = useTranslation('costs');
  return (
    <Stack gap={0}>
      {money(r, v)}
      <Text size="xs" c="dimmed">
        {until ? t('commitments.until', { date: fmtDay(until) }) : r.contractHidden ? t('commitments.hiddenDates') : ''}
      </Text>
    </Stack>
  );
}

/** A row that still owes something (or may bill, warns, or is a volume still in use): paid schedules are folded away. */
const owes = (r: CostCommitment, today: string) =>
  !r.amountsVisible ||
  Number(r.toContractEnd ?? 0) !== 0 ||
  Number(r.upTo ?? 0) !== 0 ||
  !!r.warning ||
  !!r.volume?.warnings.length ||
  (!!r.volume && r.volume.period.to >= today);

/**
 * The commitments as a table (cards on a phone): per schedule what it owes to contract end and to the earliest exit
 * and the notice-by date first (0.19 review M9), then the billing, the next payment, the fiscal-year columns, later and
 * a volume's use; schedules that owe nothing any more behind "Show paid schedules".
 */
export function CommitmentsTable({ c, withService = true, testId = 'commitment-rows' }: { c: CostCommitments; withService?: boolean; testId?: string }) {
  const { t } = useTranslation('costs');
  const [paid, setPaid] = useState(false);
  const done = c.rows.filter((r) => !owes(r, c.today)).length;
  const rows = paid ? c.rows : c.rows.filter((r) => owes(r, c.today));
  const volumes = c.rows.some((r) => r.volume);
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
          {withService && <PayerLink r={r} />}
        </Stack>
      ),
    },
    {
      key: 'toEnd',
      header: t('commitments.columns.toContractEnd'),
      cell: (r) => <UntilCell r={r} v={r.toContractEnd} until={r.contractEnd} />,
      sortValue: (r) => Number(r.toContractEnd ?? ''),
      nowrap: true,
    },
    {
      key: 'toExit',
      header: t('commitments.columns.toEarliestExit'),
      cell: (r) => <UntilCell r={r} v={r.toEarliestExit} until={r.earliestExit} />,
      sortValue: (r) => Number(r.toEarliestExit ?? ''),
      nowrap: true,
    },
    { key: 'notice', header: t('commitments.columns.noticeBy'), cell: (r) => <NoticeWarning r={r} />, sortValue: (r) => r.noticeBy ?? '' },
    ...(volumes
      ? [
          {
            key: 'volume',
            header: t('volumes.column'),
            cell: (r: CostCommitment) => (r.volume ? <VolumeUse v={r.volume} upTo={r.upTo} /> : '–'),
          },
        ]
      : []),
    { key: 'billing', header: t('commitments.columns.billing'), cell: (r) => billingText(t, r), nowrap: true },
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
      {withService && <PayerLink r={r} />}
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
        {r.upTo !== null && (
          <>
            <Text size="xs" c="dimmed">
              {t('volumes.upToLabel')}
            </Text>
            <Text size="xs" ta="right">
              {money(r, r.upTo)}
            </Text>
          </>
        )}
      </SimpleGrid>
      {r.volume && <VolumeUse v={r.volume} upTo={null} />}
      {r.warning ? (
        <NoticeWarning r={r} />
      ) : r.noticeBy ? (
        <Text size="xs" data-testid="commitment-notice-by">
          {t('commitments.noticeByLine', { date: fmtDay(r.noticeBy) })}
        </Text>
      ) : null}
    </Stack>
  );
  return (
    <Stack gap="xs">
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.scheduleId} ariaLabel={t('commitments.title')} card={card} testId={testId} />
      {done > 0 && (
        <Group>
          <Button size="compact-xs" variant="subtle" onClick={() => setPaid((v) => !v)} aria-pressed={paid} data-testid="commitments-show-paid">
            {paid ? t('commitments.hidePaid') : t('commitments.showPaid', { count: done })}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

/** "Monthly · EUR", or for a volume "Volume, prepaid · USD" (sentence case: the cell starts with it). */
function billingText(t: (k: string) => string, r: CostCommitment): string {
  return `${t(`commitments.billingCell.${r.volume ? r.volume.billing : r.billing}`)} · ${r.currency}`;
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
          {Number(x.upTo) !== 0 && (
            <Text size="xs" c="dimmed" data-testid="commitment-total-up-to">
              {t('volumes.upToTotal', { amount: fmtMoney(x.upTo, x.currency) })}
            </Text>
          )}
        </Paper>
      ))}
    </SimpleGrid>
  );
}

/** A cost plan's section Contracts: the contracts the service (or platform, 0.19.0) pays, what they owe, and "Add payments". */
export function ServiceContracts({ owner, canEdit }: { owner: PlanOwner; canEdit: boolean }) {
  const { t } = useTranslation('costs');
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const qs = `${owner.kind === 'service' ? 'serviceId' : 'platformId'}=${encodeURIComponent(owner.id)}`;
  const q = useQuery({
    queryKey: costKeys.commitments(qs),
    queryFn: () => get<CostCommitments>(`/costs/commitments?${qs}`),
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
          payer={owner}
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
