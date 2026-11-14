import { DATA_PRODUCT_ID_PREFIX, type ContactLinkInput, type ContactSnapshot } from '@sm/shared';
import { contactForUser, importContact, linksOf, setLinks } from '../contacts/service.js';
import { linksOfSubjects } from './contacts.js';
import { decisionOfUsers } from './decisions.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { ACCESS_AUDIT, auditAccessChange } from '../auth/access-change.js';
import { logger } from '../log.js';
import { newId, nowIso, parseJson } from '../util.js';

/**
 * The upgrade to documented governance (0.25.1, ADR 0038), the parts that need the open vault – the audit log needs its
 * key. Called once the vault is open (routes/auth.ts) and after a migration package is imported (migration/import.ts);
 * each step is idempotent and does only what is still open.
 *
 * 1. **Owner shares** (part 2): the migration `dataproducts-007a-owner-shares` made the shares that keep who held a
 *    right only through an owner field (dp_owner_share_conversions); here each is audited in the access family –
 *    `access.share_added`, or `access.share_changed` where a share of the subject was raised – once.
 * 2. **Pending access requests** (part 3) become registrations of their port whose approval is not documented, for
 *    the IT maintainers to complete or remove: the consumer, purpose, end date, agreement and identities of the
 *    request, the requester as its contact; the request is `converted` and names the registration. Audited per
 *    request (`dataproduct.access_request_converted`). A request whose port is gone stays as it was.
 * 3. **Owner fields become contacts** (part 2, after the shares of step 1 were made): a product's owners (productOwner),
 *    a domain's owners (domainOwner), a data object's data owner and stewards (dataOwner, dataSteward) and a
 *    registration's contacts (consumerContact) – `user:` the person contact linked to that account (made with the
 *    account's name and e-mail address when there is none), `team:` a group contact named after the team. The item's
 *    other contacts stay; its old field is emptied in the same transaction, so a second run finds nothing. Audited per
 *    item (`dataproduct.contacts_converted`, `datadomain.…`, `dataobject.…`).
 * 4. **Approved requests** (part 3): the registration an approval made gets a documented decision from it – the
 *    approvers as contacts linked to their accounts, the day, the request as evidence, the comment as note.
 * 5. **Endorsements and semantic model sign-offs** (part 5) keep their Steward users as contacts linked to them.
 *
 * Steps 3–5 need the contacts directory's tables (an earlier migration list).
 */

interface ConversionRow {
  kind: string;
  resource_id: string;
  subject: string;
  field: string;
  level: string;
  before_level: string | null;
  before_expires_at: string | null;
  converted_at: string;
}

const LEVEL: Record<string, string> = { view: 'View', edit: 'Edit', manage: 'Manage' };
const TABLE: Record<string, string> = { data_product: 'dp_products', data_domain: 'dp_domains', data_object: 'dp_objects' };
const WHAT: Record<string, string> = { data_product: 'Data product', data_domain: 'Data domain', data_object: 'Data object' };
const FIELD: Record<string, string> = { owners: 'an owner', owner: 'its data owner', stewards: 'a steward' };

/** Audits the owner shares the upgrade made (part 2), once each. Returns the number audited. */
export function auditOwnerShareConversions(): number {
  const rows = db().all<ConversionRow>('SELECT * FROM dp_owner_share_conversions WHERE audited_at IS NULL ORDER BY kind, resource_id, subject');
  if (!rows.length) return 0;
  const names = new Map<string, string>();
  for (const kind of Object.keys(TABLE)) {
    const ids = [...new Set(rows.filter((r) => r.kind === kind).map((r) => r.resource_id))];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const n of db().all<{ id: string; name: string }>(`SELECT id, name FROM ${TABLE[kind]} WHERE id IN (${part.map(() => '?').join(', ')})`, ...part))
        names.set(`${kind}:${n.id}`, n.name);
    }
  }
  const now = nowIso();
  db().tx(() => {
    for (const r of rows) {
      const name = names.get(`${r.kind}:${r.resource_id}`);
      const label = `${WHAT[r.kind] ?? r.kind}${name === undefined ? ` ${r.resource_id}` : ` "${name}"`}`;
      const raised = !!r.before_level;
      auditAccessChange({
        actor: 'system',
        action: raised ? ACCESS_AUDIT.shareChanged : ACCESS_AUDIT.shareAdded,
        entityType: r.kind,
        entityId: r.resource_id,
        summary: `${label}: ${r.subject} ${raised ? 'keeps' : 'gets'} ${LEVEL[r.level] ?? r.level} as a share – named as ${FIELD[r.field] ?? r.field}, which gives no right from 0.25.1 (upgrade)`,
        details: {
          subject: r.subject,
          after: { level: r.level, actions: [], expiresAt: null },
          ...(raised ? { before: { level: r.before_level, expiresAt: r.before_expires_at } } : {}),
          granted: [],
          upgrade: { release: '0.25.1', reason: 'ownerFieldNoRights', field: r.field, convertedAt: r.converted_at },
        },
      });
      db().run(
        'UPDATE dp_owner_share_conversions SET audited_at = ? WHERE kind = ? AND resource_id = ? AND subject = ?',
        now,
        r.kind,
        r.resource_id,
        r.subject,
      );
    }
  });
  return rows.length;
}

interface PendingRow {
  id: string;
  product_id: string;
  port_id: string;
  environment: string;
  requester: string;
  consumer_kind: string;
  ref_id: string | null;
  consumer_subjects: string;
  consumer_text: string;
  purpose: string;
  until_date: string | null;
  agreement: string | null;
  identities: string;
  port_name: string;
  product_name: string;
}

/** Turns the access requests pending at the upgrade into registrations whose approval is not documented (part 3). */
export function convertPendingRequests(): number {
  const rows = db().all<PendingRow>(
    `SELECT r.*, p.name AS port_name, pr.name AS product_name FROM dp_access_requests r
       JOIN dp_ports p ON p.id = r.port_id AND p.product_id = r.product_id AND p.direction = 'output'
       JOIN dp_products pr ON pr.id = r.product_id
     WHERE r.status = 'pending' ORDER BY r.created_at, r.id`,
  );
  if (!rows.length) return 0;
  const now = nowIso();
  db().tx(() => {
    for (const r of rows) {
      const id = newId(DATA_PRODUCT_ID_PREFIX.consumer);
      db().run(
        `INSERT INTO dp_consumers (id, port_id, consumer_kind, ref_id, consumer_subjects, consumer_text, purpose, since, end_date, agreement, contacts,
           approval, request_id, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'notDocumented', ?, ?, 'system', ?, 'system')`,
        id,
        r.port_id,
        r.consumer_kind,
        r.ref_id,
        r.consumer_subjects,
        r.consumer_text,
        r.purpose,
        r.until_date,
        r.agreement,
        JSON.stringify([`user:${r.requester.toLowerCase()}`]),
        r.id,
        now,
        now,
      );
      for (const i of [...new Set(parseJson<string[]>(r.identities, []).map((x) => String(x).trim()))].filter(Boolean).slice(0, 50))
        db().run('INSERT INTO dp_consumer_identities (consumer_id, identity) VALUES (?, ?) ON CONFLICT DO NOTHING', id, i);
      db().run("UPDATE dp_access_requests SET status = 'converted', consumer_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'", id, now, r.id);
      audit({
        actor: 'system',
        action: 'dataproduct.access_request_converted',
        entityType: 'data_product',
        entityId: r.product_id,
        summary: `Data product "${r.product_name}": the pending access request of ${r.requester} for port "${r.port_name}" (${r.environment}) became a registration whose approval is not documented (upgrade to 0.25.1)`,
        details: { requestId: r.id, consumerId: id, portId: r.port_id, environment: r.environment, requester: r.requester, release: '0.25.1' },
      });
    }
  });
  return rows.length;
}

// ---------- 3. owner fields become contacts ----------

const OWNER_FIELDS: readonly {
  kind: 'data_product' | 'data_domain' | 'data_object' | 'data_consumer';
  table: string;
  label: string;
  action: string;
  entity: string;
  columns: readonly { column: string; role: string; username?: true }[];
}[] = [
  {
    kind: 'data_product',
    table: 'dp_products',
    label: 'Data product',
    action: 'dataproduct.contacts_converted',
    entity: 'data_product',
    columns: [{ column: 'owners', role: 'productOwner' }],
  },
  {
    kind: 'data_domain',
    table: 'dp_domains',
    label: 'Data domain',
    action: 'datadomain.contacts_converted',
    entity: 'data_domain',
    columns: [{ column: 'owners', role: 'domainOwner' }],
  },
  {
    kind: 'data_object',
    table: 'dp_objects',
    label: 'Data object',
    action: 'dataobject.contacts_converted',
    entity: 'data_object',
    columns: [
      { column: 'owner', role: 'dataOwner', username: true },
      { column: 'stewards', role: 'dataSteward' },
    ],
  },
  {
    kind: 'data_consumer',
    table: 'dp_consumers',
    label: 'Consumer',
    action: 'dataproduct.contacts_converted',
    entity: 'data_product',
    columns: [{ column: 'contacts', role: 'consumerContact' }],
  },
];

/** The owner fields of before 0.25.1 as contact links, once (part 2). Returns the number of items converted. */
export function convertOwnerFields(): number {
  let n = 0;
  for (const f of OWNER_FIELDS) {
    const where = f.columns
      .map((c) => (c.username ? `(${c.column} IS NOT NULL AND ${c.column} <> '')` : `(${c.column} IS NOT NULL AND ${c.column} <> '[]')`))
      .join(' OR ');
    const extra = f.kind === 'data_consumer' ? ', (SELECT product_id FROM dp_ports WHERE id = t.port_id) AS product_id' : ', t.name AS name';
    const rows = db().all<Record<string, string | null>>(`SELECT t.* ${extra} FROM ${f.table} t WHERE ${where}`);
    for (const r of rows)
      db().tx(() => {
        const keep = linksOf(f.kind, [r.id!]).get(r.id!) ?? [];
        const links: ContactLinkInput[] = keep.map((k) => ({ role: k.role, contactId: k.contact.id }));
        const named: string[] = [];
        for (const c of f.columns) {
          const subjects = c.username ? (r[c.column] ? [`user:${r[c.column]}`] : []) : parseJson<unknown[]>(r[c.column] ?? '[]', []).map(String);
          for (const l of linksOfSubjects(subjects, c.role, { audit: false }))
            if (!links.some((x) => x.role === l.role && x.contactId === l.contactId)) {
              links.push(l);
              named.push(`${c.role}: ${subjects.join(', ')}`);
            }
        }
        setLinks(f.kind, r.id!, links);
        db().run(`UPDATE ${f.table} SET ${f.columns.map((c) => `${c.column} = ${c.username ? 'NULL' : "'[]'"}`).join(', ')} WHERE id = ?`, r.id);
        audit({
          actor: 'system',
          action: f.action,
          entityType: f.entity,
          entityId: f.kind === 'data_consumer' ? (r.product_id ?? r.id!) : r.id!,
          summary: `${f.label} ${f.kind === 'data_consumer' ? r.id : `"${r.name}"`}: the people named in it became contacts (upgrade to 0.25.1) – documentation, no right`,
          details: { kind: f.kind, itemId: r.id, contacts: links.map((l) => ({ role: l.role, contactId: l.contactId })), release: '0.25.1' },
        });
        n++;
      });
  }
  return n;
}

// ---------- 4. and 5. documented decisions of before 0.25.1 ----------

/** The person contacts of Steward users, frozen with a role (an account that is gone: a person contact of that name). */
function snapshotsOfUsers(usernames: readonly string[], role: string): ContactSnapshot[] {
  const out: ContactSnapshot[] = [];
  for (const name of [...new Set(usernames.filter(Boolean))]) {
    const c = contactForUser(name, { audit: false }) ?? importContact({ kind: 'person', name }, { audit: false });
    out.push({ contactId: c.id, name: c.name, role });
  }
  return out;
}

/** The registrations of approved requests get a documented decision from the approval (part 3). */
export function documentApprovedRequests(): number {
  const rows = db().all<{
    id: string;
    product_id: string;
    consumer_id: string;
    approvals: string;
    decided_by: string | null;
    decided_at: string | null;
    decision_comment: string;
    created_at: string;
  }>(
    `SELECT r.id, r.product_id, r.consumer_id, r.approvals, r.decided_by, r.decided_at, r.decision_comment, r.created_at FROM dp_access_requests r
       JOIN dp_consumers c ON c.id = r.consumer_id WHERE r.status = 'approved' AND c.decision IS NULL`,
  );
  for (const r of rows)
    db().tx(() => {
      const by = parseJson<{ by: string }[]>(r.approvals, []).map((a) => a.by);
      const at = r.decided_at ?? r.created_at;
      const d = decisionOfUsers(snapshotsOfUsers(by.length ? by : [r.decided_by ?? ''], 'approver'), at, r.decided_by ?? 'system', r.decision_comment, [
        { kind: 'text', value: `Access request ${r.id}, approved in Steward before 0.25.1` },
      ]);
      db().run(
        "UPDATE dp_consumers SET decision = ?, approval = 'documented', request_id = COALESCE(request_id, ?) WHERE id = ?",
        JSON.stringify(d),
        r.id,
        r.consumer_id,
      );
      audit({
        actor: 'system',
        action: 'dataproduct.access_documented',
        entityType: 'data_product',
        entityId: r.product_id,
        summary: `A registration approved through an access request is documented: decided by ${d.decidedBy.map((x) => x.name).join(', ')} on ${d.decidedOn} (upgrade to 0.25.1)`,
        details: { requestId: r.id, consumerId: r.consumer_id, decidedBy: d.decidedBy, decidedOn: d.decidedOn, release: '0.25.1' },
      });
    });
  return rows.length;
}

/** Endorsements and sign-offs of before 0.25.1 keep their Steward users as contacts linked to them (part 5). */
export function documentApprovals(): number {
  let n = 0;
  for (const r of db().all<{ product_id: string; endorsed_by: string; endorsed_at: string; note: string }>(
    'SELECT product_id, endorsed_by, endorsed_at, note FROM dp_endorsements WHERE decision IS NULL',
  ))
    db().tx(() => {
      const d = decisionOfUsers(snapshotsOfUsers([r.endorsed_by], 'domainOwner'), r.endorsed_at, r.endorsed_by, r.note);
      db().run('UPDATE dp_endorsements SET decision = ? WHERE product_id = ?', JSON.stringify(d), r.product_id);
      audit({
        actor: 'system',
        action: 'dataproduct.endorsement_documented',
        entityType: 'data_product',
        entityId: r.product_id,
        summary: `Endorsement by ${r.endorsed_by} kept as a documented endorsement of the contact linked to that user (upgrade to 0.25.1)`,
        details: { decidedBy: d.decidedBy, decidedOn: d.decidedOn, release: '0.25.1' },
      });
      n++;
    });
  for (const r of db().all<{ id: string; product_id: string; version: number; signed_by: string; signed_at: string; note: string }>(
    'SELECT id, product_id, version, signed_by, signed_at, note FROM dp_semantic_signoffs WHERE decision IS NULL',
  ))
    db().tx(() => {
      const d = decisionOfUsers(snapshotsOfUsers([r.signed_by], 'approver'), r.signed_at, r.signed_by, r.note);
      db().run('UPDATE dp_semantic_signoffs SET decision = ? WHERE id = ?', JSON.stringify(d), r.id);
      audit({
        actor: 'system',
        action: 'dataproduct.semantic_model_documented',
        entityType: 'data_product',
        entityId: r.product_id,
        summary: `Sign-off of semantic model version ${r.version} by ${r.signed_by} kept as a documented approval of the contact linked to that user (upgrade to 0.25.1)`,
        details: { version: Number(r.version), decidedBy: d.decidedBy, decidedOn: d.decidedOn, release: '0.25.1' },
      });
      n++;
    });
  return n;
}

/** Every open step of the upgrade (idempotent; never throws – a step that fails is tried again at the next start). */
export function convertDataProductGovernance(): void {
  for (const [name, step] of [
    ['owner shares', auditOwnerShareConversions],
    ['pending requests', convertPendingRequests],
    ['owner fields', convertOwnerFields],
    ['approved requests', documentApprovedRequests],
    ['endorsements and sign-offs', documentApprovals],
  ] as const)
    try {
      step();
    } catch (err) {
      logger.error({ err, step: name }, 'data products governance upgrade: a step failed – it is tried again at the next start');
    }
}
