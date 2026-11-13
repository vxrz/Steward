import { useMemo, useState } from 'react';
import { Alert, Badge, Group, Loader, Select, SimpleGrid, Stack, Table, Text, Tooltip } from '@mantine/core';
import { IconCircleCheck, IconCircleDashed, IconCircleMinus, IconCircleX, IconInfoCircle, type Icon } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataProduct, DataScorecardState, ProductCost } from '@sm/shared';
import { ErrorState } from '../../components/common';
import { TableScroll } from '../../components/TableScroll';
import { fmtNumber, numberFormat } from '../../format';
import { usePlatforms, useProductCosts, type DataProductScorecard } from './api';
import { EnvironmentSwitch, Fact, Section, useEnvironmentParam } from './parts';
import type { UseQueryResult } from '@tanstack/react-query';

/** An amount in micros as money in its currency (UI language). */
export function money(micros: number, currency: string): string {
  try {
    return numberFormat({ style: 'currency', currency, maximumFractionDigits: 0 }).format(micros / 1e6);
  } catch {
    return `${fmtNumber(Math.round(micros / 1e6))} ${currency}`;
  }
}

/** The months to choose from: this one and the eleven before it (YYYY-MM), the last full month first. */
function months(): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = 0; i < 12; i++) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return [out[1]!, out[0]!, ...out.slice(2)];
}

/** The answer of a route that is not there yet (WP4 brings the costs and the scorecard). */
function NotAvailable({ what }: { what: 'costs' | 'scorecard' }) {
  const { t } = useTranslation('dataProducts');
  return (
    <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} data-testid={`${what}-not-available`}>
      {t(`notAvailable.${what}`)}
    </Alert>
  );
}

/**
 * The costs of a product (ADR 0036 part 11): an attribution of the cost lines Steward reads – showback, never
 * chargeback. Lines only this product matches are direct; shared lines are split by their allocation's rule. A part the
 * reader may not see makes the total incomplete, never a figure from which it could be computed.
 */
export function ProductCostsTab({ p }: { p: DataProduct }) {
  const { t } = useTranslation('dataProducts');
  const [environment, setEnvironment] = useEnvironmentParam(p.environments);
  const choices = useMemo(months, []);
  const [month, setMonth] = useState(choices[0]!);
  const q = useProductCosts(p.id, environment, month);
  const platforms = usePlatforms();
  const platformName = (id: string) => platforms.data?.find((x) => x.id === id)?.name ?? t('hidden.platform');
  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Text size="sm" c="dimmed" maw={640}>
          {t('costs.help')}
        </Text>
        <Group gap="sm" align="flex-end">
          <EnvironmentSwitch names={p.environments} value={environment} onChange={setEnvironment} testId="costs-environment" />
          <Select size="xs" label={t('costs.month')} data={choices} value={month} onChange={(m) => m && setMonth(m)} allowDeselect={false} w={130} />
        </Group>
      </Group>
      {q.isLoading && <Loader size="sm" />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data === null && <NotAvailable what="costs" />}
      {q.data && <CostView c={q.data} platformName={platformName} />}
      <ValueAndCosts p={p} environment={environment} withCosts={false} />
    </Stack>
  );
}

function CostView({ c, platformName }: { c: ProductCost; platformName: (id: string) => string }) {
  const { t } = useTranslation('dataProducts');
  return (
    <Section title={t('costs.title', { month: c.month })} testId="costs">
      <Stack gap="sm">
        <Group gap="lg" wrap="wrap">
          {c.totals.length ? (
            c.totals.map((x) => (
              <Fact key={x.currency} label={t('costs.total', { currency: x.currency })}>
                <Text fw={600} size="lg">
                  {money(x.amountMicros, x.currency)}
                </Text>
              </Fact>
            ))
          ) : (
            <Text size="sm" c="dimmed">
              {t('costs.none')}
            </Text>
          )}
        </Group>
        {(c.incomplete || c.amountsHidden) && (
          <Alert variant="light" color="orange" p="xs" data-testid="costs-incomplete">
            {t('costs.incomplete')}
          </Alert>
        )}
        {c.lines.length > 0 && (
          <TableScroll>
            <Table fz="sm" aria-label={t('costs.lines')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">{t('costs.platform')}</Table.Th>
                  <Table.Th scope="col">{t('costs.kind')}</Table.Th>
                  <Table.Th scope="col">{t('costs.share')}</Table.Th>
                  <Table.Th scope="col" ta="right">
                    {t('costs.amount')}
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {c.lines.map((l, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>{platformName(l.platformId)}</Table.Td>
                    <Table.Td>{l.kind === 'direct' ? t('costs.direct') : t('costs.shareBy', { rule: t(`costs.rules.${l.rule ?? 'equal'}`) })}</Table.Td>
                    <Table.Td>{fmtNumber(l.share * 100, { maximumFractionDigits: 1 })} %</Table.Td>
                    <Table.Td ta="right" className="nowrap">
                      {money(l.amountMicros, l.currency)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableScroll>
        )}
        <Text size="xs" c="dimmed">
          {t('costs.showback')}
        </Text>
      </Stack>
    </Section>
  );
}

/** The product's business value beside its attributed costs of last month – never a ratio (decision 30). */
export function ValueAndCosts({ p, environment, withCosts = true }: { p: DataProduct; environment: string; withCosts?: boolean }) {
  const { t } = useTranslation('dataProducts');
  const last = useMemo(() => months()[0]!, []);
  const q = useProductCosts(p.id, environment, last);
  const hasValue = p.valueStatement || p.valueTier || p.valueAmount !== null;
  const costText = !withCosts
    ? null
    : q.isLoading
      ? '…'
      : q.data === null || q.error
        ? t('notAvailable.short')
        : q.data && q.data.totals.length
          ? q.data.totals.map((x) => money(x.amountMicros, x.currency)).join(' + ') + (q.data.incomplete ? ` (${t('costs.incompleteShort')})` : '')
          : t('costs.none');
  return (
    <Section title={withCosts ? t('value.titleWithCosts') : t('value.title')} testId="product-value">
      {hasValue ? (
        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          <Fact label={t('form.valueTier')}>{p.valueTier ? t(`valueTier.${p.valueTier}`) : '–'}</Fact>
          <Fact label={t('form.valueAmount')}>{p.valueAmount !== null && p.valueCurrency ? t('value.perYear', { amount: money(p.valueAmount, p.valueCurrency) }) : '–'}</Fact>
          {p.valueStatement && (
            <div style={{ gridColumn: '1 / -1' }}>
              <Fact label={t('form.valueStatement')}>{p.valueStatement}</Fact>
            </div>
          )}
        </SimpleGrid>
      ) : (
        <Text size="sm" c="dimmed">
          {t('value.none')}
        </Text>
      )}
      {withCosts && (
        <Text size="sm" mt="sm" data-testid="product-costs-line">
          {t('value.costsLastMonth', { month: last, costs: costText })}
        </Text>
      )}
    </Section>
  );
}

const STATE_ICON: Record<DataScorecardState, { icon: Icon; color: string }> = {
  met: { icon: IconCircleCheck, color: 'green' },
  partial: { icon: IconCircleMinus, color: 'yellow' },
  notMet: { icon: IconCircleX, color: 'red' },
  noEvidence: { icon: IconCircleDashed, color: 'gray' },
  notApplicable: { icon: IconCircleDashed, color: 'gray' },
};

/** The scorecard of a product in an environment (ADR 0036 part 13): its parts and ISO/IEC 25012 dimensions with their evidence, and the maturity they give. */
export function ScorecardPanel({ query, environment }: { query: UseQueryResult<DataProductScorecard | null>; environment: string }) {
  const { t } = useTranslation('dataProducts');
  const s = query.data;
  const evidence = (e: { key: string; values?: Record<string, string | number> }) => t(`scorecard.evidence.${e.key}` as 'scorecard.title', { ...(e.values ?? {}), defaultValue: e.key });
  return (
    <Section
      title={t('scorecard.title')}
      testId="product-scorecard"
      actions={
        s && (
          <Tooltip label={t('scorecard.maturityHelp')} multiline w={280}>
            <Badge variant="light" color={s.maturity >= 3 ? 'green' : s.maturity >= 1 ? 'blue' : 'gray'} tt="none" data-testid="product-maturity">
              {t('scorecard.maturity', { level: s.maturity, name: t(`scorecard.levels.${s.maturity}`) })}
            </Badge>
          </Tooltip>
        )
      }
    >
      {query.isLoading && <Loader size="sm" />}
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {s === null && <NotAvailable what="scorecard" />}
      {s && (
        <Stack gap="sm">
          {environment && (
            <Text size="xs" c="dimmed">
              {t('scorecard.in', { environment })}
            </Text>
          )}
          {(['part', 'iso25012'] as const).map((g) => {
            const parts = s.parts.filter((x) => x.group === g);
            if (!parts.length) return null;
            return (
              <div key={g}>
                <Text size="sm" fw={600} mb={4}>
                  {t(`scorecard.groups.${g}`)}
                </Text>
                <Stack gap={4}>
                  {parts.map((x) => {
                    const st = STATE_ICON[x.state];
                    return (
                      <Group key={x.id} gap="xs" wrap="nowrap" align="flex-start">
                        <st.icon size={16} color={`var(--mantine-color-${st.color}-6)`} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                        <div>
                          <Text size="sm">
                            {t(`scorecard.parts.${x.id}`)} – {t(`scorecard.states.${x.state}`)}
                          </Text>
                          {x.evidence.length > 0 && (
                            <Text size="xs" c="dimmed">
                              {x.evidence.map(evidence).join(' · ')}
                            </Text>
                          )}
                        </div>
                      </Group>
                    );
                  })}
                </Stack>
              </div>
            );
          })}
        </Stack>
      )}
    </Section>
  );
}
