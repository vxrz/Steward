import crypto from 'node:crypto';

/**
 * A simulated data path from a device to the Insights Hub store (0.13): the device measures on a grid, the gateway
 * uploads in batches, the store makes a batch readable some time later. Pure (the time is passed in), so the mock
 * (mockIot.ts) and the tests of the observed delay (server/test/freshness-delay.test.ts) use the same model.
 */
export interface IotPipeline {
  /** The device measures every N seconds (on a grid of the epoch) */
  cadenceSeconds: number;
  /** The gateway uploads the values of the last N seconds at once (default: the cadence – every value on its own) */
  uploadEverySeconds?: number;
  /** After an upload the store needs this long until the values are readable */
  ingestDelaySeconds?: number;
  /** Each upload is up to N seconds later (deterministic per upload) */
  jitterSeconds?: number;
  /** The device clock is ahead (+) or behind (−) by N seconds: added to `_time` */
  clockSkewSeconds?: number;
  /** No values are measured or uploaded in these intervals (epoch ms, [from, to)) */
  outages?: { from: number; to: number }[];
  /** Every Nth read answers as of one upload earlier (a lagging replica: the newest timestamp goes backwards) */
  backwardsEvery?: number;
  /** Every Nth read fails (HTTP 500: Steward does not retry it) */
  failEvery?: number;
}

const upload = (p: IotPipeline) => Math.max(p.cadenceSeconds, p.uploadEverySeconds ?? p.cadenceSeconds) * 1000;

function jitter(p: IotPipeline, batch: number): number {
  if (!p.jitterSeconds) return 0;
  const h = crypto.createHash('sha1').update(`batch:${batch}`).digest();
  return Math.floor((h.readUInt32BE(0) / 0xffffffff) * p.jitterSeconds * 1000);
}

const inOutage = (p: IotPipeline, m: number) => (p.outages ?? []).some((o) => m >= o.from && m < o.to);

/** When batch b (measurements in ((b−1)·U, b·U]) becomes readable. */
const visibleAt = (p: IotPipeline, b: number) => b * upload(p) + jitter(p, b) + (p.ingestDelaySeconds ?? 0) * 1000;

/** Measurement times (true time, ms) readable at `now`, newest first, at most `max`, not older than `from` (true time). */
export function readablePoints(p: IotPipeline, now: number, from: number, max: number): number[] {
  const U = upload(p);
  const C = p.cadenceSeconds * 1000;
  // a few batches above the newest one that could be readable: jitter may reorder them
  const reach = Math.ceil(((p.jitterSeconds ?? 0) * 1000) / U) + 1;
  const out: number[] = [];
  let b = Math.floor((now - (p.ingestDelaySeconds ?? 0) * 1000) / U) + reach;
  for (; b * U >= from && out.length < max + reach * Math.ceil(U / C); b--) {
    const end = b * U;
    // a batch measured entirely within an outage has no points: jump below the outage
    const o = (p.outages ?? []).find((x) => end - U >= x.from && end < x.to);
    if (o) {
      b = Math.floor(o.from / U) + 1;
      continue;
    }
    if (visibleAt(p, b) > now) continue;
    for (let m = Math.floor(end / C) * C; m > end - U; m -= C) if (m >= from && !inOutage(p, m)) out.push(m);
  }
  return out.sort((x, y) => y - x).slice(0, max);
}

/**
 * Measurement times (true time, ms) readable at `now` within [from, to], oldest first, at most `max` – the order in
 * which the store answers a range (`from`, `to`, `limit`).
 */
export function readablePointsAsc(p: IotPipeline, now: number, from: number, to: number, max: number): number[] {
  const U = upload(p);
  const C = p.cadenceSeconds * 1000;
  const reach = Math.ceil(((p.jitterSeconds ?? 0) * 1000) / U) + 1;
  const top = Math.floor((now - (p.ingestDelaySeconds ?? 0) * 1000) / U) + reach;
  const out: number[] = [];
  for (let b = Math.ceil(from / U); b <= top && out.length < max; b++) {
    const end = b * U;
    if (end - U > to) break;
    const o = (p.outages ?? []).find((x) => end - U >= x.from && end < x.to);
    if (o) {
      b = Math.ceil(o.to / U) - 1;
      continue;
    }
    if (visibleAt(p, b) > now) continue;
    for (let m = Math.floor((end - U) / C) * C + C; m <= end && out.length < max; m += C) if (m >= from && m <= to && !inOutage(p, m)) out.push(m);
  }
  return out;
}

/** The `_time` (ms) of a measurement: the device clock. */
export const deviceTime = (p: IotPipeline, m: number) => m + (p.clockSkewSeconds ?? 0) * 1000;

/**
 * One read of the newest timestamp: `read` counts the reads of this series (from 1) for the failing and backwards
 * reads. null: nothing readable.
 */
export function readNewest(p: IotPipeline, now: number, read: number): { failed: true } | { failed: false; newest: number | null } {
  if (p.failEvery && read % p.failEvery === 0) return { failed: true };
  const asOf = p.backwardsEvery && read % p.backwardsEvery === 0 ? now - upload(p) : now;
  const m = readablePoints(p, asOf, asOf - 30 * 86400 * 1000, 1)[0];
  return { failed: false, newest: m === undefined ? null : deviceTime(p, m) };
}
