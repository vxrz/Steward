import type { NamedMigration } from '../db.js';

/** Quiet hours and digests (0.10.0, ADR 0012), approvals from Microsoft Teams (ADR 0013) and personal Teams notifications (ADR 0025). Additive only. */
export const NOTIFICATION_MIGRATIONS: NamedMigration[] = [
  {
    // held messages per target (a person's e-mail, a Teams channel): the rendered text in the target's language, never a
    // channel URL or a secret; repeats of the same thing collapse into one open row. The catch-up and digest sends are
    // claimed per target and period before sending (like daily_summary_sends). Quiet hours and digests of a person.
    // The urgent flag of the notification policy of schedules and webhook triggers (monitor outputs: in the definition).
    name: 'notifications-002-quiet-hours',
    sql: `
      CREATE TABLE notification_outbox (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL,
        event TEXT NOT NULL,
        reason TEXT NOT NULL,
        locale TEXT NOT NULL,
        states TEXT NOT NULL,
        about TEXT,
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE UNIQUE INDEX notification_outbox_open ON notification_outbox(target, item_key, reason) WHERE released_at IS NULL;
      CREATE INDEX notification_outbox_target ON notification_outbox(target, released_at);
      CREATE TABLE notification_digest_sends (
        target TEXT NOT NULL,
        period TEXT NOT NULL,
        ts TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (target, period)
      );
      CREATE TABLE notification_prefs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        prefs TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE schedules ADD COLUMN notify_urgent INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE webhook_triggers ADD COLUMN notify_urgent INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // approvals from Microsoft Teams (ADR 0013). Stage 1: where a decision card was posted, so the outcome follows it.
    // Stage 2 (preview, off by default): the conversations the bot is installed in, the cards it posted (to update them),
    // the activity ids it saw (replays answer the same and change nothing), and how an MCP request was decided.
    name: 'notifications-003-teams-approvals',
    sql: `
      CREATE TABLE approval_posts (
        item_kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        target TEXT NOT NULL,
        posted_at TEXT NOT NULL,
        followed_up_at TEXT,
        PRIMARY KEY (item_kind, item_id, target)
      );
      CREATE TABLE teams_conversations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        service_url TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        installed_at TEXT NOT NULL,
        removed_at TEXT
      );
      CREATE UNIQUE INDEX teams_conversations_key ON teams_conversations(tenant_id, conversation_id);
      CREATE TABLE teams_cards (
        item_kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES teams_conversations(id) ON DELETE CASCADE,
        activity_id TEXT NOT NULL,
        version TEXT NOT NULL,
        posted_at TEXT NOT NULL,
        PRIMARY KEY (item_kind, item_id, conversation_id)
      );
      CREATE TABLE teams_bot_activities (
        activity_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        answer TEXT
      );
      ALTER TABLE mcp_requests ADD COLUMN decided_via TEXT;
    `,
  },
  {
    // personal Teams notifications through the bot (0.15.0, ADR 0025): the events a person chose for the bot's chat
    // (JSON array, nothing by default), and the Entra object id a personal chat was recorded for (it is used only while
    // the person is still linked to that id; NULL for chats recorded before)
    name: 'notifications-004-teams-personal',
    sql: `
      CREATE TABLE notification_personal_channels (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        teams TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE teams_conversations ADD COLUMN aad_object_id TEXT;
    `,
  },
  {
    // notifications a person turns on for themselves (0.18.0, ADR 0030): events that are off by default
    // (NOTIFICATION_OPT_IN_EVENTS, e.g. cost.booking_due); a row: the person opted in
    name: 'notifications-005-opt-ins',
    sql: `
      CREATE TABLE notification_opt_ins (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, event)
      );
    `,
  },
];
