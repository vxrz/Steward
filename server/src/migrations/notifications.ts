import type { NamedMigration } from '../db.js';

/** Quiet hours and digests (0.10.0, ADR 0012) and approvals from Microsoft Teams (ADR 0013). Additive only. */
export const NOTIFICATION_MIGRATIONS: NamedMigration[] = [
  {
    // held messages per target (a person's e-mail, a Teams channel): the rendered text in the target's language, never a
    // channel URL or a secret; repeats of the same thing collapse into one open row. The catch-up and digest sends are
    // claimed per target and period before sending (like daily_summary_sends). Quiet hours and digests of a person.
    // The urgent flag of the notification policy of schedules and webhook triggers (monitor outputs: in the definition).
    name: 'notifications-002-quiet-hours',
    sql: `
      CREATE TABLE notification_outbox (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL,
        event TEXT NOT NULL,
        reason TEXT NOT NULL,
        locale TEXT NOT NULL,
        states TEXT NOT NULL,
        about TEXT,
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE UNIQUE INDEX notification_outbox_open ON notification_outbox(target, item_key, reason) WHERE released_at IS NULL;
      CREATE INDEX notification_outbox_target ON notification_outbox(target, released_at);
      CREATE TABLE notification_digest_sends (
        target TEXT NOT NULL,
        period TEXT NOT NULL,
        ts TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (target, period)
      );
      CREATE TABLE notification_prefs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        prefs TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE schedules ADD COLUMN notify_urgent INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE webhook_triggers ADD COLUMN notify_urgent INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
