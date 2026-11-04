import type { NamedMigration } from '../db.js';

/** The assurance policy (#210, auth/assurance.ts). Additive only. */
export const ASSURANCE_MIGRATIONS: NamedMigration[] = [
  {
    // Loosening the assurance policy waits for a second administrator (at most 7 days): the requested changes, who
    // asked and who decided. The policy itself is a sealed setting (assurance.policy); every version is in the audit log.
    // Sessions remember what the identity provider said at their last step-up (auth_time, amr, acr), so each confirmed
    // event can name it and a rule that requires multi-factor authentication can check it.
    name: 'assurance-001-policy',
    sql: `
      CREATE TABLE assurance_policy_changes (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_by_id TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        changes TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        decided_by TEXT,
        decided_at TEXT
      );
      CREATE INDEX assurance_policy_changes_status ON assurance_policy_changes(status);
      ALTER TABLE sessions ADD COLUMN step_up_detail TEXT;
    `,
  },
];
