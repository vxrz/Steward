import { z } from 'zod';
import { checkCurrencyDecimals, fitsCurrency, isoCurrencyCode, roundToCurrency, toMicros } from './costs.js';
import {
  COST_PLAN_CATEGORIES,
  COST_PLAN_TARGET_KINDS,
  fiscalYearBounds,
  fiscalYearLabel,
  fiscalYearMonths,
  fiscalYearOf,
  isCalendarDate,
  planMonths,
  type CostPlanCadence,
  type CostPlanCategory,
  type CostPlanTarget,
} from './costPlans.js';
import { addDays, addMonths, contractDates, daysBetween, type SupplierRef, type SupplierRenewal } from './suppliers.js';

/**
 * Contract payments and commitments (0.18.0, ADR 0030, docs/COSTS.md#contract-payments-and-commitments): payment
 * schedules on supplier contracts, the plan lines they propose per fiscal year, and what is still owed. Pure
 * functions on calendar dates (YYYY-MM-DD) and whole millionths, no time zones – like the fiscal-year helpers.
 *
 * - A schedule belongs to one contract and one paying service. Billing: monthly, quarterly, yearly (a payment on the
 *   same day every 1, 3 or 12 months from the first payment – on the last day of a shorter month), once, or dated
 *   payments. A payment counts in the month of its date; no pro rata.
 * - Contract years count from the schedule's start in twelve-month steps; years 2–10 may have amounts of their own
 *   (a year without one takes the year before).
 * - The end: an own end date caps the schedule; else it follows the contract – its end date, or term by term for an
 *   automatic renewal (and without an end date: on). A contract with a fixed end (or renewed by agreement) is never
 *   passed. A schedule spans at most ten years: proposals and commitments look no further.
 */

export const COST_SCHEDULE_BILLINGS = ['monthly', 'quarterly', 'yearly', 'once', 'dates'] as const;
export type CostScheduleBilling = (typeof COST_SCHEDULE_BILLINGS)[number];

export const COST_SCHEDULE_LIMITS = {
  /** Payment schedules per contract and per paying service */
  perContract: 20,
  perService: 200,
  /** Contract years with amounts of their own: years 2–10 */
  yearAmounts: 9,
  /** Dated payments per schedule */
  payments: 120,
  /** A schedule spans at most this many years (proposals and commitments look no further) */
  years: 10,
  titleChars: 200,
  noteChars: 2000,
  /** Lines per proposal request and changes per "Update lines" */
  confirm: 200,
  updates: 400,
  /** The notice warning turns orange within this many days */
  noticeSoonDays: 90,
} as const;

const dateText = z
  .string()
  .trim()
  .max(10)
  .refine((s) => isCalendarDate(s), 'a date like 2026-10-01');
const amountText = z
  .string()
  .trim()
  .max(32)
  .refine((v) => toMicros(v) !== null && toMicros(v)! >= 0, 'an amount like 1000 or 1000.50');

const scheduleFields = {
  title: z.string().trim().min(1).max(COST_SCHEDULE_LIMITS.titleChars),
  category: z.enum(COST_PLAN_CATEGORIES).default('support'),
  /** An application or system of the paying service (validated by the server) */
  target: z
    .object({ kind: z.enum(COST_PLAN_TARGET_KINDS), id: z.string().trim().min(1).max(100) })
    .strict()
    .nullable()
    .default(null),
  /** The amount per payment in contract year 1 (dated payments: unused) */
  amount: amountText.default('0'),
  currency: isoCurrencyCode,
  billing: z.enum(COST_SCHEDULE_BILLINGS),
  /** Default: the start */
  firstPaymentOn: dateText.nullable().default(null),
  /** null: the contract's start */
  startsOn: dateText.nullable().default(null),
  /** "Planned until"; null: follows the contract */
  endsOn: dateText.nullable().default(null),
  /** Amounts of contract years 2–10 (null: the year before) */
  yearAmounts: z.array(amountText.nullable()).max(COST_SCHEDULE_LIMITS.yearAmounts).default([]),
  /** Billing "dates": each payment with its date, amount and optionally the last day it covers */
  payments: z
    .array(z.object({ date: dateText, amount: amountText, coversUntil: dateText.nullable().default(null) }).strict())
    .max(COST_SCHEDULE_LIMITS.payments)
    .default([]),
  note: z.string().trim().max(COST_SCHEDULE_LIMITS.noteChars).default(''),
};

type ScheduleFieldsOut = {
  amount: string;
  currency: string;
  billing: CostScheduleBilling;
  startsOn: string | null;
  endsOn: string | null;
  yearAmounts: (string | null)[];
  payments: { date: string; amount: string; coversUntil: string | null }[];
};

function checkSchedule(x: ScheduleFieldsOut, ctx: z.RefinementCtx): void {
  if (x.billing === 'dates') {
    if (!x.payments.length) ctx.addIssue({ code: 'custom', path: ['payments'], message: 'at least one dated payment' });
  } else if (!((toMicros(x.amount) ?? 0) > 0)) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'an amount above 0' });
  checkCurrencyDecimals(x, ctx);
  x.yearAmounts.forEach((a, i) => {
    if (a !== null && !fitsCurrency(toMicros(a) ?? 0, x.currency))
      ctx.addIssue({ code: 'custom', path: ['yearAmounts', i], message: `no more decimals than ${x.currency} has` });
  });
  x.payments.forEach((p, i) => {
    if (!fitsCurrency(toMicros(p.amount) ?? 0, x.currency))
      ctx.addIssue({ code: 'custom', path: ['payments', i, 'amount'], message: `no more decimals than ${x.currency} has` });
    if (p.coversUntil && p.coversUntil < p.date) ctx.addIssue({ code: 'custom', path: ['payments', i, 'coversUntil'], message: 'before the payment' });
  });
  if (x.startsOn && x.endsOn && x.endsOn < x.startsOn) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'the end is before the start' });
}

/** A new payment schedule: the contract and the paying service, then the payments. */
export const costScheduleInput = z
  .object({ contractId: z.string().trim().min(1).max(100), serviceId: z.string().trim().min(1).max(100), ...scheduleFields })
  .strict()
  .superRefine(checkSchedule);
export type CostScheduleInput = z.input<typeof costScheduleInput>;

/** A change keeps the contract and the paying service. */
export const costScheduleUpdate = z
  .object({ ...scheduleFields })
  .strict()
  .superRefine(checkSchedule);
export type CostScheduleUpdate = z.input<typeof costScheduleUpdate>;

/** "Add to plan": the schedules whose proposals for the fiscal year become plan lines. */
export const costProposalConfirm = z
  .object({
    fiscalYear: z.number().int().min(2000).max(2100),
    scheduleIds: z.array(z.string().trim().min(1).max(100)).min(1).max(COST_SCHEDULE_LIMITS.confirm),
  })
  .strict();

/** "Update lines": the selected changes (schedule and part) of a fiscal year. */
export const costContractUpdates = z
  .object({
    fiscalYear: z.number().int().min(2000).max(2100),
    changes: z
      .array(z.object({ scheduleId: z.string().trim().min(1).max(100), part: z.string().trim().min(1).max(40) }).strict())
      .min(1)
      .max(COST_SCHEDULE_LIMITS.updates),
  })
  .strict();

// ---------- the arithmetic ----------

/** A schedule as the arithmetic reads it: amounts in micros. */
export interface ScheduleSpec {
  billing: CostScheduleBilling;
  /** Per payment in contract year 1 */
  amount: number;
  currency: string;
  firstPaymentOn: string | null;
  /** Own start; null: the contract's */
  startsOn: string | null;
  /** Own end ("planned until"); null: follows the contract */
  endsOn: string | null;
  /** Contract years 2–10 (index 0 is year 2); null: the year before */
  yearAmounts: (number | null)[];
  payments: { date: string; amount: number; coversUntil: string | null }[];
}

/** What the arithmetic reads of a contract. */
export interface ContractTerms {
  startsOn: string | null;
  endsOn: string | null;
  noticeDays: number | null;
  renewal: SupplierRenewal;
  renewalMonths: number | null;
}

export interface SchedulePayment {
  date: string;
  amount: number;
  /** 1, 2, … counted from the start in twelve-month steps */
  contractYear: number;
  /** The days a yearly, one-off or dated payment covers when that is more than its month (prepaid) */
  coversFrom: string | null;
  coversTo: string | null;
}

const MONTHS: Record<CostScheduleBilling, number> = { monthly: 1, quarterly: 3, yearly: 12, once: 0, dates: 0 };
const minDate = (...ds: (string | null | undefined)[]): string | null => ds.filter((d): d is string => !!d).sort()[0] ?? null;
const lastOfMonth = (date: string) => addDays(addMonths(`${date.slice(0, 7)}-01`, 1), -1);

/** The schedule's start: its own, else the contract's, else its first payment. */
export function scheduleStart(s: ScheduleSpec, c: ContractTerms): string | null {
  return s.startsOn ?? c.startsOn ?? s.firstPaymentOn ?? minDate(...s.payments.map((p) => p.date));
}

/** A contract that does not run on by itself: it ends on its end date (fixed end, or renewed by agreement). */
export const hasFixedEnd = (c: ContractTerms): boolean => !!c.endsOn && c.renewal !== 'automatic';

/**
 * The last day a schedule may have a payment: its own end, never past a contract's fixed end, and at most ten years
 * after its start. An automatic renewal (or a contract without an end date) runs on term by term up to that bound.
 */
export function scheduleEnd(s: ScheduleSpec, c: ContractTerms): string | null {
  const start = scheduleStart(s, c);
  if (!start) return null;
  const limit = addDays(addMonths(start, 12 * COST_SCHEDULE_LIMITS.years), -1);
  return minDate(s.endsOn, hasFixedEnd(c) ? c.endsOn : null, limit);
}

/** The contract year (1, 2, …) of a date: twelve-month steps from the start. */
export function contractYearOf(date: string, start: string): number {
  if (date < start) return 1;
  let k = Math.floor(daysBetween(start, date) / 366);
  while (addMonths(start, 12 * (k + 1)) <= date) k++;
  while (k > 0 && addMonths(start, 12 * k) > date) k--;
  return k + 1;
}

/** The amount of a payment in a contract year: year 1 the schedule's amount, later years their own or the year before's. */
export function yearAmount(s: ScheduleSpec, year: number): number {
  let a = s.amount;
  for (let y = 2; y <= Math.min(year, COST_SCHEDULE_LIMITS.yearAmounts + 1); y++) a = s.yearAmounts[y - 2] ?? a;
  return a;
}

/**
 * The amounts of contract years 2–10 from "+ x % per year", each rounded half away from zero to the currency's minor
 * units from the year before's rounded amount – what the form fills in (and what is stored is what is shown).
 */
export function yearAmountsFromPercent(amount: number, pct: number, currency: string, years: number = COST_SCHEDULE_LIMITS.yearAmounts): number[] {
  const out: number[] = [];
  let a = amount;
  for (let i = 0; i < years; i++) {
    a = roundToCurrency(Math.round(a * (1 + pct / 100)), currency);
    out.push(a);
  }
  return out;
}

/** Every payment of a schedule, first to last, up to its end (scheduleEnd), the dated ones as they are. */
export function schedulePayments(s: ScheduleSpec, c: ContractTerms): SchedulePayment[] {
  const start = scheduleStart(s, c);
  const end = scheduleEnd(s, c);
  if (!start || !end) return [];
  if (s.billing === 'dates')
    return [...s.payments]
      .filter((p) => p.date <= end)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((p) => ({
        date: p.date,
        amount: p.amount,
        contractYear: contractYearOf(p.date, start),
        coversFrom: p.coversUntil && p.coversUntil > lastOfMonth(p.date) ? p.date : null,
        coversTo: p.coversUntil && p.coversUntil > lastOfMonth(p.date) ? p.coversUntil : null,
      }));
  const first = s.firstPaymentOn ?? start;
  if (s.billing === 'once') {
    if (first > end) return [];
    // a one-off payment covers the schedule's term: its own end, else the contract's (the current term)
    const until = minDate(s.endsOn ?? c.endsOn, end);
    const covers = !!until && until > lastOfMonth(first);
    return [
      {
        date: first,
        amount: s.amount,
        contractYear: contractYearOf(first, start),
        coversFrom: covers ? minDate(start, first) : null,
        coversTo: covers ? until : null,
      },
    ];
  }
  const step = MONTHS[s.billing];
  const out: SchedulePayment[] = [];
  for (let k = 0; k < 12 * COST_SCHEDULE_LIMITS.years + 12; k++) {
    // from the first payment, not from the previous one: the 31st stays the 31st after a shorter month
    const date = addMonths(first, k * step);
    if (date > end) break;
    const year = contractYearOf(date, start);
    const coversTo = s.billing === 'yearly' ? minDate(addDays(addMonths(date, 12), -1), end) : null;
    out.push({
      date,
      amount: yearAmount(s, year),
      contractYear: year,
      coversFrom: coversTo && coversTo > lastOfMonth(date) ? date : null,
      coversTo: coversTo && coversTo > lastOfMonth(date) ? coversTo : null,
    });
  }
  return out;
}

/** One plan line a schedule proposes for a fiscal year (a part: a contract year of periodic billing, or one payment). */
export interface ProposalPart {
  /** "y2" (contract year 2 of monthly or quarterly billing) or "p2026-02-01" (one payment) */
  part: string;
  cadence: CostPlanCadence;
  /** Positions 0–11 in the fiscal year; null/null: the whole year */
  fromIndex: number | null;
  toIndex: number | null;
  onceIndex: number | null;
  amount: number;
  /** The twelve month amounts (what the line is made from) */
  months: number[];
  /** The payment date in each month (null: none) – Book's default date */
  paymentDates: (string | null)[];
  coversFrom: string | null;
  coversTo: string | null;
}

/**
 * The plan lines a schedule proposes for a fiscal year: monthly billing a monthly line per contract-year part (a
 * price change inside the year gives two lines), quarterly a quarterly line per part, yearly, once and dated payments
 * a one-off line per payment (paid in its month; a prepaid one says what it covers).
 */
export function proposalParts(s: ScheduleSpec, c: ContractTerms, fiscalYear: number, startMonth: number): ProposalPart[] {
  const months = fiscalYearMonths(fiscalYear, startMonth);
  const b = fiscalYearBounds(fiscalYear, startMonth);
  const pays = schedulePayments(s, c).filter((p) => p.date >= b.from && p.date <= b.last);
  if (!pays.length) return [];
  const idx = (date: string) => months.indexOf(date.slice(0, 7));
  const dates = (ps: SchedulePayment[]) => months.map((m) => ps.find((p) => p.date.startsWith(m))?.date ?? null);
  if (s.billing === 'monthly' || s.billing === 'quarterly') {
    const byYear = new Map<number, SchedulePayment[]>();
    for (const p of pays) byYear.set(p.contractYear, [...(byYear.get(p.contractYear) ?? []), p]);
    return [...byYear.entries()].map(([year, ps]) => {
      const from = idx(ps[0]!.date);
      const to = idx(ps[ps.length - 1]!.date);
      const whole = from === 0 && to === 11;
      const cadence: CostPlanCadence = s.billing === 'monthly' ? 'monthly' : 'quarterly';
      const amount = ps[0]!.amount;
      return {
        part: `y${year}`,
        cadence,
        fromIndex: whole ? null : from,
        toIndex: whole ? null : to,
        onceIndex: null,
        amount,
        months: planMonths(amount, cadence, null, { from, to }),
        paymentDates: dates(ps),
        coversFrom: null,
        coversTo: null,
      };
    });
  }
  const seen = new Map<string, number>();
  return pays.map((p) => {
    const n = (seen.get(p.date) ?? 0) + 1;
    seen.set(p.date, n);
    const i = idx(p.date);
    return {
      part: n === 1 ? `p${p.date}` : `p${p.date}#${n}`,
      cadence: 'once' as const,
      fromIndex: null,
      toIndex: null,
      onceIndex: i,
      amount: p.amount,
      months: planMonths(p.amount, 'once', i),
      paymentDates: dates([p]),
      coversFrom: p.coversFrom,
      coversTo: p.coversTo,
    };
  });
}

/** Whether a line's basis (the twelve month amounts it was made from) differs from a part's months now. */
export const basisDiffers = (basis: readonly number[] | null, months: readonly number[]): boolean =>
  !basis || basis.length !== 12 || basis.some((v, i) => Number(v) !== months[i]);

/** The earliest exit (ADR 0030): the end of the term after the next notice-by date, the fixed end, or today plus the notice period. */
export function earliestExit(c: ContractTerms, today: string): string {
  if (!c.endsOn) return addDays(today, c.noticeDays ?? 0);
  if (c.renewal === 'automatic') return contractDates(c, today).termEnd ?? c.endsOn;
  return c.endsOn;
}

/** What a schedule still owes: the payments dated today or later, in total and per fiscal year. */
export interface ScheduleOwed {
  /** Up to the schedule's end – its own, else the contract's; automatic renewal or no end date: the earliest exit */
  toContractEnd: number;
  toEarliestExit: number;
  contractEnd: string | null;
  earliestExit: string | null;
  nextPayment: { date: string; amount: number } | null;
  byFiscalYear: { fiscalYear: number; toContractEnd: number; toEarliestExit: number }[];
}

export function scheduleOwed(s: ScheduleSpec, c: ContractTerms, today: string, startMonth: number): ScheduleOwed {
  const end = scheduleEnd(s, c);
  const exit = earliestExit(c, today);
  const contractEnd = minDate(s.endsOn ?? (hasFixedEnd(c) ? c.endsOn : exit), end);
  const exitEnd = minDate(exit, end);
  const pays = schedulePayments(s, c).filter((p) => p.date >= today);
  const years = new Map<number, { toContractEnd: number; toEarliestExit: number }>();
  let toContractEnd = 0;
  let toEarliestExit = 0;
  for (const p of pays) {
    const fy = fiscalYearOf(p.date, startMonth);
    const y = years.get(fy) ?? { toContractEnd: 0, toEarliestExit: 0 };
    if (contractEnd && p.date <= contractEnd) {
      toContractEnd += p.amount;
      y.toContractEnd += p.amount;
    }
    if (exitEnd && p.date <= exitEnd) {
      toEarliestExit += p.amount;
      y.toEarliestExit += p.amount;
    }
    years.set(fy, y);
  }
  const next = pays[0];
  return {
    toContractEnd,
    toEarliestExit,
    contractEnd,
    earliestExit: exitEnd,
    nextPayment: next ? { date: next.date, amount: next.amount } : null,
    byFiscalYear: [...years.entries()]
      .filter(([, v]) => v.toContractEnd || v.toEarliestExit)
      .sort(([a], [b]) => a - b)
      .map(([fiscalYear, v]) => ({ fiscalYear, ...v })),
  };
}

/**
 * The notice warning (ADR 0030): the next notice-by date of an automatically renewing contract is ahead and the
 * fiscal year in which its next term would start has no plan lines of the paying service – once that date passes,
 * the next term is owed whether planned or not. `soon`: within 90 days (orange, like the supplier's notice state).
 */
export function noticeWarning(
  c: ContractTerms,
  today: string,
  startMonth: number,
  plannedYears: ReadonlySet<number>,
  scheduleEndsOn: string | null = null,
): { noticeBy: string; fiscalYear: number; label: string; days: number; soon: boolean } | null {
  if (c.renewal !== 'automatic' || !c.endsOn) return null;
  const d = contractDates(c, today);
  if (!d.noticeBy || !d.termEnd || d.noticeBy < today) return null;
  const nextTerm = addDays(d.termEnd, 1);
  // a schedule planned to end before the next term owes nothing there
  if (scheduleEndsOn && scheduleEndsOn < nextTerm) return null;
  const fy = fiscalYearOf(nextTerm, startMonth);
  if (plannedYears.has(fy)) return null;
  const days = daysBetween(today, d.noticeBy);
  return { noticeBy: d.noticeBy, fiscalYear: fy, label: fiscalYearLabel(fy, startMonth), days, soon: days <= COST_SCHEDULE_LIMITS.noticeSoonDays };
}

// ---------- read ----------

/** A payment schedule as the app reads it (GET /api/costs/schedules). */
export interface CostSchedule {
  id: string;
  contractId: string;
  serviceId: string;
  serviceName: string;
  /** null with `contractHidden`: a contract of a supplier the reader may not see – amounts, no supplier, title or dates */
  supplier: SupplierRef | null;
  contract: { id: string; title: string; reference: string } | null;
  contractHidden: boolean;
  title: string;
  category: CostPlanCategory;
  target: CostPlanTarget | null;
  /** null when the reader may not see amounts (Hide amounts from viewers) */
  amount: string | null;
  currency: string;
  billing: CostScheduleBilling;
  firstPaymentOn: string | null;
  startsOn: string | null;
  endsOn: string | null;
  /** The start and end that apply (the contract's when the schedule has none); null for a hidden contract */
  effectiveStart: string | null;
  effectiveEnd: string | null;
  yearAmounts: (string | null)[];
  payments: { date: string; amount: string | null; coversUntil: string | null }[];
  note: string;
  nextPayment: { date: string; amount: string | null } | null;
  canEdit: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** The schedules of a contract or a service, and whether the reader may add one (GET /api/costs/schedules). */
export interface CostScheduleList {
  schedules: CostSchedule[];
  /** Add a schedule: who may change the contract, or edit a service and see the contract */
  canAdd: boolean;
  limits: { perContract: number; perService: number };
}

/** A line of a proposal as the cost plan shows it. */
export interface CostProposalLine {
  part: string;
  title: string;
  cadence: CostPlanCadence;
  fromMonth: string | null;
  toMonth: string | null;
  onceMonth: string | null;
  amount: string | null;
  planned: string | null;
  coversFrom: string | null;
  coversTo: string | null;
}

/** "Contract payments to plan" of a fiscal year (GET /api/costs/plans/:serviceId/proposals). */
export interface CostProposals {
  serviceId: string;
  fiscalYear: number;
  label: string;
  canEdit: boolean;
  proposals: {
    scheduleId: string;
    title: string;
    contractId: string;
    supplier: SupplierRef | null;
    contractHidden: boolean;
    currency: string;
    lines: CostProposalLine[];
    planned: string | null;
  }[];
  /** Plan lines the year can still take */
  linesLeft: number;
}

/** One change of "Contract changed": a line before and after (null: none – a part that is new, or one that is gone). */
export interface CostContractChange {
  part: string;
  lineId: string | null;
  before: CostProposalLine | null;
  after: CostProposalLine | null;
  /** Entries on the line (a part that goes leaves them unplanned) */
  entries: number;
}

// ---------- commitments (ADR 0030 part 5) ----------

/** The commitments of one payment schedule as of today (scheduled payments, not liabilities: entries are not subtracted). */
export interface CostCommitment {
  scheduleId: string;
  title: string;
  serviceId: string;
  serviceName: string;
  /** The service's owning teams the reader may see (grouping by team) */
  teams: { id: string; name: string }[];
  /** null with `contractHidden`: a contract of a supplier the reader may not see – amounts only */
  supplier: SupplierRef | null;
  contract: { id: string; title: string; reference: string } | null;
  contractHidden: boolean;
  billing: CostScheduleBilling;
  currency: string;
  /** The paying service's amounts are visible to the reader (Hide amounts from viewers) */
  amountsVisible: boolean;
  nextPayment: { date: string; amount: string | null } | null;
  /** Owed in the current fiscal year from today, and in the later ones (to contract end) */
  owedThisYear: string | null;
  owedLaterYears: string | null;
  toContractEnd: string | null;
  toEarliestExit: string | null;
  /** The days they run to (null for a hidden contract) */
  contractEnd: string | null;
  earliestExit: string | null;
  /** To contract end per fiscal year: the current one and the next four (aligned with CostCommitments.years), then later */
  years: (string | null)[];
  later: string | null;
  /** The contract's next notice-by date (null: none, or a hidden contract) */
  noticeBy: string | null;
  /** The notice warning: the notice-by date is ahead and the fiscal year of the next term is not planned */
  warning: { noticeBy: string; fiscalYear: number; label: string; days: number; soon: boolean } | null;
  /** Lines of the current or a later fiscal year made from it show "Contract changed" */
  changed: boolean;
  /** Months (YYYY-MM) of the current fiscal year with a payment of its lines and no entry */
  notBooked: string[];
}

/** GET /api/costs/commitments: the schedules of the services the reader may see. */
export interface CostCommitments {
  today: string;
  fiscalYear: number;
  /** The current fiscal year and the next four */
  years: { fiscalYear: number; label: string }[];
  rows: CostCommitment[];
  /** Per currency over the rows whose amounts the reader sees */
  totals: { currency: string; years: string[]; later: string; owedThisYear: string; toContractEnd: string; toEarliestExit: string }[];
  /** Rows with the notice warning */
  warnings: number;
  /** With a supplier: what was incurred per fiscal year from entries naming it (services the reader may see, amounts visible) */
  incurred?: { fiscalYear: number; label: string; currency: string; amount: string }[];
}

/** The filters of the commitments page, the export and /api/v1/cost-commitments. */
export const costCommitmentsQuery = z.object({
  teamId: z.string().trim().min(1).max(100).optional(),
  serviceId: z.string().trim().min(1).max(100).optional(),
  supplierId: z.string().trim().min(1).max(100).optional(),
  currency: z.string().trim().length(3).optional(),
  /** Only schedules whose contract end or earliest exit is within this many days */
  endingWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
});
export type CostCommitmentsQuery = z.infer<typeof costCommitmentsQuery>;

/** The built-in dataset of commitments (administrators and auditors, published at most hourly). */
export const COST_COMMITMENTS_DATASET = 'costs.commitments';
