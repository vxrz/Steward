import { applyObservation, type DelayState } from '../monitors/delay.js';
import { readNewest, type IotPipeline } from './iotPipeline.js';

/**
 * Runs a freshness check against a simulated data path (iotPipeline.ts) on simulated time: every `intervalSeconds`
 * from `from` to `to` (ms), one read that takes `readMs`. Each read is passed to `onRead` (the tests evaluate the
 * check's status with it) and to the observed delay. The demo seeds its PowerMeter's history this way (demo.ts).
 */
export function simulateReads(
  p: IotPipeline,
  opts: {
    identity: string;
    variables: string[];
    from: number;
    to: number;
    intervalSeconds: number;
    readMs?: number;
    state?: DelayState | null;
    inMaintenance?: (t: number) => boolean;
    onRead?: (at: number, newest: number | null) => void;
  },
): DelayState | null {
  let state = opts.state ?? null;
  const readMs = opts.readMs ?? 200;
  let n = 0;
  for (let t = opts.from; t <= opts.to; t += opts.intervalSeconds * 1000) {
    n++;
    const r = readNewest(p, t + readMs / 2, n);
    if (r.failed) state = applyObservation(state, opts.identity, { failed: true, at: t + readMs }, opts.inMaintenance);
    else {
      opts.onRead?.(t + readMs, r.newest);
      state = applyObservation(
        state,
        opts.identity,
        { start: t, end: t + readMs, newest: Object.fromEntries(opts.variables.map((v) => [v, r.newest])) },
        opts.inMaintenance,
      );
    }
  }
  return state;
}
