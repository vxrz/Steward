import { useState } from 'react';
import { Anchor, Badge, Group, Select, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CostAttribution, CostScheduleBilling } from '@sm/shared';
import { get } from '../../api';
import { fmtDay } from '../../format';
import { costKeys } from '../../queryKeys';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { fmtMoney } from './common';

/**
 * "Costs and contracts" of an application or system (0.19.0, ADR 0032 part 1, docs/COSTS.md): attribution, not a plan
 * – the contracts that name it or that its lines, entries and schedules pay for, and those lines, entries and schedules
 * of the services that use it, each counted once, with totals per fiscal year and currency. Read-only; only what the
 * reader may see, amounts as the service's "Hide amounts from viewers" allows.
 */
export function CostAttributionPanel({ kind, id }: { kind: 'application' | 'system'; id: string }) {
  const { t } = useTranslation('costs');
  const [year, setYear] = useState<number | null>(null);
  const q = useQuery({
    queryKey: costKeys.attribution(kind, id, year),
    queryFn: () => get<CostAttribution>(`/costs/attribution/${kind}/${encodeURIComponent(id)}${year ? `?fiscalYear=${year}` : ''}`),
  });
  const d = q.data;
  const count = d ? d.contracts.length + d.lines.length + d.entries.length + d.schedules.length : 0;
  return (
    <CollapsibleSection
      id={`${kind}-costs`}
      collapseOnPhone
      testId={`${kind}-costs`}
      size="h5"
      title={t('attribution.title')}
      count={count}
      defaultOpen={count > 0}
    >
      {!d ? null : (
        <Stack gap="sm" data-testid="cost-attribution">
          <Group justify="space-between" align="flex-end" wrap="wrap" gap="xs">
            <Text size="xs" c="dimmed" maw={560}>
              {t(`attribution.help.${kind}`)}
            </Text>
            <Select
              size="xs"
              w={150}
              label={t('plan.year')}
              allowDeselect={false}
              data={d.years.map((y) => ({ value: String(y.fiscalYear), label: y.label }))}
              value={String(d.fiscalYear)}
              onChange={(v) => v && setYear(Number(v))}
              data-testid="attribution-year"
            />
          </Group>
          {d.amountsHidden && (
            <Text size="xs" c="dimmed">
              {t('attribution.amountsHidden')}
            </Text>
          )}
          {d.totals.length > 0 && (
            <Table.ScrollContainer minWidth={360}>
              <Table striped withTableBorder fz="sm" data-testid="attribution-totals">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('attribution.columns.year')}</Table.Th>
                    <Table.Th>{t('attribution.columns.currency')}</Table.Th>
                    <Table.Th ta="right">{t('plan.columns.planned')}</Table.Th>
                    <Table.Th ta="right">{t('attribution.columns.incurred')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {d.totals.map((x) => (
                    <Table.Tr key={`${x.fiscalYear}|${x.currency}`}>
                      <Table.Td>{x.label}</Table.Td>
                      <Table.Td>{x.currency}</Table.Td>
                      <Table.Td ta="right" className="viz-num">
                        {fmtMoney(x.planned, x.currency)}
                      </Table.Td>
                      <Table.Td ta="right" className="viz-num">
                        {fmtMoney(x.incurred, x.currency)}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          {d.contracts.length > 0 && (
            <Stack gap={4} data-testid="attribution-contracts">
              <Text size="sm" fw={600}>
                {t('attribution.contracts')}
              </Text>
              {d.contracts.map((c) => (
                <Group key={c.id} gap={6} wrap="wrap">
                  {c.supplier && (
                    <Anchor component={Link} to={`/suppliers/${c.supplier.id}/contracts/${c.id}`} size="sm">
                      {c.supplier.name} · {c.title}
                    </Anchor>
                  )}
                  {c.named ? (
                    <Badge size="xs" variant="light">
                      {t('attribution.named', { services: c.services.map((s) => s.name).join(', ') })}
                    </Badge>
                  ) : (
                    <Badge size="xs" variant="light" color="gray">
                      {t('attribution.viaLines')}
                    </Badge>
                  )}
                  {c.endsOn && (
                    <Text size="xs" c="dimmed">
                      {t('attribution.endsOn', { date: fmtDay(c.endsOn) })}
                    </Text>
                  )}
                </Group>
              ))}
            </Stack>
          )}
          {d.lines.length > 0 && (
            <Stack gap={4} data-testid="attribution-lines">
              <Text size="sm" fw={600}>
                {t('attribution.lines', { label: d.label })}
              </Text>
              {d.lines.map((l) => (
                <Text key={l.id} size="sm">
                  <Anchor component={Link} to={`/services/${l.serviceId}/costs`} size="sm">
                    {l.serviceName}
                  </Anchor>
                  {' · '}
                  {l.title} · {t(`plan.cadences.${l.cadence}`)} · <span className="viz-num">{fmtMoney(l.planned, l.currency)}</span>
                  {l.contractHidden ? ` · ${t('commitments.hiddenContract')}` : ''}
                </Text>
              ))}
            </Stack>
          )}
          {d.schedules.length > 0 && (
            <Stack gap={4} data-testid="attribution-schedules">
              <Text size="sm" fw={600}>
                {t('attribution.schedules')}
              </Text>
              {d.schedules.map((x) => (
                <Text key={x.id} size="sm">
                  {x.serviceName} · {x.contract ? `${x.contract.title} – ` : ''}
                  {x.title} · {t(`schedules.billings.${x.billing as CostScheduleBilling}`)} · <span className="viz-num">{fmtMoney(x.amount, x.currency)}</span>
                </Text>
              ))}
            </Stack>
          )}
          {d.entries.length > 0 && (
            <Stack gap={4} data-testid="attribution-entries">
              <Text size="sm" fw={600}>
                {t('attribution.entries', { label: d.label, count: d.entries.length })}
              </Text>
              {d.entries.slice(0, 50).map((e) => (
                <Text key={e.id} size="sm">
                  {fmtDay(e.date)} · {e.serviceName} · <span className="viz-num">{fmtMoney(e.amount, e.currency)}</span>
                  {e.planLineTitle ? ` · ${e.planLineTitle}` : ''}
                  {e.reference ? ` · ${e.reference}` : ''}
                </Text>
              ))}
            </Stack>
          )}
          {count === 0 && (
            <Text size="sm" c="dimmed">
              {t(`attribution.empty.${kind}`)}
            </Text>
          )}
        </Stack>
      )}
    </CollapsibleSection>
  );
}
