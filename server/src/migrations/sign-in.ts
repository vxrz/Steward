import type { NamedMigration } from '../db.js';

/** Sign-in: emergency access from the server's command line (break-glass when single sign-on fails), account fields from claims. */
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
  {
    // Single sign-on claims (#77): first and last name, read-only profile fields from the provider (JSON list of
    // { key, label, value }) and the issuer + sub of the linked identity, which bridges a change of the stable id claims
    // at the next sign-in. Provider settings are not touched here: they are sealed (config_mac), and settings a
    // provider was saved without are read with today's behaviour (auth/sso-claims.ts withDefaults).
    name: 'signin-002-sso-claims',
    sql: `
      ALTER TABLE users ADD COLUMN first_name TEXT;
      ALTER TABLE users ADD COLUMN last_name TEXT;
      ALTER TABLE users ADD COLUMN profile TEXT;
      ALTER TABLE users ADD COLUMN external_sub TEXT;
      CREATE INDEX users_external_sub ON users(external_sub);
    `,
  },
  {
    // Step-up re-authentication (#14): when and how this session last confirmed it is its owner (the password again, a
    // fresh single sign-on, or the sign-in itself). Sensitive actions need a confirmation within SM_STEP_UP_MINUTES.
    name: 'signin-003-step-up',
    sql: `
      ALTER TABLE sessions ADD COLUMN step_up_at TEXT;
      ALTER TABLE sessions ADD COLUMN step_up_method TEXT;
    `,
  },
];
