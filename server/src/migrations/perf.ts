import type { NamedMigration } from '../db.js';

/** Indexes for list filters, the home dashboard, retention and foreign-key cascades. */
export const PERF_MIGRATIONS: NamedMigration[] = [
  {
    name: 'perf-001-indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS runs_status ON runs(status, started_at);
      CREATE INDEX IF NOT EXISTS runs_status_finished ON runs(status, finished_at);
      CREATE INDEX IF NOT EXISTS runs_schedule ON runs(schedule_id, started_at);
      CREATE INDEX IF NOT EXISTS run_steps_type_status ON run_steps(type, status, finished_at);
      CREATE INDEX IF NOT EXISTS run_tasks_status_created ON run_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS run_tasks_created ON run_tasks(created_at);
      CREATE INDEX IF NOT EXISTS run_artifacts_run ON run_artifacts(run_id);
    `,
  },
];
