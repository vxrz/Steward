import type { SupplierRef, SupplierStatus } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { canViewCatalogue } from '../records/access.js';
import { HttpError, parseJson } from '../util.js';

/**
 * The supplier of a linked item (0.17.0, ADR 0029): applications, systems, ticket references, page watches, cost plan
 * lines and duties keep a nullable `supplier_id` next to their free-text vendor, which stays as a fallback. Kept free
 * of the supplier service, so those modules import it without a cycle.
 */

interface RefRow {
  id: string;
  name: string;
  status: SupplierStatus;
  owners: string;
}

/** Whether the reader may see a supplier (team scope like systems, #131); jobs (no reader) see everything. */
export function supplierVisible(r: { id: string; owners: string | string[] }): boolean {
  const u = currentUser();
  if (!u) return true;
  return canViewCatalogue(u, { kind: 'supplier', id: r.id, owners: Array.isArray(r.owners) ? r.owners : parseJson<string[]>(r.owners, []) });
}

/** The suppliers of these ids that the reader may see, by id. */
export function supplierRefs(ids: readonly (string | null | undefined)[]): Map<string, SupplierRef> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, SupplierRef>();
  if (!want.length) return out;
  // a handful per page: one query per chunk keeps the parameter count low on both databases
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    for (const r of db().all<RefRow>(`SELECT id, name, status, owners FROM suppliers WHERE id IN (${part.map(() => '?').join(', ')})`, ...part))
      if (supplierVisible(r)) out.set(r.id, { id: r.id, name: r.name, status: r.status });
  }
  return out;
}

export const supplierRefOf = (id: string | null | undefined): SupplierRef | null => (id ? (supplierRefs([id]).get(id) ?? null) : null);

/**
 * The supplier a form links: missing keeps the current one, null clears it, an id must be a supplier the person may
 * see that is not archived (keeping an archived one that is linked already is fine).
 */
export function resolveSupplierLink(next: string | null | undefined, current: string | null): string | null {
  if (next === undefined) return current;
  if (next === null) return null;
  const r = db().get<RefRow>('SELECT id, name, status, owners FROM suppliers WHERE id = ?', next);
  if (!r || !supplierVisible(r)) throw new HttpError(404, `Supplier ${next} not found`, 'SUPPLIER_NOT_FOUND', { id: next });
  if (r.status === 'archived' && r.id !== current) throw new HttpError(409, `Supplier "${r.name}" is archived`, 'SUPPLIER_ARCHIVED', { name: r.name });
  return r.id;
}

/** A contract of the linked supplier (cost plan lines): missing keeps it, null clears it; it must belong to the supplier. */
export function resolveSupplierContract(supplierId: string | null, next: string | null | undefined, current: string | null): string | null {
  const id = next === undefined ? current : next;
  if (!id) return null;
  if (!supplierId) {
    if (next === undefined) return null;
    throw new HttpError(400, 'Choose the supplier of the contract first', 'SUPPLIER_CONTRACT_WITHOUT_SUPPLIER');
  }
  const c = db().get<{ id: string }>('SELECT id FROM supplier_contracts WHERE id = ? AND supplier_id = ?', id, supplierId);
  if (!c) {
    // a kept contract of a supplier that changed goes with it
    if (next === undefined) return null;
    throw new HttpError(404, `Contract ${id} not found`, 'SUPPLIER_CONTRACT_NOT_FOUND', { id });
  }
  return c.id;
}

/** The contract titles of these ids (cost plan lines). */
export function contractTitles(ids: readonly (string | null | undefined)[]): Map<string, { id: string; title: string; reference: string; supplierId: string }> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, { id: string; title: string; reference: string; supplierId: string }>();
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    for (const r of db().all<{ id: string; title: string; reference: string; supplier_id: string }>(
      `SELECT id, title, reference, supplier_id FROM supplier_contracts WHERE id IN (${part.map(() => '?').join(', ')})`,
      ...part,
    ))
      out.set(r.id, { id: r.id, title: r.title, reference: r.reference, supplierId: r.supplier_id });
  }
  return out;
}
