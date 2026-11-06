import type { NamedMigration } from '../db.js';

/**
 * Database schemas (0.8.0, #222): snapshots of the schema of a database platform or a system (a read or a tbls
 * import), their changes against the snapshot before, and the settings per database (retention, scheduled reads).
 * Additive only; subjects are named by kind and id (platform / system), so nothing in the core tables changes.
 */
export const DBSCHEMA_MIGRATIONS: NamedMigration[] = [
  {
    name: 'dbschema-001-snapshots',
    sql: `
      CREATE TABLE db_schema_snapshots (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        source TEXT NOT NULL,
        taken_at TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        via TEXT NOT NULL DEFAULT 'ui',
        dialect TEXT NOT NULL,
        product TEXT,
        server_version TEXT,
        database_name TEXT,
        table_count INTEGER NOT NULL DEFAULT 0,
        column_count INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        file_name TEXT,
        content_hash TEXT NOT NULL,
        schema_doc TEXT NOT NULL,
        checks TEXT NOT NULL DEFAULT '[]',
        check_count INTEGER NOT NULL DEFAULT 0,
        previous_id TEXT,
        changes TEXT,
        change_count INTEGER NOT NULL DEFAULT 0,
        breaking_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX db_schema_snapshots_subject ON db_schema_snapshots(subject_kind, subject_id, taken_at);
      CREATE TABLE db_schema_settings (
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        retention INTEGER NOT NULL DEFAULT 30,
        read_interval_hours INTEGER NOT NULL DEFAULT 0,
        last_read_at TEXT,
        last_read_error TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (subject_kind, subject_id)
      );
    `,
  },
];
