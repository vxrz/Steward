import type { NamedMigration } from '../db.js';

/** Archived PDF reports. */
export const REPORT_MIGRATIONS: NamedMigration[] = [
  {
    // One row per generated PDF (never updated: a new generation is a new row and a new file).
    // Retention deletes rows and files together with their run.
    name: 'reports-001-generated-reports',
    sql: `
    CREATE TABLE reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      run_id TEXT,
      process_ids TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      lang TEXT NOT NULL,
      comment TEXT,
      classification TEXT NOT NULL DEFAULT '',
      interim INTEGER NOT NULL DEFAULT 0,
      auto INTEGER NOT NULL DEFAULT 0,
      period_from TEXT,
      period_to TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      path TEXT NOT NULL,
      filename TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      protocol_hash TEXT,
      content_hash TEXT NOT NULL
    );
    CREATE INDEX reports_run ON reports(run_id, created_at);
    CREATE INDEX reports_kind ON reports(kind, created_at);
    CREATE TRIGGER reports_immutable BEFORE UPDATE ON reports
      BEGIN SELECT RAISE(ABORT, 'generated reports are immutable'); END;
    `,
  },
];
