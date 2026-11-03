import type { NamedMigration } from '../db.js';

/** Duplicating things (0.4.0). Additive only. */
export const DUPLICATE_MIGRATIONS: NamedMigration[] = [
  {
    // where a copy came from: one row per copy (kind as in DUPLICATE_KINDS); the original's name is kept for when it is gone
    name: 'duplicates-001-copied-from',
    sql: `
      CREATE TABLE copied_from (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
    `,
  },
  {
    // a maintenance window can be disabled (a copy starts so): it neither applies nor announces anything until enabled
    name: 'duplicates-002-maintenance-enabled',
    sql: `ALTER TABLE maintenance_windows ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;`,
  },
];
