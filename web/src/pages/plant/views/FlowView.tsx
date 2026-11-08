import { useMemo, useState, type ReactNode } from 'react';
import { Anchor, Badge, Button, Grid, Group, Paper, ScrollArea, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconCircleCheck, IconCircleDashed, IconCircleX, IconPlugConnectedX, IconSearch } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantFlowGraph, PlantFlowNode, PlantFlowPath } from '@sm/shared';
import { ProtocolBadge, useCheckText } from '../../../components/plant/data';
import { LegendItem, LineMark, LiveBadge, ViewLegend, ViewToolbar } from './common';
import { FlowGraph, KIND_ICON, edgePill, statusSentence, useNodeText, type FlowCounts } from './FlowGraph';
import { flowSvg } from './flowExport';
import { useMotion, useViewMode } from './prefs';

/**
 * A graph view with everything around it (#230): the toolbar (picture or table, animation, export), the legend, the
 * graph with the list of its paths beside it – hovering or focusing a path highlights it end to end, a click pins it
 * and zooms to it – and the table alternative (cards on phones) that says the same in words.
 */
export function FlowView({
  graph,
  viewId,
  title,
  counts,
  pathsTitle,
  live,
  testId,
  legend: extraLegend,
  baseLegend = ['flow', 'inactive', 'problem'],
}: {
  graph: PlantFlowGraph;
  viewId: string;
  title: string;
  counts: FlowCounts;
  pathsTitle: string;
  /** Which parts of this view have live status */
  live: string;
  testId: string;
  /** More entries of the legend (the OT network's zones, conduits …) */
  legend?: ReactNode;
  /** Which of the usual entries apply */
  baseLegend?: ('flow' | 'inactive' | 'problem')[];
}) {
  const { t } = useTranslation('plantViews');
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [mode, setMode] = useViewMode(viewId);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const text = useNodeText();
  const motion = useMotion();
  const pathById = useMemo(() => new Map(graph.paths.map((p) => [p.id, p])), [graph]);
  const highlight = useMemo(() => {
    const p = pathById.get(hoverPath ?? pinned ?? '');
    if (p) return { nodes: new Set(p.nodes), edges: new Set(p.edges) };
    if (!hoverNode) return null;
    // an area (a zone, a VLAN) stands for everything in it
    const inside = new Set([hoverNode]);
    for (let grew = true; grew;) {
      grew = false;
      for (const n of graph.nodes)
        if (n.parent && inside.has(n.parent) && !inside.has(n.id)) {
          inside.add(n.id);
          grew = true;
        }
    }
    const nodes = new Set(inside);
    const edges = new Set<string>();
    for (const x of graph.paths)
      if (x.nodes.some((n) => inside.has(n))) {
        x.nodes.forEach((n) => nodes.add(n));
        x.edges.forEach((e) => edges.add(e));
      }
    for (const e of graph.edges)
      if (inside.has(e.from) || inside.has(e.to)) {
        edges.add(e.id);
        nodes.add(e.from);
        nodes.add(e.to);
      }
    return { nodes, edges };
  }, [hoverNode, hoverPath, pinned, pathById, graph]);
  const pill = (e: PlantFlowGraph['edges'][number]) => {
    if (e.problem) return t('edge.problem');
    if (e.inactive) return t('edge.inactive');
    if (e.noConduit) return t('edge.noConduit');
    return [e.live === 'offline' ? t('edge.offline') : '', edgePill(t, e, counts, graph.grouped)].filter(Boolean).join(' · ');
  };
  const hovered = hoverNode ? graph.nodes.find((n) => n.id === hoverNode) : undefined;
  const exportSvg = () => ({
    ...flowSvg(graph, {
      title,
      subtitle: t('export.subtitle', { date: new Date().toLocaleDateString() }),
      kind: (n) => text.kind(n),
      status: (n) => statusSentence(t, n),
      pill,
      hidden: t('node.hidden'),
    }),
    title,
  });
  const legend = (
    <ViewLegend live={live}>
      {baseLegend.includes('flow') && (
        <LegendItem mark={<LineMark kind="flow" />}>{motion.animate ? t('legend.flowMoving') : t('legend.flowStatic')}</LegendItem>
      )}
      {baseLegend.includes('inactive') && <LegendItem mark={<LineMark kind="inactive" />}>{t('legend.inactive')}</LegendItem>}
      {baseLegend.includes('problem') && <LegendItem mark={<LineMark kind="problem" />}>{t('legend.problem')}</LegendItem>}
      {counts !== 'paths' && (
        <LegendItem
          mark={
            <Badge size="xs" variant="default">
              {counts === 'points' ? '8' : '3'}
            </Badge>
          }
        >
          {counts === 'points' ? t('legend.numbersPoints') : t('legend.numbersAssets')}
        </LegendItem>
      )}
      {extraLegend}
    </ViewLegend>
  );
  return (
    <Stack gap="sm" data-testid={testId} data-mode={mode}>
      <ViewToolbar mode={mode} onMode={setMode} onExport={graph.nodes.length ? exportSvg : null} />
      {mode === 'picture' ? (
        <Grid gap="sm">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <FlowGraph
              graph={graph}
              label={t('graph.label', { title })}
              height={narrow ? 460 : 620}
              highlight={highlight}
              focusKey={pinned}
              onHover={setHoverNode}
              counts={counts}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}>
            {graph.nodes.some((n) => n.info?.length) && <NodeInfo node={hovered} />}
            <PathList
              paths={graph.paths}
              title={pathsTitle}
              pinned={pinned}
              onPin={(id) => setPinned((p) => (p === id ? null : id))}
              onHover={setHoverPath}
              height={narrow ? undefined : 620}
              nodes={graph.nodes}
            />
          </Grid.Col>
        </Grid>
      ) : (
        <FlowTables graph={graph} pathsTitle={pathsTitle} narrow={narrow} nodeText={text} />
      )}
      {legend}
    </Stack>
  );
}

/** What hovering or focusing a part shows (an asset's devices, a VLAN's subnets): the same as its label says. */
function NodeInfo({ node }: { node: PlantFlowNode | undefined }) {
  const { t } = useTranslation('plantViews');
  const text = useNodeText();
  return (
    <Paper withBorder p="xs" radius="md" mb="sm" data-testid="flow-node-info" aria-live="polite">
      {node?.info?.length ? (
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            {text.kind(node)}: {text.label(node)}
          </Text>
          {node.info.map((x, i) => (
            <Group key={i} gap={6} wrap="nowrap" align="flex-start">
              <Text size="xs" c="dimmed" style={{ flexShrink: 0, minWidth: 76 }}>
                {x.label}
              </Text>
              <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                {x.value}
              </Text>
            </Group>
          ))}
        </Stack>
      ) : (
        <Text size="xs" c="dimmed">
          {t('info.hint')}
        </Text>
      )}
    </Paper>
  );
}

const PATH_LIVE = { online: IconCircleCheck, offline: IconCircleX, unknown: IconCircleDashed } as const;

export function PathStatus({ p }: { p: PlantFlowPath }) {
  const { t } = useTranslation('plantViews');
  if (p.kind === 'path') {
    const state = p.live ?? null;
    const I = state ? PATH_LIVE[state] : IconCircleDashed;
    return (
      <Group gap={3} wrap="nowrap" component="span" c={state === 'online' ? 'var(--pv-ok)' : state === 'offline' ? 'var(--pv-fail)' : 'dimmed'}>
        <I size={13} aria-hidden />
        <Text span size="xs" c={state ? 'var(--mantine-color-text)' : 'dimmed'}>
          {state ? t(`path.live.${state}`) : t('path.live.notWatched')}
        </Text>
      </Group>
    );
  }
  if (p.delivers)
    return (
      <Group gap={3} wrap="nowrap" c="var(--pv-ok)" component="span">
        <IconCircleCheck size={13} aria-hidden />
        <Text span size="xs" c="var(--mantine-color-text)">
          {t('path.delivers')}
        </Text>
      </Group>
    );
  return (
    <Group gap={3} wrap="nowrap" component="span" c="dimmed">
      <IconPlugConnectedX size={13} aria-hidden />
      <Text span size="xs">
        {t(`path.reasons.${p.reason ?? 'interface_inactive'}`)}
      </Text>
    </Group>
  );
}

const PAGE = 100;

/** The paths of a graph (data points or assets): hover or focus highlights one, a click pins it. */
function PathList({
  paths,
  nodes,
  title,
  pinned,
  onPin,
  onHover,
  height,
}: {
  paths: PlantFlowPath[];
  nodes: PlantFlowNode[];
  title: string;
  pinned: string | null;
  onPin: (id: string) => void;
  onHover: (id: string | null) => void;
  height?: number;
}) {
  const { t } = useTranslation('plantViews');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const needle = q.trim().toLowerCase();
  const shown = paths.filter((p) => !needle || [p.id, p.label, p.detail].some((x) => x.toLowerCase().includes(needle)));
  const labelOf = useMemo(() => new Map(nodes.map((n) => [n.id, n.hidden ? t('node.hidden') : n.label])), [nodes, t]);
  const list = (
    <Stack gap={2} role="list" aria-label={title}>
      {shown.slice(0, limit).map((p) => (
        <div role="listitem" key={p.id}>
          <button
            type="button"
            className="pv-path"
            data-active={pinned === p.id || undefined}
            aria-pressed={pinned === p.id}
            onMouseEnter={() => onHover(p.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(p.id)}
            onBlur={() => onHover(null)}
            onClick={() => onPin(p.id)}
            data-testid={`flow-path-${p.id}`}
          >
            <Group justify="space-between" gap={6} wrap="nowrap">
              <Text size="sm" fw={500} lineClamp={1}>
                {p.label}
              </Text>
              <PathStatus p={p} />
            </Group>
            {p.detail && (
              <Text size="xs" c="dimmed" className={p.kind === 'point' ? 'mono' : undefined} lineClamp={1}>
                {p.detail}
              </Text>
            )}
            <Text size="xs" c="dimmed" lineClamp={1}>
              {p.nodes
                .slice(1)
                .map((n) => labelOf.get(n) ?? n)
                .join(' → ') || t('path.nowhere')}
            </Text>
          </button>
        </div>
      ))}
    </Stack>
  );
  return (
    <Paper withBorder p="xs" radius="md" h={height} style={{ display: 'flex', flexDirection: 'column' }} data-testid="flow-paths">
      <Group justify="space-between" gap="xs" mb={4}>
        <Title order={3} fz="sm">
          {title}
        </Title>
        <Text size="xs" c="dimmed">
          {t('path.count', { count: paths.length })}
        </Text>
      </Group>
      <Text size="xs" c="dimmed" mb={6}>
        {t('path.help')}
      </Text>
      {paths.length > 12 && (
        <TextInput
          size="xs"
          mb={6}
          leftSection={<IconSearch size={14} />}
          placeholder={t('path.filter')}
          aria-label={t('path.filter')}
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value);
            setLimit(PAGE);
          }}
        />
      )}
      {paths.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('path.none')}
        </Text>
      ) : height ? (
        <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
          {list}
        </ScrollArea>
      ) : (
        list
      )}
      {shown.length > limit && (
        <Button size="xs" variant="subtle" mt={4} onClick={() => setLimit((l) => l + PAGE)}>
          {t('path.more', { count: Math.min(PAGE, shown.length - limit) })}
        </Button>
      )}
    </Paper>
  );
}

/** The table alternative: every part with its status in words, every path and where it goes. */
export function FlowTables({
  graph,
  pathsTitle,
  narrow,
  nodeText,
}: {
  graph: PlantFlowGraph;
  pathsTitle: string;
  narrow: boolean;
  nodeText: ReturnType<typeof useNodeText>;
}) {
  const { t } = useTranslation('plantViews');
  const checkText = useCheckText();
  const labelOf = new Map(graph.nodes.map((n) => [n.id, nodeText.label(n)]));
  const name = (n: PlantFlowNode) => (
    <Stack gap={0}>
      {n.path ? (
        <Anchor component={Link} to={n.path} size="sm" fw={500}>
          {nodeText.label(n)}
        </Anchor>
      ) : (
        <Text size="sm" fw={500} fs={n.hidden ? 'italic' : undefined}>
          {nodeText.label(n)}
        </Text>
      )}
      {n.parent && labelOf.has(n.parent) && (
        <Text size="xs" c="dimmed">
          {t('table.in', { name: labelOf.get(n.parent) })}
        </Text>
      )}
      {!!n.tags?.length && (
        <Text size="xs" c="dimmed">
          {n.tags.join(' · ')}
        </Text>
      )}
    </Stack>
  );
  // the details: the second line and what hovering shows (devices, subnets)
  const detail = (n: PlantFlowNode) => (
    <Stack gap={2}>
      {n.detail && (
        <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
          {n.detail}
        </Text>
      )}
      {n.info?.map((x, i) => (
        <Text key={i} size="xs" style={{ overflowWrap: 'anywhere' }}>
          <Text span size="xs" c="dimmed">
            {x.label}:
          </Text>{' '}
          <span className="mono">{x.value}</span>
        </Text>
      ))}
      {!n.detail && !n.info?.length && <Text size="xs">–</Text>}
    </Stack>
  );
  const status = (n: PlantFlowNode) => (
    <Stack gap={3}>
      {n.live && <LiveBadge live={n.live} withSource />}
      {n.inactive && (
        <Group gap={4} wrap="nowrap" c="dimmed">
          <IconPlugConnectedX size={14} aria-hidden />
          <Text size="xs">{t('node.inactiveSentence')}</Text>
        </Group>
      )}
      {n.checks.map((c, i) => (
        <Group key={i} gap={4} wrap="nowrap" align="flex-start">
          <IconAlertTriangle size={14} aria-hidden style={{ color: 'var(--pv-problem)', flexShrink: 0, marginTop: 2 }} />
          <Text size="xs">{checkText(c)}</Text>
        </Group>
      ))}
      {!n.live && !n.inactive && !n.checks.length && (
        <Text size="xs" c="dimmed">
          {t('node.docOnly')}
        </Text>
      )}
    </Stack>
  );
  const kindCell = (n: PlantFlowNode) => {
    const I = KIND_ICON[n.kind];
    return (
      <Group gap={6} wrap="wrap">
        <I size={15} stroke={1.6} aria-hidden />
        <Text size="sm">{nodeText.kind(n)}</Text>
        {n.protocol && <ProtocolBadge protocol={n.protocol} size="xs" />}
      </Group>
    );
  };
  const goes = (p: PlantFlowPath) =>
    p.nodes
      .slice(1)
      .map((n) => labelOf.get(n) ?? n)
      .join(' → ') || t('path.nowhere');
  return (
    <Stack gap="md" data-testid="flow-tables">
      <Stack gap={6}>
        <Title order={3} fz="sm">
          {t('table.parts')}
        </Title>
        {narrow ? (
          <Stack gap="xs" role="list" aria-label={t('table.parts')}>
            {graph.nodes.map((n) => (
              <Paper key={n.id} withBorder p="sm" role="listitem">
                <Stack gap={4}>
                  {kindCell(n)}
                  {name(n)}
                  {(n.detail || !!n.info?.length) && detail(n)}
                  {status(n)}
                </Stack>
              </Paper>
            ))}
          </Stack>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label={t('table.parts')}>
            <Table fz="sm" aria-label={t('table.parts')} data-testid="flow-parts-table">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('table.kind')}</Table.Th>
                  <Table.Th>{t('table.name')}</Table.Th>
                  <Table.Th>{t('table.detail')}</Table.Th>
                  <Table.Th>{t('table.status')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {graph.nodes.map((n) => (
                  <Table.Tr key={n.id}>
                    <Table.Td>{kindCell(n)}</Table.Td>
                    <Table.Td>{name(n)}</Table.Td>
                    <Table.Td>{detail(n)}</Table.Td>
                    <Table.Td>{status(n)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </Stack>
      {graph.paths.length > 0 && (
        <Stack gap={6}>
          <Title order={3} fz="sm">
            {pathsTitle}
          </Title>
          {narrow ? (
            <Stack gap="xs" role="list" aria-label={pathsTitle}>
              {graph.paths.slice(0, 500).map((p) => (
                <Paper key={p.id} withBorder p="sm" role="listitem">
                  <Stack gap={2}>
                    <Text size="sm" fw={500}>
                      {p.label}
                    </Text>
                    <PathStatus p={p} />
                    <Text size="xs" c="dimmed">
                      {goes(p)}
                    </Text>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          ) : (
            <div className="table-scroll" tabIndex={0} role="region" aria-label={pathsTitle}>
              <Table fz="sm" aria-label={pathsTitle} data-testid="flow-paths-table">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('table.name')}</Table.Th>
                    <Table.Th>{t('table.status')}</Table.Th>
                    <Table.Th>{t('table.goesTo')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {graph.paths.slice(0, 2000).map((p) => (
                    <Table.Tr key={p.id}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {p.label}
                        </Text>
                        {p.detail && (
                          <Text size="xs" c="dimmed" className="mono">
                            {p.detail}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <PathStatus p={p} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{goes(p)}</Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </Stack>
      )}
    </Stack>
  );
}
