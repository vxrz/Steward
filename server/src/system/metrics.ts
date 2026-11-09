import { Gauge, type Registry } from 'prom-client';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { buildInfo } from '../buildinfo.js';
import { backupSettings } from '../backup/service.js';
import { readinessChecks } from './readiness.js';
import { sqliteSpace } from '../database/sqlite-space.js';

/**
 * Operations metrics (registered by metrics.ts; docs/METRICS.md), all read on each scrape:
 *   sm_build_info{version,commit}                                   1
 *   sm_vault_unlocked                                               1 unlocked, 0 locked or not set up
 *   sm_ready                                                        1 when GET /api/ready would answer 200
 *   sm_readiness_check{check}                                       the checks of /api/ready (vault, database, scheduler)
 *   sm_backup_enabled                                               1 when scheduled backups are on
 *   sm_backup_last_success_timestamp_seconds                        end of the last successful backup (0: none)
 *   sm_backup_last_failure_timestamp_seconds                        end of the last failed backup (0: none)
 *   sm_backup_last_size_bytes                                       size of the last successful backup (encrypted)
 *   sm_backup_restore_test_last_success_timestamp_seconds           the same for the restore test
 *   sm_backup_restore_test_last_failure_timestamp_seconds
 *   sm_db_size_bytes                                                the database (SQLite file and WAL; PostgreSQL schema)
 *   sm_db_free_bytes                                                SQLite: free pages inside the file (a VACUUM gives them back)
 * Alerts that use them: examples/prometheus/steward-alerts.yml.
 */
/** A value computed at most once a second: the gauges of one scrape share it. */
function perScrape<T>(fn: () => T): () => T {
  let at = 0;
  let value: T;
  return () => {
    if (Date.now() - at > 1000) {
      value = fn();
      at = Date.now();
    }
    return value;
  };
}

export function registerOpsMetrics(registry: Registry): void {
  const info = buildInfo();
  new Gauge({
    name: 'sm_build_info',
    help: 'The version and commit of the running server (always 1)',
    labelNames: ['version', 'commit'] as const,
    registers: [registry],
  }).set({ version: info.version, commit: info.commit ?? 'development' }, 1);
  new Gauge({
    name: 'sm_vault_unlocked',
    help: '1 when the vault is unlocked; 0 while it is locked or not set up (schedules, monitors and integrations wait)',
    registers: [registry],
    collect() {
      this.set(vault().unlocked ? 1 : 0);
    },
  });
  // one readiness evaluation per scrape for both gauges
  const readiness = perScrape(() => readinessChecks());
  new Gauge({
    name: 'sm_ready',
    help: '1 when the instance is ready (GET /api/ready: vault unlocked, database writable, schedules armed); 0 needs attention',
    registers: [registry],
    collect() {
      this.set(readiness().ready ? 1 : 0);
    },
  });
  new Gauge({
    name: 'sm_readiness_check',
    help: 'The checks behind sm_ready: 1 ok, 0 failing',
    labelNames: ['check'] as const,
    registers: [registry],
    collect() {
      for (const [check, c] of Object.entries(readiness().checks)) this.set({ check }, c.ok ? 1 : 0);
    },
  });

  // the newest finished backup runs, once per scrape
  const backupRuns = perScrape(() => {
    const runs = new Map<string, { at: number; bytes: number | null }>();
    for (const r of db().all<{ kind: string; status: string; finished_at: string | null; bytes: number | null }>(
      `SELECT b.kind, b.status, b.finished_at, b.bytes FROM backup_runs b
       WHERE b.status IN ('succeeded', 'failed') AND b.finished_at = (
         SELECT MAX(x.finished_at) FROM backup_runs x WHERE x.kind = b.kind AND x.status = b.status)`,
    ))
      runs.set(`${r.kind}:${r.status}`, {
        at: r.finished_at ? Math.floor(Date.parse(r.finished_at) / 1000) : 0,
        bytes: r.bytes === null ? null : Number(r.bytes),
      });
    return runs;
  });
  new Gauge({
    name: 'sm_backup_enabled',
    help: '1 when scheduled backups are on (Settings → Backups)',
    registers: [registry],
    collect() {
      this.set(backupSettings().enabled ? 1 : 0);
    },
  });
  const at = (name: string, help: string, key: string) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(backupRuns().get(key)?.at ?? 0);
      },
    });
  at('sm_backup_last_success_timestamp_seconds', 'Unix time the last successful backup ended (0: none)', 'backup:succeeded');
  at('sm_backup_last_failure_timestamp_seconds', 'Unix time the last failed backup ended (0: none)', 'backup:failed');
  new Gauge({
    name: 'sm_backup_last_size_bytes',
    help: 'Size of the last successful backup as uploaded (encrypted), in bytes (0: none)',
    registers: [registry],
    collect() {
      this.set(backupRuns().get('backup:succeeded')?.bytes ?? 0);
    },
  });
  at('sm_backup_restore_test_last_success_timestamp_seconds', 'Unix time the last successful restore test ended (0: none)', 'restore_test:succeeded');
  new Gauge({
    name: 'sm_db_size_bytes',
    help: 'Size of the database: the SQLite file and its WAL, or the tables and indexes of the PostgreSQL schema',
    registers: [registry],
    collect() {
      this.set(db().sizeBytes());
    },
  });
  new Gauge({
    name: 'sm_db_free_bytes',
    help: 'SQLite: free pages inside the database file, reused for new data (incremental auto-vacuum gives them back; 0 on PostgreSQL)',
    registers: [registry],
    collect() {
      const space = sqliteSpace(db());
      this.set(space ? space.freePages * space.pageSize : 0);
    },
  });
  at('sm_backup_restore_test_last_failure_timestamp_seconds', 'Unix time the last failed restore test ended (0: none)', 'restore_test:failed');
}
