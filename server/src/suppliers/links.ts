import type { SupplierRef, SupplierStatus } from '@sm/shared';
import { db } from '../db.js';
import { currentUser, viaApiToken, type AuthUser } from '../auth/context.js';
import { canViewCatalogue } from '../records/access.js';
import { ScopeCtx, checkSideCover } from './contract-scope.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { audit } from '../audit.js';

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

/** Who a cost plan line or entry belongs to: a service (its id, as before 0.19), or a service or platform (0.19.0, ADR 0032). */
export type ContractPayer = string | { kind: 'service' | 'platform'; id: string };
const payerRef = (p: ContractPayer): { kind: 'service' | 'platform'; id: string } => (typeof p === 'string' ? { kind: 'service', id: p } : p);

/** Whether the contract covers the service or platform. */
export function contractCovers(contractId: string, payer: ContractPayer): boolean {
  const p = payerRef(payer);
  return p.kind === 'service'
    ? !!db().get('SELECT 1 FROM supplier_contract_services WHERE contract_id = ? AND service_id = ?', contractId, p.id)
    : !!db().get('SELECT 1 FROM supplier_contract_platforms WHERE contract_id = ? AND platform_id = ?', contractId, p.id);
}

/**
 * A contract of the linked supplier (cost plan lines and entries, matrix rows, duties, findings): missing keeps it,
 * null clears it; it must belong to the supplier. A newly chosen contract must be one the person may see (ADR 0031);
 * with `serviceId`, it must cover the service – or the person may add the service to it (who may change the contract
 * and sees the service), which coverChosenContract() then does in the caller's transaction. A contract linked already
 * is kept as it is, also one the person may not see.
 */
export function resolveSupplierContract(
  supplierId: string | null,
  next: string | null | undefined,
  current: string | null,
  serviceId?: ContractPayer,
): string | null {
  const id = next === undefined ? current : next;
  if (!id) return null;
  if (!supplierId) {
    if (next === undefined) return null;
    throw new HttpError(400, 'Choose the supplier of the contract first', 'SUPPLIER_CONTRACT_WITHOUT_SUPPLIER');
  }
  const c = db().get<{ id: string; supplier_id: string; owners: string; title: string }>(
    'SELECT id, supplier_id, owners, title FROM supplier_contracts WHERE id = ? AND supplier_id = ?',
    id,
    supplierId,
  );
  const chosen = next !== undefined && next !== current;
  // a contract the person may not see (ADR 0031) cannot be chosen; one linked already is kept
  if (!c || (chosen && !contractVisible(c))) {
    // a kept contract of a supplier that changed goes with it
    if (next === undefined) return null;
    throw new HttpError(404, `Contract ${id} not found`, 'SUPPLIER_CONTRACT_NOT_FOUND', { id });
  }
  if (chosen && serviceId && currentUser() && !contractCovers(c.id, serviceId)) {
    const ctx = new ScopeCtx();
    const p = payerRef(serviceId);
    if (!contractEditable(c, undefined, currentUser(), ctx) || !(p.kind === 'service' ? ctx.seesService(p.id) : ctx.seesPlatform(p.id)))
      throw new HttpError(409, `The contract "${c.title}" does not cover this service, and you may not add it`, 'SUPPLIER_CONTRACT_NOT_COVERING', {
        contract: c.title,
      });
    // adding a covered service widens who sees the contract: a decision of a person in a session, like the contract's
    // own route (ADR 0031 part 2; security review 0.18.0, L3) – an API token links only contracts covering the service
    if (viaApiToken())
      throw new HttpError(
        403,
        `The contract "${c.title}" does not cover this service – API tokens cannot add a service to a contract; sign in to the web UI`,
        'SUPPLIER_CONTRACT_COVER_SESSION',
        { contract: c.title },
      );
    // a platform: within the limit, and never a grant to another team on the side (security review 0.19.0 M1, L7)
    if (p.kind === 'platform') checkSideCover(c.id, p.id);
  }
  return c.id;
}

/**
 * Adds the service to a contract chosen for it (resolveSupplierContract checked that the person may): a confirmed
 * covered service without a purpose, audited on the supplier. Nothing when it is covered already, or when the contract
 * was kept (`before`) – a kept link never adds coverage back.
 */
export function coverChosenContract(contractId: string | null, before: string | null, payer: ContractPayer, actor: string): void {
  if (!contractId || contractId === before || !currentUser() || contractCovers(contractId, payer)) return;
  const c = db().get<{ supplier_id: string; title: string }>('SELECT supplier_id, title FROM supplier_contracts WHERE id = ?', contractId);
  const p = payerRef(payer);
  if (p.kind === 'platform') {
    const plat = db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', p.id);
    if (!c || !plat) return;
    // checked again with what is stored now (resolveSupplierContract asked before): the caller's transaction is undone
    checkSideCover(contractId, p.id);
    db().run(
      `INSERT INTO supplier_contract_platforms (contract_id, platform_id, purpose, added_by, added_at) VALUES (?, ?, '', ?, ?)`,
      contractId,
      p.id,
      actor,
      nowIso(),
    );
    audit({
      action: 'supplier.contract_platform_added',
      entityType: 'supplier',
      entityId: c.supplier_id,
      summary: `Platform "${plat.name}" added to the contract "${c.title}"`,
      details: { contractId, platformId: p.id, platform: plat.name, purpose: '', chosenFor: true },
    });
    return;
  }
  const serviceId = p.id;
  const svc = db().get<{ name: string }>('SELECT name FROM services WHERE id = ?', serviceId);
  if (!c || !svc) return;
  const now = nowIso();
  db().run(
    `INSERT INTO supplier_contract_services (contract_id, service_id, purpose, status, proposed_from, added_by, added_at, confirmed_by, confirmed_at)
     VALUES (?, ?, '', 'confirmed', '[]', ?, ?, ?, ?)`,
    contractId,
    serviceId,
    actor,
    now,
    actor,
    now,
  );
  audit({
    action: 'supplier.contract_service_added',
    entityType: 'supplier',
    entityId: c.supplier_id,
    summary: `Service "${svc.name}" added to the contract "${c.title}"`,
    details: { contractId, serviceId, service: svc.name, purpose: '', chosenFor: true },
  });
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
 * Whether the reader may see a contract – the one rule every read of a contract goes through (payment schedules, plan
 * lines, entries, commitments, the matrix, duties, findings, the supplier page). ADR 0031: only who may see its
 * supplier, and of them – for a contract with a team among its owners – its owners, the readers of a service it covers,
 * administrators and auditors (contract-scope.ts). `supplier` is the contract's supplier row when the caller has it
 * (saves a read); jobs (no reader) see everything.
 */
export function contractVisible(
  c: { id: string; supplier_id: string; owners?: string },
  supplier?: { id: string; owners: string | string[] } | null,
  u: AuthUser | null = currentUser(),
  ctx?: ScopeCtx,
): boolean {
  if (!u) return true;
  const s = supplier ?? db().get<{ id: string; owners: string }>('SELECT id, owners FROM suppliers WHERE id = ?', c.supplier_id);
  if (!s) return false;
  const owners = c.owners ?? db().get<{ owners: string }>('SELECT owners FROM supplier_contracts WHERE id = ?', c.id)?.owners ?? '[]';
  return (ctx ?? new ScopeCtx(u)).reads({ id: c.id, supplier_id: c.supplier_id, owners }, s);
}

/**
 * Whether the reader may change a contract – and so its payment schedules (ADR 0030): administrators, its owners,
 * designers and the supplier's owners who may see it, editors of a covered service who see every service it covers
 * (ADR 0031); not while the supplier is archived. Jobs (no reader) may.
 */
export function contractEditable(
  c: { id: string; supplier_id: string; owners?: string },
  supplier?: { id: string; owners: string | string[]; status: SupplierStatus } | null,
  u: AuthUser | null = currentUser(),
  ctx?: ScopeCtx,
): boolean {
  if (!u) return true;
  const s =
    supplier ?? db().get<{ id: string; owners: string; status: SupplierStatus }>('SELECT id, owners, status FROM suppliers WHERE id = ?', c.supplier_id);
  if (!s) return false;
  const owners = c.owners ?? db().get<{ owners: string }>('SELECT owners FROM supplier_contracts WHERE id = ?', c.id)?.owners ?? '[]';
  return (ctx ?? new ScopeCtx(u)).edits({ id: c.id, supplier_id: c.supplier_id, owners }, s);
}

/**
 * The contracts of these ids that the reader may see (contractVisible), with their supplier and term – read in bulk:
 * one statement per 500 ids, never one per contract.
 */
export function visibleContracts(ids: readonly (string | null | undefined)[], u: AuthUser | null = currentUser()): Map<string, ContractInfo> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, ContractInfo>();
  const ctx = new ScopeCtx(u);
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    const rows = db().all<ContractInfoRow & { owners: string; s_name: string; s_status: SupplierStatus; s_owners: string }>(
      `SELECT c.id, c.supplier_id, c.title, c.reference, c.starts_on, c.ends_on, c.notice_days, c.renewal, c.renewal_months, c.owners,
              s.name AS s_name, s.status AS s_status, s.owners AS s_owners
         FROM supplier_contracts c JOIN suppliers s ON s.id = c.supplier_id WHERE c.id IN (${part.map(() => '?').join(', ')})`,
      ...part,
    );
    ctx.load(rows.map((r) => r.id));
    for (const r of rows) {
      if (u && !ctx.reads(r, { id: r.supplier_id, owners: r.s_owners })) continue;
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
