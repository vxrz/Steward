import { DATA_PRODUCT_ID_PREFIX } from '@sm/shared';
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

/** Every open step of the upgrade (idempotent; never throws – a step that fails is tried again at the next start). */
export function convertDataProductGovernance(): void {
  for (const [name, step] of [
    ['owner shares', auditOwnerShareConversions],
    ['pending requests', convertPendingRequests],
  ] as const)
    try {
      step();
    } catch (err) {
      logger.error({ err, step: name }, 'data products governance upgrade: a step failed – it is tried again at the next start');
    }
}
