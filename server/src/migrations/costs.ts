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
 *
 * 0.18.0 (ADR 0030, contract payments, commitments and recorded costs):
 * costs-003-contract-payments:
 *   cost_schedules: payment schedules of supplier contracts – the paying service, title, category and target, the
 *     amount per payment in contract year 1 (micros) and currency, billing (monthly, quarterly, yearly, once, dates),
 *     the first payment, start and end (null: the contract's), amounts of contract years 2–10 (`year_amounts`, JSON
 *     micros), dated payments (`payments`, JSON: date, amount, covers until), a note.
 *   cost_plan_lines: `from_index`/`to_index` (positions 0–11 of the months a line covers; null: the whole year),
 *     `schedule_id` and `schedule_part` (the schedule and the contract-year part or payment a line was made from),
 *     `schedule_basis` (JSON: the twelve month amounts it was made from, to see when the contract changed),
 *     `covers_from`/`covers_to` (the days a prepaid payment covers). The cadence "quarterly" needs no column.
 * costs-004-entry-imports:
 *   cost_entries: `supplier_id`, `supplier_contract_id` and `import_id` (the CSV import it came from); an index on
 *     (service_id, reference) for the duplicate check of imports.
 *   cost_entry_imports: CSV imports of entries – file name, SHA-256, rows, added, skipped by reason, the mapping, who
 *     and when, and who removed its entries and when.
 *   cost_booking_reminders: the reminders "contract payments not booked" sent, once per service and month.
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
  {
    name: 'costs-003-contract-payments',
    sql: `
      CREATE TABLE cost_schedules (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        target_kind TEXT,
        target_id TEXT,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        billing TEXT NOT NULL,
        first_payment_on TEXT,
        starts_on TEXT,
        ends_on TEXT,
        year_amounts TEXT NOT NULL DEFAULT '[]',
        payments TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX cost_schedules_contract ON cost_schedules(contract_id);
      CREATE INDEX cost_schedules_service ON cost_schedules(service_id);

      ALTER TABLE cost_plan_lines ADD COLUMN from_index INTEGER;
      ALTER TABLE cost_plan_lines ADD COLUMN to_index INTEGER;
      ALTER TABLE cost_plan_lines ADD COLUMN schedule_id TEXT;
      ALTER TABLE cost_plan_lines ADD COLUMN schedule_part TEXT;
      ALTER TABLE cost_plan_lines ADD COLUMN schedule_basis TEXT;
      ALTER TABLE cost_plan_lines ADD COLUMN covers_from TEXT;
      ALTER TABLE cost_plan_lines ADD COLUMN covers_to TEXT;
      CREATE INDEX cost_plan_lines_schedule ON cost_plan_lines(schedule_id);
    `,
  },
  {
    name: 'costs-004-entry-imports',
    sql: `
      ALTER TABLE cost_entries ADD COLUMN supplier_id TEXT;
      ALTER TABLE cost_entries ADD COLUMN supplier_contract_id TEXT;
      ALTER TABLE cost_entries ADD COLUMN import_id TEXT;
      CREATE INDEX cost_entries_reference ON cost_entries(service_id, reference);
      CREATE INDEX cost_entries_supplier ON cost_entries(supplier_id);
      CREATE INDEX cost_entries_import ON cost_entries(import_id);

      CREATE TABLE cost_entry_imports (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        file_name TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL,
        rows INTEGER NOT NULL,
        added INTEGER NOT NULL,
        skipped TEXT NOT NULL DEFAULT '{}',
        mapping TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        removed_at TEXT,
        removed_by TEXT
      );
      CREATE INDEX cost_entry_imports_service ON cost_entry_imports(service_id, created_at);
      CREATE INDEX cost_entry_imports_sha ON cost_entry_imports(service_id, sha256);

      CREATE TABLE cost_booking_reminders (
        service_id TEXT NOT NULL,
        month TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (service_id, month)
      );
    `,
  },
];
