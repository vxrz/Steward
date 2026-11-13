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
];
