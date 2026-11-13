import { useCallback, useMemo } from 'react';
import { Select, Stack, Text } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import {
  DATA_PRODUCT_LIFECYCLES,
  DATA_PRODUCT_TYPES,
  collapseMap,
  type DataGraphEdge,
  type DataGraphNode,
  type DataProductLifecycle,
  type DataProductMapView,
  type DataProductType,
} from '@sm/shared';
import { QueryState } from '../../../components/common';
import { LegendItem, LineMark } from '../../plant/views/common';
import { DataGraphView, WaysTable } from './DataGraphView';
import { flowLayout } from './graphLayout';
import { useMapView, type MapFilters } from './queries';
import { useGraphText } from './text';

/**
 * The product map (ADR 0036 part 13, WP6): the products the reader may see in their domains and sub-domains, an edge
 * from the product of an output port to each product whose input port consumes it, health and type on the nodes;
 * filters by domain, type, lifecycle and environment (in the address), and the neighbours of what matches greyed.
 * Selecting a product highlights what depends on it and what it depends on; _Show only what is connected_ keeps only
 * that. Beyond 300 products the domains become nodes with counts; the table lists every product.
 *
 * WP5 shows it on the _Map_ page: `<ProductMapView />`.
 */
export function ProductMapView() {
  const [params, setParams] = useSearchParams();
  const filters: MapFilters = {
    environment: params.get('environment'),
    domain: params.get('domain'),
    type: (params.get('type') as DataProductType | null) ?? null,
    lifecycle: (params.get('lifecycle') as DataProductLifecycle | null) ?? null,
  };
  const q = useMapView(filters);
  const set = useCallback(
    (k: keyof MapFilters, v: string | null) =>
      setParams(
        (p) => {
          if (v) p.set(k, v);
          else p.delete(k);
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  return (
    <Stack gap="sm">
      <QueryState query={q} />
      {q.data && <MapGraph view={q.data} filters={filters} onFilter={set} />}
    </Stack>
  );
}

function MapGraph({ view, filters, onFilter }: { view: DataProductMapView; filters: MapFilters; onFilter: (k: keyof MapFilters, v: string | null) => void }) {
  const text = useGraphText();
  const t = text.t;
  const picture = useMemo(() => collapseMap(view), [view]);
  const layout = useCallback((g: { nodes: DataGraphNode[]; edges: DataGraphEdge[] }) => flowLayout(g), []);
  const domainName = useMemo(() => new Map(view.options.domains.map((d) => [d.id, d.name])), [view]);
  const labelOf = useMemo(() => new Map(view.nodes.map((n) => [n.id, text.label(n)])), [view, text]);
  const ins = useMemo(() => {
    const m = new Map<string, string[]>();
    const outs = new Map<string, string[]>();
    for (const e of view.edges) {
      m.set(e.to, [...(m.get(e.to) ?? []), labelOf.get(e.from) ?? e.from]);
      outs.set(e.from, [...(outs.get(e.from) ?? []), labelOf.get(e.to) ?? e.to]);
    }
    return { from: m, to: outs };
  }, [view, labelOf]);
  const domains = view.options.domains.map((d) => ({ value: d.id, label: d.parentId ? `${domainName.get(d.parentId) ?? ''} › ${d.name}` : d.name }));
  const select = (k: keyof MapFilters, label: string, data: { value: string; label: string }[], testId: string) => (
    <Select
      size="xs"
      clearable
      data={data}
      value={(filters[k] as string | null | undefined) ?? null}
      onChange={(v) => onFilter(k, v)}
      placeholder={label}
      aria-label={label}
      w={160}
      data-testid={testId}
    />
  );
  return (
    <DataGraphView
      graph={view}
      picture={picture}
      layout={layout}
      viewId="data-product-map"
      title={t('map.title')}
      testId="data-product-map-view"
      nodesTitle={t('map.products')}
      filters={
        <>
          {select('domain', t('filters.domain'), domains, 'map-domain')}
          {select(
            'type',
            t('filters.type'),
            DATA_PRODUCT_TYPES.map((x) => ({ value: x, label: t(`types.${x}`) })),
            'map-type',
          )}
          {select(
            'lifecycle',
            t('filters.lifecycle'),
            DATA_PRODUCT_LIFECYCLES.map((x) => ({ value: x, label: t(`lifecycle.${x}`) })),
            'map-lifecycle',
          )}
          {select(
            'environment',
            t('filters.environment'),
            view.options.environments.map((x) => ({ value: x, label: x })),
            'map-environment',
          )}
        </>
      }
      columns={[
        { key: 'domain', header: t('table.domain'), cell: (n) => <Text size="sm">{(n.domainId && domainName.get(n.domainId)) || '–'}</Text> },
        { key: 'type', header: t('table.type'), cell: (n) => <Text size="sm">{n.productType ? t(`types.${n.productType}`) : '–'}</Text> },
        { key: 'lifecycle', header: t('table.lifecycle'), cell: (n) => <Text size="sm">{n.lifecycle ? t(`lifecycle.${n.lifecycle}`) : '–'}</Text> },
        { key: 'from', header: t('table.takesFrom'), cell: (n) => <Text size="xs">{ins.from.get(n.id)?.join(', ') || '–'}</Text> },
        { key: 'to', header: t('table.givesTo'), cell: (n) => <Text size="xs">{ins.to.get(n.id)?.join(', ') || '–'}</Text> },
        { key: 'filter', header: t('table.inFilter'), cell: (n) => <Text size="xs">{n.outside ? t('map.neighbour') : t('map.matches')}</Text> },
      ]}
      waysTable={
        <WaysTable
          title={t('table.dependencies')}
          headers={[t('table.from'), t('table.ports'), t('table.to')]}
          rows={view.edges.map((e) => ({
            key: e.id,
            cells: [
              <Text size="sm" key="f">
                {labelOf.get(e.from) ?? e.from}
              </Text>,
              <Text size="xs" key="p">
                {text.edge(e) || '–'}
              </Text>,
              <Text size="sm" key="t">
                {labelOf.get(e.to) ?? e.to}
              </Text>,
            ],
          }))}
        />
      }
      legend={
        <>
          <LegendItem mark={<LineMark kind="problem" />}>{t('legend.deprecated')}</LegendItem>
          <LegendItem mark={<span className="dpv-swatch" style={{ borderStyle: 'dashed', background: 'var(--mantine-color-default-hover)' }} />}>
            {t('legend.neighbour')}
          </LegendItem>
        </>
      }
    />
  );
}
