import type { NamedMigration } from '../db.js';

/** Scheduled summary reports (server/src/reports/schedules.ts). */
export const REPORT_SCHEDULE_MIGRATIONS: NamedMigration[] = [
  {
    name: 'report-schedules-001',
    sql: `
      CREATE TABLE report_schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        preset TEXT NOT NULL,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        period_days INTEGER NOT NULL DEFAULT 7,
        lang TEXT NOT NULL DEFAULT 'en',
        classification TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        sections TEXT NOT NULL DEFAULT '{}',
        recipients TEXT NOT NULL DEFAULT '{}',
        attach_pdf INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT,
        last_report_id TEXT,
        last_error TEXT
      );
      -- generated reports remember their schedule (new column; rows stay immutable)
      ALTER TABLE reports ADD COLUMN schedule_id TEXT;
      CREATE INDEX reports_schedule ON reports(schedule_id, created_at);
    `,
  },
];
