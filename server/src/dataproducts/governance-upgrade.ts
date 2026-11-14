import { db } from '../db.js';
import { ACCESS_AUDIT, auditAccessChange } from '../auth/access-change.js';
import { logger } from '../log.js';
import { nowIso } from '../util.js';

/**
 * The upgrade to documented governance (0.25.1, ADR 0038), the parts that need the open vault – the audit log needs its
 * key. Called once the vault is open (routes/auth.ts) and after a migration package is imported (migration/import.ts);
 * each step is idempotent and does only what is still open.
 *
 * 1. **Owner shares** (part 2): the migration `dataproducts-007a-owner-shares` made the shares that keep who held a
 *    right only through an owner field (dp_owner_share_conversions); here each is audited in the access family –
 *    `access.share_added`, or `access.share_changed` where a share of the subject was raised – once.
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
      db().run('UPDATE dp_owner_share_conversions SET audited_at = ? WHERE kind = ? AND resource_id = ? AND subject = ?', now, r.kind, r.resource_id, r.subject);
    }
  });
  return rows.length;
}

/** Every open step of the upgrade (idempotent; never throws – a step that fails is tried again at the next start). */
export function convertDataProductGovernance(): void {
  for (const [name, step] of [['owner shares', auditOwnerShareConversions]] as const)
    try {
      step();
    } catch (err) {
      logger.error({ err, step: name }, 'data products governance upgrade: a step failed – it is tried again at the next start');
    }
}
