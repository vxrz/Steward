import { useState } from 'react';
import { Anchor, Badge, Group, Paper, Select, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CostPlanTeamYear } from '@sm/shared';
import { get } from '../../api';
import { QueryState } from '../common';
import { costKeys } from '../../queryKeys';
import { fmtMoney } from './common';
import { Difference } from './ServicePlan';

/**
 * The cost plans of a team's services in one fiscal year (ADR 0026): per service and currency planned, incurred to
 * date, expected and the difference, and the sums per currency – never across currencies. A service of several teams
 * counts for each of them (marked).
 */
export function TeamCostPlan({ teamId }: { teamId: string }) {
  const { t } = useTranslation('costs');
  const phone = useMediaQuery('(max-width: 48em)');
  const [year, setYear] = useState<number | null>(null);
  const q = useQuery({
    queryKey: costKeys.teamPlan(teamId, year),
    queryFn: () => get<CostPlanTeamYear>(`/costs/team-plans/${encodeURIComponent(teamId)}${year ? `?fiscalYear=${year}` : ''}`),
  });
  const d = q.data;
  if (!d) return <QueryState query={q} />;
  const rows = d.services.flatMap((s) => s.currencies.map((c) => ({ s, c, key: `${s.id}|${c.currency}` })));
  const name = (s: CostPlanTeamYear['services'][number]) => (
    <Group gap={6} wrap="wrap">
      <Anchor component={Link} to={`/services/${s.id}/costs`} size="sm">
        {s.name}
      </Anchor>
      {s.shared && (
        <Badge size="xs" variant="light" color="gray">
          {t('plan.team.shared')}
        </Badge>
      )}
      {s.cloud === 'hidden' && (
        <Badge size="xs" variant="light" color="gray">
          {t('plan.team.cloudHidden')}
        </Badge>
      )}
    </Group>
  );
  return (
    <Paper withBorder p="md" data-testid="team-cost-plan">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm" mb="xs">
        <div style={{ minWidth: 0 }}>
          <Title order={2} size="h4">
            {t('plan.team.title')}
          </Title>
          <Text size="xs" c="dimmed" maw={640}>
            {t('plan.team.hint')}
          </Text>
        </div>
        <Select
          label={t('plan.year')}
          w={170}
          allowDeselect={false}
          data={d.years.map((y) => ({ value: String(y.fiscalYear), label: y.label }))}
          value={String(d.fiscalYear)}
          onChange={(v) => v && setYear(Number(v))}
        />
      </Group>
      {!rows.length ? (
        <Text size="sm" c="dimmed">
          {t('plan.team.none', { label: d.label })}
        </Text>
      ) : phone ? (
        <Stack gap="xs">
          {rows.map(({ s, c, key }) => (
            <div key={key}>
              {name(s)}
              <Text size="xs" c="dimmed" className="viz-num" component="div">
                {t('plan.columns.planned')}: {fmtMoney(c.planned, c.currency)} · {t('plan.columns.incurredToDate')}: {fmtMoney(c.incurredToDate, c.currency)}
                {' · '}
                {t('plan.columns.expected')}: {fmtMoney(c.expected, c.currency)}
              </Text>
              <Text size="xs" c="dimmed" component="div">
                {t('plan.columns.difference')}: <Difference v={c.difference} currency={c.currency} />
              </Text>
            </div>
          ))}
        </Stack>
      ) : (
        <Table.ScrollContainer minWidth={560}>
          <Table fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('plan.team.service')}</Table.Th>
                <Table.Th>{t('columns.currency')}</Table.Th>
                <Table.Th ta="right">{t('plan.columns.planned')}</Table.Th>
                <Table.Th ta="right">{t('plan.columns.incurredToDate')}</Table.Th>
                <Table.Th ta="right">{t('plan.columns.expected')}</Table.Th>
                <Table.Th ta="right">{t('plan.columns.difference')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map(({ s, c, key }) => (
                <Table.Tr key={key}>
                  <Table.Td>{name(s)}</Table.Td>
                  <Table.Td>{c.currency}</Table.Td>
                  <Table.Td ta="right" className="viz-num">
                    {fmtMoney(c.planned, c.currency)}
                  </Table.Td>
                  <Table.Td ta="right" className="viz-num">
                    {fmtMoney(c.incurredToDate, c.currency)}
                  </Table.Td>
                  <Table.Td ta="right" className="viz-num">
                    {fmtMoney(c.expected, c.currency)}
                  </Table.Td>
                  <Table.Td ta="right">
                    <Difference v={c.difference} currency={c.currency} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {d.totals.length > 0 && (
        <Group gap="lg" mt="sm" wrap="wrap" data-testid="team-plan-totals">
          {d.totals.map((x) => (
            <div key={x.currency}>
              <Text size="xs" c="dimmed">
                {t('plan.team.totals', { currency: x.currency })}
              </Text>
              <Text size="sm" fw={600} className="viz-num">
                {t('plan.team.totalsLine', { planned: fmtMoney(x.planned, x.currency), expected: fmtMoney(x.expected, x.currency) })}
              </Text>
            </div>
          ))}
        </Group>
      )}
    </Paper>
  );
}
