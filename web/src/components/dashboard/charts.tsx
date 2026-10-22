import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Group, Table, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import type { DatasetStatus, MetricSeries } from '@sm/shared';
import { axisLabel, compact, dateTime, niceTicks, percent } from './format';
import { STATUS_META, STATUS_ORDER, StatusLabel } from './status';

/** Categorical slots 1–3 (fixed order: the color follows the metric's position in the widget, never its rank). */
export const SERIES_COLORS = ['var(--viz-series-1)', 'var(--viz-series-2)', 'var(--viz-series-3)'];

interface Pt {
  t: number;
  v: number;
}

function LineKey({ color }: { color: string }) {
  return (
    <svg width={14} height={8} aria-hidden style={{ flexShrink: 0 }}>
      <line x1={1} y1={4} x2={13} y2={4} stroke={color} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Trend (multi-line) chart
// ---------------------------------------------------------------------------

export function TrendChart({ series, names, height = 220 }: { series: MetricSeries[]; names: string[]; height?: number }) {
  const { t } = useTranslation('dashboards');
  const { ref, width } = useElementSize();
  const [hover, setHover] = useState<number | null>(null);

  const lines = useMemo(
    () =>
      names.map((name, i) => ({
        name,
        color: SERIES_COLORS[i] ?? SERIES_COLORS[0]!,
        pts: (series.find((s) => s.name === name)?.points ?? []).map((p) => ({ t: Date.parse(p.ts), v: p.value })) as Pt[],
      })),
    [series, names],
  );
  const times = useMemo(() => [...new Set(lines.flatMap((l) => l.pts.map((p) => p.t)))].sort((a, b) => a - b), [lines]);
  const maxV = Math.max(0, ...lines.flatMap((l) => l.pts.map((p) => p.v)));
  const ticks = niceTicks(maxV);
  const top = ticks[ticks.length - 1]!;
  const labelW = Math.max(...ticks.map((t) => compact(t).length)) * 7 + 10;
  const m = { l: labelW, r: 44, t: 10, b: 24 };
  const w = Math.max(width, 120);
  const plotW = w - m.l - m.r;
  const plotH = height - m.t - m.b;
  let t0 = times[0] ?? Date.now();
  let t1 = times[times.length - 1] ?? Date.now();
  if (t1 - t0 < 3600000) {
    t0 -= 1800000;
    t1 += 1800000;
  }
  const x = (t: number) => m.l + ((t - t0) / (t1 - t0)) * plotW;
  const y = (v: number) => m.t + plotH - (v / top) * plotH;

  const xTicks = useMemo(() => {
    const n = Math.max(2, Math.min(6, Math.floor(plotW / 90)));
    return Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
  }, [t0, t1, plotW]);

  const nearest = (px: number) => {
    if (!times.length) return null;
    const t = t0 + ((px - m.l) / plotW) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i]! - t) < Math.abs(times[best]! - t)) best = i;
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(nearest(e.clientX - r.left));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!times.length) return;
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? times.length) - 1));
    else if (e.key === 'ArrowRight') setHover((h) => Math.min(times.length - 1, (h ?? -1) + 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const valueAt = (pts: Pt[], t: number) => pts.find((p) => p.t === t)?.v;
  // selective direct labels: latest values at the line ends, only when they don't collide
  const ends = lines.filter((l) => l.pts.length).map((l) => ({ ...l, last: l.pts[l.pts.length - 1]! }));
  const endYs = ends.map((e) => y(e.last.v)).sort((a, b) => a - b);
  const endLabels = ends.length > 0 && endYs.every((v, i) => i === 0 || v - endYs[i - 1]! >= 14);
  const ht = hover !== null ? times[hover] : undefined;

  return (
    <div className="viz-root">
      {lines.length >= 2 && (
        <Group gap={14} mb={4}>
          {lines.map((l) => (
            <Group key={l.name} gap={6} wrap="nowrap">
              <LineKey color={l.color} />
              <Text size="xs" c="var(--viz-text-secondary)">
                {l.name}
              </Text>
            </Group>
          ))}
        </Group>
      )}
      <div ref={ref} style={{ position: 'relative', width: '100%' }}>
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={t('charts.trendLabel', { names: names.join(', ') })}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          style={{ display: 'block', outline: 'none', touchAction: 'pan-y' }}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
              <text x={m.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--viz-muted)" className="viz-num">
                {compact(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={i}
              x={x(t)}
              y={height - 6}
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
              fontSize={11}
              fill="var(--viz-muted)"
            >
              {axisLabel(t, t1 - t0)}
            </text>
          ))}
          {lines.map((l) =>
            l.pts.length ? (
              <path
                key={l.name}
                d={l.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}
                fill="none"
                stroke={l.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ) : null,
          )}
          {ends.map((e) => (
            <g key={e.name}>
              <circle cx={x(e.last.t)} cy={y(e.last.v)} r={4} fill={e.color} stroke="var(--viz-surface)" strokeWidth={2} />
              {endLabels && (
                <text x={x(e.last.t) + 8} y={y(e.last.v)} dy="0.32em" fontSize={11} fill="var(--viz-text-secondary)" className="viz-num">
                  {compact(e.last.v)}
                </text>
              )}
            </g>
          ))}
          {ht !== undefined && (
            <g>
              <line x1={x(ht)} x2={x(ht)} y1={m.t} y2={m.t + plotH} stroke="var(--viz-crosshair)" strokeWidth={1} />
              {lines.map((l) => {
                const v = valueAt(l.pts, ht);
                return v === undefined ? null : <circle key={l.name} cx={x(ht)} cy={y(v)} r={4} fill={l.color} stroke="var(--viz-surface)" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
        {ht !== undefined && (
          <div className="viz-tooltip" style={{ top: 4, ...(x(ht) > w * 0.6 ? { right: w - x(ht) + 10 } : { left: x(ht) + 10 }) }}>
            <div className="viz-tt-label">{dateTime(ht)}</div>
            {lines.map((l) => {
              const v = valueAt(l.pts, ht);
              return (
                <Group key={l.name} gap={6} wrap="nowrap">
                  <LineKey color={l.color} />
                  <span className="viz-tt-value viz-num">{v === undefined ? '–' : compact(v)}</span>
                  <span className="viz-tt-label">{l.name}</span>
                </Group>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Table twin of a trend chart. */
export function TrendTable({ series, names }: { series: MetricSeries[]; names: string[] }) {
  const { t } = useTranslation('dashboards');
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.ts)))].sort().reverse();
  const val = (name: string, ts: string) => series.find((s) => s.name === name)?.points.find((p) => p.ts === ts)?.value;
  return (
    <div
      className="table-scroll"
      style={{ maxHeight: 260, overflowY: 'auto' }}
      tabIndex={0}
      role="region"
      aria-label={t('charts.valuesOf', { names: names.join(', ') })}
    >
      <Table fz="xs" striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('charts.time')}</Table.Th>
            {names.map((n) => (
              <Table.Th key={n} ta="right">
                {n}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {times.map((ts) => (
            <Table.Tr key={ts}>
              <Table.Td className="nowrap">{dateTime(ts)}</Table.Td>
              {names.map((n) => (
                <Table.Td key={n} ta="right" className="viz-num">
                  {compact(val(n, ts))}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline (stat tiles)
// ---------------------------------------------------------------------------

export function Sparkline({ points, height = 36 }: { points: { ts: string; value: number }[]; height?: number }) {
  const { ref, width } = useElementSize();
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(width, 60);
  if (points.length < 2) return <div ref={ref} style={{ height }} />;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pad = 5;
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const last = points.length - 1;
  const h = hover ?? undefined;
  return (
    <div ref={ref} className="viz-root" style={{ position: 'relative', width: '100%' }}>
      <svg
        width={w}
        height={height}
        style={{ display: 'block' }}
        aria-hidden
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - pad) / (w - pad * 2)) * last);
          setHover(Math.max(0, Math.min(last, i)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <path
          d={points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('')}
          fill="none"
          stroke="var(--viz-deemph)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={x(last)} cy={y(points[last]!.value)} r={4} fill="var(--viz-series-1)" stroke="var(--viz-surface)" strokeWidth={2} />
        {h !== undefined && <line x1={x(h)} x2={x(h)} y1={0} y2={height} stroke="var(--viz-crosshair)" strokeWidth={1} />}
      </svg>
      {h !== undefined && (
        <div className="viz-tooltip" style={{ bottom: height + 2, ...(x(h) > w / 2 ? { right: w - x(h) } : { left: x(h) }) }}>
          <span className="viz-tt-value viz-num">{compact(points[h]!.value)}</span> <span className="viz-tt-label">{dateTime(points[h]!.ts)}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status distribution (100 % stacked bar)
// ---------------------------------------------------------------------------

export function StatusBar({
  counts,
  active,
  onSelect,
}: {
  counts: Partial<Record<DatasetStatus, number>>;
  active?: DatasetStatus | null;
  onSelect?: (s: DatasetStatus | null) => void;
}) {
  const { t } = useTranslation('dashboards');
  const total = STATUS_ORDER.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const present = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);
  if (!total)
    return (
      <Text size="sm" c="dimmed">
        {t('charts.noStatusRows')}
      </Text>
    );
  const pct = (n: number) => percent(n / total);
  return (
    <div className="viz-root">
      <div style={{ display: 'flex', gap: 2, width: '100%' }} role="list" aria-label={t('widgets.status.label')}>
        {present.map((s, i) => {
          const n = counts[s]!;
          const last = i === present.length - 1;
          return (
            <Tooltip
              key={s}
              label={t(onSelect ? 'charts.segmentFilter' : 'charts.segment', { status: STATUS_META[s].label, count: n, share: pct(n) })}
              withArrow
            >
              <div
                role="listitem"
                tabIndex={0}
                aria-label={`${STATUS_META[s].label}: ${n}`}
                className="viz-status-seg"
                data-dim={!!active && active !== s}
                onClick={() => onSelect?.(active === s ? null : s)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(active === s ? null : s);
                  }
                }}
                style={{
                  flexGrow: n,
                  flexBasis: 0,
                  background: STATUS_META[s].color,
                  borderTopRightRadius: last ? 4 : 0,
                  borderBottomRightRadius: last ? 4 : 0,
                }}
              />
            </Tooltip>
          );
        })}
      </div>
      <Group gap={14} mt={8} wrap="wrap">
        {present.map((s) => (
          <UnstyledButton key={s} onClick={() => onSelect?.(active === s ? null : s)} style={{ opacity: active && active !== s ? 0.5 : 1 }}>
            <Group gap={4} wrap="nowrap">
              <StatusLabel status={s} size="sm" />
              <Text size="sm" fw={600} className="viz-num">
                {counts[s]}
              </Text>
              <Text size="xs" c="var(--viz-text-secondary)">
                {pct(counts[s]!)}
              </Text>
            </Group>
          </UnstyledButton>
        ))}
      </Group>
    </div>
  );
}

export function StatusTable({ counts }: { counts: Partial<Record<DatasetStatus, number>> }) {
  const { t } = useTranslation('dashboards');
  const total = STATUS_ORDER.reduce((n, s) => n + (counts[s] ?? 0), 0) || 1;
  return (
    <Table fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t('datasets.status')}</Table.Th>
          <Table.Th ta="right">{t('datasets.rows')}</Table.Th>
          <Table.Th ta="right">{t('charts.share')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {STATUS_ORDER.map((s) => (
          <Table.Tr key={s}>
            <Table.Td>
              <StatusLabel status={s} />
            </Table.Td>
            <Table.Td ta="right" className="viz-num">
              {counts[s] ?? 0}
            </Table.Td>
            <Table.Td ta="right" className="viz-num">
              {percent((counts[s] ?? 0) / total)}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
