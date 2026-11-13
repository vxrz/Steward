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
 *
 * 0.19.0 (ADR 0032, cost attribution, platform cost plans and volume contracts):
 * costs-005-platform-plans-volumes:
 *   cost_plan_lines, cost_entries, cost_schedules, cost_entry_imports: `platform_id` – a platform's own cost plan. A
 *     row of a platform has `service_id` '' (the column stays NOT NULL) and its platform in `platform_id`; a service's
 *     row keeps `platform_id` null. cost_booking_reminders keeps the plan's owner (a service or a platform) in
 *     `service_id` – ids of both kinds never collide.
 *   cost_schedules: the billing "volume" – `volume_per` (year: a volume per contract year; term: one for the whole
 *     term), `volume_billing` (prepaid: paid up front and drawn down; byUse: billed from what is used),
 *     `volume_committed` (full, minimum, none), the minimum as an amount (`volume_minimum`, micros) or a percentage
 *     (`volume_minimum_pct`), and where the use comes from (`volume_consumption`: entries or read costs).
 *   cost_entries: an index on (supplier_contract_id, entry_date) for the use of a volume.
 *   cost_volume_notices: the volume warnings sent, once per schedule, period and kind.
 *
 * 0.21.0 (ADR 0035, price books, cost drivers and calculators – phase 1):
 * costs-006-price-books:
 *   cost_price_books: a book of item prices – name, kind (list, contracted), provider (free text), the platform,
 *     supplier and contract it belongs to, currency, its source and settings, the review interval and the last check,
 *     the current version; `base_book_id` and `derivation` stay empty until derived books (phase 2).
 *   cost_price_book_versions: immutable versions – number, SHA-256 of the normalised entries, count, the difference to
 *     the version before (JSON), how it came to be (manual, csv, migration), who and when.
 *   cost_price_items: the entries of a version – SKU, price id, name, service, category, driver, unit, charge, the
 *     price as a decimal string per block, its currency or credit item, tiers (JSON), included, minimum, validity,
 *     attributes (JSON). An index on (version_id, sku_id): a calculation reads a book with one statement.
 *   cost_price_review_notices: "Prices to review" sent, once per book and due date.
 *   cost_fx_rates: manual exchange rates – date, base, quote, the rate as a decimal string, source, who and when.
 *   The Snowflake fallback's price per credit (cost_sources.credit_price) becomes the entry `compute-credit` of the
 *   platform's contracted book, as version 1 (decision 15); cost_sources keeps its columns.
 * costs-007-calculators-estimates:
 *   cost_calculators / cost_calculator_versions: calculators (key, name, the draft being edited, Git or by hand) and
 *     their published, immutable versions (the definition as YAML and its SHA-256).
 *   cost_estimates: estimates of a service or a platform (owner kind and id), optionally for an application, system or
 *     platform; the calculator and version, inputs, lines by hand, ad-hoc adjustments, book choices (JSON), currency,
 *     the month it applies from, the current result and a pending recalculation (JSON).
 *   cost_estimate_results: the results that were current before (at most 20 per estimate).
 *   cost_estimate_books: the book versions an estimate's current or pending result used (versions in use are kept).
 *   cost_plan_lines: `estimate_id` and `estimate_basis` (the twelve month amounts a line was made from).
 *
 * 0.23.0 (ADR 0035 phase 2, contract conditions and derived books):
 * costs-008-contract-conditions:
 *   supplier_contract_conditions: the conditions of a supplier contract (its "Prices" section) – kind (percent off list,
 *     negotiated unit price, commitment; and the terms of a derived book: discount on the base, markup, fee per unit,
 *     fixed fee), the provider and scope it is for, the value (percentage, price with block, currency and tiers, the
 *     unit of a fee, the bands of a commitment and the volume schedule it reads), validity, a note, who and when.
 *   cost_price_book_versions: `derivation` – for a version of a derived book: the base version it was computed from,
 *     the terms used and the cause (a new base version, changed terms).
 *   cost_price_books: indexes on `base_book_id` (derived books follow their base) and `supplier_contract_id`.
 *   cost_estimates: `contracts` – per provider the contract whose conditions apply (chosen; default: see pricing.ts).
 *   cost_estimate_contracts: the contracts whose conditions an estimate's current or pending result used (a changed
 *     condition recalculates them).
 * costs-009-estimate-recalculation:
 *   cost_estimates: `recalc_cause` – why the job "costs" recalculates it next (a new version of a book it used, a
 *     changed condition of a contract it used; JSON), null when nothing is due.
 *   cost_estimate_notices: "Estimate changed" sent, once per estimate, kind and price version (the key).
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
  {
    name: 'costs-005-platform-plans-volumes',
    sql: `
      ALTER TABLE cost_plan_lines ADD COLUMN platform_id TEXT;
      ALTER TABLE cost_entries ADD COLUMN platform_id TEXT;
      ALTER TABLE cost_schedules ADD COLUMN platform_id TEXT;
      ALTER TABLE cost_entry_imports ADD COLUMN platform_id TEXT;
      CREATE INDEX cost_plan_lines_platform ON cost_plan_lines(platform_id, fiscal_year);
      CREATE INDEX cost_entries_platform ON cost_entries(platform_id, entry_date);
      CREATE INDEX cost_schedules_platform ON cost_schedules(platform_id);
      CREATE INDEX cost_entry_imports_platform ON cost_entry_imports(platform_id, created_at);
      CREATE INDEX cost_entries_contract ON cost_entries(supplier_contract_id, entry_date);

      ALTER TABLE cost_schedules ADD COLUMN volume_per TEXT;
      ALTER TABLE cost_schedules ADD COLUMN volume_billing TEXT;
      ALTER TABLE cost_schedules ADD COLUMN volume_committed TEXT;
      ALTER TABLE cost_schedules ADD COLUMN volume_minimum INTEGER;
      ALTER TABLE cost_schedules ADD COLUMN volume_minimum_pct INTEGER;
      ALTER TABLE cost_schedules ADD COLUMN volume_consumption TEXT;

      CREATE TABLE cost_volume_notices (
        schedule_id TEXT NOT NULL,
        period_from TEXT NOT NULL,
        kind TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (schedule_id, period_from, kind)
      );
    `,
  },
  {
    name: 'costs-006-price-books',
    sql: `
      CREATE TABLE cost_price_books (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        supplier_id TEXT,
        supplier_contract_id TEXT,
        platform_id TEXT,
        currency TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        source_settings TEXT NOT NULL DEFAULT '{}',
        review_days INTEGER NOT NULL DEFAULT 90,
        checked_at TEXT,
        checked_by TEXT,
        current_version INTEGER NOT NULL DEFAULT 0,
        base_book_id TEXT,
        derivation TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX cost_price_books_platform ON cost_price_books(platform_id);
      CREATE INDEX cost_price_books_provider ON cost_price_books(provider);

      CREATE TABLE cost_price_book_versions (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        sha256 TEXT NOT NULL DEFAULT '',
        entry_count INTEGER NOT NULL DEFAULT 0,
        diff TEXT,
        source TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX cost_price_book_versions_number ON cost_price_book_versions(book_id, number);

      CREATE TABLE cost_price_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id TEXT NOT NULL,
        sku_id TEXT NOT NULL,
        sku_price_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        service TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        driver TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL,
        charge TEXT NOT NULL,
        price TEXT NOT NULL,
        block INTEGER NOT NULL DEFAULT 1,
        currency TEXT,
        credit_sku TEXT,
        tiers TEXT,
        tier_mode TEXT NOT NULL DEFAULT 'graduated',
        included TEXT,
        minimum TEXT,
        valid_from TEXT,
        valid_to TEXT,
        attributes TEXT NOT NULL DEFAULT '[]',
        source_note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX cost_price_items_version ON cost_price_items(version_id, sku_id);

      CREATE TABLE cost_price_review_notices (
        book_id TEXT NOT NULL,
        due_on TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (book_id, due_on)
      );

      CREATE TABLE cost_fx_rates (
        rate_date TEXT NOT NULL,
        base TEXT NOT NULL,
        quote TEXT NOT NULL,
        rate TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        set_at TEXT NOT NULL,
        set_by TEXT NOT NULL,
        PRIMARY KEY (rate_date, base, quote, source)
      );

      INSERT INTO cost_price_books (id, name, kind, provider, platform_id, currency, description, source, review_days, current_version, created_at, created_by, updated_at, updated_by)
        SELECT 'cpb_' || s.platform_id, p.name || ' – contracted prices', 'contracted', 'Snowflake', s.platform_id, COALESCE(s.credit_currency, 'USD'),
          'The price per credit of the cost source''s fallback (METERING_DAILY_HISTORY × price per credit), moved here by the upgrade to 0.21.0.',
          'manual', 90, 1, s.updated_at, s.updated_by, s.updated_at, s.updated_by
        FROM cost_sources s JOIN platforms p ON p.id = s.platform_id
        WHERE s.credit_price IS NOT NULL AND s.credit_price <> '';
      INSERT INTO cost_price_book_versions (id, book_id, number, sha256, entry_count, diff, source, note, created_at, created_by)
        SELECT 'cpv_' || s.platform_id || '_1', 'cpb_' || s.platform_id, 1, '', 1, NULL, 'migration', 'The price per credit of the cost source', s.updated_at, s.updated_by
        FROM cost_sources s JOIN platforms p ON p.id = s.platform_id
        WHERE s.credit_price IS NOT NULL AND s.credit_price <> '';
      INSERT INTO cost_price_items (version_id, sku_id, sku_price_id, name, service, category, driver, unit, charge, price, block, currency, attributes, source_note)
        SELECT 'cpv_' || s.platform_id || '_1', 'compute-credit', '', 'Compute credit', 'Compute', 'Analytics', 'credits', '{credit}', 'usage', s.credit_price, 1,
          COALESCE(s.credit_currency, 'USD'), '[]', 'Cost source: price per credit (fallback)'
        FROM cost_sources s JOIN platforms p ON p.id = s.platform_id
        WHERE s.credit_price IS NOT NULL AND s.credit_price <> '';
    `,
  },
  {
    name: 'costs-007-calculators-estimates',
    sql: `
      CREATE TABLE cost_calculators (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        current_version INTEGER NOT NULL DEFAULT 0,
        draft TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX cost_calculators_key ON cost_calculators(key);

      CREATE TABLE cost_calculator_versions (
        id TEXT PRIMARY KEY,
        calculator_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        definition TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX cost_calculator_versions_number ON cost_calculator_versions(calculator_id, number);

      CREATE TABLE cost_estimates (
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        for_kind TEXT,
        for_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        calculator_id TEXT,
        calculator_version INTEGER,
        inputs TEXT NOT NULL DEFAULT '[]',
        lines TEXT NOT NULL DEFAULT '[]',
        adjustments TEXT NOT NULL DEFAULT '[]',
        books TEXT NOT NULL DEFAULT '[]',
        currency TEXT NOT NULL,
        applies_from TEXT NOT NULL,
        live_from TEXT,
        match TEXT,
        result TEXT,
        pending TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX cost_estimates_owner ON cost_estimates(owner_kind, owner_id);
      CREATE INDEX cost_estimates_for ON cost_estimates(for_kind, for_id);
      CREATE INDEX cost_estimates_calculator ON cost_estimates(calculator_id);

      CREATE TABLE cost_estimate_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        estimate_id TEXT NOT NULL,
        result TEXT NOT NULL,
        replaced_at TEXT NOT NULL,
        replaced_by TEXT NOT NULL
      );
      CREATE INDEX cost_estimate_results_estimate ON cost_estimate_results(estimate_id, id);

      CREATE TABLE cost_estimate_books (
        estimate_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        PRIMARY KEY (estimate_id, version_id)
      );
      CREATE INDEX cost_estimate_books_version ON cost_estimate_books(version_id);

      ALTER TABLE cost_plan_lines ADD COLUMN estimate_id TEXT;
      ALTER TABLE cost_plan_lines ADD COLUMN estimate_basis TEXT;
      CREATE INDEX cost_plan_lines_estimate ON cost_plan_lines(estimate_id);
    `,
  },
  {
    name: 'costs-008-contract-conditions',
    sql: `
      CREATE TABLE supplier_contract_conditions (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        scope_on TEXT NOT NULL DEFAULT 'provider',
        target TEXT NOT NULL DEFAULT '',
        price_id TEXT NOT NULL DEFAULT '',
        percent TEXT,
        price TEXT,
        block INTEGER NOT NULL DEFAULT 1,
        currency TEXT,
        tiers TEXT,
        tier_mode TEXT NOT NULL DEFAULT 'graduated',
        unit TEXT,
        bands TEXT,
        schedule_id TEXT,
        valid_from TEXT,
        valid_to TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX supplier_contract_conditions_contract ON supplier_contract_conditions(contract_id, position);

      ALTER TABLE cost_price_book_versions ADD COLUMN derivation TEXT;
      CREATE INDEX cost_price_books_base ON cost_price_books(base_book_id);
      CREATE INDEX cost_price_books_contract ON cost_price_books(supplier_contract_id);

      ALTER TABLE cost_estimates ADD COLUMN contracts TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE cost_estimate_contracts (
        estimate_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        PRIMARY KEY (estimate_id, contract_id)
      );
      CREATE INDEX cost_estimate_contracts_contract ON cost_estimate_contracts(contract_id);
    `,
  },
  {
    name: 'costs-009-estimate-recalculation',
    sql: `
      ALTER TABLE cost_estimates ADD COLUMN recalc_cause TEXT;
      CREATE INDEX cost_estimates_recalc ON cost_estimates(recalc_cause);
      CREATE TABLE cost_estimate_notices (
        estimate_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        notice_key TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (estimate_id, kind, notice_key)
      );
    `,
  },
];
