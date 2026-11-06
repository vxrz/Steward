import { useMemo, useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, Paper, ScrollArea, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconCircleCheck, IconPlugConnectedX, IconSearch } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantFlowGraph, PlantFlowNode, PlantFlowPath } from '@sm/shared';
import { ProtocolBadge, useCheckText } from '../../../components/plant/data';
import { LegendItem, LineMark, LiveBadge, ViewLegend, ViewToolbar } from './common';
import { FlowGraph, KIND_ICON, statusSentence, useNodeText } from './FlowGraph';
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
}: {
  graph: PlantFlowGraph;
  viewId: string;
  title: string;
  counts: 'points' | 'assets';
  pathsTitle: string;
  /** Which parts of this view have live status */
  live: string;
  testId: string;
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
    const nodes = new Set([hoverNode]);
    const edges = new Set<string>();
    for (const x of graph.paths)
      if (x.nodes.includes(hoverNode)) {
        x.nodes.forEach((n) => nodes.add(n));
        x.edges.forEach((e) => edges.add(e));
      }
    for (const e of graph.edges)
      if (e.from === hoverNode || e.to === hoverNode) {
        edges.add(e.id);
        nodes.add(e.from);
        nodes.add(e.to);
      }
    return { nodes, edges };
  }, [hoverNode, hoverPath, pinned, pathById, graph]);
  const pill = (e: PlantFlowGraph['edges'][number]) => {
    const n = counts === 'points' ? e.points : e.assets;
    if (e.problem) return t('edge.problem');
    if (e.inactive) return t('edge.inactive');
    if (e.result || !n) return e.files ? t('edge.files', { count: e.files }) : '';
    return counts === 'points' ? t('edge.points', { count: n }) : graph.grouped || n > 1 ? t('edge.assets', { count: n }) : '';
  };
  const exportSvg = () => ({
    ...flowSvg(graph, {
      title,
      subtitle: t('export.subtitle', { date: new Date().toLocaleDateString() }),
      kind: (k) => t(`kinds.${k}`),
      status: (n) => statusSentence(t, n),
      pill,
      hidden: t('node.hidden'),
    }),
    title,
  });
  const legend = (
    <ViewLegend live={live}>
      <LegendItem mark={<LineMark kind="flow" />}>{motion.animate ? t('legend.flowMoving') : t('legend.flowStatic')}</LegendItem>
      <LegendItem mark={<LineMark kind="inactive" />}>{t('legend.inactive')}</LegendItem>
      <LegendItem mark={<LineMark kind="problem" />}>{t('legend.problem')}</LegendItem>
      <LegendItem
        mark={
          <Badge size="xs" variant="default">
            {counts === 'points' ? '8' : '3'}
          </Badge>
        }
      >
        {counts === 'points' ? t('legend.numbersPoints') : t('legend.numbersAssets')}
      </LegendItem>
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

function PathStatus({ p }: { p: PlantFlowPath }) {
  const { t } = useTranslation('plantViews');
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
              <Text size="xs" c="dimmed" className="mono" lineClamp={1}>
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
function FlowTables({
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
  const name = (n: PlantFlowNode) =>
    n.path ? (
      <Anchor component={Link} to={n.path} size="sm" fw={500}>
        {nodeText.label(n)}
      </Anchor>
    ) : (
      <Text size="sm" fw={500} fs={n.hidden ? 'italic' : undefined}>
        {nodeText.label(n)}
      </Text>
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
                  {n.detail && (
                    <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
                      {n.detail}
                    </Text>
                  )}
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
                    <Table.Td>
                      <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
                        {n.detail || '–'}
                      </Text>
                    </Table.Td>
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
