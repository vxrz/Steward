import type { NamedMigration } from '../db.js';

/** Credentials register (server/src/credentials). Documentation only – no column holds a secret value. */
export const CREDENTIAL_MIGRATIONS: NamedMigration[] = [
  {
    name: 'credentials-001-register',
    sql: `
      CREATE TABLE credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        platform_id TEXT,
        platform_text TEXT NOT NULL DEFAULT '',
        environment TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        used_by TEXT NOT NULL DEFAULT '{}',
        owners TEXT NOT NULL DEFAULT '[]',
        owner_subjects TEXT NOT NULL DEFAULT '[]',
        location_text TEXT NOT NULL DEFAULT '',
        location_url TEXT,
        issued_at TEXT,
        expires_at TEXT,
        rotation_interval_days INTEGER,
        last_rotated_at TEXT,
        review_interval_days INTEGER,
        last_reviewed_at TEXT,
        certificate TEXT,
        gatus_platform_id TEXT,
        gatus_endpoint_key TEXT,
        reminders TEXT,
        notes TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        archived INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX credentials_expires ON credentials(archived, expires_at);
      CREATE INDEX credentials_gatus ON credentials(gatus_platform_id, gatus_endpoint_key);

      -- history shown on the entry (the audit log has the same facts, chained)
      CREATE TABLE credential_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX credential_events_entry ON credential_events(credential_id, id);

      -- reminders already sent (one row per entry, due date and threshold: never sent twice, survives restarts)
      CREATE TABLE credential_reminders (
        credential_id TEXT NOT NULL,
        reminder_key TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (credential_id, reminder_key)
      );
    `,
  },
  {
    // #125: the roles and permissions a credential holds (JSON list of { role, scope, grantedAt, note })
    name: 'credentials-002-roles',
    sql: `ALTER TABLE credentials ADD COLUMN roles TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    // #143: a credential belongs to an application, a component or a system of the catalogue (the platform stays optional)
    name: 'credentials-003-belongs-to',
    sql: `
      ALTER TABLE credentials ADD COLUMN belongs_kind TEXT;
      ALTER TABLE credentials ADD COLUMN belongs_id TEXT;
      CREATE INDEX credentials_belongs ON credentials(belongs_kind, belongs_id);
    `,
  },
];
