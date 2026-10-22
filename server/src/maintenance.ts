import fs from 'node:fs';
import path from 'node:path';
import type { MaintenanceStatus } from '@sm/shared';
import { config } from './config.js';
import { db } from './db.js';
import { audit } from './audit.js';
import { logger } from './log.js';
import { getSettings, readSetting, writeSetting } from './settings.js';
import { deleteReadOlderThan } from './notifications/store.js';

/**
 * Retention: removes finished runs (with steps, logs, tasks and artifacts) and
 * read notifications after the configured number of days. The audit log is
 * never touched – it keeps the history of deleted runs.
 */
type LastCleanup = NonNullable<MaintenanceStatus['lastCleanup']>;

const LAST_KEY = 'maintenance.lastCleanup';
const FINISHED = ['succeeded', 'failed', 'cancelled'];
const BATCH = 200;
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
      if (f.startsWith(runId)) removeInside(reportsDir(), path.join(reportsDir(), f));
    }
  } catch (err) {
    logger.warn({ err, runId }, 'could not remove run files');
  }
}

/** Deletes finished runs that ended before `cutoff`. Returns counts. */
export function deleteRunsBefore(cutoff: string): { runs: number; artifacts: number } {
  let runs = 0;
  let artifacts = 0;
  const statusList = FINISHED.map(() => '?').join(',');
  for (;;) {
    const ids = db()
      .all<{ id: string }>(
        `SELECT id FROM runs WHERE status IN (${statusList}) AND finished_at IS NOT NULL AND finished_at < ? ORDER BY finished_at LIMIT ?`,
        ...FINISHED,
        cutoff,
        BATCH,
      )
      .map((r) => r.id);
    if (!ids.length) break;
    const files = new Map<string, string[]>();
    db().tx(() => {
      for (const id of ids) {
        const paths = db().all<{ path: string }>('SELECT path FROM run_artifacts WHERE run_id = ?', id).map((r) => r.path);
        files.set(id, paths);
        artifacts += paths.length;
        for (const t of ['run_artifacts', 'run_tasks', 'run_logs', 'run_steps']) db().run(`DELETE FROM ${t} WHERE run_id = ?`, id);
        db().run('DELETE FROM runs WHERE id = ?', id);
      }
    });
    runs += ids.length;
    for (const [id, paths] of files) deleteRunFiles(id, paths);
    if (ids.length < BATCH) break;
  }
  return { runs, artifacts };
}

let running = false;

export function runCleanup(opts: { manual?: boolean } = {}): LastCleanup {
  if (running) throw new Error('A cleanup is already running');
  running = true;
  try {
    const s = getSettings();
    const now = Date.now();
    const removed = s.retentionRunDays > 0 ? deleteRunsBefore(new Date(now - s.retentionRunDays * DAY_MS).toISOString()) : { runs: 0, artifacts: 0 };
    const notificationsDeleted = s.retentionNotificationDays > 0 ? deleteReadOlderThan(s.retentionNotificationDays) : 0;
    const result: LastCleanup = { at: new Date(now).toISOString(), runsDeleted: removed.runs, artifactsDeleted: removed.artifacts, notificationsDeleted };
    if (removed.runs) db().compact();
    writeSetting(LAST_KEY, result);
    if (opts.manual || removed.runs || notificationsDeleted) {
      audit({
        actor: opts.manual ? undefined : 'system',
        action: 'maintenance.cleanup',
        entityType: 'maintenance',
        summary: `Cleanup: ${removed.runs} run(s) older than ${s.retentionRunDays || '–'} days, ${removed.artifacts} artifact(s) and ${notificationsDeleted} read notification(s) deleted`,
        details: { ...result, retentionRunDays: s.retentionRunDays, retentionNotificationDays: s.retentionNotificationDays },
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
    try {
      runCleanup();
    } catch (err) {
      logger.warn({ err }, 'maintenance cleanup failed');
    }
  };
  timers = [setTimeout(safe, 60000), setInterval(safe, DAY_MS)];
  for (const t of timers) t.unref();
}

export function stopMaintenanceJobs(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}
