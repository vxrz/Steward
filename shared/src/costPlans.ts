import { z } from 'zod';
import { currencyCode, toMicros } from './costs.js';

/**
 * Service cost planning (0.16.0, ADR 0026, docs/COSTS.md#planning-per-service): what a service plans to spend on the
 * systems and solutions it uses and on support, per fiscal year, and what it incurred – lightweight, internal to the
 * service. No person-hours, no approvals, orders or invoice processing, no chargeback and no currency conversion.
 *
 * - One fiscal year start for the whole instance (`fiscalYearStartMonth` of the cost settings, 1–12, default 1). A
 *   fiscal year is named by the calendar year it starts in: "FY 2026" (start January), "FY 2026/27" (start October).
 * - Plan lines per service and fiscal year: a title, a category, what it is for (an application or system of the
 *   service, or a platform; else free text), an amount in a currency with a cadence (yearly spread evenly over the
 *   12 months, monthly, once in one month), an optional renewal date and a note.
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

/** yearly: the amount is the year's, spread evenly over its 12 months; monthly: the amount every month; once: in one month. */
export const COST_PLAN_CADENCES = ['yearly', 'monthly', 'once'] as const;
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
 * Whole millionths per month of a plan line in its fiscal year (12 values). A yearly amount is spread evenly: the
 * months get the year's amount in twelfths, rounded so that they add up to it exactly.
 */
export function planMonths(amountMicros: number, cadence: CostPlanCadence, onceIndex: number | null): number[] {
  if (cadence === 'monthly') return Array.from({ length: 12 }, () => amountMicros);
  if (cadence === 'once') return Array.from({ length: 12 }, (_, i) => (i === onceIndex ? amountMicros : 0));
  return Array.from({ length: 12 }, (_, i) => Math.floor((amountMicros * (i + 1)) / 12) - Math.floor((amountMicros * i) / 12));
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
  /** Free text: the vendor or the contract */
  vendor: z.string().trim().max(COST_PLAN_LIMITS.vendorChars).default(''),
  /** The amount (decimal) – a year's for "yearly", a month's for "monthly", the one payment for "once" */
  amount: z
    .string()
    .trim()
    .max(32)
    .refine((v) => toMicros(v) !== null && toMicros(v)! > 0, 'an amount above 0, like 1500 or 1500.50'),
  currency: currencyCode,
  cadence: z.enum(COST_PLAN_CADENCES),
  /** "once": the month (YYYY-MM) in the fiscal year */
  onceMonth: monthText.nullable().default(null),
  /** Contract end or renewal (YYYY-MM-DD) */
  renewalDate: dateText.nullable().default(null),
  note: z.string().trim().max(COST_PLAN_LIMITS.noteChars).default(''),
};

const onceNeedsMonth = (x: { cadence: CostPlanCadence; onceMonth: string | null }, ctx: z.RefinementCtx) => {
  if (x.cadence === 'once' && !x.onceMonth) ctx.addIssue({ code: 'custom', path: ['onceMonth'], message: 'the month of the payment' });
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

export const costPlanCopyInput = z
  .object({
    fromYear: z
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
    currency: currencyCode,
    /** The plan line (same service, fiscal year and currency); none: unplanned */
    planLineId: z.string().trim().min(1).max(100).nullable().default(null),
    target,
    /** Invoice or order number */
    reference: z.string().trim().max(COST_PLAN_LIMITS.referenceChars).default(''),
    note: z.string().trim().max(COST_PLAN_LIMITS.noteChars).default(''),
  })
  .strict();
export type CostEntryInput = z.input<typeof costEntryInput>;

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
  /** As entered (null when the reader may not see amounts) */
  amount: string | null;
  currency: string;
  cadence: CostPlanCadence;
  onceMonth: string | null;
  renewalDate: string | null;
  note: string;
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
  reference: string;
  note: string;
  /** No plan line of this fiscal year */
  unplanned: boolean;
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
  /** Applications and systems of the service (for the forms; only those the reader may see) */
  targets: { kind: 'application' | 'system'; id: string; name: string }[];
  /** Fiscal years with plan lines or entries, and the current and next one */
  years: { fiscalYear: number; label: string }[];
  limits: { linesPerYear: number; entriesPerYear: number };
}

/** The plans of a team's services in one fiscal year (a service of two teams counts for both). */
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
  /** Per currency over the services whose amounts the reader sees */
  totals: ({ currency: string } & CostPlanFigures)[];
  years: { fiscalYear: number; label: string }[];
}
