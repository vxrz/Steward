import { roundToCurrency } from './costs.js';
import { fiscalYearOf } from './costPlans.js';
import {
  earliestExit,
  hasFixedEnd,
  scheduleEnd,
  scheduleOwed,
  volumePeriods,
  type ContractTerms,
  type CostVolumeWarning,
  type ScheduleOwed,
  type ScheduleSpec,
  type VolumePeriod,
  type VolumeSpec,
} from './costContracts.js';
import { addDays, daysBetween } from './suppliers.js';

/**
 * Volumes of contracts (0.19.0, ADR 0032 part 3, docs/COSTS.md#volumes): what a volume's period has used, what is left,
 * a linear estimate of the use at the period's end and its warnings, what it still owes, and how much of a prepaid
 * volume each cost was drawn from. Pure functions on calendar dates and whole millionths, no time zones – like the
 * schedule arithmetic of costContracts.ts.
 *
 * - The use of a period is the sum of its items dated from its first day up to today (entries naming the contract, or
 *   a paying platform's read costs per day – the caller reads one source, never both).
 * - The estimate is linear: the use per day over the last 90 days up to yesterday (inside the period), times the days
 *   left. It needs 28 days of the period behind it; before that there is no estimate. It is labelled an estimate
 *   everywhere it is shown.
 * - Amounts are rounded to the currency's minor units where they are an outcome (the estimate, the owed minimum).
 */

export const COST_VOLUME_ESTIMATE = {
  /** The window of the rate, in days up to yesterday */
  windowDays: 90,
  /** Fewer days of the period behind: no estimate */
  minDays: 28,
  /** "Well below the committed minimum": a shortfall of at least this share of the minimum */
  shortfallPct: 10,
  /** … and at least this share of the period over */
  shortfallElapsedPct: 25,
  /** Notify "runs out" this many days ahead of the estimated day */
  runsOutNoticeDays: 30,
  /** Notify a shortfall when the period ends within this many days */
  shortfallNoticeDays: 90,
} as const;

/** A dated amount of use (micros): an entry, or a day of read costs. `key` names it for the drawdown. */
export interface VolumeUseItem {
  date: string;
  amount: number;
  key?: string;
}

export interface VolumeEstimate {
  /** Used from the period's first day up to today */
  used: number;
  /** Micros per day in the window (null: no estimate yet) */
  rate: number | null;
  window: { from: string; to: string } | null;
  /** used + rate × the days left, in the currency's minor units (null: no estimate) */
  expectedAtEnd: number | null;
  /** The day the volume would be used up at that rate, when that is inside the period */
  runsOutOn: string | null;
  /** Share of the period's days that are over (0–100) */
  elapsedPct: number;
}

const within = (d: string, from: string, to: string) => d >= from && d <= to;

/** The use of a period up to today and the linear estimate (see the module comment). */
export function volumeEstimate(
  p: Pick<VolumePeriod, 'from' | 'to' | 'amount'>,
  items: readonly VolumeUseItem[],
  today: string,
  currency: string,
): VolumeEstimate {
  const upto = today < p.to ? today : p.to;
  const used = items.reduce((a, x) => (within(x.date, p.from, upto) ? a + x.amount : a), 0);
  const total = daysBetween(p.from, p.to) + 1;
  const elapsed = today < p.from ? 0 : Math.min(total, daysBetween(p.from, upto) + 1);
  const elapsedPct = total > 0 ? Math.round((elapsed / total) * 1000) / 10 : 100;
  const out: VolumeEstimate = { used, rate: null, window: null, expectedAtEnd: null, runsOutOn: null, elapsedPct };
  if (today > p.to) {
    // the period is over: what was used is what it ends with
    out.expectedAtEnd = used;
    return out;
  }
  const end = addDays(today, -1) < p.to ? addDays(today, -1) : p.to;
  if (end < p.from) return out;
  const start = addDays(end, -(COST_VOLUME_ESTIMATE.windowDays - 1)) > p.from ? addDays(end, -(COST_VOLUME_ESTIMATE.windowDays - 1)) : p.from;
  const days = daysBetween(start, end) + 1;
  if (days < COST_VOLUME_ESTIMATE.minDays) return out;
  const inWindow = items.reduce((a, x) => (within(x.date, start, end) ? a + x.amount : a), 0);
  const rate = inWindow / days;
  const left = daysBetween(today, p.to);
  out.rate = rate;
  out.window = { from: start, to: end };
  out.expectedAtEnd = roundToCurrency(Math.round(used + rate * left), currency);
  if (rate > 0 && used < p.amount) {
    const runsOut = addDays(today, Math.ceil((p.amount - used) / rate));
    if (runsOut <= p.to) out.runsOutOn = runsOut;
  }
  return out;
}

/** A volume limits the use (prepaid or fully committed): using more is an overage. Else the volume is a ceiling. */
export const volumeLimitsUse = (v: Pick<VolumeSpec, 'billing' | 'committed'>): boolean => v.billing === 'prepaid' || v.committed === 'full';

/**
 * The warnings of a period: a volume that limits the use – used up, or running out before the period ends (at the
 * estimated rate); a ceiling – passed, or expected to be passed; a committed minimum – expected to end well below it
 * (a shortfall of at least 10 % of the minimum, once a quarter of the period is over – money paid or owed for nothing).
 */
export function volumeWarnings(
  v: Pick<VolumeSpec, 'billing' | 'committed'>,
  p: Pick<VolumePeriod, 'amount' | 'minimum'>,
  e: VolumeEstimate,
): CostVolumeWarning[] {
  const out: CostVolumeWarning[] = [];
  if (volumeLimitsUse(v)) {
    if (e.used >= p.amount && p.amount > 0) out.push('usedUp');
    else if (e.runsOutOn) out.push('runsOut');
  } else if (e.used > p.amount) out.push('overCeiling');
  else if (e.expectedAtEnd !== null && e.expectedAtEnd > p.amount) out.push('ceiling');
  if (
    p.minimum > 0 &&
    e.expectedAtEnd !== null &&
    e.elapsedPct >= COST_VOLUME_ESTIMATE.shortfallElapsedPct &&
    (p.minimum - e.expectedAtEnd) * 100 >= p.minimum * COST_VOLUME_ESTIMATE.shortfallPct
  )
    out.push('shortfall');
  return out;
}

/**
 * The warnings a notice goes out for now (once per schedule, period and kind): used up, over the ceiling and expected
 * over it at once; running out when the estimated day is within 30 days; a shortfall when the period ends within 90.
 */
export function volumeNoticeKinds(warnings: readonly CostVolumeWarning[], p: Pick<VolumePeriod, 'to'>, e: VolumeEstimate, today: string): CostVolumeWarning[] {
  return warnings.filter((w) => {
    if (w === 'runsOut') return !!e.runsOutOn && daysBetween(today, e.runsOutOn) <= COST_VOLUME_ESTIMATE.runsOutNoticeDays;
    if (w === 'shortfall') return daysBetween(today, p.to) <= COST_VOLUME_ESTIMATE.shortfallNoticeDays;
    return true;
  });
}

/** The period a volume shows: the one today falls in, else the next one, else the last one. */
export function currentPeriod(periods: readonly VolumePeriod[], today: string): VolumePeriod | null {
  return periods.find((p) => within(today, p.from, p.to)) ?? periods.find((p) => p.from > today) ?? periods[periods.length - 1] ?? null;
}

/** What a volume schedule still owes, plus `upTo`: what it may still bill at most beyond that (never owed). */
export interface VolumeOwed extends ScheduleOwed {
  upTo: number;
}

/**
 * What a volume still owes as of today (ADR 0032 part 3): prepaid – its payments dated today or later (scheduleOwed);
 * by use – per period not over, the committed minimum not used yet (`usedOf`: the period's use up to today; a period
 * still to come owes its whole minimum), counted in the fiscal year the period ends in. `upTo`: per period the rest of
 * the volume above what is used and owed – a ceiling, shown as "up to …", never added to what is owed.
 */
export function volumeOwed(s: ScheduleSpec, c: ContractTerms, today: string, startMonth: number, usedOf: (p: VolumePeriod) => number): VolumeOwed {
  if (s.volume?.billing === 'prepaid') return { ...scheduleOwed(s, c, today, startMonth), upTo: 0 };
  const end = scheduleEnd(s, c);
  const exit = earliestExit(c, today);
  const min = (...ds: (string | null)[]) => ds.filter((d): d is string => !!d).sort()[0] ?? null;
  const contractEnd = min(s.endsOn ?? (hasFixedEnd(c) ? c.endsOn : exit), end);
  const exitEnd = min(exit, end);
  const years = new Map<number, { toContractEnd: number; toEarliestExit: number }>();
  let toContractEnd = 0;
  let toEarliestExit = 0;
  let upTo = 0;
  for (const p of volumePeriods(s, c)) {
    if (p.to < today) continue;
    const used = p.from > today ? 0 : usedOf(p);
    const owed = Math.max(0, p.minimum - used);
    const room = Math.max(0, p.amount - Math.max(used, p.minimum));
    const fy = fiscalYearOf(p.to, startMonth);
    const y = years.get(fy) ?? { toContractEnd: 0, toEarliestExit: 0 };
    if (contractEnd && p.from <= contractEnd) {
      toContractEnd += owed;
      y.toContractEnd += owed;
      upTo += room;
    }
    if (exitEnd && p.from <= exitEnd) {
      toEarliestExit += owed;
      y.toEarliestExit += owed;
    }
    years.set(fy, y);
  }
  return {
    toContractEnd,
    toEarliestExit,
    contractEnd,
    earliestExit: exitEnd,
    nextPayment: null,
    upTo,
    byFiscalYear: [...years.entries()]
      .filter(([, v]) => v.toContractEnd || v.toEarliestExit)
      .sort(([a], [b]) => a - b)
      .map(([fiscalYear, v]) => ({ fiscalYear, ...v })),
  };
}

/**
 * How much of each cost a prepaid volume covers (ADR 0032 part 3): per period, the items dated in it in date order
 * (then by key) take from the volume until it is used up; what is past it is an overage, a cost of its own. Credits
 * (negative items) are not drawn. Returns the part of each item (by key) drawn from a prepaid volume – the cost plan
 * does not count that part as incurred again: the money left with the payment.
 */
export function prepaidDrawdown(periods: readonly Pick<VolumePeriod, 'from' | 'to' | 'amount'>[], items: readonly VolumeUseItem[]): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = items
    .filter((x) => x.key !== undefined && x.amount > 0)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key! < b.key! ? -1 : a.key! > b.key! ? 1 : 0));
  for (const p of periods) {
    let left = p.amount;
    for (const x of sorted) {
      if (left <= 0) break;
      if (!within(x.date, p.from, p.to)) continue;
      const d = Math.min(x.amount, left);
      left -= d;
      out.set(x.key!, (out.get(x.key!) ?? 0) + d);
    }
  }
  return out;
}
