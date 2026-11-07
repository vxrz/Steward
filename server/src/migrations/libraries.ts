import type { NamedMigration } from '../db.js';

/** Shared procedure libraries (0.10.0, #238, ADR 0014): trusted publishers and their keys, releases, installs. Portable DDL. */
export const LIBRARY_MIGRATIONS: NamedMigration[] = [
  {
    name: 'libraries-001-publishers-releases',
    sql: `
      -- a publisher an administrator trusts; mac: seal over the library list (vault integrity key)
      CREATE TABLE library_publishers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        contact TEXT NOT NULL DEFAULT '',
        libraries TEXT NOT NULL DEFAULT '[]',
        mac TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- its public keys (OpenSSH lines); mac: seal over publisher, key, state and expiry
      CREATE TABLE library_keys (
        id TEXT PRIMARY KEY,
        publisher_id TEXT NOT NULL,
        key_line TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'active',
        expires_at TEXT,
        revoked_reason TEXT,
        mac TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        changed_by TEXT,
        changed_at TEXT
      );
      CREATE UNIQUE INDEX library_keys_fingerprint ON library_keys(fingerprint);
      CREATE INDEX library_keys_publisher ON library_keys(publisher_id);
      -- verified releases with their files (Steward's own copy: rollback re-verifies it)
      CREATE TABLE library_releases (
        id TEXT PRIMARY KEY,
        library TEXT NOT NULL,
        publisher_id TEXT NOT NULL,
        release_version TEXT NOT NULL,
        name TEXT NOT NULL,
        steward_min_version TEXT NOT NULL,
        release_sha256 TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        source TEXT NOT NULL,
        manifest TEXT NOT NULL,
        files TEXT NOT NULL,
        state TEXT NOT NULL,
        staged_at TEXT NOT NULL,
        staged_by TEXT NOT NULL,
        installed_at TEXT,
        installed_by TEXT,
        -- four-eyes (control point library.install): the install a first person asked for, waiting for a second
        install_request TEXT
      );
      CREATE UNIQUE INDEX library_releases_version ON library_releases(library, release_version);
      CREATE INDEX library_releases_state ON library_releases(state, library);
      -- one row per installed library: its publisher (bound on first install), the release, the reference mapping
      CREATE TABLE library_installs (
        library TEXT PRIMARY KEY,
        publisher_id TEXT NOT NULL,
        release_id TEXT NOT NULL,
        previous_release_id TEXT,
        reference_map TEXT NOT NULL DEFAULT '{}',
        skipped TEXT NOT NULL DEFAULT '[]',
        held INTEGER NOT NULL DEFAULT 0,
        hold_state TEXT,
        held_by TEXT,
        held_at TEXT,
        installed_at TEXT NOT NULL,
        installed_by TEXT NOT NULL
      );
    `,
  },
  {
    // a Git sync source follows a library's version tags (mode 'library'); items remember the library release they
    // came from; a process version remembers its library (JSON, NULL for local versions)
    name: 'gitsync-004-library-mode',
    sql: `
      ALTER TABLE sync_sources ADD COLUMN mode TEXT NOT NULL DEFAULT 'items';
      ALTER TABLE sync_sources ADD COLUMN allow_prereleases INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sync_sources ADD COLUMN newest_seen TEXT;
      ALTER TABLE sync_items ADD COLUMN release_id TEXT;
      ALTER TABLE process_versions ADD COLUMN origin TEXT;
    `,
  },
];
