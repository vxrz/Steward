import { Anchor, Group, Paper, SimpleGrid, Text, type SimpleGridProps } from '@mantine/core';
import { Link } from 'react-router-dom';
import {
  IconAlertTriangle,
  IconArrowsDiff,
  IconCalendarDue,
  IconCircleCheck,
  IconCircleDashed,
  IconListSearch,
  IconFileTime,
  IconGauge,
  IconHeartRateMonitor,
  IconInbox,
  IconKey,
  IconTicket,
  type Icon as TablerIcon,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DashboardAttention } from '@sm/shared';
import { TONE } from '../common';
import { MONITOR_COLORS } from '../monitors/status';
import { fmtNumber } from '../../format';

interface Tile {
  key: string;
  label: string;
  value: number;
  /** Colour of a tile that needs attention (TONE); null = the calm zero state */
  tone: string | null;
  detail: string;
  to: string;
  icon: TablerIcon;
  /** The feature is not set up yet (nothing to count): a neutral tile with this hint instead of "All quiet" */
  notSetUp?: string;
}

/** The tiles of a start page focus (TILE_KEYS order); every tile when not given. */
export const TILE_KEYS = [
  'tasks',
  'failed-runs',
  'run-findings',
  'monitors',
  'credentials',
  'findings',
  'reviews',
  'duties',
  'scorecard',
  'vendor-tickets',
] as const;
export type TileKey = (typeof TILE_KEYS)[number];

/** Columns per number of tiles, so the grid never ends in a lonely half row (five: the last tile spans the row, styles.css). */
const COLS: Record<number, SimpleGridProps['cols']> = {
  1: { base: 1 },
  2: { base: 2 },
  3: { base: 1, xs: 3 },
  4: { base: 2, lg: 4 },
  5: { base: 2, lg: 5 },
  6: { base: 2, md: 3 },
  7: { base: 2, lg: 4 },
  8: { base: 2, lg: 4 },
  9: { base: 2, md: 3 },
  10: { base: 2, lg: 5 },
};

/**
 * The start page's tiles: what needs the user's attention. Tiles the server left out (no right) are not shown; tiles of
 * features nobody set up yet say so (neutral, after the others) instead of a reassuring "All quiet". `only`: the tiles
 * of the viewer's focus (role-aware start page).
 */
export function AttentionTiles({
  a,
  processes,
  only,
  hideNotSetUp = false,
}: {
  a: DashboardAttention;
  processes?: number;
  only?: readonly TileKey[];
  /** Leave out features not set up yet (viewers, who cannot set them up) */
  hideNotSetUp?: boolean;
}) {
  const { t } = useTranslation('dashboard');
  // phones: features not set up yet fold into one line instead of a screen of empty tiles
  const quiet = t('counts.allQuiet');
  // nothing to count yet: no processes (runs), or no entries of the feature the viewer may see
  const none = (total: number | undefined, hint: string) => (total === 0 ? t(`counts.notSetUp.${hint}` as 'counts.notSetUp.processes') : undefined);
  const noProcesses = processes === 0 && !a.runs.total ? none(0, 'processes') : undefined;
  const all: Tile[] = [
    {
      key: 'tasks',
      label: t('counts.tasks'),
      value: a.tasks,
      tone: a.tasks ? TONE.person : null,
      detail: a.tasks ? t('counts.tasksDetail') : quiet,
      to: '/tasks',
      icon: IconInbox,
    },
    {
      key: 'failed-runs',
      label: t('counts.failedRuns'),
      value: a.runs.failed,
      tone: a.runs.failed ? TONE.bad : null,
      detail: a.runs.failed ? t('counts.ofRuns', { count: a.runs.total }) : a.runs.total ? t('counts.runsQuiet', { count: a.runs.total }) : quiet,
      to: '/runs?status=failed&within=24h',
      icon: IconAlertTriangle,
      notSetUp: noProcesses,
    },
  ];
  // runs that executed but whose checks found something (older servers: no count, no tile)
  const wf = a.runs.withFindings;
  if (wf !== undefined && !noProcesses)
    all.push({
      key: 'run-findings',
      label: t('counts.runFindings'),
      value: wf,
      tone: wf ? TONE.attention : null,
      detail: wf ? t('counts.ofRuns', { count: a.runs.total }) : a.runs.total ? t('counts.findingsQuiet') : quiet,
      to: '/runs?status=findings&within=24h',
      icon: IconListSearch,
    });
  const m = a.monitors;
  if (m)
    all.push({
      key: 'monitors',
      label: t('counts.monitorsDown'),
      value: m.down,
      tone: m.down ? MONITOR_COLORS.down : m.degraded ? MONITOR_COLORS.degraded : null,
      detail: !m.down && !m.degraded ? quiet : m.degraded ? t('counts.degraded', { count: m.degraded }) : t('counts.noneDegraded'),
      to: '/monitors?status=down,degraded',
      icon: IconHeartRateMonitor,
      notSetUp: none(m.total, 'monitors'),
    });
  const c = a.credentials;
  if (c) {
    const overdue = c.expired + c.overdue;
    all.push({
      key: 'credentials',
      label: t('counts.credentialsDue'),
      value: overdue + c.dueSoon,
      tone: c.expired ? TONE.bad : c.overdue ? TONE.attention : c.dueSoon ? TONE.soon : null,
      detail: overdue + c.dueSoon ? t('counts.credentialsSplit', { overdue: fmtNumber(overdue), dueSoon: fmtNumber(c.dueSoon) }) : quiet,
      to: '/credentials?status=expired,overdue,dueSoon',
      icon: IconKey,
      notSetUp: none(c.total, 'credentials'),
    });
  }
  if (a.findings)
    all.push({
      key: 'findings',
      label: t('counts.findings'),
      value: a.findings.open,
      tone: a.findings.open ? TONE.attention : null,
      detail: a.findings.open ? t('counts.findingsDetail') : quiet,
      to: '/compliance/reconciliation?findings=open',
      icon: IconArrowsDiff,
      notSetUp: none(a.findings.checks, 'accessChecks'),
    });
  const r = a.reviews;
  if (r)
    all.push({
      key: 'reviews',
      label: t('counts.reviewsDue'),
      value: r.overdue + r.dueSoon,
      tone: r.overdue ? TONE.attention : r.dueSoon ? TONE.soon : null,
      detail: r.overdue + r.dueSoon ? t('counts.reviewsSplit', { overdue: fmtNumber(r.overdue), dueSoon: fmtNumber(r.dueSoon) }) : quiet,
      to: '/records?workflow=document&review=overdue,dueSoon',
      icon: IconFileTime,
      notSetUp: none(r.total, 'documents'),
    });
  const du = a.duties;
  if (du)
    all.push({
      key: 'duties',
      label: t('counts.duties'),
      value: du.missed + du.dueSoon,
      tone: du.missed ? TONE.bad : du.dueSoon ? TONE.soon : null,
      detail: du.missed + du.dueSoon ? t('counts.dutiesSplit', { missed: fmtNumber(du.missed), dueSoon: fmtNumber(du.dueSoon) }) : quiet,
      to: '/duties?level=mandatory&status=attention',
      icon: IconCalendarDue,
      notSetUp: none(du.total, 'duties'),
    });
  const sc = a.scorecard;
  if (sc)
    all.push({
      key: 'scorecard',
      label: t('counts.scorecard'),
      value: sc.attention,
      tone: sc.attention ? TONE.attention : null,
      detail: sc.attention ? t('counts.scorecardOf', { count: sc.services, services: fmtNumber(sc.services) }) : quiet,
      to: '/scorecard?attention=1',
      icon: IconGauge,
      notSetUp: none(sc.services, 'services'),
    });
  const v = a.vendorTickets;
  if (v)
    all.push({
      key: 'vendor-tickets',
      label: t('counts.vendorTickets'),
      value: v.open,
      tone: v.open ? TONE.soon : null,
      detail: !v.open ? quiet : v.oldestDays ? t('counts.oldest', { count: v.oldestDays }) : t('counts.oldestToday'),
      to: '/tickets?waiting=vendor',
      icon: IconTicket,
      notSetUp: none(v.total, 'tickets'),
    });
  // the viewer's focus, in its order; features not set up yet after the others
  const focus = only ? only.flatMap((k) => all.filter((x) => x.key === k)) : all;
  const notSetUp = hideNotSetUp ? [] : focus.filter((x) => x.notSetUp);
  // features nobody set up yet fold into one line (phones since 0.4, every width since 0.11.0, U13)
  const folded = notSetUp.length > 1;
  const tiles = [...focus.filter((x) => !x.notSetUp), ...(folded ? [] : notSetUp)];

  return (
    <div>
      <SimpleGrid
        cols={COLS[tiles.length] ?? { base: 2, md: 3 }}
        spacing="xs"
        data-testid="start-tiles"
        data-count={tiles.length}
        className="attention-tiles"
        role="list"
        aria-label={t('counts.label')}
      >
        {tiles.map((x) => (
          <div key={x.key} role="listitem">
            <AttentionTile tile={x} />
          </div>
        ))}
      </SimpleGrid>
      {folded && (
        <Text size="xs" c="dimmed" mt="xs" data-testid="tiles-not-set-up">
          {t('counts.notSetUpList')}{' '}
          {notSetUp.map((x, i) => (
            <span key={x.key}>
              {i > 0 && ' · '}
              <Anchor component={Link} to={x.to.split('?')[0]!} inherit>
                {x.label}
              </Anchor>
            </span>
          ))}
        </Text>
      )}
    </div>
  );
}

// the visible label, number and detail are its accessible name (WCAG 2.5.3: the name contains the visible text)
function AttentionTile({ tile }: { tile: Tile }) {
  const { t } = useTranslation('dashboard');
  if (tile.notSetUp) return <NotSetUpTile tile={tile} label={t('counts.notSetUpYet')} />;
  const color = tile.tone ?? TONE.ok;
  const Icon = tile.tone ? tile.icon : IconCircleCheck;
  return (
    <Paper
      withBorder
      p="sm"
      component={Link}
      to={tile.to}
      data-testid={`tile-${tile.key}`}
      data-state={tile.tone ? 'attention' : 'quiet'}
      className="clickable attention-tile"
      style={{
        color: 'inherit',
        textDecoration: 'none',
        display: 'block',
        height: '100%',
        // non-zero tiles carry the status colour on the left edge as well (the number and the text say it, too)
        ...(tile.tone ? { borderLeft: `4px solid var(--mantine-color-${tile.tone}-filled)` } : {}),
      }}
    >
      <Text size="xs" c="dimmed" fw={500}>
        {tile.label}
      </Text>
      <Group gap={6} align="center" wrap="nowrap">
        <Icon size={20} aria-hidden color={`var(--mantine-color-${color}-text)`} />
        <Text fw={700} fz={26} lh={1.3} c={color}>
          {fmtNumber(tile.value)}
        </Text>
      </Group>
      <Text size="xs" c="dimmed" lineClamp={2}>
        {tile.detail}
      </Text>
    </Paper>
  );
}

/** A feature nobody set up yet: neutral – no number, no "All quiet" – with what is missing. */
function NotSetUpTile({ tile, label }: { tile: Tile; label: string }) {
  return (
    <Paper
      withBorder
      p="sm"
      component={Link}
      to={tile.to.split('?')[0]!}
      data-testid={`tile-${tile.key}`}
      data-state="not-set-up"
      className="clickable attention-tile"
      style={{ color: 'inherit', textDecoration: 'none', display: 'block', height: '100%', borderStyle: 'dashed' }}
    >
      <Text size="xs" c="dimmed" fw={500}>
        {tile.label}
      </Text>
      <Group gap={6} align="center" wrap="nowrap" mih={34}>
        <IconCircleDashed size={18} aria-hidden color="var(--mantine-color-dimmed)" />
        <Text fw={600} size="sm" c="dimmed">
          {label}
        </Text>
      </Group>
      <Text size="xs" c="dimmed" lineClamp={2}>
        {tile.notSetUp}
      </Text>
    </Paper>
  );
}
