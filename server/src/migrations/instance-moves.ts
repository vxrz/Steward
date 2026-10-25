import type { NamedMigration } from '../db.js';
import { pgDdl } from '../database/sql.js';
import { immutableRowTriggers } from './records.js';

/** Imported audit history (migration packages from another Steward instance): never updated or deleted. */
export const IMMUTABLE_MOVE_TABLES = ['imported_audit_log'];

const DDL = `
      -- one row per imported migration package (see server/src/migration)
      CREATE TABLE instance_imports (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL UNIQUE,
        package_sha256 TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        imported_by TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        source_public_key TEXT NOT NULL,
        source_version TEXT NOT NULL,
        source_exported_at TEXT NOT NULL,
        source_exported_by TEXT NOT NULL,
        manifest TEXT NOT NULL,
        mapping TEXT NOT NULL,
        mapping_sha256 TEXT NOT NULL,
        counts TEXT NOT NULL,
        history_checkpoint TEXT NOT NULL,
        history_entries INTEGER NOT NULL
      );
      -- the source's audit log, unchanged: verifiable with the source's public key and signed checkpoint
      CREATE TABLE imported_audit_log (
        import_id TEXT NOT NULL REFERENCES instance_imports(id),
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        run_id TEXT,
        summary TEXT NOT NULL,
        details TEXT,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (import_id, seq)
      );
      CREATE INDEX imported_audit_run ON imported_audit_log(run_id);
      CREATE INDEX imported_audit_entity ON imported_audit_log(entity_type, entity_id);
      -- former names of imported users and teams: who a name in the imported history and in hashed content
      -- (process definitions, protocols) stands for on this instance
      CREATE TABLE identity_aliases (
        kind TEXT NOT NULL,
        alias TEXT NOT NULL,
        target_id TEXT NOT NULL,
        import_id TEXT NOT NULL REFERENCES instance_imports(id),
        PRIMARY KEY (kind, alias)
      );`;

/** Moving a local instance to a deployed one (#51): imports, imported audit history, identity aliases. */
export const MOVE_MIGRATIONS: NamedMigration[] = [
  {
    name: 'move-001-instance-imports',
    sql: `${DDL}
      ${IMMUTABLE_MOVE_TABLES.map((t) => immutableRowTriggers('sqlite', t).create).join('\n      ')}`,
    // record_evidence_immutable() comes from the records migrations (applied before this one)
    pg: `${pgDdl(DDL)}
      ${IMMUTABLE_MOVE_TABLES.map((t) => immutableRowTriggers('postgres', t).create).join('\n      ')}`,
  },
];
