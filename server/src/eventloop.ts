import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Gauge } from 'prom-client';
import { logger } from './log.js';
import { registry } from './metrics.js';

/**
 * Event-loop protection: Steward's database API is synchronous (SQLite, and the PostgreSQL bridge waits for each
 * answer), so a slow query or a long synchronous job holds up every request. The delay of the event loop is measured
 * all the time (perf_hooks.monitorEventLoopDelay); every WINDOW_MS its p99 goes to sm_event_loop_lag_seconds
 * and a lag over SM_EVENT_LOOP_WARN_MS (default 1000) is logged as a warning (at most once a minute).
 */

const WINDOW_MS = 10_000;
const WARN_EVERY_MS = 60_000;

let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
let timer: NodeJS.Timeout | undefined;
let gauge: Gauge | undefined;
let lastWarnAt = 0;
let lastP99 = 0;

const warnMs = () => Math.max(50, Number(process.env.SM_EVENT_LOOP_WARN_MS) || 1000);

/** One window: the p99 and maximum since the last one, in seconds. */
export function sampleEventLoop(now = Date.now()): { p99: number; max: number } | null {
  if (!histogram) return null;
  const p99 = histogram.percentile(99) / 1e9;
  const max = histogram.max / 1e9;
  histogram.reset();
  lastP99 = Number.isFinite(p99) ? p99 : 0;
  if (max * 1000 > warnMs() && now - lastWarnAt >= WARN_EVERY_MS) {
    lastWarnAt = now;
    logger.warn(
      { lagMs: Math.round(max * 1000), p99Ms: Math.round(p99 * 1000), windowSeconds: WINDOW_MS / 1000 },
      'the event loop was blocked: requests waited (a slow database query or a long synchronous step)',
    );
  }
  return { p99: lastP99, max };
}

export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  gauge ??= new Gauge({
    name: 'sm_event_loop_lag_seconds',
    help: `99th percentile of the event loop delay over the last ${WINDOW_MS / 1000} s`,
    registers: [registry],
    collect() {
      this.set(lastP99);
    },
  });
  timer = setInterval(() => sampleEventLoop(), WINDOW_MS);
  timer.unref();
}

export function stopEventLoopMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  histogram?.disable();
  histogram = undefined;
}
