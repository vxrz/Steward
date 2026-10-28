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
];
