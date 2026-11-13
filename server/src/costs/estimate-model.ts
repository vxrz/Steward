import { fiscalYearMonths, formatMicros, planMonths, roundToCurrency, fromMicrosIn, type CostPlanProposalLine, type CostPriceCharge } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import type { StoredResult } from './pricing.js';

/**
 * Plan lines from estimates (0.21.0, ADR 0035 part 6, decision 13) – the pure part, read by the cost plan without
 * pulling in the pricing: what an estimate proposes for a fiscal year, and whether a plan line made from it still says
 * what the estimate says (Estimate changed).
 *
 * - Usage and recurring amounts (the expected scenario) become a monthly line per calculator group from the estimate's
 *   start month; where a price changes inside the year (the 36-month projection), one line per stretch of equal
 *   months. One-off amounts become a once line in the start month (per group).
 * - Who cannot see a book the estimate used is proposed the list price of its lines (or nothing for a line without one),
 *   as the estimate shows them (part 8); the basis records which view the line was made from.
 */

export interface ProposalPart extends CostPlanProposalLine {
  /** Millionths per month (monthly) or once, rounded to the currency's minor units */
  micros: number;
  /** The twelve month amounts of the line (the basis) */
  months: number[];
  fromIndex: number;
  toIndex: number;
}

export interface EstimateBasis {
  key: string;
  months: number[];
  /** Made from list prices (the maker could not see a book) */
  list: boolean;
}

/** Amount (expected) of a stored line for a view: its own, or at list price when `canSee` says no. */
function shownExpected(l: StoredResult['lines'][number], canSee: (bookId: string) => boolean): { v: number | null; hidden: boolean } {
  if (!l.a) return { v: null, hidden: false };
  if (l.book && !canSee(l.book.id)) return { v: l.l ? l.l.a[1] : null, hidden: true };
  return { v: l.a[1], hidden: false };
}

/** The proposal of an estimate for a fiscal year (`startMonth`: the instance's first month of a fiscal year). */
export function proposalsOf(
  r: StoredResult,
  title: string,
  fiscalYear: number,
  startMonth: number,
  canSee: (bookId: string) => boolean,
): { lines: ProposalPart[]; hidden: boolean } {
  const months = fiscalYearMonths(fiscalYear, startMonth);
  const first = months.findIndex((m) => m >= r.appliesFrom);
  if (first < 0) return { lines: [], hidden: false };
  let hidden = false;
  const groups: string[] = [];
  const monthly = new Map<string, number>();
  const once = new Map<string, number>();
  for (const l of r.lines) {
    const s = shownExpected(l, canSee);
    if (s.hidden) hidden = true;
    if (s.v === null) continue;
    if (!groups.includes(l.group)) groups.push(l.group);
    const m = (l.charge as CostPriceCharge) === 'oneOff' ? once : monthly;
    m.set(l.group, (m.get(l.group) ?? 0) + s.v);
  }
  // the projection follows the prices of the books used – only for a view that sees them all
  const projected = !hidden && r.months ? new Map(r.months.map((m) => [m.month, new Map(m.g)])) : null;
  const out: ProposalPart[] = [];
  const name = (g: string) => (g ? `${title} – ${g}`.slice(0, 200) : title.slice(0, 200));
  groups.forEach((g, gi) => {
    // the month amounts of the group, from the start month on
    const series = months.map((m, i) => {
      if (i < first) return 0;
      const p = projected?.get(m);
      const v = p ? (p.get(g) ?? 0) : (monthly.get(g) ?? 0);
      return roundToCurrency(v, r.currency);
    });
    let seg = 0;
    for (let i = first; i < 12;) {
      let j = i;
      while (j + 1 < 12 && series[j + 1] === series[i]) j++;
      if (series[i] !== 0) {
        const fromIndex = i;
        const toIndex = j;
        const micros = series[i]!;
        out.push({
          key: `m:${gi}:${seg}`,
          title: seg ? `${name(g)} (${months[i]})`.slice(0, 200) : name(g),
          cadence: 'monthly',
          amount: fromMicrosIn(micros, r.currency),
          fromMonth: months[fromIndex]!,
          toMonth: months[toIndex]!,
          group: g,
          micros,
          months: planMonths(micros, 'monthly', null, { from: fromIndex === 0 ? null : fromIndex, to: toIndex === 11 ? null : toIndex, currency: r.currency }),
          fromIndex,
          toIndex,
        });
        seg++;
      }
      i = j + 1;
    }
    const o = roundToCurrency(once.get(g) ?? 0, r.currency);
    if (o !== 0)
      out.push({
        key: `o:${gi}`,
        title: `${name(g)} – one-off`.slice(0, 200),
        cadence: 'once',
        amount: fromMicrosIn(o, r.currency),
        fromMonth: months[first]!,
        toMonth: months[first]!,
        group: g,
        micros: o,
        months: planMonths(o, 'once', first),
        fromIndex: first,
        toIndex: first,
      });
  });
  return { lines: out, hidden };
}

/** A view that sees list books only (for a basis made from list prices). */
export const listOnly =
  (r: StoredResult) =>
  (bookId: string): boolean =>
    r.books.find((b) => b.id === bookId)?.kind === 'list';

/**
 * Whether plan lines made from estimates still match them (Estimate changed): one statement for the estimates of all
 * lines given, the proposals computed in memory.
 */
export function estimateLineStates(
  lines: readonly { id: string; fiscal_year: number; estimate_id?: string | null; estimate_basis?: string | null }[],
  startMonth: number,
): Map<string, { id: string; title: string; changed: boolean }> {
  const out = new Map<string, { id: string; title: string; changed: boolean }>();
  const ids = [...new Set(lines.map((l) => l.estimate_id).filter((x): x is string => !!x))];
  if (!ids.length) return out;
  const rows = new Map<string, { id: string; title: string; result: string | null }>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db().all<{ id: string; title: string; result: string | null }>(
      `SELECT id, title, result FROM cost_estimates WHERE id IN (${part.map(() => '?').join(', ')})`,
      ...part,
    ))
      rows.set(r.id, r);
  }
  const cache = new Map<string, ProposalPart[]>();
  for (const l of lines) {
    if (!l.estimate_id) continue;
    const e = rows.get(l.estimate_id);
    if (!e) continue;
    const basis = parseJson<EstimateBasis | null>(l.estimate_basis ?? null, null);
    const stored = parseJson<StoredResult | null>(e.result, null);
    let changed = false;
    if (basis && stored) {
      const ck = `${e.id}|${l.fiscal_year}|${basis.list}`;
      let props = cache.get(ck);
      if (!props) {
        props = proposalsOf(stored, e.title, Number(l.fiscal_year), startMonth, basis.list ? listOnly(stored) : () => true).lines;
        cache.set(ck, props);
      }
      const now = props.find((p) => p.key === basis.key);
      changed = !now || now.months.join(',') !== basis.months.join(',');
    }
    out.set(l.id, { id: e.id, title: e.title, changed });
  }
  return out;
}

/** "1,234.50 EUR" for audit texts. */
export const microsText = (micros: number, currency: string): string => `${formatMicros(BigInt(micros))} ${currency}`;
