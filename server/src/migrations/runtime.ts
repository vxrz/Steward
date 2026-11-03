import type { NamedMigration } from '../db.js';

/**
 * Runtime robustness (0.4.0): on schedules the last cron fire, the fires missed while Steward was not running and
 * whether one catch-up run starts after a start (scheduler.ts).
 */
export const RUNTIME_MIGRATIONS: NamedMigration[] = [
  {
    name: 'runtime-001-schedule-missed-fires',
    sql: `
      ALTER TABLE schedules ADD COLUMN catch_up TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE schedules ADD COLUMN last_fired_at TEXT;
      ALTER TABLE schedules ADD COLUMN missed TEXT;`,
  },
];
