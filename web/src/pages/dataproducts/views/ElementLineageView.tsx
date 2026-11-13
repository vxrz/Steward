import { useCallback, useMemo } from 'react';
import { Badge, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import { IconBuildingFactory2 } from '@tabler/icons-react';
import { DATA_GRAPH_LIMITS, type DataGraphEdge, type DataGraphNode, type DataLineageView } from '@sm/shared';
import { QueryState } from '../../../components/common';
import { LegendItem } from '../../plant/views/common';
import { DataGraphView, WaysTable } from './DataGraphView';
import { flowLayout } from './graphLayout';
import { useLineageView } from './queries';
import { useGraphText } from './text';

/**
 * The lineage of an element (ADR 0036 parts 9 and 13, WP6): the elements 1 to 4 steps upstream and downstream across
 * products (products as areas), the steps between them, plant collections that write to it; what the reader may not
 * see stays in the picture without a name. The depth is in the address (`?depth=`, 2 by default).
 *
 * WP5 shows it on the element's page: `<ElementLineageView elementId={id} />`.
 */
export function ElementLineageView({ elementId }: { elementId: string }) {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('depth'));
  const depth = Number.isInteger(raw) && raw >= 1 && raw <= DATA_GRAPH_LIMITS.lineageDepth ? raw : 2;
  const q = useLineageView(elementId, depth);
  const setDepth = useCallback(
    (d: number) =>
      setParams(
        (p) => {
          p.set('depth', String(d));
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  return (
    <Stack gap="sm">
      <QueryState query={q} />
      {q.data && <LineageGraph view={q.data} depth={depth} onDepth={setDepth} />}
    </Stack>
  );
}

function LineageGraph({ view, depth, onDepth }: { view: DataLineageView; depth: number; onDepth: (d: number) => void }) {
  const text = useGraphText();
  const t = text.t;
  const picture = useMemo(() => ({ nodes: view.nodes, edges: view.edges, collapsed: false }), [view]);
  const layout = useCallback((g: { nodes: DataGraphNode[]; edges: DataGraphEdge[] }) => flowLayout(g), []);
  const labelOf = useMemo(() => new Map(view.nodes.map((n) => [n.id, text.label(n)])), [view, text]);
  const productOf = useMemo(() => new Map(view.nodes.filter((n) => n.group).map((n) => [n.id, n.label])), [view]);
  const distance = (n: DataGraphNode) =>
    n.distance === undefined || n.kind === 'step'
      ? '–'
      : n.distance === 0
        ? t('lineage.this')
        : n.distance < 0
          ? t('aria.upstream', { count: -n.distance })
          : t('aria.downstream', { count: n.distance });
  const names = (ids: string[]) => ids.map((id) => labelOf.get(id) ?? id).join(', ') || '–';
  return (
    <DataGraphView
      graph={view}
      picture={picture}
      layout={layout}
      viewId="data-lineage"
      title={t('lineage.title', { name: view.element.name })}
      testId="data-lineage-view"
      nodesTitle={t('lineage.elements')}
      filters={
        <SegmentedControl
          size="xs"
          value={String(depth)}
          onChange={(v) => onDepth(Number(v))}
          aria-label={t('filters.depth')}
          data={Array.from({ length: DATA_GRAPH_LIMITS.lineageDepth }, (_, i) => ({ value: String(i + 1), label: t('filters.steps', { count: i + 1 }) }))}
          data-testid="lineage-depth"
        />
      }
      columns={[
        { key: 'distance', header: t('table.distance'), cell: (n) => <Text size="sm">{distance(n)}</Text> },
        {
          key: 'product',
          header: t('table.product'),
          cell: (n) => (
            <Text size="xs">
              {[
                (n.parent && productOf.get(n.parent)) || '',
                ...(n.products ?? []).slice(1),
                n.hiddenProducts ? t('node.hiddenProducts', { count: n.hiddenProducts }) : '',
              ]
                .filter(Boolean)
                .join(', ') || '–'}
            </Text>
          ),
        },
      ]}
      waysTable={
        <WaysTable
          title={t('table.steps')}
          headers={[t('table.step'), t('table.runner'), t('table.from'), t('table.to')]}
          rows={view.steps.map((s, i) => ({
            key: s.id || `hidden-${i}`,
            cells: [
              <Stack gap={0} key="n">
                <Group gap={6} wrap="nowrap">
                  <Text size="sm" fw={500} fs={s.hidden ? 'italic' : undefined}>
                    {s.hidden ? t('hidden.step') : s.name}
                  </Text>
                  {s.proposed && (
                    <Badge size="xs" variant="outline" color="gray" tt="none" data-testid="lineage-step-proposed">
                      {t('edge.proposed')}
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  {t(`stepKinds.${s.kind}`)}
                </Text>
              </Stack>,
              <Text size="xs" key="r">
                {s.runner ?? '–'}
              </Text>,
              <Text size="xs" key="f">
                {names(s.inputs)}
              </Text>,
              <Text size="xs" key="t">
                {names(s.outputs)}
              </Text>,
            ],
          }))}
        />
      }
      legend={
        <>
          <LegendItem mark={<IconBuildingFactory2 size={14} />}>{t('legend.plant')}</LegendItem>
          {view.steps.some((x) => x.proposed) && <LegendItem mark={<ProposedMark />}>{t('legend.proposed')}</LegendItem>}
        </>
      }
    />
  );
}

/** The legend's mark of a proposed way: the dotted line of the picture (0.24.0). */
function ProposedMark() {
  return (
    <svg width={34} height={10} viewBox="0 0 34 10" aria-hidden>
      <path d="M1 5 H27" className="pv-edge-base" data-proposed strokeWidth={2} />
      <path d="M27 1 L33 5 L27 9 Z" fill="var(--pv-edge)" />
    </svg>
  );
}
