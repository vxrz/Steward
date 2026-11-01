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
];
