import crypto from 'node:crypto';
import {
  OBSERVED_DELAY_DAYS,
  SUGGESTION_MIN_COVERAGE_SECONDS,
  SUGGESTION_MIN_SAMPLES,
  type CheckDef,
  type DelayFigures,
  type ObservedDelay,
  type ObservedDelayVariable,
} from '@sm/shared';

/**
 * Observed delay of freshness checks (0.13, docs/MONITORS.md#how-fresh-is-fresh-delays-in-insights-hub). Pure: the
 * engine hands in each read (or its failure) and stores the state in monitor_checks.observed_delay.
 *
 * Per variable Steward keeps the newest timestamp T it saw and when it last saw it as the newest (t, the start of
 * that read). When a later read (ending at t') sees a newer T', it records one sample of two intervals:
 * - peak age of the previous value: [t − T, t' − T] – how old the newest value became before a newer one was readable;
 * - delay of the new value: [max(0, t − T'), t' − T'] – how long after its timestamp it became readable.
 * Suggestions use the upper bounds only (they never under-estimate); the width is about one check interval.
 */

export const DELAY_WINDOW_MS = OBSERVED_DELAY_DAYS * 86400 * 1000;
/** Slots kept per variable (oldest dropped): 500 slots of 20 minutes cover about 7 days */
export const DELAY_MAX_SAMPLES = 500;
/** Samples ending in the same slot are merged: the slot keeps the widest bounds (highest upper, lowest lower) */
export const DELAY_SLOT_SECONDS = 1200;
/** A timestamp this much later than the read's end is "in the future" (clock skew) */
export const FUTURE_TOLERANCE_MS = 5000;
/** At most this many maintenance probes per sample interval */
const MAX_PROBES = 200;

/**
 * One slot of samples, all in seconds: [interval start (epoch), interval length, peakLo, peakHi, delayLo, delayHi,
 * samples]. A slot of several samples keeps the lowest lower and the highest upper bounds (conservative).
 */
export type DelaySample = [number, number, number, number, number, number, number];

const slotOf = (x: DelaySample) => Math.floor((x[0] + x[1]) / DELAY_SLOT_SECONDS);

/** Adds a sample: merged into the last slot when it ends in the same one. */
function addSample(list: DelaySample[], x: DelaySample): void {
  const last = list[list.length - 1];
  if (!last || slotOf(last) !== slotOf(x)) {
    list.push(x);
    return;
  }
  const end = Math.max(last[0] + last[1], x[0] + x[1]);
  last[0] = Math.min(last[0], x[0]);
  last[1] = end - last[0];
  last[2] = Math.min(last[2], x[2]);
  last[3] = Math.max(last[3], x[3]);
  last[4] = Math.min(last[4], x[4]);
  last[5] = Math.max(last[5], x[5]);
  last[6] += x[6];
}

export interface VariableState {
  /** Newest timestamp seen (ms) */
  T: number | null;
  /** Start (ms) of the last successful read that saw T as the newest; null: no sample until it is seen again */
  t: number | null;
  /** The last future timestamp counted (each counts once) */
  f?: number;
  s: DelaySample[];
}

export interface DelayState {
  v: 1;
  /** Identity of the source (platform, asset, aspect, variables, path, query …): a change starts a new series */
  id: string;
  /** Start of this series (ms) */
  since: number;
  vars: Record<string, VariableState>;
  /** Exclusions by kind, counted per slot: [slot number (epoch seconds / DELAY_SLOT_SECONDS), count] */
  ev: { failed: [number, number][]; backwards: [number, number][]; future: [number, number][]; maintenance: [number, number][] };
}

/** One read of the source: the newest timestamp per variable (null: none found), between start and end (ms). */
export type DelayObservation = { failed: true; at: number } | { failed?: false; start: number; end: number; newest: Record<string, number | null> };

function addEvent(list: [number, number][], atSeconds: number): void {
  const slot = Math.floor(atSeconds / DELAY_SLOT_SECONDS);
  const last = list[list.length - 1];
  if (last && last[0] === slot) last[1]++;
  else list.push([slot, 1]);
}

const fresh = (id: string, now: number): DelayState => ({ v: 1, id, since: now, vars: {}, ev: { failed: [], backwards: [], future: [], maintenance: [] } });

export function parseDelayState(text: string | null | undefined): DelayState | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text) as DelayState;
    return s && s.v === 1 && typeof s.id === 'string' && s.vars && s.ev ? s : null;
  } catch {
    return null;
  }
}

/** What identifies the source of a freshness check: a change of any of it starts a new series (thresholds do not). */
export function delayIdentity(c: CheckDef): string | null {
  if (c.type !== 'freshness') return null;
  const parts =
    c.source === 'insightsHub'
      ? ['ih', c.platform, c.assetId ?? '', c.aspect ?? '', [...(c.variables ?? [])].sort()]
      : ['api', c.platform, c.method ?? 'GET', c.path ?? '', c.query ?? {}, c.body ?? null, c.timestamp ?? ''];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 22);
}

/** Does any moment of [from, to] (ms) fall into maintenance? Probes the ends and about every minute between. */
function overlapsMaintenance(from: number, to: number, inMaintenance: (t: number) => boolean): boolean {
  const step = Math.max(60000, (to - from) / MAX_PROBES);
  for (let t = from; t < to; t += step) if (inMaintenance(t)) return true;
  return inMaintenance(to);
}

/** Applies one read; returns the new state (the old one is not changed). */
export function observeDelay(
  prev: DelayState | null,
  identity: string,
  obs: DelayObservation,
  inMaintenance: (t: number) => boolean = () => false,
): DelayState {
  return applyObservation(prev && prev.id === identity ? structuredClone(prev) : null, identity, obs, inMaintenance);
}

/** observeDelay on a state it may change (simulations of many reads). */
export function applyObservation(
  prev: DelayState | null,
  identity: string,
  obs: DelayObservation,
  inMaintenance: (t: number) => boolean = () => false,
): DelayState {
  const now = obs.failed ? obs.at : obs.end;
  const st: DelayState = prev && prev.id === identity ? prev : fresh(identity, now);
  const sec = (ms: number) => Math.floor(ms / 1000);
  if (obs.failed) addEvent(st.ev.failed, sec(obs.at));
  else {
    // each kind counts once per read, however many variables it concerns
    const hit = new Set<'backwards' | 'future' | 'maintenance'>();
    for (const [name, T] of Object.entries(obs.newest)) {
      const vs = (st.vars[name] ??= { T: null, t: null, s: [] });
      if (T === null || !Number.isFinite(T)) continue; // nothing found: keep T, and do not move t (a looser lower bound stays valid)
      if (T > obs.end + FUTURE_TOLERANCE_MS) {
        if (vs.f !== T) hit.add('future');
        vs.f = T;
        continue;
      }
      if (vs.T === null) {
        // first sight (first run, new variable, no stored state after a restart): no sample yet
        vs.T = T;
        vs.t = obs.start;
        continue;
      }
      if (T < vs.T) {
        hit.add('backwards'); // a non-monotonic read: keep the newest seen, do not move t
        continue;
      }
      if (T === vs.T) {
        vs.t = obs.start;
        continue;
      }
      if (vs.t !== null) {
        if (overlapsMaintenance(vs.t, obs.end, inMaintenance)) hit.add('maintenance');
        else {
          const lo = (ms: number) => Math.max(0, Math.floor(ms / 1000));
          const hi = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
          addSample(vs.s, [sec(vs.t), Math.ceil((obs.end - vs.t) / 1000), lo(vs.t - vs.T), hi(obs.end - vs.T), lo(vs.t - T), hi(obs.end - T), 1]);
        }
      }
      vs.T = T;
      vs.t = obs.start;
    }
    for (const k of hit) addEvent(st.ev[k], sec(obs.end));
  }
  return pruneDelay(st, now);
}

/** Drops samples and events older than the window and beyond the caps. */
export function pruneDelay(st: DelayState, now: number): DelayState {
  const cut = Math.floor((now - DELAY_WINDOW_MS) / 1000);
  for (const vs of Object.values(st.vars)) {
    vs.s = vs.s.filter((x) => x[0] + x[1] >= cut);
    if (vs.s.length > DELAY_MAX_SAMPLES) vs.s = vs.s.slice(-DELAY_MAX_SAMPLES);
  }
  for (const k of Object.keys(st.ev) as (keyof DelayState['ev'])[]) {
    st.ev[k] = st.ev[k].filter((x) => (x[0] + 1) * DELAY_SLOT_SECONDS >= cut);
  }
  return st;
}

/** Nearest-rank percentile of sorted values (p in 0–100): always a value that was observed. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

const figures = (values: number[]): DelayFigures | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { median: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1]! };
};

const total = (list: [number, number][]) => list.reduce((n, x) => n + x[1], 0);

/** The figures of a stored state (null: none yet); the suggestion is added by the caller (it needs the settings). */
export function summarizeDelay(st: DelayState | null, intervalSeconds: number, now: number): Omit<ObservedDelay, 'suggestion'> | null {
  if (!st) return null;
  const s = pruneDelay(structuredClone(st), now);
  const variables: ObservedDelayVariable[] = Object.entries(s.vars).map(([name, vs]) => {
    const first = vs.s[0];
    const last = vs.s[vs.s.length - 1];
    const delayLo = figures(vs.s.map((x) => x[4]));
    const delayHi = figures(vs.s.map((x) => x[5]));
    return {
      name,
      samples: vs.s.reduce((n, x) => n + x[6], 0),
      coverageSeconds: first && last ? last[0] + last[1] - first[0] : 0,
      peakAge: figures(vs.s.map((x) => x[3])),
      delay: delayLo && delayHi ? { low: delayLo.median, high: delayHi.median } : null,
    };
  });
  const worst = variables.filter((v) => v.peakAge).reduce<ObservedDelayVariable | null>((a, b) => (!a || b.peakAge!.p95 > a.peakAge!.p95 ? b : a), null);
  return {
    windowDays: OBSERVED_DELAY_DAYS,
    since: new Date(s.since).toISOString(),
    intervalSeconds,
    worst,
    variables,
    excluded: {
      failedReads: total(s.ev.failed),
      wentBackwards: total(s.ev.backwards),
      futureTimestamps: total(s.ev.future),
      maintenance: total(s.ev.maintenance),
    },
    enough: !!worst && worst.samples >= SUGGESTION_MIN_SAMPLES && worst.coverageSeconds >= SUGGESTION_MIN_COVERAGE_SECONDS,
  };
}
