import fs from 'node:fs';
import path from 'node:path';
import type { MaintenanceStatus } from '@sm/shared';
import { config } from './config.js';
import { db } from './db.js';
import { audit } from './audit.js';
import { logger } from './log.js';
import { getSettings, readSetting, writeSetting } from './settings.js';
import { deleteMonitorDataBefore } from './monitors/retention.js';
import { pruneGatusData } from './gatus/metrics.js';
import { runArchiving } from './audit-archive.js';

/**
 * Retention: removes finished runs (with steps, logs, tasks and artifacts) and
 * read notifications after the configured number of days – in small batches with
 * a turn for the event loop in between, so a large cleanup does not block requests.
 * The audit log keeps the history of deleted runs; its own retention (archived
 * entries, off by default) is audit-archive.ts, run from here once a day.
 */
type LastCleanup = NonNullable<MaintenanceStatus['lastCleanup']>;

const LAST_KEY = 'maintenance.lastCleanup';
const FINISHED = ['succeeded', 'failed', 'cancelled'];
const DAY_MS = 86400000;

const artifactsDir = () => path.join(config.dataDir, 'artifacts');
const reportsDir = () => path.join(config.dataDir, 'reports');

function fileSize(f: string): number {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fileSize(p);
  }
  return total;
}

export function maintenanceStatus(): MaintenanceStatus {
  const runs = db().get<{ n: number; oldest: string | null }>('SELECT COUNT(*) AS n, MIN(started_at) AS oldest FROM runs')!;
  return {
    databaseBytes: db().sizeBytes(),
    artifactBytes: dirSize(artifactsDir()),
    runs: runs.n,
    oldestRun: runs.oldest,
    auditEntries: db().get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')!.n,
    lastCleanup: readSetting<LastCleanup | null>(LAST_KEY, null),
  };
}

/** Only removes paths inside `root`. */
function removeInside(root: string, target: string): void {
  const rel = path.relative(root, path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function deleteRunFiles(runId: string, artifactPaths: string[]): void {
  try {
    for (const p of artifactPaths) removeInside(artifactsDir(), p);
    removeInside(artifactsDir(), path.join(artifactsDir(), runId));
    for (const f of fs.existsSync(reportsDir()) ? fs.readdirSync(reportsDir()) : []) {
      // reports/<runId>/ holds the run's generated PDFs (see reports/service.ts)
      if (f === runId || f.startsWith(runId + '.') || f.startsWith(runId + '-')) removeInside(reportsDir(), path.join(reportsDir(), f));
    }
  } catch (err) {
    logger.warn({ err, runId }, 'could not remove run files');
  }
}

/** Rows per statement (each its own transaction); the event loop gets a turn in between, so requests are served. */
export const DELETE_BATCH = 500;
/** Runs per round */
const RUN_BATCH = 50;
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Deletes the rows of `table` matching `where` in batches of DELETE_BATCH (by its `id`), yielding in between. */
export async function deleteInBatches(table: string, where: string, params: unknown[]): Promise<number> {
  let n = 0;
  for (;;) {
    const c = db().run(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${where} LIMIT ${DELETE_BATCH})`, ...params).changes;
    n += c;
    if (c < DELETE_BATCH) return n;
    await turn();
  }
}

/** A run's rows, children first (evidence before its tasks); generated reports go with their run. */
const RUN_TABLES = ['run_artifacts', 'run_task_evidence', 'run_tasks', 'run_logs', 'run_steps', 'reports'];

/** Deletes finished runs that ended before `cutoff`, in small batches (a large cleanup does not block requests). */
export async function deleteRunsBefore(cutoff: string): Promise<{ runs: number; artifacts: number }> {
  let runs = 0;
  let artifacts = 0;
  const statusList = FINISHED.map(() => '?').join(',');
  for (;;) {
    const ids = db()
      .all<{ id: string }>(
        `SELECT id FROM runs WHERE status IN (${statusList}) AND finished_at IS NOT NULL AND finished_at < ? ORDER BY finished_at LIMIT ?`,
        ...FINISHED,
        cutoff,
        RUN_BATCH,
      )
      .map((r) => r.id);
    if (!ids.length) break;
    for (const id of ids) {
      const paths = db()
        .all<{ path: string }>('SELECT path FROM run_artifacts WHERE run_id = ?', id)
        .map((r) => r.path);
      // Generated PDF reports go with their run (files below); the audit log keeps their report.generated entries.
      for (const t of RUN_TABLES) await deleteInBatches(t, 'run_id = ?', [id]);
      db().run('DELETE FROM runs WHERE id = ?', id);
      deleteRunFiles(id, paths);
      artifacts += paths.length;
      runs++;
      await turn();
    }
    if (ids.length < RUN_BATCH) break;
  }
  return { runs, artifacts };
}

let running = false;

export async function runCleanup(opts: { manual?: boolean } = {}): Promise<LastCleanup> {
  if (running) throw new Error('A cleanup is already running');
  running = true;
  try {
    const s = getSettings();
    const now = Date.now();
    const removed = s.retentionRunDays > 0 ? await deleteRunsBefore(new Date(now - s.retentionRunDays * DAY_MS).toISOString()) : { runs: 0, artifacts: 0 };
    const notificationsDeleted =
      s.retentionNotificationDays > 0
        ? await deleteInBatches('notifications', 'read = 1 AND ts < ?', [new Date(now - s.retentionNotificationDays * DAY_MS).toISOString()])
        : 0;
    const monitorDays = s.retentionMonitorDays ?? 30;
    const monitorData = monitorDays > 0 ? deleteMonitorDataBefore(new Date(now - monitorDays * DAY_MS).toISOString()) : null;
    // Gatus metrics: per source (rawRetentionDays / retentionDays)
    let gatusData: ReturnType<typeof pruneGatusData> | null = null;
    try {
      gatusData = pruneGatusData(now);
    } catch (err) {
      logger.warn({ err }, 'Gatus metrics retention failed');
    }
    // the audit log: closed epochs archived, archived entries past the audit retention deleted (off by default)
    let auditArchive: Awaited<ReturnType<typeof runArchiving>> | null = null;
    try {
      auditArchive = await runArchiving({ by: opts.manual ? undefined : 'system' });
    } catch (err) {
      logger.warn({ err }, 'audit archiving failed');
    }
    const result: LastCleanup = {
      at: new Date(now).toISOString(),
      runsDeleted: removed.runs,
      artifactsDeleted: removed.artifacts,
      notificationsDeleted,
      ...(auditArchive && (auditArchive.archived.length || auditArchive.deleted)
        ? { auditArchived: auditArchive.archived.length, auditEntriesDeleted: auditArchive.deleted }
        : {}),
    };
    if (removed.runs) db().compact();
    writeSetting(LAST_KEY, result);
    if (opts.manual || removed.runs || notificationsDeleted) {
      audit({
        actor: opts.manual ? undefined : 'system',
        action: 'maintenance.cleanup',
        entityType: 'maintenance',
        summary: `Cleanup: ${removed.runs} run(s) older than ${s.retentionRunDays || '–'} days, ${removed.artifacts} artifact(s) and ${notificationsDeleted} read notification(s) deleted`,
        details: {
          ...result,
          retentionRunDays: s.retentionRunDays,
          retentionNotificationDays: s.retentionNotificationDays,
          retentionMonitorDays: monitorDays,
          monitorData,
          gatusData,
        },
      });
    }
    logger.info(result, 'maintenance cleanup finished');
    return result;
  } finally {
    running = false;
  }
}

let timers: NodeJS.Timeout[] = [];

/** Cleanup one minute after start, then daily. */
export function startMaintenanceJobs(): void {
  if (timers.length) return;
  const safe = () => {
    runCleanup().catch((err: unknown) => logger.warn({ err }, 'maintenance cleanup failed'));
  };
  timers = [setTimeout(safe, 60000), setInterval(safe, DAY_MS)];
  for (const t of timers) t.unref();
}

export function stopMaintenanceJobs(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}
