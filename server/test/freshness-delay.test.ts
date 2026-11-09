import { describe, expect, it } from 'vitest';
import { checkSchema, definitionIssues, monitorDefinitionSchema, suggestFreshness, type CheckDef, type FreshnessSettings } from '@sm/shared';
import { freshnessLookbackSeconds, freshnessStatus, freshnessWindowSeconds, type FreshnessConfig } from '../src/monitors/logic.js';
import {
  DELAY_MAX_SAMPLES,
  DELAY_SLOT_SECONDS,
  FUTURE_TOLERANCE_MS,
  delayIdentity,
  observeDelay,
  parseDelayState,
  percentile,
  summarizeDelay,
  type DelayState,
} from '../src/monitors/delay.js';
import { readNewest, readablePoints, type IotPipeline } from '../src/mock/iotPipeline.js';
import { simulateReads } from '../src/mock/delaySimulation.js';

/**
 * Freshness with an allowed delay and the observed delay (0.13, docs/MONITORS.md#how-fresh-is-fresh-delays-in-insights-hub):
 * the threshold math, the samples and their exclusions, the suggestion – and, on simulated weeks of data paths, that
 * the suggested setting raises no alarm on healthy data while an outage is still detected.
 */

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const DAY = 24 * H;
const T0 = Date.parse('2026-11-02T00:00:00Z');

describe('allowed delay: threshold math', () => {
  const now = T0;
  const ago = (s: number) => now - s * S;

  it('allowance 0 (or absent) is the behaviour of before, messages unchanged', () => {
    const cad: FreshnessConfig = { mode: 'cadence', expectedIntervalSeconds: 60, degradedAfterMissed: 2, downAfterMissed: 4 };
    for (const c of [cad, { ...cad, allowedDelaySeconds: 0 }]) {
      expect(freshnessStatus(ago(119), now, c).status).toBe('up');
      expect(freshnessStatus(ago(120), now, c).status).toBe('degraded');
      expect(freshnessStatus(ago(240), now, c).status).toBe('down');
      expect(freshnessStatus(ago(240), now, c).message).toBe('Newest data is 4 min old, expected every 60 s (4 intervals missed)');
      expect(freshnessWindowSeconds(c)).toBe(240);
      expect(freshnessLookbackSeconds(c)).toBe(360);
    }
    const age: FreshnessConfig = { mode: 'maxAge', maxAgeSeconds: 600, degradedAgeSeconds: 300 };
    expect(freshnessStatus(ago(600), now, age).status).toBe('degraded');
    expect(freshnessStatus(ago(601), now, age).status).toBe('down');
    expect(freshnessStatus(ago(720), now, age).message).toBe('Newest data is 12 min old (maximum 10 min)');
  });

  it('maxAge: down after maxAge + allowance, degraded after degradedAge + allowance (boundaries)', () => {
    const c: FreshnessConfig = { mode: 'maxAge', maxAgeSeconds: 300, degradedAgeSeconds: 120, allowedDelaySeconds: 900 };
    expect(freshnessStatus(ago(1020), now, c).status).toBe('up');
    expect(freshnessStatus(ago(1021), now, c).status).toBe('degraded');
    expect(freshnessStatus(ago(1200), now, c).status).toBe('degraded');
    expect(freshnessStatus(ago(1201), now, c).status).toBe('down');
    expect(freshnessStatus(ago(1320), now, c, 'value of activePower').message).toBe(
      'Newest value of activePower is 22 min old, 15 min of it allowed delay (maximum 5 min)',
    );
    expect(freshnessStatus(ago(60), now, c).message).toBe('Newest data is 60 s old (within the allowed delay of 15 min)');
  });

  it('cadence: missed intervals count from the age minus the allowance', () => {
    const c: FreshnessConfig = { mode: 'cadence', expectedIntervalSeconds: 60, degradedAfterMissed: 2, downAfterMissed: 4, allowedDelaySeconds: 300 };
    expect(freshnessStatus(ago(300), now, c).status).toBe('up');
    expect(freshnessStatus(ago(419), now, c).status).toBe('up');
    expect(freshnessStatus(ago(420), now, c).status).toBe('degraded');
    expect(freshnessStatus(ago(539), now, c).status).toBe('degraded');
    expect(freshnessStatus(ago(540), now, c).status).toBe('down');
    expect(freshnessStatus(ago(540), now, c).message).toBe('Newest data is 9 min old, 5 min of it allowed delay, expected every 60 s (4 intervals missed)');
    // the window and the look-back grow by the allowance
    expect(freshnessWindowSeconds(c)).toBe(540);
    expect(freshnessLookbackSeconds(c)).toBe(660);
    expect(freshnessStatus(null, now, c).message).toBe('No data within the last 9 min');
  });

  it('the schema takes 0–86400 for every freshness-based check; absent stays absent', () => {
    const fresh = { id: 'f', name: 'f', type: 'freshness', platform: 'p', assetId: 'a', aspect: 'x', variables: ['v'], mode: 'maxAge', maxAgeSeconds: 60 };
    expect(checkSchema.safeParse({ ...fresh, allowedDelaySeconds: 0 }).success).toBe(true);
    expect(checkSchema.safeParse({ ...fresh, allowedDelaySeconds: 86400 }).success).toBe(true);
    expect(checkSchema.safeParse({ ...fresh, allowedDelaySeconds: 86401 }).success).toBe(false);
    expect(checkSchema.safeParse({ ...fresh, allowedDelaySeconds: -1 }).success).toBe(false);
    expect(checkSchema.safeParse({ ...fresh, allowedDelaySeconds: 1.5 }).success).toBe(false);
    expect((checkSchema.parse(fresh) as Record<string, unknown>).allowedDelaySeconds).toBeUndefined();
    const hb = checkSchema.parse({ id: 'h', name: 'h', type: 'heartbeat', mode: 'cadence', expectedIntervalSeconds: 60, allowedDelaySeconds: 120 });
    expect((hb as { allowedDelaySeconds?: number }).allowedDelaySeconds).toBe(120);
    const ddb = checkSchema.parse({
      id: 'd',
      name: 'd',
      type: 'dynamodb',
      platform: 'aws',
      table: 'orders',
      mode: 'newestItem',
      partitionKey: 'pk',
      partitionValues: ['a'],
      timeAttribute: 'ts',
      freshnessMode: 'maxAge',
      maxAgeSeconds: 600,
      allowedDelaySeconds: 300,
    });
    expect((ddb as { allowedDelaySeconds?: number }).allowedDelaySeconds).toBe(300);
    expect(definitionIssues(monitorDefinitionSchema.parse({ name: 'x', checks: [{ ...fresh, allowedDelaySeconds: 600 }] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const read = (start: number, newest: Record<string, number | null>, ms = 200) => ({ start, end: start + ms, newest });

describe('observed delay: samples', () => {
  it('records peak age and delay bounds only when the newest timestamp advances', () => {
    let st = observeDelay(null, 'id', read(T0, { v: T0 - 50 * S }));
    expect(st.vars.v!.s).toEqual([]); // first sight: nothing to compare with
    st = observeDelay(st, 'id', read(T0 + MIN, { v: T0 - 50 * S })); // the same value: t moves on
    expect(st.vars.v!.t).toBe(T0 + MIN);
    expect(st.vars.v!.s).toEqual([]);
    st = observeDelay(st, 'id', read(T0 + 2 * MIN, { v: T0 + 30 * S }));
    // peak age of the previous value: [t − T, t' − T] = [60+50, 120.2+50]; delay of the new one: [60−30, 120.2−30]
    expect(st.vars.v!.s).toEqual([[(T0 + MIN) / S, 61, 110, 171, 30, 91, 1]]);
    expect(st.vars.v!.T).toBe(T0 + 30 * S);
    expect(st.vars.v!.t).toBe(T0 + 2 * MIN);
    // a value newer than the last read: the delay's lower bound is 0, never negative (a later slot: its own entry)
    st = observeDelay(st, 'id', read(T0 + 30 * MIN, { v: T0 + 29 * MIN }));
    expect(st.vars.v!.s).toHaveLength(2);
    expect(st.vars.v!.s.at(-1)!.slice(4, 6)).toEqual([0, 61]);
    // samples ending in the same 20-minute slot are merged: the widest bounds, counted twice
    st = observeDelay(st, 'id', read(T0 + 31 * MIN, { v: T0 + 30 * MIN + 40 * S }));
    expect(st.vars.v!.s).toHaveLength(2);
    expect(st.vars.v!.s.at(-1)).toEqual([(T0 + 2 * MIN) / S, 1741, 60, 1771, 0, 61, 2]);
  });

  it('failed reads, null values, backwards and future timestamps, maintenance: counted, never used', () => {
    const Q = 25 * MIN; // reads further apart than a slot, so each sample has its own
    let st = observeDelay(null, 'id', read(T0, { v: T0 - 10 * S }));
    // a failed read: no observation, the next sample starts from the last successful read
    st = observeDelay(st, 'id', { failed: true, at: T0 + Q });
    // nothing found (outside the look-back): T and t stay
    st = observeDelay(st, 'id', read(T0 + 2 * Q, { v: null }));
    st = observeDelay(st, 'id', read(T0 + 3 * Q, { v: T0 + 2 * Q }));
    expect(st.vars.v!.s).toHaveLength(1);
    expect(st.vars.v!.s[0]!.slice(0, 4)).toEqual([T0 / S, 4501, 10, 4511]);
    // backwards: the newest seen is kept, t does not move
    st = observeDelay(st, 'id', read(T0 + 4 * Q, { v: T0 + Q }));
    expect(st.vars.v!.T).toBe(T0 + 2 * Q);
    expect(st.vars.v!.t).toBe(T0 + 3 * Q);
    // in the future beyond the tolerance (counted once per timestamp, even when seen again), within it: fine
    st = observeDelay(st, 'id', read(T0 + 5 * Q, { v: T0 + 10 * Q }));
    st = observeDelay(st, 'id', read(T0 + 6 * Q, { v: T0 + 10 * Q }));
    expect(st.vars.v!.T).toBe(T0 + 2 * Q);
    st = observeDelay(st, 'id', read(T0 + 7 * Q, { v: T0 + 7 * Q + 200 + FUTURE_TOLERANCE_MS - 1 }));
    expect(st.vars.v!.s).toHaveLength(2);
    expect(st.vars.v!.s[1]![4]).toBe(0);
    // a sample whose interval overlaps maintenance
    const maint = (t: number) => t >= T0 + 8 * Q && t < T0 + 8 * Q + 2 * MIN;
    st = observeDelay(st, 'id', read(T0 + 9 * Q, { v: T0 + 8 * Q }), maint);
    expect(st.vars.v!.s).toHaveLength(2);
    expect(st.vars.v!.T).toBe(T0 + 8 * Q); // the series goes on from the new value
    const sum = summarizeDelay(st, 60, T0 + 10 * Q)!;
    expect(sum.excluded).toEqual({ failedReads: 1, wentBackwards: 1, futureTimestamps: 1, maintenance: 1 });
    expect(sum.worst!.samples).toBe(2);
  });

  it('each kind counts once per read, whatever the number of variables', () => {
    let st = observeDelay(null, 'id', read(T0, { a: T0, b: T0 }));
    st = observeDelay(st, 'id', read(T0 + MIN, { a: T0 - MIN, b: T0 - MIN }));
    expect(summarizeDelay(st, 60, T0 + MIN)!.excluded.wentBackwards).toBe(1);
  });

  it('restart: stored state continues the series; without one the first read records nothing', () => {
    let st = observeDelay(null, 'id', read(T0, { v: T0 - 10 * S }));
    const stored = JSON.stringify(st);
    st = observeDelay(parseDelayState(stored), 'id', read(T0 + MIN, { v: T0 + 30 * S }));
    expect(st.vars.v!.s).toHaveLength(1);
    expect(observeDelay(parseDelayState(null), 'id', read(T0 + MIN, { v: T0 + 30 * S })).vars.v!.s).toHaveLength(0);
    expect(parseDelayState('not json')).toBeNull();
  });

  it('identity: the source starts a new series, thresholds do not', () => {
    const base = checkSchema.parse({
      id: 'f',
      name: 'f',
      type: 'freshness',
      platform: 'plt_1',
      assetId: 'a1',
      aspect: 'Energy',
      variables: ['activePower', 'energy'],
      mode: 'cadence',
      expectedIntervalSeconds: 60,
    }) as CheckDef;
    const id = delayIdentity(base)!;
    const same = (p: Record<string, unknown>) => delayIdentity({ ...base, ...p } as CheckDef) === id;
    expect(same({ expectedIntervalSeconds: 30, allowedDelaySeconds: 600, mode: 'maxAge', maxAgeSeconds: 60, name: 'x', intervalSeconds: 30 })).toBe(true);
    expect(same({ variables: ['energy', 'activePower'] })).toBe(true); // the order does not matter
    for (const p of [{ platform: 'plt_2' }, { assetId: 'a2' }, { aspect: 'Other' }, { variables: ['energy'] }, { source: 'platform' }])
      expect(same(p)).toBe(false);
    const api = { ...base, source: 'platform', path: '/x', timestamp: 'ts' } as CheckDef;
    const apiId = delayIdentity(api);
    for (const p of [{ path: '/y' }, { query: { a: '1' } }, { timestamp: 'other' }, { method: 'POST' }])
      expect(delayIdentity({ ...api, ...p } as CheckDef)).not.toBe(apiId);
    expect(delayIdentity({ id: 'h', name: 'h', type: 'heartbeat' } as CheckDef)).toBeNull();
    // a different identity resets samples and counts
    let st = observeDelay(null, id, read(T0, { v: T0 }));
    st = observeDelay(st, id, { failed: true, at: T0 + MIN });
    st = observeDelay(st, id, read(T0 + 2 * MIN, { v: T0 + MIN }));
    expect(st.vars.v!.s).toHaveLength(1);
    const reset = observeDelay(st, 'other', read(T0 + 3 * MIN, { v: T0 + 2 * MIN }));
    expect(reset.vars.v!.s).toEqual([]);
    expect(reset.since).toBe(T0 + 3 * MIN + 200);
    expect(summarizeDelay(reset, 60, T0 + 3 * MIN)!.excluded.failedReads).toBe(0);
  });

  it('window bounds: 7 days, 20-minute slots (widest bounds), at most 500 slots per variable', () => {
    let st: DelayState | null = null;
    // a new value every minute for 9 days
    for (let i = 0; i < 9 * 1440; i++) st = observeDelay(st, 'id', read(T0 + i * MIN, { v: T0 + i * MIN - 30 * S - (i % 7) * S }));
    const s = st!.vars.v!.s;
    expect(s.length).toBeLessThanOrEqual(DELAY_MAX_SAMPLES);
    const now = T0 + 9 * DAY;
    expect(s[0]![0] + s[0]![1]).toBeGreaterThanOrEqual((now - 7 * DAY) / S - DELAY_SLOT_SECONDS);
    // a slot keeps the highest upper and lowest lower bound of its samples
    const slot = s.at(-2)!;
    expect(slot[6]).toBeGreaterThan(1);
    expect(slot[3]).toBe(Math.max(...s.slice(1, -1).map((x) => x[3])));
    const sum = summarizeDelay(st, 60, now)!;
    expect(sum.worst!.samples).toBeGreaterThan(9000); // samples, not slots
    expect(sum.worst!.coverageSeconds).toBeGreaterThan(6.9 * 86400);
  });

  it('percentiles: nearest rank – always an observed value', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile(v, 90)).toBe(9);
    expect(percentile([7], 95)).toBe(7);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 50)).toBe(50);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('observed delay: suggestion', () => {
  const observed = (p95: number, samples = 100, coverageSeconds = 2 * 86400, intervalSeconds = 60) => {
    const worst = { name: 'v', samples, coverageSeconds, peakAge: { median: p95 - 60, p95, max: p95 * 3 }, delay: { low: 30, high: 90 } };
    return { worst, intervalSeconds, enough: samples >= 20 && coverageSeconds >= 86400 };
  };

  it('needs 24 hours and 20 samples', () => {
    const c: FreshnessSettings = { mode: 'cadence', expectedIntervalSeconds: 60 };
    expect(suggestFreshness(observed(403, 19), c)).toBeNull();
    expect(suggestFreshness(observed(403, 100, 86399), c)).toBeNull();
    expect(suggestFreshness(observed(403, 20, 86400), c)).not.toBeNull();
    expect(suggestFreshness(null, c)).toBeNull();
  });

  it('cadence: p95 − expected interval, rounded up to the minute, plus one check interval', () => {
    const s = suggestFreshness(observed(403), { mode: 'cadence', expectedIntervalSeconds: 60, allowedDelaySeconds: 360 })!;
    expect(s.changes).toEqual([{ field: 'allowedDelaySeconds', from: 360, to: 420 }]);
    expect(s.basedOnSeconds).toBe(403);
    expect(s.marginSeconds).toBe(60);
    expect(suggestFreshness(observed(403), { mode: 'cadence', expectedIntervalSeconds: 60 })!.changes[0]!.from).toBeNull();
    // already covered: nothing to change
    expect(suggestFreshness(observed(403), { mode: 'cadence', expectedIntervalSeconds: 60, allowedDelaySeconds: 420 })!.changes).toEqual([]);
    // data younger than the interval: only the margin
    expect(suggestFreshness(observed(50, 100, 86400, 30), { mode: 'cadence', expectedIntervalSeconds: 60 })!.changes[0]!.to).toBe(30);
    expect(suggestFreshness(observed(403), { mode: 'cadence' })).toBeNull();
  });

  it('maxAge: p95 − allowance, rounded up, plus one interval; a warning below the peak is removed', () => {
    expect(suggestFreshness(observed(810), { mode: 'maxAge', maxAgeSeconds: 600 })!.changes).toEqual([{ field: 'maxAgeSeconds', from: 600, to: 900 }]);
    // with an allowance, the maximum age is what the peak needs beyond it
    expect(suggestFreshness(observed(810), { mode: 'maxAge', maxAgeSeconds: 600, allowedDelaySeconds: 300 })!.changes).toEqual([]);
    expect(suggestFreshness(observed(810), { mode: 'maxAge', maxAgeSeconds: 900, degradedAgeSeconds: 300 })!.changes).toEqual([
      { field: 'degradedAgeSeconds', from: 300, to: null },
    ]);
    expect(suggestFreshness(observed(810), { mode: 'maxAge', maxAgeSeconds: 900, degradedAgeSeconds: 600, allowedDelaySeconds: 600 })!.changes).toEqual([
      { field: 'maxAgeSeconds', from: 900, to: 300 },
      // a warning no lower than the new maximum would never come first
      { field: 'degradedAgeSeconds', from: 600, to: null },
    ]);
  });
});

// ---------------------------------------------------------------------------

/** One healthy data path, the check on it, and how it is configured before the measurement. */
interface Scenario {
  name: string;
  pipeline: IotPipeline;
  intervalSeconds: number;
  config: FreshnessConfig;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'every value uploaded on its own',
    pipeline: { cadenceSeconds: 60, ingestDelaySeconds: 20, jitterSeconds: 10 },
    intervalSeconds: 60,
    config: { mode: 'cadence', expectedIntervalSeconds: 60 },
  },
  {
    name: '1-minute values uploaded every 15 minutes',
    pipeline: { cadenceSeconds: 60, uploadEverySeconds: 900, ingestDelaySeconds: 60, jitterSeconds: 60 },
    intervalSeconds: 60,
    config: { mode: 'cadence', expectedIntervalSeconds: 60, degradedAfterMissed: 1, downAfterMissed: 3 },
  },
  {
    name: 'device clock 45 s behind, 10-second values every 5 minutes',
    pipeline: { cadenceSeconds: 10, uploadEverySeconds: 300, ingestDelaySeconds: 30, jitterSeconds: 20, clockSkewSeconds: -45 },
    intervalSeconds: 30,
    config: { mode: 'cadence', expectedIntervalSeconds: 10, degradedAfterMissed: 3, downAfterMissed: 6 },
  },
  {
    name: 'device clock 3 s ahead (within the tolerance), failing reads',
    pipeline: { cadenceSeconds: 60, uploadEverySeconds: 120, ingestDelaySeconds: 30, clockSkewSeconds: 3, failEvery: 17 },
    intervalSeconds: 60,
    config: { mode: 'cadence', expectedIntervalSeconds: 60 },
  },
  {
    name: 'on-change data with a maximum age that is too tight',
    pipeline: { cadenceSeconds: 600, ingestDelaySeconds: 120, jitterSeconds: 60 },
    intervalSeconds: 60,
    config: { mode: 'maxAge', maxAgeSeconds: 300, degradedAgeSeconds: 240 },
  },
];

const apply = (c: FreshnessConfig, changes: { field: string; to: number | null }[]): FreshnessConfig => {
  const out = { ...c } as Record<string, unknown>;
  for (const ch of changes) out[ch.field] = ch.to ?? undefined;
  return out as unknown as FreshnessConfig;
};

describe('observed delay on simulated data paths', () => {
  it('the mock data path: batches become readable after upload and ingest delay; outages leave a gap', () => {
    const p: IotPipeline = { cadenceSeconds: 60, uploadEverySeconds: 300, ingestDelaySeconds: 60, outages: [{ from: T0 + 600 * S, to: T0 + 1200 * S }] };
    // batch (T0−300 s, T0] is readable from T0 + 60 s
    expect(readablePoints(p, T0 + 59 * S, T0 - DAY, 1)).toEqual([T0 - 300 * S]);
    expect(readablePoints(p, T0 + 60 * S, T0 - DAY, 2)).toEqual([T0, T0 - 60 * S]);
    // during and after the outage the newest is from before it, until a batch after it is readable
    expect(readablePoints(p, T0 + 1250 * S, T0 - DAY, 1)).toEqual([T0 + 540 * S]);
    expect(readablePoints(p, T0 + 1560 * S, T0 - DAY, 1)).toEqual([T0 + 1500 * S]);
    expect(readNewest({ ...p, failEvery: 3 }, T0, 3)).toEqual({ failed: true });
    expect(readNewest({ ...p, clockSkewSeconds: -30 }, T0 + 60 * S, 1)).toEqual({ failed: false, newest: T0 - 30 * S });
    expect(readNewest({ ...p, backwardsEvery: 2 }, T0 + 60 * S, 2)).toEqual({ failed: false, newest: T0 - 300 * S });
  });

  for (const sc of SCENARIOS) {
    it(`${sc.name}: the suggested setting raises no alarm for a week; a longer outage is detected`, () => {
      const vars = ['v'];
      const week1 = T0;
      const week2 = T0 + 7 * DAY;
      const outageAt = T0 + 14 * DAY + 3 * H;
      const measured = simulateReads(sc.pipeline, { identity: 'id', variables: vars, from: week1, to: week2 - 1, intervalSeconds: sc.intervalSeconds });
      const sum = summarizeDelay(measured, sc.intervalSeconds, week2)!;
      expect(sum.enough).toBe(true);
      const suggestion = suggestFreshness(sum, sc.config)!;
      expect(suggestion).not.toBeNull();
      const config = apply(sc.config, suggestion.changes);
      // a week with the suggested setting: no degraded, no down
      const alarms: string[] = [];
      simulateReads(sc.pipeline, {
        identity: 'id',
        variables: vars,
        state: measured,
        from: week2,
        to: week2 + 7 * DAY,
        intervalSeconds: sc.intervalSeconds,
        onRead: (at, newest) => {
          const f = freshnessStatus(newest, at, config);
          if (f.status !== 'up') alarms.push(`${new Date(at).toISOString()}: ${f.message}`);
        },
      });
      expect(alarms.slice(0, 3)).toEqual([]);
      // an outage longer than the threshold plus the margin: detected
      const threshold =
        config.mode === 'cadence'
          ? (config.allowedDelaySeconds ?? 0) + (config.expectedIntervalSeconds ?? 60) * (config.downAfterMissed ?? 4)
          : (config.maxAgeSeconds ?? 0) + (config.allowedDelaySeconds ?? 0);
      const outageMs = (threshold + suggestion.marginSeconds + 2 * Math.max(sc.pipeline.uploadEverySeconds ?? 0, sc.pipeline.cadenceSeconds)) * S;
      const broken: IotPipeline = { ...sc.pipeline, failEvery: undefined, outages: [{ from: outageAt, to: outageAt + outageMs }] };
      let down = false;
      simulateReads(broken, {
        identity: 'id',
        variables: vars,
        from: outageAt,
        to: outageAt + outageMs,
        intervalSeconds: sc.intervalSeconds,
        onRead: (at, newest) => {
          if (freshnessStatus(newest, at, config).status === 'down') down = true;
        },
      });
      expect(down).toBe(true);
    });
  }

  it('reads that fail or go backwards are counted and do not change the suggestion', () => {
    const clean: IotPipeline = { cadenceSeconds: 60, uploadEverySeconds: 300, ingestDelaySeconds: 60, jitterSeconds: 30 };
    const noisy: IotPipeline = { ...clean, failEvery: 17, backwardsEvery: 23 };
    const run = (p: IotPipeline) =>
      summarizeDelay(simulateReads(p, { identity: 'id', variables: ['v'], from: T0, to: T0 + 7 * DAY, intervalSeconds: 60 }), 60, T0 + 7 * DAY)!;
    const a = run(clean);
    const b = run(noisy);
    expect(b.excluded.failedReads).toBeGreaterThan(500);
    expect(b.excluded.wentBackwards).toBeGreaterThan(100);
    expect(b.excluded.futureTimestamps).toBe(0);
    const c: FreshnessSettings = { mode: 'cadence', expectedIntervalSeconds: 60 };
    // a skipped read only widens a sample by one interval: the suggestion stays within one minute
    expect(Math.abs(suggestFreshness(b, c)!.changes[0]!.to! - suggestFreshness(a, c)!.changes[0]!.to!)).toBeLessThanOrEqual(60);
  });

  it('a device clock ahead of real time: every timestamp is in the future, no sample, no suggestion', () => {
    const p: IotPipeline = { cadenceSeconds: 60, uploadEverySeconds: 60, ingestDelaySeconds: 10, clockSkewSeconds: 300 };
    const sum = summarizeDelay(simulateReads(p, { identity: 'id', variables: ['v'], from: T0, to: T0 + 2 * DAY, intervalSeconds: 60 }), 60, T0 + 2 * DAY)!;
    expect(sum.worst).toBeNull();
    expect(sum.excluded.futureTimestamps).toBeGreaterThan(2000);
    expect(sum.enough).toBe(false);
  });

  it('samples during maintenance are left out', () => {
    const p: IotPipeline = { cadenceSeconds: 60, uploadEverySeconds: 300, ingestDelaySeconds: 60 };
    const maint = (t: number) => t >= T0 + DAY && t < T0 + DAY + 2 * H;
    const sum = summarizeDelay(
      simulateReads(p, { identity: 'id', variables: ['v'], from: T0, to: T0 + 2 * DAY, intervalSeconds: 60, inMaintenance: maint }),
      60,
      T0 + 2 * DAY,
    )!;
    expect(sum.excluded.maintenance).toBeGreaterThanOrEqual(24);
    expect(sum.excluded.maintenance).toBeLessThanOrEqual(26);
  });
});
