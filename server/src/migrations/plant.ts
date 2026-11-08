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
  {
    // part 3 (#220): the OT network – VLANs, IEC 62443-3-2 zones and conduits of a site; devices, data paths and the
    // checks of an asset (its live status). Sub-lists (subnets, transfers, checks) are JSON, as in part 2.
    name: 'plant-003-ot-network',
    sql: `
      CREATE TABLE plant_vlans (
        site_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        vid INTEGER,
        type TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        subnets TEXT NOT NULL DEFAULT '[]',
        restricted INTEGER NOT NULL DEFAULT 0,
        managed_by TEXT NOT NULL DEFAULT '',
        rules_at TEXT NOT NULL DEFAULT '',
        sites TEXT NOT NULL DEFAULT '[]',
        location TEXT NOT NULL DEFAULT '',
        segment_id TEXT,
        notes TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (site_id, id)
      );
      CREATE INDEX plant_vlans_segment ON plant_vlans(segment_id);
      CREATE TABLE plant_zones (
        site_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        criticality TEXT,
        vlans TEXT NOT NULL DEFAULT '[]',
        owner TEXT NOT NULL DEFAULT '',
        sl_target INTEGER,
        risk_assessment TEXT NOT NULL DEFAULT '',
        assessed_at TEXT,
        notes TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (site_id, id)
      );
      CREATE TABLE plant_conduits (
        site_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        zone_a TEXT NOT NULL,
        zone_b TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'both',
        protocols TEXT NOT NULL DEFAULT '[]',
        controls TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (site_id, id)
      );
      CREATE TABLE plant_devices (
        asset_id TEXT NOT NULL,
        id TEXT NOT NULL,
        hostname TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        mac TEXT NOT NULL DEFAULT '',
        serial TEXT NOT NULL DEFAULT '',
        vlan_id TEXT,
        address_type TEXT,
        address TEXT NOT NULL DEFAULT '',
        switch_name TEXT NOT NULL DEFAULT '',
        switch_port TEXT NOT NULL DEFAULT '',
        wall_outlet TEXT NOT NULL DEFAULT '',
        cmdb_port TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'active',
        flags TEXT NOT NULL DEFAULT '[]',
        confidence TEXT,
        owner TEXT NOT NULL DEFAULT '',
        monitoring TEXT NOT NULL DEFAULT '',
        checks TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (asset_id, id)
      );
      CREATE TABLE plant_data_paths (
        asset_id TEXT NOT NULL,
        id TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        devices TEXT NOT NULL DEFAULT '[]',
        collector TEXT,
        transfers TEXT NOT NULL DEFAULT '[]',
        destinations TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (asset_id, id)
      );
      CREATE TABLE plant_asset_checks (
        asset_id TEXT PRIMARY KEY,
        checks TEXT NOT NULL DEFAULT '[]',
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
    `,
  },
  {
    // 0.11.0: old ids of renamed entries keep leading to them (docs/PLANT.md#changing-ids). kind as in PLANT_ID_KINDS,
    // scope the site, asset or profile id the entry's id is unique in ('' for sites, assets, profiles and KPI
    // definitions). Chains are collapsed when written (a → b, then b → c gives a → c and b → c).
    name: 'plant-004-id-aliases',
    sql: `
      CREATE TABLE plant_id_aliases (
        kind TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        old_id TEXT NOT NULL,
        new_id TEXT NOT NULL,
        renamed_at TEXT NOT NULL,
        renamed_by TEXT NOT NULL,
        PRIMARY KEY (kind, scope, old_id)
      );
      CREATE INDEX plant_id_aliases_new ON plant_id_aliases(kind, scope, new_id);
    `,
  },
  {
    // 0.11.0: a device profile may extend one base profile (its own part: what it adds and changes); an assignment may
    // add data points and interfaces for its one asset (docs/adr/0007-plant-registry.md, "Update 0.11")
    name: 'plant-005-profile-extends',
    sql: `
      ALTER TABLE plant_profiles ADD COLUMN base_id TEXT;
      ALTER TABLE plant_profiles ADD COLUMN interface_overrides TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE plant_profiles ADD COLUMN point_overrides TEXT NOT NULL DEFAULT '[]';
      CREATE INDEX plant_profiles_base ON plant_profiles(base_id);
      ALTER TABLE plant_assignments ADD COLUMN additions TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    // 0.11.0: data collections – what a collector reads from an asset, its items mapped to data points – and the
    // gateway name → data point pairs remembered from imports (docs/adr/0019-data-collections.md)
    name: 'plant-006-collections',
    sql: `
      CREATE TABLE plant_collections (
        asset_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        collector TEXT NOT NULL,
        data_path_id TEXT,
        interface_id TEXT,
        mode TEXT NOT NULL DEFAULT 'interval',
        interval_ms INTEGER,
        debounce_ms INTEGER,
        triggers TEXT NOT NULL DEFAULT '[]',
        composition TEXT NOT NULL DEFAULT '',
        destination TEXT,
        access TEXT NOT NULL DEFAULT '{}',
        settings TEXT NOT NULL DEFAULT '[]',
        items TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL DEFAULT '',
        source_file TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        import_id TEXT,
        not_in_source INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        PRIMARY KEY (asset_id, id)
      );
      CREATE TABLE plant_collection_mappings (
        collector_key TEXT NOT NULL,
        asset_id TEXT NOT NULL DEFAULT '',
        gateway_name TEXT NOT NULL,
        data_point TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (collector_key, asset_id, gateway_name)
      );
    `,
  },
  {
    // 0.11: where a zone sits in the Purdue levels (field … external); null: the OT network diagram derives one
    name: 'plant-007-zone-level',
    sql: `ALTER TABLE plant_zones ADD COLUMN level TEXT;`,
  },
];
