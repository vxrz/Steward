/**
 * Observed delay of freshness checks (0.13): what Steward measured about how old the newest value gets before a newer
 * one becomes readable, and the setting it suggests from that. The server measures (server/src/monitors/delay.ts);
 * the editor recomputes the suggestion from the figures and the values in the form.
 */

/** Days of samples the figures cover */
export const OBSERVED_DELAY_DAYS = 7;
/** A suggestion needs this much coverage … */
export const SUGGESTION_MIN_COVERAGE_SECONDS = 24 * 3600;
/** … and this many samples (of the worst variable) */
export const SUGGESTION_MIN_SAMPLES = 20;

/** Median, 95th percentile (nearest rank) and maximum, in seconds. */
export interface DelayFigures {
  median: number;
  p95: number;
  max: number;
}

export interface ObservedDelayVariable {
  /** The variable ('' for a source with one timestamp) */
  name: string;
  samples: number;
  /** Seconds from the first sample's start to the last sample's end */
  coverageSeconds: number;
  /** Upper bounds of how old the newest value became before a newer one was readable */
  peakAge: DelayFigures | null;
  /** Delay of new values: the median of the lower and of the upper bounds */
  delay: { low: number; high: number } | null;
}

export interface ObservedDelay {
  windowDays: number;
  /** When this series started (first run, or the check's source changed) */
  since: string;
  /** The check interval the samples were taken at (the resolution of every figure) */
  intervalSeconds: number;
  /** The variable with the highest 95th percentile peak age – the summary and the suggestion use it */
  worst: ObservedDelayVariable | null;
  variables: ObservedDelayVariable[];
  /** Observations that were not used */
  excluded: { failedReads: number; wentBackwards: number; futureTimestamps: number; maintenance: number };
  /** Enough data for a suggestion (coverage and samples of the worst variable) */
  enough: boolean;
  /** The suggestion for the check as saved (the editor recomputes it for the values in the form) */
  suggestion: FreshnessSuggestion | null;
}

export type SuggestionField = 'allowedDelaySeconds' | 'maxAgeSeconds' | 'degradedAgeSeconds';

export interface FreshnessSuggestion {
  /** The fields to change: from the current value to the suggested one (null: not set) */
  changes: { field: SuggestionField; from: number | null; to: number | null }[];
  /** The 95th percentile peak age it is based on, and the margin added (one check interval) */
  basedOnSeconds: number;
  marginSeconds: number;
}

/** The freshness settings a suggestion reads (a freshness or heartbeat check, or a DynamoDB check's freshness). */
export interface FreshnessSettings {
  mode: 'cadence' | 'maxAge';
  expectedIntervalSeconds?: number;
  maxAgeSeconds?: number;
  degradedAgeSeconds?: number;
  allowedDelaySeconds?: number;
}

const ceilMinute = (s: number) => Math.ceil(Math.max(0, s) / 60) * 60;

/**
 * The setting that would not have alarmed on the observed peak ages: from the 95th percentile of the upper bounds of
 * the worst variable, rounded up to the next minute, plus one check interval as margin (outages show in the maximum
 * but do not drive it). cadence: allowedDelaySeconds = p95 − expected interval; maxAge: maxAgeSeconds = p95 − the
 * allowed delay, and a warning threshold that would fire at the observed peak (or not before the new maximum) is removed. null: not enough data.
 */
export function suggestFreshness(
  observed: Pick<ObservedDelay, 'worst' | 'enough' | 'intervalSeconds'> | null | undefined,
  c: FreshnessSettings,
): FreshnessSuggestion | null {
  const p95 = observed?.worst?.peakAge?.p95;
  if (!observed?.enough || p95 === undefined) return null;
  const margin = Math.max(1, observed.intervalSeconds);
  const allowance = c.allowedDelaySeconds ?? 0;
  const changes: FreshnessSuggestion['changes'] = [];
  if (c.mode === 'cadence') {
    if (!c.expectedIntervalSeconds) return null;
    const to = Math.min(86400, ceilMinute(p95 - c.expectedIntervalSeconds) + margin);
    if (to !== allowance) changes.push({ field: 'allowedDelaySeconds', from: c.allowedDelaySeconds ?? null, to });
  } else {
    const to = Math.min(365 * 86400, Math.max(60, ceilMinute(p95 - allowance) + margin));
    if (to !== c.maxAgeSeconds) changes.push({ field: 'maxAgeSeconds', from: c.maxAgeSeconds ?? null, to });
    // a warning threshold below the observed peak would warn before nearly every new value; one at or above the new
    // maximum would never warn first
    if (c.degradedAgeSeconds !== undefined && (c.degradedAgeSeconds + allowance < p95 + margin || c.degradedAgeSeconds >= to))
      changes.push({ field: 'degradedAgeSeconds', from: c.degradedAgeSeconds, to: null });
  }
  return { changes, basedOnSeconds: p95, marginSeconds: margin };
}
