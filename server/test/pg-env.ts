/**
 * Test database selection (vitest setup file, runs in every test process).
 *
 * - default: SQLite in each test server's temporary data directory
 * - SM_TEST_DATABASE_URL=postgres://…: PostgreSQL, every server gets its own schema
 *   (dropped after the run by test/pg-global.ts)
 *
 * A developer's own SM_DATABASE_* variables are never used by tests.
 */
import crypto from 'node:crypto';

export const PG_TEST_URL = process.env.SM_TEST_DATABASE_URL || undefined;

/** Environment for a server with its own, empty database (spread into a child process env). */
export function freshDbEnv(): Record<string, string> {
  if (!PG_TEST_URL) return {};
  const prefix = process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc';
  return { SM_DATABASE_URL: PG_TEST_URL, SM_DATABASE_SCHEMA: `${prefix}_${crypto.randomBytes(5).toString('hex')}` };
}

if (!process.env.SM_TEST_DB_ASSIGNED) {
  process.env.SM_TEST_DB_ASSIGNED = '1';
  delete process.env.SM_DATABASE_URL;
  delete process.env.SM_DATABASE_SCHEMA;
  delete process.env.SM_DATABASE_CA;
  Object.assign(process.env, freshDbEnv());
}
