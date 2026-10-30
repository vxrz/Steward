import { describe, expect, it } from 'vitest';
import { forecastTo, theilSen, trendLine, trendOf, windowMs, type TrendPoint } from '@sm/shared';

/** Trends and forecasts (#145): the math – a robust line, gaps, resets, flat lines, too few points, forecasts. */

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-01T00:00:00Z');
/** One point a day for `days` days up to NOW: value(i) for the i-th day back (0 = today). */
const daily = (days: number, value: (daysBack: number) => number): TrendPoint[] =>
  Array.from({ length: days }, (_, i) => days - 1 - i).map((back) => ({ ts: new Date(NOW - back * DAY).toISOString(), value: value(back) }));

describe('trend math', () => {
  it('parses windows', () => {
    expect(windowMs('24h')).toBe(DAY);
    expect(windowMs('7d')).toBe(7 * DAY);
    expect(windowMs('0d')).toBeNull();
    expect(windowMs('500d')).toBeNull();
    expect(windowMs('week')).toBeNull();
  });

  it('fits a straight line robustly: an outlier does not tilt it', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6];
    expect(
      theilSen(
        xs,
        xs.map((x) => 10 + 2 * x),
      ),
    ).toEqual({ slope: 2, intercept: 10 });
    const ys = xs.map((x) => 10 + 2 * x);
    ys[3] = 1000;
    const fit = theilSen(xs, ys);
    expect(fit.slope).toBeCloseTo(2, 5);
    expect(fit.intercept).toBeCloseTo(10, 5);
  });

  it('reports change, percent, per day and a stable confidence for a steady rise', () => {
    // 100 → 160 over the last 7 days, +10 a day
    const t = trendOf(
      daily(7, (back) => 160 - 10 * back),
      '7d',
      NOW,
    )!;
    expect(t.points).toBe(7);
    expect(t.perDay).toBeCloseTo(10, 6);
    expect(t.end).toBeCloseTo(160, 6);
    expect(t.change).toBeCloseTo(70, 6);
    expect(t.changePct).toBeCloseTo(77.78, 1);
    expect(t.confidence).toBe('stable');
    expect(trendLine(t, NOW).map((p) => Math.round(p.value))).toEqual([90, 160]);
  });

  it('stays flat for a flat line, and calls noisy points rough', () => {
    const flat = trendOf(
      daily(10, () => 42),
      '7d',
      NOW,
    )!;
    expect(flat).toMatchObject({ change: 0, changePct: 0, perDay: 0, confidence: 'stable' });
    const noisy = trendOf(
      daily(30, (back) => 100 + (back % 2 ? 40 : -40) - back * 0.1),
      '30d',
      NOW,
    )!;
    expect(noisy.confidence).toBe('rough');
  });

  it('gives no trend from too few points or a window that is barely covered', () => {
    expect(
      trendOf(
        daily(4, (b) => b),
        '7d',
        NOW,
      ),
    ).toBeNull();
    // five points within the last two hours of a 30-day window
    const late = Array.from({ length: 5 }, (_, i) => ({ ts: new Date(NOW - i * 1_800_000).toISOString(), value: i }));
    expect(trendOf(late, '30d', NOW)).toBeNull();
    expect(trendOf([], '7d', NOW)).toBeNull();
    expect(
      trendOf(
        daily(10, (b) => b),
        'nonsense',
        NOW,
      ),
    ).toBeNull();
  });

  it('ignores gaps and points outside the window', () => {
    // a rise of 5 a day, with days 3–9 missing, plus old points far below
    const pts = daily(30, (back) => 500 - 5 * back).filter((_, i, all) => !(i >= all.length - 10 && i < all.length - 3));
    const old = daily(60, () => -1000).slice(0, 20);
    const t = trendOf([...old, ...pts], '30d', NOW)!;
    expect(t.perDay).toBeCloseTo(5, 6);
    expect(t.confidence).toBe('stable');
  });

  it('follows a counter from its last reset', () => {
    // counted up through the month, reset to 0 four days ago, counting up 50 a day again
    const pts = daily(14, (back) => (back >= 5 ? 1200 - back * 10 : (4 - back) * 50));
    const t = trendOf(pts, '14d', NOW)!;
    expect(t.reset).toBe(true);
    expect(t.perDay).toBeCloseTo(50, 6);
    expect(Date.parse(t.from)).toBe(NOW - 4 * DAY);
    // a noisy series that jumps up and down is not a counter: no resets
    expect(
      trendOf(
        daily(14, (back) => (back % 2 ? 100 : 10)),
        '14d',
        NOW,
      )!.reset,
    ).toBe(false);
  });

  it('forecasts when a limit is reached, and says so when it is not approached', () => {
    // 900 asset attributes, +10 a day: the contract limit of 1130 in 23 days
    const pts = daily(30, (back) => 900 - 10 * back);
    const f = forecastTo(pts, 1130, { now: NOW })!;
    expect(f.state).toBe('approaching');
    expect(f.days).toBeCloseTo(23, 1);
    expect(f.at!.slice(0, 10)).toBe('2026-11-24');
    expect(forecastTo(pts, 500, { now: NOW })!.state).toBe('reached');
    expect(
      forecastTo(
        daily(30, () => 900),
        1130,
        { now: NOW },
      )!.state,
    ).toBe('notApproaching');
    expect(
      forecastTo(
        daily(30, (back) => 900 + 10 * back),
        1130,
        { now: NOW },
      )!.state,
    ).toBe('notApproaching');
    expect(
      forecastTo(
        daily(30, (back) => 900 - 0.001 * back),
        1130,
        { now: NOW },
      )!.state,
    ).toBe('beyond');
    // free storage going down to a lower limit
    const free = forecastTo(
      daily(30, (back) => 100 + 2 * back),
      40,
      { lower: true, now: NOW },
    )!;
    expect(free).toMatchObject({ state: 'approaching', days: 30, lower: true });
    expect(
      forecastTo(
        daily(30, (back) => 100 + 2 * back),
        120,
        { lower: true, now: NOW },
      )!.state,
    ).toBe('reached');
    expect(
      forecastTo(
        daily(3, (b) => b),
        10,
        { now: NOW },
      ),
    ).toBeNull();
  });
});
