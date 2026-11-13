import {
  COST_LIST_CONDITION_KINDS,
  conditionMatches,
  conditionOverlap,
  costConditionsInput,
  normaliseCondition,
  type CostCondition,
  type CostConditionKind,
  type CostConditionScope,
  type CostConditionView,
  type CostContractConditions,
  type CostTierMode,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { ScopeCtx } from '../suppliers/contract-scope.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { costSettings } from './access.js';

/**
 * Conditions of supplier contracts (0.23.0, ADR 0035 parts 3, 4 and 8, docs/PRICE-BOOKS.md#contract-conditions): the
 * contract's "Prices" section – percent off list per scope, negotiated unit prices, commitments read from a volume
 * schedule of the same contract, and the terms of derived books (discount on the base, markup, fee per unit, fixed fee).
 *
 * - **Who sees them**: who sees the contract (ADR 0031) **and** its amounts – administrators, auditors, who may change
 *   the contract, and every other reader unless _Hide amounts from viewers_ is on. Everyone else never learns them: an
 *   estimate shows such a line at the list price (pricing.ts), the contract's page shows no section.
 * - **Who changes them**: who may change the contract and sees its amounts; a signed-in session (the routes); audited as
 *   `supplier.contract_conditions_changed` with before and after.
 * - **Inheritance**: an order form without conditions of its own applies its master agreement's (shown read-only).
 * - Read in bulk: one statement for the contracts and one for their conditions, whatever their number.
 */

interface ConditionRow {
  id: string;
  contract_id: string;
  position: number;
  kind: CostConditionKind;
  provider: string;
  scope_on: CostConditionScope;
  target: string;
  price_id: string;
  percent: string | null;
  price: string | null;
  block: number;
  currency: string | null;
  tiers: string | null;
  tier_mode: CostTierMode;
  unit: string | null;
  bands: string | null;
  schedule_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  note: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface ContractRow {
  id: string;
  supplier_id: string;
  owners: string;
  parent_id: string | null;
  title: string;
  reference: string;
  starts_on: string | null;
  ends_on: string | null;
  renewal: string;
  s_owners: string;
  s_status: 'unconfirmed' | 'active' | 'archived';
}

const toCondition = (r: ConditionRow): CostCondition => ({
  id: r.id,
  kind: r.kind,
  provider: r.provider,
  on: r.scope_on,
  target: r.target,
  priceId: r.price_id,
  percent: r.percent,
  price: r.price,
  block: Number(r.block) as CostCondition['block'],
  currency: r.currency,
  tiers: parseJson(r.tiers, null),
  tierMode: r.tier_mode,
  unit: r.unit,
  bands: parseJson(r.bands, null),
  scheduleId: r.schedule_id,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  note: r.note,
});

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

function contractRows(ids: readonly string[]): Map<string, ContractRow> {
  const want = [...new Set(ids)];
  const out = new Map<string, ContractRow>();
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    for (const r of db().all<ContractRow>(
      `SELECT c.id, c.supplier_id, c.owners, c.parent_id, c.title, c.reference, c.starts_on, c.ends_on, c.renewal, s.owners AS s_owners, s.status AS s_status
         FROM supplier_contracts c JOIN suppliers s ON s.id = c.supplier_id WHERE c.id IN (${marks(part.length)})`,
      ...part,
    ))
      out.set(r.id, r);
  }
  return out;
}

function conditionRows(contractIds: readonly string[]): Map<string, ConditionRow[]> {
  const want = [...new Set(contractIds)];
  const out = new Map<string, ConditionRow[]>(want.map((id) => [id, []]));
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    for (const r of db().all<ConditionRow>(
      `SELECT * FROM supplier_contract_conditions WHERE contract_id IN (${marks(part.length)}) ORDER BY contract_id, position, id`,
      ...part,
    ))
      out.get(r.contract_id)!.push(r);
  }
  return out;
}

// ---------- who sees them ----------

/**
 * Which contracts' conditions `u` may see (who sees the contract with its amounts). A function memoised for one request
 * or calculation; jobs (no reader) see all.
 */
export function conditionsSight(u: AuthUser | null = currentUser()): (contractId: string) => boolean {
  if (!u) return () => true;
  const ctx = new ScopeCtx(u);
  const hide = costSettings().hideAmountsFromViewers;
  const privileged = isAdmin(u) || u.roles.includes('auditor');
  const memo = new Map<string, boolean>();
  let rows: Map<string, ContractRow> | null = null;
  const decide = (id: string, c: ContractRow | undefined) => {
    const s = c && { id: c.supplier_id, owners: c.s_owners, status: c.s_status };
    return !!c && !!s && ctx.reads(c, s) && (privileged || !hide || ctx.edits(c, s));
  };
  return (id) => {
    let v = memo.get(id);
    if (v !== undefined) return v;
    // the first question reads every contract that has conditions, and its order forms, at once (a fixed number of
    // statements for a page of estimates, whatever the number of lines and contracts)
    if (!rows) {
      const ids = db()
        .all<{ id: string }>(
          'SELECT id FROM supplier_contracts WHERE id IN (SELECT contract_id FROM supplier_contract_conditions) OR parent_id IN (SELECT contract_id FROM supplier_contract_conditions)',
        )
        .map((r) => r.id);
      rows = contractRows(ids);
      ctx.load([...rows.keys()]);
    }
    let c = rows.get(id);
    if (!c) {
      c = contractRows([id]).get(id);
      ctx.load([id]);
    }
    v = decide(id, c);
    memo.set(id, v);
    return v;
  };
}

// ---------- reading for pricing ----------

/** A contract with the conditions that apply to it (its own, or its master's while it has none). */
export interface PricingContract {
  id: string;
  title: string;
  reference: string;
  /** The conditions are its master agreement's */
  inherited: boolean;
  term: { from: string | null; to: string | null };
  conditions: CostCondition[];
}

/** The contracts of these ids with their applying conditions – no visibility check (the caller filters). */
export function pricingContracts(ids: readonly string[]): Map<string, PricingContract> {
  const rows = contractRows(ids);
  const own = conditionRows([...rows.keys()]);
  const masters = [...rows.values()].filter((r) => r.parent_id && !own.get(r.id)?.length).map((r) => r.parent_id!);
  const inherited = masters.length ? conditionRows(masters) : new Map<string, ConditionRow[]>();
  const out = new Map<string, PricingContract>();
  for (const r of rows.values()) {
    const mine = own.get(r.id) ?? [];
    const from = !mine.length && r.parent_id ? (inherited.get(r.parent_id) ?? []) : mine;
    out.set(r.id, {
      id: r.id,
      title: r.title,
      reference: r.reference,
      inherited: !mine.length && from.length > 0,
      // a contract that ends without renewal ends its conditions; one that renews keeps them
      term: { from: r.starts_on, to: r.renewal === 'fixedEnd' ? r.ends_on : null },
      conditions: from.map(toCondition),
    });
  }
  return out;
}

/**
 * The contracts that could apply to a provider's prices: those with list conditions for it (or an order form whose
 * master has them and which has none of its own) whose conditions the reader sees – the ones covering one of
 * `prefer` (the estimate's service or platforms) first, order forms before masters, then by title.
 */
export function contractCandidates(
  providers: readonly string[],
  sees: (id: string) => boolean,
  prefer: { serviceId?: string | null; platformIds?: readonly string[] } = {},
): Map<string, string[]> {
  const norm = (s: string) => s.trim().toLowerCase();
  const want = new Set(providers.map(norm));
  const out = new Map<string, string[]>();
  if (!want.size) return out;
  const kinds = COST_LIST_CONDITION_KINDS;
  const rows = db().all<{ contract_id: string; provider: string }>(
    `SELECT DISTINCT contract_id, provider FROM supplier_contract_conditions WHERE kind IN (${marks(kinds.length)})`,
    ...kinds,
  );
  const holders = new Map<string, Set<string>>();
  for (const r of rows) {
    const p = norm(r.provider);
    if (!want.has(p)) continue;
    holders.set(r.contract_id, (holders.get(r.contract_id) ?? new Set()).add(p));
  }
  if (!holders.size) return out;
  // order forms that inherit: children of a holder with no conditions of their own
  const withOwn = new Set(
    db()
      .all<{ contract_id: string }>('SELECT DISTINCT contract_id FROM supplier_contract_conditions')
      .map((r) => r.contract_id),
  );
  const masters = [...holders.keys()];
  const children: { id: string; parent_id: string }[] = [];
  for (let i = 0; i < masters.length; i += 500) {
    const part = masters.slice(i, i + 500);
    children.push(
      ...db().all<{ id: string; parent_id: string }>(`SELECT id, parent_id FROM supplier_contracts WHERE parent_id IN (${marks(part.length)})`, ...part),
    );
  }
  const all = new Map(holders);
  for (const c of children) if (!withOwn.has(c.id)) all.set(c.id, holders.get(c.parent_id)!);
  const ids = [...all.keys()].filter((id) => sees(id));
  if (!ids.length) return out;
  const info = contractRows(ids);
  const covering = new Set<string>();
  if (prefer.serviceId)
    for (const r of db().all<{ contract_id: string }>('SELECT contract_id FROM supplier_contract_services WHERE service_id = ?', prefer.serviceId))
      covering.add(r.contract_id);
  for (const p of prefer.platformIds ?? [])
    for (const r of db().all<{ contract_id: string }>('SELECT contract_id FROM supplier_contract_platforms WHERE platform_id = ?', p))
      covering.add(r.contract_id);
  const rank = (id: string) => (covering.has(id) ? 0 : 2) + (info.get(id)?.parent_id ? 0 : 1);
  const sorted = ids
    .filter((id) => info.has(id))
    .sort((a, b) => rank(a) - rank(b) || (info.get(a)!.title < info.get(b)!.title ? -1 : info.get(a)!.title > info.get(b)!.title ? 1 : a < b ? -1 : 1));
  for (const id of sorted) for (const p of all.get(id)!) out.set(p, [...(out.get(p) ?? []), id]);
  return out;
}

// ---------- the contract's "Prices" section ----------

const notFound = (id: string) => new HttpError(404, `Contract ${id} not found`, 'SUPPLIER_CONTRACT_NOT_FOUND', { id });

function requireContract(id: string, need: 'view' | 'edit'): { row: ContractRow; canEdit: boolean } {
  const u = currentUser();
  const row = contractRows([id]).get(id);
  if (!row) throw notFound(id);
  const ctx = new ScopeCtx(u).load([id]);
  const s = { id: row.supplier_id, owners: row.s_owners, status: row.s_status };
  // who may not see the conditions finds no section: like a contract without one (404 for who may not see the contract)
  if (!ctx.reads(row, s)) throw notFound(id);
  if (!conditionsSight(u)(id))
    throw new HttpError(403, 'Only who sees the amounts of this contract sees its prices', 'FORBIDDEN', { context: 'contractConditions' });
  const canEdit = ctx.edits(row, s);
  if (need === 'edit' && !canEdit)
    throw new HttpError(403, `You are not allowed to change the contract "${row.title}"`, 'FORBIDDEN', { context: 'contractConditions' });
  return { row, canEdit };
}

const norm = (s: string) => s.trim().toLowerCase();

function views(rows: ConditionRow[], contractedProviders: Set<string>): CostConditionView[] {
  return rows.map((r) => {
    const c = toCondition(r);
    // a percentage that would apply on top of a contracted book of this contract is flagged: the book includes the discount
    const flag = (c.kind === 'percentOff' || c.kind === 'commitment') && contractedProviders.has(norm(c.provider)) ? ('contractedBook' as const) : null;
    return { ...c, flag, updatedAt: r.updated_at, updatedBy: r.updated_by };
  });
}

export function getContractConditions(contractId: string): CostContractConditions {
  const { row, canEdit } = requireContract(contractId, 'view');
  const own = conditionRows([contractId]).get(contractId) ?? [];
  const books = db().all<{ id: string; name: string; kind: string; provider: string }>(
    'SELECT id, name, kind, provider FROM cost_price_books WHERE supplier_contract_id = ? ORDER BY name, id',
    contractId,
  );
  const contracted = new Set(books.filter((b) => b.kind === 'contracted').map((b) => norm(b.provider)));
  let inherited: CostContractConditions['inherited'] = null;
  if (!own.length && row.parent_id) {
    const master = contractRows([row.parent_id]).get(row.parent_id);
    const rows = conditionRows([row.parent_id]).get(row.parent_id) ?? [];
    if (master && rows.length) inherited = { id: master.id, title: master.title, conditions: views(rows, contracted) };
  }
  const schedules = db().all<{ id: string; title: string; currency: string }>(
    "SELECT id, title, currency FROM cost_schedules WHERE contract_id = ? AND billing = 'volume' ORDER BY title, id",
    contractId,
  );
  return {
    contract: { id: row.id, title: row.title, reference: row.reference, supplierId: row.supplier_id },
    conditions: views(own, contracted),
    inherited,
    canEdit,
    books,
    schedules,
  };
}

const auditView = (c: CostCondition) => ({
  kind: c.kind,
  provider: c.provider,
  on: c.on,
  target: c.target,
  priceId: c.priceId || undefined,
  percent: c.percent ?? undefined,
  price: c.price ?? undefined,
  block: c.price ? c.block : undefined,
  currency: c.currency ?? undefined,
  tiers: c.tiers ?? undefined,
  unit: c.unit ?? undefined,
  bands: c.bands ?? undefined,
  scheduleId: c.scheduleId ?? undefined,
  validFrom: c.validFrom ?? undefined,
  validTo: c.validTo ?? undefined,
});

/** Hooks run after a contract's conditions changed (derived books follow, estimates are recalculated). */
const changedHooks: ((contractId: string) => void)[] = [];
export function onConditionsChanged(fn: (contractId: string) => void): void {
  changedHooks.push(fn);
}

/** Replaces a contract's conditions (all of them): who may change the contract and sees its amounts. */
export function setContractConditions(contractId: string, body: unknown): CostContractConditions {
  const { row } = requireContract(contractId, 'edit');
  const x = costConditionsInput.parse(body);
  const before = conditionRows([contractId]).get(contractId) ?? [];
  const keep = new Map(before.map((r) => [r.id, r]));
  const next = x.conditions.map((c) => normaliseCondition(c, c.id && keep.has(c.id) ? c.id : newId('ccd_')));
  const overlap = conditionOverlap(next);
  if (overlap) {
    const a = next[overlap.a]!;
    throw new HttpError(
      400,
      `Two conditions of the same kind for ${a.on === 'provider' ? a.provider : `${a.provider} – ${a.target}`} overlap in time`,
      'COST_CONDITION_OVERLAP',
      { provider: a.provider, target: a.target || a.provider, first: overlap.a + 1, second: overlap.b + 1 },
    );
  }
  const schedules = new Set(
    db()
      .all<{ id: string }>("SELECT id FROM cost_schedules WHERE contract_id = ? AND billing = 'volume'", contractId)
      .map((r) => r.id),
  );
  for (const c of next)
    if (c.kind === 'commitment' && !schedules.has(c.scheduleId ?? ''))
      throw new HttpError(400, 'A commitment reads a volume schedule of the same contract', 'COST_CONDITION_SCHEDULE', { id: c.scheduleId ?? '' });
  const now = nowIso();
  const actor = currentActor();
  const same = (a: ConditionRow, b: CostCondition) => JSON.stringify(auditView(toCondition(a))) === JSON.stringify(auditView(b)) && a.note === b.note;
  db().tx(() => {
    db().run('DELETE FROM supplier_contract_conditions WHERE contract_id = ?', contractId);
    next.forEach((c, i) => {
      const old = keep.get(c.id);
      const unchanged = old && same(old, c);
      db().run(
        `INSERT INTO supplier_contract_conditions (id, contract_id, position, kind, provider, scope_on, target, price_id, percent, price, block, currency, tiers, tier_mode,
           unit, bands, schedule_id, valid_from, valid_to, note, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        contractId,
        i,
        c.kind,
        c.provider,
        c.on,
        c.target,
        c.priceId,
        c.percent,
        c.price,
        c.block,
        c.currency,
        c.tiers ? JSON.stringify(c.tiers) : null,
        c.tierMode,
        c.unit,
        c.bands ? JSON.stringify(c.bands) : null,
        c.scheduleId,
        c.validFrom,
        c.validTo,
        c.note,
        old?.created_at ?? now,
        old?.created_by ?? actor,
        unchanged ? old.updated_at : now,
        unchanged ? old.updated_by : actor,
      );
    });
    audit({
      action: 'supplier.contract_conditions_changed',
      entityType: 'supplier',
      entityId: row.supplier_id,
      summary: `Prices of the contract "${row.title}": ${next.length} condition(s)${before.length !== next.length ? ` (were ${before.length})` : ''}`,
      details: {
        contractId,
        before: before.map((r) => ({ id: r.id, ...auditView(toCondition(r)) })),
        after: next.map((c) => ({ id: c.id, ...auditView(c) })),
      },
    });
    for (const fn of changedHooks) fn(contractId);
  });
  return getContractConditions(contractId);
}

/** Whether a list condition of a contract matches a priced item (for flags and tests). */
export const listConditionFor = (c: CostCondition, provider: string, sku: string): boolean =>
  COST_LIST_CONDITION_KINDS.includes(c.kind) && conditionMatches(c, { provider, bookId: '', service: '', category: '', driver: '', sku, priceId: '' });

/** Removes the conditions of a removed contract (and with them its standing in estimates). */
export function forgetContractConditions(contractId: string): void {
  db().run('DELETE FROM supplier_contract_conditions WHERE contract_id = ?', contractId);
  db().run('DELETE FROM cost_estimate_contracts WHERE contract_id = ?', contractId);
}

/**
 * The contracts whose conditions the reader sees and which grant something on list prices, with the providers they
 * are for – the choice of an estimate (GET /api/costs/contracts). An order form without conditions of its own is
 * listed with its master's.
 */
export function conditionContracts(
  u: AuthUser | null = currentUser(),
): { id: string; title: string; reference: string; supplierName: string; providers: string[] }[] {
  const providers = db()
    .all<{ provider: string }>(
      `SELECT DISTINCT provider FROM supplier_contract_conditions WHERE kind IN (${marks(COST_LIST_CONDITION_KINDS.length)})`,
      ...COST_LIST_CONDITION_KINDS,
    )
    .map((r) => r.provider);
  const byProvider = contractCandidates(providers, conditionsSight(u));
  const out = new Map<string, { id: string; title: string; reference: string; supplierName: string; providers: string[] }>();
  const names = new Map(providers.map((p) => [norm(p), p]));
  const rows = contractRows([...new Set([...byProvider.values()].flat())]);
  const supplierIds = [...new Set([...rows.values()].map((r) => r.supplier_id))];
  const suppliers = new Map(
    supplierIds.length
      ? db()
          .all<{ id: string; name: string }>(`SELECT id, name FROM suppliers WHERE id IN (${marks(supplierIds.length)})`, ...supplierIds)
          .map((x) => [x.id, x.name])
      : [],
  );
  for (const [p, ids] of byProvider)
    for (const id of ids) {
      const r = rows.get(id);
      if (!r) continue;
      const have = out.get(id) ?? { id, title: r.title, reference: r.reference, supplierName: suppliers.get(r.supplier_id) ?? '', providers: [] };
      have.providers.push(names.get(p) ?? p);
      out.set(id, have);
    }
  return [...out.values()].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}
