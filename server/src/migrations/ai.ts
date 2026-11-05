import type { NamedMigration } from '../db.js';

/** AI models through LLM gateways (0.6.0, #216, server/src/ai/). Additive only. */
export const AI_MIGRATIONS: NamedMigration[] = [
  {
    // ai_usage: one row per call of a model – who, what, how many tokens, the result – never the prompt or the answer
    // (they stay in the run). A call reserves its worst case (estimated input + the most output) as a "pending" row
    // before it is sent, so parallel steps cannot overspend a budget; the row gets the real counts when the answer comes.
    // ai_budgets: tokens per day and month for the installation (scope_id ''), a gateway or a process.
    // ai_budget_notices: which 80 % and 100 % notices of a period went out (once each).
    name: 'ai-001-usage-and-budgets',
    sql: `
      CREATE TABLE ai_usage (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        day TEXT NOT NULL,
        month TEXT NOT NULL,
        process_id TEXT,
        process_name TEXT,
        process_version INTEGER,
        run_id TEXT,
        step_key TEXT,
        platform_id TEXT NOT NULL,
        platform_name TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        format TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        result TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        cost REAL,
        prompt_fingerprint TEXT NOT NULL DEFAULT '',
        input_fingerprint TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX ai_usage_platform_day ON ai_usage(platform_id, day);
      CREATE INDEX ai_usage_process_day ON ai_usage(process_id, day);
      CREATE INDEX ai_usage_month ON ai_usage(month, day);
      CREATE INDEX ai_usage_ts ON ai_usage(ts);
      CREATE TABLE ai_budgets (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        tokens_per_day INTEGER,
        tokens_per_month INTEGER,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id)
      );
      CREATE TABLE ai_budget_notices (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        period TEXT NOT NULL,
        level INTEGER NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id, period, level)
      );
    `,
  },
  {
    // parent_process_ids: the processes of the runs above a sub-process run (",p1,p2,"), so a process's budget also
    // covers the calls of its sub-processes
    name: 'ai-002-usage-parent-processes',
    sql: `ALTER TABLE ai_usage ADD COLUMN parent_process_ids TEXT NOT NULL DEFAULT '';`,
  },
];
