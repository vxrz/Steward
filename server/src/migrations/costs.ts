import type { NamedMigration } from '../db.js';

/**
 * Platform costs (0.9.0, #226, docs/COSTS.md). Additive only.
 *
 * cost_records: one line per source line (a FOCUS subset), amounts as whole millionths of the currency (INTEGER, never
 *   a float) with their currency. `line_key` identifies a line within its source platform and source, so a re-read
 *   replaces it. `platform_id`, `component_id` and `application_id` are Steward's links (set by the mapping, again on
 *   every read); services and owning teams follow from the application when costs are shown.
 * cost_sources: per platform, whether its costs are read and how (tag key, Snowflake's price per credit, the currency of
 *   AI prices), and the last read.
 * cost_imports: FOCUS files imported (SHA-256, size, period, who, how).
 * cost_budgets / cost_budget_notices: a monthly budget per service, application or team; the 80 % and 100 % notices
 *   sent (once per budget, month and level).
 * cost_push_tokens: push tokens of the FOCUS import from CI (hashes only), modelled on db_schema_push_tokens.
 * scorecard_snapshots.costs: the scorecard part "Costs" of a day.
 *
 * 0.16.0 (ADR 0026, service cost planning):
 * cost_plan_lines: what a service plans to spend in a fiscal year (`fiscal_year`: the calendar year it starts in) –
 *   title, category, what it is for (`target_kind`/`target_id`: an application or system of the service, or a
 *   platform; `vendor` free text), amount (micros) and currency, cadence (`once_index`: the month of a one-off payment
 *   as its position 0–11 in the fiscal year), renewal date, note.
 * cost_entries: what a service incurred – date, amount (micros, negative for a credit) and currency, the plan line
 *   (none: unplanned), what it is for, a reference (invoice or order number), a note. No hours: effort is not planned.
 */
export const COSTS_MIGRATIONS: NamedMigration[] = [
  {
    name: 'costs-001-records-budgets-imports',
    sql: `
      CREATE TABLE cost_records (
        id TEXT PRIMARY KEY,
        source_platform_id TEXT NOT NULL,
        source TEXT NOT NULL,
        line_key TEXT NOT NULL,
        granularity TEXT NOT NULL,
        billing_period_start TEXT NOT NULL,
        billing_period_end TEXT NOT NULL,
        charge_period_start TEXT NOT NULL,
        charge_period_end TEXT NOT NULL,
        month TEXT NOT NULL,
        billed_cost INTEGER NOT NULL,
        effective_cost INTEGER NOT NULL,
        billing_currency TEXT NOT NULL,
        provider_name TEXT NOT NULL DEFAULT '',
        service_name TEXT NOT NULL DEFAULT '',
        service_category TEXT NOT NULL DEFAULT '',
        resource_id TEXT NOT NULL DEFAULT '',
        resource_name TEXT NOT NULL DEFAULT '',
        sub_account_id TEXT NOT NULL DEFAULT '',
        charge_category TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '{}',
        platform_id TEXT NOT NULL,
        component_id TEXT,
        application_id TEXT,
        import_id TEXT,
        read_at TEXT NOT NULL,
        corrected_at TEXT
      );
      CREATE UNIQUE INDEX cost_records_line ON cost_records(source_platform_id, source, line_key);
      CREATE INDEX cost_records_month ON cost_records(month);
      CREATE INDEX cost_records_application ON cost_records(application_id, month);
      CREATE INDEX cost_records_platform ON cost_records(platform_id, month);
      CREATE INDEX cost_records_source ON cost_records(source_platform_id, source, charge_period_start);

      CREATE TABLE cost_sources (
        platform_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        tag_key TEXT NOT NULL DEFAULT 'application',
        credit_price TEXT,
        credit_currency TEXT,
        currency TEXT,
        last_read_at TEXT,
        last_read_error TEXT,
        last_read_note TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE cost_imports (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL,
        file_name TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        period_start TEXT,
        period_end TEXT,
        mode TEXT NOT NULL,
        via TEXT NOT NULL,
        token_id TEXT,
        actor TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE INDEX cost_imports_platform ON cost_imports(platform_id, imported_at);
      CREATE INDEX cost_imports_sha ON cost_imports(platform_id, sha256);

      CREATE TABLE cost_budgets (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id)
      );
      CREATE TABLE cost_budget_notices (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        month TEXT NOT NULL,
        level INTEGER NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id, month, level)
      );

      CREATE TABLE cost_push_tokens (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        allowed_cidrs TEXT NOT NULL DEFAULT '[]',
        rate_limit_per_minute INTEGER NOT NULL DEFAULT 6,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        rotated_at TEXT,
        last_used_at TEXT,
        last_used_ip TEXT,
        revoked_at TEXT,
        revoked_by TEXT
      );
      CREATE INDEX cost_push_tokens_platform ON cost_push_tokens(platform_id);

      ALTER TABLE scorecard_snapshots ADD COLUMN costs TEXT;
    `,
  },
  {
    name: 'costs-002-service-plans',
    sql: `
      CREATE TABLE cost_plan_lines (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        fiscal_year INTEGER NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT,
        vendor TEXT NOT NULL DEFAULT '',
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        cadence TEXT NOT NULL,
        once_index INTEGER,
        renewal_date TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX cost_plan_lines_service ON cost_plan_lines(service_id, fiscal_year);

      CREATE TABLE cost_entries (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        entry_date TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        plan_line_id TEXT,
        target_kind TEXT,
        target_id TEXT,
        reference TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX cost_entries_service ON cost_entries(service_id, entry_date);
      CREATE INDEX cost_entries_line ON cost_entries(plan_line_id);
    `,
  },
];
