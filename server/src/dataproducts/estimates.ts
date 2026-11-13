import { toMicros, type DataProductEstimates } from '@sm/shared';
import { db } from '../db.js';
import { moduleEnabled } from '../modules/registry.js';
import { estimatesFor } from '../costs/estimates.js';
import { lastMonths, productCosts } from './costs.js';
import { visibleProduct } from './service.js';

/**
 * Estimated against attributed (ADR 0036 part 11, ADR 0035 part 6, phase 2): the estimates _for_ a data product – each
 * belongs to a service or a platform, as cost plans, and names the product as what it is for – beside the costs
 * attributed to the product, per month and currency. Showback only: nothing is netted, booked or planned here.
 *
 * - Estimates are listed as their owner's plan rights allow (who may read the owner's cost plan reads the estimate,
 *   amounts by the Costs module's rule); one the reader may not see is neither listed nor counted.
 * - A month's estimate is the sum of the expected monthly amount (and low and high) of the estimates of that currency
 *   that apply from that month on; an estimate shown at list prices to the reader marks the month (`atListPrice`).
 * - The attributed side is the Costs tab's (hidden parts make it incomplete, never a figure to subtract from).
 */
export function productEstimates(productId: string, q: { environment?: string; months: number }, now = Date.now()): DataProductEstimates {
  const { row } = visibleProduct(productId);
  const costs = productCosts(row.id, q, now);
  const available = moduleEnabled('costs');
  const estimates = available ? estimatesFor('dataProduct', row.id) : [];
  const comparison: DataProductEstimates['comparison'] = [];
  for (const m of costs.months) {
    const currencies = new Set([...m.totals.map((t) => t.currency), ...estimates.filter((e) => e.appliesFrom <= m.month).map((e) => e.currency)]);
    for (const currency of [...currencies].sort()) {
      const applying = estimates.filter((e) => e.currency === currency && e.appliesFrom <= m.month && e.monthly);
      const sum = (k: 'low' | 'expected' | 'high') => applying.reduce((n, e) => n + (toMicros(e.monthly![k]) ?? 0), 0);
      comparison.push({
        month: m.month,
        currency,
        attributedMicros: m.totals.find((t) => t.currency === currency)?.amountMicros ?? 0,
        incomplete: m.incomplete,
        estimated: applying.length ? { low: sum('low'), expected: sum('expected'), high: sum('high') } : null,
        atListPrice: applying.some((e) => e.atListPrice),
      });
    }
  }
  return { productId: row.id, environment: costs.environment, available, estimates, comparison };
}

/**
 * A data product to compare a dry run with (MCP `calculate_cost_estimate` with `compareWith`): its attributed costs of
 * the last complete months as the reader may see them, their monthly average per currency (incomplete where a part is
 * hidden), and its estimates' expected monthly amounts – so an assistant sets an architecture's price range beside
 * what a similar product costs. A product the reader may not see answers like a missing one.
 */
export function productComparison(
  idOrKey: string,
  q: { environment?: string; months: number },
  variants: { name: string; currency: string; monthly: { low: string; expected: string; high: string } }[],
  now = Date.now(),
) {
  const id = db().get<{ id: string }>('SELECT id FROM dp_products WHERE id = ? OR key = ?', idOrKey, idOrKey.toLowerCase())?.id ?? idOrKey;
  const { row } = visibleProduct(id);
  // the complete months only: the current one is still being read
  const e = productEstimates(row.id, { environment: q.environment, months: q.months + 1 }, now);
  const months = lastMonths(q.months + 1, now).slice(0, -1);
  const rows = e.comparison.filter((x) => months.includes(x.month));
  const currencies = [...new Set(rows.map((x) => x.currency))].sort();
  const amount = (micros: number) => (micros / 1e6).toFixed(2);
  const average = currencies.map((currency) => {
    const of = rows.filter((x) => x.currency === currency);
    const sum = of.reduce((n, x) => n + x.attributedMicros, 0);
    return { currency, monthly: amount(Math.round(sum / Math.max(1, months.length))), incomplete: of.some((x) => x.incomplete) };
  });
  return {
    product: { id: row.id, key: row.key, name: row.name },
    environment: e.environment,
    months: months.map((m) => ({
      month: m,
      attributed: rows.filter((x) => x.month === m).map((x) => ({ currency: x.currency, amount: amount(x.attributedMicros), incomplete: x.incomplete })),
    })),
    attributedMonthlyAverage: average,
    estimates: e.estimates.slice(0, 20).map((x) => ({ title: x.title, currency: x.currency, appliesFrom: x.appliesFrom, monthly: x.monthly })),
    // each variant's expected monthly amount against the product's average in the same currency (null: no costs in it)
    variants: variants.map((v) => {
      const avg = average.find((a) => a.currency === v.currency);
      const exp = toMicros(v.monthly.expected) ?? 0;
      return {
        name: v.name,
        currency: v.currency,
        expectedMonthly: v.monthly.expected,
        productMonthly: avg?.monthly ?? null,
        difference: avg ? amount(exp - (toMicros(avg.monthly) ?? 0)) : null,
        incomplete: avg?.incomplete ?? false,
      };
    }),
    note: 'Attributed costs are a showback of the bills Steward reads (never a budget); an incomplete average leaves out parts you may not see.',
  };
}
