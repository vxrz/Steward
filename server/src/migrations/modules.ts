import type { NamedMigration } from '../db.js';

/**
 * Module access (0.21.0, ADR 0034, docs/MODULES.md). Additive only: without a row a module is used by everyone signed
 * in, as before – an upgrade changes nothing.
 *
 * module_access: per module an administrator restricted (or opened again), its mode – `everyone` or `selected` – and
 *   who changed it when.
 * module_grants: the teams and users (`team:<name>`, `user:<name>`, the subject strings of access lists) that use a
 *   restricted module; `role` is for the module roles of a later version (null: uses it). A deleted team stays as a
 *   grant that matches nobody, so deleting a team never widens a restricted module. Keyed by an id of its own: a team
 *   renamed to the name of a deleted team's grant leaves two rows rather than failing the rename.
 * reports.modules: the restrictable modules whose sections a scheduled report holds (JSON array; null: none) – a
 *   recipient who does not use one of them reads the copy of the report without them instead.
 * module_grants.source (0.23.0, module roles): who keeps a grant – null for an administrator's (the access dialog, the
 *   user form), `sso` for one synchronised from single sign-on at each sign-in. The former instance role "plant" becomes
 *   a contributor grant of the plant registry in code, once the vault is open (modules/user-roles.ts
 *   convertDeprecatedRoles: it reads the roles as JSON and audits each account).
 */
export const MODULE_MIGRATIONS: NamedMigration[] = [
  {
    name: 'modules-001-access',
    sql: `
      CREATE TABLE module_access (
        module_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE module_grants (
        id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        role TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX module_grants_module ON module_grants(module_id);
    `,
  },
  {
    name: 'modules-002-report-modules',
    sql: `ALTER TABLE reports ADD COLUMN modules TEXT;`,
  },
  {
    name: 'modules-003-grant-source',
    sql: `ALTER TABLE module_grants ADD COLUMN source TEXT;`,
  },
];
