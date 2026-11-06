import type { ReactNode } from 'react';
import { ActionIcon, Badge, Group, Menu, Paper, SegmentedControl, Stack, Switch, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import {
  IconAlertTriangle,
  IconChartTreemap,
  IconCircleCheck,
  IconCircleX,
  IconDownload,
  IconHelpCircle,
  IconPhoto,
  IconTable,
  IconVectorBezier2,
  type Icon,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ASSET_STATUSES, type AssetStatus, type PlantLive, type PlantLiveState } from '@sm/shared';
import { notifyError } from '../../../api';
import { useMotion, type ViewMode } from './prefs';
import './views.css';

/** Building blocks shared by the plant views (#230): status marks, the toolbar, the legend. */

export const statusVar = (s: AssetStatus) => `var(--pv-${s})`;
export const liveVar = (s: PlantLiveState) => `var(--pv-${s})`;

export const LIVE_ICON: Record<PlantLiveState, Icon> = { ok: IconCircleCheck, warn: IconAlertTriangle, fail: IconCircleX, unknown: IconHelpCircle };
const LIVE_COLOR: Record<PlantLiveState, string> = { ok: 'green', warn: 'orange', fail: 'red', unknown: 'gray' };

/** The word of a linked item's state: a monitor's status or a dataset's freshness. */
export function useLiveText() {
  const { t } = useTranslation('plantViews');
  return (l: Pick<PlantLive, 'source' | 'status'>) => t(`live.${l.source}.${l.status}`, { defaultValue: t('live.unknownStatus', { status: l.status }) });
}

/** Live status of a linked item: icon + word (+ where it comes from), never colour alone. */
export function LiveBadge({
  live,
  size = 'sm',
  withSource = false,
  focusable = true,
}: {
  live: PlantLive;
  size?: 'xs' | 'sm';
  withSource?: boolean;
  /** Inside a focusable graph node the node itself is the stop */
  focusable?: boolean;
}) {
  const { t } = useTranslation('plantViews');
  const text = useLiveText();
  const I = LIVE_ICON[live.state];
  const word = text(live);
  return (
    <Tooltip label={live.label ? t(`live.from.${live.source}`, { name: live.label }) : t(`live.fromAny.${live.source}`)} withArrow multiline maw={260}>
      <Badge
        size={size}
        color={LIVE_COLOR[live.state]}
        variant="light"
        leftSection={<I size={size === 'xs' ? 10 : 12} aria-hidden />}
        style={{ minWidth: 'max-content', textTransform: 'none' }}
        data-live={live.state}
        tabIndex={focusable ? 0 : undefined}
      >
        {withSource ? t(`live.sourceWord.${live.source}`, { word }) : word}
      </Badge>
    </Tooltip>
  );
}

/** Counts of live states as a short text: "2 up · 1 down" (empty: no linked monitor). */
export function useLiveCounts() {
  const { t } = useTranslation('plantViews');
  return (live: Partial<Record<PlantLiveState, number>>) =>
    (['fail', 'warn', 'unknown', 'ok'] as const)
      .filter((s) => live[s])
      .map((s) => t(`liveCount.${s}`, { count: live[s] }))
      .join(' · ');
}

/** A horizontal bar of counts with a 2 px gap between parts (assets by status, coverage). */
export function CountBar({
  parts,
  height = 8,
  label,
}: {
  parts: { key: string; value: number; color: string; text: string }[];
  height?: number;
  label: string;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="pv-bar" style={{ height }} role="img" aria-label={label}>
      {total === 0 ? (
        <span style={{ flex: 1, background: 'var(--mantine-color-default-border)' }} />
      ) : (
        parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <Tooltip key={p.key} label={p.text} withArrow>
              <span style={{ flex: p.value, background: p.color }} />
            </Tooltip>
          ))
      )}
    </div>
  );
}

/** Assets by documented status as a bar (operational, commissioning, maintenance …). */
export function StatusBar({ counts, height = 8 }: { counts: Partial<Record<AssetStatus, number>>; height?: number }) {
  const { t } = useTranslation(['plantViews', 'plant']);
  const parts = ASSET_STATUSES.map((s) => ({ key: s, value: counts[s] ?? 0, color: statusVar(s), text: `${t(`plant:status.${s}`)}: ${counts[s] ?? 0}` }));
  const label = parts
    .filter((p) => p.value)
    .map((p) => p.text)
    .join(', ');
  return <CountBar parts={parts} height={height} label={label || t('noAssets')} />;
}

/** The arcs of a ring (donut) as SVG paths: one per part, a small gap between them. */
export function ringArcs(parts: { value: number; color: string }[], r: number): { d: string; color: string }[] {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return [];
  const shown = parts.filter((p) => p.value > 0);
  if (shown.length === 1) {
    // a full ring: two half arcs
    const d = `M ${r} 0 A ${r} ${r} 0 1 1 ${-r} 0 A ${r} ${r} 0 1 1 ${r} 0`;
    return [{ d, color: shown[0]!.color }];
  }
  const gap = Math.min(0.08, 0.6 / shown.length);
  let a0 = -Math.PI / 2;
  return shown.map((p) => {
    const sweep = (p.value / total) * Math.PI * 2;
    const s = a0 + gap / 2;
    const e = a0 + Math.max(sweep - gap / 2, gap / 2 + 0.001);
    a0 += sweep;
    const large = e - s > Math.PI ? 1 : 0;
    const pt = (a: number) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
    return { d: `M ${pt(s)} A ${r} ${r} 0 ${large} 1 ${pt(e)}`, color: p.color };
  });
}

/** The status ring of a node: assets by documented status (outer), linked monitors by state (inner, when known). */
export function StatusRing({
  counts,
  live,
  size = 44,
  label,
}: {
  counts: Partial<Record<AssetStatus, number>>;
  live?: Partial<Record<PlantLiveState, number>>;
  size?: number;
  label: string;
}) {
  const r = size / 2 - 4;
  const outer = ringArcs(
    ASSET_STATUSES.map((s) => ({ value: counts[s] ?? 0, color: statusVar(s) })),
    r,
  );
  const inner = live
    ? ringArcs(
        (['ok', 'warn', 'fail', 'unknown'] as const).map((s) => ({ value: live[s] ?? 0, color: liveVar(s) })),
        r - 7,
      )
    : [];
  return (
    <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} role="img" aria-label={label}>
      <circle r={r} fill="none" stroke="var(--mantine-color-default-border)" strokeWidth={5} opacity={outer.length ? 0 : 1} />
      {outer.map((a, i) => (
        <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={5} strokeLinecap="butt" />
      ))}
      {inner.map((a, i) => (
        <path key={`l${i}`} d={a.d} fill="none" stroke={a.color} strokeWidth={3} />
      ))}
    </svg>
  );
}

/** Picture or table, the animation switch and the export of a view. */
export function ViewToolbar({
  mode,
  onMode,
  onExport,
  motion = true,
  pictureIcon = IconVectorBezier2,
  children,
}: {
  mode: ViewMode;
  onMode: (m: ViewMode) => void;
  /** Draws the SVG of what is shown (null: nothing to export) */
  onExport?: (() => { svg: string; width: number; height: number; title: string } | null) | null;
  /** The view animates (the switch is shown) */
  motion?: boolean;
  pictureIcon?: Icon;
  children?: ReactNode;
}) {
  const { t } = useTranslation('plantViews');
  const m = useMotion();
  const P = pictureIcon;
  const run = async (kind: 'svg' | 'png') => {
    const x = onExport?.();
    if (!x) return;
    const { downloadPng, downloadSvg } = await import('./exportImage');
    try {
      if (kind === 'svg') downloadSvg(x.svg, x.title);
      else await downloadPng(x.svg, x.title, x.width, x.height);
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Group justify="space-between" gap="xs" wrap="wrap" data-testid="view-toolbar">
      <Group gap="xs" wrap="wrap">
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(v) => onMode(v as ViewMode)}
          aria-label={t('toolbar.mode')}
          data={[
            {
              value: 'picture',
              label: (
                <Group gap={4} wrap="nowrap" component="span">
                  <P size={14} aria-hidden />
                  <span>{t('toolbar.picture')}</span>
                </Group>
              ),
            },
            {
              value: 'table',
              label: (
                <Group gap={4} wrap="nowrap" component="span">
                  <IconTable size={14} aria-hidden />
                  <span>{t('toolbar.table')}</span>
                </Group>
              ),
            },
          ]}
          data-testid="view-mode"
        />
        {children}
      </Group>
      <Group gap="xs" wrap="nowrap">
        {motion && mode === 'picture' && (
          <Tooltip label={t('toolbar.reducedHint')} disabled={!m.reduced} withArrow multiline maw={260}>
            <Switch
              size="xs"
              label={t('toolbar.animationOff')}
              checked={m.off || m.reduced}
              disabled={m.reduced}
              onChange={(e) => m.setOff(e.currentTarget.checked)}
              data-testid="animation-off"
            />
          </Tooltip>
        )}
        {onExport && (
          <Menu position="bottom-end" withinPortal shadow="md">
            <Menu.Target>
              <Tooltip label={t('toolbar.export')} withArrow>
                <ActionIcon variant="default" size="input-xs" aria-label={t('toolbar.export')} data-testid="view-export">
                  <IconDownload size={16} />
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconChartTreemap size={14} />} onClick={() => void run('svg')} data-testid="export-svg">
                {t('toolbar.exportSvg')}
              </Menu.Item>
              <Menu.Item leftSection={<IconPhoto size={14} />} onClick={() => void run('png')} data-testid="export-png">
                {t('toolbar.exportPng')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
    </Group>
  );
}

/** One entry of a legend: a small mark and its text. */
export function LegendItem({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <Group gap={6} wrap="nowrap" align="center" component="li" style={{ listStyle: 'none' }}>
      <span aria-hidden style={{ display: 'inline-flex', flexShrink: 0 }}>
        {mark}
      </span>
      <Text size="xs">{children}</Text>
    </Group>
  );
}

/** A line sample for a legend: documented flow, not active, a failing check. */
export function LineMark({ kind }: { kind: 'flow' | 'inactive' | 'problem' | 'online' | 'offline' }) {
  const { animate } = useMotion();
  return (
    <svg width={34} height={10} viewBox="0 0 34 10">
      <path
        d="M1 5 H27"
        className="pv-edge-base"
        data-inactive={kind === 'inactive' || undefined}
        data-problem={kind === 'problem' || kind === 'offline' || undefined}
        data-online={kind === 'online' || undefined}
        strokeWidth={2}
        style={kind === 'offline' ? { strokeDasharray: 'none' } : undefined}
      />
      {(kind === 'flow' || kind === 'online') && animate && <path d="M1 5 H27" className="pv-edge-flow" strokeWidth={2.5} />}
      <path
        d="M27 1 L33 5 L27 9 Z"
        fill={kind === 'problem' || kind === 'offline' ? 'var(--pv-problem)' : kind === 'online' ? 'var(--pv-ok)' : 'var(--pv-edge)'}
      />
    </svg>
  );
}

/**
 * The legend of a view: which parts have live status (and from what), which are documentation only. Shown with every
 * picture, so nobody mistakes the drawing for monitoring.
 */
export function ViewLegend({ live, children, testId = 'view-legend' }: { live: string; children?: ReactNode; testId?: string }) {
  const { t } = useTranslation('plantViews');
  return (
    <Paper withBorder p="xs" radius="md" data-testid={testId}>
      <Stack gap={6}>
        <Group gap={6} wrap="nowrap" align="flex-start">
          <IconCircleCheck size={14} aria-hidden style={{ marginTop: 2, flexShrink: 0, color: 'var(--pv-ok)' }} />
          <Text size="xs">
            <Text span fw={600} size="xs">
              {t('legend.liveTitle')}
            </Text>{' '}
            {live}
          </Text>
        </Group>
        <Group gap={6} wrap="nowrap" align="flex-start">
          <IconHelpCircle size={14} aria-hidden style={{ marginTop: 2, flexShrink: 0, color: 'var(--pv-unknown)' }} />
          <Text size="xs">
            <Text span fw={600} size="xs">
              {t('legend.docTitle')}
            </Text>{' '}
            {t('legend.doc')}
          </Text>
        </Group>
        {children && (
          <Group gap="md" wrap="wrap" component="ul" m={0} p={0}>
            {children}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

/** Text only for screen readers (status words beside a mark). */
export const SrOnly = ({ children }: { children: ReactNode }) => <VisuallyHidden>{children}</VisuallyHidden>;
