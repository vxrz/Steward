import type { NamedMigration } from '../db.js';

/** The optional daily summary per user (server/src/notifications/summary.ts). */
export const DAILY_SUMMARY_MIGRATIONS: NamedMigration[] = [
  {
    name: 'notifications-001-daily-summary',
    sql: `
      CREATE TABLE daily_summary_prefs (
        user_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        prefs TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      -- one row per user and local day: claimed before sending, so a summary goes out at most once a day
      CREATE TABLE daily_summary_sends (
        user_id TEXT NOT NULL,
        day TEXT NOT NULL,
        ts TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'sent',
        PRIMARY KEY (user_id, day)
      );
    `,
  },
];
