import type { NamedMigration } from '../db.js';

/** Webhook triggers (server/src/triggers). Portable DDL: translated for PostgreSQL by pgDdl(). */
export const TRIGGER_MIGRATIONS: NamedMigration[] = [
  {
    name: 'triggers-001-webhooks',
    sql: `
      CREATE TABLE webhook_triggers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        process_id TEXT NOT NULL,
        process_version INTEGER,
        owner TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        dry_run INTEGER NOT NULL DEFAULT 0,
        input_mapping TEXT NOT NULL DEFAULT '{}',
        bindings TEXT NOT NULL DEFAULT '{}',
        auth_mode TEXT NOT NULL DEFAULT 'token',
        -- the secret, encrypted with the vault key (needed to verify HMAC signatures) …
        secret_enc TEXT NOT NULL,
        -- … and its SHA-256 for constant-time comparison of static tokens
        secret_hash TEXT NOT NULL,
        secret_prefix TEXT NOT NULL,
        secret_rotated_at TEXT NOT NULL,
        allowed_cidrs TEXT NOT NULL DEFAULT '[]',
        allowed_headers TEXT NOT NULL DEFAULT '[]',
        rate_limit_per_min INTEGER NOT NULL DEFAULT 30,
        dedupe_seconds INTEGER NOT NULL DEFAULT 60,
        skip_if_running INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_fired_at TEXT,
        last_run_id TEXT,
        last_result TEXT,
        fire_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0,
        last_rejected_at TEXT,
        last_rejected_reason TEXT
      );
      CREATE INDEX webhook_triggers_process ON webhook_triggers(process_id);
      -- accepted calls (started or skipped runs); rejected calls are only counted
      CREATE TABLE webhook_trigger_fires (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        source_ip TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        run_id TEXT,
        test INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX webhook_trigger_fires_trigger ON webhook_trigger_fires(trigger_id, id);
      -- runs started by a webhook trigger remember it (the name survives deleting the trigger)
      ALTER TABLE runs ADD COLUMN trigger_id TEXT;
      ALTER TABLE runs ADD COLUMN trigger_name TEXT;
    `,
  },
];
