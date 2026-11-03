import type { NamedMigration } from '../db.js';

/**
 * Audit log growth (0.4.0): epochs, archives and retention (server/src/audit-archive.ts).
 *
 * The signed checkpoints are epoch boundaries. Closed epochs are exported as signed archive files (one per month of
 * checkpoints); audit_archives records each archive – its range, the signed checkpoint it ends at and the digest it
 * starts from – and, once a retention period deleted its entries from audit_log, from when. The newest archive whose
 * entries were deleted is where verification of the database starts (its signed checkpoint links to the first
 * remaining entry). The index on (action, seq) finds checkpoints without reading the whole log.
 */
export const AUDIT_MIGRATIONS: NamedMigration[] = [
  {
    name: 'audit-001-archives',
    sql: `
      CREATE TABLE audit_archives (
        id TEXT PRIMARY KEY,
        first_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        first_ts TEXT NOT NULL,
        last_ts TEXT NOT NULL,
        entries INTEGER NOT NULL,
        epochs INTEGER NOT NULL,
        start_hash TEXT NOT NULL,
        start_digest TEXT NOT NULL,
        checkpoint TEXT NOT NULL,
        file TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        remote_key TEXT,
        uploaded_at TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        prune_started_at TEXT,
        pruned_at TEXT,
        pruned_entries INTEGER
      );
      CREATE UNIQUE INDEX audit_archives_last ON audit_archives(last_seq);
      CREATE INDEX audit_action ON audit_log(action, seq);
    `,
  },
];
