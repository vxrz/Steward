import type { SupplierRef, SupplierStatus } from '@sm/shared';
import { db } from '../db.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { canEditService, canViewCatalogue } from '../records/access.js';
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

/** A contract of the linked supplier (cost plan lines and entries): missing keeps it, null clears it; it must belong to the supplier. */
export function resolveSupplierContract(supplierId: string | null, next: string | null | undefined, current: string | null): string | null {
  const id = next === undefined ? current : next;
  if (!id) return null;
  if (!supplierId) {
    if (next === undefined) return null;
    throw new HttpError(400, 'Choose the supplier of the contract first', 'SUPPLIER_CONTRACT_WITHOUT_SUPPLIER');
  }
  const c = db().get<{ id: string; supplier_id: string }>('SELECT id, supplier_id FROM supplier_contracts WHERE id = ? AND supplier_id = ?', id, supplierId);
  // a contract the person may not see (ADR 0031) cannot be chosen; one linked already is kept
  if (!c || (next !== undefined && next !== current && !contractVisible(c))) {
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

// ---------- contracts (ADR 0030; ADR 0031 gives them a scope of their own) ----------

/** What the cost plans, payment schedules and commitments read of a supplier contract. */
export interface ContractInfo {
  id: string;
  supplierId: string;
  supplierName: string;
  supplierStatus: SupplierStatus;
  title: string;
  reference: string;
  startsOn: string | null;
  endsOn: string | null;
  noticeDays: number | null;
  renewal: 'automatic' | 'byAgreement' | 'fixedEnd';
  renewalMonths: number | null;
}

interface ContractInfoRow {
  id: string;
  supplier_id: string;
  title: string;
  reference: string;
  starts_on: string | null;
  ends_on: string | null;
  notice_days: number | null;
  renewal: ContractInfo['renewal'];
  renewal_months: number | null;
}

/**
 * Whether the reader may see a contract – the one rule every read of a contract in the Costs module goes through
 * (payment schedules, plan lines, entries, commitments, the supplier page's payments). Today a contract is seen by who
 * may see its supplier; ADR 0031 (contracts with their own scope: owners, covered services) changes only this body.
 * `supplier` is the contract's supplier row when the caller has it (saves a read); jobs (no reader) see everything.
 */
export function contractVisible(
  c: { id: string; supplier_id: string },
  supplier?: { id: string; owners: string | string[] } | null,
  u: AuthUser | null = currentUser(),
): boolean {
  if (!u) return true;
  const s = supplier ?? db().get<{ id: string; owners: string }>('SELECT id, owners FROM suppliers WHERE id = ?', c.supplier_id);
  if (!s) return false;
  return canViewCatalogue(u, { kind: 'supplier', id: s.id, owners: Array.isArray(s.owners) ? s.owners : parseJson<string[]>(s.owners, []) });
}

/**
 * Whether the reader may change a contract – and so its payment schedules (ADR 0030): who may change its supplier
 * (designers, administrators, the supplier's owners), not while the supplier is archived. ADR 0031 gives contracts
 * owners of their own and changes only this body. Jobs (no reader) may.
 */
export function contractEditable(
  c: { id: string; supplier_id: string },
  supplier?: { id: string; owners: string | string[]; status: SupplierStatus } | null,
  u: AuthUser | null = currentUser(),
): boolean {
  if (!u) return true;
  const s =
    supplier ?? db().get<{ id: string; owners: string; status: SupplierStatus }>('SELECT id, owners, status FROM suppliers WHERE id = ?', c.supplier_id);
  if (!s || s.status === 'archived') return false;
  return canEditService(u, { kind: 'supplier', id: s.id, owners: Array.isArray(s.owners) ? s.owners : parseJson<string[]>(s.owners, []) });
}

/**
 * The contracts of these ids that the reader may see (contractVisible), with their supplier and term – read in bulk:
 * one statement per 500 ids, never one per contract.
 */
export function visibleContracts(ids: readonly (string | null | undefined)[], u: AuthUser | null = currentUser()): Map<string, ContractInfo> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, ContractInfo>();
  const seen = new Map<string, boolean>();
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    const rows = db().all<ContractInfoRow & { s_name: string; s_status: SupplierStatus; s_owners: string }>(
      `SELECT c.id, c.supplier_id, c.title, c.reference, c.starts_on, c.ends_on, c.notice_days, c.renewal, c.renewal_months,
              s.name AS s_name, s.status AS s_status, s.owners AS s_owners
         FROM supplier_contracts c JOIN suppliers s ON s.id = c.supplier_id WHERE c.id IN (${part.map(() => '?').join(', ')})`,
      ...part,
    );
    for (const r of rows) {
      let v = seen.get(r.supplier_id);
      if (v === undefined) {
        v = contractVisible(r, { id: r.supplier_id, owners: r.s_owners }, u);
        seen.set(r.supplier_id, v);
      }
      if (!v) continue;
      out.set(r.id, {
        id: r.id,
        supplierId: r.supplier_id,
        supplierName: r.s_name,
        supplierStatus: r.s_status,
        title: r.title,
        reference: r.reference,
        startsOn: r.starts_on,
        endsOn: r.ends_on,
        noticeDays: r.notice_days === null || r.notice_days === undefined ? null : Number(r.notice_days),
        renewal: r.renewal,
        renewalMonths: r.renewal_months === null || r.renewal_months === undefined ? null : Number(r.renewal_months),
      });
    }
  }
  return out;
}

/** Every contract the Costs module may read regardless of the reader (jobs, the dataset and the export: no reader). */
export const allContracts = (ids: readonly (string | null | undefined)[]): Map<string, ContractInfo> => visibleContracts(ids, null);
