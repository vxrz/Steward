import { useMemo, useState } from 'react';
import { Alert, Anchor, Button, Group, Modal, Paper, SegmentedControl, SimpleGrid, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconCoin, IconEyeOff, IconSettings } from '@tabler/icons-react';
import { COST_SCOPES, type CostOverview, type CostOverviewRow, type CostScope, type CostSettings } from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../api';
import { EmptyState, QueryState } from '../components/common';
import { ListPage } from '../components/page/ListPage';
import { DataTable, type DataColumn } from '../components/DataTable';
import { BudgetBar, ChangeText, fmtMoney, SCOPE_PATH } from '../components/costs/common';
import { costKeys } from '../queryKeys';
import '../components/dashboard/viz.css';

/**
 * Costs (#226): what services, applications, teams and platforms cost per month – one row per scope and currency, with
 * the current month so far, its forecast, the last month and the budget. Showback, not FinOps. Amounts the reader may
 * not see are left out (the setting "hide amounts from viewers").
 */
export function CostsPage() {
  const { t } = useTranslation('costs');
  const [params, setParams] = useSearchParams();
  const scope = (COST_SCOPES as readonly string[]).includes(params.get('scope') ?? '') ? (params.get('scope') as CostScope) : 'service';
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState(false);
  const q = useQuery({ queryKey: costKeys.overview(scope), queryFn: () => get<CostOverview>(`/costs?scope=${scope}`) });
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (q.data?.rows ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle));
  }, [q.data, search]);
  const anyCosts = (q.data?.rows ?? []).some((r) => r.currency && (r.thisMonth !== null || r.lastMonth !== null || !r.amountsVisible));
  const hiddenSome = (q.data?.rows ?? []).some((r) => !r.amountsVisible);
  const money = (r: CostOverviewRow, v: string | null) => (r.amountsVisible ? fmtMoney(v, r.currency) : '–');
  const columns: DataColumn<CostOverviewRow>[] = [
    {
      key: 'name',
      header: t(`scopes.${scope}`),
      cell: (r) => (
        <Anchor component={Link} to={SCOPE_PATH(r.scope, r.id)} size="sm" fw={500}>
          {r.name}
        </Anchor>
      ),
      sortValue: (r) => r.name,
    },
    { key: 'currency', header: t('columns.currency'), cell: (r) => r.currency || '–', sortValue: (r) => r.currency, nowrap: true },
    {
      key: 'thisMonth',
      header: t('columns.thisMonth'),
      cell: (r) => <span className="viz-num">{money(r, r.thisMonth)}</span>,
      sortValue: (r) => Number(r.thisMonth ?? ''),
      nowrap: true,
    },
    {
      key: 'forecast',
      header: t('columns.forecast'),
      cell: (r) => <span className="viz-num">{money(r, r.forecast)}</span>,
      sortValue: (r) => Number(r.forecast ?? ''),
      nowrap: true,
    },
    {
      key: 'lastMonth',
      header: t('columns.lastMonth'),
      cell: (r) => <span className="viz-num">{money(r, r.lastMonth)}</span>,
      sortValue: (r) => Number(r.lastMonth ?? ''),
      nowrap: true,
    },
    { key: 'change', header: t('columns.change'), cell: (r) => <ChangeText pct={r.changePct} />, sortValue: (r) => r.changePct, nowrap: true },
    ...(scope === 'platform'
      ? [
          {
            key: 'unassigned',
            header: t('columns.unassigned'),
            cell: (r: CostOverviewRow) => <span className="viz-num">{money(r, r.unassigned)}</span>,
            sortValue: (r: CostOverviewRow) => Number(r.unassigned ?? ''),
            nowrap: true,
          },
        ]
      : [
          {
            key: 'budget',
            header: t('columns.budget'),
            cell: (r: CostOverviewRow) => <BudgetBar pct={r.budgetPct} state={r.budgetState} />,
            sortValue: (r: CostOverviewRow) => r.budgetPct,
          },
        ]),
  ];
  const card = (r: CostOverviewRow) => (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Anchor component={Link} to={SCOPE_PATH(r.scope, r.id)} fw={500} size="sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          {r.name}
        </Anchor>
        <ChangeText pct={r.changePct} />
      </Group>
      <SimpleGrid cols={2} spacing={4} verticalSpacing={2}>
        <Text size="xs" c="dimmed">
          {t('columns.thisMonth')}
        </Text>
        <Text size="xs" ta="right" className="viz-num">
          {money(r, r.thisMonth)}
        </Text>
        <Text size="xs" c="dimmed">
          {t('columns.forecast')}
        </Text>
        <Text size="xs" ta="right" className="viz-num">
          {money(r, r.forecast)}
        </Text>
        <Text size="xs" c="dimmed">
          {t('columns.lastMonth')}
        </Text>
        <Text size="xs" ta="right" className="viz-num">
          {money(r, r.lastMonth)}
        </Text>
      </SimpleGrid>
      {scope !== 'platform' && r.budgetPct !== null && <BudgetBar pct={r.budgetPct} state={r.budgetState} />}
    </Stack>
  );
  return (
    <ListPage
      testId="costs-page"
      title={t('title')}
      description={t('description')}
      actions={
        q.data?.canManageSettings ? (
          <Button size="xs" variant="default" leftSection={<IconSettings size={14} />} onClick={() => setSettings(true)} data-testid="cost-settings">
            {t('settings.open')}
          </Button>
        ) : undefined
      }
      search={{ value: search, onChange: setSearch, label: t('search') }}
      view="costs"
    >
      <SegmentedControl
        mb="md"
        aria-label={t('scopeLabel')}
        data={COST_SCOPES.map((s) => ({ value: s, label: t(`scopesPlural.${s}`) }))}
        value={scope}
        onChange={(v) => setParams(v === 'service' ? {} : { scope: v }, { replace: true })}
        data-testid="cost-scope"
        fullWidth
        maw={560}
      />
      <QueryState query={q} />
      {q.data && !anyCosts && (
        <EmptyState
          icon={IconCoin}
          title={t('empty.title')}
          whoCanAct={t('empty.who')}
          action={
            <Button component={Link} to="/platforms" variant="default" size="xs">
              {t('empty.platforms')}
            </Button>
          }
        >
          {t(`empty.${scope}`)}
        </EmptyState>
      )}
      {q.data && hiddenSome && (
        <Alert icon={<IconEyeOff size={16} />} color="gray" variant="light" mb="md" data-testid="amounts-hidden">
          {t('hiddenHint')}
        </Alert>
      )}
      {q.data && scope === 'platform' && q.data.totals.length > 0 && (
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} mb="md">
          {q.data.totals.map((x) => (
            <Paper key={x.currency} withBorder p="sm" data-testid="cost-total">
              <Text size="xs" c="dimmed">
                {t('totals', { currency: x.currency })}
              </Text>
              <Text fw={600} size="lg" className="viz-num">
                {fmtMoney(x.thisMonth, x.currency)}
              </Text>
              <Text size="xs" c="dimmed">
                {t('totalsLast', { amount: fmtMoney(x.lastMonth, x.currency) })}
              </Text>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {q.data && anyCosts && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => `${r.id}|${r.currency}`}
          ariaLabel={t('tableLabel', { scope: t(`scopesPlural.${scope}`) })}
          rowHref={(r) => SCOPE_PATH(r.scope, r.id)}
          card={card}
          testId="cost-rows"
        />
      )}
      {settings && q.data && <SettingsDialog onClose={() => setSettings(false)} />}
    </ListPage>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['costs', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: costKeys.settings, queryFn: () => get<CostSettings>('/costs/settings') });
  const [draft, setDraft] = useState<CostSettings | null>(null);
  const v = draft ?? q.data ?? null;
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!v) return;
    setBusy(true);
    try {
      await put('/costs/settings', v);
      await qc.invalidateQueries({ queryKey: costKeys.all });
      notifyOk(t('settings.saved'));
      onClose();
    } catch (e) {
      notifyError(e, t('settings.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('settings.title')}>
      <QueryState query={q} />
      {v && (
        <Stack>
          <Switch
            label={t('settings.hide')}
            description={t('settings.hideHint')}
            checked={v.hideAmountsFromViewers}
            onChange={(e) => setDraft({ ...v, hideAmountsFromViewers: e.currentTarget.checked })}
            data-testid="hide-amounts"
          />
          <TextInput
            label={t('settings.currency')}
            description={t('settings.currencyHint')}
            maxLength={3}
            w={160}
            value={v.defaultCurrency}
            onChange={(e) => setDraft({ ...v, defaultCurrency: e.currentTarget.value.toUpperCase() })}
          />
          <Text size="xs" c="dimmed">
            {t('settings.noConversion')}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button onClick={save} loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
