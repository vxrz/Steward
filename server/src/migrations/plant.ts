import type { NamedMigration } from '../db.js';

/**
 * The plant registry module (#218, docs/adr/0007-plant-registry.md): its own tables, nothing in the core changes.
 * Additive only. Ids are the stable ids of the records (from people or the import file); import_id names the last
 * import that wrote a record and not_in_source marks one an import kept although its file no longer contains it.
 */
export const PLANT_MIGRATIONS: NamedMigration[] = [
  {
    name: 'plant-001-registry',
    sql: `
      CREATE TABLE plant_sites (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        names TEXT NOT NULL DEFAULT '{}',
        description TEXT NOT NULL DEFAULT '',
        lat REAL,
        lon REAL,
        zoom INTEGER,
        contacts TEXT NOT NULL DEFAULT '[]',
        fields TEXT NOT NULL DEFAULT '{}',
        acl TEXT NOT NULL DEFAULT '[]',
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX plant_sites_code ON plant_sites(code);
      CREATE TABLE plant_nodes (
        site_id TEXT NOT NULL,
        id TEXT NOT NULL,
        level TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        names TEXT NOT NULL DEFAULT '{}',
        type TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL DEFAULT '',
        building_id TEXT,
        description TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        fields TEXT NOT NULL DEFAULT '{}',
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (site_id, id)
      );
      CREATE INDEX plant_nodes_parent ON plant_nodes(site_id, parent_id);
      CREATE TABLE plant_buildings (
        site_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        names TEXT NOT NULL DEFAULT '{}',
        kind TEXT NOT NULL DEFAULT 'building',
        parent_id TEXT,
        description TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        fields TEXT NOT NULL DEFAULT '{}',
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (site_id, id)
      );
      CREATE TABLE plant_assets (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        area_id TEXT,
        work_center_id TEXT,
        work_unit_id TEXT,
        building_id TEXT,
        name TEXT NOT NULL,
        manufacturer TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'operational',
        parent_id TEXT,
        domain TEXT NOT NULL DEFAULT '',
        process_area TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        commissioned TEXT,
        end_of_support TEXT,
        description TEXT NOT NULL DEFAULT '',
        capabilities TEXT NOT NULL DEFAULT '[]',
        image_name TEXT NOT NULL DEFAULT '',
        fields TEXT NOT NULL DEFAULT '{}',
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX plant_assets_site ON plant_assets(site_id);
      CREATE INDEX plant_assets_parent ON plant_assets(parent_id);
      CREATE TABLE plant_asset_images (
        asset_id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE plant_refs (
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        system TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (kind, item_id, position)
      );
      CREATE INDEX plant_refs_lookup ON plant_refs(system, ref_id);
      CREATE TABLE plant_imports (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        mode TEXT NOT NULL,
        missing TEXT NOT NULL,
        replaces TEXT,
        files TEXT NOT NULL DEFAULT '[]',
        sha256 TEXT NOT NULL,
        counts TEXT NOT NULL DEFAULT '{}',
        sites TEXT NOT NULL DEFAULT '[]'
      );
    `,
  },
  {
    // part 2 (#219): device profiles and KPI definitions (catalogues of the installation), an asset's assignment
    name: 'plant-002-data-points',
    sql: `
      CREATE TABLE plant_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        manufacturer TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        interfaces TEXT NOT NULL DEFAULT '[]',
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE plant_kpis (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        names TEXT NOT NULL DEFAULT '{}',
        category TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        formula TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL DEFAULT '',
        range_min REAL,
        range_max REAL,
        trend TEXT,
        timing TEXT,
        audience TEXT NOT NULL DEFAULT '[]',
        methodology TEXT,
        strategy TEXT NOT NULL DEFAULT '',
        implementation TEXT NOT NULL DEFAULT '',
        dynamic_columns INTEGER NOT NULL DEFAULT 0,
        inputs TEXT NOT NULL DEFAULT '[]',
        parameters TEXT NOT NULL DEFAULT '[]',
        result_columns TEXT NOT NULL DEFAULT '[]',
        computation TEXT NOT NULL DEFAULT '{}',
        notes TEXT NOT NULL DEFAULT '',
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE plant_assignments (
        asset_id TEXT PRIMARY KEY,
        profile_id TEXT,
        firmware TEXT NOT NULL DEFAULT '',
        interfaces TEXT NOT NULL DEFAULT '[]',
        overrides TEXT NOT NULL DEFAULT '[]',
        publications TEXT NOT NULL DEFAULT '[]',
        kpis TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX plant_assignments_profile ON plant_assignments(profile_id);
    `,
  },
];
