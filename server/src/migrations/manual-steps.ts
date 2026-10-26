import type { NamedMigration } from '../db.js';

/**
 * Manual steps (#83): what the person entered, the second-person verification and the evidence files.
 * Existing tasks keep NULL / the defaults and behave as before.
 */
export const MANUAL_STEP_MIGRATIONS: NamedMigration[] = [
  {
    name: 'manual-001-steps',
    sql: `
      -- the step's settings, copied when the run reached it (JSON, ManualTaskSpec without the verifiers)
      ALTER TABLE run_tasks ADD COLUMN manual TEXT;
      -- who may verify (JSON array of user:/team:/role: subjects; mapped when an instance is moved)
      ALTER TABLE run_tasks ADD COLUMN verifiers TEXT NOT NULL DEFAULT '[]';
      -- work | verify | done (NULL for select and approve tasks)
      ALTER TABLE run_tasks ADD COLUMN stage TEXT;
      ALTER TABLE run_tasks ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
      -- the current round's entry (JSON ManualSubmission) and who made it
      ALTER TABLE run_tasks ADD COLUMN submission TEXT;
      ALTER TABLE run_tasks ADD COLUMN completed_by TEXT;
      ALTER TABLE run_tasks ADD COLUMN completed_at TEXT;
      -- the second person's verification (JSON ManualVerification)
      ALTER TABLE run_tasks ADD COLUMN verification TEXT;
      ALTER TABLE run_tasks ADD COLUMN verified_by TEXT;
      ALTER TABLE run_tasks ADD COLUMN verified_at TEXT;
      -- earlier rounds a verifier sent back (JSON array)
      ALTER TABLE run_tasks ADD COLUMN returned TEXT NOT NULL DEFAULT '[]';

      -- evidence files of manual steps, stored read-only below <data>/artifacts/<run id>/evidence/
      CREATE TABLE run_task_evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES run_tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_key TEXT NOT NULL,
        round INTEGER NOT NULL,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        path TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        uploaded_at TEXT NOT NULL
      );
      CREATE INDEX run_task_evidence_task ON run_task_evidence(task_id, uploaded_at);
      CREATE INDEX run_task_evidence_run ON run_task_evidence(run_id);
    `,
  },
];
