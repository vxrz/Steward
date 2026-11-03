import type { NamedMigration } from '../db.js';

/**
 * Runtime robustness (0.4.0): on schedules the last cron fire, the fires missed while Steward was not running and
 * whether one catch-up run starts after a start (scheduler.ts); the state of the background jobs (jobs/registry.ts).
 */
export const RUNTIME_MIGRATIONS: NamedMigration[] = [
  {
    name: 'runtime-001-schedule-missed-fires',
    sql: `
      ALTER TABLE schedules ADD COLUMN catch_up TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE schedules ADD COLUMN last_fired_at TEXT;
      ALTER TABLE schedules ADD COLUMN missed TEXT;`,
  },
  {
    name: 'runtime-002-background-jobs',
    sql: `
      CREATE TABLE background_jobs (
        name TEXT PRIMARY KEY,
        last_started_at TEXT,
        last_finished_at TEXT,
        last_duration_ms INTEGER,
        last_result TEXT,
        last_error TEXT,
        last_success_at TEXT,
        last_trigger TEXT,
        runs INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0
      );`,
  },
];
