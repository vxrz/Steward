import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The background job runner (jobs/registry.ts): no overlap, time limits, results that survive a restart,
 * Prometheus metrics and "Run now" on System status.
 */
let s: TestServer;
let reg: typeof import('../src/jobs/registry.js');

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const job = (name: string) => reg.listJobs().find((j) => j.name === name)!;
async function metric(line: RegExp): Promise<number> {
  const { metricsText } = await import('../src/metrics.js');
  const m = line.exec((await metricsText()).body);
  return m ? Number(m[1]) : NaN;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  reg = await import('../src/jobs/registry.js');
});
afterAll(async () => {
  reg?.resetJobs();
  await s?.app.close();
});
beforeEach(() => reg.resetJobs());

describe('background jobs', () => {
  it('never runs a job twice at the same time: a start while it runs is skipped and counted', async () => {
    const gate = deferred();
    let calls = 0;
    reg.registerJob({
      name: 'overlap',
      intervalMs: 60_000,
      timeoutMs: 10_000,
      run: async () => {
        calls++;
        await gate.promise;
      },
    });
    const first = reg.runJob('overlap');
    await wait(10);
    expect(job('overlap')).toMatchObject({ running: true, lastResult: null });
    expect(await reg.runJob('overlap')).toBe(false);
    expect(await reg.runJob('overlap')).toBe(false);
    gate.resolve();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(job('overlap')).toMatchObject({ running: false, lastResult: 'succeeded', runs: 1, skipped: 2, failures: 0, lastError: null });
    expect(job('overlap').lastSuccessAt).toBeTruthy();
    expect(job('overlap').lastDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a run over its time limit as timed out, aborts its signal and keeps the guard until it really ends', async () => {
    const gate = deferred();
    let aborted = false;
    const failuresBefore = (await metric(/^sm_job_failures_total\{job="slow"\} (\d+)/m)) || 0;
    reg.registerJob({
      name: 'slow',
      intervalMs: 60_000,
      timeoutMs: 50,
      run: async (signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        await gate.promise;
      },
    });
    const t0 = Date.now();
    expect(await reg.runJob('slow')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(aborted).toBe(true);
    expect(job('slow')).toMatchObject({ lastResult: 'timedOut', running: true, failures: 1 });
    expect(job('slow').lastError).toMatch(/longer than/);
    // still running: the next start waits
    expect(await reg.runJob('slow')).toBe(false);
    gate.resolve();
    await reg.jobSettled('slow');
    expect(job('slow').running).toBe(false);
    expect(await metric(/^sm_job_failures_total\{job="slow"\} (\d+)/m)).toBe(failuresBefore + 1);
  });

  it('records failures with their message and counts them in sm_job_failures_total', async () => {
    reg.registerJob({
      name: 'broken',
      intervalMs: 60_000,
      timeoutMs: 1000,
      run: () => {
        throw new Error('the upstream said no');
      },
    });
    await reg.runJob('broken');
    await reg.runJob('broken');
    expect(job('broken')).toMatchObject({ lastResult: 'failed', lastError: 'the upstream said no', runs: 2, failures: 2, lastSuccessAt: null });
    expect(await metric(/^sm_job_failures_total\{job="broken"\} (\d+)/m)).toBeGreaterThanOrEqual(2);
    expect(await metric(/^sm_job_last_success_timestamp_seconds\{job="broken"\} (\d+)/m)).toBe(0);
  });

  it('exports the time of the last success and the durations', async () => {
    reg.registerJob({ name: 'fine', intervalMs: 60_000, timeoutMs: 1000, run: () => undefined });
    const before = Date.now() / 1000 - 1;
    await reg.runJob('fine');
    expect(await metric(/^sm_job_last_success_timestamp_seconds\{job="fine"\} ([\d.e+]+)/m)).toBeGreaterThan(before);
    expect(await metric(/^sm_job_duration_seconds_count\{job="fine"\} (\d+)/m)).toBeGreaterThanOrEqual(1);
  });

  it('keeps the state across a restart (the database), including the last success in the metrics', async () => {
    reg.registerJob({ name: 'kept', intervalMs: 60_000, timeoutMs: 1000, run: () => undefined });
    await reg.runJob('kept');
    const before = job('kept');
    // a new process: the registry is empty, the table is not
    reg.resetJobs();
    reg.registerJob({ name: 'kept', intervalMs: 60_000, timeoutMs: 1000, run: () => undefined });
    expect(job('kept')).toMatchObject({ lastResult: 'succeeded', runs: 1, lastSuccessAt: before.lastSuccessAt, running: false });
    expect(await metric(/^sm_job_last_success_timestamp_seconds\{job="kept"\} ([\d.e+]+)/m)).toBeCloseTo(Date.parse(before.lastSuccessAt!) / 1000, 0);
  });

  it('runs on its interval while started, with the next run shown, and stops', async () => {
    let calls = 0;
    reg.registerJob({ name: 'ticking', intervalMs: 40, timeoutMs: 1000, run: () => void calls++ });
    expect(job('ticking').nextRunAt).toBeNull();
    reg.startJobs();
    expect(Date.parse(job('ticking').nextRunAt!)).toBeGreaterThan(Date.now() - 1000);
    await wait(250);
    expect(await reg.stopJobs(1000)).toEqual([]);
    const seen = calls;
    expect(seen).toBeGreaterThanOrEqual(2);
    await wait(150);
    expect(calls).toBe(seen);
    expect(job('ticking').nextRunAt).toBeNull();
  });

  it('runs an extra first time soon after the start (the clean-up: one minute after start, then daily)', async () => {
    let calls = 0;
    reg.registerJob({ name: 'first', intervalMs: 60_000, firstRunAfterMs: 20, timeoutMs: 1000, run: () => void calls++ });
    reg.startJobs();
    await wait(150);
    await reg.stopJobs();
    expect(calls).toBe(1);
  });

  it('stopJobs waits (up to its limit) for running jobs and names those still running', async () => {
    const gate = deferred();
    reg.registerJob({ name: 'busy', intervalMs: 60_000, timeoutMs: 10_000, run: () => gate.promise });
    reg.startJobs();
    void reg.runJob('busy');
    await wait(10);
    expect(await reg.stopJobs(50)).toEqual(['busy']);
    gate.resolve();
    await reg.jobSettled('busy');
    expect(await reg.stopJobs(50)).toEqual([]);
  });

  it('registers the built-in jobs with their intervals', async () => {
    const { registerFeatureJobs } = await import('../src/features/index.js');
    registerFeatureJobs();
    registerFeatureJobs();
    const names = reg.registeredJobs();
    for (const n of [
      'stale-datasets',
      'credential-reminders',
      'duties',
      'scorecard',
      'kubernetes',
      'repositories',
      'kafka',
      'kafka-connect',
      'aws',
      'snowflake',
      'dependency-track',
      'vault-links',
      'ai-usage',
      'daily-summary',
      'cleanup',
      'audit-checkpoint',
      'git-sync',
      'scheduler-heartbeat',
    ])
      expect(names).toContain(n);
    expect(job('duties')).toMatchObject({ everySeconds: 300 });
    expect(job('cleanup')).toMatchObject({ everySeconds: 86400 });
    expect(job('git-sync')).toMatchObject({ everySeconds: 60 });
  });
});

describe('System status: background jobs (administrators)', () => {
  it('lists the jobs and starts one with "Run now" (audited), 409 while it runs, 404 for an unknown one', async () => {
    const gate = deferred();
    reg.registerJob({ name: 'by-hand', intervalMs: 60_000, timeoutMs: 10_000, run: () => gate.promise });
    const list = await s.api<{ jobs: { name: string }[]; running: boolean }>('GET', '/system/jobs');
    expect(list.running).toBe(false);
    expect(list.jobs.map((j) => j.name)).toContain('by-hand');
    expect(await s.api('POST', '/system/jobs/by-hand/run')).toEqual({ started: true });
    await wait(10);
    await expect(s.api('POST', '/system/jobs/by-hand/run')).rejects.toMatchObject({ status: 409, body: { code: 'JOB_RUNNING' } });
    await expect(s.api('POST', '/system/jobs/nope/run')).rejects.toMatchObject({ status: 404, body: { code: 'JOB_NOT_FOUND' } });
    gate.resolve();
    await reg.jobSettled('by-hand');
    const j = (await s.api<{ jobs: { name: string; lastResult: string; lastTrigger: string }[] }>('GET', '/system/jobs')).jobs.find(
      (x) => x.name === 'by-hand',
    );
    expect(j).toMatchObject({ lastResult: 'succeeded', lastTrigger: 'manual' });
    const audit = await s.api<{ action: string; entityId: string; actor: string }[]>('GET', '/audit?action=job.run_requested&limit=5');
    expect(audit[0]).toMatchObject({ action: 'job.run_requested', entityId: 'by-hand', actor: 'admin' });
  });
});
