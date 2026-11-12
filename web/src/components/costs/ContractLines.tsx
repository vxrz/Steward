import { useState } from 'react';
import { Alert, Button, Checkbox, Group, Paper, Stack, Table, Text, VisuallyHidden } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconCalendarDollar, IconRefresh } from '@tabler/icons-react';
import type { CostPlanYear, CostProposalLine, CostProposals } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { costKeys } from '../../queryKeys';
import { fmtDay } from '../../format';
import { fmtMoney, fmtMonth, ownerKey, type PlanOwner } from './common';

/** The API path of a cost plan (a service's or a platform's) – spelled out in this file so the route contract test follows it. */
const planBase = (o: PlanOwner): string =>
  o.kind === 'service' ? `/costs/plans/${encodeURIComponent(o.id)}` : `/costs/platform-plans/${encodeURIComponent(o.id)}`;

/**
 * The contract lines of a service's cost plan (0.18.0, ADR 0030 part 3): "Contract payments to plan" – the payment
 * schedules with payments in the year and no lines for it, added in one step ("Add to plan"); "Contract changed" –
 * the lines whose proposal changed, before and after, applied in one step ("Update lines"); and the quiet rows of
 * payments prepaid in an earlier fiscal year. Nothing is created or rewritten without a person.
 */

type Tt = (k: string, o?: Record<string, unknown>) => string;

/** "Monthly, Feb 2026 – Sep 2026: 1,000.00 EUR" */
export function proposalText(t: Tt, l: CostProposalLine, currency: string): string {
  const when =
    l.cadence === 'once'
      ? l.onceMonth
        ? t('plan.cadenceOnceIn', { month: fmtMonth(l.onceMonth) })
        : t('plan.cadences.once')
      : l.fromMonth && l.toMonth
        ? t('plan.cadenceSpan', { cadence: t(`plan.cadences.${l.cadence}`), from: fmtMonth(l.fromMonth), to: fmtMonth(l.toMonth) })
        : t(`plan.cadences.${l.cadence}`);
  const covers = l.coversFrom && l.coversTo ? ` · ${t('plan.covers', { from: fmtDay(l.coversFrom), to: fmtDay(l.coversTo) })}` : '';
  return `${when}: ${fmtMoney(l.amount, currency)}${covers}`;
}

export function ProposalsPanel({ d, onSaved }: { d: CostPlanYear; onSaved: (y: CostPlanYear) => void }) {
  const { t } = useTranslation('costs');
  const tt = t as unknown as Tt;
  const q = useQuery({
    queryKey: costKeys.proposals(ownerKey(d.owner), d.fiscalYear),
    queryFn: () => get<CostProposals>(`${planBase(d.owner)}/proposals?fiscalYear=${d.fiscalYear}`),
  });
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const p = q.data;
  if (!p || !p.proposals.length) return null;
  const selected = chosen ?? new Set(p.proposals.map((x) => x.scheduleId));
  const add = async () => {
    setBusy(true);
    try {
      onSaved(await post<CostPlanYear>(`${planBase(d.owner)}/proposals`, { fiscalYear: d.fiscalYear, scheduleIds: [...selected] }));
      notifyOk(t('contractLines.added'));
      setChosen(null);
    } catch (e) {
      notifyError(e, t('contractLines.notAdded'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert
      icon={<IconCalendarDollar size={16} />}
      color="blue"
      variant="light"
      title={t('contractLines.toPlan', { label: d.label })}
      data-testid="plan-proposals"
    >
      <Stack gap="xs">
        <Text size="xs">{t('contractLines.toPlanHelp')}</Text>
        {p.proposals.map((x) => (
          <Checkbox
            key={x.scheduleId}
            checked={selected.has(x.scheduleId)}
            disabled={!p.canEdit}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.currentTarget.checked) next.add(x.scheduleId);
              else next.delete(x.scheduleId);
              setChosen(next);
            }}
            label={
              <span>
                <Text span size="sm" fw={500}>
                  {x.contractHidden ? t('contractLines.hiddenContract', { title: x.title }) : x.title}
                </Text>
                {x.lines.map((l) => (
                  <Text key={l.part} size="xs" c="dimmed" component="div">
                    {proposalText(tt, l, x.currency)}
                  </Text>
                ))}
              </span>
            }
            data-testid="plan-proposal"
          />
        ))}
        {p.canEdit && (
          <Group>
            <Button size="xs" onClick={() => void add()} loading={busy} disabled={!selected.size} data-testid="plan-proposals-add">
              {t('contractLines.addToPlan', { count: selected.size })}
            </Button>
          </Group>
        )}
      </Stack>
    </Alert>
  );
}

export function ChangesPanel({ d, onSaved }: { d: CostPlanYear; onSaved: (y: CostPlanYear) => void }) {
  const { t } = useTranslation('costs');
  const tt = t as unknown as Tt;
  const all = d.contractChanges.flatMap((s) => s.changes.map((c) => `${s.scheduleId}|${c.part}`));
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  if (!d.contractChanges.length) return null;
  const selected = chosen ?? new Set(all);
  const currencyOf = (lineId: string | null) => d.lines.find((l) => l.id === lineId)?.currency ?? d.currencies[0]?.currency ?? '';
  const apply = async () => {
    setBusy(true);
    try {
      onSaved(
        await post<CostPlanYear>(`${planBase(d.owner)}/contract-updates`, {
          fiscalYear: d.fiscalYear,
          changes: [...selected].map((k) => ({ scheduleId: k.slice(0, k.indexOf('|')), part: k.slice(k.indexOf('|') + 1) })),
        }),
      );
      notifyOk(t('contractLines.updated'));
      setChosen(null);
    } catch (e) {
      notifyError(e, t('contractLines.notUpdated'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper withBorder p="md" data-testid="plan-contract-changes">
      <Stack gap="sm">
        <Group gap="xs">
          <IconRefresh size={16} aria-hidden />
          <Text fw={600}>{t('contractLines.changedTitle')}</Text>
        </Group>
        <Text size="xs" c="dimmed">
          {t('contractLines.changedHelp')}
        </Text>
        {d.contractChanges.map((s) => (
          <Stack key={s.scheduleId} gap={4}>
            <Text size="sm" fw={500}>
              {s.title}
            </Text>
            <Table.ScrollContainer minWidth={420}>
              <Table fz="sm" withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={40}>
                      <VisuallyHidden>{t('contractLines.choose')}</VisuallyHidden>
                    </Table.Th>
                    <Table.Th>{t('contractLines.before')}</Table.Th>
                    <Table.Th>{t('contractLines.after')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {s.changes.map((c) => {
                    const k = `${s.scheduleId}|${c.part}`;
                    const currency = currencyOf(c.lineId);
                    return (
                      <Table.Tr key={k} data-testid="plan-contract-change">
                        <Table.Td>
                          <Checkbox
                            aria-label={t('contractLines.chooseChange', { title: s.title })}
                            checked={selected.has(k)}
                            disabled={!d.canEdit}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.currentTarget.checked) next.add(k);
                              else next.delete(k);
                              setChosen(next);
                            }}
                          />
                        </Table.Td>
                        <Table.Td>
                          {c.before ? (
                            proposalText(tt, c.before, currency)
                          ) : (
                            <Text span size="sm" c="dimmed">
                              {t('contractLines.newLine')}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          {c.after ? (
                            proposalText(tt, c.after, currency)
                          ) : (
                            <Text span size="sm" c="orange">
                              {c.entries ? t('contractLines.goneWithEntries', { count: c.entries }) : t('contractLines.gone')}
                            </Text>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Stack>
        ))}
        {d.canEdit && (
          <Group>
            <Button size="xs" onClick={() => void apply()} loading={busy} disabled={!selected.size} data-testid="plan-update-lines">
              {t('contractLines.update', { count: selected.size })}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

/** Payments of earlier fiscal years that cover part of this one: shown, not counted (no amortisation). */
export function PrepaidRows({ d }: { d: CostPlanYear }) {
  const { t } = useTranslation('costs');
  if (!d.prepaid.length) return null;
  return (
    <Stack gap={2} data-testid="plan-prepaid">
      {d.prepaid.map((p) => (
        <Text key={p.lineId} size="sm" c="dimmed">
          {t('contractLines.prepaid', {
            label: p.label,
            title: p.title,
            amount: fmtMoney(p.amount, p.currency),
            from: fmtDay(p.coversFrom),
            to: fmtDay(p.coversTo),
          })}
        </Text>
      ))}
    </Stack>
  );
}
