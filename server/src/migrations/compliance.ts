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

/** Tables of compliance evidence whose rows are never deleted (a trigger refuses it; db:copy --force lifts it while replacing data). */
export const EVIDENCE_TABLES = ['access_snapshots', 'access_findings'];

export function noDeleteTrigger(dialect: 'sqlite' | 'postgres', table: string): { create: string; drop: string } {
  const name = `${table}_no_delete`;
  return dialect === 'sqlite'
    ? {
        create: `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table.replace(/_/g, ' ')} cannot be deleted'); END;`,
        drop: `DROP TRIGGER IF EXISTS ${name};`,
      }
    : {
        create: `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION access_evidence_no_delete();`,
        drop: `DROP TRIGGER IF EXISTS ${name} ON ${table};`,
      };
}

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
      ${EVIDENCE_TABLES.map((t) => noDeleteTrigger('sqlite', t).create).join('\n      ')}
    `,
    pg: `
      ALTER TABLE access_findings ADD COLUMN dismiss_requested_by TEXT;
      ALTER TABLE access_findings ADD COLUMN dismiss_requested_at TEXT;
      CREATE FUNCTION access_evidence_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION '% cannot be deleted', TG_TABLE_NAME; END $$;
      ${EVIDENCE_TABLES.map((t) => noDeleteTrigger('postgres', t).create).join('\n      ')}
    `,
  },
  {
    // person access reviews (#118): one person's rights on several platforms, decided and sealed
    name: 'compliance-003-person-reviews',
    sql: `
      CREATE TABLE person_reviews (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        person_user TEXT,
        person_name TEXT NOT NULL,
        identifiers TEXT NOT NULL DEFAULT '[]',
        sources TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        four_eyes INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        submitted_by TEXT,
        submitted_at TEXT,
        approved_by TEXT,
        approved_at TEXT,
        approval_comment TEXT NOT NULL DEFAULT '',
        closed_at TEXT,
        seal_hash TEXT
      );
      CREATE TABLE person_review_items (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        check_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        subject_name TEXT NOT NULL DEFAULT '',
        subject_type TEXT,
        right_name TEXT NOT NULL,
        decision TEXT,
        comment TEXT NOT NULL DEFAULT '',
        decided_by TEXT,
        decided_at TEXT,
        recheck TEXT,
        rechecked_at TEXT
      );
      CREATE INDEX person_review_items_review ON person_review_items(review_id, seq);
      CREATE INDEX person_reviews_created ON person_reviews(created_at);
    `,
  },
  {
    // corrective actions (ISO/IEC 27001 clause 10.2, ADR 0029 part 3): findings, their actions and reminders, and the
    // suggestions Steward makes from its own events (source_key unique: an event is suggested once). Kept at the end
    // of this list: migrations run by name in list order, so compliance-004-soa can go before or after it.
    name: 'compliance-005-corrective-actions',
    sql: `
      CREATE TABLE ca_findings (
        id TEXT PRIMARY KEY,
        number TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        source_kind TEXT,
        source_id TEXT,
        source_label TEXT NOT NULL DEFAULT '',
        service_id TEXT,
        supplier_id TEXT,
        control_ids TEXT NOT NULL DEFAULT '[]',
        record_id TEXT,
        severity TEXT NOT NULL,
        owner TEXT,
        due_date TEXT,
        cause TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        eff_method TEXT,
        eff_result TEXT,
        eff_note TEXT,
        eff_checked_by TEXT,
        eff_checked_at TEXT,
        grc_ref TEXT NOT NULL DEFAULT '',
        grc_url TEXT NOT NULL DEFAULT '',
        cancel_reason TEXT NOT NULL DEFAULT '',
        suggestion_id TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        closed_at TEXT,
        closed_by TEXT
      );
      CREATE INDEX ca_findings_status ON ca_findings(status, due_date);
      CREATE INDEX ca_findings_service ON ca_findings(service_id);
      CREATE INDEX ca_findings_record ON ca_findings(record_id);

      CREATE TABLE ca_actions (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL REFERENCES ca_findings(id),
        title TEXT NOT NULL,
        owners TEXT NOT NULL DEFAULT '[]',
        due_date TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        done_at TEXT,
        done_by TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX ca_actions_finding ON ca_actions(finding_id);
      CREATE INDEX ca_actions_open ON ca_actions(done_at, due_date);

      -- reminders sent, so each goes out once (also across restarts)
      CREATE TABLE ca_action_reminders (
        action_id TEXT NOT NULL,
        reminder_key TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (action_id, reminder_key)
      );

      CREATE TABLE ca_suggestions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_key TEXT NOT NULL UNIQUE,
        source_kind TEXT,
        source_id TEXT,
        source_label TEXT NOT NULL DEFAULT '',
        service_id TEXT,
        control_ids TEXT NOT NULL DEFAULT '[]',
        record_id TEXT,
        title TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        severity TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        reason TEXT NOT NULL DEFAULT '',
        finding_id TEXT
      );
      CREATE INDEX ca_suggestions_status ON ca_suggestions(status, created_at);
    `,
  },
  {
    // statement of applicability with a responsibility matrix per service (ISO/IEC 27001 clause 6.1.3 d, ADR 0029 part 2):
    // one SoA per control catalogue, its rows per control, its versions (frozen content and SHA-256, approval) and who
    // does six fixed areas of each service. Listed after compliance-005: migrations run in list order, and the list is
    // history (an upgraded and a fresh database must match).
    name: 'compliance-004-soa',
    sql: `
      CREATE TABLE soas (
        id TEXT PRIMARY KEY,
        catalogue_id TEXT NOT NULL UNIQUE,
        scope_name TEXT NOT NULL DEFAULT '',
        scope_service_ids TEXT NOT NULL DEFAULT '[]',
        four_eyes INTEGER NOT NULL DEFAULT 1,
        area_controls TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE soa_entries (
        id TEXT PRIMARY KEY,
        soa_id TEXT NOT NULL REFERENCES soas(id),
        control_id TEXT NOT NULL,
        applicable INTEGER,
        justification TEXT NOT NULL DEFAULT '',
        status TEXT,
        how_met TEXT NOT NULL DEFAULT '',
        party TEXT,
        supplier_id TEXT,
        central_name TEXT NOT NULL DEFAULT '',
        owner TEXT,
        reviewed_at TEXT,
        reviewed_by TEXT,
        grc_ref TEXT NOT NULL DEFAULT '',
        grc_url TEXT NOT NULL DEFAULT '',
        evidence_links TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        updated_by TEXT,
        UNIQUE (soa_id, control_id)
      );
      CREATE INDEX soa_entries_supplier ON soa_entries(supplier_id);

      CREATE TABLE soa_versions (
        id TEXT PRIMARY KEY,
        soa_id TEXT NOT NULL REFERENCES soas(id),
        number INTEGER NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        submitted_by TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        comment TEXT NOT NULL DEFAULT '',
        files TEXT NOT NULL DEFAULT '{}',
        UNIQUE (soa_id, number)
      );
      CREATE INDEX soa_versions_status ON soa_versions(soa_id, status);

      CREATE TABLE service_responsibilities (
        service_id TEXT NOT NULL,
        area TEXT NOT NULL,
        party TEXT NOT NULL,
        supplier_id TEXT,
        contract_id TEXT,
        central_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        duty_id TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (service_id, area)
      );
      CREATE INDEX service_responsibilities_supplier ON service_responsibilities(supplier_id);
    `,
  },
];
