import { useState, type KeyboardEvent } from 'react';
import { Group, Table, Text } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import type { CostCurrencySummary } from '@sm/shared';
import { compact, niceTicks } from '../dashboard/format';
import { fmtMonth, fmtMonthOnly, fmtMoney } from './common';

/**
 * The months of one currency as bars (#226): the 12 complete months in the first series colour, the current month so
 * far hatched in the same colour, its forecast as a dashed outline, and the monthly budget as a dashed reference line.
 * One series, so no legend box – the key below names the hatching, the outline and the line. Hover or the arrow keys
 * show a month; the table twin lists every month.
 */
export function CostChart({ c, budget, height = 220 }: { c: CostCurrencySummary; budget?: number | null; height?: number }) {
  const { t } = useTranslation('costs');
  const { ref, width } = useElementSize();
  const [hover, setHover] = useState<number | null>(null);
  const months = c.months;
  const values = months.map((m) => (m.amount === null ? null : Number(m.amount)));
  const forecast = c.forecast === null ? null : Number(c.forecast);
  const max = Math.max(0, ...values.map((v) => v ?? 0), forecast ?? 0, budget ?? 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const labelW = Math.max(...ticks.map((x) => compact(x).length)) * 7 + 10;
  const m = { l: labelW, r: 8, t: 10, b: 24 };
  const w = Math.max(width, 200);
  const plotW = w - m.l - m.r;
  const plotH = height - m.t - m.b;
  const slot = plotW / months.length;
  const barW = Math.max(4, Math.min(36, slot - 4));
  const x = (i: number) => m.l + i * slot + (slot - barW) / 2;
  const y = (v: number) => m.t + plotH - (v / top) * plotH;
  const last = months.length - 1;
  // every other month label on narrow charts
  const every = slot < 34 ? 3 : slot < 52 ? 2 : 1;
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? months.length) - 1));
    else if (e.key === 'ArrowRight') setHover((h) => Math.min(last, (h ?? -1) + 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };
  const bar = (i: number, v: number) => {
    const h = Math.max(0, y(0) - y(v));
    // 4px rounded data end, anchored to the baseline
    const r = Math.min(4, barW / 2, h);
    const x0 = x(i);
    const y0 = y(v);
    return `M${x0},${y(0)}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + barW - r}Q${x0 + barW},${y0} ${x0 + barW},${y0 + r}V${y(0)}Z`;
  };
  const hv = hover !== null ? values[hover] : undefined;
  const label = t('chart.label', { currency: c.currency, from: fmtMonth(months[0]!.month), to: fmtMonth(months[last]!.month) });
  return (
    <div className="viz-root">
      <div ref={ref} style={{ position: 'relative', width: '100%' }}>
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={label}
          tabIndex={0}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          style={{ display: 'block', touchAction: 'pan-y' }}
          data-testid="cost-chart"
        >
          <defs>
            <pattern id={`hatch-${c.currency}`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill="var(--viz-surface)" />
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--viz-series-1)" strokeWidth={3} />
            </pattern>
          </defs>
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={m.l} x2={w - m.r} y1={y(tk)} y2={y(tk)} stroke={tk === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
              <text x={m.l - 6} y={y(tk)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--viz-muted)" className="viz-num">
                {compact(tk)}
              </text>
            </g>
          ))}
          {months.map((mo, i) => {
            const v = values[i] ?? null;
            return (
              <g key={mo.month} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
                {/* the hit target is the whole column, larger than the bar */}
                <rect x={m.l + i * slot} y={m.t} width={slot} height={plotH} fill="transparent" />
                {i === last && forecast !== null && forecast > (v ?? 0) && (
                  <path d={bar(i, forecast)} fill="none" stroke="var(--viz-muted)" strokeWidth={1.5} strokeDasharray="4 3" data-testid="forecast-bar" />
                )}
                {v !== null && v > 0 && (
                  <path
                    d={bar(i, v)}
                    fill={i === last ? `url(#hatch-${c.currency})` : 'var(--viz-series-1)'}
                    stroke={i === last ? 'var(--viz-series-1)' : 'none'}
                    strokeWidth={1}
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                )}
                {i % every === last % every && (
                  <text x={x(i) + barW / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--viz-muted)">
                    {fmtMonthOnly(mo.month)}
                  </text>
                )}
              </g>
            );
          })}
          {budget !== null && budget !== undefined && budget > 0 && (
            <g>
              <line
                x1={m.l}
                x2={w - m.r}
                y1={y(budget)}
                y2={y(budget)}
                stroke="var(--viz-text-secondary)"
                strokeWidth={1.5}
                strokeDasharray="6 4"
                data-testid="budget-line"
              />
            </g>
          )}
        </svg>
        {hover !== null && (
          <div className="viz-tooltip" style={{ top: 4, ...(x(hover) > w * 0.6 ? { right: w - x(hover) + 6 } : { left: x(hover) + barW + 6 }) }}>
            <div className="viz-tt-label">{fmtMonth(months[hover]!.month, 'long')}</div>
            <div className="viz-tt-value viz-num">{hv === null || hv === undefined ? '–' : fmtMoney(String(hv), c.currency)}</div>
            {hover === last && forecast !== null && (
              <div className="viz-tt-label">{t('chart.forecastTip', { amount: fmtMoney(String(forecast), c.currency) })}</div>
            )}
          </div>
        )}
      </div>
      <Group gap="md" mt={4} wrap="wrap">
        <Group gap={6} wrap="nowrap">
          <svg width={14} height={10} aria-hidden>
            <rect width={14} height={10} rx={2} fill="var(--viz-series-1)" />
          </svg>
          <Text size="xs" c="var(--viz-text-secondary)">
            {t('chart.months')}
          </Text>
        </Group>
        <Group gap={6} wrap="nowrap">
          <svg width={14} height={10} aria-hidden>
            <rect width={14} height={10} rx={2} fill={`url(#hatch-${c.currency})`} stroke="var(--viz-series-1)" />
          </svg>
          <Text size="xs" c="var(--viz-text-secondary)">
            {t('chart.soFar')}
          </Text>
        </Group>
        {forecast !== null && (
          <Group gap={6} wrap="nowrap">
            <svg width={14} height={10} aria-hidden>
              <rect x={1} y={1} width={12} height={8} rx={2} fill="none" stroke="var(--viz-muted)" strokeDasharray="3 2" />
            </svg>
            <Text size="xs" c="var(--viz-text-secondary)">
              {t('chart.forecast')}
            </Text>
          </Group>
        )}
        {budget !== null && budget !== undefined && budget > 0 && (
          <Group gap={6} wrap="nowrap">
            <svg width={14} height={10} aria-hidden>
              <line x1={0} x2={14} y1={5} y2={5} stroke="var(--viz-text-secondary)" strokeWidth={1.5} strokeDasharray="4 3" />
            </svg>
            <Text size="xs" c="var(--viz-text-secondary)">
              {t('chart.budget')}
            </Text>
          </Group>
        )}
      </Group>
    </div>
  );
}

/** The table twin of the chart: every month with EffectiveCost and BilledCost. */
export function CostMonthsTable({ c }: { c: CostCurrencySummary }) {
  const { t } = useTranslation('costs');
  return (
    <Table.ScrollContainer minWidth={320}>
      <Table striped withTableBorder fz="sm" data-testid="cost-months">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('table.month')}</Table.Th>
            <Table.Th ta="right">{t('table.effective')}</Table.Th>
            <Table.Th ta="right">{t('table.billed')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {[...c.months].reverse().map((mo, i) => (
            <Table.Tr key={mo.month}>
              <Table.Td>
                {fmtMonth(mo.month, 'long')}
                {i === 0 ? ` (${t('table.soFar')})` : ''}
              </Table.Td>
              <Table.Td ta="right" className="viz-num">
                {fmtMoney(mo.amount, c.currency)}
              </Table.Td>
              <Table.Td ta="right" className="viz-num">
                {fmtMoney(mo.billed, c.currency)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
