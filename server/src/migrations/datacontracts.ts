import type { NamedMigration } from '../db.js';

/**
 * Data contracts (0.9.0, #221, docs/DATA-CONTRACTS.md): ODCS v3 contracts with every saved version (the YAML as it was
 * saved, its lint findings and its changes against the version before), their links to what Steward knows, and the
 * test runs of the data contract service with their full reports (evidence). Owning teams live in resource_teams
 * (kind "contract"). Additive only.
 */
export const DATA_CONTRACT_MIGRATIONS: NamedMigration[] = [
  {
    name: 'datacontracts-001-contracts',
    sql: `
      CREATE TABLE data_contracts (
        id TEXT PRIMARY KEY,
        contract_key TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        odcs_version TEXT NOT NULL DEFAULT '',
        current_version INTEGER NOT NULL,
        lint_errors INTEGER NOT NULL DEFAULT 0,
        service_platform_id TEXT,
        test_server TEXT,
        require_change_record INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX data_contracts_key ON data_contracts(contract_key);
      CREATE TABLE data_contract_versions (
        contract_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        odcs_version TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        yaml TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        lint TEXT NOT NULL DEFAULT '[]',
        lint_errors INTEGER NOT NULL DEFAULT 0,
        changes TEXT,
        change_count INTEGER NOT NULL DEFAULT 0,
        breaking_count INTEGER NOT NULL DEFAULT 0,
        change_record_id TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (contract_id, version)
      );
      CREATE TABLE data_contract_links (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_kind TEXT,
        detail TEXT,
        schema_name TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE INDEX data_contract_links_contract ON data_contract_links(contract_id);
      CREATE INDEX data_contract_links_target ON data_contract_links(kind, target_id);
      CREATE TABLE data_contract_runs (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        result TEXT NOT NULL,
        via TEXT NOT NULL,
        source_id TEXT,
        service_platform_id TEXT,
        server TEXT,
        checks_total INTEGER NOT NULL DEFAULT 0,
        checks_passed INTEGER NOT NULL DEFAULT 0,
        checks_warning INTEGER NOT NULL DEFAULT 0,
        checks_failed INTEGER NOT NULL DEFAULT 0,
        headline TEXT NOT NULL DEFAULT '',
        report TEXT NOT NULL,
        report_sha256 TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        dry_run INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        actor TEXT NOT NULL
      );
      CREATE INDEX data_contract_runs_contract ON data_contract_runs(contract_id, started_at);
    `,
  },
];
