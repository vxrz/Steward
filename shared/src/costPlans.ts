import { z } from 'zod';
import { checkCurrencyDecimals, currencyMinorUnits, isoCurrencyCode, toMicros } from './costs.js';
import type { SupplierRef } from './suppliers.js';
import type { CostContractChange, CostPayer, CostVolumeBilling, CostVolumeConsumption, CostVolumeStatus } from './costContracts.js';

/**
 * Service cost planning (0.16.0, ADR 0026, docs/COSTS.md#planning-per-service): what a service plans to spend on the
 * systems and solutions it uses and on support, per fiscal year, and what it incurred – lightweight, internal to the
 * service. No person-hours, no approvals, orders or invoice processing, no chargeback and no currency conversion.
 *
 * - One fiscal year start for the whole instance (`fiscalYearStartMonth` of the cost settings, 1–12, default 1). A
 *   fiscal year is named by the calendar year it starts in: "FY 2026" (start January), "FY 2026/27" (start October).
 * - Plan lines per service and fiscal year: a title, a category, what it is for (an application or system of the
 *   service, or a platform; else free text), an amount in a currency with a cadence (yearly spread evenly over the
 *   12 months, monthly, quarterly, once in one month), an optional renewal date and a note.
 * - 0.18.0 (ADR 0030): monthly, quarterly and yearly lines may cover only part of the year (a from and a to month,
 *   stored as positions 0–11 like the month of a one-off payment); a one-off payment may say which days it covers
 *   (prepaid); entries name a supplier and a contract.
 * - Cost entries: a date, an amount and a currency, optionally a plan line (without one: "unplanned") and an
 *   application or system of the service, a reference (invoice or PO number) and a note.
 *
 * Amounts are whole millionths of the currency (micros) like the cost model, decimal strings in the API.
 */

// ---------- fiscal years ----------

export const FISCAL_YEAR_MIN = 2000;
export const FISCAL_YEAR_MAX = 2100;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM plus n months (n may be negative). Pure string arithmetic, no time zones. */
export function shiftMonth(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${pad2(mm + 1)}`;
}

/** The fiscal year (the calendar year it starts in) of a month YYYY-MM or a date YYYY-MM-DD. */
export function fiscalYearOf(monthOrDate: string, startMonth: number): number {
  const y = Number(monthOrDate.slice(0, 4));
  const m = Number(monthOrDate.slice(5, 7));
  return m >= startMonth ? y : y - 1;
}

/** The 12 months (YYYY-MM) of a fiscal year, first to last. */
export function fiscalYearMonths(fiscalYear: number, startMonth: number): string[] {
  const first = `${fiscalYear}-${pad2(startMonth)}`;
  return Array.from({ length: 12 }, (_, i) => shiftMonth(first, i));
}

/** "FY 2026" when the year starts in January, else "FY 2026/27". */
export function fiscalYearLabel(fiscalYear: number, startMonth: number): string {
  return startMonth === 1 ? `FY ${fiscalYear}` : `FY ${fiscalYear}/${pad2((fiscalYear + 1) % 100)}`;
}

/** The first day of a fiscal year and the first day after it (YYYY-MM-DD, end exclusive), and its last day. */
export function fiscalYearBounds(fiscalYear: number, startMonth: number): { from: string; to: string; last: string } {
  const months = fiscalYearMonths(fiscalYear, startMonth);
  const to = `${shiftMonth(months[11]!, 1)}-01`;
  const last = new Date(Date.parse(`${to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return { from: `${months[0]}-01`, to, last };
}

/** A date YYYY-MM-DD that exists in the calendar (29 February only in leap years). */
export function isCalendarDate(s: string): boolean {
  if (s.length !== 10 || s[4] !== '-' || s[7] !== '-') return false;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) if (s[i]! < '0' || s[i]! > '9') return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A month YYYY-MM. */
export function isMonth(s: string): boolean {
  return s.length === 7 && isCalendarDate(`${s}-01`);
}

// ---------- plan lines and entries ----------

export const COST_PLAN_CATEGORIES = ['licence', 'cloud', 'support', 'hardware', 'other'] as const;
export type CostPlanCategory = (typeof COST_PLAN_CATEGORIES)[number];

/**
 * yearly: the amount is the year's (of the months the line covers), spread evenly over them; monthly: the amount every
 * month; quarterly (0.18.0): the amount every third month from the line's first month; once: in one month.
 */
export const COST_PLAN_CADENCES = ['yearly', 'monthly', 'quarterly', 'once'] as const;
export type CostPlanCadence = (typeof COST_PLAN_CADENCES)[number];

/** What a plan line or an entry is for: an application or system of the service, or a platform. */
export const COST_PLAN_TARGET_KINDS = ['application', 'system', 'platform'] as const;
export type CostPlanTargetKind = (typeof COST_PLAN_TARGET_KINDS)[number];

export const COST_PLAN_LIMITS = {
  /** Plan lines per service and fiscal year */
  linesPerYear: 200,
  /** Cost entries per service and fiscal year */
  entriesPerYear: 2000,
  titleChars: 200,
  vendorChars: 200,
  referenceChars: 100,
  noteChars: 2000,
  /** Renewals shown ahead, in days */
  renewalDays: 90,
} as const;

/**
 * An amount split into `n` parts that add up to it exactly – in whole minor units of the currency when it has one and
 * the amount fits it (8333.33 + … EUR, 8333 + … JPY), else in micros (amounts entered before 0.18.0 with more decimals
 * than their currency). The parts differ by one unit at most.
 */
export function spreadAmount(amountMicros: number, n: number, currency?: string): number[] {
  if (n <= 0) return [];
  let unit = currency ? BigInt(10 ** (6 - currencyMinorUnits(currency))) : 1n;
  const total = BigInt(Math.round(amountMicros));
  if (total % unit !== 0n) unit = 1n;
  const units = total / unit;
  const nn = BigInt(n);
  // floor division that also holds for a negative total
  const fl = (a: bigint) => (a >= 0n ? a / nn : -((-a + nn - 1n) / nn));
  return Array.from({ length: n }, (_, i) => Number((fl(units * BigInt(i + 1)) - fl(units * BigInt(i))) * unit));
}

/** The months of a plan line in its fiscal year (positions 0–11), as stored: none means the whole year. */
export interface PlanLineSpan {
  from?: number | null;
  to?: number | null;
  /** The currency: a yearly amount is spread in its minor units (0.18.0) */
  currency?: string;
}

/**
 * Whole millionths per month of a plan line in its fiscal year (12 values). A yearly amount is spread evenly over the
 * months the line covers (from–to, default the whole year), in the currency's minor units, so that they add up to it
 * exactly; monthly: the amount in each month from–to; quarterly: every third month from the from month up to the to
 * month; once: in its month.
 */
export function planMonths(amountMicros: number, cadence: CostPlanCadence, onceIndex: number | null, span: PlanLineSpan = {}): number[] {
  const from = Math.max(0, Math.min(11, span.from ?? 0));
  const to = Math.max(from, Math.min(11, span.to ?? 11));
  const out = Array.from({ length: 12 }, () => 0);
  if (cadence === 'once') {
    if (onceIndex !== null && onceIndex >= 0 && onceIndex < 12) out[onceIndex] = amountMicros;
    return out;
  }
  if (cadence === 'monthly') {
    for (let i = from; i <= to; i++) out[i] = amountMicros;
    return out;
  }
  if (cadence === 'quarterly') {
    for (let i = from; i <= to; i += 3) out[i] = amountMicros;
    return out;
  }
  spreadAmount(amountMicros, to - from + 1, span.currency).forEach((v, k) => (out[from + k] = v));
  return out;
}

/** Book (0.18.0): offered on lines whose months are payments – monthly, quarterly and one-off – not on yearly spreads. */
export const isBookable = (cadence: CostPlanCadence): boolean => cadence !== 'yearly';

/**
 * The month Book offers first (position 0–11; null: no payment up to now): the current month when it has a payment
 * without an entry, else the latest earlier month with one, else the current month (booked already: Book asks), else
 * the latest month with a payment. Months after the current one are never offered – an entry says money was spent.
 */
export function defaultBookIndex(planned: readonly boolean[], booked: readonly boolean[], cur: number): number | null {
  const upto = Math.min(cur, 11);
  if (upto < 0) return null;
  if (cur <= 11 && planned[cur] && !booked[cur]) return cur;
  for (let i = upto; i >= 0; i--) if (planned[i] && !booked[i]) return i;
  if (cur <= 11 && planned[cur]) return cur;
  for (let i = upto; i >= 0; i--) if (planned[i]) return i;
  return null;
}

/** The last day (YYYY-MM-DD) of a month YYYY-MM. */
export function lastDayOf(month: string): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
}

const dateText = z
  .string()
  .trim()
  .max(10)
  .refine((s) => isCalendarDate(s), 'a date like 2026-10-01');
const monthText = z
  .string()
  .trim()
  .max(7)
  .refine((s) => isMonth(s), 'a month like 2026-10');
const target = z
  .object({ kind: z.enum(COST_PLAN_TARGET_KINDS), id: z.string().trim().min(1).max(100) })
  .strict()
  .nullable()
  .default(null);

const planLineFields = {
  title: z.string().trim().min(1).max(COST_PLAN_LIMITS.titleChars),
  category: z.enum(COST_PLAN_CATEGORIES),
  /** An application or system of the service, or a platform (validated by the server) */
  target,
  /** Free text: the vendor or the contract; the fallback when no supplier is linked */
  vendor: z.string().trim().max(COST_PLAN_LIMITS.vendorChars).default(''),
  /** The supplier (0.17.0, ADR 0029): missing keeps it, null clears it */
  supplierId: z.string().trim().min(1).max(100).nullable().optional(),
  /** The supplier's contract the line pays for: missing keeps it, null clears it */
  supplierContractId: z.string().trim().min(1).max(100).nullable().optional(),
  /** The amount (decimal) – a year's for "yearly", a month's for "monthly", the one payment for "once" */
  amount: z
    .string()
    .trim()
    .max(32)
    .refine((v) => toMicros(v) !== null && toMicros(v)! > 0, 'an amount above 0, like 1500 or 1500.50'),
  currency: isoCurrencyCode,
  cadence: z.enum(COST_PLAN_CADENCES),
  /** "once": the month (YYYY-MM) in the fiscal year */
  onceMonth: monthText.nullable().default(null),
  /** Only part of the year (0.18.0; monthly, quarterly, yearly): the first and the last month (YYYY-MM) in the fiscal year; none: the whole year */
  fromMonth: monthText.nullable().default(null),
  toMonth: monthText.nullable().default(null),
  /** A one-off payment that covers more than its month (prepaid, 0.18.0): the first and the last day it covers */
  coversFrom: dateText.nullable().default(null),
  coversTo: dateText.nullable().default(null),
  /** Contract end or renewal (YYYY-MM-DD) */
  renewalDate: dateText.nullable().default(null),
  note: z.string().trim().max(COST_PLAN_LIMITS.noteChars).default(''),
  /** "Unlink from contract" (0.18.0): null makes a line made from a payment schedule an ordinary line; missing keeps it */
  scheduleId: z.null().optional(),
};

const onceNeedsMonth = (
  x: {
    cadence: CostPlanCadence;
    onceMonth: string | null;
    fromMonth: string | null;
    toMonth: string | null;
    coversFrom: string | null;
    coversTo: string | null;
    amount: string;
    currency: string;
  },
  ctx: z.RefinementCtx,
) => {
  if (x.cadence === 'once' && !x.onceMonth) ctx.addIssue({ code: 'custom', path: ['onceMonth'], message: 'the month of the payment' });
  if (x.fromMonth && x.toMonth && x.toMonth < x.fromMonth) ctx.addIssue({ code: 'custom', path: ['toMonth'], message: 'the last month is before the first' });
  if (!x.coversFrom !== !x.coversTo)
    ctx.addIssue({ code: 'custom', path: [x.coversFrom ? 'coversTo' : 'coversFrom'], message: 'the first and the last day it covers' });
  if (x.coversFrom && x.coversTo && x.coversTo < x.coversFrom)
    ctx.addIssue({ code: 'custom', path: ['coversTo'], message: 'the last day is before the first' });
  // no more decimals than the currency has (0.18.0): 1500.50 JPY is refused
  checkCurrencyDecimals(x, ctx);
};

export const costPlanLineInput = z
  .object({ fiscalYear: z.number().int().min(FISCAL_YEAR_MIN).max(FISCAL_YEAR_MAX), ...planLineFields })
  .strict()
  .superRefine(onceNeedsMonth);
export type CostPlanLineInput = z.input<typeof costPlanLineInput>;

/** A change keeps the line's fiscal year. */
export const costPlanLineUpdate = z
  .object({ ...planLineFields })
  .strict()
  .superRefine(onceNeedsMonth);
export type CostPlanLineUpdate = z.input<typeof costPlanLineUpdate>;

/** Copies the lines of `fiscalYear` into the next fiscal year. */
export const costPlanCopyInput = z
  .object({
    fiscalYear: z
      .number()
      .int()
      .min(FISCAL_YEAR_MIN)
      .max(FISCAL_YEAR_MAX - 1),
  })
  .strict();

/** A cost entry. Effort (hours, days) is not something Steward plans or records: the schema refuses unknown fields. */
export const costEntryInput = z
  .object({
    date: dateText,
    /** The amount (decimal); negative for a credit note */
    amount: z
      .string()
      .trim()
      .max(32)
      .refine((v) => toMicros(v) !== null && toMicros(v)! !== 0, 'an amount like 1500.50 (negative for a credit)'),
    currency: isoCurrencyCode,
    /** The plan line (same service, fiscal year and currency); none: unplanned */
    planLineId: z.string().trim().min(1).max(100).nullable().default(null),
    target,
    /** The supplier (0.18.0, ADR 0030): missing keeps it – on a new entry with a plan line, the line's; null clears it */
    supplierId: z.string().trim().min(1).max(100).nullable().optional(),
    /** The supplier's contract: missing keeps it (a new entry with a plan line: the line's); null clears it */
    supplierContractId: z.string().trim().min(1).max(100).nullable().optional(),
    /** Invoice or order number */
    reference: z.string().trim().max(COST_PLAN_LIMITS.referenceChars).default(''),
    note: z.string().trim().max(COST_PLAN_LIMITS.noteChars).default(''),
  })
  .strict()
  .superRefine(checkCurrencyDecimals);
export type CostEntryInput = z.input<typeof costEntryInput>;

/**
 * Book (0.18.0, ADR 0030): one entry from a plan line's payment in a month – prefilled with the planned amount, the
 * line's currency, supplier, contract and target. `again` books a month that has an entry on the line already.
 */
export const costBookInput = z
  .object({
    /** The month (YYYY-MM) of the fiscal year; default: the current one, or an earlier one without an entry */
    month: monthText.optional(),
    /** Default: the schedule's payment date in the month, else today (the current month) or the month's last day */
    date: dateText.optional(),
    /** Default: the planned amount of the month */
    amount: z
      .string()
      .trim()
      .max(32)
      .refine((v) => toMicros(v) !== null && toMicros(v)! !== 0, 'an amount like 1500.50 (negative for a credit)')
      .optional(),
    reference: z.string().trim().max(COST_PLAN_LIMITS.referenceChars).default(''),
    note: z.string().trim().max(COST_PLAN_LIMITS.noteChars).default(''),
    again: z.boolean().default(false),
  })
  .strict();
export type CostBookInput = z.input<typeof costBookInput>;

// ---------- the year view ----------

export interface CostPlanTarget {
  kind: CostPlanTargetKind;
  id: string;
  /** Empty when the reader may not see it */
  name: string;
  visible: boolean;
  /** No longer an application or system of the service (removed since) */
  gone?: boolean;
}

/** How a plan line relates to the cloud and platform costs read for the service (category cloud, an application or platform). */
export type CostPlanReadState = 'matched' | 'hidden' | 'taken' | 'none';

export interface CostPlanLine {
  id: string;
  serviceId: string;
  fiscalYear: number;
  title: string;
  category: CostPlanCategory;
  target: CostPlanTarget | null;
  vendor: string;
  /** The supplier (0.17.0, ADR 0029; null: none, or one the reader may not see); `vendor` is the fallback text */
  supplier: SupplierRef | null;
  /** A supplier is linked that the reader may not see (0.18.0): shown without its name, kept on save */
  supplierHidden: boolean;
  /** The supplier's contract the line pays for */
  supplierContract: { id: string; title: string; reference: string } | null;
  /** It names a contract the reader may not see (ADR 0031): "a contract you may not see", kept on save */
  supplierContractHidden: boolean;
  /** The contract no longer covers the service (ADR 0031) */
  supplierContractUncovered: boolean;
  /** As entered (null when the reader may not see amounts) */
  amount: string | null;
  currency: string;
  cadence: CostPlanCadence;
  onceMonth: string | null;
  /** Only part of the year (0.18.0): the first and the last month (YYYY-MM); null: the whole year */
  fromMonth: string | null;
  toMonth: string | null;
  /** A one-off payment that covers more than its month (prepaid): the days it covers */
  coversFrom: string | null;
  coversTo: string | null;
  renewalDate: string | null;
  note: string;
  /**
   * The payment schedule the line was made from (0.18.0, ADR 0030): `changed` when the schedule's proposal for the
   * year differs from what the line was made from (Contract changed); null: an ordinary line
   */
  schedule: { id: string; contractId: string; title: string; changed: boolean } | null;
  /**
   * The estimate the line was made from (0.21.0, ADR 0035): `changed` when the estimate no longer proposes what the
   * line was made from (Estimate changed, with Update lines); null: an ordinary line
   */
  estimate: { id: string; title: string; changed: boolean } | null;
  /** A line naming a contract without a schedule (0.17 style) whose contract ends in this fiscal year: its end */
  contractEnds: string | null;
  /** A hand-made line for a contract that also has a payment schedule with payments in this year (a hint, not a block) */
  twoLines: boolean;
  /** The schedule's payment date per month of the year (Book's default date; null: none, or not a schedule line) */
  paymentDates: (string | null)[] | null;
  /**
   * A line of a volume schedule (0.19.0, ADR 0032): how it is billed and where the use comes from; `suggested` – for
   * Book on a line billed by use: the average use per month so far in the period (Book asks for the actual amount)
   */
  volume: { billing: CostVolumeBilling; consumption: CostVolumeConsumption; suggested: string | null } | null;
  /** Book is offered (monthly, quarterly and one-off lines with a planned amount) */
  bookable: boolean;
  /** Months (YYYY-MM) that are over, and the current one, with a planned payment and no entry on the line */
  notBooked: string[];
  /** Planned per month of the fiscal year */
  months: (string | null)[];
  /** Incurred per month: entries and, for a matched cloud line, the costs read */
  incurredMonths: (string | null)[];
  planned: string | null;
  plannedToDate: string | null;
  incurredToDate: string | null;
  /** Incurred in the months that are over, and for the current month and those to come: what is booked, else the plan */
  expected: string | null;
  /** expected − planned */
  difference: string | null;
  read: CostPlanReadState;
  /** Entries on this line */
  entries: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CostEntry {
  id: string;
  serviceId: string;
  date: string;
  amount: string | null;
  currency: string;
  planLineId: string | null;
  planLineTitle: string | null;
  target: CostPlanTarget | null;
  /** The supplier (0.18.0; null: none, or one the reader may not see – `supplierHidden`) */
  supplier: SupplierRef | null;
  /** A supplier is linked that the reader may not see: kept on save */
  supplierHidden: boolean;
  supplierContract: { id: string; title: string; reference: string } | null;
  /** It names a contract the reader may not see (ADR 0031), kept on save; the contract no longer covers the service */
  supplierContractHidden: boolean;
  supplierContractUncovered: boolean;
  /** The CSV import the entry came from (0.18.0; null: entered or booked) */
  importId: string | null;
  reference: string;
  note: string;
  /** No plan line of this fiscal year */
  unplanned: boolean;
  /**
   * The part of the entry drawn from a prepaid volume of its contract (0.19.0, ADR 0032): use of what was paid up front,
   * not counted as incurred again (null: none)
   */
  drawn: string | null;
  /**
   * It counts for a prepaid volume of its contract the reader may not see in full – its payer, its amounts, or another
   * service or platform using it (security review 0.19.0 M2): the entry counts in full here, nothing of that volume is
   * shown as drawn ("possibly covered by a prepaid volume you may not see")
   */
  drawnHidden: boolean;
  /**
   * The fiscal year of its plan line when that is another one than the entry's (the fiscal year start changed since
   * the entry was linked): the link stays, the entry counts as unplanned in its own year (docs/COSTS.md).
   */
  planLineYear: { fiscalYear: number; label: string } | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CostPlanFigures {
  planned: string | null;
  plannedToDate: string | null;
  incurredToDate: string | null;
  expected: string | null;
  difference: string | null;
}

export interface CostPlanCurrency extends CostPlanFigures {
  currency: string;
  /** Per month of the fiscal year: planned, incurred (entries and the costs read), of which read */
  months: { month: string; planned: string | null; incurred: string | null; read: string | null }[];
  /** Cloud and platform costs read for the service that no plan line takes (null when hidden or none) */
  read: { incurredToDate: string | null; expected: string | null; months: (string | null)[] } | null;
  /** Entries without a plan line */
  unplanned: { incurredToDate: string | null; expected: string | null; count: number };
  /**
   * Use drawn from prepaid volumes (0.19.0, ADR 0032): read costs (a platform's plan) and entries covered by what was
   * paid up front – shown, not counted as incurred (null: none)
   */
  drawn: { toDate: string | null; months: (string | null)[] } | null;
}

/** shown: the reader sees every application of the service; hidden: they do not, so no cloud figures; none: nothing read. */
export type CostPlanCloudState = 'shown' | 'hidden' | 'none';

/** What changing the fiscal year start would do (GET /api/costs/settings/fiscal-year-change). */
export interface FiscalYearChange {
  startMonth: number;
  /** Plan lines and cost entries of all services: none, and the change moves nothing */
  lines: number;
  entries: number;
  /** Entries whose date would then fall into another fiscal year than their plan line's (they keep the link) */
  entriesOtherYear: number;
}

export interface CostPlanYear {
  /** Whose plan it is (0.19.0, ADR 0032): a service, or a platform's own cost plan */
  owner: CostPayer;
  /** The service ('' for a platform's plan) */
  serviceId: string;
  serviceName: string;
  fiscalYear: number;
  label: string;
  startMonth: number;
  months: string[];
  /** Index of the current month in `months`: -1 before the year, 12 after it */
  currentIndex: number;
  from: string;
  to: string;
  amountsVisible: boolean;
  canEdit: boolean;
  cloud: CostPlanCloudState;
  lines: CostPlanLine[];
  entries: CostEntry[];
  currencies: CostPlanCurrency[];
  /** Renewals of the service's plan lines in the next 90 days (any fiscal year) */
  renewals: { lineId: string; title: string; fiscalYear: number; renewalDate: string; days: number }[];
  /** Applications and systems of the service (for the forms; only those the reader may see; none for a platform) */
  targets: { kind: 'application' | 'system'; id: string; name: string }[];
  /** The volume schedules the plan's owner pays, each with its current period (0.19.0, ADR 0032) */
  volumes: (CostVolumeStatus & { scheduleId: string; title: string; contractId: string; contractHidden: boolean })[];
  /** Fiscal years with plan lines or entries, and the current and next one */
  years: { fiscalYear: number; label: string }[];
  limits: { linesPerYear: number; entriesPerYear: number };
  /**
   * Prepaid payments of earlier fiscal years that cover part of this one (0.18.0): shown quietly, not counted in
   * planned, incurred or expected
   */
  prepaid: {
    lineId: string;
    title: string;
    fiscalYear: number;
    label: string;
    amount: string | null;
    currency: string;
    coversFrom: string;
    coversTo: string;
  }[];
  /** Payment schedules of the service with payments in this year and no lines for it yet (Contract payments to plan) */
  proposals: number;
  /** Contract changed (the current and later fiscal years): per schedule, its lines before and after */
  contractChanges: { scheduleId: string; title: string; changes: CostContractChange[] }[];
  /** What a copy into this year did (only in the answer of the copy) */
  copyResult?: { copied: string[]; proposed: string[]; shortened: string[]; leftOut: string[] };
}

/** The plans of a team's services (and, since 0.19.0, platforms) in one fiscal year (one of two teams counts for both). */
export interface CostPlanTeamYear {
  teamId: string;
  teamName: string;
  fiscalYear: number;
  label: string;
  services: {
    id: string;
    name: string;
    amountsVisible: boolean;
    cloud: CostPlanCloudState;
    /** Also a service of another team */
    shared: boolean;
    currencies: ({ currency: string } & CostPlanFigures)[];
  }[];
  /** The team's platforms with a cost plan in the year (0.19.0, ADR 0032): the same figures */
  platforms: {
    id: string;
    name: string;
    amountsVisible: boolean;
    shared: boolean;
    currencies: ({ currency: string } & CostPlanFigures)[];
  }[];
  /** Per currency over the services and platforms whose amounts the reader sees */
  totals: ({ currency: string } & CostPlanFigures)[];
  years: { fiscalYear: number; label: string }[];
}

/**
 * An application's or system's "Costs and contracts" (0.19.0, ADR 0032 part 1): attribution, not a plan – the services
 * plan and pay. Contracts that name it for a covered service, or that its lines, entries and schedules pay for; the plan
 * lines, entries and payment schedules that name it in the services that use it, each counted once; totals per fiscal
 * year and currency. Only what the reader may see; amounts null where they may not see the service's amounts.
 */
export interface CostAttribution {
  kind: 'application' | 'system';
  id: string;
  name: string;
  fiscalYear: number;
  label: string;
  years: { fiscalYear: number; label: string }[];
  contracts: {
    id: string;
    title: string;
    reference: string;
    supplier: SupplierRef | null;
    endsOn: string | null;
    /** The covered services (the reader sees) for which the contract names it */
    services: { id: string; name: string; purpose: string }[];
    /** Named on the contract for a covered service (else only through a line, entry or schedule) */
    named: boolean;
  }[];
  lines: {
    id: string;
    serviceId: string;
    serviceName: string;
    title: string;
    category: CostPlanCategory;
    cadence: CostPlanCadence;
    currency: string;
    amount: string | null;
    planned: string | null;
    contract: { id: string; title: string } | null;
    contractHidden: boolean;
  }[];
  entries: {
    id: string;
    serviceId: string;
    serviceName: string;
    date: string;
    currency: string;
    amount: string | null;
    reference: string;
    planLineTitle: string | null;
  }[];
  schedules: {
    id: string;
    serviceId: string;
    serviceName: string;
    title: string;
    billing: string;
    currency: string;
    amount: string | null;
    contract: { id: string; title: string } | null;
    contractHidden: boolean;
  }[];
  /** Per fiscal year and currency over what the reader sees with amounts: planned (lines) and incurred (entries) */
  totals: { fiscalYear: number; label: string; currency: string; planned: string; incurred: string }[];
  /** Lines, entries or schedules of services whose amounts the reader may not see are listed without amounts and not totalled */
  amountsHidden: boolean;
}
