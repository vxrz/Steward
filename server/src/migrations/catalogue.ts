import type { NamedMigration } from '../db.js';

/**
 * Applications in the service catalogue (#84): the applications, their CIA rating, the platforms mapped to them
 * (a platform belongs to at most one application: its id is the key), the applications of a service, overrides
 * of a service's derived protection need, the applications a living document applies to, and custom CIA scales.
 */
export const CATALOGUE_MIGRATIONS: NamedMigration[] = [
  {
    name: 'catalogue-001-applications',
    sql: `
      CREATE TABLE applications (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        vendor TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        owners TEXT NOT NULL DEFAULT '[]',
        criticality TEXT,
        cmdb_system TEXT,
        cmdb_id TEXT,
        cmdb_url TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      -- one row per application and dimension (confidentiality, integrity, availability)
      CREATE TABLE application_ratings (
        application_id TEXT NOT NULL REFERENCES applications(id),
        dimension TEXT NOT NULL,
        level TEXT NOT NULL,
        justification TEXT NOT NULL DEFAULT '',
        rated_at TEXT NOT NULL,
        rated_by TEXT NOT NULL,
        needs_rerating INTEGER NOT NULL DEFAULT 0,
        previous_label TEXT,
        PRIMARY KEY (application_id, dimension)
      );

      -- integrations: the platform id is the key, so a platform belongs to at most one application
      CREATE TABLE application_platforms (
        platform_id TEXT PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
        application_id TEXT NOT NULL REFERENCES applications(id),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE INDEX application_platforms_app ON application_platforms(application_id);

      CREATE TABLE service_applications (
        service_id TEXT NOT NULL REFERENCES services(id),
        application_id TEXT NOT NULL REFERENCES applications(id),
        role TEXT,
        role_text TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (service_id, application_id)
      );
      CREATE INDEX service_applications_app ON service_applications(application_id);

      CREATE TABLE service_protection_overrides (
        service_id TEXT NOT NULL REFERENCES services(id),
        dimension TEXT NOT NULL,
        level TEXT NOT NULL,
        reason TEXT NOT NULL,
        set_at TEXT NOT NULL,
        set_by TEXT NOT NULL,
        needs_rerating INTEGER NOT NULL DEFAULT 0,
        previous_label TEXT,
        PRIMARY KEY (service_id, dimension)
      );

      -- document scope: the applications a living document applies to
      CREATE TABLE record_applications (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        application_id TEXT NOT NULL REFERENCES applications(id),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (record_id, application_id)
      );
      CREATE INDEX record_applications_app ON record_applications(application_id);

      -- custom scales (no rows: the BSI default); dimension "all" (one scale for all three) or one row per dimension
      CREATE TABLE cia_scales (
        dimension TEXT PRIMARY KEY,
        levels TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
    `,
  },
  {
    // #103: what an application consists of (repositories, images, topics, …) and the tech stack of each component.
    // Mapping components to platforms per environment can follow as its own table.
    name: 'catalogue-002-components',
    sql: `
      CREATE TABLE application_components (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id),
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        sbom_format TEXT,
        sbom_name TEXT,
        sbom_imported_at TEXT,
        sbom_imported_by TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX application_components_app ON application_components(application_id);

      -- one row per component and endoflife.date product
      CREATE TABLE component_stack (
        component_id TEXT NOT NULL REFERENCES application_components(id) ON DELETE CASCADE,
        product TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        sbom_ref TEXT NOT NULL DEFAULT '',
        set_at TEXT NOT NULL,
        set_by TEXT NOT NULL,
        PRIMARY KEY (component_id, product)
      );
    `,
  },
  {
    // #104: end of life of the products in the tech stacks, read from endoflife.date (a cache, filled again by the
    // daily refresh), and the messages sent to application owners (once per application, product, cycle and kind).
    name: 'catalogue-003-lifecycle',
    sql: `
      CREATE TABLE eol_releases (
        product TEXT NOT NULL,
        cycle TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        release_date TEXT,
        is_lts INTEGER NOT NULL DEFAULT 0,
        eoas_from TEXT,
        eol_from TEXT,
        is_eol INTEGER NOT NULL DEFAULT 0,
        latest TEXT,
        PRIMARY KEY (product, cycle)
      );
      CREATE TABLE eol_products (
        product TEXT PRIMARY KEY,
        fetched_at TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE eol_notices (
        application_id TEXT NOT NULL,
        product TEXT NOT NULL,
        cycle TEXT NOT NULL,
        kind TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (application_id, product, cycle, kind)
      );
    `,
  },
  {
    // #129: systems that applications run on (servers, VMs, clusters, cloud services – shared between applications),
    // their tech stack, the "runs on" links with an environment, and the environment of a component.
    name: 'catalogue-004-systems',
    sql: `
      CREATE TABLE systems (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        vendor TEXT NOT NULL DEFAULT '',
        cmdb_url TEXT NOT NULL DEFAULT '',
        owners TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        platform_id TEXT,
        sbom_format TEXT,
        sbom_name TEXT,
        sbom_imported_at TEXT,
        sbom_imported_by TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      -- one row per system and endoflife.date product (like component_stack)
      CREATE TABLE system_stack (
        system_id TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
        product TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        sbom_ref TEXT NOT NULL DEFAULT '',
        set_at TEXT NOT NULL,
        set_by TEXT NOT NULL,
        PRIMARY KEY (system_id, product)
      );

      -- an application runs on a system in an environment (one system can host several applications and environments)
      CREATE TABLE application_systems (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES applications(id),
        system_id TEXT NOT NULL REFERENCES systems(id),
        environment TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        UNIQUE (application_id, system_id, environment)
      );
      CREATE INDEX application_systems_system ON application_systems(system_id);

      -- empty: all environments / not specific to one (every component from before)
      ALTER TABLE application_components ADD COLUMN environment TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // #108: maintenance windows of platforms, systems, applications and services (once or repeating), and the
    // announcements sent for them (once per occurrence and kind)
    name: 'catalogue-005-maintenance',
    sql: `
      CREATE TABLE maintenance_windows (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        recurrence TEXT,
        time_zone TEXT NOT NULL,
        responsible TEXT NOT NULL DEFAULT '[]',
        change_record_id TEXT,
        quiet_monitors INTEGER NOT NULL DEFAULT 1,
        pause_messages INTEGER NOT NULL DEFAULT 0,
        reminder_hours INTEGER NOT NULL DEFAULT 24,
        cancelled_at TEXT,
        cancelled_by TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE maintenance_targets (
        window_id TEXT NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        PRIMARY KEY (window_id, kind, target_id)
      );
      CREATE INDEX maintenance_targets_target ON maintenance_targets(kind, target_id);
      CREATE TABLE maintenance_notices (
        window_id TEXT NOT NULL,
        occurrence_start TEXT NOT NULL,
        kind TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (window_id, occurrence_start, kind)
      );
    `,
  },
  {
    // #111: a Kubernetes namespace component names its cluster (a platform) and keeps what Steward last read from it
    name: 'catalogue-006-namespace-cluster',
    sql: `
      ALTER TABLE application_components ADD COLUMN platform_id TEXT;
      ALTER TABLE application_components ADD COLUMN cluster_state TEXT;
    `,
  },
  {
    // #107, #112: repository and Kafka topic components name their platform (platform_id) and keep what Steward last read
    name: 'catalogue-007-component-readouts',
    sql: `
      ALTER TABLE application_components ADD COLUMN repo_state TEXT;
      ALTER TABLE application_components ADD COLUMN topic_state TEXT;
    `,
  },
  {
    // AWS accounts (#116): what was read for a cloud-account component, and per account the shared reads
    // (resources, IAM users, costs) that all its components use; Snowflake (#115): what was read for a database
    name: 'catalogue-008-cloud-readouts',
    sql: `
      ALTER TABLE application_components ADD COLUMN aws_state TEXT;
      ALTER TABLE application_components ADD COLUMN snowflake_state TEXT;
      CREATE TABLE aws_account_cache (
        platform_id TEXT NOT NULL,
        part TEXT NOT NULL,
        read_at TEXT NOT NULL,
        data TEXT,
        error TEXT,
        PRIMARY KEY (platform_id, part)
      );
    `,
  },
  {
    // Dependency-Track (#119): the project of a component (any type) and what was read from it
    name: 'catalogue-009-dependency-track',
    sql: `
      ALTER TABLE application_components ADD COLUMN dt_platform_id TEXT;
      ALTER TABLE application_components ADD COLUMN dt_project TEXT;
      ALTER TABLE application_components ADD COLUMN dt_state TEXT;
    `,
  },
];
