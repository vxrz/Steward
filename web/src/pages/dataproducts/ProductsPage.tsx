import { useMemo, useState } from 'react';
import { Anchor, Button, Checkbox, Group, Paper, Popover, Select, Stack, Text, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconAlertTriangle, IconColumns3, IconPackages, IconPlus, IconTopologyStar3 } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DATA_PRODUCT_LIFECYCLES, DATA_PRODUCT_TYPES, HEALTH_STATUSES, type DataHealthStatus, type DataProductSummary, type Team } from '@sm/shared';
import { getOptional } from '../../api';
import { QueryState, useCreateParam } from '../../components/common';
import { DataTable, ListFooter, type DataColumn } from '../../components/DataTable';
import { ListPage } from '../../components/page/ListPage';
import { readJsonPref, writePref } from '../../components/page/prefs';
import { RatingBadges } from '../../components/catalogue/cia';
import { useEnvironmentList } from '../../components/catalogue/environments';
import { ProductForm, domainOptions } from '../../components/dataproducts/ProductForm';
import { ImportDialog, TransferMenu } from '../../components/dataproducts/Transfer';
import { fmtRelative } from '../../format';
import { HealthBadge } from './views';
import { pagesOf, qs, useDomains, useInvalidateDataProducts, useListFacts, useListHealth, useProductList } from './api';
import { money } from './ProductCosts';
import { ClassificationBadge, LifecycleBadge, TypeBadge } from './parts';
import { useCanCreate } from './rights';

const to = (p: { id: string }) => `/data-products/${encodeURIComponent(p.id)}`;

/** Columns the reader can add or remove (name, domain, type, lifecycle, health and rating are always shown). */
const OPTIONAL_COLUMNS = ['environments', 'classification', 'maturity', 'costs', 'value', 'updated'] as const;
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
const DEFAULT_COLUMNS: OptionalColumn[] = ['maturity', 'costs'];
const COLUMNS_PREF = 'list.columns.data-products';
const isColumns = (v: unknown): v is OptionalColumn[] => Array.isArray(v) && v.every((x) => (OPTIONAL_COLUMNS as readonly unknown[]).includes(x));

/** The optional columns shown, remembered per user in this browser like the list's sort and view. */
function useColumns(): [Set<OptionalColumn>, (next: OptionalColumn[]) => void] {
  const [shown, setShown] = useState(() => new Set(readJsonPref(COLUMNS_PREF, isColumns, DEFAULT_COLUMNS)));
  return [
    shown,
    (next) => {
      setShown(new Set(next));
      writePref(COLUMNS_PREF, JSON.stringify(next));
    },
  ];
}

function ColumnChooser({ shown, onChange }: { shown: Set<OptionalColumn>; onChange: (next: OptionalColumn[]) => void }) {
  const { t } = useTranslation('dataProducts');
  const label: Record<OptionalColumn, string> = {
    environments: t('products.environments'),
    classification: t('products.classification'),
    maturity: t('products.maturity'),
    costs: t('products.costsLastMonth'),
    value: t('products.value'),
    updated: t('products.updated'),
  };
  return (
    <Popover position="bottom-end" shadow="md" withinPortal trapFocus returnFocus>
      <Popover.Target>
        <Button size="xs" variant="default" leftSection={<IconColumns3 size={14} />} data-testid="product-columns">
          {t('products.columns')}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Checkbox.Group label={t('products.columnsLabel')} value={[...shown]} onChange={(v) => onChange(OPTIONAL_COLUMNS.filter((c) => v.includes(c)))}>
          <Stack gap={6} mt="xs">
            {OPTIONAL_COLUMNS.map((c) => (
              <Checkbox key={c} value={c} label={label[c]} size="sm" data-testid={`product-column-${c}`} />
            ))}
          </Stack>
        </Checkbox.Group>
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * The data products the reader may see (ADR 0036 part 13): name, domain, type, lifecycle, environments, health, the
 * rating with its floor warning, classification and value; filters by domain, type, lifecycle, team, environment and
 * health – in the address, so a filtered list can be shared. Paged by the server (100 at a time), cards on phones.
 */
export function DataProductsPage() {
  const { t } = useTranslation(['dataProducts', 'dataProductViews', 'common']);
  const navigate = useNavigate();
  const canCreate = useCanCreate();
  const invalidate = useInvalidateDataProducts();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [optional, setOptional] = useColumns();
  useCreateParam(canCreate, () => setCreating(true));
  const f = {
    domain: params.get('domain') ?? '',
    type: params.get('type') ?? '',
    lifecycle: params.get('lifecycle') ?? '',
    team: params.get('team') ?? '',
    environment: params.get('environment') ?? '',
    health: params.get('health') ?? '',
  };
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const query = qs({ q, domain: f.domain, type: f.type, lifecycle: f.lifecycle, team: f.team, environment: f.environment, health: f.health });
  const list = useProductList(query);
  const domains = useDomains();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => getOptional<Team[]>('/teams', []), staleTime: 60_000 });
  const envs = useEnvironmentList();
  const rows = pagesOf(list.data);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const health = useListHealth(ids, f.environment);
  const healthOf = useMemo(() => new Map((health.data ?? []).map((h) => [h.productId, h.status])), [health.data]);
  // maturity and last month's costs of the page, in one request
  const facts = useListFacts(ids, f.environment);
  const factsOf = useMemo(() => new Map((facts.data ?? []).map((x) => [x.productId, x])), [facts.data]);
  const costCell = (p: DataProductSummary) => {
    const c = factsOf.get(p.id)?.lastMonth;
    if (!c) return '–';
    const text = c.totals.map((x) => money(x.amountMicros, x.currency)).join(' + ');
    return c.incomplete ? (
      <Tooltip label={t('products.costsIncomplete')}>
        <span>{text ? `${text} *` : t('products.costsHidden')}</span>
      </Tooltip>
    ) : (
      text
    );
  };
  const total = list.data?.pages[0]?.total ?? 0;
  const none = list.isSuccess && !query && total === 0;
  const active = Object.values(f).filter(Boolean).length + (q ? 1 : 0);
  const healthCell = (p: DataProductSummary) => {
    const s = healthOf.get(p.id);
    return s ? <HealthBadge status={s} /> : null;
  };
  const floorWarning = (p: DataProductSummary) =>
    p.ratingBelowObjects && (
      <Tooltip label={t('rating.belowShort')}>
        <IconAlertTriangle size={16} color="var(--mantine-color-orange-6)" aria-label={t('rating.belowShort')} role="img" />
      </Tooltip>
    );
  return (
    <ListPage
      testId="data-products"
      title={t('products.title')}
      description={t('products.description')}
      primaryAction={
        canCreate && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="product-new">
            {t('products.new')}
          </Button>
        )
      }
      actions={
        <>
          {!none && (
            <Button size="xs" variant="default" leftSection={<IconTopologyStar3 size={14} />} component={Link} to="/data-products/map">
              {t('products.map')}
            </Button>
          )}
          {!none && <ColumnChooser shown={optional} onChange={setOptional} />}
          {(!none || canCreate) && <TransferMenu domain={f.domain || undefined} canImport={canCreate} onImport={() => setImporting(true)} />}
        </>
      }
      search={
        none
          ? undefined
          : {
              value: search,
              onChange: (v) => {
                setSearch(v);
                set('q', v.trim() || null);
              },
              placeholder: t('products.search'),
            }
      }
      activeFilters={active}
      filters={
        none ? undefined : (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="product-filters">
            <Select
              size="xs"
              label={t('products.domain')}
              data={domainOptions(domains.data)}
              value={f.domain || null}
              onChange={(v) => set('domain', v)}
              clearable
              searchable
              w={{ base: '100%', xs: 200 }}
            />
            <Select
              size="xs"
              label={t('products.type')}
              data={DATA_PRODUCT_TYPES.map((x) => ({ value: x, label: t(`types.${x}`) }))}
              value={f.type || null}
              onChange={(v) => set('type', v)}
              clearable
              w={{ base: '100%', xs: 170 }}
            />
            <Select
              size="xs"
              label={t('products.lifecycle')}
              data={DATA_PRODUCT_LIFECYCLES.map((x) => ({ value: x, label: t(`lifecycle.${x}`) }))}
              value={f.lifecycle || null}
              onChange={(v) => set('lifecycle', v)}
              clearable
              w={{ base: '100%', xs: 150 }}
              data-testid="filter-lifecycle"
            />
            <Select
              size="xs"
              label={t('products.team')}
              data={(teams.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
              value={f.team || null}
              onChange={(v) => set('team', v)}
              clearable
              searchable
              w={{ base: '100%', xs: 170 }}
            />
            <Select
              size="xs"
              label={t('products.environment')}
              data={envs.map((e) => e.name)}
              value={f.environment || null}
              onChange={(v) => set('environment', v)}
              clearable
              w={{ base: '100%', xs: 150 }}
            />
            <Select
              size="xs"
              label={t('products.health')}
              data={[...HEALTH_STATUSES].reverse().map((x) => ({ value: x, label: t(`dataProductViews:health.${x}`) }))}
              value={f.health || null}
              onChange={(v) => set('health', v)}
              clearable
              w={{ base: '100%', xs: 150 }}
            />
          </Group>
        )
      }
      view={none ? undefined : 'data-products'}
      empty={{
        show: none,
        icon: IconPackages,
        title: t('products.emptyTitle'),
        text: t('products.emptyText'),
        whoCanAct: canCreate ? undefined : t('products.whoCanAct'),
        action: canCreate && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            {t('products.new')}
          </Button>
        ),
      }}
    >
      <QueryState query={list} />
      {!none && list.isSuccess && rows.length === 0 && (
        <Text size="sm" c="dimmed" data-testid="products-no-match">
          {t('products.noMatch')}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          testId="product-table"
          ariaLabel={t('products.title')}
          rows={rows}
          rowKey={(p) => p.id}
          rowHref={to}
          rememberSort="data-products"
          card={(p) => (
            <Paper withBorder p="sm" component="article" aria-labelledby={`product-${p.id}`} data-testid="product-card">
              <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Anchor id={`product-${p.id}`} component={Link} to={to(p)} fw={600} style={{ overflowWrap: 'anywhere' }}>
                    {p.name}
                  </Anchor>
                  {healthCell(p)}
                </Group>
                <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                  {[p.domain?.hidden ? t('hidden.domain') : p.domain?.name, p.key].filter(Boolean).join(' · ')}
                </Text>
                <Group gap={6}>
                  <LifecycleBadge lifecycle={p.lifecycle} sunsetDate={p.sunsetDate} />
                  <TypeBadge type={p.type} />
                  <ClassificationBadge value={p.classification} />
                  {floorWarning(p)}
                </Group>
                <RatingBadges rating={p.rating} />
                {p.environments.length > 0 && (
                  <Text size="xs" c="dimmed">
                    {t('products.inEnvironments', { list: p.environments.join(', ') })}
                  </Text>
                )}
                {factsOf.has(p.id) && (
                  <Text size="xs" c="dimmed">
                    {t('scorecard.maturityShort', { level: factsOf.get(p.id)!.maturity })}
                    {factsOf.get(p.id)!.lastMonth && (
                      <>
                        {' '}
                        · {t('products.costsLastMonth')}: {costCell(p)}
                      </>
                    )}
                  </Text>
                )}
              </Stack>
            </Paper>
          )}
          columns={(
            [
              {
                key: 'name',
                header: t('products.name'),
                sortValue: (p) => p.name,
                cell: (p) => (
                  <>
                    <Anchor component={Link} to={to(p)} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                      {p.name}
                    </Anchor>
                    <Text size="xs" c="dimmed" className="mono">
                      {p.key}
                    </Text>
                  </>
                ),
              },
              {
                key: 'domain',
                header: t('products.domain'),
                sortValue: (p) => p.domain?.name ?? '',
                cell: (p) => (p.domain?.hidden ? t('hidden.domain') : (p.domain?.name ?? '–')),
              },
              { key: 'type', header: t('products.type'), sortValue: (p) => p.type ?? '', nowrap: true, cell: (p) => <TypeBadge type={p.type} size="xs" /> },
              {
                key: 'lifecycle',
                header: t('products.lifecycle'),
                sortValue: (p) => DATA_PRODUCT_LIFECYCLES.indexOf(p.lifecycle),
                nowrap: true,
                cell: (p) => <LifecycleBadge lifecycle={p.lifecycle} sunsetDate={p.sunsetDate} size="xs" />,
              },
              { key: 'environments', header: t('products.environments'), cell: (p) => p.environments.join(', ') || '–' },
              {
                key: 'health',
                header: t('products.health'),
                sortValue: (p) => HEALTH_STATUSES.indexOf(healthOf.get(p.id) ?? ('noData' as DataHealthStatus)),
                nowrap: true,
                cell: healthCell,
              },
              {
                key: 'rating',
                header: t('products.rating'),
                nowrap: true,
                cell: (p) => (
                  <Group gap={4} wrap="nowrap">
                    <RatingBadges rating={p.rating} nowrap />
                    {floorWarning(p)}
                  </Group>
                ),
              },
              {
                key: 'classification',
                header: t('products.classification'),
                nowrap: true,
                cell: (p) => (p.classification ? <ClassificationBadge value={p.classification} size="xs" /> : '–'),
              },
              {
                key: 'maturity',
                header: t('products.maturity'),
                sortValue: (p) => factsOf.get(p.id)?.maturity ?? null,
                nowrap: true,
                cell: (p) => {
                  const m = factsOf.get(p.id)?.maturity;
                  return m === undefined ? '–' : <Text size="sm">{t('scorecard.maturityShort', { level: m })}</Text>;
                },
              },
              {
                key: 'costs',
                header: t('products.costsLastMonth'),
                sortValue: (p) => factsOf.get(p.id)?.lastMonth?.totals[0]?.amountMicros ?? null,
                nowrap: true,
                cell: costCell,
              },
              {
                key: 'value',
                header: t('products.value'),
                sortValue: (p) => (p.valueTier ? ['low', 'medium', 'high'].indexOf(p.valueTier) : null),
                nowrap: true,
                cell: (p) => (p.valueTier ? t(`valueTier.${p.valueTier}`) : '–'),
              },
              { key: 'updated', header: t('products.updated'), sortValue: (p) => p.updatedAt, nowrap: true, cell: (p) => fmtRelative(p.updatedAt) },
            ] satisfies DataColumn<DataProductSummary>[]
          ).filter((c) => !(OPTIONAL_COLUMNS as readonly string[]).includes(c.key) || optional.has(c.key as OptionalColumn))}
          footer={
            <ListFooter
              shown={rows.length}
              total={list.data?.pages[0]?.countCapped ? undefined : total}
              hasMore={!!list.hasNextPage}
              onLoadMore={() => void list.fetchNextPage()}
              loading={list.isFetchingNextPage}
            />
          }
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onDone={() => {
            invalidate();
            setImporting(false);
          }}
        />
      )}
      {creating && (
        <ProductForm
          domains={domains.data}
          onClose={() => setCreating(false)}
          onSaved={(p) => {
            invalidate();
            setCreating(false);
            navigate(to(p));
          }}
        />
      )}
    </ListPage>
  );
}
