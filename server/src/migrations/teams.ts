import type { NamedMigration } from '../db.js';

/** Team-scoped access (#131). Additive only: without owning teams, every resource keeps the visibility it had. */
export const TEAM_MIGRATIONS: NamedMigration[] = [
  {
    // roles a member has in the team (JSON array of roles; NULL = none beyond their instance roles), and the
    // owning teams of any resource by kind and id (one row per team)
    name: 'teams-001-scopes',
    sql: `
      ALTER TABLE team_members ADD COLUMN roles TEXT;
      CREATE TABLE resource_teams (
        kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, resource_id, team_id)
      );
      CREATE INDEX resource_teams_team ON resource_teams(team_id);
    `,
  },
  {
    // team settings (#136): the team's own channel for messages about its resources (JSON; NULL = the instance's), its
    // URL encrypted with the vault (NULL = none)
    name: 'teams-002-settings',
    sql: `
      CREATE TABLE team_settings (
        team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        channel TEXT,
        channel_secret TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
    `,
  },
  {
    // team defaults (#136): JSON { newResources, summary, branding } (NULL = the instance's), the team's report logo
    // (base64, NULL = the instance logo), the member's own choice of team for new resources, and the team of a report
    // schedule (a subjects array, ["team:<name>"], so renames and migration packages map it like other team references)
    name: 'teams-003-defaults',
    sql: `
      ALTER TABLE team_settings ADD COLUMN defaults TEXT;
      ALTER TABLE team_settings ADD COLUMN logo TEXT;
      ALTER TABLE team_members ADD COLUMN new_resources INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE report_schedules ADD COLUMN team TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    // review 0.20.0: a user's teams are read on every request (owning teams, auth/policy.ts); the primary key
    // (team_id, user_id) cannot find them by user
    name: 'teams-004-member-index',
    sql: `
      CREATE INDEX IF NOT EXISTS team_members_user ON team_members(user_id);
    `,
  },
  {
    // shares (0.21.0, ADR 0033): one subject (user:, team: or role: – the subject strings used everywhere else, lower
    // case) given a level (view, edit, manage) and the kind's action rights (JSON array) on one resource, with an
    // optional end date (at most a year ahead) and when its Manage holders were reminded of it. resource_restrictions:
    // the resources whose scope is Restricted – instance roles give nothing there, only shares (and owning teams)
    name: 'teams-005-shares',
    sql: `
      CREATE TABLE resource_shares (
        kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        level TEXT NOT NULL,
        actions TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        reminded_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, resource_id, subject)
      );
      CREATE INDEX resource_shares_subject ON resource_shares(subject);
      CREATE INDEX resource_shares_expires ON resource_shares(expires_at);
      CREATE TABLE resource_restrictions (
        kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, resource_id)
      );
    `,
  },
];
