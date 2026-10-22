import type { NamedMigration } from '../db.js';

/** Monitors (server/src/monitors). Portable DDL: translated for PostgreSQL by pgDdl(). */
export const MONITOR_MIGRATIONS: NamedMigration[] = [
  {
    name: 'monitors-001-core',
    sql: `
      -- current definition (changes are recorded in the audit log)
      CREATE TABLE monitors (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        acl TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        is_template INTEGER NOT NULL DEFAULT 0,
        template_id TEXT,
        template_version INTEGER,
        template_params TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX monitors_template ON monitors(template_id);

      -- aggregated status per monitor
      CREATE TABLE monitor_state (
        monitor_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'unknown',
        since TEXT,
        root_causes TEXT NOT NULL DEFAULT '[]',
        last_evaluated_at TEXT,
        ack_by TEXT,
        ack_at TEXT,
        ack_comment TEXT
      );

      -- per check: status after flapping control, counters, last result, heartbeat secret
      CREATE TABLE monitor_checks (
        monitor_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        since TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_successes INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        last_ok_at TEXT,
        last_result TEXT,
        caused_by TEXT NOT NULL DEFAULT '[]',
        note TEXT,
        hook_id TEXT UNIQUE,
        heartbeat_key TEXT,
        secret_enc TEXT,
        secret_hash TEXT,
        secret_prefix TEXT,
        secret_rotated_at TEXT,
        last_push_at TEXT,
        last_push TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (monitor_id, check_id)
      );
      CREATE INDEX monitor_checks_key ON monitor_checks(heartbeat_key);

      -- status changes (check_id '' = the monitor itself)
      CREATE TABLE monitor_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        status TEXT NOT NULL,
        previous TEXT,
        message TEXT NOT NULL DEFAULT '',
        caused_by TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX monitor_history_check ON monitor_history(monitor_id, check_id, id);
      CREATE INDEX monitor_history_ts ON monitor_history(ts);

      -- hourly samples for uptime: evaluations that were ok (up/degraded), down, or neither
      CREATE TABLE monitor_samples (
        monitor_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        bucket TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        down INTEGER NOT NULL DEFAULT 0,
        other INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (monitor_id, check_id, bucket)
      );
      CREATE INDEX monitor_samples_bucket ON monitor_samples(bucket);

      -- the latest raw results per check (bounded)
      CREATE TABLE monitor_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        value TEXT
      );
      CREATE INDEX monitor_results_check ON monitor_results(monitor_id, check_id, id);

      CREATE TABLE monitor_maintenance (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX monitor_maintenance_monitor ON monitor_maintenance(monitor_id, ends_at);

      -- de-duplication of outputs (subject '' = the monitor itself)
      CREATE TABLE monitor_output_state (
        monitor_id TEXT NOT NULL,
        output_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        last_status TEXT,
        last_sent_at TEXT,
        last_error TEXT,
        last_run_id TEXT,
        PRIMARY KEY (monitor_id, output_id, subject)
      );

      -- gateways reporting many heartbeat checks in one call
      CREATE TABLE monitor_gateways (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        auth_mode TEXT NOT NULL DEFAULT 'token',
        secret_enc TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        secret_prefix TEXT NOT NULL,
        secret_rotated_at TEXT NOT NULL,
        allowed_cidrs TEXT NOT NULL DEFAULT '[]',
        allowed_keys TEXT NOT NULL DEFAULT '[]',
        rate_limit_per_min INTEGER NOT NULL DEFAULT 120,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];
