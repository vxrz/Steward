import type { NamedMigration } from '../db.js';

/**
 * Data products: Steward documents governance, it doesn't run it (0.25.1, ADR 0038 parts 2–6). A list of its own after
 * the tables it reads (the order is history: `resource_shares` and its `rights` column come from earlier lists).
 *
 * dataproducts-007a-owner-shares (ADR 0038 part 2 – owner fields give no rights):
 *   Until 0.25.0 a product's owners and a domain's owners had View, Edit and Manage on it, a data object's owner and
 *   stewards View – computed from the fields. From 0.25.1 the fields are documentation. Every `user:` or `team:` subject
 *   of such a field (lower case and trimmed, as deciding compared them; a data object's owner is a user name, so
 *   `user:<owner>`) that does not already hold the level without an end date gets an **explicit share** with exactly
 *   that level: Manage on its product or domain, View on its data object. An existing share of the subject is raised to
 *   the level and loses its end date (a Manage share until a date is Manage for good: the owner had it for good). Data
 *   objects and domains had no shares before (they become kinds of the shares core with this release), so a share is
 *   never lowered and a level above the one needed never kept with an end date.
 *   dp_owner_share_conversions records each share made or raised (the level before and its end date) – the evidence
 *   of the conversion; the access-change audit entries (`access.share_added`, `access.share_changed`) are written once
 *   the vault is open (dataproducts/governance-upgrade.ts: the audit log needs its key), and `audited_at` says so. The
 *   owner fields stay as they were. Running the conversion twice changes nothing (it only adds what is missing).
 *
 * dataproducts-007b-documented-access (ADR 0038 parts 3 and 4 – access is documented, not requested):
 *   dp_consumers.approval: `documented` (a decision made elsewhere is recorded) or `notDocumented` (none yet – every
 *     registration made before 0.25.1, and the pending requests the upgrade turns into registrations);
 *   dp_consumers.decision: the documented decision (JSON, DocumentedDecision of shared/src/contacts.ts), NULL: none;
 *   dp_consumers.ticket_id, run_id: the optional fulfilment – the platform ticket as a ticket reference and the run of
 *     the platform team's process (as before on an approval);
 *   dp_consumers.request_id: the access request a registration came from (approved before 0.25.1, or pending then);
 *   dp_access_requests stay as read-only history; the upgrade (dataproducts/governance-upgrade.ts, audited) turns
 *     pending ones into registrations (status `converted`, consumer_id set).
 *   dp_port_reviews.decision: the review's documented decision (JSON, NULL for reviews before 0.25.1 – their seal does
 *     not cover it and still verifies); documented: 1 for reviews started since 0.25.1, which need one to be submitted. Four eyes is the module setting `portReviewFourEyes` (off by default); a review
 *     keeps the four_eyes it was started with.
 */

type Dialect = 'sqlite' | 'pg';

const NOW: Record<Dialect, string> = {
  sqlite: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  pg: `to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
};

const RANK = (col: string) => `CASE ${col} WHEN 'view' THEN 1 WHEN 'edit' THEN 2 WHEN 'manage' THEN 3 ELSE 0 END`;

/** The subjects of a JSON array column, one row each (`kind`, `rid`, `subj`, `lvl`, `field`). */
function subjectsOf(d: Dialect, table: string, column: string, kind: string, level: string): string {
  if (d === 'sqlite')
    return `SELECT '${kind}' AS kind, t.id AS rid, lower(trim(j.value)) AS subj, '${level}' AS lvl, '${column}' AS field
      FROM ${table} t, json_each(CASE WHEN json_valid(t.${column}) AND json_type(t.${column}) = 'array' THEN t.${column} ELSE '[]' END) j
      WHERE j.type = 'text'`;
  return `SELECT '${kind}' AS kind, t.id AS rid, lower(trim(j.value)) AS subj, '${level}' AS lvl, '${column}' AS field
      FROM ${table} t
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.${column}::jsonb) = 'array' THEN t.${column}::jsonb ELSE '[]'::jsonb END) AS j(value)`;
}

/** Everyone an owner field named, with the level it gave. */
function named(d: Dialect): string {
  return [
    subjectsOf(d, 'dp_products', 'owners', 'data_product', 'manage'),
    subjectsOf(d, 'dp_domains', 'owners', 'data_domain', 'manage'),
    `SELECT 'data_object' AS kind, t.id AS rid, 'user:' || lower(trim(t.owner)) AS subj, 'view' AS lvl, 'owner' AS field
      FROM dp_objects t WHERE t.owner IS NOT NULL AND trim(t.owner) <> ''`,
    subjectsOf(d, 'dp_objects', 'stewards', 'data_object', 'view'),
  ].join('\n    UNION ALL\n    ');
}

/**
 * The conversion (exported for the proof, dataproducts-owner-shares.test.ts): who gets a share, recorded, then the
 * shares added or raised.
 */
export function ownerShareConversion(dialect: 'sqlite' | 'postgres'): string {
  const d: Dialect = dialect === 'sqlite' ? 'sqlite' : 'pg';
  return `
    INSERT INTO dp_owner_share_conversions (kind, resource_id, subject, field, level, before_level, before_expires_at, converted_at)
    SELECT n.kind, n.rid, n.subj, MIN(n.field), MAX(n.lvl), MAX(s.level), MAX(s.expires_at), ${NOW[d]}
    FROM (${named(d)}) n
    LEFT JOIN resource_shares s ON s.kind = n.kind AND s.resource_id = n.rid AND s.subject = n.subj
    WHERE (n.subj LIKE 'user:_%' OR n.subj LIKE 'team:_%')
      AND NOT EXISTS (
        SELECT 1 FROM resource_shares x WHERE x.kind = n.kind AND x.resource_id = n.rid AND x.subject = n.subj
          AND x.expires_at IS NULL AND ${RANK('x.level')} >= ${RANK('n.lvl')}
      )
      AND NOT EXISTS (SELECT 1 FROM dp_owner_share_conversions c WHERE c.kind = n.kind AND c.resource_id = n.rid AND c.subject = n.subj)
    GROUP BY n.kind, n.rid, n.subj;
    INSERT INTO resource_shares (kind, resource_id, subject, level, actions, expires_at, created_by, created_at)
    SELECT c.kind, c.resource_id, c.subject, c.level, '[]', NULL, 'system', c.converted_at
    FROM dp_owner_share_conversions c
    WHERE c.audited_at IS NULL
    ON CONFLICT (kind, resource_id, subject) DO UPDATE SET
      level = CASE WHEN ${RANK('resource_shares.level')} > ${RANK('excluded.level')} THEN resource_shares.level ELSE excluded.level END,
      expires_at = NULL,
      reminded_at = NULL;
  `;
}

const ownerShares = (d: Dialect): string =>
  `
    CREATE TABLE dp_owner_share_conversions (
      kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      field TEXT NOT NULL,
      level TEXT NOT NULL,
      before_level TEXT,
      before_expires_at TEXT,
      converted_at TEXT NOT NULL,
      audited_at TEXT,
      PRIMARY KEY (kind, resource_id, subject)
    );
    ${ownerShareConversion(d === 'sqlite' ? 'sqlite' : 'postgres')}
  `;

export const DATA_GOVERNANCE_MIGRATIONS: NamedMigration[] = [
  {
    name: 'dataproducts-007a-owner-shares',
    sql: ownerShares('sqlite'),
    pg: ownerShares('pg'),
  },
  {
    name: 'dataproducts-007b-documented-access',
    sql: `
      ALTER TABLE dp_consumers ADD COLUMN approval TEXT NOT NULL DEFAULT 'notDocumented';
      ALTER TABLE dp_consumers ADD COLUMN decision TEXT;
      ALTER TABLE dp_consumers ADD COLUMN ticket_id TEXT;
      ALTER TABLE dp_consumers ADD COLUMN run_id TEXT;
      ALTER TABLE dp_consumers ADD COLUMN request_id TEXT;
      ALTER TABLE dp_port_reviews ADD COLUMN decision TEXT;
      ALTER TABLE dp_port_reviews ADD COLUMN documented INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // ADR 0038 part 5: endorsements and semantic model sign-offs are documented approvals – who approved elsewhere
    // (contacts, frozen), when, the evidence (JSON, DocumentedDecision). NULL for those of before 0.25.1 until the
    // upgrade (dataproducts/governance-upgrade.ts) gives them one from the Steward user who endorsed or signed off – a
    // person contact linked to that user. The contacts directory's tables come from an earlier list.
    name: 'dataproducts-007c-documented-approvals',
    sql: `
      ALTER TABLE dp_endorsements ADD COLUMN decision TEXT;
      ALTER TABLE dp_semantic_signoffs ADD COLUMN decision TEXT;
    `,
  },
];
