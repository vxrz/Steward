import { afterAll, describe, expect, it, vi } from 'vitest';

/** Event-loop protection (eventloop.ts): the p99 lag as a metric and a warning when the loop was blocked. */
describe('event-loop lag', () => {
  afterAll(async () => (await import('../src/eventloop.js')).stopEventLoopMonitor());

  it('measures a blocked event loop, exports the p99 and warns at most once a minute', async () => {
    const { logger } = await import('../src/log.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    const { startEventLoopMonitor, sampleEventLoop } = await import('../src/eventloop.js');
    const { registry } = await import('../src/metrics.js');
    startEventLoopMonitor();
    // the histogram's timer runs once the loop turns
    await new Promise((r) => setTimeout(r, 100));
    sampleEventLoop(0);
    await new Promise((r) => setTimeout(r, 50));
    // a long synchronous step: nothing else can run meanwhile
    const until = Date.now() + 1200;
    while (Date.now() < until) {
      /* busy */
    }
    await new Promise((r) => setTimeout(r, 50));
    const now = Date.now();
    const s = sampleEventLoop(now)!;
    expect(s.max).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toMatch(/the event loop was blocked/);
    expect(await registry.getSingleMetricAsString('sm_event_loop_lag_seconds')).toMatch(/^sm_event_loop_lag_seconds [\d.e+-]+$/m);
    // a second block within the minute: measured, not logged again
    await new Promise((r) => setTimeout(r, 50));
    const again = Date.now() + 1100;
    while (Date.now() < again) {
      /* busy */
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(sampleEventLoop(now + 1000)!.max).toBeGreaterThan(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
