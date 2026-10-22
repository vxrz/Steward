import type { NamedMigration } from '../db.js';

/** Notifications, API tokens, maintenance. */
export const OPS_MIGRATIONS: NamedMigration[] = [
  {
    name: 'ops-001-notifications',
    sql: `
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      dedupe_key TEXT
    );
    CREATE INDEX notifications_user ON notifications(user_id, ts DESC);
    CREATE INDEX notifications_dedupe ON notifications(user_id, dedupe_key, ts);
    -- last external send per channel/event/entity (de-duplication window)
    CREATE TABLE notification_sends (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
    -- datasets already reported as stale (for the snapshot with this updated_at)
    CREATE TABLE notification_stale (dataset_key TEXT PRIMARY KEY, updated_at TEXT NOT NULL, notified_at TEXT NOT NULL);
    ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    name: 'ops-002-api-tokens',
    sql: `
    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      prefix TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX api_tokens_user ON api_tokens(user_id);
    `,
  },
  {
    // Preferred language per user (UI and notifications); NULL = not chosen, Settings.defaultLocale applies.
    name: 'ops-003-user-locale',
    sql: `ALTER TABLE users ADD COLUMN locale TEXT;`,
  },
];
