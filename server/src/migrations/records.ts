import type { NamedMigration } from '../db.js';

/** Records, links and the service catalogue (server/src/records). Portable DDL: translated for PostgreSQL by pgDdl(). */
export const RECORD_MIGRATIONS: NamedMigration[] = [
  {
    name: 'records-001-core',
    sql: `
      CREATE TABLE record_types (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        workflow TEXT NOT NULL,
        template TEXT NOT NULL DEFAULT '',
        fields TEXT NOT NULL DEFAULT '[]',
        builtin INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      -- one counter per number prefix and year: CR-2026-0001 (seq = the last number given out)
      CREATE TABLE record_counters (
        prefix TEXT NOT NULL,
        year INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (prefix, year)
      );

      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        type_id TEXT NOT NULL REFERENCES record_types(id),
        number TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        fields TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        owner TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        frozen_hash TEXT,
        submitted_by TEXT,
        submitted_at TEXT,
        superseded_by TEXT,
        import_meta TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX records_type ON records(type_id, status);
      CREATE INDEX records_updated ON records(updated_at);

      -- every saved change of title, body or fields
      CREATE TABLE record_versions (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        fields TEXT NOT NULL,
        hash TEXT NOT NULL,
        author TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY (record_id, version)
      );

      -- transitions, approvals, comments, revisions
      CREATE TABLE record_events (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        action TEXT,
        from_status TEXT,
        to_status TEXT,
        actor TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        content_hash TEXT,
        version INTEGER,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX record_events_record ON record_events(record_id, created_at);

      CREATE TABLE record_attachments (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        path TEXT NOT NULL,
        revision INTEGER NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE INDEX record_attachments_record ON record_attachments(record_id, kind);

      -- generic links between items: from a record or service to an internal item ({ kind, id }) or an external URL
      CREATE TABLE item_links (
        id TEXT PRIMARY KEY,
        from_kind TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_kind TEXT,
        to_id TEXT,
        url TEXT,
        label TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE INDEX item_links_from ON item_links(from_kind, from_id);
      CREATE INDEX item_links_to ON item_links(to_kind, to_id);

      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        contacts TEXT NOT NULL DEFAULT '[]',
        owners TEXT NOT NULL DEFAULT '[]',
        criticality TEXT,
        cmdb_system TEXT,
        cmdb_id TEXT,
        cmdb_url TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
    `,
  },
  {
    // the field definitions (labels, kinds, options) of frozen content, taken when it is frozen
    name: 'records-002-version-field-defs',
    sql: `ALTER TABLE record_versions ADD COLUMN field_defs TEXT;`,
  },
  {
    // living documents (workflow "document"): approved editions, periodic reviews and their reminders
    name: 'records-003-documents',
    sql: `
      ALTER TABLE record_types ADD COLUMN review_interval_months INTEGER;

      -- the document state of a record of a "document" type (one row per document)
      CREATE TABLE record_documents (
        record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
        current_edition TEXT,
        pending_kind TEXT,
        pending_summary TEXT,
        review_owner TEXT,
        review_interval_months INTEGER,
        next_review_override TEXT,
        last_reviewed_at TEXT,
        last_reviewed_by TEXT,
        update_requested_at TEXT,
        updated_at TEXT NOT NULL
      );

      -- every approved edition, frozen: content, field definitions, attached files and the content hash
      CREATE TABLE record_editions (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        major INTEGER NOT NULL,
        minor INTEGER NOT NULL,
        edition TEXT NOT NULL,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        fields TEXT NOT NULL,
        field_defs TEXT NOT NULL,
        attachments TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        change_summary TEXT NOT NULL,
        authors TEXT NOT NULL,
        submitted_by TEXT,
        submitted_at TEXT,
        approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        PRIMARY KEY (record_id, major, minor)
      );
      CREATE INDEX record_editions_approved ON record_editions(approved_at);

      CREATE TABLE record_reviews (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        outcome TEXT NOT NULL,
        edition TEXT,
        reviewer TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        next_review_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX record_reviews_record ON record_reviews(record_id, created_at);

      -- review reminders sent (at most once per key: due date and threshold)
      CREATE TABLE record_review_reminders (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        reminder_key TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (record_id, reminder_key)
      );
    `,
  },
];
