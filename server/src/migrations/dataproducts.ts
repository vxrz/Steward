import type { NamedMigration } from '../db.js';

/**
 * The data products module (0.22.0, ADR 0036 part 18, docs/DATA-PRODUCTS.md): domains, data objects, products with
 * their ratings and environments; the element catalogue with readouts, discovery sources and runs; membership, ports,
 * bindings, consumers; steps, check links, cost matches and allocations, notice bookkeeping. Owning teams live in
 * resource_teams (kinds data_product, data_object, data_element, data_domain). Additive only; ids carry the prefixes
 * of DATA_PRODUCT_ID_PREFIX (shared/src/dataProducts.ts).
 *
 * JSON columns hold arrays or objects as text. Person columns: owners, stewards, custodians, contacts and consumer
 * subjects are subjects (`user:`, `team:`) mapped on import (USER_REFS); *_by columns are history.
 */
export const DATA_PRODUCT_MIGRATIONS: NamedMigration[] = [
  {
    name: 'dataproducts-001-core',
    sql: `
      CREATE TABLE dp_domains (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        colour TEXT,
        owners TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dp_domains_key ON dp_domains(key);
      CREATE INDEX dp_domains_parent ON dp_domains(parent_id);
      CREATE TABLE dp_objects (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        name_norm TEXT NOT NULL,
        definition TEXT NOT NULL DEFAULT '',
        synonyms TEXT NOT NULL DEFAULT '[]',
        domain_id TEXT,
        lifecycle TEXT NOT NULL DEFAULT 'draft',
        lifecycle_dates TEXT NOT NULL DEFAULT '{}',
        classification TEXT,
        personal_data TEXT NOT NULL DEFAULT 'none',
        categories TEXT NOT NULL DEFAULT '[]',
        special_categories TEXT NOT NULL DEFAULT '[]',
        subjects TEXT NOT NULL DEFAULT '[]',
        legal_basis TEXT,
        legal_note TEXT NOT NULL DEFAULT '',
        purposes TEXT NOT NULL DEFAULT '[]',
        retention TEXT NOT NULL DEFAULT '',
        deletion_rule TEXT NOT NULL DEFAULT '',
        regulatory_flags TEXT NOT NULL DEFAULT '[]',
        attributes TEXT NOT NULL DEFAULT '[]',
        owner TEXT,
        stewards TEXT NOT NULL DEFAULT '[]',
        custodians TEXT NOT NULL DEFAULT '[]',
        external_refs TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dp_objects_key ON dp_objects(key);
      CREATE INDEX dp_objects_name ON dp_objects(name_norm, id);
      CREATE INDEX dp_objects_domain ON dp_objects(domain_id);
      CREATE TABLE dp_products (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        name_norm TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        type TEXT,
        domain_id TEXT,
        owners TEXT NOT NULL DEFAULT '[]',
        support TEXT NOT NULL DEFAULT '{}',
        criticality TEXT,
        tier INTEGER,
        classification TEXT,
        lifecycle TEXT NOT NULL DEFAULT 'proposed',
        lifecycle_dates TEXT NOT NULL DEFAULT '{}',
        sunset_date TEXT,
        successor_id TEXT,
        version TEXT NOT NULL DEFAULT '',
        value_statement TEXT NOT NULL DEFAULT '',
        value_tier TEXT,
        value_amount INTEGER,
        value_currency TEXT,
        rating_reason TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        external_refs TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dp_products_key ON dp_products(key);
      CREATE INDEX dp_products_name ON dp_products(name_norm, id);
      CREATE INDEX dp_products_domain ON dp_products(domain_id);
      CREATE INDEX dp_products_successor ON dp_products(successor_id);
      CREATE TABLE dp_ratings (
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        level TEXT NOT NULL,
        justification TEXT NOT NULL DEFAULT '',
        rated_at TEXT NOT NULL,
        rated_by TEXT NOT NULL,
        needs_rerating INTEGER NOT NULL DEFAULT 0,
        previous_label TEXT,
        PRIMARY KEY (kind, item_id, dimension)
      );
      CREATE INDEX dp_ratings_item ON dp_ratings(item_id);
      CREATE TABLE dp_product_environments (
        product_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'planned',
        monitor_id TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (product_id, environment)
      );
      CREATE INDEX dp_product_environments_monitor ON dp_product_environments(monitor_id);
    `,
  },
  {
    name: 'dataproducts-002-elements',
    sql: `
      CREATE TABLE dp_elements (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        name_norm TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        environment TEXT NOT NULL DEFAULT '',
        parent_id TEXT,
        layer TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        type_label TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'entered',
        discovery_source_id TEXT,
        external_id TEXT,
        ol_namespace TEXT,
        ol_name TEXT,
        application_id TEXT,
        component_id TEXT,
        plant_sink TEXT,
        api_ref TEXT,
        flags TEXT NOT NULL DEFAULT '{}',
        tech_hash TEXT,
        missing_since TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dp_elements_unique ON dp_elements(platform_id, kind, environment, name_norm);
      CREATE INDEX dp_elements_name ON dp_elements(name_norm, id);
      CREATE INDEX dp_elements_external ON dp_elements(platform_id, external_id);
      CREATE INDEX dp_elements_parent ON dp_elements(parent_id);
      CREATE INDEX dp_elements_source ON dp_elements(discovery_source_id);
      CREATE INDEX dp_elements_kind ON dp_elements(kind, name_norm);
      CREATE INDEX dp_elements_missing ON dp_elements(missing_since);
      CREATE INDEX dp_elements_component ON dp_elements(component_id);
      CREATE TABLE dp_element_readouts (
        element_id TEXT PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '{}',
        read_at TEXT NOT NULL
      );
      CREATE TABLE dp_discovery_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '[]',
        include_prefixes TEXT NOT NULL DEFAULT '[]',
        exclude_prefixes TEXT NOT NULL DEFAULT '[]',
        environment_rules TEXT NOT NULL DEFAULT '[]',
        mode TEXT,
        identity_id TEXT,
        element_team_ids TEXT NOT NULL DEFAULT '[]',
        interval_minutes INTEGER NOT NULL DEFAULT 1440,
        enabled INTEGER NOT NULL DEFAULT 1,
        run_as TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT,
        failing_since TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX dp_discovery_sources_platform ON dp_discovery_sources(platform_id);
      CREATE TABLE dp_discovery_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        added INTEGER NOT NULL DEFAULT 0,
        changed INTEGER NOT NULL DEFAULT 0,
        renamed INTEGER NOT NULL DEFAULT 0,
        missing INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        unchanged INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        actor TEXT NOT NULL
      );
      CREATE INDEX dp_discovery_runs_source ON dp_discovery_runs(source_id, started_at);
    `,
  },
  {
    name: 'dataproducts-003-membership-ports',
    sql: `
      CREATE TABLE dp_members (
        product_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        role TEXT NOT NULL,
        include_descendants INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (product_id, element_id)
      );
      CREATE INDEX dp_members_element ON dp_members(element_id);
      CREATE TABLE dp_ports (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        name TEXT NOT NULL,
        port_type TEXT NOT NULL DEFAULT 'table',
        version TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        lifecycle TEXT NOT NULL DEFAULT 'draft',
        lifecycle_dates TEXT NOT NULL DEFAULT '{}',
        sunset_date TEXT,
        successor_id TEXT,
        objectives TEXT NOT NULL DEFAULT '{}',
        source_kind TEXT,
        source_port_id TEXT,
        source_element_id TEXT,
        source_text TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX dp_ports_product ON dp_ports(product_id, position);
      CREATE INDEX dp_ports_source_port ON dp_ports(source_port_id);
      CREATE INDEX dp_ports_source_element ON dp_ports(source_element_id);
      CREATE TABLE dp_port_bindings (
        id TEXT PRIMARY KEY,
        port_id TEXT NOT NULL,
        environment TEXT NOT NULL DEFAULT '',
        contract_id TEXT,
        contract_version INTEGER,
        contract_server TEXT,
        objectives TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dp_port_bindings_port ON dp_port_bindings(port_id, environment);
      CREATE INDEX dp_port_bindings_contract ON dp_port_bindings(contract_id);
      CREATE TABLE dp_port_elements (
        binding_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        PRIMARY KEY (binding_id, element_id)
      );
      CREATE INDEX dp_port_elements_element ON dp_port_elements(element_id);
      CREATE TABLE dp_port_objects (
        port_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        PRIMARY KEY (port_id, object_id)
      );
      CREATE INDEX dp_port_objects_object ON dp_port_objects(object_id);
      CREATE TABLE dp_object_elements (
        object_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (object_id, element_id)
      );
      CREATE INDEX dp_object_elements_element ON dp_object_elements(element_id);
      CREATE TABLE dp_consumers (
        id TEXT PRIMARY KEY,
        port_id TEXT NOT NULL,
        consumer_kind TEXT NOT NULL,
        ref_id TEXT,
        consumer_subjects TEXT NOT NULL DEFAULT '[]',
        consumer_text TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        since TEXT,
        end_date TEXT,
        agreement TEXT,
        contacts TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX dp_consumers_port ON dp_consumers(port_id);
      CREATE INDEX dp_consumers_ref ON dp_consumers(consumer_kind, ref_id);
    `,
  },
  {
    name: 'dataproducts-004-steps-checks-costs',
    sql: `
      CREATE TABLE dp_steps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        step_kind TEXT NOT NULL DEFAULT 'transform',
        runner TEXT,
        schedule TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '[]',
        last_run TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE dp_step_elements (
        step_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        PRIMARY KEY (step_id, element_id, direction)
      );
      CREATE INDEX dp_step_elements_element ON dp_step_elements(element_id, direction);
      CREATE TABLE dp_check_links (
        id TEXT PRIMARY KEY,
        element_id TEXT,
        step_id TEXT,
        monitor_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'other',
        origin TEXT NOT NULL DEFAULT 'linked',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE INDEX dp_check_links_monitor ON dp_check_links(monitor_id, check_id);
      CREATE INDEX dp_check_links_element ON dp_check_links(element_id);
      CREATE INDEX dp_check_links_step ON dp_check_links(step_id);
      CREATE TABLE dp_cost_matches (
        id TEXT PRIMARY KEY,
        product_id TEXT,
        element_id TEXT,
        environment TEXT NOT NULL DEFAULT '',
        platform_id TEXT NOT NULL,
        match_kind TEXT NOT NULL,
        match_value TEXT NOT NULL,
        tag_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE INDEX dp_cost_matches_product ON dp_cost_matches(product_id);
      CREATE INDEX dp_cost_matches_element ON dp_cost_matches(element_id);
      CREATE INDEX dp_cost_matches_line ON dp_cost_matches(platform_id, match_kind, match_value);
      CREATE TABLE dp_cost_allocations (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL,
        match_kind TEXT NOT NULL,
        match_value TEXT NOT NULL,
        tag_key TEXT NOT NULL DEFAULT '',
        rule TEXT NOT NULL DEFAULT 'equal',
        weights TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dp_cost_allocations_line ON dp_cost_allocations(platform_id, match_kind, match_value, tag_key);
      CREATE TABLE dp_notices (
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        notice_key TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (kind, item_id, notice_key)
      );
    `,
  },
  {
    // 0.24.0 (ADR 0036 phase 2, package A): lineage from tools – lineage sources (OpenLineage push, dbt) with push tokens,
    // proposed steps from OpenLineage jobs, dbt models and Snowflake OBJECT_DEPENDENCIES with their matched elements and
    // the last run per job, the tests of a dbt manifest, and the index that matches OpenLineage datasets to elements (dbt
    // test results go to package B's dp_quality_results through recordQualityResults)
    name: 'dataproducts-005a-lineage',
    sql: `
      CREATE TABLE dp_lineage_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        platform_id TEXT,
        namespace_aliases TEXT NOT NULL DEFAULT '[]',
        team_ids TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        received INTEGER NOT NULL DEFAULT 0,
        refused INTEGER NOT NULL DEFAULT 0,
        last_event_at TEXT,
        last_error TEXT,
        last_error_at TEXT,
        last_import TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE dp_lineage_tokens (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        hash TEXT NOT NULL,
        allowed_cidrs TEXT NOT NULL DEFAULT '[]',
        rate_limit_per_minute INTEGER NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        rotated_at TEXT,
        last_used_at TEXT,
        last_used_ip TEXT,
        revoked_at TEXT,
        revoked_by TEXT
      );
      CREATE UNIQUE INDEX dp_lineage_tokens_hash ON dp_lineage_tokens(hash);
      CREATE INDEX dp_lineage_tokens_source ON dp_lineage_tokens(source_id);
      CREATE TABLE dp_lineage_proposals (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        source_id TEXT NOT NULL,
        job_key TEXT NOT NULL,
        name TEXT NOT NULL,
        step_kind TEXT NOT NULL DEFAULT 'transform',
        tool TEXT NOT NULL DEFAULT '',
        ends_hash TEXT NOT NULL DEFAULT '',
        unmatched TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open',
        changed INTEGER NOT NULL DEFAULT 0,
        step_id TEXT,
        last_run_id TEXT,
        last_run_state TEXT,
        last_run_at TEXT,
        last_complete_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT
      );
      CREATE UNIQUE INDEX dp_lineage_proposals_key ON dp_lineage_proposals(source_id, origin, job_key);
      CREATE INDEX dp_lineage_proposals_status ON dp_lineage_proposals(status, last_seen_at);
      CREATE INDEX dp_lineage_proposals_step ON dp_lineage_proposals(step_id);
      CREATE TABLE dp_lineage_proposal_elements (
        proposal_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        PRIMARY KEY (proposal_id, element_id, direction)
      );
      CREATE INDEX dp_lineage_proposal_elements_element ON dp_lineage_proposal_elements(element_id);
      CREATE TABLE dp_lineage_tests (
        source_id TEXT NOT NULL,
        test_key TEXT NOT NULL,
        element_id TEXT NOT NULL,
        name TEXT NOT NULL,
        test_name TEXT NOT NULL DEFAULT '',
        column_name TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, test_key, element_id)
      );
      CREATE INDEX dp_elements_ol ON dp_elements(ol_namespace, ol_name);
    `,
  },
  {
    // 0.24.0 (ADR 0036 phase 2, package B): quality results of elements (dbt tests, Data Metric Function results,
    // contract tests, the data-element check's volume and quality modes) – at most one row per element, source, name
    // and hour, kept 400 days; volume readings of the data-element check (the reading before); daily scorecard
    // snapshots per product and environment (kept 400 days)
    name: 'dataproducts-005b-quality-scorecard-history',
    sql: `
      CREATE TABLE dp_quality_results (
        id TEXT PRIMARY KEY,
        element_id TEXT NOT NULL,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        dimension TEXT,
        status TEXT NOT NULL,
        value REAL,
        message TEXT NOT NULL DEFAULT '',
        run_ref TEXT,
        bucket TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        recorded_by TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dp_quality_results_key ON dp_quality_results(element_id, source, name, bucket);
      CREATE INDEX dp_quality_results_element ON dp_quality_results(element_id, observed_at);
      CREATE INDEX dp_quality_results_observed ON dp_quality_results(observed_at);
      CREATE TABLE dp_volume_readings (
        element_id TEXT NOT NULL,
        measure TEXT NOT NULL,
        read_at TEXT NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (element_id, measure, read_at)
      );
      CREATE TABLE dp_scorecard_snapshots (
        product_id TEXT NOT NULL,
        environment TEXT NOT NULL DEFAULT '',
        day TEXT NOT NULL,
        maturity INTEGER NOT NULL,
        states TEXT NOT NULL DEFAULT '{}',
        taken_at TEXT NOT NULL,
        PRIMARY KEY (product_id, environment, day)
      );
      CREATE INDEX dp_scorecard_snapshots_day ON dp_scorecard_snapshots(day);
    `,
  },
  // 0.24.0 (ADR 0036 phase 2, package C): consumers, access and governance – platform identities of registrations,
  // what platforms say who reads a port (ACCESS_HISTORY, consumer groups: read again on a target, not moved), access
  // requests with their settings, port access reviews, promotions between environments and endorsements
  {
    name: 'dataproducts-005c-governance',
    sql: `
      CREATE TABLE dp_consumer_identities (
        consumer_id TEXT NOT NULL,
        identity TEXT NOT NULL,
        PRIMARY KEY (consumer_id, identity)
      );
      CREATE TABLE dp_actual_reads (
        port_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        window_days INTEGER NOT NULL DEFAULT 30,
        objects INTEGER NOT NULL DEFAULT 0,
        read_at TEXT NOT NULL,
        read_by TEXT NOT NULL,
        PRIMARY KEY (port_id, environment, platform_id)
      );
      CREATE INDEX dp_actual_reads_at ON dp_actual_reads(read_at);
      CREATE TABLE dp_actual_consumers (
        port_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        objects TEXT NOT NULL DEFAULT '[]',
        reads INTEGER,
        last_seen TEXT,
        detail TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (port_id, environment, platform_id, kind, name)
      );
      CREATE TABLE dp_access_settings (
        product_id TEXT PRIMARY KEY,
        process_id TEXT,
        ticket_source TEXT,
        review_months INTEGER,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE dp_access_requests (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        port_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        requester TEXT NOT NULL,
        consumer_kind TEXT NOT NULL,
        ref_id TEXT,
        consumer_subjects TEXT NOT NULL DEFAULT '[]',
        consumer_text TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        until_date TEXT,
        agreement TEXT,
        identities TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        four_eyes INTEGER NOT NULL DEFAULT 0,
        approvals TEXT NOT NULL DEFAULT '[]',
        decided_by TEXT,
        decided_at TEXT,
        decision_comment TEXT NOT NULL DEFAULT '',
        consumer_id TEXT,
        ticket_id TEXT,
        run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX dp_access_requests_product ON dp_access_requests(product_id, status);
      CREATE INDEX dp_access_requests_port ON dp_access_requests(port_id, status);
      CREATE INDEX dp_access_requests_requester ON dp_access_requests(requester, created_at);
      CREATE INDEX dp_access_requests_status ON dp_access_requests(status, created_at);
      CREATE TABLE dp_port_reviews (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        port_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        four_eyes INTEGER NOT NULL DEFAULT 1,
        check_info TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        submitted_by TEXT,
        submitted_at TEXT,
        approved_by TEXT,
        approved_at TEXT,
        approval_comment TEXT NOT NULL DEFAULT '',
        seal_hash TEXT
      );
      CREATE INDEX dp_port_reviews_port ON dp_port_reviews(port_id, environment, status);
      CREATE INDEX dp_port_reviews_product ON dp_port_reviews(product_id, created_at);
      CREATE TABLE dp_port_review_items (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        consumer_id TEXT,
        label TEXT NOT NULL,
        finding TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        decision TEXT,
        comment TEXT NOT NULL DEFAULT '',
        decided_by TEXT,
        decided_at TEXT
      );
      CREATE INDEX dp_port_review_items_review ON dp_port_review_items(review_id, seq);
      CREATE TABLE dp_promotions (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        from_env TEXT NOT NULL,
        to_env TEXT NOT NULL,
        members INTEGER NOT NULL DEFAULT 0,
        bindings INTEGER NOT NULL DEFAULT 0,
        missing INTEGER NOT NULL DEFAULT 0,
        evidence TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX dp_promotions_product ON dp_promotions(product_id, created_at);
      CREATE TABLE dp_endorsements (
        product_id TEXT PRIMARY KEY,
        endorsed_by TEXT NOT NULL,
        endorsed_at TEXT NOT NULL,
        review_date TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        review_reason TEXT,
        review_flagged_at TEXT
      );
      CREATE INDEX dp_endorsements_review ON dp_endorsements(review_date);
    `,
  },
  {
    // phase 2, package D (0.24.0): cost splitting by measured use – what a platform's allocation measures and the
    // quantities read (dp_cost_usage: per platform, measure, scope, month and subject; subject '' is the scope's total);
    // the origins of imported entries (an import's or a Git sync source's name), which _replace_ removes from
    name: 'dataproducts-005d-measured-use-origins',
    sql: `
      ALTER TABLE dp_cost_allocations ADD COLUMN measure TEXT;
      ALTER TABLE dp_cost_allocations ADD COLUMN subjects TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE dp_cost_allocations ADD COLUMN read_at TEXT;
      ALTER TABLE dp_cost_allocations ADD COLUMN read_error TEXT;
      CREATE TABLE dp_cost_usage (
        platform_id TEXT NOT NULL,
        measure TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        month TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        quantity TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (platform_id, measure, scope, month, subject)
      );
      CREATE TABLE dp_import_origins (
        origin TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (origin, kind, item_id)
      );
      CREATE INDEX dp_import_origins_item ON dp_import_origins(kind, item_id);
    `,
  },
  {
    // 0.24.0 (release review): what a port access review froze of each entry as structured facts (JSON) instead of an
    // English text – entries frozen before keep their text (detail) and their seal
    name: 'dataproducts-005e-port-review-facts',
    sql: `
      ALTER TABLE dp_port_review_items ADD COLUMN facts TEXT;
    `,
  },
  {
    // 0.25.0 (ADR 0037 part 0, package A): generic parts – the technology and the key: value properties of an element
    // (its namespace is ol_namespace, its OpenLineage name the qualified name); the technologies administrators add to
    // the built-in list (shared/src/dataTechnologies.ts)
    name: 'dataproducts-006a-generic-parts-technologies',
    sql: `
      ALTER TABLE dp_elements ADD COLUMN technology TEXT;
      ALTER TABLE dp_elements ADD COLUMN properties TEXT NOT NULL DEFAULT '[]';
      CREATE INDEX dp_elements_technology ON dp_elements(technology);
      CREATE TABLE dp_technologies (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT 'other',
        ol_namespace_pattern TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
    `,
  },
  {
    // phase 3, package D (0.25.0, ADR 0037 parts 4 and 6): semantic models (Apache Ossie) as governed records – one
    // document per product, every save a version (who, when, SHA-256), stored as written, with optional sign-offs
    // (valid from their day); recorded responses linked to a port as its preview; the GDPR Art. 30 details of data
    // objects and products – transfers to third countries with their safeguards (e) and the measures' reference (g)
    name: 'dataproducts-006d-semantic-models-ropa',
    sql: `
      CREATE TABLE dp_semantic_versions (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        format TEXT NOT NULL,
        ossie_version TEXT,
        document TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'page',
        lint_count INTEGER NOT NULL DEFAULT 0,
        proposed_by TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX dp_semantic_versions_product ON dp_semantic_versions(product_id, version);
      CREATE TABLE dp_semantic_signoffs (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        signed_by TEXT NOT NULL,
        signed_at TEXT NOT NULL
      );
      CREATE INDEX dp_semantic_signoffs_product ON dp_semantic_signoffs(product_id, valid_from);
      CREATE UNIQUE INDEX dp_semantic_signoffs_version ON dp_semantic_signoffs(version_id);
      CREATE TABLE dp_port_recordings (
        port_id TEXT NOT NULL,
        recording_id TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (port_id, recording_id)
      );
      ALTER TABLE dp_objects ADD COLUMN transfers TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE dp_objects ADD COLUMN toms TEXT;
      ALTER TABLE dp_products ADD COLUMN transfers TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE dp_products ADD COLUMN toms TEXT;
    `,
  },
];
