import { useCallback, useMemo } from 'react';
import { Badge, Group, Select, Stack, Text } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import { IconArrowsSplit } from '@tabler/icons-react';
import { collapsePipeline, type DataGraphEdge, type DataGraphNode, type DataPipelineView } from '@sm/shared';
import { QueryState } from '../../../components/common';
import { LegendItem } from '../../plant/views/common';
import { DataGraphView, WaysTable } from './DataGraphView';
import { pipelineLayout } from './graphLayout';
import { usePipelineView } from './queries';
import { useGraphText } from './text';

/**
 * The pipeline of a data product (ADR 0036 part 13, WP6): its elements in columns – input ports, the internal steps by
 * layer, output ports – with the neighbours its steps read from or write to outside it (greyed), steps as labelled
 * edges, health on the elements, the environment switchable (production first; `?environment=` in the address).
 * Beyond 150 nodes the picture collapses elements by parent, then by column; the table lists every element.
 *
 * WP5 shows it in the product's _Pipeline_ tab: `<PipelineView productId={id} />`.
 */
export function PipelineView({ productId }: { productId: string }) {
  const [params, setParams] = useSearchParams();
  const environment = params.get('environment');
  const q = usePipelineView(productId, environment);
  const setEnvironment = useCallback(
    (v: string | null) =>
      setParams(
        (p) => {
          if (v) p.set('environment', v);
          else p.delete('environment');
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  return (
    <Stack gap="sm">
      <QueryState query={q} />
      {q.data && <PipelineGraph view={q.data} onEnvironment={setEnvironment} />}
    </Stack>
  );
}

function PipelineGraph({ view, onEnvironment }: { view: DataPipelineView; onEnvironment: (env: string | null) => void }) {
  const text = useGraphText();
  const t = text.t;
  const picture = useMemo(() => {
    const c = collapsePipeline(view);
    const area: DataGraphNode = {
      id: `product:${view.product.id}`,
      kind: 'product',
      label: view.product.name,
      detail: '',
      group: true,
      path: null,
      health: null,
    };
    return { ...c, nodes: [area, ...c.nodes] };
  }, [view]);
  const layout = useCallback((g: { nodes: DataGraphNode[]; edges: DataGraphEdge[] }) => pipelineLayout(g, view.columns, view.product.id), [view]);
  const columnName = useMemo(() => new Map(view.columns.map((c) => [c.index, text.column(c)])), [view, text]);
  const labelOf = useMemo(() => new Map(view.nodes.map((n) => [n.id, text.label(n)])), [view, text]);
  const place = (n: DataGraphNode) =>
    n.kind === 'step'
      ? t('kinds.step')
      : n.outside
        ? (columnName.get(n.column ?? -1) ?? '')
        : [n.role ? t(`roles.${n.role}`) : '', n.layer].filter(Boolean).join(' · ');
  const names = (ids: string[]) => ids.map((id) => labelOf.get(id) ?? id).join(', ') || '–';
  return (
    <DataGraphView
      graph={view}
      picture={picture}
      layout={layout}
      viewId="data-pipeline"
      title={t('pipeline.title', { name: view.product.name })}
      testId="data-pipeline-view"
      nodesTitle={t('pipeline.elements')}
      headerText={(i) => columnName.get(i) ?? ''}
      filters={
        view.environments.length > 0 && (
          <Select
            size="xs"
            data={view.environments}
            value={view.environment}
            onChange={(v) => onEnvironment(v)}
            allowDeselect={false}
            aria-label={t('filters.environment')}
            w={150}
            data-testid="pipeline-environment"
          />
        )
      }
      columns={[
        { key: 'place', header: t('table.place'), cell: (n) => <Text size="sm">{place(n)}</Text> },
        {
          key: 'ports',
          header: t('table.ports'),
          cell: (n) => (
            <Group gap={4}>
              {n.ports?.map((p) => (
                <Badge key={p} size="xs" variant="light" style={{ textTransform: 'none' }}>
                  {p}
                </Badge>
              ))}
              {!n.ports?.length && <Text size="xs">–</Text>}
            </Group>
          ),
        },
        {
          key: 'products',
          header: t('table.alsoIn'),
          cell: (n) => (
            <Text size="xs">
              {[...(n.products ?? []), n.hiddenProducts ? t('node.hiddenProducts', { count: n.hiddenProducts }) : ''].filter(Boolean).join(', ') || '–'}
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
                <Text size="sm" fw={500} fs={s.hidden ? 'italic' : undefined}>
                  {s.hidden ? t('hidden.step') : s.name}
                </Text>
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
          <LegendItem mark={<span className="dpv-swatch" style={{ borderStyle: 'dashed', background: 'var(--mantine-color-default-hover)' }} />}>
            {t('legend.outside')}
          </LegendItem>
          <LegendItem mark={<IconArrowsSplit size={14} />}>{t('legend.step')}</LegendItem>
        </>
      }
    />
  );
}
