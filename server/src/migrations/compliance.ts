import type { NamedMigration } from '../db.js';
import { pgDdl } from '../database/sql.js';

/** Access governance evidence (server/src/compliance). Portable DDL: translated for PostgreSQL by pgDdl(). */

const CORE = `
  -- access changes a run reported (accessChange steps); turned into access change entries when the run ends
  CREATE TABLE run_access_changes (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    platform_id TEXT,
    data TEXT NOT NULL,
    record_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX run_access_changes_run ON run_access_changes(run_id);

  CREATE TABLE access_checks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    platform_id TEXT NOT NULL,
    source TEXT NOT NULL,
    dataset_key TEXT,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    owner TEXT NOT NULL,
    notify TEXT NOT NULL DEFAULT '[]',
    ignore_rights TEXT NOT NULL DEFAULT '[]',
    last_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    last_snapshot_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  -- who had which access when: never updated; data is stored once per change (same_as points to the stored copy)
  CREATE TABLE access_snapshots (
    id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    taken_at TEXT NOT NULL,
    taken_by TEXT NOT NULL,
    trigger TEXT NOT NULL,
    subject_count INTEGER NOT NULL,
    assignment_count INTEGER NOT NULL,
    hash TEXT NOT NULL,
    prev_chain_hash TEXT,
    chain_hash TEXT NOT NULL,
    data TEXT,
    same_as TEXT,
    source_run_id TEXT,
    UNIQUE (check_id, seq)
  );
  CREATE INDEX access_snapshots_check ON access_snapshots(check_id, taken_at);

  CREATE TABLE access_findings (
    id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    prev_snapshot_id TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    window_from TEXT NOT NULL,
    window_to TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    granted TEXT NOT NULL DEFAULT '[]',
    revoked TEXT NOT NULL DEFAULT '[]',
    rights_before TEXT NOT NULL DEFAULT '[]',
    rights_after TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    record_id TEXT,
    resolved_by TEXT,
    resolved_at TEXT,
    comment TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX access_findings_check ON access_findings(check_id, status);
  CREATE INDEX access_findings_platform ON access_findings(platform_id, status);

  CREATE TABLE control_catalogues (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE controls (
    id TEXT PRIMARY KEY,
    catalogue_id TEXT NOT NULL REFERENCES control_catalogues(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    UNIQUE (catalogue_id, ref)
  );

  CREATE TABLE control_tags (
    control_id TEXT NOT NULL REFERENCES controls(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (control_id, kind, target_id)
  );
  CREATE INDEX control_tags_target ON control_tags(kind, target_id);

  CREATE TABLE evidence_packs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scope TEXT NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    status TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    expires_at TEXT NOT NULL,
    path TEXT,
    size INTEGER,
    sha256 TEXT,
    file_count INTEGER,
    error TEXT
  );
  CREATE INDEX evidence_packs_created ON evidence_packs(created_by, created_at);
`;

export const COMPLIANCE_MIGRATIONS: NamedMigration[] = [
  {
    name: 'compliance-001-core',
    sql: `${CORE}
      CREATE TRIGGER access_snapshots_immutable BEFORE UPDATE ON access_snapshots
        BEGIN SELECT RAISE(ABORT, 'access snapshots are immutable'); END;
    `,
    pg: `${pgDdl(CORE)}
      CREATE FUNCTION access_snapshots_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'access snapshots are immutable'; END $$;
      CREATE TRIGGER access_snapshots_immutable BEFORE UPDATE ON access_snapshots FOR EACH ROW EXECUTE FUNCTION access_snapshots_immutable();
    `,
  },
  {
    // four-eyes dismissals of findings; snapshots and findings are evidence: never deleted (defence in depth –
    // the verification compares them with the authentic audit entries as well)
    name: 'compliance-002-governance',
    sql: `
      ALTER TABLE access_findings ADD COLUMN dismiss_requested_by TEXT;
      ALTER TABLE access_findings ADD COLUMN dismiss_requested_at TEXT;
      CREATE TRIGGER access_snapshots_no_delete BEFORE DELETE ON access_snapshots
        BEGIN SELECT RAISE(ABORT, 'access snapshots cannot be deleted'); END;
      CREATE TRIGGER access_findings_no_delete BEFORE DELETE ON access_findings
        BEGIN SELECT RAISE(ABORT, 'access findings cannot be deleted'); END;
    `,
    pg: `
      ALTER TABLE access_findings ADD COLUMN dismiss_requested_by TEXT;
      ALTER TABLE access_findings ADD COLUMN dismiss_requested_at TEXT;
      CREATE FUNCTION access_evidence_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION '% cannot be deleted', TG_TABLE_NAME; END $$;
      CREATE TRIGGER access_snapshots_no_delete BEFORE DELETE ON access_snapshots FOR EACH ROW EXECUTE FUNCTION access_evidence_no_delete();
      CREATE TRIGGER access_findings_no_delete BEFORE DELETE ON access_findings FOR EACH ROW EXECUTE FUNCTION access_evidence_no_delete();
    `,
  },
];
