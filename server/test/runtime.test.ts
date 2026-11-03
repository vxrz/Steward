import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Runtime robustness: the global run limit (SM_MAX_CONCURRENT_RUNS, engine/runner.ts) and the graceful shutdown
 * (bootstrap.ts): no new runs, running steps get the grace period, the rest is marked interrupted, runs waiting for a
 * person are left to resume after the restart.
 */
let s: TestServer;
let config: typeof import('../src/config.js').config;
let runner: typeof import('../src/engine/runner.js');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = async (id: string): Promise<string> => (await s.api<{ status: string }>('GET', `/runs/${id}`)).status;
const start = async (processId: string): Promise<string> => (await s.api<{ id: string }>('POST', '/runs', { processId })).id;

async function until(fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await wait(25);
  }
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  ({ config } = await import('../src/config.js'));
  runner = await import('../src/engine/runner.js');
  const { quiesce } = await import('./helpers.js');
  await quiesce();
  for (const [name, steps] of [
    ['Short step', [{ id: 'w', type: 'wait', seconds: 0.4 }]],
    ['Long step', [{ id: 'w', type: 'wait', seconds: 60 }]],
    ['Needs approval', [{ id: 'ok', type: 'userTask', mode: 'approve', title: 'Go on?' }]],
  ] as const)
    await s.api('POST', '/processes', { definition: { name, steps } });
});
afterAll(async () => {
  config.maxConcurrentRuns = 20;
  await s?.app.close();
});

describe('global run limit (SM_MAX_CONCURRENT_RUNS)', () => {
  it('queues runs beyond the limit and starts them first come, first served', async () => {
    config.maxConcurrentRuns = 2;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await start('short-step'));
    expect(await Promise.all(ids.map(status))).toEqual(['running', 'running', 'queued', 'queued', 'queued']);
    expect(runner.queuedRunIds()).toEqual(ids.slice(2));
    const detail = await s.api<{ logs?: { message: string }[] }>('GET', `/runs/${ids[4]}`);
    expect(JSON.stringify(detail)).toMatch(/Waiting for a free slot/);
    // never more than two at a time
    let most = 0;
    await until(async () => {
      most = Math.max(most, runner.busyRunIds().length);
      return (await Promise.all(ids.map(status))).every((x) => x === 'succeeded');
    }, 20_000);
    expect(most).toBeLessThanOrEqual(2);
    const runs = await Promise.all(ids.map((id) => s.api<{ startedAt: string }>('GET', `/runs/${id}`)));
    const started = runs.map((r) => Date.parse(r.startedAt));
    // in the order they arrived; a queued run's start is when it got its slot
    expect([...started].sort((a, b) => a - b)).toEqual(started);
    expect(started[2]!).toBeGreaterThan(started[0]! + 300);
    const audit = await s.api<{ summary: string }[]>('GET', `/audit?runId=${ids[2]}&limit=5`);
    expect(audit.map((a) => a.summary).join('\n')).toMatch(/queued: 2 of at most 2 runs are running/);
  });

  it('does not count runs waiting for a person', async () => {
    config.maxConcurrentRuns = 1;
    const waiting = await start('needs-approval');
    await s.waitRun(waiting, ['waiting']);
    const next = await start('short-step');
    expect(await status(next)).toBe('running');
    await s.waitRun(next, ['succeeded']);
    await s.api('POST', `/runs/${waiting}/cancel`);
  });

  it('lets a queued run be cancelled (it leaves the queue)', async () => {
    config.maxConcurrentRuns = 1;
    const first = await start('short-step');
    const second = await start('short-step');
    expect(await status(second)).toBe('queued');
    await s.api('POST', `/runs/${second}/cancel`);
    expect(await status(second)).toBe('cancelled');
    expect(runner.queuedRunIds()).not.toContain(second);
    await s.waitRun(first, ['succeeded']);
    await wait(100);
    expect(await status(second)).toBe('cancelled');
  });

  it('keeps queued runs across a restart: recovery queues them again in their order', async () => {
    config.maxConcurrentRuns = 1;
    const { db } = await import('../src/db.js');
    const blocker = await start('short-step');
    // two runs that were queued when the server stopped (persisted in the database, not in this process)
    const a = await start('short-step');
    const b = await start('short-step');
    expect(runner.queuedRunIds()).toEqual([a, b]);
    // the restart: the in-memory queue is gone, the rows stay
    await s.api('POST', `/runs/${a}/cancel`);
    await s.api('POST', `/runs/${b}/cancel`);
    db().run("UPDATE runs SET status = 'queued', finished_at = NULL WHERE id IN (?, ?)", a, b);
    expect(runner.queuedRunIds()).toEqual([]);
    await runner.recoverRuns();
    expect(runner.queuedRunIds()).toEqual([a, b]);
    await s.waitRun(blocker, ['succeeded']);
    await s.waitRun(a, ['succeeded']);
    await s.waitRun(b, ['succeeded']);
    config.maxConcurrentRuns = 20;
  });

  it('0 means no limit', async () => {
    config.maxConcurrentRuns = 0;
    const ids = await Promise.all([1, 2, 3].map(() => runner.startRun({ processId: 'short-step' }, { actor: 'admin' })));
    expect(await Promise.all(ids.map(status))).toEqual(['running', 'running', 'running']);
    for (const id of ids) await s.waitRun(id, ['succeeded']);
    config.maxConcurrentRuns = 20;
  });
});

describe('graceful shutdown', () => {
  it('queues a sub-process run started while shutting down (it starts after the restart)', async () => {
    runner.stopAcceptingRuns();
    try {
      const id = await runner.startRun({ processId: 'short-step' }, { trigger: 'subprocess', actor: 'admin' });
      expect(await status(id)).toBe('queued');
      runner.resumeAcceptingRuns();
      await s.waitRun(id, ['succeeded']);
    } finally {
      runner.resumeAcceptingRuns();
    }
  });
});
