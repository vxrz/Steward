import type { NamedMigration } from '../db.js';

/**
 * Platforms and their API specifications.
 * - platforms-001: the path prefix of an API specification (the path of its server URL, editable per spec). NULL for
 *   specs imported before: their prefix is derived from server_url when read (platforms/service.ts, specPrefix).
 */
export const PLATFORM_MIGRATIONS: NamedMigration[] = [
  {
    name: 'platforms-001-spec-path-prefix',
    sql: `ALTER TABLE platform_specs ADD COLUMN path_prefix TEXT;`,
  },
];
