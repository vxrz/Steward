import type { NamedMigration } from '../db.js';

/**
 * One access model, phase 2 (0.23.0, ADR 0033 "Migration", #297): the access lists of processes, platforms, platform
 * identities, monitors and plant sites become shares, one share per entry with exactly its rights. A list of its own
 * after the tables it reads (the order is history: these tables and `resource_shares` are created by earlier lists).
 *
 * access-001-acl-shares:
 *   resource_shares.rights: _Custom_ – the exact rights of an entry that no level and action rights express (a process
 *     entry with `manage` but not `edit`), JSON array in the kind's own rights; NULL for every other share.
 *   One share per subject of every `acl` entry with at least one right (several entries of one subject add up, as they
 *   did when deciding; entries without rights are dropped, as `setSiteAccess` dropped them):
 *   - process  `view/run/edit/approve/manage`: any right sees it; Manage when `manage` and `edit`, Edit when `edit`,
 *     else View; `run`, `approve` as action rights; `manage` without `edit` is Custom (its exact rights).
 *   - monitor  `view/acknowledge/edit/manage`: `manage` includes the others (Manage with `acknowledge`), Edit when
 *     `edit`, else View; `acknowledge` as action right.
 *   - site     `view/propose/manage`: Manage (with `propose`) when `manage`, else View; `propose` as action right.
 *   - platform `use/manage`: Manage when `manage`, else View; `use` always (`manage` includes `use`).
 *   - platform identity `use`: View with `use`.
 *   resource_restrictions: every process, monitor, site and platform whose list had entries is Restricted – without
 *   owning teams a non-empty list kept instance roles out, which is what Restricted means; with owning teams it changes
 *   nothing until the teams are removed, and then behaves as the list did. Identities stay closed by default.
 *   The `acl` columns stay as they were (no longer read); migration packages of older versions are migrated the same
 *   way on import (their staging database runs this migration).
 */

type Dialect = 'sqlite' | 'pg';

interface AclKind {
  kind: string;
  table: string;
  perms: readonly string[];
  /** SQL CASE for the level, from the h_<right> columns (0/1) */
  level: string;
  /** Action rights in alphabetical order (as cleanShares stores them), each with its condition */
  actions: readonly [string, string][];
  /** SQL for the Custom rights (a JSON array) or NULL */
  rights?: string;
  restrict: boolean;
}

/** A JSON array of the names whose condition holds, e.g. ["approve","run"] (conditions on h_<right>). */
const jsonList = (items: readonly [string, string][]): string =>
  items.length ? `'[' || rtrim(${items.map(([name, cond]) => `CASE WHEN ${cond} THEN '"${name}",' ELSE '' END`).join(' || ')}, ',') || ']'` : `'[]'`;

const KINDS: readonly AclKind[] = [
  {
    kind: 'process',
    table: 'processes',
    perms: ['view', 'run', 'edit', 'approve', 'manage'],
    level: `CASE WHEN h_manage = 1 AND h_edit = 1 THEN 'manage' WHEN h_edit = 1 THEN 'edit' ELSE 'view' END`,
    actions: [
      ['approve', 'h_approve = 1'],
      ['run', 'h_run = 1'],
    ],
    rights: `CASE WHEN h_manage = 1 AND h_edit = 0 THEN ${jsonList([
      ['approve', 'h_approve = 1'],
      ['manage', '1 = 1'],
      ['run', 'h_run = 1'],
      ['view', '1 = 1'],
    ])} ELSE NULL END`,
    restrict: true,
  },
  {
    kind: 'monitor',
    table: 'monitors',
    perms: ['view', 'acknowledge', 'edit', 'manage'],
    level: `CASE WHEN h_manage = 1 THEN 'manage' WHEN h_edit = 1 THEN 'edit' ELSE 'view' END`,
    actions: [['acknowledge', 'h_acknowledge = 1 OR h_manage = 1']],
    restrict: true,
  },
  {
    kind: 'site',
    table: 'plant_sites',
    perms: ['view', 'propose', 'manage'],
    level: `CASE WHEN h_manage = 1 THEN 'manage' ELSE 'view' END`,
    actions: [['propose', 'h_propose = 1 OR h_manage = 1']],
    restrict: true,
  },
  {
    kind: 'platform',
    table: 'platforms',
    perms: ['use', 'manage'],
    level: `CASE WHEN h_manage = 1 THEN 'manage' ELSE 'view' END`,
    actions: [['use', '1 = 1']],
    restrict: true,
  },
  {
    kind: 'platform_identity',
    table: 'platform_identities',
    perms: ['use'],
    level: `'view'`,
    actions: [['use', '1 = 1']],
    restrict: false,
  },
];

const NOW: Record<Dialect, string> = {
  sqlite: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  pg: `to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
};

/** The entries of every list, one row per entry and right (subject lower case and trimmed, as deciding compared them). */
function entries(k: AclKind, d: Dialect): string {
  if (d === 'sqlite')
    return `SELECT t.id AS rid, lower(trim(CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.subject') END)) AS subj, p.value AS perm
      FROM ${k.table} t,
        json_each(CASE WHEN json_valid(t.acl) AND json_type(t.acl) = 'array' THEN t.acl ELSE '[]' END) j,
        json_each(CASE WHEN j.type = 'object' THEN CASE WHEN json_type(j.value, '$.permissions') = 'array' THEN json_extract(j.value, '$.permissions') ELSE '[]' END ELSE '[]' END) p`;
  return `SELECT t.id AS rid, lower(trim(CASE WHEN jsonb_typeof(j.value) = 'object' THEN j.value->>'subject' END)) AS subj, p.value AS perm
      FROM ${k.table} t
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.acl::jsonb) = 'array' THEN t.acl::jsonb ELSE '[]'::jsonb END) AS j(value)
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(j.value) = 'object' AND jsonb_typeof(j.value->'permissions') = 'array' THEN j.value->'permissions' ELSE '[]'::jsonb END
      ) AS p(value)`;
}

function convert(k: AclKind, d: Dialect): string {
  const has = k.perms.map((p) => `max(CASE WHEN e.perm = '${p}' THEN 1 ELSE 0 END) AS h_${p}`).join(', ');
  const any = k.perms.map((p) => `h_${p}`).join(' + ');
  const shares = `INSERT INTO resource_shares (kind, resource_id, subject, level, actions, expires_at, created_by, created_at, rights)
    SELECT '${k.kind}', rid, subj, ${k.level}, ${jsonList(k.actions)}, NULL, 'system', ${NOW[d]}, ${k.rights ?? 'NULL'}
    FROM (SELECT e.rid, e.subj, ${has} FROM (${entries(k, d)}) e GROUP BY e.rid, e.subj) x
    WHERE ${any} > 0 AND (subj LIKE 'user:_%' OR subj LIKE 'team:_%' OR subj LIKE 'role:_%')
    ON CONFLICT DO NOTHING;`;
  if (!k.restrict) return shares;
  const listed =
    d === 'sqlite'
      ? `CASE WHEN json_valid(acl) THEN json_type(acl) = 'array' AND json_array_length(acl) > 0 ELSE 0 END`
      : `jsonb_typeof(acl::jsonb) = 'array' AND jsonb_array_length(acl::jsonb) > 0`;
  return `${shares}
    INSERT INTO resource_restrictions (kind, resource_id, created_by, created_at)
    SELECT '${k.kind}', id, 'system', ${NOW[d]} FROM ${k.table} WHERE ${listed}
    ON CONFLICT DO NOTHING;`;
}

const aclShares = (d: Dialect): string => ['ALTER TABLE resource_shares ADD COLUMN rights TEXT;', ...KINDS.map((k) => convert(k, d))].join('\n');

export const ACCESS_MIGRATIONS: NamedMigration[] = [
  {
    name: 'access-001-acl-shares',
    sql: aclShares('sqlite'),
    pg: aclShares('pg'),
  },
];
