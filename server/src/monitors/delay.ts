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
/** Samples of the last 24 hours ending in the same 20-minute slot are merged … */
export const DELAY_SLOT_SECONDS = 1200;
/** … older ones in 2-hour slots: 72 + 72 slots cover 7 days (a slot keeps the lowest lower and highest upper bounds) */
export const DELAY_OLD_SLOT_SECONDS = 7200;
const RECENT_SECONDS = 86400;
/** A timestamp this much later than the read's end is "in the future" (clock skew) */
export const FUTURE_TOLERANCE_MS = 5000;
/** At most this many maintenance probes per sample interval */
const MAX_PROBES = 200;

/**
 * One slot of samples, in seconds: [slot index (end of the samples / slot length), peakLo, peakHi, delayLo, delayHi,
 * samples]. Several samples in a slot keep the lowest lower and the highest upper bounds (conservative).
 */
export type DelaySlot = [number, number, number, number, number, number];

function mergeInto(list: DelaySlot[], x: DelaySlot): void {
  const last = list[list.length - 1];
  if (!last || last[0] !== x[0]) {
    list.push([...x]);
    return;
  }
  last[1] = Math.min(last[1], x[1]);
  last[2] = Math.max(last[2], x[2]);
  last[3] = Math.min(last[3], x[3]);
  last[4] = Math.max(last[4], x[4]);
  last[5] += x[5];
}

export interface VariableState {
  /** Newest timestamp seen (ms) */
  T: number | null;
  /** Start (ms) of the last successful read that saw T as the newest; null: no sample until it is seen again */
  t: number | null;
  /** The last future timestamp counted (each counts once) */
  f?: number;
  /** End (s) of the newest sample */
  e: number;
  /** 20-minute slots of the last 24 hours */
  s: DelaySlot[];
  /** 2-hour slots before */
  h: DelaySlot[];
}

type Events = [number, number][];

export interface DelayState {
  v: 2;
  /** Identity of the source (platform, asset, aspect, variables, path, query …): a change starts a new series */
  id: string;
  /** Start of this series (ms) */
  since: number;
  vars: Record<string, VariableState>;
  /** Exclusions by kind, counted per 2-hour slot: [slot index, count] */
  ev: { failed: Events; backwards: Events; future: Events; maintenance: Events };
}

/** One read of the source: the newest timestamp per variable (null: none found), between start and end (ms). */
export type DelayObservation = { failed: true; at: number } | { failed?: false; start: number; end: number; newest: Record<string, number | null> };

function addEvent(list: Events, atSeconds: number): void {
  const slot = Math.floor(atSeconds / DELAY_OLD_SLOT_SECONDS);
  const last = list[list.length - 1];
  if (last && last[0] === slot) last[1]++;
  else list.push([slot, 1]);
}

const EVENT_KINDS = ['failed', 'backwards', 'future', 'maintenance'] as const;
const fresh = (id: string, now: number): DelayState => ({ v: 2, id, since: now, vars: {}, ev: { failed: [], backwards: [], future: [], maintenance: [] } });
const newVariable = (): VariableState => ({ T: null, t: null, e: 0, s: [], h: [] });

// ---------- storage: compact numbers, no repeated keys ----------

/** Slots as one list of numbers: the first index absolute, then the difference to the previous one. */
function packSlots(list: DelaySlot[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const x of list) {
    out.push(x[0] - prev, x[1], x[2], x[3], x[4], x[5]);
    prev = x[0];
  }
  return out;
}
function unpackSlots(flat: unknown): DelaySlot[] {
  const out: DelaySlot[] = [];
  if (!Array.isArray(flat)) return out;
  let prev = 0;
  for (let i = 0; i + 5 < flat.length; i += 6) {
    const x = flat.slice(i, i + 6).map(Number) as DelaySlot;
    x[0] += prev;
    prev = x[0];
    out.push(x);
  }
  return out;
}
const packEvents = (list: Events) => list.flatMap((x, i) => [x[0] - (i ? list[i - 1]![0] : 0), x[1]]);
function unpackEvents(flat: unknown): Events {
  const out: Events = [];
  if (!Array.isArray(flat)) return out;
  let prev = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([(prev += Number(flat[i])), Number(flat[i + 1])]);
  return out;
}

/** The stored form (monitor_checks.observed_delay): about 3 KB per variable for a week of new values every minute. */
export function encodeDelayState(st: DelayState): string {
  return JSON.stringify({
    v: 2,
    id: st.id,
    since: Math.floor(st.since / 1000),
    vars: Object.fromEntries(Object.entries(st.vars).map(([k, x]) => [k, [x.T, x.t, x.f ?? 0, x.e, packSlots(x.s), packSlots(x.h)]])),
    ev: EVENT_KINDS.map((k) => packEvents(st.ev[k])),
  });
}

export function parseDelayState(text: string | null | undefined): DelayState | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as { v?: number; id?: unknown; since?: number; vars?: Record<string, unknown[]>; ev?: unknown[] };
    if (raw?.v !== 2 || typeof raw.id !== 'string' || !raw.vars || !Array.isArray(raw.ev)) return null;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return {
      v: 2,
      id: raw.id,
      since: Number(raw.since) * 1000,
      vars: Object.fromEntries(
        Object.entries(raw.vars).map(([k, x]) => [
          k,
          { T: num(x[0]), t: num(x[1]), ...(num(x[2]) ? { f: num(x[2])! } : {}), e: num(x[3]) ?? 0, s: unpackSlots(x[4]), h: unpackSlots(x[5]) },
        ]),
      ),
      ev: Object.fromEntries(EVENT_KINDS.map((k, i) => [k, unpackEvents(raw.ev![i])])) as DelayState['ev'],
    };
  } catch {
    return null;
  }
}

/** The newest timestamp seen per variable (ms) while the source is the same – the status uses it, so a lagging read cannot make data look older. */
export function newestSeen(st: DelayState | null, identity: string | null, name: string): number | null {
  return st && identity && st.id === identity ? (st.vars[name]?.T ?? null) : null;
}

/** What identifies the source of a freshness check: a change of any of it starts a new series (thresholds do not). */
export function delayIdentity(c: CheckDef): string | null {
  if (c.type !== 'freshness') return null;
  const parts =
    c.source === 'insightsHub'
      ? ['ih', c.platform, c.assetId ?? '', c.aspect ?? '', [...(c.variables ?? [])].sort()]
      : c.source === 'influxdb'
        ? [
            'influx',
            c.platform,
            c.database ?? '',
            c.bucket ?? '',
            c.retentionPolicy ?? '',
            c.measurement ?? '',
            [...(c.fields ?? [])].sort(),
            Object.entries(c.tags ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            c.groupBy ?? '',
          ]
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
  return stepDelay(prev && prev.id === identity ? structuredClone(prev) : null, identity, obs, inMaintenance).state;
}

/** observeDelay on a state it may change (simulations of many reads). */
export function applyObservation(
  prev: DelayState | null,
  identity: string,
  obs: DelayObservation,
  inMaintenance: (t: number) => boolean = () => false,
): DelayState {
  return stepDelay(prev, identity, obs, inMaintenance).state;
}

/**
 * Applies one read to a state it may change. `changed`: anything worth storing changed – a sample, a count, a newest
 * timestamp, a slot that moved or went. A read that only saw the same newest value again changes the time it was
 * last seen (t) and nothing else: that stays in memory (after a restart an older t only makes a lower bound lower).
 */
export function stepDelay(
  prev: DelayState | null,
  identity: string,
  obs: DelayObservation,
  inMaintenance: (t: number) => boolean = () => false,
): { state: DelayState; changed: boolean } {
  const now = obs.failed ? obs.at : obs.end;
  let changed = !prev || prev.id !== identity;
  const st: DelayState = prev && prev.id === identity ? prev : fresh(identity, now);
  const sec = (ms: number) => Math.floor(ms / 1000);
  if (obs.failed) {
    addEvent(st.ev.failed, sec(obs.at));
    changed = true;
  } else {
    // each kind counts once per read, however many variables it concerns
    const hit = new Set<'backwards' | 'future' | 'maintenance'>();
    for (const [name, T] of Object.entries(obs.newest)) {
      let vs = st.vars[name];
      if (!vs) {
        vs = st.vars[name] = newVariable();
        changed = true;
      }
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
        changed = true;
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
          const end = Math.ceil(obs.end / 1000);
          mergeInto(vs.s, [Math.floor(end / DELAY_SLOT_SECONDS), lo(vs.t - vs.T), hi(obs.end - vs.T), lo(vs.t - T), hi(obs.end - T), 1]);
          vs.e = Math.max(vs.e, end);
        }
      }
      vs.T = T;
      vs.t = obs.start;
      changed = true;
    }
    for (const k of hit) addEvent(st.ev[k], sec(obs.end));
    if (hit.size) changed = true;
  }
  if (compactDelay(st, now)) changed = true;
  return { state: st, changed };
}

/** Moves 20-minute slots older than 24 hours into 2-hour slots, drops what is older than the window; true: something moved. */
export function compactDelay(st: DelayState, now: number): boolean {
  const nowS = Math.floor(now / 1000);
  const cut = nowS - DELAY_WINDOW_MS / 1000;
  const ratio = DELAY_OLD_SLOT_SECONDS / DELAY_SLOT_SECONDS;
  let moved = false;
  for (const vs of Object.values(st.vars)) {
    while (vs.s.length && (vs.s[0]![0] + 1) * DELAY_SLOT_SECONDS <= nowS - RECENT_SECONDS) {
      const x = vs.s.shift()!;
      mergeInto(vs.h, [Math.floor(x[0] / ratio), x[1], x[2], x[3], x[4], x[5]]);
      moved = true;
    }
    while (vs.h.length && (vs.h[0]![0] + 1) * DELAY_OLD_SLOT_SECONDS < cut) {
      vs.h.shift();
      moved = true;
    }
    while (vs.s.length && (vs.s[0]![0] + 1) * DELAY_SLOT_SECONDS < cut) {
      vs.s.shift();
      moved = true;
    }
  }
  for (const k of EVENT_KINDS) {
    const list = st.ev[k];
    while (list.length && (list[0]![0] + 1) * DELAY_OLD_SLOT_SECONDS < cut) {
      list.shift();
      moved = true;
    }
  }
  return moved;
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
  const s = structuredClone(st);
  compactDelay(s, now);
  const variables: ObservedDelayVariable[] = Object.entries(s.vars).map(([name, vs]) => {
    const slots = [...vs.h, ...vs.s];
    // coverage from the end of the oldest slot (never more than the samples cover) to the end of the newest sample
    const firstEnd = vs.h.length ? (vs.h[0]![0] + 1) * DELAY_OLD_SLOT_SECONDS : vs.s.length ? (vs.s[0]![0] + 1) * DELAY_SLOT_SECONDS : null;
    const delayLo = figures(slots.map((x) => x[3]));
    const delayHi = figures(slots.map((x) => x[4]));
    return {
      name,
      samples: slots.reduce((n, x) => n + x[5], 0),
      coverageSeconds: firstEnd === null ? 0 : Math.max(0, vs.e - firstEnd),
      peakAge: figures(slots.map((x) => x[2])),
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
