import { z, type ZodType } from 'zod';
import { COST_SCOPES, fromMicros } from '@sm/shared';
import { db } from '../db.js';
import { coverOf, coverWhere, scopeInfo, visibleScopes } from './access.js';
import { budgetOf } from './query.js';
import { defineReportSection } from '../reports/sections.js';
import { en, costsSectionDraw, type Row, type CostSectionData } from './report-section-draw.js';

/**
 * "Costs" section of scheduled summary reports (#226, docs/COSTS.md#dashboards-and-the-api): per service, application, team or
 * platform the costs of the report period against the period before (a monthly schedule: the last month against the
 * month before), per currency, with the budget's state. Collected with the rights of the schedule's owner: scopes they
 * may not see are neither named nor counted; amounts they may not see are left out (only the change in percent).
 */

const MAX_ROWS = 200;

const schema = z.object({
  /** What the rows are */
  scope: z.enum(COST_SCOPES).default('service'),
  /** Only these (ids); null: every one the owner may see */
  ids: z.array(z.string().min(1).max(100)).max(200).nullable().default(null),
});

type CostConfig = z.infer<typeof schema>;

const iso = (t: number) => new Date(t).toISOString();

function sumsIn(where: { sql: string; params: unknown[] }, from: number, to: number, unassignedOnly = false): Map<string, number> {
  return new Map(
    db()
      .all<{ c: string; e: number }>(
        `SELECT billing_currency AS c, SUM(effective_cost) AS e FROM cost_records WHERE ${where.sql}${unassignedOnly ? ' AND application_id IS NULL' : ''}
           AND charge_period_start >= ? AND charge_period_start < ? GROUP BY billing_currency`,
        ...where.params,
        iso(from),
        iso(to),
      )
      .map((r) => [r.c, Number(r.e)]),
  );
}

function build(c: CostConfig, ctx: { from: number; to: number; now: number }): CostSectionData {
  const span = ctx.to - ctx.from;
  const scopes = visibleScopes(c.scope).filter((s) => !c.ids || c.ids.includes(s.id));
  const rows: Row[] = [];
  const totals = new Map<string, { p: number; b: number }>();
  for (const s of scopes) {
    const where = coverWhere(coverOf(c.scope, s.id));
    if (!where) continue;
    const now = sumsIn(where, ctx.from, ctx.to);
    const before = sumsIn(where, ctx.from - span, ctx.from);
    const un = c.scope === 'platform' ? sumsIn(where, ctx.from, ctx.to, true) : new Map<string, number>();
    // a reader who does not see every application of the scope gets the budget's state only
    const budget = c.scope === 'platform' ? null : budgetOf(c.scope, s.id, s.amounts, ctx.to - 1);
    for (const currency of [...new Set([...now.keys(), ...before.keys()])].sort()) {
      const p = now.get(currency) ?? 0;
      const b = before.get(currency) ?? 0;
      const show = (n: number) => (s.amounts ? fromMicros(Math.round(n / 10_000) * 10_000) : null);
      rows.push({
        name: s.name,
        currency,
        amounts: s.amounts,
        period: show(p),
        before: show(b),
        changePct: b > 0 ? Math.round(((p - b) / b) * 1000) / 10 : null,
        unassigned: c.scope === 'platform' ? show(un.get(currency) ?? 0) : null,
        budget: budget && budget.currency === currency ? { amount: budget.amount, pct: budget.pct, state: budget.state } : null,
      });
      if (c.scope === 'platform' && s.amounts) {
        const t = totals.get(currency) ?? { p: 0, b: 0 };
        t.p += p;
        t.b += b;
        totals.set(currency, t);
      }
    }
  }
  rows.sort((a, b) => Number(b.period ?? 0) - Number(a.period ?? 0) || a.name.localeCompare(b.name));
  return {
    scope: c.scope,
    rows: rows.slice(0, MAX_ROWS),
    totals: [...totals.entries()].map(([currency, t]) => ({
      currency,
      period: fromMicros(Math.round(t.p / 10_000) * 10_000),
      before: fromMicros(Math.round(t.b / 10_000) * 10_000),
    })),
  };
}

export const costsSection = defineReportSection<CostConfig, CostSectionData>({
  ...costsSectionDraw,
  schema: schema as unknown as ZodType<CostConfig>,
  validate: (c) => {
    if (!c.ids) return;
    // a scope the owner may not see reads like a missing one
    const missing = c.ids.filter((id) => !scopeInfo(c.scope, id));
    if (missing.length) throw Object.assign(new Error(`${en.scope[c.scope]}(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  build,
});
