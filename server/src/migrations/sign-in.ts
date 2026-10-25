import type { NamedMigration } from '../db.js';

/** Sign-in: emergency access from the server's command line (break-glass when single sign-on fails). */
export const SIGN_IN_MIGRATIONS: NamedMigration[] = [
  {
    // One-time codes created by `steward admin emergency-access`: only the SHA-256 of the code is stored.
    // A code opens one session for one administrator, once, within its window. Sessions remember how they
    // were opened (password, single sign-on, emergency) so the sign-in policy applies to them while they last.
    name: 'signin-001-emergency-access',
    sql: `
      CREATE TABLE emergency_access_grants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        nonce TEXT UNIQUE,
        issued_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        used_ip TEXT,
        revoked_at TEXT
      );
      CREATE INDEX emergency_access_grants_user ON emergency_access_grants(user_id);
      ALTER TABLE sessions ADD COLUMN method TEXT;
      ALTER TABLE sessions ADD COLUMN emergency_grant_id TEXT;
    `,
  },
];
