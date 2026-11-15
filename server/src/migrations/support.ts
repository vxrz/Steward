import type { NamedMigration } from '../db.js';

/**
 * Support channels, support levels and guides (0.26.0, ADR 0039 parts 4–6, docs/SUPPORT.md). Additive only. A list of
 * its own after the tables it describes (the order is history: data products, services and applications come from
 * earlier lists).
 *
 * support-001-channels-levels:
 *   support_levels: the administrators' catalogue (Settings → Support levels) – names in English and German, hours, one
 *     first-response time as text, a note, the address of the SLA document, the position in the list, and
 *     `legacy_tier`: the support tier (1–3) the upgrade made the level from, for the deprecated `tier` of the API
 *     (0.26 only; NULL for every other level). Who made and changed it.
 *   support_channels: the channels of an item, polymorphic – kind (data_product, service, application), the item's id,
 *     purpose, tool, name, address, hours, note and the position in the item's list. Who added it.
 *   guides: where the consumers of an item find guides and documentation (data products) – the same kind and item,
 *     title, external address, position, who added it.
 *   dp_products, services, applications: support_level_id (support_levels.id, NULL: none);
 *   dp_products.supported_by_service_id: the service that supports the product (services.id, NULL: none).
 *
 * The data of before – a product's `support` (channel, url, hours) and `tier` – becomes a channel and a level once the
 * vault is open (support/upgrade.ts, audited); both columns stay, emptied.
 */
export const SUPPORT_MIGRATIONS: NamedMigration[] = [
  {
    name: 'support-001-channels-levels',
    sql: `
      CREATE TABLE support_levels (
        id TEXT PRIMARY KEY,
        name_en TEXT NOT NULL,
        name_de TEXT NOT NULL DEFAULT '',
        hours TEXT NOT NULL DEFAULT '',
        first_response TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        sla_url TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        legacy_tier INTEGER,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE support_channels (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        tool TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        hours TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE INDEX support_channels_item ON support_channels(kind, item_id, position);

      CREATE TABLE guides (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE INDEX guides_item ON guides(kind, item_id, position);

      ALTER TABLE dp_products ADD COLUMN support_level_id TEXT;
      ALTER TABLE dp_products ADD COLUMN supported_by_service_id TEXT;
      ALTER TABLE services ADD COLUMN support_level_id TEXT;
      ALTER TABLE applications ADD COLUMN support_level_id TEXT;
    `,
  },
];
