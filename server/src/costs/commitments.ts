import {
  COST_COMMITMENTS_DATASET,
  basisDiffers,
  contractDates,
  costCommitmentsQuery,
  daysBetween,
  fiscalYearLabel,
  fiscalYearMonths,
  fiscalYearOf,
  fromMicros,
  fromMicrosIn,
  noticeWarning,
  planMonths,
  scheduleOwed,
  toMicros,
  type CostCommitment,
  type CostCommitments,
  type DatasetRow,
  type SupplierRef,
} from '@sm/shared';
import { db } from '../db.js';
import { owningTeams } from '../auth/policy.js';
import { csvCell } from '../csv.js';
import { HttpError, parseJson } from '../util.js';
import { publishDataset } from '../dashboards/datasets.js';
import { supplierRefs, visibleContracts } from '../suppliers/links.js';
import { requireScope, scopeInfo, type ScopeInfo } from './access.js';
import { startMonth, today as todayOf } from './plans.js';
import { allSchedules, plannedYears, schedulesWhere, type Schedule } from './schedule-model.js';

/**
 * Commitments (0.18.0, ADR 0030 part 5, docs/COSTS.md#commitments): what the payment schedules of a service still owe
 * – the payments dated today or later (instance time zone), to contract end and to the earliest exit, per fiscal year
 * and in total, per currency (no conversion). Entries are not subtracted: a commitment is what the contract says is
 * still to pay, not what is unbooked – scheduled payments, not liabilities.
 *
 * - Rows only for services the reader may see; a schedule of a contract the reader may not see (contractVisible) shows
 *   its amounts without supplier, title or dates. Amounts follow the paying service's "Hide amounts from viewers";
 *   totals add only what the reader sees, so they never reveal hidden services.
 * - The notice warning: an automatically renewing contract's next notice-by date is ahead and the fiscal year of its
 *   next term has no plan lines of the paying service.
 * - Used by the service's "Contracts" section, Costs → Commitments, the supplier page, /api/v1/cost-commitments, MCP,
 *   the dataset `costs.commitments` (no reader: every schedule of a service that is not archived) and the export part.
 */

/** The current fiscal year and the next four: the columns of the commitments. */
export const COMMITMENT_YEARS = 5;

interface Ctx {
  today: string;
  start: number;
  curFy: number;
  months: string[];
  cur: number;
  visible: ReturnType<typeof visibleContracts>;
  refs: Map<string, SupplierRef>;
  lines: Map<string, LineRow[]>;
  booked: Map<string, Set<string>>;
  planned: Map<string, Set<number>>;
}

interface LineRow {
  id: string;
  service_id: string;
  fiscal_year: number;
  schedule_id: string;
  schedule_part: string | null;
  schedule_basis: string | null;
  amount: number;
  currency: string;
  cadence: 'yearly' | 'monthly' | 'quarterly' | 'once';
  once_index: number | null;
  from_index: number | null;
  to_index: number | null;
}

/** Everything the rows need, read in bulk: the schedules' lines of the current and later years and their entries. */
function context(list: Schedule[], now: number): Ctx {
  const start = startMonth();
  const today = todayOf(now);
  const curFy = fiscalYearOf(today, start);
  const months = fiscalYearMonths(curFy, start);
  const ids = [...new Set(list.map((x) => x.row.id))];
  const lines = new Map<string, LineRow[]>();
  const rows: LineRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    rows.push(
      ...db().all<LineRow>(
        `SELECT id, service_id, fiscal_year, schedule_id, schedule_part, schedule_basis, amount, currency, cadence, once_index, from_index, to_index
           FROM cost_plan_lines WHERE schedule_id IN (${part.map(() => '?').join(', ')}) AND fiscal_year >= ?`,
        ...part,
        curFy,
      ),
    );
  }
  for (const r of rows) lines.set(r.schedule_id, [...(lines.get(r.schedule_id) ?? []), r]);
  const booked = new Map<string, Set<string>>();
  const lineIds = rows.filter((r) => Number(r.fiscal_year) === curFy).map((r) => r.id);
  for (let i = 0; i < lineIds.length; i += 500) {
    const part = lineIds.slice(i, i + 500);
    for (const e of db().all<{ plan_line_id: string; entry_date: string }>(
      `SELECT plan_line_id, entry_date FROM cost_entries WHERE plan_line_id IN (${part.map(() => '?').join(', ')})`,
      ...part,
    ))
      booked.set(e.plan_line_id, (booked.get(e.plan_line_id) ?? new Set()).add(e.entry_date.slice(0, 7)));
  }
  const planned = new Map<string, Set<number>>();
  for (const sid of new Set(list.map((x) => x.row.service_id))) planned.set(sid, plannedYears(sid));
  const m = today.slice(0, 7);
  return {
    today,
    start,
    curFy,
    months,
    cur: months.indexOf(m),
    visible: visibleContracts(list.map((x) => x.contract.id)),
    refs: supplierRefs(list.map((x) => x.contract.supplierId)),
    lines,
    booked,
    planned,
  };
}

/** One schedule's commitments as the reader may see them (`info`: the paying service, seen by the reader). */
function rowOf(x: Schedule, info: ScopeInfo, ctx: Ctx): CostCommitment {
  const owed = scheduleOwed(x.spec, x.terms, ctx.today, ctx.start);
  const show = (n: number) => (info.amounts ? fromMicros(n) : null);
  const visible = ctx.visible.has(x.contract.id);
  const byFy = new Map(owed.byFiscalYear.map((y) => [y.fiscalYear, y.toContractEnd]));
  const years = Array.from({ length: COMMITMENT_YEARS }, (_, i) => byFy.get(ctx.curFy + i) ?? 0);
  const later = owed.byFiscalYear.filter((y) => y.fiscalYear >= ctx.curFy + COMMITMENT_YEARS).reduce((a, y) => a + y.toContractEnd, 0);
  // Contract changed: a line of the current or a later year whose proposal changed, or a part new in such a year
  const mine = ctx.lines.get(x.row.id) ?? [];
  let changed = false;
  for (const fy of new Set(mine.map((l) => Number(l.fiscal_year)))) {
    const parts = x.parts(fy, ctx.start);
    const ls = mine.filter((l) => Number(l.fiscal_year) === fy);
    if (
      ls.some((l) => {
        const p = parts.find((y) => y.part === l.schedule_part);
        return !p || basisDiffers(parseJson<number[] | null>(l.schedule_basis ?? 'null', null), p.months);
      }) ||
      parts.some((p) => !ls.some((l) => l.schedule_part === p.part))
    ) {
      changed = true;
      break;
    }
  }
  // Not booked: the current year's payments of its lines up to now without an entry on their line
  const notBooked = new Set<string>();
  for (const l of mine)
    if (Number(l.fiscal_year) === ctx.curFy && l.cadence !== 'yearly') {
      const plan = planMonths(Number(l.amount), l.cadence, l.once_index === null ? null : Number(l.once_index), {
        from: l.from_index === null ? null : Number(l.from_index),
        to: l.to_index === null ? null : Number(l.to_index),
        currency: l.currency,
      });
      const b = ctx.booked.get(l.id);
      plan.forEach((v, i) => {
        if (v !== 0 && i <= ctx.cur && !b?.has(ctx.months[i]!)) notBooked.add(ctx.months[i]!);
      });
    }
  const warning = visible ? noticeWarning(x.terms, ctx.today, ctx.start, ctx.planned.get(x.row.service_id) ?? new Set(), x.spec.endsOn) : null;
  return {
    scheduleId: x.row.id,
    title: x.row.title,
    serviceId: x.row.service_id,
    serviceName: info.name,
    teams: owningTeams('service', x.row.service_id).map((t) => ({ id: t.id, name: t.name })),
    supplier: visible ? (ctx.refs.get(x.contract.supplierId) ?? null) : null,
    contract: visible ? { id: x.contract.id, title: x.contract.title, reference: x.contract.reference } : null,
    contractHidden: !visible,
    billing: x.row.billing,
    currency: x.row.currency,
    amountsVisible: info.amounts,
    nextPayment: owed.nextPayment ? { date: owed.nextPayment.date, amount: show(owed.nextPayment.amount) } : null,
    owedThisYear: show(years[0]!),
    owedLaterYears: show(owed.toContractEnd - years[0]!),
    toContractEnd: show(owed.toContractEnd),
    toEarliestExit: show(owed.toEarliestExit),
    contractEnd: visible ? owed.contractEnd : null,
    earliestExit: visible ? owed.earliestExit : null,
    years: years.map(show),
    later: show(later),
    noticeBy: visible ? (warning?.noticeBy ?? noticeByOf(x, ctx.today)) : null,
    warning,
    changed,
    notBooked: [...notBooked].sort(),
  };
}

/** The contract's next notice-by date ahead (or null). */
function noticeByOf(x: Schedule, today: string): string | null {
  const d = contractDates(x.terms, today);
  return d.noticeBy && d.noticeBy >= today ? d.noticeBy : null;
}

const byOrder = (a: CostCommitment, b: CostCommitment) =>
  Number(!!b.warning) - Number(!!a.warning) ||
  a.serviceName.localeCompare(b.serviceName) ||
  (a.supplier?.name ?? '').localeCompare(b.supplier?.name ?? '') ||
  a.title.localeCompare(b.title) ||
  (a.scheduleId < b.scheduleId ? -1 : 1);

/**
 * The commitments of the services the reader may see, filtered by team, service, supplier, currency and "ending
 * within … days" – the rows with the notice warning first.
 */
export function commitments(query: unknown, now = Date.now()): CostCommitments {
  const q = costCommitmentsQuery.parse(query ?? {});
  let list: Schedule[];
  if (q.serviceId) {
    requireScope('service', q.serviceId);
    list = schedulesWhere('service_id', [q.serviceId]);
  } else if (q.teamId) {
    requireScope('team', q.teamId);
    const ids = db()
      .all<{ resource_id: string }>("SELECT resource_id FROM resource_teams WHERE kind = 'service' AND team_id = ?", q.teamId)
      .map((r) => r.resource_id);
    list = schedulesWhere('service_id', ids);
  } else list = allSchedules();
  if (q.supplierId) {
    if (!supplierRefs([q.supplierId]).has(q.supplierId))
      throw new HttpError(404, `Supplier ${q.supplierId} not found`, 'SUPPLIER_NOT_FOUND', { id: q.supplierId });
    list = list.filter((x) => x.contract.supplierId === q.supplierId);
  }
  const infos = new Map<string, ScopeInfo | null>();
  const info = (id: string) => {
    if (!infos.has(id)) infos.set(id, scopeInfo('service', id));
    return infos.get(id)!;
  };
  // the paying service must be seen (and not archived, unless it was asked for by id)
  const archived = new Set(
    db()
      .all<{ id: string }>('SELECT id FROM services WHERE archived = 1')
      .map((r) => r.id),
  );
  list = list.filter((x) => !!info(x.row.service_id) && (q.serviceId || !archived.has(x.row.service_id)));
  const ctx = context(list, now);
  let rows = list.map((x) => rowOf(x, info(x.row.service_id)!, ctx));
  // a supplier the reader asked for: only contracts they may see
  if (q.supplierId) rows = rows.filter((r) => !r.contractHidden);
  if (q.currency) rows = rows.filter((r) => r.currency === q.currency!.toUpperCase());
  if (q.endingWithinDays) {
    const days = q.endingWithinDays;
    rows = rows.filter((r) => [r.contractEnd, r.earliestExit].some((d) => !!d && daysBetween(ctx.today, d) <= days));
  }
  rows.sort(byOrder);
  const result: CostCommitments = {
    today: ctx.today,
    fiscalYear: ctx.curFy,
    years: Array.from({ length: COMMITMENT_YEARS }, (_, i) => ({ fiscalYear: ctx.curFy + i, label: fiscalYearLabel(ctx.curFy + i, ctx.start) })),
    rows,
    totals: totalsOf(rows),
    warnings: rows.filter((r) => r.warning).length,
  };
  if (q.supplierId) result.incurred = incurredWith(q.supplierId, ctx.start);
  return result;
}

/** Per currency over the rows whose amounts the reader sees. */
function totalsOf(rows: CostCommitment[]): CostCommitments['totals'] {
  const m = (v: string | null) => (v === null ? 0 : (toMicros(v) ?? 0));
  const by = new Map<string, { years: number[]; later: number; owedThisYear: number; toContractEnd: number; toEarliestExit: number }>();
  for (const r of rows) {
    if (!r.amountsVisible) continue;
    const t = by.get(r.currency) ?? {
      years: Array.from({ length: COMMITMENT_YEARS }, () => 0),
      later: 0,
      owedThisYear: 0,
      toContractEnd: 0,
      toEarliestExit: 0,
    };
    r.years.forEach((v, i) => (t.years[i]! += m(v)));
    t.later += m(r.later);
    t.owedThisYear += m(r.owedThisYear);
    t.toContractEnd += m(r.toContractEnd);
    t.toEarliestExit += m(r.toEarliestExit);
    by.set(r.currency, t);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, t]) => ({
      currency,
      years: t.years.map((v) => fromMicros(v)),
      later: fromMicros(t.later),
      owedThisYear: fromMicros(t.owedThisYear),
      toContractEnd: fromMicros(t.toContractEnd),
      toEarliestExit: fromMicros(t.toEarliestExit),
    }));
}

/**
 * What was incurred with a supplier per fiscal year and currency: the entries that name it, of services the reader may
 * see and whose amounts they see – sums only (entries are not listed under "Used by").
 */
function incurredWith(supplierId: string, start: number): NonNullable<CostCommitments['incurred']> {
  const by = new Map<string, number>();
  const infos = new Map<string, ScopeInfo | null>();
  for (const e of db().all<{ service_id: string; entry_date: string; amount: number; currency: string }>(
    'SELECT service_id, entry_date, amount, currency FROM cost_entries WHERE supplier_id = ?',
    supplierId,
  )) {
    if (!infos.has(e.service_id)) infos.set(e.service_id, scopeInfo('service', e.service_id));
    const i = infos.get(e.service_id);
    if (!i || !i.amounts) continue;
    const k = `${fiscalYearOf(e.entry_date, start)}|${e.currency}`;
    by.set(k, (by.get(k) ?? 0) + Number(e.amount));
  }
  return [...by.entries()]
    .map(([k, v]) => {
      const [fy, currency] = k.split('|');
      return { fiscalYear: Number(fy), label: fiscalYearLabel(Number(fy), start), currency: currency!, amount: fromMicros(v) };
    })
    .sort((a, b) => b.fiscalYear - a.fiscalYear || a.currency.localeCompare(b.currency));
}

// ---------- CSV: the page's export and the export part ----------

/** The columns of commitments.csv (fixed; the five fiscal-year columns are named by their position). */
export const COMMITMENT_CSV_HEAD = [
  'Service id',
  'Service',
  'Supplier',
  'Contract',
  'Schedule',
  'Billing',
  'Currency',
  'Next payment',
  'Next amount',
  'Owed this fiscal year',
  'Owed later years',
  'To contract end',
  'Contract end',
  'To earliest exit',
  'Earliest exit',
  'Notice by',
  'Warning',
  'Fiscal year 1',
  'Fiscal year 2',
  'Fiscal year 3',
  'Fiscal year 4',
  'Fiscal year 5',
  'Later',
] as const;

/** One CSV line per row (formulas defused, amounts with the currency's minor units). */
export function commitmentCsvLines(c: CostCommitments): string[] {
  const num = (v: string | null, currency: string) => {
    const x = v === null ? null : toMicros(v);
    return x === null ? '' : fromMicrosIn(x, currency);
  };
  return c.rows.map((r) =>
    [
      csvCell(r.serviceId, 'needed'),
      csvCell(r.serviceName, 'needed'),
      csvCell(r.supplier?.name ?? '', 'needed'),
      csvCell(r.contract?.title ?? '', 'needed'),
      csvCell(r.title, 'needed'),
      r.billing,
      r.currency,
      r.nextPayment?.date ?? '',
      num(r.nextPayment?.amount ?? null, r.currency),
      num(r.owedThisYear, r.currency),
      num(r.owedLaterYears, r.currency),
      num(r.toContractEnd, r.currency),
      r.contractEnd ?? '',
      num(r.toEarliestExit, r.currency),
      r.earliestExit ?? '',
      r.noticeBy ?? '',
      r.warning ? csvCell(`Notice by ${r.warning.noticeBy} – ${r.warning.label} not planned yet`, 'needed') : '',
      ...r.years.map((v) => num(v, r.currency)),
      num(r.later, r.currency),
    ].join(','),
  );
}

/** The commitments as CSV (UTF-8 with a byte order mark): the page's export with its filters. */
export function commitmentsCsv(query: unknown, now = Date.now()): { name: string; csv: string } {
  const c = commitments(query, now);
  const head = [...COMMITMENT_CSV_HEAD.slice(0, 17), ...c.years.map((y) => y.label), 'Later'].map((h) => csvCell(h, 'needed')).join(',');
  return { name: `commitments-${c.today}.csv`, csv: '﻿' + [head, ...commitmentCsvLines(c)].join('\r\n') + '\r\n' };
}

// ---------- the dataset ----------

const DATASET_COLUMNS = [
  'Service',
  'Supplier',
  'Contract',
  'Schedule',
  'Currency',
  'This fiscal year',
  'Next fiscal year',
  'To contract end',
  'To earliest exit',
  'Notice by',
];
let published = 0;

/**
 * The built-in dataset "Commitments" (`costs.commitments`): one row per schedule of a service that is not archived,
 * with what it owes this and next fiscal year, to contract end and to the earliest exit, and the notice-by date;
 * status warning while the notice warning applies. Its rows name every service and supplier: administrators and
 * auditors (the feature's dataset rule), like `costs.plans`. Published by the job "costs" at most hourly.
 */
export function publishCommitmentsDataset(force = false, now = Date.now()): boolean {
  if (!force && now - published < 3600_000) return false;
  if (!db().get('SELECT id FROM cost_schedules LIMIT 1') && !db().get('SELECT key FROM datasets WHERE key = ?', COST_COMMITMENTS_DATASET)) return false;
  published = now;
  const c = commitments({}, now);
  const n = (v: string | null) => (v === null ? null : (toMicros(v) ?? 0) / 1_000_000);
  const rows: DatasetRow[] = c.rows.map((r) => ({
    Service: r.serviceName,
    Supplier: r.supplier?.name ?? '',
    Contract: r.contract?.title ?? '',
    Schedule: r.title,
    Currency: r.currency,
    'This fiscal year': n(r.years[0] ?? null),
    'Next fiscal year': n(r.years[1] ?? null),
    'To contract end': n(r.toContractEnd),
    'To earliest exit': n(r.toEarliestExit),
    'Notice by': r.noticeBy,
    _key: r.scheduleId,
    _status: r.warning ? 'warning' : 'good',
    _reason: r.warning ? `Notice by ${r.warning.noticeBy} – ${r.warning.label} not planned yet` : '',
  }));
  publishDataset({
    key: COST_COMMITMENTS_DATASET,
    title: 'Commitments',
    processId: 'costs:commitments',
    processName: 'Commitments (built in)',
    runId: '',
    dryRun: false,
    columns: DATASET_COLUMNS,
    rows,
    metrics: { schedules: rows.length, warnings: c.warnings },
    limits: {},
    staleAfterMinutes: 24 * 60 * 2,
    staleAfterFixed: true,
  });
  return true;
}
