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
import { ScopeCtx, checkSideCover } from '../suppliers/contract-scope.js';
import { scopeInfo, visibleScopes, type ScopeInfo } from './access.js';
import {
  catalogueOf,
  checkOwnerTarget,
  lineRows,
  ownerCol,
  ownerValues,
  planYearOf,
  requireEditOf,
  startMonth,
  targetOf,
  thisMonth,
  today,
  type LineRow,
  type OwnerRef,
} from './plans.js';
import {
  dropSchedules,
  insertScheduleLine,
  payerOf,
  proposalLine,
  scheduleSnapshot as snapshot,
  schedulesOfContract,
  schedulesOfOwner,
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
 * - 0.19.0 (ADR 0032): a platform can pay a schedule instead of a service – its own cost plan gets the lines; the
 *   platform must be covered by the contract (a schedule for another platform adds it when the person may change the
 *   contract); who may change the platform's plan (its managers, the members of its owning teams) and sees the
 *   contract may add one. The billing "volume" (part 3): one volume schedule per contract and currency; its use read
 *   from a platform's costs only when a platform pays it.
 */

/** The payer of a schedule as the reader may see it (null: hidden – the schedule does not exist for them). */
function payerInfo(o: OwnerRef): ScopeInfo | null {
  return scopeInfo(o.kind, o.id);
}

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

/** Who may add, change or remove a schedule: who may change the contract, or change the payer's plan and see the contract. */
function mayChange(c: ContractRow, payer: ScopeInfo | null, ctx = new ScopeCtx()): boolean {
  if (contractEditable(c, supplierOf(c), currentUser(), ctx)) return true;
  return !!payer?.canEditPlan && contractVisible(c, supplierOf(c), currentUser(), ctx);
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
  const payers = new Map<string, ScopeInfo | null>();
  const info = (o: OwnerRef) => {
    const k = `${o.kind}|${o.id}`;
    if (!payers.has(k)) payers.set(k, payerInfo(o));
    return payers.get(k)!;
  };
  const seen = visibleContracts(list.map((x) => x.contract.id));
  const refs = supplierRefs(list.map((x) => x.contract.supplierId));
  const day = today(now);
  const start = startMonth();
  const out: CostSchedule[] = [];
  // one reader's view of the contracts' scopes for the whole list (services read once)
  const ctx = new ScopeCtx().load(list.map((x) => x.contract.id));
  for (const x of list) {
    const payer = payerOf(x.row);
    const svc = info(payer);
    if (!svc) continue;
    const visible = seen.has(x.contract.id);
    const s = show(svc);
    const c = contractRow(x.contract.id);
    const owed = scheduleOwed(x.spec, x.terms, day, start);
    const v = x.spec.volume;
    out.push({
      id: x.row.id,
      contractId: x.contract.id,
      serviceId: payer.kind === 'service' ? payer.id : '',
      serviceName: payer.kind === 'service' ? svc.name : '',
      payer: { kind: payer.kind, id: payer.id, name: svc.name },
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
      volume: v
        ? {
            per: v.per,
            billing: v.billing,
            committed: v.committed,
            minimumAmount: v.minimum === null ? null : s(v.minimum),
            minimumPct: v.minimumPct,
            consumption: v.consumption,
          }
        : null,
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
  for (const v of views) if (v.target && v.serviceId) v.target = targetOf(v.target.kind, v.target.id, catalogueOf(v.serviceId));
  return views;
}

/** GET /api/costs/schedules?contractId=|serviceId=|platformId= */
export function listSchedules(q: { contractId?: string; serviceId?: string; platformId?: string }, now = Date.now()): CostScheduleList {
  const limits = { perContract: COST_SCHEDULE_LIMITS.perContract, perService: COST_SCHEDULE_LIMITS.perService };
  if (q.contractId) {
    const c = visibleContract(q.contractId);
    const editsSome = () => visibleScopes('service').some((s) => s.canEditBudget) || visibleScopes('platform').some((p) => p.canEditPlan);
    return {
      schedules: withTargets(toViews(schedulesOfContract(c.id), now)),
      canAdd: contractEditable(c, supplierOf(c)) || (!!currentUser() && c.s_status !== 'archived' && editsSome()),
      limits,
    };
  }
  if (q.serviceId) {
    const info = scopeInfo('service', q.serviceId);
    if (!info) throw new HttpError(404, `Service ${q.serviceId} not found`, 'COST_SCOPE_NOT_FOUND', { scope: 'service', id: q.serviceId });
    return { schedules: withTargets(toViews(schedulesOfOwner({ kind: 'service', id: q.serviceId }), now)), canAdd: info.canEditBudget, limits };
  }
  if (q.platformId) {
    const info = scopeInfo('platform', q.platformId);
    if (!info) throw new HttpError(404, `Platform ${q.platformId} not found`, 'COST_SCOPE_NOT_FOUND', { scope: 'platform', id: q.platformId });
    return { schedules: toViews(schedulesOfOwner({ kind: 'platform', id: q.platformId }), now), canAdd: info.canEditPlan, limits };
  }
  throw new HttpError(400, 'Name a contract, a service or a platform', 'COST_SCHEDULE_QUERY');
}

// ---------- changing ----------

function checkLimits(contractId: string, payer: OwnerRef): void {
  const n = (sql: string, id: string) => Number(db().get<{ n: number }>(sql, id)?.n ?? 0);
  if (n('SELECT COUNT(*) AS n FROM cost_schedules WHERE contract_id = ?', contractId) >= COST_SCHEDULE_LIMITS.perContract)
    throw new HttpError(409, `A contract has at most ${COST_SCHEDULE_LIMITS.perContract} payment schedules`, 'COST_SCHEDULE_CONTRACT_LIMIT', {
      max: COST_SCHEDULE_LIMITS.perContract,
    });
  if (n(`SELECT COUNT(*) AS n FROM cost_schedules WHERE ${ownerCol(payer)} = ?`, payer.id) >= COST_SCHEDULE_LIMITS.perService)
    throw new HttpError(409, `A service or platform pays at most ${COST_SCHEDULE_LIMITS.perService} payment schedules`, 'COST_SCHEDULE_SERVICE_LIMIT', {
      max: COST_SCHEDULE_LIMITS.perService,
    });
}

const micros = (v: string) => toMicros(v) ?? 0;

/**
 * The volume of a schedule (ADR 0032 part 3): one volume schedule per contract and currency (their use would be the
 * same entries); the use read from a platform's costs only when a platform pays it.
 */
function checkVolume(x: ReturnType<typeof costScheduleUpdate.parse>, contractId: string, payer: OwnerRef, except: string | null): void {
  if (x.billing !== 'volume' || !x.volume) return;
  if (x.volume.consumption === 'read' && payer.kind !== 'platform')
    throw new HttpError(400, 'Only a volume a platform pays can be used up by its read costs', 'COST_VOLUME_READ_PLATFORM');
  const other = db().get<{ title: string }>(
    "SELECT title FROM cost_schedules WHERE contract_id = ? AND currency = ? AND billing = 'volume' AND id <> ?",
    contractId,
    x.currency,
    except ?? '',
  );
  if (other)
    throw new HttpError(409, `The contract has a volume in ${x.currency} already: "${other.title}"`, 'COST_VOLUME_ONE_PER_CURRENCY', {
      title: other.title,
      currency: x.currency,
    });
}

function columnsOf(x: ReturnType<typeof costScheduleUpdate.parse>, payer: OwnerRef) {
  const v = x.billing === 'volume' ? x.volume : null;
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
      x.billing === 'monthly' || x.billing === 'quarterly' || x.billing === 'yearly' || (x.billing === 'volume' && v?.per === 'year')
        ? x.yearAmounts.map((y) => (y === null ? null : micros(y)))
        : [],
    ),
    payments: JSON.stringify(x.billing === 'dates' ? x.payments.map((p) => ({ date: p.date, amount: micros(p.amount), coversUntil: p.coversUntil })) : []),
    note: x.note,
    volume_per: v ? v.per : null,
    volume_billing: v ? v.billing : null,
    volume_committed: v ? (v.billing === 'prepaid' ? 'full' : v.committed) : null,
    volume_minimum: v && v.billing === 'byUse' && v.committed === 'minimum' && v.minimumAmount !== null ? micros(v.minimumAmount) : null,
    volume_minimum_pct: v && v.billing === 'byUse' && v.committed === 'minimum' && v.minimumAmount === null ? v.minimumPct : null,
    // the use comes from entries for a service, from the read costs for a platform – unless chosen
    volume_consumption: v ? (v.consumption ?? (payer.kind === 'platform' ? 'read' : 'entries')) : null,
  } as const;
}

const summaryOf = (c: ReturnType<typeof columnsOf>) =>
  c.billing === 'dates'
    ? `${JSON.parse(c.payments).length} dated payment(s) in ${c.currency}`
    : c.billing === 'volume'
      ? `a volume of ${moneyText(c.amount, c.currency)} per ${c.volume_per === 'term' ? 'term' : 'contract year'}, ${c.volume_billing === 'prepaid' ? 'prepaid' : `billed by use, committed ${c.volume_committed}`}`
      : `${moneyText(c.amount, c.currency)} ${c.billing}`;

/** POST /api/costs/schedules */
export function addSchedule(body: unknown): CostScheduleList {
  const x = costScheduleInput.parse(body);
  const c = visibleContract(x.contractId);
  const payer: OwnerRef = x.platformId ? { kind: 'platform', id: x.platformId } : { kind: 'service', id: x.serviceId! };
  const svc = payerInfo(payer);
  if (!svc)
    throw new HttpError(404, `${payer.kind === 'service' ? 'Service' : 'Platform'} ${payer.id} not found`, 'COST_SCOPE_NOT_FOUND', {
      scope: payer.kind,
      id: payer.id,
    });
  if (c.s_status === 'archived') throw new HttpError(409, `Supplier "${c.s_name}" is archived`, 'SUPPLIER_ARCHIVED', { name: c.s_name });
  requireChange(c, svc);
  // the payer must be covered by the contract (ADR 0031 decided 16; ADR 0032 for platforms): a schedule for another
  // payer adds it when the person may change the contract; a proposed service is confirmed – the schedule says it pays
  const cover =
    payer.kind === 'service'
      ? db().get<{ status: string }>('SELECT status FROM supplier_contract_services WHERE contract_id = ? AND service_id = ?', c.id, payer.id)
      : db().get<{ status: string }>("SELECT 'confirmed' AS status FROM supplier_contract_platforms WHERE contract_id = ? AND platform_id = ?", c.id, payer.id);
  if (!cover && !contractEditable(c, supplierOf(c)))
    throw new HttpError(
      409,
      `The contract "${c.title}" does not cover the ${payer.kind} "${svc.name}"`,
      payer.kind === 'service' ? 'COST_SCHEDULE_SERVICE_NOT_COVERED' : 'COST_SCHEDULE_PLATFORM_NOT_COVERED',
      payer.kind === 'service' ? { contract: c.title, service: svc.name } : { contract: c.title, platform: svc.name },
    );
  checkOwnerTarget(payer, x.target);
  checkLimits(c.id, payer);
  checkVolume(x, c.id, payer, null);
  // a platform added on the side: never a grant to another team (security review 0.19.0 M1)
  if (payer.kind === 'platform' && !cover) checkSideCover(c.id, payer.id);
  const cols = columnsOf(x, payer);
  const id = newId('csc_');
  const now = nowIso();
  db().tx(() => {
    if (payer.kind === 'platform' && !cover) {
      db().run(
        `INSERT INTO supplier_contract_platforms (contract_id, platform_id, purpose, added_by, added_at) VALUES (?, ?, '', ?, ?)`,
        c.id,
        payer.id,
        currentActor(),
        now,
      );
      audit({
        action: 'supplier.contract_platform_added',
        entityType: 'supplier',
        entityId: c.supplier_id,
        summary: `Platform "${svc.name}" added to the contract "${c.title}" with a payment schedule`,
        details: { contractId: c.id, platformId: payer.id, platform: svc.name, scheduleId: id },
      });
    } else if (payer.kind === 'service' && (!cover || cover.status === 'proposed')) {
      if (!cover)
        db().run(
          `INSERT INTO supplier_contract_services (contract_id, service_id, purpose, status, proposed_from, added_by, added_at, confirmed_by, confirmed_at)
           VALUES (?, ?, '', 'confirmed', '[]', ?, ?, ?, ?)`,
          c.id,
          payer.id,
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
          payer.id,
        );
      audit({
        action: cover ? 'supplier.contract_service_confirmed' : 'supplier.contract_service_added',
        entityType: 'supplier',
        entityId: c.supplier_id,
        summary: `Service "${svc.name}" ${cover ? 'confirmed for' : 'added to'} the contract "${c.title}" with a payment schedule`,
        details: { contractId: c.id, serviceId: payer.id, service: svc.name, scheduleId: id },
      });
    }
    const owner = ownerValues(payer);
    db().run(
      `INSERT INTO cost_schedules (id, contract_id, service_id, platform_id, title, category, target_kind, target_id, amount, currency, billing, first_payment_on, starts_on, ends_on,
         year_amounts, payments, note, volume_per, volume_billing, volume_committed, volume_minimum, volume_minimum_pct, volume_consumption,
         created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      c.id,
      owner.service_id,
      owner.platform_id,
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
      cols.volume_per,
      cols.volume_billing,
      cols.volume_committed,
      cols.volume_minimum,
      cols.volume_minimum_pct,
      cols.volume_consumption,
      now,
      currentActor(),
      now,
      currentActor(),
    );
    audit({
      action: 'cost.schedule_added',
      entityType: payer.kind,
      entityId: payer.id,
      summary: `Payment schedule "${cols.title}" of the contract "${c.title}" (${c.s_name}) added for "${svc.name}": ${summaryOf(cols)}`,
      details: { scheduleId: id, contractId: c.id, supplierId: c.supplier_id, after: snapshot(cols) },
    });
  });
  return listSchedules({ contractId: c.id });
}

/** PUT /api/costs/schedules/:id – the contract and the payer stay. */
export function updateSchedule(id: string, body: unknown): CostScheduleList {
  const before = scheduleRow(id);
  const c = visibleContract(before.contract_id);
  const payer = payerOf(before);
  const svc = payerInfo(payer);
  if (!svc) throw new HttpError(404, `Payment schedule ${id} not found`, 'COST_SCHEDULE_NOT_FOUND', { id });
  requireChange(c, svc);
  const x = costScheduleUpdate.parse(body);
  const same = x.target && x.target.kind === before.target_kind && x.target.id === before.target_id;
  if (!same) checkOwnerTarget(payer, x.target);
  checkVolume(x, c.id, payer, id);
  const cols = columnsOf(x, payer);
  db().tx(() => {
    db().run(
      `UPDATE cost_schedules SET title = ?, category = ?, target_kind = ?, target_id = ?, amount = ?, currency = ?, billing = ?, first_payment_on = ?, starts_on = ?,
         ends_on = ?, year_amounts = ?, payments = ?, note = ?, volume_per = ?, volume_billing = ?, volume_committed = ?, volume_minimum = ?, volume_minimum_pct = ?,
         volume_consumption = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
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
      cols.volume_per,
      cols.volume_billing,
      cols.volume_committed,
      cols.volume_minimum,
      cols.volume_minimum_pct,
      cols.volume_consumption,
      nowIso(),
      currentActor(),
      id,
    );
    audit({
      action: 'cost.schedule_changed',
      entityType: payer.kind,
      entityId: payer.id,
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
  const svc = payerInfo(payerOf(before));
  if (!svc) throw new HttpError(404, `Payment schedule ${id} not found`, 'COST_SCHEDULE_NOT_FOUND', { id });
  requireChange(c, svc);
  db().tx(() => dropSchedules([before], 'removed', c.title, c.s_name));
  return listSchedules({ contractId: c.id });
}

// ---------- proposals: "Contract payments to plan" ----------

/** The schedules of a service or platform with payments in the fiscal year and no lines for it there yet. */
function open(o: OwnerRef, fy: number, start: number, lines: LineRow[]): Schedule[] {
  return schedulesOfOwner(o).filter((x) => x.parts(fy, start).length && !lines.some((l) => l.schedule_id === x.row.id));
}

/** GET /api/costs/plans/:serviceId/proposals?fiscalYear= (and /api/costs/platform-plans/:platformId/…) */
export function proposals(serviceId: string | OwnerRef, year: number | undefined, now = Date.now()): CostProposals {
  const o: OwnerRef = typeof serviceId === 'string' ? { kind: 'service', id: serviceId } : serviceId;
  const info = scopeInfo(o.kind, o.id);
  if (!info)
    throw new HttpError(404, `${o.kind === 'service' ? 'Service' : 'Platform'} ${o.id} not found`, 'COST_SCOPE_NOT_FOUND', { scope: o.kind, id: o.id });
  const start = startMonth();
  const fy = year ?? fiscalYearOf(thisMonth(now), start);
  const months = fiscalYearMonths(fy, start);
  const lines = lineRows(o, fy);
  const list = open(o, fy, start, lines);
  const seen = visibleContracts(list.map((x) => x.contract.id));
  const refs = supplierRefs(list.map((x) => x.contract.supplierId));
  const s = show(info);
  return {
    serviceId: o.kind === 'service' ? o.id : '',
    fiscalYear: fy,
    label: fiscalYearLabel(fy, start),
    canEdit: info.canEditPlan,
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
export function confirmProposals(serviceId: string | OwnerRef, body: unknown): CostPlanYear {
  const o: OwnerRef = typeof serviceId === 'string' ? { kind: 'service', id: serviceId } : serviceId;
  const info = requireEditOf(o);
  const x = costProposalConfirm.parse(body);
  const start = startMonth();
  const lines = lineRows(o, x.fiscalYear);
  const list = open(o, x.fiscalYear, start, lines);
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
        const lineId = insertScheduleLine(o, x.fiscalYear, s, p);
        added.push({ lineId, scheduleId: s.row.id, part: p.part, amount: fromMicros(p.amount), cadence: p.cadence, currency: s.row.currency });
      }
    audit({
      action: 'cost.contract_lines_added',
      entityType: o.kind,
      entityId: o.id,
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
export function applyContractUpdates(serviceId: string | OwnerRef, body: unknown, now = Date.now()): CostPlanYear {
  const o: OwnerRef = typeof serviceId === 'string' ? { kind: 'service', id: serviceId } : serviceId;
  const info = requireEditOf(o);
  const x = costContractUpdates.parse(body);
  const start = startMonth();
  const curFy = fiscalYearOf(thisMonth(now), start);
  if (x.fiscalYear < curFy)
    throw new HttpError(409, `${fiscalYearLabel(x.fiscalYear, start)} is over: its plan stays as planned`, 'COST_UPDATE_PAST_YEAR', {
      year: fiscalYearLabel(x.fiscalYear, start),
    });
  const lines = lineRows(o, x.fiscalYear);
  const schedules = new Map(
    schedulesWhere(
      'id',
      x.changes.map((c) => c.scheduleId),
    )
      .filter((s) => (o.kind === 'service' ? s.row.service_id === o.id : s.row.platform_id === o.id))
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
    throw new HttpError(409, `A cost plan has at most ${COST_PLAN_LIMITS.linesPerYear} plan lines per fiscal year`, 'COST_PLAN_LIMIT', {
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
        const lineId = insertScheduleLine(o, x.fiscalYear, st.s, p);
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
      entityType: o.kind,
      entityId: o.id,
      summary: `Contract lines of "${info.name}" updated for ${fiscalYearLabel(x.fiscalYear, start)}: ${done.filter((d) => d.kind === 'changed').length} changed, ${done.filter((d) => d.kind === 'added').length} added, ${done.filter((d) => d.kind === 'removed').length} removed`,
      details: { fiscalYear: x.fiscalYear, lines: done },
    });
  });
  return planYearOf(info, x.fiscalYear, Date.now(), start);
}
