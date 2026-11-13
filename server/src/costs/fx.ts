import { COST_PRICE_LIMITS, costFxRateInput, formatPrice, parsePrice, PRICE_SCALE, roundDiv, type CostFxRate } from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser } from '../auth/context.js';
import { HttpError, nowIso } from '../util.js';
import { isCostsManager, usesCosts } from './price-books.js';

/**
 * Exchange rates for estimates (0.21.0, ADR 0035 part 3, decision 10): manual rates of a date, set by the costs managers.
 * Only estimates convert – the cost model, plans, commitments and volumes stay per currency. A conversion uses the rate
 * of the latest date on or before the calculation (direct, else the inverse of the opposite rate); the rate, its date
 * and its source are stored on the estimate and shown on every converted line. ECB reference rates come in phase 2.
 */

interface RateRow {
  rate_date: string;
  base: string;
  quote: string;
  rate: string;
  source: 'manual';
  set_at: string;
  set_by: string;
}

const toRate = (r: RateRow): CostFxRate => ({ date: r.rate_date, base: r.base, quote: r.quote, rate: r.rate, source: r.source, setAt: r.set_at, setBy: r.set_by });

export function listRates(): CostFxRate[] {
  if (!usesCosts(currentUser())) return [];
  return db()
    .all<RateRow>('SELECT * FROM cost_fx_rates ORDER BY rate_date DESC, base, quote LIMIT ?', COST_PRICE_LIMITS.fxRates)
    .map(toRate);
}

const requireManager = () => {
  if (!isCostsManager(currentUser())) throw new HttpError(403, 'Only the costs managers set exchange rates', 'FORBIDDEN', { context: 'fxRates' });
};

export function setRate(body: unknown): CostFxRate {
  requireManager();
  const x = costFxRateInput.parse(body);
  const rate = formatPrice(parsePrice(x.rate)!);
  const before = db().get<RateRow>("SELECT * FROM cost_fx_rates WHERE rate_date = ? AND base = ? AND quote = ? AND source = 'manual'", x.date, x.base, x.quote);
  const count = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_fx_rates')?.n ?? 0);
  if (!before && count >= COST_PRICE_LIMITS.fxRates)
    throw new HttpError(409, `Steward keeps at most ${COST_PRICE_LIMITS.fxRates} exchange rates – remove old ones first`, 'COST_FX_RATE_LIMIT', {
      max: COST_PRICE_LIMITS.fxRates,
    });
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO cost_fx_rates (rate_date, base, quote, rate, source, set_at, set_by) VALUES (?, ?, ?, ?, 'manual', ?, ?)
       ON CONFLICT (rate_date, base, quote, source) DO UPDATE SET rate = excluded.rate, set_at = excluded.set_at, set_by = excluded.set_by`,
      x.date,
      x.base,
      x.quote,
      rate,
      now,
      currentActor(),
    );
    audit({
      action: 'cost.fx_rate_set',
      entityType: 'settings',
      entityId: 'costs.fx',
      summary: `Exchange rate of ${x.date}: 1 ${x.base} = ${rate} ${x.quote} (manual)`,
      details: { date: x.date, base: x.base, quote: x.quote, before: before?.rate ?? null, after: rate },
    });
  });
  return toRate(db().get<RateRow>("SELECT * FROM cost_fx_rates WHERE rate_date = ? AND base = ? AND quote = ? AND source = 'manual'", x.date, x.base, x.quote)!);
}

export const fxRateKey = z
  .object({
    date: z.string().trim().max(10),
    base: z.string().trim().length(3),
    quote: z.string().trim().length(3),
  })
  .strict();

export function removeRate(q: unknown): void {
  requireManager();
  const x = fxRateKey.parse(q);
  const before = db().get<RateRow>("SELECT * FROM cost_fx_rates WHERE rate_date = ? AND base = ? AND quote = ? AND source = 'manual'", x.date, x.base, x.quote);
  if (!before) throw new HttpError(404, 'Exchange rate not found', 'COST_FX_RATE_MISSING', { from: x.base, to: x.quote });
  db().tx(() => {
    db().run("DELETE FROM cost_fx_rates WHERE rate_date = ? AND base = ? AND quote = ? AND source = 'manual'", x.date, x.base, x.quote);
    audit({
      action: 'cost.fx_rate_set',
      entityType: 'settings',
      entityId: 'costs.fx',
      summary: `Exchange rate of ${x.date} for ${x.base}/${x.quote} removed`,
      details: { date: x.date, base: x.base, quote: x.quote, before: before.rate, after: null },
    });
  });
}

export interface FxUse {
  from: string;
  to: string;
  /** 10^-12 */
  rate: bigint;
  date: string;
}

/**
 * The rates of a calculation, read once: the latest rate on or before `day` of each pair (direct, else the inverse of
 * the opposite pair). Answers null when there is none (COST_FX_RATE_MISSING is the caller's).
 */
export class FxTable {
  private rows: RateRow[];
  private cache = new Map<string, FxUse | null>();
  constructor(private day: string) {
    this.rows = db().all<RateRow>('SELECT * FROM cost_fx_rates WHERE rate_date <= ? ORDER BY rate_date DESC', day);
  }
  rate(from: string, to: string): FxUse | null {
    const k = `${from}>${to}`;
    if (this.cache.has(k)) return this.cache.get(k)!;
    let out: FxUse | null = null;
    const direct = this.rows.find((r) => r.base === from && r.quote === to);
    const inverse = this.rows.find((r) => r.base === to && r.quote === from);
    const pick = direct && (!inverse || direct.rate_date >= inverse.rate_date) ? direct : inverse;
    if (pick) {
      const r = parsePrice(pick.rate)!;
      out = { from, to, date: pick.rate_date, rate: pick === direct ? r : roundDiv(PRICE_SCALE * PRICE_SCALE, r) };
    }
    this.cache.set(k, out);
    return out;
  }
  get day0(): string {
    return this.day;
  }
}
