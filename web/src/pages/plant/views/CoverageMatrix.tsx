import { useMemo, useState } from 'react';
import { Anchor, Button, Group, Paper, Select, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleMinus,
  IconCirclePlus,
  IconDatabase,
  IconGridDots,
  type Icon,
} from '@tabler/icons-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  coveragePct,
  type PlantCheck,
  type PlantCoverage,
  type PlantCoverageCell,
  type PlantKpiPotential,
  type PlantCoverageRow,
  type PlantCoverageState,
} from '@sm/shared';
import { get } from '../../../api';
import { EmptyState, FilterPanel, QueryState } from '../../../components/common';
import { plantKeys } from '../../../queryKeys';
import { useNameOf, usePlantLabel } from '../../../components/plant/common';
import { useCheckText } from '../../../components/plant/data';
import { CountBar, LegendItem, ViewLegend, ViewToolbar } from './common';
import { clip, cssColor, escapeXml, exportTheme, svgDocument } from './exportImage';
import { useViewMode } from './prefs';

/**
 * The KPI coverage matrix (#230, Plant → Explore data and the KPI page): assets × KPI definitions – has an instance,
 * could have one (delivers every input), cannot (inputs missing, with the list), problem (a check fails), not checked
 * (the KPI reads no data points). Filtered by site, area, device profile (and KPI); a cell opens the asset.
 */

export const COVERAGE_ICON: Record<PlantCoverageState, Icon> = {
  has: IconCircleCheck,
  problem: IconAlertTriangle,
  could: IconCirclePlus,
  cannot: IconCircleMinus,
  unchecked: IconCircleDashed,
};
export const coverageVar = (s: PlantCoverageState) => `var(--pv-${s === 'unchecked' ? 'cannot' : s})`;

/**
 * 0.12.0: a cell as shown – "could have it" is split by KPI potential into collected ("Collected – ready") and not
 * collected yet ("Device delivers, not collected"); the other states as they are.
 */
export type CoverageShown = Exclude<PlantCoverageState, 'could'> | 'ready' | 'collect';
export const SHOWN_STATES: CoverageShown[] = ['has', 'problem', 'ready', 'collect', 'cannot', 'unchecked'];
export const shownOf = (c: Pick<PlantCoverageCell, 'state' | 'collected'>): CoverageShown =>
  c.state === 'could' ? (c.collected ? 'ready' : 'collect') : c.state;
const SHOWN_ICON: Record<CoverageShown, Icon> = { ...COVERAGE_ICON, ready: IconDatabase, collect: IconCirclePlus };
const shownVar = (s: CoverageShown) => coverageVar(s === 'ready' || s === 'collect' ? 'could' : s);
/** Totals by the states as shown. */
const shownTotals = (totals: PlantCoverage['totals'], potential: PlantKpiPotential | undefined): Record<CoverageShown, number> => ({
  has: totals.has,
  problem: totals.problem,
  ready: potential?.ready ?? 0,
  collect: potential ? potential.collect : totals.could,
  cannot: totals.cannot,
  unchecked: totals.unchecked,
});

/** A cell in words: the state and, for "cannot" and "problem", what is missing or fails. */
function useCellText() {
  const { t } = useTranslation('plantViews');
  const checkText = useCheckText();
  return (c: PlantCoverageCell, kpi: string) => {
    const fake = (g: { code: PlantCheck['code']; params: PlantCheck['params'] }): PlantCheck => ({
      ...g,
      message: g.code,
      subject: { kind: 'kpi', id: '', name: kpi },
    });
    const units = (c.units ?? []).map((u) =>
      checkText(fake({ code: 'kpi_unit_mismatch', params: { kpi, point: u.point, expected: u.expected, actual: u.actual, relation: u.relation } })),
    );
    const details = [...(c.gaps ?? []).map((g) => checkText(fake(g))), ...(c.checks ?? []).map((x) => checkText(x)), ...units];
    const shown = shownOf(c);
    return { state: t(`coverage.states.${shown}`), explain: t(`coverage.legend.${shown}`), details, jobs: c.jobs ?? [] };
  };
}

const PAGE = 100;

export function CoverageMatrix({ embedded }: { embedded?: boolean }) {
  const { t } = useTranslation(['plantViews', 'plant']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [params, setParams] = useSearchParams();
  const filter = { site: params.get('site') ?? '', area: params.get('area') ?? '', profile: params.get('profile') ?? '', kpi: params.get('kpi') ?? '' };
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const [mode, setMode] = useViewMode('kpi-coverage');
  const [limit, setLimit] = useState(PAGE);
  const [focus, setFocus] = useState<{ row: number; col: number } | null>(null);
  const q = useQuery({ queryKey: plantKeys.coverage(qs), queryFn: () => get<PlantCoverage>(`/plant/views/coverage${qs ? `?${qs}` : ''}`) });
  const set = (k: keyof typeof filter, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'site') next.delete('area');
    setParams(next, { replace: true });
    setLimit(PAGE);
    setFocus(null);
  };
  const c = q.data;
  const cellText = useCellText();
  const pct = c ? coveragePct(c.totals) : null;
  const filters = c && (
    <Group gap="xs" wrap="wrap" data-testid="coverage-filters">
      <Select
        size="xs"
        w={narrow ? '100%' : 190}
        label={label('site')}
        placeholder={t('coverage.all')}
        data={c.options.sites.map((s) => ({ value: s.id, label: nameOf(s) }))}
        value={filter.site || null}
        onChange={(v) => set('site', v)}
        clearable
        searchable
        data-testid="coverage-site"
      />
      <Select
        size="xs"
        w={narrow ? '100%' : 190}
        label={label('area')}
        placeholder={t('coverage.all')}
        data={c.options.areas.filter((a) => !filter.site || a.siteId === filter.site).map((a) => ({ value: a.id, label: nameOf(a) }))}
        value={filter.area || null}
        onChange={(v) => set('area', v)}
        clearable
        searchable
        data-testid="coverage-area"
      />
      <Select
        size="xs"
        w={narrow ? '100%' : 230}
        label={t('coverage.profile')}
        placeholder={t('coverage.all')}
        data={c.options.profiles.map((p) => ({ value: p.id, label: p.name }))}
        value={filter.profile || null}
        onChange={(v) => set('profile', v)}
        clearable
        searchable
        data-testid="coverage-profile"
      />
      {filter.kpi && (
        <Button size="xs" variant="light" mt={narrow ? 0 : 22} onClick={() => set('kpi', null)} data-testid="coverage-kpi-clear">
          {t('coverage.allKpis')}
        </Button>
      )}
    </Group>
  );
  const rows = c ? c.rows.slice(0, limit) : [];
  const exportSvg = () => (c ? { ...matrixSvg(c, rows, t, nameOf), title: t('coverage.exportTitle') } : null);
  const focused = focus && c ? { row: c.rows[focus.row]!, col: focus.col } : null;
  return (
    <Stack gap="sm" data-testid="kpi-coverage">
      {!embedded && (
        <div>
          <Title order={2} fz="h4">
            {t('coverage.title')}
          </Title>
          <Text size="xs" c="dimmed">
            {t('coverage.help', { type: label('asset', true, true) })}
          </Text>
        </div>
      )}
      <QueryState query={q} />
      {c && <FilterPanel active={[filter.site, filter.area, filter.profile, filter.kpi].filter(Boolean).length}>{filters}</FilterPanel>}
      {c && c.kpis.length === 0 ? (
        <EmptyState icon={IconGridDots} title={t('coverage.noKpisTitle')} testId="coverage-empty">
          {t('coverage.noKpisText')}
        </EmptyState>
      ) : c && c.total === 0 ? (
        <EmptyState icon={IconGridDots} title={t('coverage.noAssetsTitle', { type: label('asset', true, true) })} testId="coverage-empty">
          {qs ? t('coverage.noMatch') : t('coverage.noAssetsText', { type: label('asset', true, true) })}
        </EmptyState>
      ) : (
        c && (
          <>
            <CoverageSummary totals={c.totals} potential={c.potential} pct={pct} />
            <PotentialByPlace coverage={c} />
            <ViewToolbar mode={mode} onMode={setMode} motion={false} pictureIcon={IconGridDots} onExport={mode === 'picture' ? exportSvg : null} />
            {mode === 'picture' ? (
              <Stack gap="xs">
                <div className="table-scroll" tabIndex={0} role="region" aria-label={t('coverage.title')}>
                  <table className="pv-matrix" aria-label={t('coverage.title')} data-testid="coverage-matrix">
                    <thead>
                      <tr>
                        <th className="pv-sticky" scope="col">
                          {label('asset')}
                        </th>
                        {c.kpis.map((k) => (
                          <th key={k.id} scope="col" style={{ maxWidth: 130 }}>
                            <Anchor component={Link} to={`/plant/kpis/${encodeURIComponent(k.id)}`} size="xs" fw={600} style={{ overflowWrap: 'anywhere' }}>
                              {nameOf(k)}
                            </Anchor>
                            {k.category && (
                              <Text size="xs" c="dimmed" fw={400}>
                                {k.category}
                              </Text>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <MatrixRow
                          key={r.asset.id}
                          row={r}
                          index={i}
                          site={i === 0 || rows[i - 1]!.asset.siteId !== r.asset.siteId ? nameOf(r.asset.site) : null}
                          cols={c.kpis.length}
                          kpiName={(j) => nameOf(c.kpis[j]!)}
                          onFocus={(col) => setFocus({ row: i, col })}
                          cellText={cellText}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                {focused && <CellDetail row={focused.row} kpi={nameOf(c.kpis[focused.col]!)} cell={focused.row.cells[focused.col]!} />}
              </Stack>
            ) : (
              <CoverageList rows={rows} kpis={c.kpis.map((k) => nameOf(k))} kpiIds={c.kpis.map((k) => k.id)} cellText={cellText} />
            )}
            {(c.rows.length > limit || c.truncated) && (
              <Group gap="sm">
                {c.rows.length > limit && (
                  <Button size="xs" variant="default" onClick={() => setLimit((l) => l + PAGE)} data-testid="coverage-more">
                    {t('coverage.more', { count: Math.min(PAGE, c.rows.length - limit) })}
                  </Button>
                )}
                <Text size="xs" c="dimmed">
                  {c.truncated
                    ? t('coverage.truncated', { shown: c.rows.length, total: c.total })
                    : t('coverage.shown', { shown: rows.length, total: c.total })}
                </Text>
              </Group>
            )}
            <CoverageLegend />
          </>
        )
      )}
    </Stack>
  );
}

/** Totals of a selection as a bar, the coverage in per cent and the counts by state (icon + word + number). */
export function CoverageSummary({
  totals,
  potential,
  pct,
  compact,
}: {
  totals: PlantCoverage['totals'];
  potential?: PlantKpiPotential;
  pct: number | null;
  compact?: boolean;
}) {
  const { t } = useTranslation('plantViews');
  const counts = shownTotals(totals, potential);
  const shown = SHOWN_STATES.filter((s) => s !== 'unchecked' || totals.unchecked);
  return (
    <Paper withBorder p="sm" radius="md" data-testid="coverage-summary">
      <Stack gap={8}>
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Text size="sm" fw={600}>
            {pct === null ? t('coverage.pctNone') : t('coverage.pct', { pct })}
          </Text>
          {!compact && (
            <Text size="xs" c="dimmed">
              {t('coverage.pctHelp')}
            </Text>
          )}
        </Group>
        <CountBar
          parts={SHOWN_STATES.map((s) => ({ key: s, value: counts[s], color: shownVar(s), text: `${t(`coverage.states.${s}`)}: ${counts[s]}` }))}
          height={10}
          label={shown.map((s) => `${t(`coverage.states.${s}`)}: ${counts[s]}`).join(', ')}
        />
        <Group gap="md" wrap="wrap">
          {shown.map((s) => {
            const I = SHOWN_ICON[s];
            return (
              <Group key={s} gap={4} wrap="nowrap" data-testid={`coverage-total-${s}`} title={t(`coverage.legend.${s}`)}>
                <I size={14} aria-hidden style={{ color: shownVar(s) }} />
                <Text size="xs">
                  {t(`coverage.states.${s}`)}: <b>{counts[s]}</b>
                </Text>
              </Group>
            );
          })}
        </Group>
        {potential && potential.ready + potential.collect > 0 && (
          <Text size="xs" data-testid="coverage-potential">
            {t('coverage.potential', { ready: potential.ready, collect: potential.collect })}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

/**
 * 0.12.0: KPI potential per site and area (every asset that matches the filters): has, ready (collected), needs a
 * collection, cannot – shown when the answer spans more than one site or area.
 */
function PotentialByPlace({ coverage: c }: { coverage: PlantCoverage }) {
  const { t } = useTranslation('plantViews');
  const nameOf = useNameOf();
  const groups = c.groups ?? [];
  if (groups.length < 2) return null;
  const sites = new Map(c.options.sites.map((s) => [s.id, s]));
  const areas = new Map(c.options.areas.map((a) => [`${a.siteId}/${a.id}`, a]));
  const name = (g: (typeof groups)[number]) => {
    const site = sites.get(g.siteId);
    const area = g.areaId ? areas.get(`${g.siteId}/${g.areaId}`) : undefined;
    return area ? nameOf(area) : site ? nameOf(site) : g.siteId;
  };
  const order = [...groups].sort(
    (a, b) =>
      name({ ...a, areaId: null }).localeCompare(name({ ...b, areaId: null })) || (a.areaId ? 1 : 0) - (b.areaId ? 1 : 0) || name(a).localeCompare(name(b)),
  );
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={t('coverage.byPlace')}>
      <Table fz="xs" withTableBorder aria-label={t('coverage.byPlace')} data-testid="coverage-by-place">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('coverage.place')}</Table.Th>
            {(['has', 'ready', 'collect', 'cannot'] as const).map((s) => (
              <Table.Th key={s} title={t(`coverage.legend.${s}`)}>
                {t(`coverage.states.${s}`)}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {order.map((g) => (
            <Table.Tr key={`${g.siteId}/${g.areaId ?? ''}`} data-testid={`coverage-place-${g.siteId}${g.areaId ? `-${g.areaId}` : ''}`}>
              <Table.Td style={{ paddingLeft: g.areaId ? 24 : undefined, fontWeight: g.areaId ? 400 : 600 }}>{name(g)}</Table.Td>
              <Table.Td>{g.totals.has + g.totals.problem}</Table.Td>
              <Table.Td>{g.potential.ready}</Table.Td>
              <Table.Td>{g.potential.collect}</Table.Td>
              <Table.Td>{g.totals.cannot}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function CoverageLegend() {
  const { t } = useTranslation('plantViews');
  return (
    <ViewLegend live={t('coverage.live')} testId="coverage-legend">
      {SHOWN_STATES.map((s) => {
        const I = SHOWN_ICON[s];
        return (
          <LegendItem key={s} mark={<I size={14} style={{ color: shownVar(s) }} />}>
            {t(`coverage.legend.${s}`)}
          </LegendItem>
        );
      })}
    </ViewLegend>
  );
}

const cellPath = (assetId: string, c: PlantCoverageCell) =>
  `/plant/assets/${encodeURIComponent(assetId)}${c.state === 'has' || c.state === 'cannot' ? '/flow' : ''}`;

function MatrixRow({
  row,
  index,
  site,
  cols,
  kpiName,
  onFocus,
  cellText,
}: {
  row: PlantCoverageRow;
  index: number;
  site: string | null;
  cols: number;
  kpiName: (j: number) => string;
  onFocus: (col: number) => void;
  cellText: ReturnType<typeof useCellText>;
}) {
  const { t } = useTranslation('plantViews');
  const nameOf = useNameOf();
  return (
    <>
      {site && (
        <tr>
          <th colSpan={cols + 1} scope="colgroup" className="pv-sticky" style={{ paddingTop: index ? 12 : 4 }}>
            <Text size="xs" fw={700} tt="uppercase" c="dimmed">
              {site}
            </Text>
          </th>
        </tr>
      )}
      <tr data-testid={`coverage-row-${row.asset.id}`}>
        <th scope="row" className="pv-sticky" style={{ fontWeight: 400 }}>
          <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(row.asset.id)}/flow`} size="sm" fw={500}>
            {row.asset.name}
          </Anchor>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {[row.area ? nameOf(row.area) : null, row.profile?.name ?? t('coverage.noProfile')].filter(Boolean).join(' · ')}
          </Text>
        </th>
        {row.cells.map((c, j) => {
          const I = SHOWN_ICON[shownOf(c)];
          const x = cellText(c, kpiName(j));
          const aria = [`${row.asset.name}, ${kpiName(j)}: ${x.state}`, x.jobs.length ? t('coverage.jobs', { jobs: x.jobs.join(', ') }) : '', ...x.details]
            .filter(Boolean)
            .join('. ');
          return (
            <td key={j}>
              <Link
                to={cellPath(row.asset.id, c)}
                className="pv-cell"
                data-state={c.state}
                data-potential={c.state === 'could' ? shownOf(c) : undefined}
                data-units={c.units?.length ? 'differ' : undefined}
                data-inactive={c.inactive || undefined}
                aria-label={aria}
                title={[x.state, x.explain, ...x.details].join('\n')}
                onFocus={() => onFocus(j)}
                onMouseEnter={() => onFocus(j)}
                data-testid={`cell-${row.asset.id}-${j}`}
                style={{ textDecoration: 'none' }}
              >
                <I size={14} aria-hidden />
                <span aria-hidden>{t(`coverage.short.${shownOf(c)}`)}</span>
              </Link>
            </td>
          );
        })}
      </tr>
    </>
  );
}

/** What a hovered or focused cell means: the state, the instances, what is missing or fails, and where to go. */
function CellDetail({ row, kpi, cell }: { row: PlantCoverageRow; kpi: string; cell: PlantCoverageCell }) {
  const { t } = useTranslation('plantViews');
  const text = useCellText()(cell, kpi);
  const I = SHOWN_ICON[shownOf(cell)];
  return (
    <Paper withBorder p="sm" radius="md" data-testid="coverage-detail" aria-live="polite">
      <Stack gap={4}>
        <Group gap={6} wrap="wrap">
          <I size={16} aria-hidden style={{ color: coverageVar(cell.state) }} />
          <Text size="sm" fw={600}>
            {row.asset.name} · {kpi}: {text.state}
          </Text>
          {cell.inactive && (
            <Text size="xs" c="dimmed">
              {t('coverage.inactive')}
            </Text>
          )}
        </Group>
        {text.jobs.length > 0 && (
          <Text size="xs" c="dimmed" className="mono">
            {t('coverage.jobs', { jobs: text.jobs.join(', ') })}
          </Text>
        )}
        {text.details.map((d, i) => (
          <Text key={i} size="xs">
            {d}
          </Text>
        ))}
        <Text size="xs" c="dimmed">
          {text.explain}
        </Text>
        {cell.state === 'could' && <Text size="xs">{t(cell.collected ? 'coverage.couldHint' : 'coverage.collectHint')}</Text>}
      </Stack>
    </Paper>
  );
}

/** The list alternative (phones): per asset, every KPI with its state in words. */
function CoverageList({
  rows,
  kpis,
  kpiIds,
  cellText,
}: {
  rows: PlantCoverageRow[];
  kpis: string[];
  kpiIds: string[];
  cellText: ReturnType<typeof useCellText>;
}) {
  const { t } = useTranslation('plantViews');
  const nameOf = useNameOf();
  const label = usePlantLabel();
  return (
    <Stack gap="xs" role="list" aria-label={t('coverage.title')} data-testid="coverage-list">
      {rows.map((r) => (
        <Paper key={r.asset.id} withBorder p="sm" role="listitem">
          <Stack gap={6}>
            <div>
              <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(r.asset.id)}/flow`} fw={500} size="sm">
                {r.asset.name}
              </Anchor>
              <Text size="xs" c="dimmed">
                {[nameOf(r.asset.site), r.area ? nameOf(r.area) : null, r.profile?.name ?? t('coverage.noProfile')].filter(Boolean).join(' · ')}
              </Text>
            </div>
            <Stack gap={4} role="list" aria-label={t('coverage.kpisOf', { name: r.asset.name, type: label('asset', false, true) })}>
              {r.cells.map((c, j) => {
                const I = SHOWN_ICON[shownOf(c)];
                const x = cellText(c, kpis[j]!);
                return (
                  <Group key={kpiIds[j]} gap={6} wrap="nowrap" align="flex-start" role="listitem">
                    <I size={15} aria-hidden style={{ color: coverageVar(c.state), flexShrink: 0, marginTop: 2 }} />
                    <Stack gap={0} style={{ minWidth: 0 }}>
                      <Text size="sm">
                        {kpis[j]}: <b>{x.state}</b>
                      </Text>
                      {x.details.map((d, i) => (
                        <Text key={i} size="xs" c="dimmed">
                          {d}
                        </Text>
                      ))}
                    </Stack>
                  </Group>
                );
              })}
            </Stack>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}

type TFn = TFunction<'plantViews'>;

/** The matrix as an SVG (the rows shown). */
function matrixSvg(c: PlantCoverage, rows: PlantCoverageRow[], t: TFn, nameOf: (x: { name: string; names?: Record<string, string> }) => string) {
  const th = exportTheme();
  const left = 240;
  const cw = 92;
  const ch = 30;
  const head = 80;
  const width = left + c.kpis.length * cw + 24;
  const height = head + rows.length * ch + 24;
  const color = (s: PlantCoverageState) => cssColor(`--pv-${s === 'unchecked' ? 'cannot' : s}`);
  const out: string[] = [];
  c.kpis.forEach((k, j) => {
    const x = left + j * cw + cw / 2;
    out.push(
      `<text transform="translate(${x} ${head - 8}) rotate(-30)" font-size="11" font-weight="600" fill="${th.text}">${escapeXml(clip(nameOf(k), 26))}</text>`,
    );
  });
  rows.forEach((r, i) => {
    const y = head + i * ch;
    out.push(`<text x="16" y="${y + 19}" font-size="12" fill="${th.text}">${escapeXml(clip(r.asset.name, 34))}</text>`);
    r.cells.forEach((cell, j) => {
      const x = left + j * cw;
      const filled = cell.state === 'has' || cell.state === 'problem';
      out.push(
        `<rect x="${x + 3}" y="${y + 3}" width="${cw - 6}" height="${ch - 6}" rx="5" fill="${filled ? color(cell.state) : th.background}" stroke="${color(cell.state)}" stroke-width="1.5"/>`,
        `<text x="${x + cw / 2}" y="${y + 19}" font-size="10.5" text-anchor="middle" fill="${filled ? '#ffffff' : th.text}">${escapeXml(t(`coverage.short.${shownOf(cell)}`))}</text>`,
      );
    });
  });
  const pct = coveragePct(c.totals);
  return {
    svg: svgDocument({
      width,
      height,
      title: t('coverage.exportTitle'),
      subtitle: `${pct === null ? t('coverage.pctNone') : t('coverage.pct', { pct })} · ${SHOWN_STATES.map((s) => `${t(`coverage.states.${s}`)} ${shownTotals(c.totals, c.potential)[s]}`).join(' · ')}`,
      body: out.join(''),
    }),
    width,
    height: height + 44,
  };
}

/** The coverage of one KPI definition (KPI page): the bar, the counts and the assets that cannot have it, with why. */
export function KpiCoverageCard({ kpiId }: { kpiId: string }) {
  const { t } = useTranslation('plantViews');
  const label = usePlantLabel();
  const qs = `kpi=${encodeURIComponent(kpiId)}`;
  const q = useQuery({ queryKey: plantKeys.coverage(qs), queryFn: () => get<PlantCoverage>(`/plant/views/coverage?${qs}`) });
  const cellText = useCellText();
  const c = q.data;
  const cannot = useMemo(() => (c ? c.rows.filter((r) => r.cells[0]?.state === 'cannot' && r.profile) : []), [c]);
  return (
    <Paper withBorder p="md" data-testid="kpi-coverage-card">
      <Stack gap="xs">
        <Title order={2} fz="h5">
          {t('coverage.cardTitle')}
        </Title>
        <QueryState query={q} />
        {c && (
          <>
            <CoverageSummary totals={c.totals} potential={c.potential} pct={coveragePct(c.totals)} compact />
            {cannot.length > 0 && (
              <Stack gap={4}>
                <Text size="xs" fw={600}>
                  {t('coverage.cannotWith', { type: label('asset', true) })}
                </Text>
                {cannot.slice(0, 5).map((r) => (
                  <Stack key={r.asset.id} gap={0}>
                    <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(r.asset.id)}/flow`} size="sm">
                      {r.asset.name}
                    </Anchor>
                    {cellText(r.cells[0]!, c.kpis[0]?.name ?? '')
                      .details.slice(0, 2)
                      .map((d, i) => (
                        <Text key={i} size="xs" c="dimmed">
                          {d}
                        </Text>
                      ))}
                  </Stack>
                ))}
              </Stack>
            )}
            <Anchor component={Link} to={`/plant/explore?view=coverage&kpi=${encodeURIComponent(kpiId)}`} size="sm" data-testid="kpi-coverage-link">
              {t('coverage.openMatrix')}
            </Anchor>
          </>
        )}
      </Stack>
    </Paper>
  );
}
