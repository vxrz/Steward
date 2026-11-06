import type { NamedMigration } from '../db.js';

/**
 * changedetection.io (0.9.0, #242): the watches of a changedetection.io platform as its components – metadata only
 * (title, URL, tags, state, times of the last check and change, the last error), never page contents – with their
 * optional links to an application, a service or a vendor; and the last read of each platform (who reads it in the
 * background). Additive only; nothing in the core tables changes.
 */
export const CHANGEDETECTION_MIGRATIONS: NamedMigration[] = [
  {
    name: 'changedetection-001-watches',
    sql: `
      CREATE TABLE cd_watches (
        platform_id TEXT NOT NULL,
        uuid TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        paused INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        last_changed_at TEXT,
        last_error TEXT,
        seen_at TEXT NOT NULL,
        removed_at TEXT,
        application_id TEXT,
        service_id TEXT,
        vendor TEXT NOT NULL DEFAULT '',
        linked_at TEXT,
        linked_by TEXT,
        PRIMARY KEY (platform_id, uuid)
      );
      CREATE INDEX cd_watches_application ON cd_watches(application_id);
      CREATE INDEX cd_watches_service ON cd_watches(service_id);
      CREATE TABLE cd_reads (
        platform_id TEXT PRIMARY KEY,
        read_at TEXT,
        read_by TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        error TEXT,
        total INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];
