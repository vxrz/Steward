import type { DataProductListFacts } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { productAccess } from './access.js';
import { lastMonths, productCostsOf } from './costs.js';
import { scorecardsOf } from './scorecard.js';
import { productsByIds } from './store.js';

/**
 * The product list's facts beside a page of products (ADR 0036 part 13: maturity, costs last month where visible), in
 * bulk: the scorecards and the attributed costs of the whole page are read once each (scorecardsOf, productCostsOf –
 * one statement per kind of fact and chunk), never per row. Products `u` may not see are left out, in the order asked.
 * Costs follow the cost rules: a part `u` may not see marks the month incomplete and is not in the total.
 */
export function listFacts(u: AuthUser | null, ids: readonly string[], environment?: string, now = Date.now()): DataProductListFacts[] {
  const rows = productsByIds(ids);
  const visible = ids.filter((id) => {
    const p = rows.get(id);
    return !!p && productAccess(u, p).permissions.includes('view');
  });
  if (!visible.length) return [];
  const cards = scorecardsOf(u, visible, environment, now);
  // the last full month
  const month = lastMonths(2, now)[0]!;
  const costs = productCostsOf(u, visible, [month]);
  return visible.map((id) => {
    const card = cards.get(id);
    const env = card?.environment ?? null;
    const c = env ? costs.get(id)?.get(env)?.get(month) : undefined;
    return {
      productId: id,
      environment: env,
      maturity: card?.maturity ?? 0,
      lastMonth: c && (c.totals.length || c.incomplete) ? { month, totals: c.totals, incomplete: c.incomplete } : null,
    };
  });
}
