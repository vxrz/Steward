import { Cron } from 'croner';
import { Counter, Gauge, Histogram } from 'prom-client';
import type { BackgroundJob, BackgroundJobResult } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { audit } from '../audit.js';
import { registry as metricsRegistry } from '../metrics.js';
import { HttpError, nowIso } from '../util.js';

/**
 * One runner for the periodic background work (reminders, integrations, clean-up, checkpoints): each job has a
 * name, an interval or a cron expression and a time limit. A job never runs twice at the same time – a start while
 * it still runs is skipped (and counted). The last start, end, duration, result and error of every job are kept in
 * the database (table background_jobs), so they survive a restart; System status shows them to administrators, with
 * "Run now", and /api/metrics has sm_job_last_success_timestamp_seconds, sm_job_duration_seconds and
 * sm_job_failures_total per job.
 *
 * A job that runs over its time limit is recorded as timed out (its AbortSignal is aborted); the next start is still
 * skipped until it has really ended – a promise cannot be stopped from outside.
 */

export interface JobDefinition {
  /** Stable name (lower case, dashes): the key of its state, its metrics label and its row on System status. */
  name: string;
  /** Every … milliseconds (first run one interval after the start, unless `firstRunAfterMs`). */
  intervalMs?: number;
  /** Or a cron expression (croner syntax), in `timezone` (default: the server's). */
  cron?: string;
  timezone?: string;
  /** An extra first run this long after the start (e.g. the clean-up one minute after start, then daily). */
  firstRunAfterMs?: number;
  /** Longest expected run; longer runs are recorded as timed out. */
  timeoutMs: number;
  run: (signal: AbortSignal) => unknown;
}

interface JobState {
  def: JobDefinition;
  timers: NodeJS.Timeout[];
  cron?: Cron;
  /** the promise of the current run (set while it runs, also after a timeout until it really ends) */
  running?: Promise<void>;
  runningSince?: number;
  nextRunAt?: number;
}

interface JobRow {
  name: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_duration_ms: number | null;
  last_result: BackgroundJobResult | null;
  last_error: string | null;
  last_success_at: string | null;
  last_trigger: string | null;
  runs: number;
  failures: number;
  skipped: number;
}

const jobs = new Map<string, JobState>();
let started = false;

// ---------- metrics ----------

let metrics: { lastSuccess: Gauge<'job'>; duration: Histogram<'job'>; failures: Counter<'job'> } | undefined;
function jobMetrics() {
  if (!metrics) {
    metrics = {
      lastSuccess: new Gauge({
        name: 'sm_job_last_success_timestamp_seconds',
        help: 'Unix time of the last successful run of a background job (0: none recorded)',
        labelNames: ['job'] as const,
        registers: [metricsRegistry],
      }),
      duration: new Histogram({
        name: 'sm_job_duration_seconds',
        help: 'Duration of background job runs',
        labelNames: ['job'] as const,
        buckets: [0.01, 0.05, 0.25, 1, 5, 15, 60, 300, 900, 3600],
        registers: [metricsRegistry],
      }),
      failures: new Counter({
        name: 'sm_job_failures_total',
        help: 'Background job runs that failed or ran over their time limit',
        labelNames: ['job'] as const,
        registers: [metricsRegistry],
      }),
    };
  }
  return metrics;
}

// ---------- state in the database ----------

function row(name: string): JobRow | undefined {
  try {
    return db().get<JobRow>('SELECT * FROM background_jobs WHERE name = ?', name);
  } catch {
    return undefined;
  }
}

/** Writes are best effort: a job must not fail because its bookkeeping could not be written (e.g. the database is away). */
function persist(name: string, sql: string, ...params: unknown[]): void {
  try {
    db().run(`INSERT INTO background_jobs (name) VALUES (?) ON CONFLICT (name) DO NOTHING`, name);
    db().run(sql, ...params, name);
  } catch (err) {
    logger.warn({ err, job: name }, 'could not record the state of a background job');
  }
}

// ---------- registry ----------

/** Registers a job (replacing one with the same name); it is planned when the runner starts (or now, if it runs). */
export function registerJob(def: JobDefinition): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(def.name)) throw new Error(`Invalid job name "${def.name}"`);
  if (!def.intervalMs === !def.cron) throw new Error(`Job "${def.name}" needs either intervalMs or cron`);
  const old = jobs.get(def.name);
  if (old) unplan(old);
  const state: JobState = { def, timers: [], running: old?.running, runningSince: old?.runningSince };
  jobs.set(def.name, state);
  const success = row(def.name)?.last_success_at;
  jobMetrics().lastSuccess.set({ job: def.name }, success ? Date.parse(success) / 1000 : 0);
  if (started) plan(state);
}

export function registeredJobs(): string[] {
  return [...jobs.keys()];
}

function plan(s: JobState): void {
  const { def } = s;
  const fire = () => void runJob(def.name, 'schedule').catch((err) => logger.warn({ err, job: def.name }, 'background job could not start'));
  if (def.cron) {
    s.cron = new Cron(def.cron, { timezone: def.timezone, protect: true }, fire);
  } else {
    const every = def.intervalMs!;
    s.nextRunAt = Date.now() + (def.firstRunAfterMs ?? every);
    const interval = setInterval(() => {
      s.nextRunAt = Date.now() + every;
      fire();
    }, every);
    interval.unref();
    s.timers.push(interval);
    if (def.firstRunAfterMs !== undefined) {
      const first = setTimeout(() => {
        s.nextRunAt = Date.now() + every - (def.firstRunAfterMs! % every);
        fire();
      }, def.firstRunAfterMs);
      first.unref();
      s.timers.push(first);
    }
  }
}

function unplan(s: JobState): void {
  for (const t of s.timers.splice(0)) clearTimeout(t);
  s.cron?.stop();
  s.cron = undefined;
  s.nextRunAt = undefined;
}

/** Plans every registered job (idempotent). */
export function startJobs(): void {
  if (started) return;
  started = true;
  for (const s of jobs.values()) plan(s);
  logger.info({ jobs: jobs.size }, 'background jobs started');
}

/** Stops planning new runs and waits (up to `waitMs`) for running ones; returns the names still running. */
export async function stopJobs(waitMs = 0): Promise<string[]> {
  started = false;
  for (const s of jobs.values()) unplan(s);
  const busy = () => [...jobs.values()].filter((s) => s.running);
  if (waitMs > 0 && busy().length) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(busy().map((s) => s.running)),
      new Promise((r) => {
        timer = setTimeout(r, waitMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }
  return busy().map((s) => s.def.name);
}

export const jobsStarted = (): boolean => started;

/**
 * Runs a job now. Returns false when it still runs (the start is skipped and counted). Resolves when the run ends
 * or its time limit is reached, whichever comes first.
 */
export async function runJob(name: string, trigger: 'schedule' | 'manual' = 'schedule'): Promise<boolean> {
  const s = jobs.get(name);
  if (!s) throw new HttpError(404, 'This background job does not exist', 'JOB_NOT_FOUND');
  if (s.running) {
    persist(name, 'UPDATE background_jobs SET skipped = skipped + 1 WHERE name = ?');
    logger.info({ job: name, runningSince: new Date(s.runningSince!).toISOString() }, 'background job still running: start skipped');
    return false;
  }
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  s.runningSince = t0;
  persist(name, 'UPDATE background_jobs SET last_started_at = ?, last_trigger = ?, runs = runs + 1 WHERE name = ?', startedAt, trigger);
  const ac = new AbortController();
  let settle!: () => void;
  s.running = new Promise<void>((r) => (settle = r));
  const work = (async () => s.def.run(ac.signal))();
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), s.def.timeoutMs);
    timer.unref();
  });
  const outcome = await Promise.race([
    work.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    limit,
  ]);
  clearTimeout(timer);
  const finish = (result: BackgroundJobResult, error: string | null) => {
    const ms = Date.now() - t0;
    const m = jobMetrics();
    m.duration.observe({ job: name }, ms / 1000);
    if (result === 'succeeded') m.lastSuccess.set({ job: name }, Date.now() / 1000);
    else m.failures.inc({ job: name });
    const at = nowIso();
    persist(
      name,
      `UPDATE background_jobs SET last_finished_at = ?, last_duration_ms = ?, last_result = ?, last_error = ?,
         last_success_at = CASE WHEN ? = 'succeeded' THEN ? ELSE last_success_at END,
         failures = failures + CASE WHEN ? = 'succeeded' THEN 0 ELSE 1 END WHERE name = ?`,
      at,
      ms,
      result,
      error ? error.slice(0, 2000) : null,
      result,
      at,
      result,
    );
  };
  if (outcome === 'timeout') {
    ac.abort();
    logger.warn({ job: name, timeoutMs: s.def.timeoutMs }, 'background job ran over its time limit');
    finish('timedOut', `Ran longer than ${Math.round(s.def.timeoutMs / 1000)} s`);
    // the overlap guard holds until the work has really ended
    void work
      .catch(() => undefined)
      .finally(() => {
        s.running = undefined;
        s.runningSince = undefined;
        settle();
      });
    return true;
  }
  if (outcome.ok) finish('succeeded', null);
  else {
    const message = (outcome.err as Error)?.message || String(outcome.err);
    logger.warn({ err: outcome.err, job: name }, 'background job failed');
    finish('failed', message);
  }
  s.running = undefined;
  s.runningSince = undefined;
  settle();
  return true;
}

/** "Run now" on System status (administrators; audited). Answers at once; the run goes on in the background. */
export function requestJobRun(name: string): { started: boolean } {
  const s = jobs.get(name);
  if (!s) throw new HttpError(404, 'This background job does not exist', 'JOB_NOT_FOUND');
  if (s.running) throw new HttpError(409, 'This background job is running already', 'JOB_RUNNING');
  audit({ action: 'job.run_requested', entityType: 'job', entityId: name, summary: `Background job "${name}" started by hand` });
  void runJob(name, 'manual').catch((err) => logger.warn({ err, job: name }, 'background job could not start'));
  return { started: true };
}

/** For tests and shutdown: wait until a job's current run has ended. */
export async function jobSettled(name: string): Promise<void> {
  await jobs.get(name)?.running;
}

export function listJobs(): BackgroundJob[] {
  let rows: JobRow[] = [];
  try {
    rows = db().all<JobRow>('SELECT * FROM background_jobs');
  } catch {
    /* shown without history */
  }
  const byName = new Map(rows.map((r) => [r.name, r]));
  return [...jobs.values()]
    .map((s): BackgroundJob => {
      const r = byName.get(s.def.name);
      const next = s.cron?.nextRun()?.getTime() ?? s.nextRunAt;
      return {
        name: s.def.name,
        everySeconds: s.def.intervalMs ? Math.round(s.def.intervalMs / 1000) : null,
        cron: s.def.cron ?? null,
        timeoutSeconds: Math.round(s.def.timeoutMs / 1000),
        running: !!s.running,
        runningSince: s.runningSince ? new Date(s.runningSince).toISOString() : null,
        lastStartedAt: r?.last_started_at ?? null,
        lastFinishedAt: r?.last_finished_at ?? null,
        lastDurationMs: r?.last_duration_ms ?? null,
        lastResult: r?.last_result ?? null,
        lastError: r?.last_error ?? null,
        lastSuccessAt: r?.last_success_at ?? null,
        lastTrigger: r?.last_trigger === 'manual' ? 'manual' : r?.last_trigger === 'schedule' ? 'schedule' : null,
        nextRunAt: started && next ? new Date(next).toISOString() : null,
        runs: Number(r?.runs ?? 0),
        failures: Number(r?.failures ?? 0),
        skipped: Number(r?.skipped ?? 0),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** For tests: forget every job (timers stopped). */
export function resetJobs(): void {
  for (const s of jobs.values()) unplan(s);
  jobs.clear();
  started = false;
}
