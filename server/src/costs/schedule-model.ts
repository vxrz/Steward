import {
  fromMicros,
  proposalParts,
  type ContractTerms,
  type CostPlanCategory,
  type CostPlanTargetKind,
  type CostProposalLine,
  type CostScheduleBilling,
  type ProposalPart,
  type ScheduleSpec,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { newId, nowIso, parseJson } from '../util.js';
import { allContracts, type ContractInfo } from '../suppliers/links.js';

/**
 * Payment schedules as rows and as the arithmetic of shared/src/costContracts.ts reads them (0.18.0, ADR 0030) – kept
 * apart from schedules.ts (the routes' services) so the cost plan (plans.ts) reads them without an import cycle.
 *
 * The arithmetic needs every schedule's contract terms whoever reads: a schedule exists for a reader through its
 * paying service, and its proposals and amounts are the service's. Whether the contract itself (supplier, title,
 * dates) is shown goes through contractVisible (suppliers/links.ts) where the result is shaped.
 */

export interface ScheduleRow {
  id: string;
  contract_id: string;
  service_id: string;
  title: string;
  category: CostPlanCategory;
  target_kind: CostPlanTargetKind | null;
  target_id: string | null;
  amount: number;
  currency: string;
  billing: CostScheduleBilling;
  first_payment_on: string | null;
  starts_on: string | null;
  ends_on: string | null;
  year_amounts: string;
  payments: string;
  note: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export const specOf = (r: ScheduleRow): ScheduleSpec => ({
  billing: r.billing,
  amount: Number(r.amount),
  currency: r.currency,
  firstPaymentOn: r.first_payment_on,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  yearAmounts: parseJson<(number | null)[]>(r.year_amounts, []).map((v) => (v === null || v === undefined ? null : Number(v))),
  payments: parseJson<{ date: string; amount: number; coversUntil: string | null }[]>(r.payments, []).map((p) => ({
    date: p.date,
    amount: Number(p.amount),
    coversUntil: p.coversUntil ?? null,
  })),
});

export const termsOf = (c: ContractInfo): ContractTerms => ({
  startsOn: c.startsOn,
  endsOn: c.endsOn,
  noticeDays: c.noticeDays,
  renewal: c.renewal,
  renewalMonths: c.renewalMonths,
});

/** A schedule with its spec, its contract and the contract's terms (a schedule whose contract is gone is left out). */
export interface Schedule {
  row: ScheduleRow;
  spec: ScheduleSpec;
  contract: ContractInfo;
  terms: ContractTerms;
  /** The proposal of a fiscal year, computed once */
  parts(fiscalYear: number, startMonth: number): ProposalPart[];
}

function withTerms(rows: ScheduleRow[]): Schedule[] {
  const contracts = allContracts(rows.map((r) => r.contract_id));
  const out: Schedule[] = [];
  for (const row of rows) {
    const contract = contracts.get(row.contract_id);
    if (!contract) continue;
    const spec = specOf(row);
    const terms = termsOf(contract);
    const memo = new Map<string, ProposalPart[]>();
    out.push({
      row,
      spec,
      contract,
      terms,
      parts: (fy, start) => {
        const k = `${fy}|${start}`;
        let p = memo.get(k);
        if (!p) {
          p = proposalParts(spec, terms, fy, start);
          memo.set(k, p);
        }
        return p;
      },
    });
  }
  return out;
}

/** The schedules a service pays (one statement, and one for their contracts). */
export const schedulesOfService = (serviceId: string): Schedule[] =>
  withTerms(db().all<ScheduleRow>('SELECT * FROM cost_schedules WHERE service_id = ? ORDER BY created_at, id', serviceId));

/** The schedules of a contract. */
export const schedulesOfContract = (contractId: string): Schedule[] =>
  withTerms(db().all<ScheduleRow>('SELECT * FROM cost_schedules WHERE contract_id = ? ORDER BY created_at, id', contractId));

/** The schedules of several contracts or services (in chunks of 500 ids). */
export function schedulesWhere(column: 'contract_id' | 'service_id' | 'id', ids: readonly string[]): Schedule[] {
  const want = [...new Set(ids)];
  const rows: ScheduleRow[] = [];
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    rows.push(...db().all<ScheduleRow>(`SELECT * FROM cost_schedules WHERE ${column} IN (${part.map(() => '?').join(', ')}) ORDER BY created_at, id`, ...part));
  }
  return withTerms(rows);
}

/** Every schedule (the dataset, the export, the reminder job: no reader). */
export const allSchedules = (): Schedule[] => withTerms(db().all<ScheduleRow>('SELECT * FROM cost_schedules ORDER BY created_at, id'));

/**
 * The title of a line made from a schedule as a reader who may see the contract reads it: "contract – schedule". A line
 * stores the schedule's title only (and the contract's id) – the contract's title is added when the line is read, for
 * who may see the contract (security review 0.18.0, M6; plans.ts lineTitle).
 */
export const scheduleLineTitle = (s: Schedule): string => contractLineTitle(s.contract.title, s.row.title);

/** "contract – line": the title of a schedule's line with its contract's title in front. */
export const contractLineTitle = (contract: string, title: string): string => `${contract} – ${title}`;

/** A title given for a schedule's line without its contract's title in front (a form sends back what it showed). */
export const ownLineTitle = (contract: string, title: string): string => (title.startsWith(`${contract} – `) ? title.slice(contract.length + 3) : title);

/** A proposed part as the cost plan shows it (amounts by the reader's right). */
export function proposalLine(p: ProposalPart, title: string, months: string[], show: (n: number) => string | null): CostProposalLine {
  return {
    part: p.part,
    title,
    cadence: p.cadence,
    fromMonth: p.cadence === 'once' ? null : (months[p.fromIndex ?? 0] ?? null),
    toMonth: p.cadence === 'once' ? null : (months[p.toIndex ?? 11] ?? null),
    onceMonth: p.onceIndex === null ? null : (months[p.onceIndex] ?? null),
    amount: show(p.amount),
    planned: show(p.months.reduce((a, b) => a + b, 0)),
    coversFrom: p.coversFrom,
    coversTo: p.coversTo,
  };
}

/** Inserts the plan line of a proposed part (no audit): "Add to plan", "Update lines" and the copy into the next year. */
export function insertScheduleLine(serviceId: string, fiscalYear: number, s: Schedule, p: ProposalPart): string {
  const id = newId('cpl_');
  const now = nowIso();
  db().run(
    `INSERT INTO cost_plan_lines (id, service_id, fiscal_year, title, category, target_kind, target_id, vendor, supplier_id, supplier_contract_id, amount, currency,
       cadence, once_index, from_index, to_index, schedule_id, schedule_part, schedule_basis, covers_from, covers_to, renewal_date, note,
       created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', ?, ?, ?, ?)`,
    id,
    serviceId,
    fiscalYear,
    // the schedule's title only: the contract's title is added when the line is read, for who may see the contract
    s.row.title.slice(0, 200),
    s.row.category,
    s.row.target_kind,
    s.row.target_id,
    s.contract.supplierId,
    s.contract.id,
    p.amount,
    s.row.currency,
    p.cadence,
    p.onceIndex,
    p.fromIndex,
    p.toIndex,
    s.row.id,
    p.part,
    JSON.stringify(p.months),
    p.coversFrom,
    p.coversTo,
    now,
    currentActor(),
    now,
    currentActor(),
  );
  return id;
}

/** The fiscal years in which a service has plan lines (the notice warning). */
export function plannedYears(serviceId: string): Set<number> {
  return new Set(
    db()
      .all<{ fy: number }>('SELECT DISTINCT fiscal_year AS fy FROM cost_plan_lines WHERE service_id = ?', serviceId)
      .map((r) => Number(r.fy)),
  );
}

/** What an audit entry records of a schedule. */
export const scheduleSnapshot = (
  r: Pick<
    ScheduleRow,
    | 'title'
    | 'category'
    | 'target_kind'
    | 'target_id'
    | 'amount'
    | 'currency'
    | 'billing'
    | 'first_payment_on'
    | 'starts_on'
    | 'ends_on'
    | 'year_amounts'
    | 'payments'
  >,
) => ({
  title: r.title,
  category: r.category,
  target: r.target_kind ? { kind: r.target_kind, id: r.target_id } : null,
  amount: fromMicros(Number(r.amount)),
  currency: r.currency,
  billing: r.billing,
  firstPaymentOn: r.first_payment_on,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  yearAmounts: parseJson<(number | null)[]>(r.year_amounts, []).map((v) => (v === null ? null : fromMicros(Number(v)))),
  payments: parseJson<{ date: string; amount: number; coversUntil: string | null }[]>(r.payments, []).map((p) => ({
    date: p.date,
    amount: fromMicros(Number(p.amount)),
    coversUntil: p.coversUntil,
  })),
});

/**
 * Removes schedules and makes the lines made from them ordinary lines (they keep their amounts, supplier and
 * contract), audited per schedule – also when their contract goes (suppliers/service.ts calls it, no rights check).
 */
export function dropSchedules(rows: ScheduleRow[], why: 'removed' | 'contractRemoved', contractTitle: string, supplierName: string): void {
  for (const r of rows) {
    const lines = db().run('UPDATE cost_plan_lines SET schedule_id = NULL, schedule_part = NULL, schedule_basis = NULL WHERE schedule_id = ?', r.id).changes;
    db().run('DELETE FROM cost_schedules WHERE id = ?', r.id);
    const name = db().get<{ name: string }>('SELECT name FROM services WHERE id = ?', r.service_id)?.name ?? r.service_id;
    audit({
      action: 'cost.schedule_removed',
      entityType: 'service',
      entityId: r.service_id,
      summary: `Payment schedule "${r.title}" of the contract "${contractTitle}" (${supplierName}) removed from "${name}"${why === 'contractRemoved' ? ' with its contract' : ''}${lines ? `; ${lines} plan line(s) are ordinary lines now` : ''}`,
      details: {
        scheduleId: r.id,
        contractId: r.contract_id,
        before: scheduleSnapshot(r),
        linesUnlinked: lines,
        ...(why === 'contractRemoved' ? { contractRemoved: true } : {}),
      },
    });
  }
}
