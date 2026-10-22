import type { NamedMigration } from '../db.js';

/** Git sync (server/src/sync): sources, pending updates and the origin of synced items. Portable DDL. */
export const GITSYNC_MIGRATIONS: NamedMigration[] = [
  {
    name: 'gitsync-001-sources',
    sql: `
      CREATE TABLE sync_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        api_url TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL,
        folder TEXT NOT NULL DEFAULT '',
        kinds TEXT NOT NULL DEFAULT '[]',
        -- access token for the Git host API, encrypted with the vault key (optional: public repositories)
        token_enc TEXT,
        interval_minutes INTEGER NOT NULL DEFAULT 0,
        webhook_enabled INTEGER NOT NULL DEFAULT 0,
        -- webhook secret: encrypted (HMAC signatures) and hashed (static tokens, GitLab)
        webhook_secret_enc TEXT,
        webhook_secret_hash TEXT,
        webhook_secret_prefix TEXT,
        require_signed INTEGER NOT NULL DEFAULT 0,
        auto_accept_new INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_fetch_at TEXT,
        last_commit TEXT,
        last_status TEXT,
        last_error TEXT,
        last_verified INTEGER
      );
      -- incoming files waiting for (or after) a decision
      CREATE TABLE sync_updates (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        kind TEXT,
        path TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        commit_verified INTEGER,
        blob_sha TEXT NOT NULL,
        -- the id/key the file stands for (new items get it)
        identity TEXT,
        entity_id TEXT,
        entity_name TEXT,
        action TEXT NOT NULL,
        conflict INTEGER NOT NULL DEFAULT 0,
        conflict_reason TEXT,
        status TEXT NOT NULL,
        errors TEXT NOT NULL DEFAULT '[]',
        content TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        comment TEXT,
        result_version INTEGER
      );
      CREATE INDEX sync_updates_source ON sync_updates(source_id, status);
      CREATE INDEX sync_updates_status ON sync_updates(status, created_at);
      -- where a Steward item came from (one source per item)
      CREATE TABLE sync_items (
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        blob_sha TEXT NOT NULL,
        -- hash of the incoming content last applied, and of the local item right after applying it
        source_hash TEXT NOT NULL,
        local_hash TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        applied_by TEXT NOT NULL,
        PRIMARY KEY (kind, entity_id)
      );
      CREATE INDEX sync_items_source ON sync_items(source_id, path);
    `,
  },
];
