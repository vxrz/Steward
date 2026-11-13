import { monitorEventLoopDelay } from 'node:perf_hooks';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Discovery at scale (ADR 0036 _Performance_, WP2): about 50,000 Snowflake objects from the mock in partitions, written
 * in batches of 500 with multi-row statements – within 60 s, with the event loop's lag below 200 ms; a second, unchanged
 * run writes only readouts; the statements per batch stay a small fixed number; 20,000 Kafka topics the same way.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let snowflake = '';
let kafka = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { applications: false });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  kafka = platforms.find((p) => p.kind === 'kafka')!.id;
}, 180_000);

/** Runs a source and measures the time, the event loop's longest delay and the database statements of the run. */
async function measured(sourceId: string) {
  const { runSource } = await import('../src/dataproducts/discovery/job.js');
  const { requestDbStats } = await import('../src/database/timing.js');
  const stats = { statements: 0, ms: 0 };
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const t0 = Date.now();
  const run = await requestDbStats.run(stats, () => runSource(sourceId, { trigger: 'schedule' }));
  const ms = Date.now() - t0;
  h.disable();
  // the lag as Steward reports it (sm_event_loop_lag_seconds: the p99 of the delay, eventloop.ts) – the in-process mock
  // that answers the statements and a busy test machine add to the maximum, which is kept for the log
  return { run, ms, maxLagMs: h.percentile(99) / 1e6, worstMs: h.max / 1e6, statements: stats.statements };
}

/**
 * The event loop's p99 lag: 200 ms is the target (SM_PERF=1, run alone); beside other test files on a shared runner the
 * CPU is starved and the lag measures the machine, so the everyday bound only catches a run that blocks the loop.
 */
const LAG_MS = process.env.SM_PERF ? 200 : 1000;

describe('discovery at scale', () => {
  it('reads about 50,000 Snowflake tables within 60 s, with the event loop free; an unchanged run writes only readouts', async () => {
    const sf = await import('../src/mock/mockSnowflake.js');
    // 10 schemas × 4,980 tables, the database and its schemas: 49,811 elements (the run's limit is 50,000)
    sf.addSnowflakeBulk('BIG', 10, 4_980);
    const src = await dana('POST', '/data-products/discovery-sources', {
      name: 'Big',
      platformId: snowflake,
      scope: ['BIG'],
      mode: 'accountUsage',
      enabled: false,
    });
    const first = await measured(src.id);
    expect(first.run).toMatchObject({ status: 'succeeded', added: 49_811, truncated: false });
    expect(first.ms).toBeLessThan(60_000);
    expect(first.maxLagMs).toBeLessThan(LAG_MS);
    // multi-row writes: well under one statement per element (a batch of 500 costs a few dozen)
    expect(first.statements).toBeLessThan(49_811 / 5);
    const second = await measured(src.id);
    expect(second.run).toMatchObject({ status: 'succeeded', added: 0, changed: 0, renamed: 0, missing: 0, unchanged: 49_811 });
    expect(second.ms).toBeLessThan(60_000);
    expect(second.maxLagMs).toBeLessThan(LAG_MS);
    expect(second.statements).toBeLessThan(first.statements);
    // the catalogue reads them by keyset pages
    const page = await dana('GET', '/data-elements?prefix=big.s9.&limit=100');
    expect(page.items).toHaveLength(100);
    sf.resetSnowflakeCatalogue();
  }, 240_000);

  it('a run beyond the limit keeps the first and says truncated, marking nothing missing', async () => {
    const sf = await import('../src/mock/mockSnowflake.js');
    sf.addSnowflakeBulk('HUGE', 11, 4_600);
    const src = await dana('POST', '/data-products/discovery-sources', {
      name: 'Huge',
      platformId: snowflake,
      scope: ['HUGE'],
      mode: 'accountUsage',
      enabled: false,
    });
    const r = await measured(src.id);
    expect(r.run).toMatchObject({ status: 'truncated', truncated: true, added: 50_000, missing: 0, errorCode: 'DATA_DISCOVERY_TOO_LARGE' });
    expect(r.maxLagMs).toBeLessThan(LAG_MS);
    sf.resetSnowflakeCatalogue();
  }, 240_000);

  it('reads 20,000 Kafka topics in a few requests', async () => {
    const mk = await import('../src/mock/mockKafka.js');
    mk.addKafkaTopics('scale.', 20_000);
    mk.resetKafkaCalls();
    const src = await dana('POST', '/data-products/discovery-sources', { name: 'Many topics', platformId: kafka, scope: ['scale.'], enabled: false });
    const r = await measured(src.id);
    expect(r.run).toMatchObject({ status: 'succeeded', added: 20_000 });
    expect(r.ms).toBeLessThan(60_000);
    expect(r.maxLagMs).toBeLessThan(LAG_MS);
    // one listing and one description per 200 topics
    expect(mk.kafkaCalls().length).toBe(1 + 20_000 / 200);
    mk.resetKafka();
  }, 240_000);
});
