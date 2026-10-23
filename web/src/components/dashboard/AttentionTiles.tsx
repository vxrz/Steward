import { Group, Paper, SimpleGrid, Text, type SimpleGridProps } from '@mantine/core';
import { Link } from 'react-router-dom';
import {
  IconAlertTriangle,
  IconArrowsDiff,
  IconCircleCheck,
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
}

/** Columns per number of tiles, so the grid never ends in a lonely half row (five: the last tile spans the row, styles.css). */
const COLS: Record<number, SimpleGridProps['cols']> = {
  1: { base: 1 },
  2: { base: 2 },
  3: { base: 1, xs: 3 },
  4: { base: 2, lg: 4 },
  5: { base: 2, lg: 5 },
  6: { base: 2, md: 3 },
};

/** The start page's tiles: what needs the user's attention. Tiles the server left out (no right) are not shown. */
export function AttentionTiles({ a }: { a: DashboardAttention }) {
  const { t } = useTranslation('dashboard');
  const quiet = t('counts.allQuiet');
  const tiles: Tile[] = [
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
    },
  ];
  const m = a.monitors;
  if (m)
    tiles.push({
      key: 'monitors',
      label: t('counts.monitorsDown'),
      value: m.down,
      tone: m.down ? MONITOR_COLORS.down : m.degraded ? MONITOR_COLORS.degraded : null,
      detail: !m.down && !m.degraded ? quiet : m.degraded ? t('counts.degraded', { count: m.degraded }) : t('counts.noneDegraded'),
      to: '/monitors?status=down,degraded',
      icon: IconHeartRateMonitor,
    });
  const c = a.credentials;
  if (c) {
    const overdue = c.expired + c.overdue;
    tiles.push({
      key: 'credentials',
      label: t('counts.credentialsDue'),
      value: overdue + c.dueSoon,
      tone: c.expired ? TONE.bad : c.overdue ? TONE.attention : c.dueSoon ? TONE.soon : null,
      detail: overdue + c.dueSoon ? t('counts.credentialsSplit', { overdue: fmtNumber(overdue), dueSoon: fmtNumber(c.dueSoon) }) : quiet,
      to: '/credentials?status=expired,overdue,dueSoon',
      icon: IconKey,
    });
  }
  if (a.findings)
    tiles.push({
      key: 'findings',
      label: t('counts.findings'),
      value: a.findings.open,
      tone: a.findings.open ? TONE.attention : null,
      detail: a.findings.open ? t('counts.findingsDetail') : quiet,
      to: '/compliance/reconciliation?findings=open',
      icon: IconArrowsDiff,
    });
  const v = a.vendorTickets;
  if (v)
    tiles.push({
      key: 'vendor-tickets',
      label: t('counts.vendorTickets'),
      value: v.open,
      tone: v.open ? TONE.soon : null,
      detail: !v.open ? quiet : v.oldestDays ? t('counts.oldest', { count: v.oldestDays }) : t('counts.oldestToday'),
      to: '/tickets?waiting=vendor',
      icon: IconTicket,
    });

  return (
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
          <AttentionTile tile={x} name={t('counts.name', { label: x.label, value: fmtNumber(x.value), detail: x.detail })} />
        </div>
      ))}
    </SimpleGrid>
  );
}

function AttentionTile({ tile, name }: { tile: Tile; name: string }) {
  const color = tile.tone ?? TONE.ok;
  const Icon = tile.tone ? tile.icon : IconCircleCheck;
  return (
    <Paper
      withBorder
      p="sm"
      component={Link}
      to={tile.to}
      aria-label={name}
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
