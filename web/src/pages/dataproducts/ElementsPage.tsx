import { useState } from 'react';
import { Anchor, Badge, Button, Group, Paper, SegmentedControl, Select, Stack, Switch, Text, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconAlertTriangle, IconPlus, IconRadar, IconTable } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DATA_ELEMENT_KINDS, DEFAULT_DATA_LAYERS, type DataElementSummary } from '@sm/shared';
import { QueryState, useCreateParam } from '../../components/common';
import { DataTable, ListFooter } from '../../components/DataTable';
import { ListPage } from '../../components/page/ListPage';
import { useEnvironmentList } from '../../components/catalogue/environments';
import { ElementForm } from '../../components/dataproducts/CatalogueForms';
import { fmtDay, fmtNumber } from '../../format';
import { pagesOf, qs, useElementList, useInvalidateDataProducts, usePlatforms } from './api';
import { PlatformName, useKindLabel } from './parts';
import { useCanCreate } from './rights';

const to = (e: { id: string }) => `/data-elements/${encodeURIComponent(e.id)}`;

/** "In 2 products, 1 you may not see" – counted, never named. */
export function ProductCount({ products }: { products: { visible: number; hidden: number } }) {
  const { t } = useTranslation('dataProducts');
  const n = products.visible + products.hidden;
  if (!n)
    return (
      <Text span size="sm" c="dimmed">
        {t('elements.inNoProduct')}
      </Text>
    );
  return (
    <Text span size="sm">
      {t('elements.inProducts', { count: n })}
      {products.hidden > 0 && (
        <Text span size="xs" c="dimmed">
          {' '}
          ({t('hidden.count', { count: products.hidden })})
        </Text>
      )}
    </Text>
  );
}

export function MissingBadge({ since }: { since: string | null }) {
  const { t } = useTranslation('dataProducts');
  if (!since) return null;
  return (
    <Tooltip label={t('elements.missingSince', { date: fmtDay(since) })}>
      <Badge size="xs" color="orange" variant="light" tt="none" leftSection={<IconAlertTriangle size={10} aria-hidden />} data-testid="element-missing">
        {t('elements.missing')}
      </Badge>
    </Tooltip>
  );
}

/**
 * The element catalogue (ADR 0036 part 5): every table, view, topic, API and path the reader may see, paged by the
 * server (100 at a time; the catalogue holds up to 250,000). Search by the start of the qualified name (fast, by
 * index) or by a text in it; filter by platform, kind, environment and layer; _In no product_ and _Missing_.
 */
export function DataElementsPage() {
  const { t } = useTranslation(['dataProducts', 'common']);
  const navigate = useNavigate();
  const kindLabel = useKindLabel();
  const canCreate = useCanCreate();
  const invalidate = useInvalidateDataProducts();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? params.get('prefix') ?? '');
  const [term] = useDebouncedValue(search.trim(), 300);
  // the start of the qualified name (by index) or a text in it; remembered in the address with the search
  const mode = params.get('match') === 'prefix' || params.has('prefix') ? 'prefix' : 'text';
  const [creating, setCreating] = useState(false);
  useCreateParam(canCreate, () => setCreating(true));
  const platforms = usePlatforms();
  const envs = useEnvironmentList();
  const f = {
    platformId: params.get('platform') ?? '',
    kind: params.get('kind') ?? '',
    environment: params.get('environment') ?? '',
    layer: params.get('layer') ?? '',
    inNoProduct: params.get('inNoProduct') === '1',
    missing: params.get('missing') === '1',
  };
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const setMode = (m: string) => {
    const next = new URLSearchParams(params);
    next.delete('q');
    next.delete('prefix');
    if (m === 'prefix') next.set('match', 'prefix');
    else next.delete('match');
    if (search.trim()) next.set(m === 'prefix' ? 'prefix' : 'q', search.trim());
    setParams(next, { replace: true });
  };
  const query = qs({
    [mode === 'prefix' ? 'prefix' : 'q']: term,
    platformId: f.platformId,
    kind: f.kind,
    environment: f.environment,
    layer: f.layer,
    inNoProduct: f.inNoProduct,
    missing: f.missing,
  });
  const list = useElementList(query);
  const rows = pagesOf(list.data);
  const first = list.data?.pages[0];
  const anyFilter = !!(term || f.platformId || f.kind || f.environment || f.layer || f.inNoProduct || f.missing);
  const none = list.isSuccess && !anyFilter && (first?.total ?? 0) === 0;
  const active = [f.platformId, f.kind, f.environment, f.layer, f.inNoProduct, f.missing, term].filter(Boolean).length;
  const usedPlatforms = (platforms.data ?? []).filter(
    (p) => ['snowflake', 'kafka', 'confluent-cloud', 'database', 'aws', 'insights-hub'].includes(p.kind) || p.id === f.platformId,
  );
  return (
    <ListPage
      testId="data-elements"
      title={t('elements.title')}
      description={t('elements.description')}
      primaryAction={
        canCreate && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="element-new">
            {t('elements.new')}
          </Button>
        )
      }
      actions={
        <Button size="xs" variant="default" leftSection={<IconRadar size={14} />} component={Link} to="/data-products/discovery">
          {t('discovery.title')}
        </Button>
      }
      search={{
        value: search,
        onChange: (v) => {
          setSearch(v);
          set(mode === 'prefix' ? 'prefix' : 'q', v.trim() || null);
        },
        placeholder: mode === 'prefix' ? t('elements.searchPrefix') : t('elements.searchText'),
        label: t('elements.search'),
      }}
      activeFilters={active}
      filters={
        <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="element-filters">
          <div>
            <Text size="xs" fw={500} mb={2} id="element-search-mode">
              {t('elements.searchMode')}
            </Text>
            <SegmentedControl
              size="xs"
              aria-labelledby="element-search-mode"
              value={mode}
              onChange={setMode}
              data={[
                { value: 'prefix', label: t('elements.startsWith') },
                { value: 'text', label: t('elements.contains') },
              ]}
            />
          </div>
          <Select
            size="xs"
            label={t('elements.platform')}
            data={usedPlatforms.map((p) => ({ value: p.id, label: p.name }))}
            value={f.platformId || null}
            onChange={(v) => set('platform', v)}
            clearable
            searchable
            w={{ base: '100%', xs: 180 }}
          />
          <Select
            size="xs"
            label={t('elements.kind')}
            data={DATA_ELEMENT_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
            value={f.kind || null}
            onChange={(v) => set('kind', v)}
            clearable
            searchable
            w={{ base: '100%', xs: 180 }}
          />
          <Select
            size="xs"
            label={t('elements.environment')}
            data={envs.map((e) => e.name)}
            value={f.environment || null}
            onChange={(v) => set('environment', v)}
            clearable
            w={{ base: '100%', xs: 140 }}
          />
          <Select
            size="xs"
            label={t('elements.layer')}
            data={[...DEFAULT_DATA_LAYERS]}
            value={f.layer || null}
            onChange={(v) => set('layer', v)}
            clearable
            w={{ base: '100%', xs: 130 }}
          />
          <Switch
            size="sm"
            label={t('elements.onlyInNoProduct')}
            checked={f.inNoProduct}
            onChange={(e) => set('inNoProduct', e.currentTarget.checked ? '1' : null)}
            mb={6}
            data-testid="filter-in-no-product"
          />
          <Switch
            size="sm"
            label={t('elements.onlyMissing')}
            checked={f.missing}
            onChange={(e) => set('missing', e.currentTarget.checked ? '1' : null)}
            mb={6}
            data-testid="filter-missing"
          />
        </Group>
      }
      view="data-elements"
      empty={{
        show: none,
        icon: IconTable,
        title: t('elements.emptyTitle'),
        text: t('elements.emptyText'),
        whoCanAct: canCreate ? undefined : t('products.whoCanAct'),
        action: canCreate && (
          <Group>
            <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
              {t('elements.new')}
            </Button>
            <Button variant="default" leftSection={<IconRadar size={16} />} component={Link} to="/data-products/discovery">
              {t('discovery.title')}
            </Button>
          </Group>
        ),
      }}
    >
      <QueryState query={list} />
      {!none && list.isSuccess && rows.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('elements.noMatch')}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          testId="element-table"
          ariaLabel={t('elements.title')}
          rows={rows}
          rowKey={(e) => e.id}
          rowHref={to}
          card={(e: DataElementSummary) => (
            <Paper withBorder p="sm" component="article" aria-labelledby={`element-${e.id}`} data-testid="element-card">
              <Stack gap={4}>
                <Anchor id={`element-${e.id}`} component={Link} to={to(e)} fw={600} className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {e.qualifiedName}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {[kindLabel(e.kind), e.platformHidden ? t('hidden.platform') : e.platformName, e.environment, e.layer].filter(Boolean).join(' · ')}
                </Text>
                <Group gap={6}>
                  <ProductCount products={e.products} />
                  <MissingBadge since={e.missingSince} />
                </Group>
              </Stack>
            </Paper>
          )}
          columns={[
            {
              key: 'name',
              header: t('elements.name'),
              cell: (e) => (
                <Stack gap={0}>
                  <Anchor
                    component={Link}
                    to={to(e)}
                    size="sm"
                    fw={500}
                    className="mono"
                    style={{ overflowWrap: 'anywhere' }}
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    {e.qualifiedName}
                  </Anchor>
                  {e.displayName && e.displayName !== e.qualifiedName && (
                    <Text size="xs" c="dimmed">
                      {e.displayName}
                    </Text>
                  )}
                </Stack>
              ),
            },
            { key: 'kind', header: t('elements.kind'), nowrap: true, cell: (e) => kindLabel(e.kind) },
            { key: 'platform', header: t('elements.platform'), cell: (e) => <PlatformName name={e.platformName} hidden={e.platformHidden} /> },
            { key: 'environment', header: t('elements.environment'), nowrap: true, cell: (e) => e.environment || '–' },
            { key: 'layer', header: t('elements.layer'), nowrap: true, cell: (e) => e.layer || '–' },
            { key: 'products', header: t('elements.products'), nowrap: true, cell: (e) => <ProductCount products={e.products} /> },
            {
              key: 'source',
              header: t('elements.source'),
              nowrap: true,
              cell: (e) => (
                <Group gap={4} wrap="nowrap">
                  {t(`elements.sources.${e.source}`)}
                  <MissingBadge since={e.missingSince} />
                </Group>
              ),
            },
          ]}
          footer={
            <ListFooter
              shown={rows.length}
              total={first?.countCapped ? undefined : first?.total}
              hasMore={!!list.hasNextPage}
              onLoadMore={() => void list.fetchNextPage()}
              loading={list.isFetchingNextPage}
            />
          }
        />
      )}
      {first?.countCapped && (
        <Text size="xs" c="dimmed" mt={4}>
          {t('elements.capped', { count: fmtNumber(first.total) })}
        </Text>
      )}
      {creating && (
        <ElementForm
          onClose={() => setCreating(false)}
          onSaved={(e) => {
            invalidate();
            setCreating(false);
            navigate(to(e));
          }}
        />
      )}
    </ListPage>
  );
}
