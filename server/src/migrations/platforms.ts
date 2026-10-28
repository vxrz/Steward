import type { NamedMigration } from '../db.js';

/**
 * Platforms and their API specifications.
 * - platforms-002: recorded responses for test runs (#105).
 * - platforms-001: the path prefix of an API specification (the path of its server URL, editable per spec). NULL for
 *   specs imported before: their prefix is derived from server_url when read (platforms/service.ts, specPrefix).
 */
export const PLATFORM_MIGRATIONS: NamedMigration[] = [
  {
    name: 'platforms-001-spec-path-prefix',
    sql: `ALTER TABLE platform_specs ADD COLUMN path_prefix TEXT;`,
  },
  {
    // Recorded responses (#105): answers that test runs use instead of the platform
    name: 'platforms-002-recordings',
    sql: `
      CREATE TABLE platform_recordings (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        query TEXT NOT NULL DEFAULT '{}',
        body_match TEXT,
        status INTEGER NOT NULL,
        headers TEXT NOT NULL DEFAULT '{}',
        body TEXT,
        note TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX platform_recordings_platform ON platform_recordings(platform_id, method);
    `,
  },
];
