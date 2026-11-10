import { useState, type ReactNode } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import { Alert, Anchor, Badge, Button, Group, Modal, Paper, SimpleGrid, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconCoin, IconEyeOff, IconPencil, IconReceipt } from '@tabler/icons-react';
import { COST_SCOPES, type CostBudget, type CostCurrencySummary, type CostScope, type CostScopeDetail } from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../api';
import { EmptyState, QueryState, useFieldErrors } from '../components/common';
import { DetailPage } from '../components/page/DetailPage';
import { LinkTabs } from '../components/page/LinkTabs';
import { BudgetBadge, BudgetBar, ChangeText, fmtChange, fmtMoney, SCOPE_PATH } from '../components/costs/common';
import { CostChart, CostMonthsTable } from '../components/costs/CostChart';
import { PlatformCostSource } from '../components/costs/PlatformCostSource';
import { TeamCostPlan } from '../components/costs/TeamPlan';
import { costKeys } from '../queryKeys';
import { fmtDate, numberFormat } from '../format';
import '../components/dashboard/viz.css';

/**
 * The costs of one service, application, team or platform (#226): per currency the last 12 months and the current one
 * so far, the forecast and the trend, the budget, the costs by provider and service, and what is behind them; for a
 * platform its source – how its costs are read, FOCUS imports and push tokens.
 */
export function CostDetailPage() {
  const { t } = useTranslation('costs');
  const p = useParams();
  const scope = (COST_SCOPES as readonly string[]).includes(p.scope ?? '') ? (p.scope as CostScope) : 'service';
  const id = p.id ?? '';
  const tab = p.tab === 'source' && scope === 'platform' ? 'source' : 'overview';
  const q = useQuery({ queryKey: costKeys.detail(scope, id), queryFn: () => get<CostScopeDetail>(`/costs/${scope}/${encodeURIComponent(id)}`) });
  const d = q.data;
  const base = SCOPE_PATH(scope, id);
  const tabs =
    scope === 'platform' ? (
      <LinkTabs
        label={t('tabsLabel')}
        active={tab === 'source' ? `${base}/source` : base}
        tabs={[
          { to: base, label: t('tabs.overview') },
          { to: `${base}/source`, label: t('tabs.source'), testId: 'tab-source' },
        ]}
      />
    ) : undefined;
  const owner: Record<CostScope, string> = { service: `/services/${id}`, application: `/applications/${id}`, team: '/users', platform: `/platforms/${id}` };
  return (
    <DetailPage
      back={[{ label: t('title'), to: scope === 'service' ? '/costs' : `/costs?scope=${scope}` }]}
      title={d?.name ?? t(`scopes.${scope}`)}
      status={
        d ? (
          <Group gap={6}>
            <Badge variant="light" color="gray">
              {t(`scopes.${scope}`)}
            </Badge>
            {d.budget && <BudgetBadge state={d.budget.state} />}
          </Group>
        ) : undefined
      }
      description={t(`detailHint.${scope}`)}
      actions={
        d && scope !== 'team' ? (
          <>
            {/* the read costs and the service's cost plan link to each other (two views of one service's money) */}
            {scope === 'service' && (
              <Button
                component={Link}
                to={`/services/${id}/costs`}
                variant="default"
                size="xs"
                leftSection={<IconReceipt size={14} />}
                data-testid="open-cost-plan"
              >
                {t('open.plan')}
              </Button>
            )}
            <Button component={Link} to={owner[scope]} variant="default" size="xs">
              {t(`open.${scope}`)}
            </Button>
          </>
        ) : undefined
      }
      tabs={tabs}
      recent={d ? { label: `${t('title')}: ${d.name}`, kind: scope === 'team' ? 'service' : scope } : undefined}
    >
      <QueryState query={q} />
      {d && tab === 'overview' && <Overview d={d} />}
      {d && tab === 'source' && <PlatformCostSource platformId={id} />}
    </DetailPage>
  );
}

function Overview({ d }: { d: CostScopeDetail }) {
  const { t } = useTranslation('costs');
  const [editing, setEditing] = useState(false);
  const has = d.currencies.length > 0;
  return (
    <Stack gap="lg">
      {!d.amountsVisible && (
        <Alert icon={<IconEyeOff size={16} />} color="gray" variant="light" data-testid="amounts-hidden">
          {t('hiddenHintOne')}
        </Alert>
      )}
      {d.scope !== 'platform' && (d.budget || d.canEditBudget) && <BudgetCard d={d} onEdit={() => setEditing(true)} />}
      {!has && (
        <EmptyState icon={IconCoin} title={t('none.title')} whoCanAct={t('none.who')}>
          {t(`none.${d.scope}`)}
        </EmptyState>
      )}
      {d.currencies.map((c) => (
        <CurrencySection
          key={c.currency}
          c={c}
          budget={d.budget && d.budget.currency === c.currency && d.budget.amount !== null ? Number(d.budget.amount) : null}
        />
      ))}
      {d.scope === 'platform' && d.unassigned.length > 0 && (
        <Paper withBorder p="md" data-testid="cost-unassigned">
          <Title order={3} size="h5" mb={4}>
            {t('unassigned.title')}
          </Title>
          <Text size="xs" c="dimmed" mb="xs">
            {t('unassigned.hint')}
          </Text>
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            {d.unassigned.map((u) => (
              <Text key={u.currency} size="sm">
                {t('unassigned.line', { thisMonth: fmtMoney(u.thisMonth, u.currency), lastMonth: fmtMoney(u.lastMonth, u.currency) })}
              </Text>
            ))}
          </SimpleGrid>
        </Paper>
      )}
      {d.parts.length > 0 && (
        <Paper withBorder p="md">
          <Title order={3} size="h5" mb="xs">
            {t(d.scope === 'application' ? 'parts.platforms' : 'parts.applications')}
          </Title>
          <Breakdown
            testId="cost-parts"
            head={t(d.scope === 'application' ? 'parts.platform' : 'parts.application')}
            rows={d.parts.map((x, i) => ({
              key: `${x.kind}-${x.id ?? i}-${x.currency}`,
              label:
                x.kind === 'application' && x.id ? (
                  <Anchor component={Link} to={SCOPE_PATH('application', x.id)} size="sm">
                    {x.name}
                  </Anchor>
                ) : x.kind === 'platform' && x.id ? (
                  <Anchor component={Link} to={SCOPE_PATH('platform', x.id)} size="sm">
                    {x.name}
                  </Anchor>
                ) : x.kind === 'unassigned' ? (
                  x.name ? (
                    t('parts.unassignedOn', { name: x.name })
                  ) : (
                    t('parts.unassigned')
                  )
                ) : (
                  <Text span size="sm" c="dimmed">
                    {t('parts.other')}
                  </Text>
                ),
              thisMonth: x.thisMonth,
              lastMonth: x.lastMonth,
              currency: x.currency,
            }))}
          />
        </Paper>
      )}
      {d.byService.length > 0 && (
        <Paper withBorder p="md">
          <Title order={3} size="h5" mb="xs">
            {t('byService.title')}
          </Title>
          <Breakdown
            testId="cost-by-service"
            head={t('byService.service')}
            rows={d.byService.map((x) => ({
              key: `${x.provider}|${x.service}|${x.currency}`,
              label: x.service || '–',
              sub: [x.provider, x.category].filter(Boolean).join(' · '),
              thisMonth: x.thisMonth,
              lastMonth: x.lastMonth,
              currency: x.currency,
            }))}
          />
        </Paper>
      )}
      {d.scope === 'team' && <TeamCostPlan teamId={d.id} />}
      {d.sources.length > 0 && (
        <Text size="xs" c="dimmed" data-testid="cost-sources">
          {t('sources', {
            list: d.sources.map((s) => `${s.platformName} (${t(`sourceKinds.${s.source}`)}, ${fmtDate(s.readAt)})`).join(' · '),
          })}
        </Text>
      )}
      {editing && <BudgetDialog d={d} onClose={() => setEditing(false)} />}
    </Stack>
  );
}

interface BreakdownRow {
  key: string;
  label: ReactNode;
  sub?: string;
  thisMonth: string | null;
  lastMonth: string | null;
  currency: string;
}

/** A breakdown as a table on wide screens and as a list on phones (no sideways scrolling). */
function Breakdown({ head, rows, testId }: { head: string; rows: BreakdownRow[]; testId: string }) {
  const { t } = useTranslation('costs');
  const phone = useMediaQuery('(max-width: 48em)');
  if (phone)
    return (
      <Stack gap={0} data-testid={testId}>
        {rows.map((r, i) => (
          <Group
            key={r.key}
            justify="space-between"
            wrap="nowrap"
            gap="sm"
            py={8}
            style={i ? { borderTop: '1px solid var(--mantine-color-default-border)' } : undefined}
          >
            <div style={{ minWidth: 0 }}>
              <Text size="sm" component="div" style={{ overflowWrap: 'anywhere' }}>
                {r.label}
              </Text>
              {r.sub && (
                <Text size="xs" c="dimmed">
                  {r.sub}
                </Text>
              )}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <Text size="sm" className="viz-num">
                {fmtMoney(r.thisMonth, r.currency)}
              </Text>
              <Text size="xs" c="dimmed" className="viz-num">
                {t('lastMonthShort', { amount: fmtMoney(r.lastMonth, r.currency) })}
              </Text>
            </div>
          </Group>
        ))}
      </Stack>
    );
  return (
    <Table fz="sm" data-testid={testId}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{head}</Table.Th>
          <Table.Th ta="right">{t('columns.thisMonth')}</Table.Th>
          <Table.Th ta="right">{t('columns.lastMonth')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr key={r.key}>
            <Table.Td style={{ overflowWrap: 'anywhere' }}>
              {r.label}
              {r.sub && (
                <Text size="xs" c="dimmed">
                  {r.sub}
                </Text>
              )}
            </Table.Td>
            <Table.Td ta="right" className="viz-num">
              {fmtMoney(r.thisMonth, r.currency)}
            </Table.Td>
            <Table.Td ta="right" className="viz-num">
              {fmtMoney(r.lastMonth, r.currency)}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function CurrencySection({ c, budget }: { c: CostCurrencySummary; budget: number | null }) {
  const { t } = useTranslation('costs');
  const [table, setTable] = useState(false);
  const trend = c.trend;
  return (
    <Paper withBorder p="md" data-testid={`cost-currency-${c.currency}`}>
      <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
        <Title order={2} size="h4">
          {t('currencyTitle', { currency: c.currency })}
        </Title>
        <Button size="compact-xs" variant="subtle" onClick={() => setTable((v) => !v)} aria-pressed={table}>
          {table ? t('chart.showChart') : t('chart.showTable')}
        </Button>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 4 }} mb="md" spacing="sm">
        <Stat label={t('columns.thisMonth')} value={fmtMoney(c.thisMonth, c.currency)} />
        <Stat
          label={t('columns.forecast')}
          value={fmtMoney(c.forecast, c.currency)}
          extra={c.changePct !== null ? <ChangeText pct={c.changePct} /> : undefined}
        />
        <Stat label={t('columns.lastMonth')} value={fmtMoney(c.lastMonth, c.currency)} />
        <Stat
          label={t('trend.label')}
          value={
            trend ? (trend.perMonth !== null ? t('trend.perMonth', { amount: fmtMoney(trend.perMonth, c.currency) }) : fmtChange(trend.changePctPerMonth)) : '–'
          }
          extra={
            trend ? (
              <Text span size="xs" c="dimmed">
                {t(`trend.${trend.confidence}`, { months: trend.months, pct: fmtChange(trend.changePctPerMonth) })}
              </Text>
            ) : (
              <Text span size="xs" c="dimmed">
                {t('trend.none')}
              </Text>
            )
          }
        />
      </SimpleGrid>
      {table ? <CostMonthsTable c={c} /> : <CostChart c={c} budget={budget} />}
    </Paper>
  );
}

function Stat({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600} className="viz-num" style={{ overflowWrap: 'anywhere' }}>
        {value}
      </Text>
      {extra}
    </div>
  );
}

function BudgetCard({ d, onEdit }: { d: CostScopeDetail; onEdit: () => void }) {
  const { t } = useTranslation('costs');
  const b = d.budget;
  return (
    <Paper withBorder p="md" data-testid="cost-budget">
      <Group justify="space-between" wrap="wrap" gap="xs" mb={b ? 'xs' : 0}>
        <div>
          <Title order={2} size="h4">
            {t('budget.title')}
          </Title>
          {!b && (
            <Text size="sm" c="dimmed">
              {t('budget.none')}
            </Text>
          )}
        </div>
        {d.canEditBudget && (
          <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={onEdit} data-testid="edit-budget">
            {b ? t('budget.edit') : t('budget.set')}
          </Button>
        )}
      </Group>
      {b && (
        <Stack gap={6}>
          {b.stateOnly || b.pct === null ? (
            <>
              <Group gap="xs" wrap="wrap">
                <BudgetBadge state={b.state} />
                {b.amount !== null && <Text size="sm">{t('budget.amountOnly', { amount: fmtMoney(b.amount, b.currency) })}</Text>}
              </Group>
              <Text size="xs" c="dimmed" data-testid="budget-state-only">
                {t('budget.stateOnly')}
              </Text>
            </>
          ) : (
            <>
              <Text size="sm">
                {b.amount !== null
                  ? t('budget.used', { used: fmtMoney(b.used, b.currency), amount: fmtMoney(b.amount, b.currency) })
                  : t('budget.usedPct', { pct: numberFormat({ maximumFractionDigits: 1 }).format(b.pct) })}
              </Text>
              <BudgetBar pct={b.pct} state={b.state} />
            </>
          )}
          {b.forecastPct !== null && (
            <Text size="xs" c="dimmed">
              {t('budget.forecast', { pct: numberFormat({ maximumFractionDigits: 1 }).format(b.forecastPct) })}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t('budget.changed', { who: b.updatedBy, when: fmtDate(b.updatedAt) })}
            {b.comment ? ` – ${b.comment}` : ''}
          </Text>
        </Stack>
      )}
    </Paper>
  );
}

function BudgetDialog({ d, onClose }: { d: CostScopeDetail; onClose: () => void }) {
  const { t } = useTranslation(['costs', 'common']);
  const qc = useQueryClient();
  const b: CostBudget | null = d.budget;
  const firstCurrency = d.currencies[0]?.currency ?? 'USD';
  const [amount, setAmount] = useState(b?.amount ?? '');
  const [currency, setCurrency] = useState(b?.currency ?? firstCurrency);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Number(amount);
  const raising = !!b && (amount.trim() === '' || currency !== b.currency || (b.amount !== null && Number.isFinite(n) && n > Number(b.amount)));
  const check = useFieldErrors({
    amount: !amount.trim() && t('common:validation.required'),
    currency: !/^[A-Za-z]{3}$/.test(currency.trim()) && t('common:validation.currency'),
  });
  const save = async (remove = false) => {
    if (!remove && !check.validate()) return;
    setBusy(true);
    try {
      await put('/costs/budgets', {
        scope: d.scope,
        scopeId: d.id,
        amount: remove ? null : amount.trim(),
        currency: currency.trim().toUpperCase(),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      await qc.invalidateQueries({ queryKey: costKeys.all });
      notifyOk(t('budget.saved'));
      onClose();
    } catch (e) {
      notifyError(e, t('budget.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('budget.dialogTitle', { name: d.name })}>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('budget.dialogHint')}
        </Text>
        <Group grow align="flex-start">
          <TextInput
            label={t('budget.amount')}
            inputMode="decimal"
            data-autofocus
            required
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            error={check.error('amount')}
          />
          <TextInput
            label={t('budget.currency')}
            maxLength={3}
            required
            value={currency}
            onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
            error={check.error('currency')}
          />
        </Group>
        <Textarea label={t('budget.comment')} autosize minRows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
        {raising && (
          <Text size="xs" c="orange" data-testid="budget-raise">
            {t('budget.raiseHint')}
          </Text>
        )}
        <Group justify="space-between">
          {b ? (
            <Button variant="subtle" color="red" onClick={() => save(true)} loading={busy}>
              {t('budget.remove')}
            </Button>
          ) : (
            <span />
          )}
          <Group>
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button onClick={() => save()} loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
