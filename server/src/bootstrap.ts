import { config } from './config.js';
import { logger } from './log.js';
import { engine } from './engine/index.js';
import * as scheduler from './scheduler.js';
import { startMonitorEngine, stopMonitorEngine } from './monitors/engine.js';
import { startGatusScraper, stopGatusScraper } from './gatus/metrics.js';
import { startReportSchedules, stopReportSchedules } from './reports/schedules.js';
import { startAccessChecks, stopAccessChecks } from './compliance/reconciliation.js';
import { startBackupJobs, stopBackupJobs } from './backup/service.js';
import { startJobs, stopJobs } from './jobs/registry.js';
import { closeAllPools } from './dbms/pool.js';
import { startEventLoopMonitor, stopEventLoopMonitor } from './eventloop.js';
import { isUnexpected, reportError } from './errorReporting.js';
import { lifecyclePhase, setLifecyclePhase, shuttingDown } from './lifecycle.js';

/**
 * Start-up and shutdown order of Steward's background work, in one place.
 *
 * startBackground() – when the HTTP server listens:
 *   1. event-loop monitor  2. background jobs (registered from features/ by main.ts)  3. scheduled backups
 * startUnlocked() – once, when the vault is unlocked (at start with SM_MASTER_PASSPHRASE[_FILE], or by a person):
 *   1. recovery of runs (resume waiting ones, mark running ones interrupted, re-queue queued ones)
 *   2. scheduler (records the fires missed while Steward was not running, starts catch-up runs)
 *   3. monitor engine  4. Gatus scraper  5. report schedules  6. access checks
 * shutdown() – SIGTERM/SIGINT (main.ts) and the desktop executable:
 *   1. not ready any more (/api/ready answers 503), no new runs (503 SHUTTING_DOWN) and no new scheduled fires
 *   2. report schedules, access checks, backups, background jobs, monitor engine and Gatus scraper stop
 *   3. up to SM_SHUTDOWN_GRACE_SECONDS (default 25) for running steps and jobs to end – runs waiting for a person
 *      are persisted and resume after the restart, so they are not waited for
 *   4. runs still running are marked interrupted (as recovery would do at the next start)
 * The caller (main.ts) then closes the HTTP server, flushes logs and error reports and releases the database lease.
 */

let unlockedStarted = false;

export function startBackground(): void {
  startEventLoopMonitor();
  // the jobs are registered by the entry point (main.ts: registerFeatureJobs() from the composition root, features/)
  startJobs();
  startBackupJobs();
  if (lifecyclePhase() === 'starting') setLifecyclePhase('running');
}

/** The services that need the decrypted vault; started once per unlock (stopUnlocked() when an administrator locks it). */
export async function startUnlocked(): Promise<void> {
  if (unlockedStarted || shuttingDown()) return;
  unlockedStarted = true;
  await engine().recover();
  scheduler.startScheduler();
  startMonitorEngine();
  startGatusScraper();
  startReportSchedules();
  startAccessChecks();
}

/** The vault was locked: no scheduled fires and no monitor checks until it is unlocked again (the rest stays). */
export function stopUnlocked(): void {
  scheduler.stopScheduler();
  void stopMonitorEngine();
  unlockedStarted = false;
}

export interface ShutdownReport {
  /** runs that ended (or began waiting) within the grace period */
  drained: number;
  /** runs marked interrupted */
  interrupted: string[];
  /** queued runs: they stay queued and start after the restart */
  queued: number;
  /** background jobs still running when the grace period ended */
  jobsRunning: string[];
  ms: number;
}

let stopping: Promise<ShutdownReport> | undefined;

/** Stops the background work (idempotent: a second call waits for the first). */
export function shutdown(graceMs = config.shutdownGraceMs): Promise<ShutdownReport> {
  stopping ??= doShutdown(graceMs);
  return stopping;
}

async function doShutdown(graceMs: number): Promise<ShutdownReport> {
  const t0 = Date.now();
  setLifecyclePhase('stopping');
  engine().stopAccepting();
  const counts = engine().counts();
  const busy = counts.busy;
  logger.info(
    { graceSeconds: Math.round(graceMs / 1000), runningRuns: busy.length, activeRuns: counts.active.length, queuedRuns: counts.queued.length },
    'shutting down: no new runs; waiting for running steps',
  );
  scheduler.stopScheduler();
  stopReportSchedules();
  stopAccessChecks();
  stopBackupJobs();
  const safely = async <T>(what: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      logger.warn({ err }, `shutdown: ${what} failed`);
      if (isUnexpected(err)) reportError(err, { tags: { phase: 'shutdown' } });
      return fallback;
    }
  };
  // the grace period is shared: runs, background jobs and running monitor checks end side by side
  const [left, jobsRunning] = await Promise.all([
    safely('waiting for runs', engine().drain(graceMs), engine().counts().busy),
    safely('stopping background jobs', stopJobs(graceMs), []),
    safely('stopping the monitor engine', stopMonitorEngine(), undefined),
  ]);
  stopGatusScraper();
  stopEventLoopMonitor();
  // database platforms (0.7.0): their pooled connections
  await safely('closing database connections', closeAllPools(), undefined);
  const interrupted = left.length ? engine().interruptBusy() : [];
  // the last moment the scheduler was alive: fires after it count as missed at the next start
  scheduler.recordAlive();
  setLifecyclePhase('stopped');
  const report: ShutdownReport = {
    drained: busy.length - interrupted.length,
    interrupted,
    queued: engine().counts().queued.length,
    jobsRunning,
    ms: Date.now() - t0,
  };
  logger[interrupted.length || jobsRunning.length ? 'warn' : 'info'](report, 'background work stopped');
  return report;
}

/** For tests: back to the state before shutdown() (does not restart anything). */
export function resetLifecycle(): void {
  setLifecyclePhase('starting');
  stopping = undefined;
  unlockedStarted = false;
}
