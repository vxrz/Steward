import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconArrowDownRight,
  IconArrowRight,
  IconArrowUpRight,
  IconChevronDown,
  IconChevronUp,
  IconCircleCheck,
  IconCircleX,
  IconDownload,
  IconFlask,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import type { DashboardWidget, DatasetMeta, DatasetRow, DatasetStatus, RunDetail, RunSummary, Schedule } from '@sm/shared';
import { Trans, useTranslation } from 'react-i18next';
import { get } from '../../api';
import { errorText } from '../../i18n/errors';
import { severityLabel } from '../common';
import { fmtRelative } from '../../format';
import { Markdown } from '../common';
import { StatusBar, StatusTable, Sparkline, TrendChart, TrendTable } from './charts';
import { useDashboardCtx, useDataset, useDatasetMetas, useMetrics, isNotFound } from './data';
import { compact, dateTime, download, toCsv } from './format';
import { SEVERITY_RANK, STATUS_META, StatusLabel, asStatus } from './status';

// ---------------------------------------------------------------------------
// Card wrapper
// ---------------------------------------------------------------------------

function WidgetCard({
  title,
  subtitle,
  fetching,
  toggle,
  view,
  onView,
  actions,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  fetching?: boolean;
  toggle?: boolean;
  view?: 'chart' | 'table';
  onView?: (v: 'chart' | 'table') => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation('dashboards');
  return (
    <Paper
      withBorder
      p="sm"
      h="100%"
      className="viz-root"
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
      component="section"
      aria-label={typeof title === 'string' ? title : undefined}
    >
      {(title || toggle || actions) && (
        <Group justify="space-between" align="flex-start" wrap="nowrap" mb={6} gap="xs">
          <div style={{ minWidth: 0 }}>
            {title && (
              <Text size="sm" fw={600} c="var(--viz-text-primary)" truncate>
                {title}
              </Text>
            )}
            {subtitle && (
              <Text size="xs" c="var(--viz-text-secondary)" truncate component="div">
                {subtitle}
              </Text>
            )}
          </div>
          <Group gap={4} wrap="nowrap">
            {actions}
            {toggle && (
              <SegmentedControl
                size="xs"
                value={view}
                onChange={(v) => onView?.(v as 'chart' | 'table')}
                data={[
                  { value: 'chart', label: t('w.chart') },
                  { value: 'table', label: t('w.table') },
                ]}
                aria-label={t('w.viewToggle')}
              />
            )}
          </Group>
        </Group>
      )}
      <div className="viz-fade" data-fetching={!!fetching} style={{ flex: 1, minWidth: 0 }}>
        {children}
      </div>
    </Paper>
  );
}

function NoData({ dataset, error }: { dataset?: string; error?: unknown }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  if (!dataset) return <Text size="sm" c="dimmed">{t('w.chooseDataset')}</Text>;
  return (
    <Stack gap={4}>
      <Text size="sm" c="dimmed">
        {isNotFound(error) || !error ? (
          <Trans t={t} i18nKey="w.noData" values={{ dataset, node: t('editor:steps.publish.label') }} components={{ c: <span className="mono" /> }} />
        ) : (
          errorText(error)
        )}
      </Text>
      <Anchor component={Link} to="/processes" size="xs">
        {t('w.goToProcesses')}
      </Anchor>
    </Stack>
  );
}

function Freshness({ meta }: { meta?: DatasetMeta }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  if (!meta) return null;
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" c="var(--viz-text-secondary)" truncate>
        {t('list.updated', { when: fmtRelative(meta.updatedAt) })}
      </Text>
      {meta.stale && (
        <Tooltip label={t('w.olderThan', { count: meta.staleAfterMinutes ?? 0 })}>
          <Badge size="xs" color="yellow" variant="light" leftSection={<IconAlertTriangle size={10} />}>
            {t('datasets.stale')}
          </Badge>
        </Tooltip>
      )}
      {meta.dryRun && (
        <Badge size="xs" color="gray" variant="light" leftSection={<IconFlask size={10} />}>
          {t('common:status.dryrun')}
        </Badge>
      )}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

function KpiWidget({ w }: { w: DashboardWidget }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const metas = useDatasetMetas();
  const meta = metas.data?.find((m) => m.key === w.dataset);
  const isRows = !w.metric || w.metric === '_rows';
  const days = w.days ?? 30;
  const series = useMetrics(isRows ? undefined : w.dataset, isRows ? [] : [w.metric!], days);
  const points = isRows ? [] : (series.data?.find((s) => s.name === w.metric)?.points ?? []);
  const value = isRows ? meta?.rowCount : (meta?.metrics[w.metric!] ?? points[points.length - 1]?.value);
  const first = points[0]?.value;
  const delta = value !== undefined && first !== undefined && points.length > 1 ? value - first : undefined;
  const good = delta === undefined || delta === 0 || !w.goodWhen ? null : (delta > 0) === (w.goodWhen === 'up');
  const DeltaIcon = !delta ? IconArrowRight : delta > 0 ? IconArrowUpRight : IconArrowDownRight;
  const label = w.title || `${meta?.title ?? w.dataset} · ${isRows ? t('w.rows') : w.metric}`;
  if (!meta && !metas.isLoading) {
    return (
      <WidgetCard title={label}>
        <NoData dataset={w.dataset} />
      </WidgetCard>
    );
  }
  return (
    <WidgetCard title={label} fetching={metas.isFetching} toggle={points.length > 1} view={view} onView={setView}>
      {view === 'table' ? (
        <TrendTable series={series.data ?? []} names={[w.metric!]} />
      ) : (
        <Stack gap={4}>
          <Group gap={10} align="baseline" wrap="nowrap">
            <span className="viz-kpi-value">{compact(value)}</span>
            {delta !== undefined && (
              <Group gap={2} wrap="nowrap">
                <DeltaIcon size={14} color={good === null ? 'var(--viz-muted)' : good ? 'var(--viz-delta-good)' : 'var(--viz-delta-bad)'} aria-hidden />
                <Text size="xs" fw={600} c={good === null ? 'var(--viz-text-secondary)' : good ? 'var(--viz-delta-good)' : 'var(--viz-delta-bad)'} className="viz-num">
                  {delta > 0 ? '+' : ''}
                  {compact(delta)}
                </Text>
                <Text size="xs" c="var(--viz-text-secondary)">
                  {t('w.vsDaysAgo', { count: days })}
                </Text>
              </Group>
            )}
          </Group>
          {points.length > 1 && <Sparkline points={points} />}
          <Freshness meta={meta} />
        </Stack>
      )}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

function TrendWidget({ w }: { w: DashboardWidget }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const metas = useDatasetMetas();
  const meta = metas.data?.find((m) => m.key === w.dataset);
  const names = (w.metrics?.length ? w.metrics : Object.keys(meta?.metrics ?? {}).slice(0, 3)).slice(0, 3);
  const days = w.days ?? 30;
  const series = useMetrics(w.dataset, names, days);
  const title = w.title || t('w.lastDays', { name: meta?.title ?? w.dataset, count: days });
  if (!meta && !metas.isLoading) {
    return (
      <WidgetCard title={title}>
        <NoData dataset={w.dataset} />
      </WidgetCard>
    );
  }
  const hasPoints = (series.data ?? []).some((s) => s.points.length > 0);
  return (
    <WidgetCard title={title} subtitle={<Freshness meta={meta} />} fetching={series.isFetching} toggle view={view} onView={setView}>
      {!hasPoints ? (
        <Text size="sm" c="dimmed">
          {series.isLoading ? t('common:loading') : t('w.noHistory')}
        </Text>
      ) : view === 'table' ? (
        <TrendTable series={series.data ?? []} names={names} />
      ) : (
        <TrendChart series={series.data ?? []} names={names} />
      )}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Status distribution
// ---------------------------------------------------------------------------

function StatusWidget({ w }: { w: DashboardWidget }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const { statusFilter, setStatusFilter } = useDashboardCtx();
  const metas = useDatasetMetas();
  const meta = metas.data?.find((m) => m.key === w.dataset);
  const title = w.title || t('w.statusTitle', { name: meta?.title ?? w.dataset });
  if (!meta) {
    return (
      <WidgetCard title={title}>
        {metas.isLoading ? <Text size="sm" c="dimmed">{t('common:loading')}</Text> : <NoData dataset={w.dataset} />}
      </WidgetCard>
    );
  }
  const active = statusFilter?.dataset === meta.key ? statusFilter.status : null;
  return (
    <WidgetCard title={title} subtitle={<Freshness meta={meta} />} fetching={metas.isFetching} toggle view={view} onView={setView}>
      {view === 'table' ? (
        <StatusTable counts={meta.statusCounts} />
      ) : (
        <StatusBar counts={meta.statusCounts} active={active} onSelect={(s) => setStatusFilter(s ? { dataset: meta.key, status: s } : null)} />
      )}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

type Sort = { col: string; dir: 1 | -1 } | null;

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

function TableWidget({ w }: { w: DashboardWidget }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const { statusFilter, setStatusFilter } = useDashboardCtx();
  const ds = useDataset(w.dataset);
  const [q, setQ] = useState('');
  const [problems, setProblems] = useState(!!w.problemsOnly);
  const [sort, setSort] = useState<Sort>({ col: '_status', dir: 1 });
  const [limit, setLimit] = useState(w.limit ?? 50);
  const d = ds.data;
  const cols = useMemo(() => (w.columns?.length ? w.columns.filter((c) => d?.columns.includes(c)) : (d?.columns ?? [])), [w.columns, d]);
  const hasStatus = !!d?.rows.some((r) => r._status);
  const filterStatus = statusFilter && d && statusFilter.dataset === d.key ? statusFilter.status : null;

  const rows = useMemo(() => {
    if (!d) return [];
    const needle = q.trim().toLowerCase();
    let list = d.rows.filter((r) => {
      if (problems && asStatus(r._status) === 'good') return false;
      if (filterStatus && asStatus(r._status) !== filterStatus) return false;
      if (needle && !cols.some((c) => cellText(r[c]).toLowerCase().includes(needle)) && !cellText(r._statusText).toLowerCase().includes(needle)) return false;
      return true;
    });
    if (sort) {
      const key = (r: DatasetRow) => (sort.col === '_status' ? SEVERITY_RANK[asStatus(r._status)] : r[sort.col]);
      list = [...list].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : cellText(x).localeCompare(cellText(y), undefined, { numeric: true });
        return c * sort.dir;
      });
    }
    return list;
  }, [d, q, problems, filterStatus, sort, cols]);

  const title = w.title || d?.title || w.dataset;
  if (!d) {
    return (
      <WidgetCard title={title}>
        {ds.isLoading ? <Text size="sm" c="dimmed">{t('common:loading')}</Text> : <NoData dataset={w.dataset} error={ds.error} />}
      </WidgetCard>
    );
  }
  const header = (col: string, label: string, right = false) => (
    <Table.Th
      key={col}
      ta={right ? 'right' : undefined}
      style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
      onClick={() => setSort((s) => (s?.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: 1 }))}
      aria-sort={sort?.col === col ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
    >
      <Group gap={2} wrap="nowrap" justify={right ? 'flex-end' : undefined}>
        {label}
        {sort?.col === col && (sort.dir === 1 ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />)}
      </Group>
    </Table.Th>
  );
  const numeric = (c: string) => d.rows.slice(0, 20).every((r) => r[c] === null || r[c] === undefined || typeof r[c] === 'number');
  return (
    <WidgetCard
      title={title}
      subtitle={<Freshness meta={d} />}
      fetching={ds.isFetching}
      actions={
        <Tooltip label={t('w.downloadCsv')}>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label={t('w.downloadCsv')}
            onClick={() =>
              download(
                `${d.key}.csv`,
                toCsv(
                  [...(hasStatus ? ['status', 'reason'] : []), ...cols],
                  rows.map((r) => [...(hasStatus ? [asStatus(r._status), cellText(r._statusText)] : []), ...cols.map((c) => r[c])]),
                ),
              )
            }
          >
            <IconDownload size={15} />
          </ActionIcon>
        </Tooltip>
      }
    >
      <Group gap="xs" mb={6} wrap="wrap">
        <TextInput
          size="xs"
          placeholder={t('w.search')}
          aria-label={t('w.search')}
          leftSection={<IconSearch size={13} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          w={180}
        />
        {hasStatus && <Switch size="xs" label={t('w.problemsOnly')} checked={problems} onChange={(e) => setProblems(e.currentTarget.checked)} />}
        {filterStatus && (
          <Badge
            variant="light"
            color="gray"
            rightSection={
              <UnstyledButton aria-label={t('w.clearFilter')} onClick={() => setStatusFilter(null)} style={{ display: 'flex' }}>
                <IconX size={11} />
              </UnstyledButton>
            }
          >
            {t('w.statusOnly', { status: STATUS_META[filterStatus].label })}
          </Badge>
        )}
        <Text size="xs" c="var(--viz-text-secondary)" ml="auto" className="viz-num">
          {t('w.rowsOf', { shown: rows.length, total: d.rowCount })}
        </Text>
      </Group>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={typeof title === 'string' ? title : t('w.table')}>
        <Table fz="sm" striped highlightOnHover verticalSpacing={4} miw={(hasStatus ? 130 : 0) + cols.length * 140}>
          <Table.Thead>
            <Table.Tr>
              {hasStatus && header('_status', t('datasets.status'))}
              {cols.map((c) => header(c, c, numeric(c)))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.slice(0, limit).map((r, i) => (
              <Table.Tr key={r._key ?? i}>
                {hasStatus && (
                  <Table.Td className="nowrap">
                    <StatusLabel status={asStatus(r._status)} text={r._statusText || undefined} size="xs" />
                  </Table.Td>
                )}
                {cols.map((c) => (
                  <Table.Td key={c} ta={numeric(c) ? 'right' : undefined} className={numeric(c) ? 'viz-num' : undefined} style={{ maxWidth: 360, overflowWrap: 'break-word' }}>
                    {typeof r[c] === 'boolean' ? (r[c] ? t('common:yes') : t('common:no')) : cellText(r[c])}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
            {rows.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={cols.length + (hasStatus ? 1 : 0)}>
                  <Text size="sm" c="dimmed">
                    {problems || filterStatus ? t('w.allGood') : t('w.noRows')}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </div>
      {rows.length > limit && (
        <Group justify="center" mt={6}>
          <Button size="compact-xs" variant="subtle" onClick={() => setLimit((l) => l + 50)}>
            {t('w.showMore', { count: rows.length - limit })}
          </Button>
        </Group>
      )}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Checks of the latest run
// ---------------------------------------------------------------------------

function ChecksWidget({ w }: { w: DashboardWidget }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const { refreshMs } = useDashboardCtx();
  const last = useQuery({
    queryKey: ['runs', 'latest', w.process],
    queryFn: () => get<RunSummary[]>(`/runs?processId=${encodeURIComponent(w.process!)}&limit=1`),
    enabled: !!w.process,
    refetchInterval: refreshMs,
  });
  const runId = last.data?.[0]?.id;
  const run = useQuery({ queryKey: ['run', runId], queryFn: () => get<RunDetail>(`/runs/${runId}`), enabled: !!runId, refetchInterval: refreshMs });
  const checks = (run.data?.steps ?? []).filter((s) => s.type === 'check');
  const title = w.title || run.data?.processName || w.process || t('widgets.checks.label');
  return (
    <WidgetCard
      title={title}
      subtitle={
        run.data && (
          <>
            {t('w.latestRun', { when: fmtRelative(run.data.startedAt) })} ·{' '}
            <Anchor component={Link} to={`/runs/${run.data.id}`} size="xs">
              {t('w.open')}
            </Anchor>
          </>
        )
      }
      fetching={run.isFetching}
    >
      {!w.process ? (
        <Text size="sm" c="dimmed">{t('w.chooseProcess')}</Text>
      ) : last.data && !runId ? (
        <Text size="sm" c="dimmed">{t('w.notRunYet')}</Text>
      ) : (
        <Stack gap={6}>
          {checks.length === 0 && run.data && <Text size="sm" c="dimmed">{t('w.noChecks')}</Text>}
          {checks.map((c) => {
            const o = (c.output ?? {}) as { passed?: boolean; severity?: string; message?: string };
            const failedStatus: DatasetStatus = o.severity === 'warning' ? 'warning' : o.severity === 'info' ? 'unknown' : 'critical';
            return (
              <Group key={c.id} gap={8} wrap="nowrap" align="flex-start">
                {o.passed ? (
                  <IconCircleCheck size={18} color="var(--viz-good)" aria-label={t('w.passed')} style={{ flexShrink: 0 }} />
                ) : (
                  <IconCircleX size={18} color={STATUS_META[failedStatus].color} aria-label={t('w.failed')} style={{ flexShrink: 0 }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" c="var(--viz-text-primary)">
                    {c.name}{' '}
                    <Text span size="xs" c="var(--viz-text-secondary)">
                      {o.passed ? t('w.passed') : t('w.failedSeverity', { severity: severityLabel(o.severity ?? 'error') })}
                    </Text>
                  </Text>
                  {(o.message || c.error) && (
                    <Text size="xs" c="var(--viz-text-secondary)" style={{ wordBreak: 'break-word' }}>
                      {o.message ?? c.error}
                    </Text>
                  )}
                </div>
              </Group>
            );
          })}
        </Stack>
      )}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Freshness of all datasets on the dashboard
// ---------------------------------------------------------------------------

function FreshnessWidget({ w, datasets }: { w: DashboardWidget; datasets: string[] }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const metas = useDatasetMetas();
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => get<Schedule[]>('/schedules') });
  const nextRun = (processId: string) =>
    (schedules.data ?? [])
      .filter((s) => s.enabled && s.processId === processId && s.nextRunAt)
      .map((s) => s.nextRunAt!)
      .sort()[0];
  return (
    <WidgetCard title={w.title || t('widgets.freshness.label')} fetching={metas.isFetching}>
      <div className="table-scroll" tabIndex={0} role="region" aria-label={w.title || t('widgets.freshness.label')}>
        <Table fz="sm" verticalSpacing={4} miw={520}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('datasets.dataset')}</Table.Th>
              <Table.Th>{t('datasets.updated')}</Table.Th>
              <Table.Th>{t('datasets.source')}</Table.Th>
              <Table.Th>{t('w.nextRefresh')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {datasets.map((key) => {
              const m = metas.data?.find((x) => x.key === key);
              const next = m ? nextRun(m.processId) : undefined;
              return (
                <Table.Tr key={key}>
                  <Table.Td>
                    <Text size="sm">{m?.title ?? key}</Text>
                    <Text size="xs" c="dimmed" className="mono">
                      {key}
                    </Text>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    {m ? (
                      <Stack gap={2}>
                        <Tooltip label={dateTime(m.updatedAt)}>
                          <Text size="sm">{fmtRelative(m.updatedAt)}</Text>
                        </Tooltip>
                        <Group gap={4}>
                          {m.stale && (
                            <Badge size="xs" color="yellow" variant="light" leftSection={<IconAlertTriangle size={10} />}>
                              {t('datasets.stale')}
                            </Badge>
                          )}
                          {m.dryRun && (
                            <Badge size="xs" color="gray" variant="light" leftSection={<IconFlask size={10} />}>
                              {t('common:status.dryrun')}
                            </Badge>
                          )}
                        </Group>
                      </Stack>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {t('w.noDataShort')}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {m ? (
                      <Stack gap={0}>
                        <Anchor component={Link} to={`/processes/${m.processId}`} size="sm">
                          {m.processName}
                        </Anchor>
                        <Anchor component={Link} to={`/runs/${m.runId}`} size="xs" c="dimmed">
                          {t('w.run')}
                        </Anchor>
                      </Stack>
                    ) : (
                      '–'
                    )}
                  </Table.Td>
                  <Table.Td className="nowrap">
                    <Text size="sm" c={next ? undefined : 'dimmed'}>
                      {next ? fmtRelative(next) : t('w.notScheduled')}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              );
            })}
            {datasets.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={4}>
                  <Text size="sm" c="dimmed">
                    {t('w.noDatasets')}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </div>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------

export function WidgetView({ w, datasets }: { w: DashboardWidget; datasets: string[] }) {
  const { t } = useTranslation('dashboards');
  switch (w.type) {
    case 'kpi':
      return <KpiWidget w={w} />;
    case 'trend':
      return <TrendWidget w={w} />;
    case 'status':
      return <StatusWidget w={w} />;
    case 'table':
      return <TableWidget w={w} />;
    case 'checks':
      return <ChecksWidget w={w} />;
    case 'freshness':
      return <FreshnessWidget w={w} datasets={datasets} />;
    case 'markdown':
      return (
        <WidgetCard title={w.title}>
          <Markdown text={w.text} />
        </WidgetCard>
      );
    default:
      return (
        <WidgetCard title={w.title}>
          <Text size="sm" c="dimmed">
            {t('w.unknownType')}
          </Text>
        </WidgetCard>
      );
  }
}

/** 12-column grid; every widget is full width on phones. */
export function WidgetGrid({ widgets, renderExtra }: { widgets: DashboardWidget[]; renderExtra?: (w: DashboardWidget) => ReactNode }) {
  const datasets = [...new Set(widgets.map((w) => w.dataset).filter((x): x is string => !!x))];
  return (
    <div className="dash-grid">
      {widgets.map((w) => (
        <div key={w.id} className="dash-cell" style={{ ['--span' as string]: String(w.width ?? defaultWidth(w.type)) }}>
          {renderExtra?.(w)}
          <WidgetView w={w} datasets={datasets} />
        </div>
      ))}
    </div>
  );
}

export function defaultWidth(type: DashboardWidget['type']): number {
  switch (type) {
    case 'kpi':
      return 3;
    case 'status':
    case 'trend':
    case 'checks':
      return 6;
    default:
      return 12;
  }
}
