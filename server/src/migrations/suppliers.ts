import type { NamedMigration } from '../db.js';

/**
 * Suppliers (0.17.0, ADR 0029 part 1, docs/SUPPLIERS.md). Additive only.
 *
 * suppliers: who runs, backs up, patches and recovers what a service team uses – type, description, website, owners
 *   (subjects, like systems), whether it processes personal data and its data processing agreement, status
 *   (unconfirmed: made from a free-text vendor on upgrade; active; archived), the free-text spellings it was made from
 *   or merged with (`aliases`) and `norm_name` (normVendor of the name: letters and digits, legal forms left out).
 * supplier_contacts: people at the supplier (personal data of people outside Steward: never in /api/v1, MCP, datasets,
 *   exports or audit details); removing one deletes it.
 * supplier_contracts: term, notice period, renewal, the document, the SLA and contractual RTO/RPO (hours).
 * supplier_certificates: ISO/IEC 27001, SOC 2 … with what it covers, issued, valid until, the document, who looked at
 *   it and when.
 * supplier_reminders: reminders sent, once per item and key (certificate/contract, the date and the days ahead).
 * supplier_text_migrations: each distinct normalised free-text vendor per table, handled once by migrateVendorTexts()
 *   – its spellings, the outcome (linked, ignored, notSupplier) and the supplier.
 *
 * suppliers-002-links: the five free-text vendors get a nullable `supplier_id` (the text stays as a fallback), cost
 * plan lines the contract that pays for them, service duties the supplier they review.
 *
 * suppliers-003-contract-scope (0.18.0, ADR 0031): contracts get a scope of their own – owners (subjects, filled from
 * the supplier's owners), a master agreement (`parent_id`, one level), personal data and the data processing agreement
 * per contract (null: as the master, then the supplier), who made and changed it. supplier_contract_services: the
 * services a contract covers, each with its purpose; confirmed, or proposed by this upgrade from what already names the
 * contract (cost plan lines, cost entries and responsibility matrix rows; the paying services of payment schedules are
 * confirmed). supplier_contact_scopes: the contracts, applications and systems a contact is about (none: company-wide).
 * The settings row 'catalogue.supplierContractScope' asks the server to audit the upgrade once and to show
 * administrators the notice that contracts may now be seen by fewer people (suppliers/contract-scope.ts).
 *
 * suppliers-004-contract-links (0.18.0, ADR 0031): a service duty and a corrective action finding can name a contract
 * of their supplier; supplier_merge_dismissals remembers the groups of "Same supplier in several teams" an
 * administrator kept separate (the group key: the normalised name and the suppliers' ids).
 */
export const SUPPLIER_MIGRATIONS: NamedMigration[] = [
  {
    name: 'suppliers-001-suppliers',
    sql: `
      CREATE TABLE suppliers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        norm_name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        description TEXT NOT NULL DEFAULT '',
        website TEXT NOT NULL DEFAULT '',
        owners TEXT NOT NULL DEFAULT '[]',
        personal_data INTEGER NOT NULL DEFAULT 0,
        dpa_status TEXT,
        dpa_since TEXT,
        dpa_link TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        aliases TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX suppliers_norm ON suppliers(norm_name);
      CREATE INDEX suppliers_status ON suppliers(status);

      CREATE TABLE supplier_contacts (
        id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL REFERENCES suppliers(id),
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'other',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX supplier_contacts_supplier ON supplier_contacts(supplier_id);

      CREATE TABLE supplier_contracts (
        id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL REFERENCES suppliers(id),
        title TEXT NOT NULL,
        reference TEXT NOT NULL DEFAULT '',
        starts_on TEXT,
        ends_on TEXT,
        notice_days INTEGER,
        renewal TEXT NOT NULL DEFAULT 'fixedEnd',
        renewal_months INTEGER,
        sla_availability REAL,
        sla_support_hours TEXT NOT NULL DEFAULT '',
        sla_response TEXT NOT NULL DEFAULT '',
        rto_hours REAL,
        rpo_hours REAL,
        link TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX supplier_contracts_supplier ON supplier_contracts(supplier_id);

      CREATE TABLE supplier_certificates (
        id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL REFERENCES suppliers(id),
        kind TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        issuer TEXT NOT NULL DEFAULT '',
        issued_on TEXT,
        valid_until TEXT,
        link TEXT NOT NULL DEFAULT '',
        checked_by TEXT,
        checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX supplier_certificates_supplier ON supplier_certificates(supplier_id);

      CREATE TABLE supplier_reminders (
        item_id TEXT NOT NULL,
        reminder_key TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (item_id, reminder_key)
      );

      CREATE TABLE supplier_text_migrations (
        table_name TEXT NOT NULL,
        norm_text TEXT NOT NULL,
        spellings TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL,
        supplier_id TEXT,
        rows_linked INTEGER NOT NULL DEFAULT 0,
        migrated_at TEXT NOT NULL,
        PRIMARY KEY (table_name, norm_text)
      );
      CREATE INDEX supplier_text_migrations_supplier ON supplier_text_migrations(supplier_id);
    `,
  },
  {
    name: 'suppliers-002-links',
    sql: `
      ALTER TABLE applications ADD COLUMN supplier_id TEXT;
      ALTER TABLE systems ADD COLUMN supplier_id TEXT;
      ALTER TABLE ticket_refs ADD COLUMN supplier_id TEXT;
      ALTER TABLE cd_watches ADD COLUMN supplier_id TEXT;
      ALTER TABLE cost_plan_lines ADD COLUMN supplier_id TEXT;
      ALTER TABLE cost_plan_lines ADD COLUMN supplier_contract_id TEXT;
      ALTER TABLE service_duties ADD COLUMN supplier_id TEXT;
      CREATE INDEX applications_supplier ON applications(supplier_id);
      CREATE INDEX systems_supplier ON systems(supplier_id);
      CREATE INDEX ticket_refs_supplier ON ticket_refs(supplier_id);
      CREATE INDEX cd_watches_supplier ON cd_watches(supplier_id);
      CREATE INDEX cost_plan_lines_supplier ON cost_plan_lines(supplier_id);
      CREATE INDEX cost_plan_lines_contract ON cost_plan_lines(supplier_contract_id);
      CREATE INDEX service_duties_supplier ON service_duties(supplier_id);
    `,
  },
  {
    name: 'suppliers-003-contract-scope',
    sql: `
      ALTER TABLE supplier_contracts ADD COLUMN owners TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE supplier_contracts ADD COLUMN parent_id TEXT;
      ALTER TABLE supplier_contracts ADD COLUMN personal_data INTEGER;
      ALTER TABLE supplier_contracts ADD COLUMN dpa_status TEXT;
      ALTER TABLE supplier_contracts ADD COLUMN dpa_since TEXT;
      ALTER TABLE supplier_contracts ADD COLUMN dpa_link TEXT;
      ALTER TABLE supplier_contracts ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
      ALTER TABLE supplier_contracts ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';
      CREATE INDEX supplier_contracts_parent ON supplier_contracts(parent_id);
      UPDATE supplier_contracts SET owners = COALESCE((SELECT s.owners FROM suppliers s WHERE s.id = supplier_contracts.supplier_id), '[]');

      CREATE TABLE supplier_contract_services (
        contract_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'confirmed',
        proposed_from TEXT NOT NULL DEFAULT '[]',
        added_by TEXT NOT NULL DEFAULT '',
        added_at TEXT NOT NULL,
        confirmed_by TEXT,
        confirmed_at TEXT,
        PRIMARY KEY (contract_id, service_id)
      );
      CREATE INDEX supplier_contract_services_service ON supplier_contract_services(service_id);

      INSERT INTO supplier_contract_services (contract_id, service_id, purpose, status, proposed_from, added_by, added_at, confirmed_by, confirmed_at)
        SELECT x.contract_id, x.service_id, '', 'confirmed', '["paymentSchedule"]', 'system', MAX(c.updated_at), 'system', MAX(c.updated_at)
          FROM cost_schedules x JOIN supplier_contracts c ON c.id = x.contract_id JOIN services s ON s.id = x.service_id
         GROUP BY x.contract_id, x.service_id;
      INSERT INTO supplier_contract_services (contract_id, service_id, purpose, status, proposed_from, added_by, added_at, confirmed_by, confirmed_at)
        SELECT x.contract_id, x.service_id, '', 'proposed', '', 'system', MAX(c.updated_at), NULL, NULL
          FROM (
            SELECT supplier_contract_id AS contract_id, service_id FROM cost_plan_lines WHERE supplier_contract_id IS NOT NULL
            UNION SELECT supplier_contract_id AS contract_id, service_id FROM cost_entries WHERE supplier_contract_id IS NOT NULL
            UNION SELECT contract_id, service_id FROM service_responsibilities WHERE contract_id IS NOT NULL
          ) x JOIN supplier_contracts c ON c.id = x.contract_id JOIN services s ON s.id = x.service_id
         WHERE NOT EXISTS (SELECT 1 FROM supplier_contract_services y WHERE y.contract_id = x.contract_id AND y.service_id = x.service_id)
         GROUP BY x.contract_id, x.service_id;
      UPDATE supplier_contract_services SET proposed_from = proposed_from || ',"costPlanLine"' WHERE status = 'proposed' AND EXISTS (
        SELECT 1 FROM cost_plan_lines l WHERE l.supplier_contract_id = supplier_contract_services.contract_id AND l.service_id = supplier_contract_services.service_id);
      UPDATE supplier_contract_services SET proposed_from = proposed_from || ',"costEntry"' WHERE status = 'proposed' AND EXISTS (
        SELECT 1 FROM cost_entries e WHERE e.supplier_contract_id = supplier_contract_services.contract_id AND e.service_id = supplier_contract_services.service_id);
      UPDATE supplier_contract_services SET proposed_from = proposed_from || ',"responsibility"' WHERE status = 'proposed' AND EXISTS (
        SELECT 1 FROM service_responsibilities r WHERE r.contract_id = supplier_contract_services.contract_id AND r.service_id = supplier_contract_services.service_id);
      UPDATE supplier_contract_services SET proposed_from = '[' || substr(proposed_from, 2) || ']' WHERE status = 'proposed';

      CREATE TABLE supplier_contact_scopes (
        contact_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        PRIMARY KEY (contact_id, kind, item_id)
      );
      CREATE INDEX supplier_contact_scopes_item ON supplier_contact_scopes(kind, item_id);

      INSERT INTO settings (key, value) SELECT 'catalogue.supplierContractScope', '{"pending":true}' WHERE EXISTS (SELECT 1 FROM supplier_contracts);
    `,
  },
  {
    name: 'suppliers-004-contract-links',
    sql: `
      ALTER TABLE service_duties ADD COLUMN supplier_contract_id TEXT;
      ALTER TABLE ca_findings ADD COLUMN supplier_contract_id TEXT;
      CREATE INDEX service_duties_supplier_contract ON service_duties(supplier_contract_id);
      CREATE INDEX ca_findings_supplier_contract ON ca_findings(supplier_contract_id);

      CREATE TABLE supplier_merge_dismissals (
        group_key TEXT PRIMARY KEY,
        dismissed_by TEXT NOT NULL,
        dismissed_at TEXT NOT NULL
      );
    `,
  },
];
