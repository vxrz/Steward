import type { NamedMigration } from '../db.js';

/**
 * OAuth sign-in for MCP clients (#12, mcp/oauth.ts): optional, off by default. Registered clients, one-time
 * authorization codes and the grants a person gave a client (with the hashes of its current access and refresh token).
 */
export const MCP_OAUTH_MIGRATIONS: NamedMigration[] = [
  {
    name: 'mcp-oauth-001',
    sql: `
      CREATE TABLE oauth_clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        registered_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE oauth_codes (
        hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        grant_id TEXT
      );
      CREATE TABLE oauth_grants (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        access_hash TEXT NOT NULL UNIQUE,
        access_expires_at TEXT NOT NULL,
        refresh_hash TEXT NOT NULL UNIQUE,
        previous_refresh_hash TEXT,
        refresh_expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX oauth_grants_user ON oauth_grants(user_id);
      CREATE INDEX oauth_grants_previous ON oauth_grants(previous_refresh_hash);
    `,
  },
];
