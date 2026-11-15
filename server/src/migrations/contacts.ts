import type { NamedMigration } from '../db.js';

/**
 * The contacts directory (0.25.1, ADR 0038 part 1, docs/CONTACTS.md). Additive only. A list of its own after the
 * tables it links to (the order is history).
 *
 * contacts-001-directory:
 *   contacts: the people and groups items name for their business side – kind (person, group), name and its
 *     normalised form (`name_norm`: NFKC, lower case, single spaces), e-mail and `email_norm` (lower case, trimmed; ''
 *     for none – several contacts may share one: who may not see a contact never learns that its address is known, so a
 *     new one is made, and administrators see the pair under Possible duplicates), phone, organisational unit, a URL,
 *     the Steward user it is (`user_id`, users.id, documentation only – never a right), status (active, left) and who
 *     made and changed it. Personal data of people who often have no account: in backups and migration packages,
 *     never in an audit entry's details beyond the name.
 *   contact_links: a contact named on an item with a role – kind (CONTACT_LINK_ROLES: service, supplier, plant_site,
 *     data_product …), the item's id, the role (a fixed list per kind, or free text), the position in the item's list,
 *     who linked it and when. One row per kind, item, role and contact; who sees a contact is computed from these rows
 *     (contacts/visibility.ts), so the index on contact_id serves the directory's pages.
 */
/*
 * contacts-002-roles (0.26.0, ADR 0039 parts 1 and 3):
 *   contact_roles: the role catalogue (Settings → Contacts → Roles) – key, English and German label, a description, the
 *     kinds it applies to (JSON array of link kinds: switched on), one or many contacts per item (`cardinality`),
 *     `expected` (an item without one gets a hint), built-in (CONTACT_LINK_ROLES: never deleted or re-keyed, kinds only
 *     a part of their seed), active (switched off: no new links, existing ones stay and are marked), a position for
 *     the order, where it came from (`source`: 'plant_site_text' for a role the upgrade made from a site's free text –
 *     shown only to who sees a site that names it until an administrator saves it, '' otherwise) and who made and
 *     changed it. The built-in roles – every role of before, keys and kinds unchanged, so
 *     no link changes, and the new ones of applications and systems – are part of the catalogue from the start
 *     (CONTACT_LINK_ROLES, BUILT_IN_CONTACT_ROLE_LABELS); a row of a built-in role holds what an administrator changed
 *     (no rows are inserted here: a new installation's tables stay empty, as a migration package's target needs them).
 *     Plant sites' free-text roles become own roles when the vault is first opened (contacts/upgrade.ts
 *     convertPlantSiteRoles, audited, idempotent).
 *   contact_links.deputy_of: stands in for that contact (contacts.id) in the same role on the same item, or NULL.
 *   contact_links.until: named until that day (YYYY-MM-DD), or NULL: after it the link is marked ended.
 */
export const CONTACTS_MIGRATIONS: NamedMigration[] = [
  {
    name: 'contacts-001-directory',
    sql: `
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'person',
        name TEXT NOT NULL,
        name_norm TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        email_norm TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        org_unit TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        user_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX contacts_name_norm ON contacts(name_norm);
      CREATE INDEX contacts_email_norm ON contacts(email_norm);
      CREATE INDEX contacts_user ON contacts(user_id);

      CREATE TABLE contact_links (
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        role TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES contacts(id),
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (kind, item_id, role, contact_id)
      );
      CREATE INDEX contact_links_contact ON contact_links(contact_id);
    `,
  },
  {
    name: 'contacts-002-roles',
    sql: `
      CREATE TABLE contact_roles (
        key TEXT PRIMARY KEY,
        label_en TEXT NOT NULL,
        label_de TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        kinds TEXT NOT NULL DEFAULT '[]',
        cardinality TEXT NOT NULL DEFAULT 'many',
        expected INTEGER NOT NULL DEFAULT 0,
        built_in INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 1000,
        source TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      ALTER TABLE contact_links ADD COLUMN deputy_of TEXT;
      ALTER TABLE contact_links ADD COLUMN until TEXT;
    `,
  },
];
