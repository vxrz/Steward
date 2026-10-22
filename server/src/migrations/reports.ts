import type { NamedMigration } from '../db.js';
import { pgDdl } from '../database/sql.js';

/** Archived PDF reports. */
const REPORTS_TABLE = `
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
`;

export const REPORT_MIGRATIONS: NamedMigration[] = [
  {
    // One row per generated PDF (never updated: a new generation is a new row and a new file).
    // Retention deletes rows and files together with their run.
    name: 'reports-001-generated-reports',
    sql: `${REPORTS_TABLE}
    CREATE TRIGGER reports_immutable BEFORE UPDATE ON reports
      BEGIN SELECT RAISE(ABORT, 'generated reports are immutable'); END;
    `,
    pg: `${pgDdl(REPORTS_TABLE)}
    CREATE FUNCTION reports_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'generated reports are immutable'; END $$;
    CREATE TRIGGER reports_immutable BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION reports_immutable();
    `,
  },
];
