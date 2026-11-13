import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Anchor, Button, Grid, Group, Paper, Select, Stack, Switch, Table, Text, TextInput, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link } from 'react-router-dom';
import { IconArrowsMaximize, IconEyeOff, IconInfoCircle, IconSearch } from '@tabler/icons-react';
import { DATA_HEALTH_ORDER, reachable, type DataGraph, type DataGraphEdge, type DataGraphNode } from '@sm/shared';
import { TableScroll } from '../../../components/TableScroll';
import { fmtDay } from '../../../format';
import { LegendItem, LineMark, ViewToolbar } from '../../plant/views/common';
import { useMotion, useViewMode } from '../../plant/views/prefs';
import { DataGraphCanvas, KIND_ICON, iconKey } from './DataGraphCanvas';
import { graphSvg } from './graphExport';
import type { GraphLayout } from './graphLayout';
import { HEALTH_ICON, HealthBadge, healthVar } from './health';
import { useGraphText, type GraphText } from './text';

/**
 * A data products picture with everything around it (ADR 0036 part 13): the toolbar (picture or table – phones start
 * with the table –, animation, export as SVG or PNG), a search that finds and selects a node, _Fit to screen_, the
 * selection with what it connects to (and _Show only what is connected_), the legend, notes on what was collapsed,
 * left out or is hidden, and the table that says the same in words.
 */

export interface TableColumn {
  key: string;
  header: string;
  cell: (n: DataGraphNode) => ReactNode;
}

export interface DataGraphViewProps {
  /** The graph as the server sent it (the table lists all of it) */
  graph: DataGraph;
  /** What the picture draws (collapsed where large) */
  picture: { nodes: DataGraphNode[]; edges: DataGraphEdge[]; collapsed: boolean };
  /** Lays out what is drawn (it may be only part of the picture: "Show only what is connected") */
  layout: (g: { nodes: DataGraphNode[]; edges: DataGraphEdge[] }) => GraphLayout;
  viewId: string;
  title: string;
  testId: string;
  /** Columns of the table of nodes (after kind and name) */
  columns: TableColumn[];
  /** The second table: steps, or dependencies */
  waysTable?: ReactNode;
  /** Filters and the environment switch, beside the picture/table switch */
  filters?: ReactNode;
  /** Filters with visible labels, in a row of their own below the toolbar (as on the lists) */
  filterBar?: ReactNode;
  /** More entries of the legend */
  legend?: ReactNode;
  headerText?: (index: number) => string;
  /** The words of the nodes in the table ("Element", "Product") */
  nodesTitle: string;
}

const PAGE = 100;
const NO_MATCHES = new Set<string>();

export function DataGraphView({
  graph,
  picture,
  layout: layoutOf,
  viewId,
  title,
  testId,
  columns,
  waysTable,
  filters,
  filterBar,
  legend,
  headerText,
  nodesTitle,
}: DataGraphViewProps) {
  const text = useGraphText();
  const t = text.t;
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [mode, setMode] = useViewMode(viewId);
  const motion = useMotion();
  const [selected, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [onlyConnected, setOnlyConnected] = useState(false);
  // a node of the full graph drawn inside a collapsed one: the collapsed one stands for it
  const repOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of picture.nodes) for (const id of n.members ?? []) m.set(id, n.id);
    return m;
  }, [picture]);
  const drawn = useMemo(() => {
    if (!onlyConnected || !selected) return picture;
    const r = reachable(picture, selected);
    const groups = new Set(picture.nodes.filter((n) => n.group).map((n) => n.id));
    return {
      ...picture,
      nodes: picture.nodes.filter((n) => r.nodes.has(n.id) || (groups.has(n.id) && picture.nodes.some((m) => r.nodes.has(m.id) && m.parent === n.id))),
      edges: picture.edges.filter((e) => r.edges.has(e.id)),
    };
  }, [picture, onlyConnected, selected]);
  const layout = useMemo(() => layoutOf(drawn), [layoutOf, drawn]);
  const highlight = useMemo(() => (selected && drawn.nodes.some((n) => n.id === selected) ? reachable(drawn, selected) : null), [drawn, selected]);
  const byId = useMemo(() => new Map(picture.nodes.map((n) => [n.id, n])), [picture]);
  const sel = selected ? byId.get(selected) : undefined;
  const choose = (id: string | null) => {
    const target = id ? (repOf.get(id) ?? id) : null;
    setSelected(target);
    setFocusId(target);
    if (!target) setOnlyConnected(false);
  };
  // the search: every named node of the graph (also those inside a collapsed one)
  const options = useMemo(
    () =>
      graph.nodes
        .filter((n) => !n.group && !n.hidden && n.label)
        .map((n) => ({ value: n.id, label: n.detail && n.detail !== n.label ? `${n.label} · ${n.detail}` : n.label })),
    [graph],
  );
  const exportSvg = () => ({
    ...graphSvg(drawn, layout, { title, subtitle: t('export.subtitle', { date: fmtDay(new Date()) }), text, header: headerText }),
    title,
  });
  const notes: ReactNode[] = [];
  if (graph.truncated.nodes)
    notes.push(
      graph.view === 'lineage'
        ? t('notes.lineageTruncated', { upstream: graph.truncated.upstream, downstream: graph.truncated.downstream })
        : t('notes.truncated', { count: graph.truncated.nodes }),
    );
  if (picture.collapsed && mode === 'picture') notes.push(t('notes.collapsed'));
  if (graph.hidden.elements || graph.hidden.products) notes.push(t('notes.hidden', { elements: graph.hidden.elements, products: graph.hidden.products }));
  return (
    <Stack gap="sm" data-testid={testId} data-mode={mode}>
      <ViewToolbar mode={mode} onMode={setMode} onExport={drawn.nodes.length ? exportSvg : null}>
        {filters}
      </ViewToolbar>
      {filterBar}
      {notes.length > 0 && (
        <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} p="xs" data-testid="graph-notes">
          <Stack gap={2}>
            {notes.map((n, i) => (
              <Text key={i} size="xs">
                {n}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      {mode === 'picture' ? (
        <Grid gap="sm">
          <Grid.Col span={{ base: 12, lg: 9 }}>
            <Stack gap="xs">
              <Group gap="xs" wrap="wrap">
                <Select
                  size="xs"
                  searchable
                  clearable
                  limit={50}
                  data={options}
                  value={null}
                  onChange={(v) => choose(v)}
                  placeholder={t('search.placeholder')}
                  aria-label={t('search.label')}
                  leftSection={<IconSearch size={14} />}
                  nothingFoundMessage={t('search.nothing')}
                  style={{ flex: '1 1 16rem', maxWidth: 420 }}
                  data-testid="graph-search"
                />
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconArrowsMaximize size={14} />}
                  onClick={() => setFitKey((k) => k + 1)}
                  data-testid="graph-fit"
                >
                  {t('toolbar.fit')}
                </Button>
              </Group>
              {drawn.nodes.length === 0 ? (
                <Paper withBorder p="lg" radius="md">
                  <Text size="sm" c="dimmed" ta="center">
                    {t('empty')}
                  </Text>
                </Paper>
              ) : (
                <DataGraphCanvas
                  nodes={drawn.nodes}
                  edges={drawn.edges}
                  layout={layout}
                  label={t('graph.label', { title })}
                  height={narrow ? 460 : 620}
                  highlight={highlight}
                  selected={selected}
                  matches={NO_MATCHES}
                  onSelect={(id) => {
                    setSelected(id);
                    if (!id) setOnlyConnected(false);
                  }}
                  focusId={focusId}
                  fitKey={fitKey}
                  headerText={headerText}
                />
              )}
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 3 }}>
            <Selection
              node={sel}
              text={text}
              connected={highlight ? highlight.nodes.size - 1 : 0}
              onlyConnected={onlyConnected}
              onOnlyConnected={setOnlyConnected}
              onClear={() => choose(null)}
            />
          </Grid.Col>
        </Grid>
      ) : (
        <Stack gap="md">
          <NodeTable graph={graph} columns={columns} narrow={narrow} text={text} title={nodesTitle} />
          {waysTable}
        </Stack>
      )}
      <Legend animate={motion.animate} extra={legend} />
    </Stack>
  );
}

/** What is selected: its name and status in words, its page, how much it connects to. */
function Selection({
  node,
  text,
  connected,
  onlyConnected,
  onOnlyConnected,
  onClear,
}: {
  node: DataGraphNode | undefined;
  text: GraphText;
  connected: number;
  onlyConnected: boolean;
  onOnlyConnected: (v: boolean) => void;
  onClear: () => void;
}) {
  const t = text.t;
  return (
    <Paper withBorder p="sm" radius="md" data-testid="graph-selection" aria-live="polite">
      {node ? (
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            {text.kind(node)}
          </Text>
          <Text size="sm" fw={600} fs={node.hidden ? 'italic' : undefined} style={{ overflowWrap: 'anywhere' }}>
            {text.label(node)}
          </Text>
          {node.detail && !node.hidden && (
            <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
              {node.detail}
            </Text>
          )}
          {node.health && <HealthBadge status={node.health} />}
          <Text size="xs">{t('selection.connected', { count: connected })}</Text>
          <Switch
            size="xs"
            label={t('selection.only')}
            checked={onlyConnected}
            onChange={(e) => onOnlyConnected(e.currentTarget.checked)}
            data-testid="graph-only-connected"
          />
          <Group gap="xs">
            {node.path && (
              <Button size="xs" variant="light" component={Link} to={node.path} data-testid="graph-open">
                {t('selection.open')}
              </Button>
            )}
            <Button size="xs" variant="subtle" onClick={onClear}>
              {t('selection.clear')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Text size="xs" c="dimmed">
          {t('selection.hint')}
        </Text>
      )}
    </Paper>
  );
}

/** The legend: health in words and icons, what lines and greyed nodes mean. */
function Legend({ animate, extra }: { animate: boolean; extra?: ReactNode }) {
  const text = useGraphText();
  const t = text.t;
  return (
    <Paper withBorder p="xs" radius="md" data-testid="graph-legend">
      <Stack gap={6}>
        <Text size="xs">
          <Text span fw={600} size="xs">
            {t('legend.healthTitle')}
          </Text>{' '}
          {t('legend.health')}
        </Text>
        <Group gap="md" wrap="wrap" component="ul" m={0} p={0}>
          {DATA_HEALTH_ORDER.map((s) => {
            const I = HEALTH_ICON[s];
            return (
              <LegendItem key={s} mark={<I size={14} style={{ color: healthVar(s) }} />}>
                {t(`health.${s}`)}
              </LegendItem>
            );
          })}
        </Group>
        <Group gap="md" wrap="wrap" component="ul" m={0} p={0}>
          <LegendItem mark={<LineMark kind="flow" />}>{animate ? t('legend.flowMoving') : t('legend.flowStatic')}</LegendItem>
          <LegendItem mark={<IconEyeOff size={14} />}>{t('legend.hidden')}</LegendItem>
          {extra}
        </Group>
      </Stack>
    </Paper>
  );
}

/** The table alternative: every node with its kind, name, status in words and the view's columns (cards on phones). */
function NodeTable({ graph, columns, narrow, text, title }: { graph: DataGraph; columns: TableColumn[]; narrow: boolean; text: GraphText; title: string }) {
  const t = text.t;
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () => graph.nodes.filter((n) => !n.group && (!needle || [text.label(n), n.detail, text.kind(n)].some((x) => x.toLowerCase().includes(needle)))),
    [graph, needle, text],
  );
  const name = (n: DataGraphNode) =>
    n.path ? (
      <Anchor component={Link} to={n.path} size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
        {text.label(n)}
      </Anchor>
    ) : (
      <Text size="sm" fw={500} fs={n.hidden ? 'italic' : undefined} style={{ overflowWrap: 'anywhere' }}>
        {text.label(n)}
      </Text>
    );
  const kind = (n: DataGraphNode) => {
    const I = KIND_ICON[iconKey(n)];
    return (
      <Group gap={6} wrap="nowrap">
        <I size={15} stroke={1.6} aria-hidden />
        <Text size="sm">{text.kind(n)}</Text>
      </Group>
    );
  };
  const health = (n: DataGraphNode) =>
    n.health ? (
      <Stack gap={2}>
        <HealthBadge status={n.health} />
        {n.checks && n.checks.visible + n.checks.hidden > 0 && (
          <Text size="xs" c="dimmed">
            {t('aria.checks', { count: n.checks.visible + n.checks.hidden })}
          </Text>
        )}
      </Stack>
    ) : (
      <Text size="xs" c="dimmed">
        –
      </Text>
    );
  return (
    <Stack gap={6} data-testid="graph-tables">
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Title order={3} fz="sm">
          {title}
        </Title>
        <TextInput
          size="xs"
          leftSection={<IconSearch size={14} />}
          placeholder={t('table.filter')}
          aria-label={t('table.filter')}
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value);
            setLimit(PAGE);
          }}
          style={{ flex: '0 1 18rem' }}
          data-testid="graph-table-filter"
        />
      </Group>
      <Text size="xs" c="dimmed">
        {t('table.count', { count: rows.length })}
      </Text>
      {narrow ? (
        <Stack gap="xs" role="list" aria-label={title}>
          {rows.slice(0, limit).map((n) => (
            <Paper key={n.id} withBorder p="sm" role="listitem">
              <Stack gap={4}>
                {kind(n)}
                {name(n)}
                {n.detail && !n.hidden && (
                  <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                    {n.detail}
                  </Text>
                )}
                {columns.map((c) => (
                  <Group key={c.key} gap={6} wrap="nowrap" align="flex-start">
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0, minWidth: 90 }}>
                      {c.header}
                    </Text>
                    <div>{c.cell(n)}</div>
                  </Group>
                ))}
                {n.health && health(n)}
              </Stack>
            </Paper>
          ))}
        </Stack>
      ) : (
        <TableScroll label={title}>
          <Table fz="sm" aria-label={title} data-testid="graph-nodes-table" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('table.kind')}</Table.Th>
                <Table.Th>{t('table.name')}</Table.Th>
                {columns.map((c) => (
                  <Table.Th key={c.key}>{c.header}</Table.Th>
                ))}
                <Table.Th>{t('table.health')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.slice(0, limit).map((n) => (
                <Table.Tr key={n.id}>
                  <Table.Td>{kind(n)}</Table.Td>
                  <Table.Td>
                    <Stack gap={0}>
                      {name(n)}
                      {n.detail && !n.hidden && (
                        <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
                          {n.detail}
                        </Text>
                      )}
                    </Stack>
                  </Table.Td>
                  {columns.map((c) => (
                    <Table.Td key={c.key}>{c.cell(n)}</Table.Td>
                  ))}
                  <Table.Td>{health(n)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableScroll>
      )}
      {rows.length > limit && (
        <Button size="xs" variant="subtle" onClick={() => setLimit((l) => l + PAGE)} data-testid="graph-table-more">
          {t('table.more', { count: Math.min(PAGE, rows.length - limit) })}
        </Button>
      )}
    </Stack>
  );
}

/** The ways between the nodes as a table: steps (pipeline, lineage) with their ends, or a map's dependencies. */
export function WaysTable({ title, rows, headers }: { title: string; rows: { key: string; cells: ReactNode[] }[]; headers: string[] }) {
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [limit, setLimit] = useState(PAGE);
  const { t } = useGraphText();
  if (!rows.length) return null;
  return (
    <Stack gap={6}>
      <Title order={3} fz="sm">
        {title}
      </Title>
      {narrow ? (
        <Stack gap="xs" role="list" aria-label={title}>
          {rows.slice(0, limit).map((r) => (
            <Paper key={r.key} withBorder p="sm" role="listitem">
              <Stack gap={4}>
                {r.cells.map((c, i) => (
                  <Group key={i} gap={6} wrap="nowrap" align="flex-start">
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0, minWidth: 90 }}>
                      {headers[i]}
                    </Text>
                    <div style={{ minWidth: 0 }}>{c}</div>
                  </Group>
                ))}
              </Stack>
            </Paper>
          ))}
        </Stack>
      ) : (
        <TableScroll label={title}>
          <Table fz="sm" aria-label={title} data-testid="graph-ways-table" striped>
            <Table.Thead>
              <Table.Tr>
                {headers.map((h) => (
                  <Table.Th key={h}>{h}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.slice(0, limit).map((r) => (
                <Table.Tr key={r.key}>
                  {r.cells.map((c, i) => (
                    <Table.Td key={i}>{c}</Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableScroll>
      )}
      {rows.length > limit && (
        <Button size="xs" variant="subtle" onClick={() => setLimit((l) => l + PAGE)}>
          {t('table.more', { count: Math.min(PAGE, rows.length - limit) })}
        </Button>
      )}
    </Stack>
  );
}
