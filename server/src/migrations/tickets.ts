import type { NamedMigration } from '../db.js';

/** Ticket references (server/src/tickets). */
export const TICKET_MIGRATIONS: NamedMigration[] = [
  {
    name: 'tickets-001-references',
    sql: `
      CREATE TABLE ticket_refs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        external_number TEXT NOT NULL,
        external_url TEXT,
        title TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        vendor TEXT NOT NULL DEFAULT '',
        responsible TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        resolved_at TEXT,
        last_checked_at TEXT,
        reminder_days INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX ticket_refs_status ON ticket_refs(status, opened_at);
      CREATE INDEX ticket_refs_number ON ticket_refs(source, external_number);

      -- history shown on the entry (status changes, checks, reminders); the audit log has the same facts, chained
      CREATE TABLE ticket_ref_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        comment TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX ticket_ref_events_entry ON ticket_ref_events(ticket_id, id);

      -- "not checked for N days" reminders already sent (never twice, survives restarts)
      CREATE TABLE ticket_ref_reminders (
        ticket_id TEXT NOT NULL,
        reminder_key TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (ticket_id, reminder_key)
      );
    `,
  },
];
