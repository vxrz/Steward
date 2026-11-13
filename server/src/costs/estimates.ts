import {
  COST_ESTIMATE_LIMITS,
  COST_PLAN_LIMITS,
  costEstimateInput,
  costEstimateProposalInput,
  costEstimateUpdate,
  fiscalYearLabel,
  fiscalYearOf,
  type CostAdjustment,
  type CostEstimate,
  type CostEstimateHandLine,
  type CostEstimateProposals,
  type CostEstimateSummary,
  type CostInputValue,
  type CostEstimateTargetKind,
  type CostPlanTargetKind,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser, type AuthUser } from '../auth/context.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { requireScope, scopeInfo, type ScopeInfo } from './access.js';
import { catalogueOf, checkOwnerTarget, startMonth, targetOf, thisMonth, type OwnerRef } from './plans.js';
import { bookRow, onVersionWritten, priceSight } from './price-books.js';
import { onConditionsChanged } from './contract-conditions.js';
import { moduleEnabled } from '../modules/registry.js';
import { productVisibleTo } from '../dataproducts/access-lookup.js';
import { calculateOne, viewResult, type StoredResult } from './pricing.js';
import { listOnly, microsText, proposalsOf, SEE_ALL, type EstimateBasis, type PriceSight } from './estimate-model.js';

/**
 * Estimates (0.21.0, ADR 0035 part 6): a calculation kept – the inputs (values or ranges), the calculator and its
 * version, lines by hand, ad-hoc adjustments, the books chosen, the currency and the month it applies from – with the
 * result Steward priced (never recomputed on read). It belongs to a service or a platform, the owners of cost plans,
 * and is optionally for an application or system of the service or a platform.
 *
 * - Who may change the owner's cost plan creates, changes, recalculates and accepts estimates and makes plan lines from
 *   them; who may read the plan reads them, the amounts by the module's rule (Hide amounts from viewers). Every write
 *   is a signed-in session's (the routes) and audited (`cost.estimate_added|changed|accepted|removed`,
 *   `cost.estimate_lines_added|updated`), adjustments with their reason, before and after.
 * - A line priced from a book the reader may not see is shown at the list price (priceHidden) – pricing.ts.
 * - "Recalculate" prices the estimate again with the books' current versions and keeps the result beside the current
 *   one; "Accept new prices" makes it current. The last 20 results stay as the history.
 */

export interface EstimateRow {
  id: string;
  owner_kind: 'service' | 'platform';
  owner_id: string;
  for_kind: CostEstimateTargetKind | null;
  for_id: string | null;
  title: string;
  description: string;
  calculator_id: string | null;
  calculator_version: number | null;
  inputs: string;
  lines: string;
  adjustments: string;
  books: string;
  contracts?: string;
  currency: string;
  applies_from: string;
  result: string | null;
  pending: string | null;
  /** Why the job recalculates it next (0.23.0): RecalcCause as JSON */
  recalc_cause?: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

type StoredAdjustment = CostAdjustment & { by: string; at: string; found?: string };

const notFound = (id: string) => new HttpError(404, `Estimate ${id} not found`, 'COST_ESTIMATE_NOT_FOUND', { id });

const ownerOf = (r: Pick<EstimateRow, 'owner_kind' | 'owner_id'>): OwnerRef => ({ kind: r.owner_kind, id: r.owner_id });

function access(r: EstimateRow, u: AuthUser | null = currentUser()): ScopeInfo | null {
  return scopeInfo(r.owner_kind, r.owner_id, u);
}

function requireEstimate(id: string, need: 'view' | 'edit' = 'view'): { row: EstimateRow; info: ScopeInfo } {
  const row = db().get<EstimateRow>('SELECT * FROM cost_estimates WHERE id = ?', id);
  if (!row) throw notFound(id);
  const info = access(row);
  if (!info) throw notFound(id);
  if (need === 'edit' && !info.canEditPlan)
    throw new HttpError(403, `You are not allowed to change the estimates of "${info.name}"`, 'FORBIDDEN', { context: 'costEstimate' });
  return { row, info };
}

/** Which books, contracts' conditions and derived books' terms the reader may see (once per request). */
function bookSight(u: AuthUser | null = currentUser()): PriceSight {
  return priceSight(u);
}

const stored = (text: string | null): StoredResult | null => parseJson<StoredResult | null>(text, null);

function forOf(r: EstimateRow): CostEstimate['for'] {
  if (!r.for_kind || !r.for_id) return null;
  if (r.for_kind === 'dataProduct') return dataProductTarget(r.for_id);
  const cat = r.owner_kind === 'service' ? catalogueOf(r.owner_id) : { apps: new Set<string>(), systems: new Set<string>() };
  const t = targetOf(r.for_kind, r.for_id, cat);
  return t ? { kind: t.kind, id: t.id, name: t.name, visible: t.visible } : null;
}

function checkFor(o: OwnerRef, t: { kind: CostEstimateTargetKind; id: string } | null): void {
  if (t?.kind === 'dataProduct') {
    // a data product the editor may see (the module on and theirs to use), whoever owns the estimate
    const x = dataProductTarget(t.id);
    if (!x || !x.visible)
      throw new HttpError(400, `Not a data product you may see: ${t.id}`, 'COST_PLAN_TARGET', {
        kind: t.kind,
      });
    return;
  }
  checkOwnerTarget(o, t as { kind: CostPlanTargetKind; id: string } | null);
}

/**
 * A data product as an estimate's target (ADR 0035 part 6): its name where the reader may see it – the module on and
 * the product visible to them – else `visible: false` and no name (a product they may not see is never named).
 */
function dataProductTarget(id: string): CostEstimate['for'] {
  if (!moduleEnabled('dataProducts')) return { kind: 'dataProduct', id, name: '', visible: false };
  const row = db().get<{ id: string; name: string }>('SELECT id, name FROM dp_products WHERE id = ?', id);
  if (!row) return { kind: 'dataProduct', id, name: '', visible: false };
  const sees = dataProductVisible(row.id);
  return { kind: 'dataProduct', id: row.id, name: sees ? row.name : '', visible: sees };
}

/** Whether the current reader may see the data product (its own rights, team scope and module access). */
function dataProductVisible(id: string): boolean {
  try {
    return productVisibleTo(id);
  } catch {
    return false;
  }
}

// ---------- reading ----------

function summaryOf(r: EstimateRow, info: ScopeInfo, sight: PriceSight, planLines: number, calcNames: Map<string, string>): CostEstimateSummary {
  const s = info.amounts ? stored(r.result) : null;
  const v = s ? viewResult(s, sight) : null;
  const f = r.for_kind && r.for_id ? forOf(r) : null;
  return {
    id: r.id,
    title: r.title,
    owner: { kind: r.owner_kind, id: r.owner_id, name: info.name },
    for: f && f.visible ? { kind: f.kind, id: f.id, name: f.name } : null,
    calculator: r.calculator_id ? { id: r.calculator_id, name: calcNames.get(r.calculator_id) ?? '' } : null,
    currency: r.currency,
    appliesFrom: r.applies_from,
    monthly: v ? v.totals.monthly : null,
    oneOff: v ? v.totals.oneOff : null,
    ranged: !!v?.ranged,
    adjusted: !!v?.adjusted,
    atListPrice: !!v && (v.atListPrice || v.incomplete),
    pending: !!r.pending,
    planLines,
    updatedAt: r.updated_at,
  };
}

/** The estimates of a service or a platform – a fixed number of statements whatever their number. */
export function listEstimates(o: OwnerRef): CostEstimateSummary[] {
  const info = requireScope(o.kind, o.id);
  const rows = db().all<EstimateRow>('SELECT * FROM cost_estimates WHERE owner_kind = ? AND owner_id = ? ORDER BY title, id', o.kind, o.id);
  return summaries(rows, () => info);
}

function summaries(rows: EstimateRow[], infoOf: (r: EstimateRow) => ScopeInfo | null): CostEstimateSummary[] {
  if (!rows.length) return [];
  const sight = bookSight();
  const counts = new Map(
    db()
      .all<{ estimate_id: string; n: number }>('SELECT estimate_id, COUNT(*) AS n FROM cost_plan_lines WHERE estimate_id IS NOT NULL GROUP BY estimate_id')
      .map((x) => [x.estimate_id, Number(x.n)]),
  );
  const calcNames = new Map(
    db()
      .all<{ id: string; name: string }>('SELECT id, name FROM cost_calculators')
      .map((x) => [x.id, x.name]),
  );
  const out: CostEstimateSummary[] = [];
  for (const r of rows) {
    const info = infoOf(r);
    if (info) out.push(summaryOf(r, info, sight, counts.get(r.id) ?? 0, calcNames));
  }
  return out;
}

/** Every estimate the reader may see (the public API and MCP), optionally of one service or platform. */
export function allEstimates(q: { serviceId?: string; platformId?: string } = {}): CostEstimateSummary[] {
  if (q.serviceId) return listEstimates({ kind: 'service', id: q.serviceId });
  if (q.platformId) return listEstimates({ kind: 'platform', id: q.platformId });
  const rows = db().all<EstimateRow>('SELECT * FROM cost_estimates ORDER BY title, id');
  const infos = new Map<string, ScopeInfo | null>();
  return summaries(rows, (r) => {
    const k = `${r.owner_kind}:${r.owner_id}`;
    if (!infos.has(k)) infos.set(k, access(r));
    return infos.get(k)!;
  });
}

/** The estimates that name an application, system, platform or data product the reader may see (its costs panel or tab). */
export function estimatesFor(kind: CostEstimateTargetKind, id: string): CostEstimateSummary[] {
  const rows = db().all<EstimateRow>('SELECT * FROM cost_estimates WHERE for_kind = ? AND for_id = ? ORDER BY title, id', kind, id);
  return summaries(rows, (r) => access(r));
}

export function getEstimate(id: string): CostEstimate {
  const { row, info } = requireEstimate(id);
  const sight = bookSight();
  const cur = info.amounts ? stored(row.result) : null;
  const pend = info.amounts ? stored(row.pending) : null;
  const curView = cur ? viewResult(cur, sight) : null;
  const pendView = pend ? viewResult(pend, sight) : null;
  const num = (s: string) => Number(s);
  const changePct =
    curView && pendView && num(curView.totals.monthly.expected) !== 0
      ? Math.round(((num(pendView.totals.monthly.expected) - num(curView.totals.monthly.expected)) / num(curView.totals.monthly.expected)) * 1000) / 10
      : null;
  const calc = row.calculator_id
    ? db().get<{ id: string; name: string; current_version: number }>('SELECT id, name, current_version FROM cost_calculators WHERE id = ?', row.calculator_id)
    : undefined;
  const lines = db().all<{ id: string; fiscal_year: number; title: string; estimate_basis: string | null }>(
    'SELECT id, fiscal_year, title, estimate_basis FROM cost_plan_lines WHERE estimate_id = ? ORDER BY fiscal_year, created_at, id',
    id,
  );
  const history = db().all<{ result: string; replaced_at: string; replaced_by: string }>(
    'SELECT result, replaced_at, replaced_by FROM cost_estimate_results WHERE estimate_id = ? ORDER BY id DESC LIMIT ?',
    id,
    COST_ESTIMATE_LIMITS.resultsKept,
  );
  const sm = startMonth();
  const props = new Map<string, ReturnType<typeof proposalsOf>['lines']>();
  const planLines = lines.map((l) => {
    const basis = parseJson<EstimateBasis | null>(l.estimate_basis, null);
    const s = stored(row.result);
    let changed = false;
    if (basis && s) {
      const k = `${l.fiscal_year}|${basis.list}`;
      if (!props.has(k)) props.set(k, proposalsOf(s, row.title, Number(l.fiscal_year), sm, basis.list ? listOnly(s) : SEE_ALL).lines);
      const now = props.get(k)!.find((p) => p.key === basis.key);
      changed = !now || now.months.join(',') !== basis.months.join(',');
    }
    return { id: l.id, fiscalYear: Number(l.fiscal_year), title: l.title, changed };
  });
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    owner: { kind: row.owner_kind, id: row.owner_id, name: info.name },
    for: forOf(row),
    calculator: row.calculator_id
      ? { id: row.calculator_id, name: calc?.name ?? '', version: Number(row.calculator_version ?? 0), latest: Number(calc?.current_version ?? 0) }
      : null,
    inputs: parseJson<{ key: string; value: CostInputValue }[]>(row.inputs, []),
    lines: parseJson<CostEstimateHandLine[]>(row.lines, []),
    adjustments: parseJson<StoredAdjustment[]>(row.adjustments, []).map(({ found: _f, ...a }) => a),
    books: parseJson<{ provider: string; bookId: string }[]>(row.books, []),
    // the contracts chosen – only those whose conditions the reader sees are named
    contracts: parseJson<{ provider: string; contractId: string | null }[]>(row.contracts ?? '[]', []).filter(
      (c) => !c.contractId || sight.conditions(c.contractId),
    ),
    currency: row.currency,
    appliesFrom: row.applies_from,
    amountsVisible: info.amounts,
    canEdit: info.canEditPlan,
    result: curView,
    pending: pendView ? { ...pendView, changePct } : null,
    planLines,
    history: info.amounts
      ? history.map((h) => {
          const s = stored(h.result);
          const v = s ? viewResult(s, sight) : null;
          return { at: h.replaced_at, by: h.replaced_by, monthly: v?.totals.monthly.expected ?? null, oneOff: v?.totals.oneOff.expected ?? null };
        })
      : [],
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

// ---------- writing ----------

function platformOf(o: OwnerRef, t: { kind: CostEstimateTargetKind; id: string } | null): string | null {
  if (o.kind === 'platform') return o.id;
  return t?.kind === 'platform' ? t.id : null;
}

/** What the pricing prefers for an estimate: the owner's (or target's) platform and the owning service. */
const ownerOptions = (o: OwnerRef, t: { kind: CostPlanTargetKind; id: string } | null) => ({
  platformId: platformOf(o, t),
  serviceId: o.kind === 'service' ? o.id : null,
});

/** Keeps who added an adjustment and when; a new or changed one is the current person's. */
function stampAdjustments(next: readonly CostAdjustment[], before: readonly StoredAdjustment[], found: Map<string, string>): StoredAdjustment[] {
  const same = (a: CostAdjustment, b: CostAdjustment) =>
    a.line === b.line &&
    a.kind === b.kind &&
    a.percent === b.percent &&
    a.price === b.price &&
    a.currency === b.currency &&
    a.block === b.block &&
    a.reason === b.reason;
  const now = nowIso();
  return next.map((a) => {
    const old = before.find((b) => same(a, b));
    if (old) return old;
    return { ...a, by: currentActor(), at: now, ...(a.kind === 'price' && a.line && found.has(a.line) ? { found: found.get(a.line) } : {}) };
  });
}

function fixedFound(adj: readonly StoredAdjustment[]): Map<string, string> {
  return new Map(adj.filter((a) => a.kind === 'price' && a.line && a.found).map((a) => [a.line!, a.found!]));
}

function recordBooks(
  id: string,
  versionIds: readonly string[],
  keep: readonly string[] = [],
  contractIds: readonly string[] = [],
  keepContracts: readonly string[] = [],
): void {
  db().run('DELETE FROM cost_estimate_books WHERE estimate_id = ?', id);
  for (const v of new Set([...versionIds, ...keep]))
    db().run('INSERT INTO cost_estimate_books (estimate_id, version_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, v);
  // the contracts whose conditions it used (a changed condition recalculates it)
  db().run('DELETE FROM cost_estimate_contracts WHERE estimate_id = ?', id);
  for (const c of new Set([...contractIds, ...keepContracts]))
    db().run('INSERT INTO cost_estimate_contracts (estimate_id, contract_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, c);
}

function keepHistory(id: string, result: string | null): void {
  if (!result) return;
  db().run('INSERT INTO cost_estimate_results (estimate_id, result, replaced_at, replaced_by) VALUES (?, ?, ?, ?)', id, result, nowIso(), currentActor());
  const old = db()
    .all<{ id: number }>('SELECT id FROM cost_estimate_results WHERE estimate_id = ? ORDER BY id DESC', id)
    .slice(COST_ESTIMATE_LIMITS.resultsKept);
  for (const o of old) db().run('DELETE FROM cost_estimate_results WHERE id = ?', o.id);
}

const totalsText = (s: StoredResult): string => {
  const v = viewResult(s, SEE_ALL);
  const m = v.totals.monthly;
  return `${m.expected} ${s.currency}/month${s.ranged ? ` (${m.low}–${m.high})` : ''}${v.totals.oneOff.expected !== '0.00' ? ` + ${v.totals.oneOff.expected} ${s.currency} one-off` : ''}`;
};
const adjustmentsOf = (a: readonly StoredAdjustment[]) =>
  a.map((x) => ({
    line: x.line,
    kind: x.kind,
    value: x.kind === 'percent' ? x.percent : x.price,
    currency: x.currency ?? null,
    reason: x.reason,
    by: x.by,
    at: x.at,
  }));

export async function createEstimate(body: unknown): Promise<CostEstimate> {
  const x = costEstimateInput.parse(body);
  const o: OwnerRef = { kind: x.ownerKind, id: x.ownerId };
  const info = requireScope(o.kind, o.id);
  if (!info.canEditPlan) throw new HttpError(403, `You are not allowed to change the estimates of "${info.name}"`, 'FORBIDDEN', { context: 'costEstimate' });
  checkFor(o, x.for);
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_estimates WHERE owner_kind = ? AND owner_id = ?', o.kind, o.id)?.n ?? 0);
  if (n >= COST_ESTIMATE_LIMITS.perOwner)
    throw new HttpError(409, `"${info.name}" has ${COST_ESTIMATE_LIMITS.perOwner} estimates – the most it may have`, 'COST_ESTIMATE_LIMIT', {
      max: COST_ESTIMATE_LIMITS.perOwner,
      what: 'estimates',
    });
  const calc = await calculateOne(
    {
      calculatorId: x.calculatorId,
      calculatorVersion: x.calculatorVersion,
      inputs: x.inputs,
      lines: x.lines,
      adjustments: x.adjustments,
      books: x.books,
      contracts: x.contracts,
      currency: x.currency,
      appliesFrom: x.appliesFrom,
    },
    ownerOptions(o, x.for),
  );
  const r = calc.result;
  const adjustments = stampAdjustments(x.adjustments as CostAdjustment[], [], calc.found);
  const id = newId('cest_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO cost_estimates (id, owner_kind, owner_id, for_kind, for_id, title, description, calculator_id, calculator_version, inputs, lines, adjustments, books,
         contracts, currency, applies_from, result, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      o.kind,
      o.id,
      x.for?.kind ?? null,
      x.for?.id ?? null,
      x.title,
      x.description,
      r.calculator?.id || null,
      r.calculator?.version || null,
      JSON.stringify(x.inputs),
      JSON.stringify(x.lines),
      JSON.stringify(adjustments),
      JSON.stringify(x.books),
      JSON.stringify(x.contracts),
      x.currency,
      r.appliesFrom,
      JSON.stringify(r),
      now,
      currentActor(),
      now,
      currentActor(),
    );
    recordBooks(id, calc.versionIds, [], calc.contractIds);
    audit({
      action: 'cost.estimate_added',
      entityType: o.kind,
      entityId: o.id,
      summary: `Estimate "${x.title}" of "${info.name}" added: ${totalsText(r)}${r.adjusted ? ', with ad-hoc adjustments' : ''}`,
      details: {
        estimateId: id,
        calculator: r.calculator,
        inputs: x.inputs,
        lines: x.lines.length,
        currency: x.currency,
        appliesFrom: r.appliesFrom,
        books: r.books.map((b) => ({ id: b.id, version: b.version })),
        rates: r.rates,
        adjustments: adjustmentsOf(adjustments),
        totals: viewResult(r, SEE_ALL).totals,
      },
    });
  });
  return getEstimate(id);
}

export async function updateEstimate(id: string, body: unknown): Promise<CostEstimate> {
  const { row, info } = requireEstimate(id, 'edit');
  const x = costEstimateUpdate.parse(body);
  const o = ownerOf(row);
  checkFor(o, x.for);
  const before = parseJson<StoredAdjustment[]>(row.adjustments, []);
  const calc = await calculateOne(
    {
      calculatorId: x.calculatorId,
      calculatorVersion: x.calculatorVersion,
      inputs: x.inputs,
      lines: x.lines,
      adjustments: x.adjustments,
      books: x.books,
      contracts: x.contracts,
      currency: x.currency,
      appliesFrom: x.appliesFrom,
    },
    { ...ownerOptions(o, x.for), fixedFound: fixedFound(before) },
  );
  const r = calc.result;
  const adjustments = stampAdjustments(x.adjustments as CostAdjustment[], before, calc.found);
  const prev = stored(row.result);
  db().tx(() => {
    keepHistory(id, row.result);
    db().run(
      `UPDATE cost_estimates SET for_kind = ?, for_id = ?, title = ?, description = ?, calculator_id = ?, calculator_version = ?, inputs = ?, lines = ?, adjustments = ?,
         books = ?, contracts = ?, currency = ?, applies_from = ?, result = ?, pending = NULL, updated_at = ?, updated_by = ? WHERE id = ?`,
      x.for?.kind ?? null,
      x.for?.id ?? null,
      x.title,
      x.description,
      r.calculator?.id || null,
      r.calculator?.version || null,
      JSON.stringify(x.inputs),
      JSON.stringify(x.lines),
      JSON.stringify(adjustments),
      JSON.stringify(x.books),
      JSON.stringify(x.contracts),
      x.currency,
      r.appliesFrom,
      JSON.stringify(r),
      nowIso(),
      currentActor(),
      id,
    );
    recordBooks(id, calc.versionIds, [], calc.contractIds);
    audit({
      action: 'cost.estimate_changed',
      entityType: o.kind,
      entityId: o.id,
      summary: `Estimate "${x.title}" of "${info.name}" changed: ${totalsText(r)}${prev ? ` (was ${totalsText(prev)})` : ''}`,
      details: {
        estimateId: id,
        before: {
          title: row.title,
          calculatorVersion: row.calculator_version,
          inputs: parseJson(row.inputs, []),
          adjustments: adjustmentsOf(before),
          totals: prev ? viewResult(prev, SEE_ALL).totals : null,
        },
        after: {
          title: x.title,
          calculatorVersion: r.calculator?.version ?? null,
          inputs: x.inputs,
          adjustments: adjustmentsOf(adjustments),
          totals: viewResult(r, SEE_ALL).totals,
        },
      },
    });
  });
  return getEstimate(id);
}

/**
 * Prices the estimate again with the books' current versions (and its calculator version): the result is kept beside
 * the current one until "Accept new prices". Nothing is pending when nothing changed.
 */
export async function recalculateEstimate(id: string): Promise<CostEstimate> {
  const { row } = requireEstimate(id, 'edit');
  const adj = parseJson<StoredAdjustment[]>(row.adjustments, []);
  const calc = await calculateOne(
    {
      calculatorId: row.calculator_id,
      calculatorVersion: row.calculator_version,
      inputs: parseJson(row.inputs, []),
      lines: parseJson(row.lines, []),
      adjustments: adj.map(({ by: _b, at: _a, found: _f, ...a }) => a),
      books: parseJson(row.books, []),
      contracts: parseJson(row.contracts ?? '[]', []),
      currency: row.currency,
      appliesFrom: row.applies_from,
    },
    { ...ownerOptions(ownerOf(row), row.for_kind && row.for_id ? { kind: row.for_kind, id: row.for_id } : null), fixedFound: fixedFound(adj) },
  );
  const cur = stored(row.result);
  const sameAs = (a: StoredResult | null, b: StoredResult) =>
    !!a && JSON.stringify({ ...a, calculatedAt: '', calculatedBy: '' }) === JSON.stringify({ ...b, calculatedAt: '', calculatedBy: '' });
  db().tx(() => {
    if (sameAs(cur, calc.result)) db().run('UPDATE cost_estimates SET pending = NULL WHERE id = ?', id);
    else {
      db().run('UPDATE cost_estimates SET pending = ? WHERE id = ?', JSON.stringify(calc.result), id);
      const keep = db()
        .all<{ version_id: string }>('SELECT version_id FROM cost_estimate_books WHERE estimate_id = ?', id)
        .map((v) => v.version_id);
      const keepContracts = db()
        .all<{ contract_id: string }>('SELECT contract_id FROM cost_estimate_contracts WHERE estimate_id = ?', id)
        .map((v) => v.contract_id);
      recordBooks(id, calc.versionIds, keep, calc.contractIds, keepContracts);
    }
  });
  return getEstimate(id);
}

/** "Accept new prices": the recalculated result becomes current; the one before goes into the history. */
export function acceptEstimate(id: string): CostEstimate {
  const { row, info } = requireEstimate(id, 'edit');
  const pend = stored(row.pending);
  if (!pend) throw new HttpError(409, 'Nothing to accept – recalculate first', 'COST_ESTIMATE_NOTHING_PENDING');
  const prev = stored(row.result);
  db().tx(() => {
    keepHistory(id, row.result);
    db().run('UPDATE cost_estimates SET result = ?, pending = NULL, updated_at = ?, updated_by = ? WHERE id = ?', row.pending, nowIso(), currentActor(), id);
    recordBooks(
      id,
      pend.versionIds ?? [],
      [],
      (pend.contracts ?? []).map((c) => c.id),
    );
    audit({
      action: 'cost.estimate_accepted',
      entityType: row.owner_kind,
      entityId: row.owner_id,
      summary: `New prices of the estimate "${row.title}" of "${info.name}" accepted: ${totalsText(pend)}${prev ? ` (was ${totalsText(prev)})` : ''}`,
      details: {
        estimateId: id,
        books: pend.books.map((b) => ({ id: b.id, version: b.version })),
        before: prev ? viewResult(prev, SEE_ALL).totals : null,
        after: viewResult(pend, SEE_ALL).totals,
      },
    });
  });
  return getEstimate(id);
}

export function removeEstimate(id: string): void {
  const { row, info } = requireEstimate(id, 'edit');
  db().tx(() => {
    // plan lines made from it stay, as the team's statements
    const lines = db().run('UPDATE cost_plan_lines SET estimate_id = NULL, estimate_basis = NULL WHERE estimate_id = ?', id).changes;
    db().run('DELETE FROM cost_estimate_results WHERE estimate_id = ?', id);
    db().run('DELETE FROM cost_estimate_books WHERE estimate_id = ?', id);
    db().run('DELETE FROM cost_estimate_contracts WHERE estimate_id = ?', id);
    db().run('DELETE FROM cost_estimates WHERE id = ?', id);
    audit({
      action: 'cost.estimate_removed',
      entityType: row.owner_kind,
      entityId: row.owner_id,
      summary: `Estimate "${row.title}" of "${info.name}" removed${lines ? ` (${lines} plan line(s) keep their amounts)` : ''}`,
      details: { estimateId: id, title: row.title, planLines: lines },
    });
  });
}

/** Removes the estimates of a deleted service or platform. */
export function forgetEstimates(kind: 'service' | 'platform', id: string): number {
  const rows = db().all<{ id: string }>('SELECT id FROM cost_estimates WHERE owner_kind = ? AND owner_id = ?', kind, id);
  for (const r of rows) {
    db().run('DELETE FROM cost_estimate_results WHERE estimate_id = ?', r.id);
    db().run('DELETE FROM cost_estimate_books WHERE estimate_id = ?', r.id);
    db().run('DELETE FROM cost_estimate_contracts WHERE estimate_id = ?', r.id);
  }
  db().run('DELETE FROM cost_estimates WHERE owner_kind = ? AND owner_id = ?', kind, id);
  return rows.length;
}

// ---------- plan lines from an estimate ----------

export const estimateLinesInput = z.object({ fiscalYear: z.number().int().min(2000).max(2100).optional() }).strict();

const yearOf = (fy: number | undefined): number => fy ?? fiscalYearOf(thisMonth(Date.now()), startMonth());

/** What the estimate proposes for a fiscal year (the reader's view: list prices for books they may not see). */
export function estimateProposals(id: string, fiscalYear?: number): CostEstimateProposals {
  const { row, info } = requireEstimate(id);
  const fy = yearOf(fiscalYear);
  const s = info.amounts ? stored(row.result) : null;
  const sm = startMonth();
  const sight = bookSight();
  const p = s ? proposalsOf(s, row.title, fy, sm, sight) : { lines: [], hidden: false };
  const hiddenRates = !!s && confidential(s);
  const existing = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_plan_lines WHERE estimate_id = ? AND fiscal_year = ?', id, fy)?.n ?? 0);
  return {
    fiscalYear: fy,
    label: fiscalYearLabel(fy, sm),
    currency: row.currency,
    lines: p.lines.map(({ micros: _m, months: _x, fromIndex: _f, toIndex: _t, ...l }) => l),
    hiddenRates,
    adjusted: !!s?.adjusted,
    existing,
  };
}

/** Priced with rates not every reader may see: a contracted or derived book, or a contract's conditions (0.23.0). */
const confidential = (s: StoredResult): boolean => s.books.some((b) => b.kind !== 'list') || s.lines.some((l) => !!l.cid);

/** "Add to plan": the chosen proposals become plan lines of the fiscal year, each remembering the estimate. */
export function confirmEstimateProposals(id: string, body: unknown): { added: number; lineIds: string[] } {
  const { row, info } = requireEstimate(id, 'edit');
  const x = costEstimateProposalInput.parse(body);
  const s = stored(row.result);
  if (!s) throw new HttpError(409, 'The estimate has no result yet', 'COST_ESTIMATE_NOTHING_PENDING');
  const sight = bookSight();
  const p = proposalsOf(s, row.title, x.fiscalYear, startMonth(), sight);
  const chosen = p.lines.filter((l) => x.keys.includes(l.key));
  if (!chosen.length) throw new HttpError(400, 'Choose lines of the proposal', 'COST_PROPOSAL_NONE', { year: fiscalYearLabel(x.fiscalYear, startMonth()) });
  if (confidential(s) && !x.confirmHidden)
    throw new HttpError(409, 'Readers of this plan will see these amounts', 'COST_ESTIMATE_HIDDEN_RATES', { title: row.title });
  const o = ownerOf(row);
  const col = o.kind === 'service' ? 'service_id' : 'platform_id';
  const have = Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM cost_plan_lines WHERE ${col} = ? AND fiscal_year = ?`, o.id, x.fiscalYear)?.n ?? 0);
  if (have + chosen.length > COST_PLAN_LIMITS.linesPerYear)
    throw new HttpError(
      409,
      `These proposals add ${chosen.length} plan lines; the year can take ${COST_PLAN_LIMITS.linesPerYear - have} more`,
      'COST_PROPOSAL_LIMIT',
      {
        adding: chosen.length,
        left: COST_PLAN_LIMITS.linesPerYear - have,
        max: COST_PLAN_LIMITS.linesPerYear,
      },
    );
  const now = nowIso();
  const ids: string[] = [];
  const note = `From the estimate “${row.title}”${s.adjusted ? ' – with ad-hoc adjustments' : ''}${p.hidden ? ' – at list prices for some lines' : ''}`;
  db().tx(() => {
    for (const l of chosen) {
      const lid = newId('cpl_');
      ids.push(lid);
      const basis: EstimateBasis = { key: l.key, months: l.months, list: p.hidden };
      db().run(
        `INSERT INTO cost_plan_lines (id, service_id, platform_id, fiscal_year, title, category, target_kind, target_id, vendor, amount, currency, cadence, once_index,
           from_index, to_index, estimate_id, estimate_basis, note, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lid,
        o.kind === 'service' ? o.id : '',
        o.kind === 'platform' ? o.id : null,
        x.fiscalYear,
        l.title,
        x.category,
        // a data product is no target of a plan line (showback, never chargeback – ADR 0036 part 11)
        o.kind === 'service' && row.for_kind !== 'dataProduct' ? row.for_kind : null,
        o.kind === 'service' && row.for_kind !== 'dataProduct' ? row.for_id : null,
        l.micros,
        row.currency,
        l.cadence,
        l.cadence === 'once' ? l.fromIndex : null,
        l.cadence === 'once' || l.fromIndex === 0 ? null : l.fromIndex,
        l.cadence === 'once' || l.toIndex === 11 ? null : l.toIndex,
        id,
        JSON.stringify(basis),
        note,
        now,
        currentActor(),
        now,
        currentActor(),
      );
    }
    audit({
      action: 'cost.estimate_lines_added',
      entityType: o.kind,
      entityId: o.id,
      summary: `${chosen.length} plan line(s) of "${info.name}" (${fiscalYearLabel(x.fiscalYear, startMonth())}) made from the estimate "${row.title}"${s.adjusted ? ' (with ad-hoc adjustments)' : ''}`,
      details: {
        estimateId: id,
        fiscalYear: x.fiscalYear,
        hiddenRatesConfirmed: x.confirmHidden,
        lines: chosen.map((l, i) => ({
          lineId: ids[i],
          title: l.title,
          cadence: l.cadence,
          amount: microsText(l.micros, row.currency),
          from: l.fromMonth,
          to: l.toMonth,
        })),
      },
    });
  });
  return { added: chosen.length, lineIds: ids };
}

/**
 * "Update lines": plan lines made from the estimate whose amount and months are still what they were made from take
 * the estimate's current proposal of the same key; a line changed by hand keeps its amount (and its estimate).
 */
export function updateEstimateLines(id: string, body: unknown): { updated: number; kept: number } {
  const { row, info } = requireEstimate(id, 'edit');
  const fy = estimateLinesInput.parse(body ?? {}).fiscalYear;
  const s = stored(row.result);
  if (!s) return { updated: 0, kept: 0 };
  const lines = db().all<{
    id: string;
    fiscal_year: number;
    title: string;
    amount: number;
    cadence: string;
    once_index: number | null;
    from_index: number | null;
    to_index: number | null;
    estimate_basis: string | null;
  }>(
    `SELECT id, fiscal_year, title, amount, cadence, once_index, from_index, to_index, estimate_basis FROM cost_plan_lines WHERE estimate_id = ?${fy ? ' AND fiscal_year = ?' : ''}`,
    id,
    ...(fy ? [fy] : []),
  );
  const sm = startMonth();
  let updated = 0;
  let kept = 0;
  const changes: { lineId: string; before: string; after: string }[] = [];
  const now = nowIso();
  db().tx(() => {
    for (const l of lines) {
      const basis = parseJson<EstimateBasis | null>(l.estimate_basis, null);
      if (!basis) continue;
      if (planMonthsOf(l).join(',') !== basis.months.join(',')) {
        kept++;
        continue;
      }
      const props = proposalsOf(s, row.title, Number(l.fiscal_year), sm, basis.list ? listOnly(s) : bookSight());
      const p = props.lines.find((x) => x.key === basis.key);
      if (!p || p.months.join(',') === basis.months.join(',')) continue;
      db().run(
        `UPDATE cost_plan_lines SET amount = ?, cadence = ?, once_index = ?, from_index = ?, to_index = ?, estimate_basis = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
        p.micros,
        p.cadence,
        p.cadence === 'once' ? p.fromIndex : null,
        p.cadence === 'once' || p.fromIndex === 0 ? null : p.fromIndex,
        p.cadence === 'once' || p.toIndex === 11 ? null : p.toIndex,
        JSON.stringify({ ...basis, months: p.months }),
        now,
        currentActor(),
        l.id,
      );
      changes.push({ lineId: l.id, before: microsText(Number(l.amount), row.currency), after: microsText(p.micros, row.currency) });
      updated++;
    }
    if (updated)
      audit({
        action: 'cost.estimate_lines_updated',
        entityType: row.owner_kind,
        entityId: row.owner_id,
        summary: `${updated} plan line(s) of "${info.name}" updated from the estimate "${row.title}"${kept ? `; ${kept} changed by hand kept` : ''}`,
        details: { estimateId: id, lines: changes, kept },
      });
  });
  return { updated, kept };
}

/** The twelve month amounts of a stored plan line (as the plan computes them). */
function planMonthsOf(l: { amount: number; cadence: string; once_index: number | null; from_index: number | null; to_index: number | null }): number[] {
  const out = Array.from({ length: 12 }, () => 0);
  const amount = Number(l.amount);
  if (l.cadence === 'once') {
    if (l.once_index !== null) out[Number(l.once_index)] = amount;
    return out;
  }
  if (l.cadence !== 'monthly') return out.map(() => NaN);
  const from = l.from_index === null ? 0 : Number(l.from_index);
  const to = l.to_index === null ? 11 : Number(l.to_index);
  for (let i = from; i <= to; i++) out[i] = amount;
  return out;
}

// ---------- recalculation in the background (0.23.0, ADR 0035 part 6) ----------

/** What made an estimate due for recalculation: a new version of a book it used, or a changed contract condition. */
export interface RecalcCause {
  book?: { id: string; name: string; version: number };
  contract?: { id: string; title: string; at: string };
}

/** Marks the estimates that used a book or a contract's conditions: the job "costs" recalculates them. */
function markRecalc(sql: string, cause: RecalcCause, ...params: unknown[]): void {
  db().run(`UPDATE cost_estimates SET recalc_cause = ? WHERE id IN (${sql})`, JSON.stringify(cause), ...params);
}
onVersionWritten((bookId, version) => {
  const b = bookRow(bookId);
  markRecalc(
    'SELECT b.estimate_id FROM cost_estimate_books b JOIN cost_price_book_versions v ON v.id = b.version_id WHERE v.book_id = ?',
    { book: { id: bookId, name: b?.name ?? bookId, version } },
    bookId,
  );
});
onConditionsChanged((contractId) => {
  const c = db().get<{ title: string }>('SELECT title FROM supplier_contracts WHERE id = ?', contractId);
  // an order form inheriting them is recorded under its own id: its estimates follow too
  markRecalc(
    'SELECT estimate_id FROM cost_estimate_contracts WHERE contract_id = ? OR contract_id IN (SELECT id FROM supplier_contracts WHERE parent_id = ?)',
    { contract: { id: contractId, title: c?.title ?? contractId, at: nowIso() } },
    contractId,
    contractId,
  );
});

/**
 * The choices a background recalculation pins: per provider the book and the contract the current result used (or
 * the ones the estimate chose) – the job sees every book and contract, so it must not choose others than its editor did.
 * Null when a book it used is gone.
 */
function pinnedChoices(
  row: EstimateRow,
  cur: StoredResult | null,
): { books: { provider: string; bookId: string }[]; contracts: { provider: string; contractId: string | null }[] } | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const books = new Map(parseJson<{ provider: string; bookId: string }[]>(row.books, []).map((b) => [norm(b.provider), b]));
  const contracts = new Map(parseJson<{ provider: string; contractId: string | null }[]>(row.contracts ?? '[]', []).map((c) => [norm(c.provider), c]));
  // the book each provider was priced from: its contracted or derived book before a list book it fell back to
  for (const b of [...(cur?.books ?? [])].sort((x, y) => (x.kind === 'list' ? 1 : 0) - (y.kind === 'list' ? 1 : 0)))
    if (!books.has(norm(b.provider))) books.set(norm(b.provider), { provider: b.provider, bookId: b.id });
  // the contract whose conditions it used – or none: the job must not apply a contract its editor did not
  for (const c of cur?.contracts ?? []) if (!contracts.has(norm(c.provider))) contracts.set(norm(c.provider), { provider: c.provider, contractId: c.id });
  for (const l of cur?.lines ?? []) if (!contracts.has(norm(l.provider))) contracts.set(norm(l.provider), { provider: l.provider, contractId: null });
  for (const b of books.values()) if (!bookRow(b.bookId)) return null;
  return { books: [...books.values()], contracts: [...contracts.values()] };
}

/**
 * Recalculates an estimate in the job (no reader): the same books and contracts, their current versions and
 * conditions; the result goes beside the current one (pending) when it differs. Returns the results for the notice.
 */
export async function recalculateInBackground(row: EstimateRow): Promise<{ before: StoredResult | null; after: StoredResult | null }> {
  const cur = stored(row.result);
  const pin = pinnedChoices(row, cur);
  if (!pin) {
    db().run('UPDATE cost_estimates SET recalc_cause = NULL WHERE id = ?', row.id);
    return { before: cur, after: null };
  }
  const adj = parseJson<StoredAdjustment[]>(row.adjustments, []);
  const calc = await calculateOne(
    {
      calculatorId: row.calculator_id,
      calculatorVersion: row.calculator_version,
      inputs: parseJson(row.inputs, []),
      lines: parseJson(row.lines, []),
      adjustments: adj.map(({ by: _b, at: _a, found: _f, ...a }) => a),
      books: pin.books,
      contracts: pin.contracts,
      currency: row.currency,
      appliesFrom: row.applies_from,
    },
    { ...ownerOptions(ownerOf(row), row.for_kind && row.for_id ? { kind: row.for_kind, id: row.for_id } : null), fixedFound: fixedFound(adj) },
  );
  const same =
    !!cur && JSON.stringify({ ...cur, calculatedAt: '', calculatedBy: '' }) === JSON.stringify({ ...calc.result, calculatedAt: '', calculatedBy: '' });
  db().tx(() => {
    if (same) db().run('UPDATE cost_estimates SET pending = NULL, recalc_cause = NULL WHERE id = ?', row.id);
    else {
      db().run('UPDATE cost_estimates SET pending = ?, recalc_cause = NULL WHERE id = ?', JSON.stringify(calc.result), row.id);
      const keep = db()
        .all<{ version_id: string }>('SELECT version_id FROM cost_estimate_books WHERE estimate_id = ?', row.id)
        .map((v) => v.version_id);
      const keepContracts = db()
        .all<{ contract_id: string }>('SELECT contract_id FROM cost_estimate_contracts WHERE estimate_id = ?', row.id)
        .map((v) => v.contract_id);
      recordBooks(row.id, calc.versionIds, keep, calc.contractIds, keepContracts);
    }
  });
  return { before: cur, after: same ? null : calc.result };
}

/** The estimates due for recalculation (at most `limit`). */
export const dueEstimates = (limit: number): EstimateRow[] =>
  db().all<EstimateRow>('SELECT * FROM cost_estimates WHERE recalc_cause IS NOT NULL ORDER BY updated_at, id LIMIT ?', limit);

/** The amounts a reader sees of a stored result (per month, expected), or null without amounts. */
export function monthlyFor(r: StoredResult, sight: PriceSight): number {
  return Number(viewResult(r, sight).totals.monthly.expected);
}
