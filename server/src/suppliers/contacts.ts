import { db } from '../db.js';
import { parseJson } from '../util.js';
import { canViewCatalogue } from '../records/access.js';
import { moduleOnly } from '../auth/policy.js';
import type { AuthUser } from '../auth/context.js';
import type { ContactKindDef } from '../contacts/registry.js';
import { LegacyContactMatcher, writeItemLinks } from '../contacts/service.js';
import { ScopeCtx } from './contract-scope.js';
import { contactViews, supplierContactRowsById, type ContactRow, type SupplierRow } from './service.js';

/**
 * Suppliers as a link kind of the contacts directory (0.25.1, ADR 0038, docs/CONTACTS.md). The item of a link is the
 * supplier's contact entry (supplier_contacts: role, note and scope, ADR 0031), so who sees and who changes the person
 * through a supplier is exactly who sees and changes that entry: a company-wide entry – who sees the supplier; a scoped
 * one – who sees one of its items; administrators and auditors. The supplier permission logic is unchanged.
 */
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

function suppliersOf(ids: readonly string[]): Map<string, SupplierRow> {
  const out = new Map<string, SupplierRow>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 500) {
    const part = uniq.slice(i, i + 500);
    for (const r of db().all<SupplierRow>(`SELECT * FROM suppliers WHERE id IN (${marks(part.length)})`, ...part)) out.set(r.id, r);
  }
  return out;
}

/** The views of these entries as `u` sees them (contactViews per supplier, ScopeCtx of u), by entry id. */
function views(u: AuthUser, entryIds: readonly string[]) {
  const out = new Map<string, { canEdit: boolean; supplier: SupplierRow }>();
  if (moduleOnly(u)) return out;
  const rows = supplierContactRowsById(entryIds);
  const suppliers = suppliersOf(rows.map((r) => r.supplier_id));
  const ctx = new ScopeCtx(u);
  const bySupplier = new Map<string, ContactRow[]>();
  for (const r of rows) bySupplier.set(r.supplier_id, [...(bySupplier.get(r.supplier_id) ?? []), r]);
  for (const [sid, list] of bySupplier) {
    const s = suppliers.get(sid);
    if (!s || !canViewCatalogue(u, { kind: 'supplier', id: s.id, owners: parseJson<string[]>(s.owners, []) })) continue;
    for (const v of contactViews(s, list, ctx)) out.set(v.id, { canEdit: v.canEdit, supplier: s });
  }
  return out;
}

export const supplierContactKind: ContactKindDef = {
  visibleIds: (u, ids) => new Set(views(u, ids).keys()),
  canChange: (u, id) => !!views(u, [id]).get(id)?.canEdit,
  names: (ids) => {
    const rows = supplierContactRowsById(ids);
    const suppliers = suppliersOf(rows.map((r) => r.supplier_id));
    return new Map(rows.map((r) => [r.id, suppliers.get(r.supplier_id)?.name ?? r.supplier_id]));
  },
  href: (id) => {
    const r = db().get<{ supplier_id: string }>('SELECT supplier_id FROM supplier_contacts WHERE id = ?', id);
    return r ? `/suppliers/${encodeURIComponent(r.supplier_id)}` : '';
  },
  // the person was erased: the supplier's entry for them (role, note, scope) goes too
  onLinksErased: (ids) => {
    for (const id of ids) {
      db().run('DELETE FROM supplier_contact_scopes WHERE contact_id = ?', id);
      db().run('DELETE FROM supplier_contacts WHERE id = ?', id);
    }
  },
};

/**
 * The upgrade to 0.25.1 (ADR 0038): each supplier contact entry gets its person in the contacts directory, once – the
 * entry keeps role, note and scope, its own name, e-mail and phone are emptied. The same e-mail address with the same
 * name and phone is one contact across suppliers; without an e-mail address the same name and phone within one
 * supplier. Runs once the vault is open and after a migration package is imported; audited as a whole.
 */
export function convertSupplierContacts(): number {
  const rows = db().all<ContactRow>(
    `SELECT sc.*, NULL AS contact_id FROM supplier_contacts sc
      WHERE NOT EXISTS (SELECT 1 FROM contact_links l WHERE l.kind = 'supplier' AND l.item_id = sc.id) ORDER BY sc.created_at, sc.id`,
  );
  if (!rows.length) return 0;
  const m = new LegacyContactMatcher('supplier', ['phone']);
  for (const r of rows)
    db().tx(() => {
      const contactId = m.contactOf({ role: r.role, name: r.name, email: r.email, phone: r.phone }, r.supplier_id);
      writeItemLinks('supplier', r.id, [{ role: r.role, contactId }]);
      db().run("UPDATE supplier_contacts SET name = '', email = '', phone = '' WHERE id = ?", r.id);
    });
  m.audit(rows.length, rows.length);
  return rows.length;
}
