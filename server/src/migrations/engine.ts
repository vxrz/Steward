import type { NamedMigration } from '../db.js';

/** Sub-processes, engine extras. */
export const ENGINE_MIGRATIONS: NamedMigration[] = [
  {
    // Sub-flows: child runs know their parent run and the parent's step (activation key);
    // `outputs` holds the evaluated definition outputs of a finished run.
    name: 'engine-001-parent-runs',
    sql: `
      ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
      ALTER TABLE runs ADD COLUMN parent_step_key TEXT;
      ALTER TABLE runs ADD COLUMN outputs TEXT;
      CREATE INDEX runs_parent ON runs(parent_run_id, parent_step_key);
    `,
  },
  {
    // Readiness probe: a one-row table the probe writes to (cheap proof the database is writable).
    name: 'engine-002-readiness-probe',
    sql: `CREATE TABLE engine_probe (id INTEGER PRIMARY KEY CHECK (id = 1), ts TEXT NOT NULL);`,
  },
];
