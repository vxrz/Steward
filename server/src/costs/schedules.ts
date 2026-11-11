import {
  COST_PLAN_LIMITS,
  COST_SCHEDULE_LIMITS,
  costContractUpdates,
  costProposalConfirm,
  costScheduleInput,
  costScheduleUpdate,
  fiscalYearLabel,
  fiscalYearMonths,
  fiscalYearOf,
  fromMicros,
  moneyText,
  scheduleEnd,
  scheduleOwed,
  scheduleStart,
  basisDiffers,
  toMicros,
  type CostPlanYear,
  type CostProposals,
  type CostSchedule,
  type CostScheduleList,
  type SupplierRef,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser } from '../auth/context.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { contractEditable, contractVisible, supplierRefs, visibleContracts } from '../suppliers/links.js';
import { ScopeCtx } from '../suppliers/contract-scope.js';
import { scopeInfo, visibleScopes, type ScopeInfo } from './access.js';
import { catalogueOf, checkTarget, lineRows, planYearOf, requireEdit, startMonth, targetOf, thisMonth, today, type LineRow } from './plans.js';
import {
  dropSchedules,
  insertScheduleLine,
  proposalLine,
  scheduleSnapshot as snapshot,
  schedulesOfContract,
  schedulesOfService,
  schedulesWhere,
  scheduleLineTitle,
  type Schedule,
  type ScheduleRow,
} from './schedule-model.js';

/**
 * Payment schedules of supplier contracts and the contract lines of cost plans (0.18.0, ADR 0030 parts 2–3,
 * docs/COSTS.md#contract-payments-and-commitments).
 *
 * - A schedule exists for a reader only through its paying service: lists neither name nor count schedules of services
 *   the reader may not see. A reader who sees the service but not the contract (contractVisible) sees "a contract of a
 *   supplier you may not see" – amounts, no supplier, title or dates.
 * - Add, change, remove a schedule: who may change the contract (contractEditable, ADR 0031: its owners, designers,
 *   administrators, the supplier's owners who see it, editors of its covered services), or who may edit the paying
 *   service and see the contract. The paying service must be covered by the contract: a schedule for another service
 *   adds it when the person may change the contract, else it is refused (ADR 0031 decided 16). Audited on the service
 *   (`cost.schedule_added|changed|removed`), naming supplier and contract.
 * - Proposals ("Add to plan"), "Update lines": who may change the service (requireEdit). Nothing is created without a
 *   person; years that are over are never updated. Audited as `cost.contract_lines_added|updated`.
 * - These are new writes for people: the routes need a signed-in session (routes.ts). No step-up (ADR 0026).
 */

const show = (info: ScopeInfo) => (n: number) => (info.amounts ? fromMicros(n) : null);

function scheduleRow(id: string): ScheduleRow {
  const r = db().get<ScheduleRow>('SELECT * FROM cost_schedules WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Payment schedule ${id} not found`, 'COST_SCHEDULE_NOT_FOUND', { id });
  return r;
}

interface ContractRow {
  id: string;
  supplier_id: string;
  owners: string;
  title: string;
  s_name: string;
  s_owners: string;
  s_status: 'unconfirmed' | 'active' | 'archived';
}

/** The contract with its supplier (no visibility check). */
const contractRow = (id: string): ContractRow | undefined =>
  db().get<ContractRow>(
    `SELECT c.id, c.supplier_id, c.owners, c.title, s.name AS s_name, s.owners AS s_owners, s.status AS s_status
       FROM supplier_contracts c JOIN suppliers s ON s.id = c.supplier_id WHERE c.id = ?`,
    id,
  );

const supplierOf = (c: ContractRow) => ({ id: c.supplier_id, owners: c.s_owners, status: c.s_status });

/** A contract the reader may see (404 otherwise, like one that does not exist). */
function visibleContract(id: string): ContractRow {
  const c = contractRow(id);
  if (!c || !contractVisible(c, supplierOf(c))) throw new HttpError(404, `Contract ${id} not found`, 'SUPPLIER_CONTRACT_NOT_FOUND', { id });
  return c;
}

/** Who may add, change or remove a schedule: who may change the contract, or edit the paying service and see the contract. */
function mayChange(c: ContractRow, service: ScopeInfo | null, ctx = new ScopeCtx()): boolean {
  if (contractEditable(c, supplierOf(c), currentUser(), ctx)) return true;
  return !!service?.canEditBudget && contractVisible(c, supplierOf(c), currentUser(), ctx);
}

function requireChange(c: ContractRow, service: ScopeInfo | null): void {
  if (!mayChange(c, service))
    throw new HttpError(403, `You are not allowed to change the payments of the contract "${c.title}"`, 'COST_SCHEDULE_FORBIDDEN', { contract: c.title });
}

// ---------- reading ----------

/**
 * Schedules as the reader may see them: only those of services they may see; the contract (supplier, title, dates)
 * only when they may see it.
 */
function toViews(list: Schedule[], now: number): CostSchedule[] {
  const services = new Map<string, ScopeInfo | null>();
  const info = (id: string) => {
    if (!services.has(id)) services.set(id, scopeInfo('service', id));
    return services.get(id)!;
  };
  const seen = visibleContracts(list.map((x) => x.contract.id));
  const refs = supplierRefs(list.map((x) => x.contract.supplierId));
  const day = today(now);
  const start = startMonth();
  const out: CostSchedule[] = [];
  // one reader's view of the contracts' scopes for the whole list (services read once)
  const ctx = new ScopeCtx().load(list.map((x) => x.contract.id));
  for (const x of list) {
    const svc = info(x.row.service_id);
    if (!svc) continue;
    const visible = seen.has(x.contract.id);
    const s = show(svc);
    const c = contractRow(x.contract.id);
    const owed = scheduleOwed(x.spec, x.terms, day, start);
    out.push({
      id: x.row.id,
      contractId: x.contract.id,
      serviceId: x.row.service_id,
      serviceName: svc.name,
      supplier: visible ? (refs.get(x.contract.supplierId) ?? null) : null,
      contract: visible ? { id: x.contract.id, title: x.contract.title, reference: x.contract.reference } : null,
      contractHidden: !visible,
      title: x.row.title,
      category: x.row.category,
      target: x.row.target_kind && x.row.target_id ? { kind: x.row.target_kind, id: x.row.target_id, name: '', visible: false } : null,
      amount: s(Number(x.row.amount)),
      currency: x.row.currency,
      billing: x.row.billing,
      firstPaymentOn: x.row.first_payment_on,
      startsOn: x.row.starts_on,
      endsOn: x.row.ends_on,
      effectiveStart: visible ? scheduleStart(x.spec, x.terms) : null,
      effectiveEnd: visible ? scheduleEnd(x.spec, x.terms) : null,
      yearAmounts: x.spec.yearAmounts.map((v) => (v === null ? null : s(v))),
      payments: x.spec.payments.map((p) => ({ date: p.date, amount: s(p.amount), coversUntil: p.coversUntil })),
      note: x.row.note,
      nextPayment: owed.nextPayment ? { date: owed.nextPayment.date, amount: s(owed.nextPayment.amount) } : null,
      canEdit: !!c && mayChange(c, svc, ctx),
      createdAt: x.row.created_at,
      createdBy: x.row.created_by,
      updatedAt: x.row.updated_at,
      updatedBy: x.row.updated_by,
    });
  }
  return out;
}

/** The targets of the views (an application or system of the paying service), resolved like the plan's: names only for who may see them. */
function withTargets(views: CostSchedule[]): CostSchedule[] {
  for (const v of views) if (v.target) v.target = targetOf(v.target.kind, v.target.id, catalogueOf(v.serviceId));
  return views;
}

/** GET /api/costs/schedules?contractId=|serviceId= */
export function listSchedules(q: { contractId?: string; serviceId?: string }, now = Date.now()): CostScheduleList {
  const limits = { perContract: COST_SCHEDULE_LIMITS.perContract, perService: COST_SCHEDULE_LIMITS.perService };
  if (q.contractId) {
    const c = visibleContract(q.contractId);
    const editsSome = () => visibleScopes('service').some((s) => s.canEditBudget);
    return {
      schedules: withTargets(toViews(schedulesOfContract(c.id), now)),
      canAdd: contractEditable(c, supplierOf(c)) || (!!currentUser() && c.s_status !== 'archived' && editsSome()),
      limits,
    };
  }
  if (q.serviceId) {
    const info = scopeInfo('service', q.serviceId);
    if (!info) throw new HttpError(404, `Service ${q.serviceId} not found`, 'COST_SCOPE_NOT_FOUND', { scope: 'service', id: q.serviceId });
    return { schedules: withTargets(toViews(schedulesOfService(q.serviceId), now)), canAdd: info.canEditBudget, limits };
  }
  throw new HttpError(400, 'Name a contract or a service', 'COST_SCHEDULE_QUERY');
}

// ---------- changing ----------

function checkLimits(contractId: string, serviceId: string): void {
  const n = (sql: string, id: string) => Number(db().get<{ n: number }>(sql, id)?.n ?? 0);
  if (n('SELECT COUNT(*) AS n FROM cost_schedules WHERE contract_id = ?', contractId) >= COST_SCHEDULE_LIMITS.perContract)
    throw new HttpError(409, `A contract has at most ${COST_SCHEDULE_LIMITS.perContract} payment schedules`, 'COST_SCHEDULE_CONTRACT_LIMIT', {
      max: COST_SCHEDULE_LIMITS.perContract,
    });
  if (n('SELECT COUNT(*) AS n FROM cost_schedules WHERE service_id = ?', serviceId) >= COST_SCHEDULE_LIMITS.perService)
    throw new HttpError(409, `A service pays at most ${COST_SCHEDULE_LIMITS.perService} payment schedules`, 'COST_SCHEDULE_SERVICE_LIMIT', {
      max: COST_SCHEDULE_LIMITS.perService,
    });
}

const micros = (v: string) => toMicros(v) ?? 0;

function columnsOf(x: ReturnType<typeof costScheduleUpdate.parse>) {
  return {
    title: x.title,
    category: x.category,
    target_kind: x.target?.kind ?? null,
    target_id: x.target?.id ?? null,
    amount: x.billing === 'dates' ? 0 : micros(x.amount),
    currency: x.currency,
    billing: x.billing,
    first_payment_on: x.billing === 'dates' ? null : x.firstPaymentOn,
    starts_on: x.startsOn,
    ends_on: x.endsOn,
    year_amounts: JSON.stringify(
      x.billing === 'monthly' || x.billing === 'quarterly' || x.billing === 'yearly' ? x.yearAmounts.map((v) => (v === null ? null : micros(v))) : [],
    ),
    payments: JSON.stringify(x.billing === 'dates' ? x.payments.map((p) => ({ date: p.date, amount: micros(p.amount), coversUntil: p.coversUntil })) : []),
    note: x.note,
  };
}

const summaryOf = (c: ReturnType<typeof columnsOf>) =>
  c.billing === 'dates' ? `${JSON.parse(c.payments).length} dated payment(s) in ${c.currency}` : `${moneyText(c.amount, c.currency)} ${c.billing}`;

/** POST /api/costs/schedules */
export function addSchedule(body: unknown): CostScheduleList {
  const x = costScheduleInput.parse(body);
  const c = visibleContract(x.contractId);
  const svc = scopeInfo('service', x.serviceId);
  if (!svc) throw new HttpError(404, `Service ${x.serviceId} not found`, 'COST_SCOPE_NOT_FOUND', { scope: 'service', id: x.serviceId });
  if (c.s_status === 'archived') throw new HttpError(409, `Supplier "${c.s_name}" is archived`, 'SUPPLIER_ARCHIVED', { name: c.s_name });
  requireChange(c, svc);
  // the paying service must be covered by the contract (ADR 0031 decided 16): a schedule for another service adds it
  // when the person may change the contract; a proposed one is confirmed – the schedule says the service pays
  const cover = db().get<{ status: string }>('SELECT status FROM supplier_contract_services WHERE contract_id = ? AND service_id = ?', c.id, x.serviceId);
  if (!cover && !contractEditable(c, supplierOf(c)))
    throw new HttpError(409, `The contract "${c.title}" does not cover the service "${svc.name}"`, 'COST_SCHEDULE_SERVICE_NOT_COVERED', {
      contract: c.title,
      service: svc.name,
    });
  checkTarget(x.target, catalogueOf(x.serviceId));
  checkLimits(c.id, x.serviceId);
  const cols = columnsOf(x);
  const id = newId('csc_');
  const now = nowIso();
  db().tx(() => {
    if (!cover || cover.status === 'proposed') {
      if (!cover)
        db().run(
          `INSERT INTO supplier_contract_services (contract_id, service_id, purpose, status, proposed_from, added_by, added_at, confirmed_by, confirmed_at)
           VALUES (?, ?, '', 'confirmed', '[]', ?, ?, ?, ?)`,
          c.id,
          x.serviceId,
          currentActor(),
          now,
          currentActor(),
          now,
        );
      else
        db().run(
          "UPDATE supplier_contract_services SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE contract_id = ? AND service_id = ?",
          currentActor(),
          now,
          c.id,
          x.serviceId,
        );
      audit({
        action: cover ? 'supplier.contract_service_confirmed' : 'supplier.contract_service_added',
        entityType: 'supplier',
        entityId: c.supplier_id,
        summary: `Service "${svc.name}" ${cover ? 'confirmed for' : 'added to'} the contract "${c.title}" with a payment schedule`,
        details: { contractId: c.id, serviceId: x.serviceId, service: svc.name, scheduleId: id },
      });
    }
    db().run(
      `INSERT INTO cost_schedules (id, contract_id, service_id, title, category, target_kind, target_id, amount, currency, billing, first_payment_on, starts_on, ends_on,
         year_amounts, payments, note, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      c.id,
      x.serviceId,
      cols.title,
      cols.category,
      cols.target_kind,
      cols.target_id,
      cols.amount,
      cols.currency,
      cols.billing,
      cols.first_payment_on,
      cols.starts_on,
      cols.ends_on,
      cols.year_amounts,
      cols.payments,
      cols.note,
      now,
      currentActor(),
      now,
      currentActor(),
    );
    audit({
      action: 'cost.schedule_added',
      entityType: 'service',
      entityId: x.serviceId,
      summary: `Payment schedule "${cols.title}" of the contract "${c.title}" (${c.s_name}) added for "${svc.name}": ${summaryOf(cols)}`,
      details: { scheduleId: id, contractId: c.id, supplierId: c.supplier_id, after: snapshot(cols) },
    });
  });
  return listSchedules({ contractId: c.id });
}

/** PUT /api/costs/schedules/:id – the contract and the paying service stay. */
export function updateSchedule(id: string, body: unknown): CostScheduleList {
  const before = scheduleRow(id);
  const c = visibleContract(before.contract_id);
  const svc = scopeInfo('service', before.service_id);
  if (!svc) throw new HttpError(404, `Payment schedule ${id} not found`, 'COST_SCHEDULE_NOT_FOUND', { id });
  requireChange(c, svc);
  const x = costScheduleUpdate.parse(body);
  const same = x.target && x.target.kind === before.target_kind && x.target.id === before.target_id;
  if (!same) checkTarget(x.target, catalogueOf(before.service_id));
  const cols = columnsOf(x);
  db().tx(() => {
    db().run(
      `UPDATE cost_schedules SET title = ?, category = ?, target_kind = ?, target_id = ?, amount = ?, currency = ?, billing = ?, first_payment_on = ?, starts_on = ?,
         ends_on = ?, year_amounts = ?, payments = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      cols.title,
      cols.category,
      cols.target_kind,
      cols.target_id,
      cols.amount,
      cols.currency,
      cols.billing,
      cols.first_payment_on,
      cols.starts_on,
      cols.ends_on,
      cols.year_amounts,
      cols.payments,
      cols.note,
      nowIso(),
      currentActor(),
      id,
    );
    audit({
      action: 'cost.schedule_changed',
      entityType: 'service',
      entityId: before.service_id,
      summary: `Payment schedule "${cols.title}" of the contract "${c.title}" (${c.s_name}) changed for "${svc.name}": ${summaryOf(cols)}`,
      details: { scheduleId: id, contractId: c.id, supplierId: c.supplier_id, before: snapshot(before), after: snapshot(cols) },
    });
  });
  return listSchedules({ contractId: c.id });
}

/** DELETE /api/costs/schedules/:id */
export function removeSchedule(id: string): CostScheduleList {
  const before = scheduleRow(id);
  const c = visibleContract(before.contract_id);
  const svc = scopeInfo('service', before.service_id);
  if (!svc) throw new HttpError(404, `Payment schedule ${id} not found`, 'COST_SCHEDULE_NOT_FOUND', { id });
  requireChange(c, svc);
  db().tx(() => dropSchedules([before], 'removed', c.title, c.s_name));
  return listSchedules({ contractId: c.id });
}

// ---------- proposals: "Contract payments to plan" ----------

/** The schedules of a service with payments in the fiscal year and no lines for it there yet. */
function open(serviceId: string, fy: number, start: number, lines: LineRow[]): Schedule[] {
  return schedulesOfService(serviceId).filter((x) => x.parts(fy, start).length && !lines.some((l) => l.schedule_id === x.row.id));
}

/** GET /api/costs/plans/:serviceId/proposals?fiscalYear= */
export function proposals(serviceId: string, year: number | undefined, now = Date.now()): CostProposals {
  const info = scopeInfo('service', serviceId);
  if (!info) throw new HttpError(404, `Service ${serviceId} not found`, 'COST_SCOPE_NOT_FOUND', { scope: 'service', id: serviceId });
  const start = startMonth();
  const fy = year ?? fiscalYearOf(thisMonth(now), start);
  const months = fiscalYearMonths(fy, start);
  const lines = lineRows(serviceId, fy);
  const list = open(serviceId, fy, start, lines);
  const seen = visibleContracts(list.map((x) => x.contract.id));
  const refs = supplierRefs(list.map((x) => x.contract.supplierId));
  const s = show(info);
  return {
    serviceId,
    fiscalYear: fy,
    label: fiscalYearLabel(fy, start),
    canEdit: info.canEditBudget,
    proposals: list.map((x) => {
      const visible = seen.has(x.contract.id);
      const title = visible ? scheduleLineTitle(x) : x.row.title;
      const parts = x.parts(fy, start);
      return {
        scheduleId: x.row.id,
        title,
        contractId: x.contract.id,
        supplier: visible ? ((refs.get(x.contract.supplierId) as SupplierRef | undefined) ?? null) : null,
        contractHidden: !visible,
        currency: x.row.currency,
        lines: parts.map((p) => proposalLine(p, title, months, s)),
        planned: s(parts.reduce((a, p) => a + p.months.reduce((m, v) => m + v, 0), 0)),
      };
    }),
    linesLeft: Math.max(0, COST_PLAN_LIMITS.linesPerYear - lines.length),
  };
}

/** POST /api/costs/plans/:serviceId/proposals – "Add to plan": the selected proposals become plan lines in one step. */
export function confirmProposals(serviceId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const x = costProposalConfirm.parse(body);
  const start = startMonth();
  const lines = lineRows(serviceId, x.fiscalYear);
  const list = open(serviceId, x.fiscalYear, start, lines);
  const chosen = [...new Set(x.scheduleIds)].map((id) => {
    const s = list.find((y) => y.row.id === id);
    if (!s)
      throw new HttpError(409, `Payment schedule ${id} has nothing to plan in ${fiscalYearLabel(x.fiscalYear, start)}`, 'COST_PROPOSAL_NONE', {
        year: fiscalYearLabel(x.fiscalYear, start),
      });
    return s;
  });
  const adding = chosen.reduce((n, s) => n + s.parts(x.fiscalYear, start).length, 0);
  if (lines.length + adding > COST_PLAN_LIMITS.linesPerYear)
    throw new HttpError(
      409,
      `These proposals add ${adding} plan lines; the year can take ${COST_PLAN_LIMITS.linesPerYear - lines.length} more`,
      'COST_PROPOSAL_LIMIT',
      {
        adding,
        left: Math.max(0, COST_PLAN_LIMITS.linesPerYear - lines.length),
        max: COST_PLAN_LIMITS.linesPerYear,
      },
    );
  db().tx(() => {
    const added: { lineId: string; scheduleId: string; part: string; amount: string; cadence: string; currency: string }[] = [];
    for (const s of chosen)
      for (const p of s.parts(x.fiscalYear, start)) {
        const lineId = insertScheduleLine(serviceId, x.fiscalYear, s, p);
        added.push({ lineId, scheduleId: s.row.id, part: p.part, amount: fromMicros(p.amount), cadence: p.cadence, currency: s.row.currency });
      }
    audit({
      action: 'cost.contract_lines_added',
      entityType: 'service',
      entityId: serviceId,
      summary: `${added.length} contract line(s) of ${chosen.length} payment schedule(s) added to the cost plan of "${info.name}" for ${fiscalYearLabel(x.fiscalYear, start)}: ${chosen.map((s) => scheduleLineTitle(s)).join(', ')}`,
      details: {
        fiscalYear: x.fiscalYear,
        schedules: chosen.map((s) => ({ scheduleId: s.row.id, contractId: s.contract.id, supplierId: s.contract.supplierId })),
        lines: added,
      },
    });
  });
  return planYearOf(info, x.fiscalYear, Date.now(), start);
}

// ---------- "Contract changed" → "Update lines" ----------

/**
 * POST /api/costs/plans/:serviceId/contract-updates – applies the selected changes of a fiscal year (the current or a
 * later one) in one step: a changed part changes its line, a part that is gone removes its line (its entries become
 * unplanned), a new part adds one. A change that no longer applies (someone updated the lines meanwhile) is refused.
 */
export function applyContractUpdates(serviceId: string, body: unknown, now = Date.now()): CostPlanYear {
  const info = requireEdit(serviceId);
  const x = costContractUpdates.parse(body);
  const start = startMonth();
  const curFy = fiscalYearOf(thisMonth(now), start);
  if (x.fiscalYear < curFy)
    throw new HttpError(409, `${fiscalYearLabel(x.fiscalYear, start)} is over: its plan stays as planned`, 'COST_UPDATE_PAST_YEAR', {
      year: fiscalYearLabel(x.fiscalYear, start),
    });
  const lines = lineRows(serviceId, x.fiscalYear);
  const schedules = new Map(
    schedulesWhere(
      'id',
      x.changes.map((c) => c.scheduleId),
    )
      .filter((s) => s.row.service_id === serviceId)
      .map((s) => [s.row.id, s]),
  );
  type Step = { kind: 'change' | 'remove' | 'add'; s: Schedule; line?: LineRow; part?: ReturnType<Schedule['parts']>[number] };
  const steps: Step[] = [];
  for (const ch of x.changes) {
    const s = schedules.get(ch.scheduleId);
    const line = lines.find((l) => l.schedule_id === ch.scheduleId && l.schedule_part === ch.part);
    const part = s?.parts(x.fiscalYear, start).find((p) => p.part === ch.part);
    const basis = line?.schedule_basis ? parseJson<number[] | null>(line.schedule_basis, null) : null;
    if (s && line && part && basisDiffers(basis, part.months)) steps.push({ kind: 'change', s, line, part });
    else if (s && line && !part) steps.push({ kind: 'remove', s, line });
    else if (s && !line && part && lines.some((l) => l.schedule_id === s.row.id)) steps.push({ kind: 'add', s, part });
    else throw new HttpError(409, `The change of ${ch.part} no longer applies – reload the plan`, 'COST_UPDATE_STALE', { part: ch.part });
  }
  const adds = steps.filter((st) => st.kind === 'add').length - steps.filter((st) => st.kind === 'remove').length;
  if (lines.length + adds > COST_PLAN_LIMITS.linesPerYear)
    throw new HttpError(409, `A service has at most ${COST_PLAN_LIMITS.linesPerYear} plan lines per fiscal year`, 'COST_PLAN_LIMIT', {
      max: COST_PLAN_LIMITS.linesPerYear,
    });
  const months = fiscalYearMonths(x.fiscalYear, start);
  const view = (l: { amount: number; cadence: string; from_index: number | null; to_index: number | null; once_index: number | null; currency: string }) => ({
    amount: fromMicros(Number(l.amount)),
    cadence: l.cadence,
    fromMonth: l.cadence === 'once' || l.from_index === null ? null : months[Number(l.from_index)],
    toMonth: l.cadence === 'once' || l.to_index === null ? null : months[Number(l.to_index)],
    onceMonth: l.once_index === null ? null : months[Number(l.once_index)],
    currency: l.currency,
  });
  db().tx(() => {
    const done: { lineId: string | null; scheduleId: string; part: string; kind: string; before: unknown; after: unknown; entriesUnplanned?: number }[] = [];
    for (const st of steps) {
      if (st.kind === 'change') {
        const p = st.part!;
        db().run(
          `UPDATE cost_plan_lines SET amount = ?, cadence = ?, once_index = ?, from_index = ?, to_index = ?, covers_from = ?, covers_to = ?, schedule_basis = ?,
             updated_at = ?, updated_by = ? WHERE id = ?`,
          p.amount,
          p.cadence,
          p.onceIndex,
          p.fromIndex,
          p.toIndex,
          p.coversFrom,
          p.coversTo,
          JSON.stringify(p.months),
          nowIso(),
          currentActor(),
          st.line!.id,
        );
        done.push({
          lineId: st.line!.id,
          scheduleId: st.s.row.id,
          part: p.part,
          kind: 'changed',
          before: view(st.line!),
          after: view({
            amount: p.amount,
            cadence: p.cadence,
            from_index: p.fromIndex,
            to_index: p.toIndex,
            once_index: p.onceIndex,
            currency: st.s.row.currency,
          }),
        });
      } else if (st.kind === 'remove') {
        const unlinked = db().run('UPDATE cost_entries SET plan_line_id = NULL WHERE plan_line_id = ?', st.line!.id).changes;
        db().run('DELETE FROM cost_plan_lines WHERE id = ?', st.line!.id);
        done.push({
          lineId: st.line!.id,
          scheduleId: st.s.row.id,
          part: st.line!.schedule_part ?? '',
          kind: 'removed',
          before: view(st.line!),
          after: null,
          entriesUnplanned: unlinked,
        });
      } else {
        const p = st.part!;
        const lineId = insertScheduleLine(serviceId, x.fiscalYear, st.s, p);
        done.push({
          lineId,
          scheduleId: st.s.row.id,
          part: p.part,
          kind: 'added',
          before: null,
          after: view({
            amount: p.amount,
            cadence: p.cadence,
            from_index: p.fromIndex,
            to_index: p.toIndex,
            once_index: p.onceIndex,
            currency: st.s.row.currency,
          }),
        });
      }
    }
    audit({
      action: 'cost.contract_lines_updated',
      entityType: 'service',
      entityId: serviceId,
      summary: `Contract lines of "${info.name}" updated for ${fiscalYearLabel(x.fiscalYear, start)}: ${done.filter((d) => d.kind === 'changed').length} changed, ${done.filter((d) => d.kind === 'added').length} added, ${done.filter((d) => d.kind === 'removed').length} removed`,
      details: { fiscalYear: x.fiscalYear, lines: done },
    });
  });
  return planYearOf(info, x.fiscalYear, Date.now(), start);
}
