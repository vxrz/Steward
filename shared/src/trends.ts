/**
 * Trends and forecasts of metrics (#145): documented math without dependencies, the same on the server (checks,
 * summaries, API) and in the browser (KPI widgets, trend lines).
 *
 * - The trend is a robust straight line through the points (Theil–Sen: the median of the slopes between all pairs
 *   of points, the intercept the median of the residuals) – a single outlier or a gap does not tilt it, unlike a line
 *   from the first to the last point.
 * - A counter that was reset (a drop of more than half of the range, e.g. a monthly quota that starts again) is
 *   followed from its last reset on.
 * - Too few points (fewer than TREND_LIMITS.minPoints, or less than a fifth of the window covered) give no trend.
 * - The confidence is "stable" when the points stay close to the line (the median distance is under a quarter of
 *   the change over the window, or the line is flat and so are the points), else "rough".
 */

export const TREND_WINDOWS = ['24h', '7d', '30d'] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];

export const TREND_LIMITS = {
  /** Points needed for a trend */
  minPoints: 5,
  /** Part of the window the points must cover */
  minCoverage: 0.2,
  /** Pairs at most for the median of slopes (larger series are thinned evenly first) */
  maxPoints: 400,
  /** Forecasts further out than this are "not within two years" */
  maxForecastDays: 730,
} as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** '24h' → 86400000, '7d' → 604800000; also 'Nh' and 'Nd' (1–400 days). */
export function windowMs(w: string): number | null {
  const m = /^(\d{1,4})([hd])$/.exec(w.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const ms = n * (m[2] === 'h' ? HOUR : DAY);
  return n > 0 && ms <= 400 * DAY ? ms : null;
}

export interface TrendPoint {
  ts: string;
  value: number;
}

export type TrendConfidence = 'stable' | 'rough';

export interface Trend {
  /** The window the trend covers, e.g. "7d" */
  window: string;
  /** Points used (after a reset, only those since) */
  points: number;
  /** First and last point used */
  from: string;
  to: string;
  /** The line's value at the start and at the end of the window */
  start: number;
  end: number;
  /** Change over the window (end − start) */
  change: number;
  /** Change in percent of the start (null when the start is 0) */
  changePct: number | null;
  /** Change per day */
  perDay: number;
  confidence: TrendConfidence;
  /** The counter was reset in the window; the trend follows it from then on */
  reset: boolean;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Evenly thinned to at most n points (first and last kept). */
function thin<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (n - 1))]!);
  return out;
}

/** Theil–Sen line through (x, y): slope per x unit and the value at x = 0. */
export function theilSen(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++) {
      const dx = xs[j]! - xs[i]!;
      if (dx !== 0) slopes.push((ys[j]! - ys[i]!) / dx);
    }
  const slope = slopes.length ? median(slopes) : 0;
  const intercept = median(ys.map((y, i) => y - slope * xs[i]!));
  return { slope, intercept };
}

/**
 * Index of the first point after the last reset, 0 without one. A reset is a drop of more than half of the range in
 * a counter-like series (at least four in five steps go up or stay) – a noisy series has no resets.
 */
function lastReset(values: number[]): number {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;
  if (!(range > 0) || values.length < 3) return 0;
  let rising = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! >= values[i - 1]!) rising++;
  if (rising / (values.length - 1) < 0.8) return 0;
  let at = 0;
  for (let i = 1; i < values.length; i++) if (values[i - 1]! - values[i]! > range / 2) at = i;
  return at;
}

/** The trend of a series over the window ending at `now` (null: too few points). */
export function trendOf(series: TrendPoint[], window: string, now: number = Date.now()): Trend | null {
  const w = windowMs(window);
  if (!w) return null;
  const since = now - w;
  let pts = series
    .map((p) => ({ t: Date.parse(p.ts), v: p.value }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.t >= since && p.t <= now)
    .sort((a, b) => a.t - b.t);
  const reset = lastReset(pts.map((p) => p.v));
  if (reset > 0) pts = pts.slice(reset);
  if (pts.length < TREND_LIMITS.minPoints) return null;
  const first = pts[0]!.t;
  const last = pts[pts.length - 1]!.t;
  if (last - first < w * TREND_LIMITS.minCoverage) return null;
  const used = thin(pts, TREND_LIMITS.maxPoints);
  // x in days since the first point keeps the numbers small
  const xs = used.map((p) => (p.t - first) / DAY);
  const ys = used.map((p) => p.v);
  const { slope, intercept } = theilSen(xs, ys);
  // the line over the window (from its start, or from the reset, to now)
  const x0 = Math.max(since, reset > 0 ? first : since);
  const at = (t: number) => intercept + slope * ((t - first) / DAY);
  const start = at(x0);
  const end = at(now);
  const change = end - start;
  const residual = median(ys.map((y, i) => Math.abs(y - (intercept + slope * xs[i]!))));
  const flat = Math.abs(change) < 1e-9;
  const confidence: TrendConfidence = flat ? (residual < 1e-9 ? 'stable' : 'rough') : residual < Math.abs(change) / 4 ? 'stable' : 'rough';
  return {
    window,
    points: pts.length,
    from: new Date(first).toISOString(),
    to: new Date(last).toISOString(),
    start,
    end,
    change,
    changePct: Math.abs(start) > 1e-9 ? (change / Math.abs(start)) * 100 : null,
    perDay: slope,
    confidence,
    reset: reset > 0,
  };
}

export type ForecastState = 'reached' | 'approaching' | 'notApproaching' | 'beyond';

export interface Forecast {
  limit: number;
  /** An upper limit (a quota, a contract) is reached from below; a lower one (free space) from above */
  lower: boolean;
  state: ForecastState;
  /** Days until the line reaches the limit ('approaching'); 0 when reached */
  days: number | null;
  /** When ('approaching') */
  at: string | null;
  trend: Trend;
}

/**
 * When does the trend reach the limit? 'reached': the latest value is at or past it; 'notApproaching': flat or moving
 * away from it; 'beyond': later than two years. `lower`: a lower limit (reached by falling, e.g. free storage).
 */
export function forecastTo(series: TrendPoint[], limit: number, opts: { window?: string; lower?: boolean; now?: number } = {}): Forecast | null {
  const now = opts.now ?? Date.now();
  const lower = !!opts.lower;
  const trend = trendOf(series, opts.window ?? '30d', now);
  if (!trend || !Number.isFinite(limit)) return null;
  const latest = [...series].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)!.value;
  const base = { limit, lower, trend };
  if (lower ? latest <= limit : latest >= limit) return { ...base, state: 'reached', days: 0, at: new Date(now).toISOString() };
  const towards = lower ? trend.perDay < 0 : trend.perDay > 0;
  if (!towards) return { ...base, state: 'notApproaching', days: null, at: null };
  const days = Math.max(0, (limit - trend.end) / trend.perDay);
  if (days > TREND_LIMITS.maxForecastDays) return { ...base, state: 'beyond', days: null, at: null };
  return { ...base, state: 'approaching', days: Math.round(days * 10) / 10, at: new Date(now + days * DAY).toISOString() };
}

/** The fitted line between two instants (for a trend line in a chart). */
export function trendLine(t: Trend, now: number = Date.now()): { ts: string; value: number }[] {
  const w = windowMs(t.window) ?? 0;
  const startT = t.reset ? Date.parse(t.from) : now - w;
  return [
    { ts: new Date(startT).toISOString(), value: t.start },
    { ts: new Date(now).toISOString(), value: t.end },
  ];
}
