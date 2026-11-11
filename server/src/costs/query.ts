import {
  COST_BUDGET_WARN_PCT,
  COST_LIMITS,
  fromMicros,
  trendOf,
  type CostBudget,
  type CostBudgetScope,
  type CostCurrencySummary,
  type CostOverview,
  type CostOverviewRow,
  type CostScope,
  type CostScopeDetail,
  type CostSource,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { capabilities } from '../auth/permissions.js';
import {
  costSettings,
  coverOf,
  coverWhere,
  requireScope,
  scopeInfo,
  seesWholeScope,
  serviceCovers,
  visibleScopes,
  type ScopeCover,
  type ScopeInfo,
} from './access.js';

/**
 * Reading the cost model (#226): per scope the last 12 complete months and the current month so far, per currency
 * (no conversion), the forecast of the current month, the trend (#145, Theil–Sen through the complete months) and the
 * budget. Months are calendar months in UTC; EffectiveCost is what is shown (BilledCost is kept next to it).
 */

const DAY = 86_400_000;

export function monthOf(t: number): string {
  return new Date(t).toISOString().slice(0, 7);
}
export function addMonths(month: string, n: number): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}
const monthStartMs = (month: string) => Date.parse(`${month}-01T00:00:00Z`);
const daysIn = (month: string) => (monthStartMs(addMonths(month, 1)) - monthStartMs(month)) / DAY;

/** The 12 complete months before `month` and `month` itself, oldest first. */
export function monthWindow(month: string): string[] {
  return Array.from({ length: COST_LIMITS.months + 1 }, (_, i) => addMonths(month, i - COST_LIMITS.months));
}

interface Sum {
  e: number;
  b: number;
  end: string | null;
}

/** Sums of a scope per currency and month (from `fromMonth` on). */
function sums(where: { sql: string; params: unknown[] } | false, fromMonth: string): Map<string, Map<string, Sum>> {
  const out = new Map<string, Map<string, Sum>>();
  if (!where) return out;
  for (const r of db().all<{ month: string; billing_currency: string; e: number | null; b: number | null; e_end: string | null }>(
    `SELECT month, billing_currency, SUM(effective_cost) AS e, SUM(billed_cost) AS b, MAX(charge_period_end) AS e_end FROM cost_records
      WHERE ${where.sql} AND month >= ? GROUP BY month, billing_currency`,
    ...where.params,
    fromMonth,
  )) {
    const m = out.get(r.billing_currency) ?? new Map<string, Sum>();
    m.set(r.month, { e: Number(r.e ?? 0), b: Number(r.b ?? 0), end: r.e_end });
    out.set(r.billing_currency, m);
  }
  return out;
}

/**
 * The current month projected from its days so far: so far ÷ days covered × days of the month. Days covered end at
 * the newest charge period of the month (or now). Null in the first two days of a month or without lines.
 */
export function forecastOf(soFar: number | null, newestEnd: string | null, month: string, now: number): number | null {
  if (soFar === null || !newestEnd) return null;
  const start = monthStartMs(month);
  if (now - start < 2 * DAY) return null;
  const covered = (Math.min(Date.parse(newestEnd), now, monthStartMs(addMonths(month, 1))) - start) / DAY;
  if (covered < 1) return null;
  return Math.round((soFar / covered) * daysIn(month));
}

/**
 * The forecast of the current month, per currency, as the sum of each platform's own projection: sources lag behind
 * by different times (Cost Explorer a day, Confluent's Costs API three), so each platform's days so far count for it.
 */
export function forecastFromGroups(
  groups: { plat: string; currency: string; e: number; end: string | null }[],
  month: string,
  now: number,
): Map<string, number | null> {
  const per = new Map<string, { currency: string; e: number; end: string | null }>();
  for (const g of groups) {
    const k = `${g.currency}|${g.plat}`;
    const x = per.get(k) ?? { currency: g.currency, e: 0, end: null };
    x.e += g.e;
    if (!x.end || (g.end && g.end > x.end)) x.end = g.end;
    per.set(k, x);
  }
  const out = new Map<string, number | null>();
  for (const x of per.values()) {
    const f = forecastOf(x.e, x.end, month, now);
    const was = out.get(x.currency);
    out.set(x.currency, f === null || was === null ? null : (was ?? 0) + f);
  }
  return out;
}

function monthForecast(where: { sql: string; params: unknown[] } | false, month: string, now: number): Map<string, number | null> {
  if (!where) return new Map();
  const rows = db().all<{ plat: string; currency: string; e: number; last_end: string | null }>(
    `SELECT platform_id AS plat, billing_currency AS currency, SUM(effective_cost) AS e, MAX(charge_period_end) AS last_end FROM cost_records
      WHERE ${where.sql} AND month = ? GROUP BY platform_id, billing_currency`,
    ...where.params,
    month,
  );
  return forecastFromGroups(
    rows.map((r) => ({ plat: r.plat, currency: r.currency, e: Number(r.e), end: r.last_end })),
    month,
    now,
  );
}

const pct = (a: number, b: number): number | null => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);

function currencySummary(
  currency: string,
  m: Map<string, Sum>,
  month: string,
  now: number,
  amounts: boolean,
  fc: Map<string, number | null>,
): CostCurrencySummary {
  const window = monthWindow(month);
  const show = (n: number | null) => (n === null || !amounts ? null : fromMicros(n));
  const cur = m.get(month);
  const prev = m.get(addMonths(month, -1));
  const forecast = cur ? (fc.get(currency) ?? null) : null;
  // the trend: complete months from the first one with costs
  const complete = window.slice(0, -1);
  const firstWith = complete.findIndex((x) => m.has(x));
  const points = firstWith < 0 ? [] : complete.slice(firstWith).map((x) => ({ ts: `${x}-01T00:00:00.000Z`, value: (m.get(x)?.e ?? 0) / 1_000_000 }));
  const t = points.length >= 5 ? trendOf(points, '400d', monthStartMs(month)) : null;
  const mean = points.length ? points.reduce((n, p) => n + p.value, 0) / points.length : 0;
  const perMonth = t ? t.perDay * (365.25 / 12) : null;
  return {
    currency,
    months: window.map((x) => {
      const s = m.get(x);
      return { month: x, amount: s && amounts ? fromMicros(s.e) : null, billed: s && amounts ? fromMicros(s.b) : null };
    }),
    thisMonth: show(cur?.e ?? null),
    lastMonth: show(prev?.e ?? null),
    forecast: show(forecast),
    changePct: forecast !== null && prev ? pct(forecast, prev.e) : null,
    trend:
      t && perMonth !== null
        ? {
            perMonth: amounts ? fromMicros(Math.round(perMonth * 1_000_000)) : null,
            changePctPerMonth: mean > 0 ? Math.round((perMonth / mean) * 1000) / 10 : null,
            confidence: t.confidence,
            months: points.length,
          }
        : null,
  };
}

// ---------- budgets (read side; budgets.ts changes them) ----------

export interface BudgetRow {
  scope: CostBudgetScope;
  scope_id: string;
  amount: number;
  currency: string;
  comment: string;
  updated_at: string;
  updated_by: string;
}

export function budgetRow(scope: CostBudgetScope, id: string): BudgetRow | undefined {
  return db().get<BudgetRow>('SELECT * FROM cost_budgets WHERE scope = ? AND scope_id = ?', scope, id);
}

/** Every budget of a scope kind, by id – one statement for a list (the overview, the scorecard). */
export function budgetRows(scope: CostBudgetScope): Map<string, BudgetRow> {
  return new Map(
    db()
      .all<BudgetRow>('SELECT * FROM cost_budgets WHERE scope = ?', scope)
      .map((b) => [b.scope_id, b]),
  );
}

/**
 * A budget with this month's use (in the budget's currency) and its forecast – always over the whole scope. A reader
 * who does not see every application of a service or team gets its state only (`stateOnly`): the use and the
 * percentages minus what they see would be the costs of the others. No reader (jobs, notices): everything.
 */
export function budgetOf(
  scope: CostBudgetScope,
  id: string,
  amounts: boolean,
  now = Date.now(),
  reader: AuthUser | null = currentUser(),
  /** The budgets read for a list (budgetRows): no statement for a scope without one */
  rows?: Map<string, BudgetRow>,
): CostBudget | null {
  const b = rows ? rows.get(id) : budgetRow(scope, id);
  if (!b) return null;
  const month = monthOf(now);
  const m = sums(coverWhere(coverOf(scope, id, false)), month)
    .get(b.currency)
    ?.get(month);
  const used = m?.e ?? 0;
  const limit = Number(b.amount);
  const forecast = m ? (monthForecast(coverWhere(coverOf(scope, id, false)), month, now).get(b.currency) ?? null) : null;
  const p = limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0;
  const stateOnly = !seesWholeScope(scope, id, reader);
  return {
    scope,
    scopeId: id,
    amount: amounts ? fromMicros(limit) : null,
    currency: b.currency,
    used: amounts && !stateOnly ? fromMicros(used) : null,
    pct: stateOnly ? null : p,
    forecastPct: !stateOnly && forecast !== null && limit > 0 ? Math.round((forecast / limit) * 1000) / 10 : null,
    state: used >= limit ? 'exceeded' : p >= COST_BUDGET_WARN_PCT ? 'warning' : 'ok',
    stateOnly,
    comment: b.comment,
    updatedAt: b.updated_at,
    updatedBy: b.updated_by,
  };
}

// ---------- one scope ----------

interface Part {
  kind: 'application' | 'platform' | 'other' | 'unassigned';
  id: string | null;
  name: string;
  currency: string;
  thisMonth: number;
  lastMonth: number;
}

const names = (table: 'applications' | 'platforms', ids: string[]): Map<string, string> =>
  new Map(
    ids.length
      ? db()
          .all<{ id: string; name: string }>(`SELECT id, name FROM ${table} WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids)
          .map((r) => [r.id, r.name])
      : [],
  );

function partsOf(info: ScopeInfo, cover: ScopeCover, month: string): Part[] {
  const where = coverWhere(cover);
  if (!where) return [];
  const prev = addMonths(month, -1);
  const byPlatform = info.scope === 'application';
  const rows = db().all<{ app: string | null; plat: string; month: string; currency: string; e: number }>(
    `SELECT application_id AS app, platform_id AS plat, month, billing_currency AS currency, SUM(effective_cost) AS e FROM cost_records
      WHERE ${where.sql} AND month IN (?, ?) GROUP BY application_id, platform_id, month, billing_currency`,
    ...where.params,
    prev,
    month,
  );
  const apps = names('applications', [...new Set(rows.map((r) => r.app).filter((x): x is string => !!x))]);
  const plats = names('platforms', [...new Set(rows.map((r) => r.plat))]);
  const out = new Map<string, Part>();
  for (const r of rows) {
    let p: Omit<Part, 'thisMonth' | 'lastMonth' | 'currency'>;
    if (byPlatform) {
      // the platforms an application's costs come from – a platform the reader may not see is not named
      p = scopeInfo('platform', r.plat) ? { kind: 'platform', id: r.plat, name: plats.get(r.plat) ?? r.plat } : { kind: 'other', id: null, name: '' };
    } else if (!r.app) {
      p =
        info.scope === 'team' && scopeInfo('platform', r.plat)
          ? { kind: 'unassigned', id: r.plat, name: plats.get(r.plat) ?? r.plat }
          : { kind: 'unassigned', id: null, name: '' };
    } else {
      p = scopeInfo('application', r.app) ? { kind: 'application', id: r.app, name: apps.get(r.app) ?? r.app } : { kind: 'other', id: null, name: '' };
    }
    const k = `${p.kind}|${p.id ?? ''}|${r.currency}`;
    const x = out.get(k) ?? { ...p, currency: r.currency, thisMonth: 0, lastMonth: 0 };
    if (r.month === month) x.thisMonth += Number(r.e);
    else x.lastMonth += Number(r.e);
    out.set(k, x);
  }
  return [...out.values()].sort((a, b) => b.thisMonth - a.thisMonth || b.lastMonth - a.lastMonth || a.name.localeCompare(b.name));
}

export function scopeDetail(scope: CostScope, id: string, now = Date.now()): CostScopeDetail {
  const info = requireScope(scope, id);
  const month = monthOf(now);
  const cover = coverOf(scope, id);
  const where = coverWhere(cover);
  const window = monthWindow(month);
  const s = sums(where, window[0]!);
  const fc = monthForecast(where, month, now);
  const amounts = info.amounts;
  const show = (n: number) => (amounts ? fromMicros(n) : null);
  const currencies = [...s.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, m]) => currencySummary(c, m, month, now, amounts, fc));
  const prev = addMonths(month, -1);
  const unassigned =
    scope === 'platform' && where
      ? db()
          .all<{ currency: string; month: string; e: number }>(
            `SELECT billing_currency AS currency, month, SUM(effective_cost) AS e FROM cost_records WHERE platform_id = ? AND application_id IS NULL
              AND month IN (?, ?) GROUP BY billing_currency, month ORDER BY billing_currency`,
            id,
            prev,
            month,
          )
          .reduce(
            (acc, r) => {
              const x = acc.find((a) => a.currency === r.currency) ?? (acc.push({ currency: r.currency, thisMonth: null, lastMonth: null }), acc.at(-1)!);
              if (r.month === month) x.thisMonth = show(Number(r.e));
              else x.lastMonth = show(Number(r.e));
              return acc;
            },
            [] as CostScopeDetail['unassigned'],
          )
      : [];
  const byService = where
    ? db()
        .all<{ provider: string; service: string; category: string; currency: string; month: string; e: number }>(
          `SELECT provider_name AS provider, service_name AS service, MAX(service_category) AS category, billing_currency AS currency, month, SUM(effective_cost) AS e
             FROM cost_records WHERE ${where.sql} AND month IN (?, ?) GROUP BY provider_name, service_name, billing_currency, month`,
          ...where.params,
          prev,
          month,
        )
        .reduce((acc, r) => {
          const k = `${r.provider}|${r.service}|${r.currency}`;
          const x = acc.get(k) ?? { provider: r.provider, service: r.service, category: r.category, currency: r.currency, t: 0, l: 0 };
          if (r.month === month) x.t += Number(r.e);
          else x.l += Number(r.e);
          acc.set(k, x);
          return acc;
        }, new Map<string, { provider: string; service: string; category: string; currency: string; t: number; l: number }>())
    : new Map();
  const sources = where
    ? db()
        .all<{ source_platform_id: string; source: CostSource; read_at: string }>(
          `SELECT source_platform_id, source, MAX(read_at) AS read_at FROM cost_records WHERE ${where.sql} GROUP BY source_platform_id, source`,
          ...where.params,
        )
        .filter((r) => scopeInfo('platform', r.source_platform_id))
    : [];
  const sourceNames = names(
    'platforms',
    sources.map((r) => r.source_platform_id),
  );
  return {
    scope,
    id,
    name: info.name,
    amountsVisible: amounts,
    month,
    currencies,
    unassigned,
    byService: [...byService.values()]
      .sort((a, b) => b.t - a.t || b.l - a.l)
      .slice(0, 50)
      .map((x) => ({ provider: x.provider, service: x.service, category: x.category, currency: x.currency, thisMonth: show(x.t), lastMonth: show(x.l) })),
    parts: partsOf(info, cover, month)
      .slice(0, 100)
      .map((p) => ({ kind: p.kind, id: p.id, name: p.name, currency: p.currency, thisMonth: show(p.thisMonth), lastMonth: show(p.lastMonth) })),
    sources: sources
      .map((r) => ({
        platformId: r.source_platform_id,
        platformName: sourceNames.get(r.source_platform_id) ?? r.source_platform_id,
        source: r.source,
        readAt: r.read_at,
      }))
      .sort((a, b) => a.platformName.localeCompare(b.platformName)),
    budget: scope === 'platform' ? null : budgetOf(scope, id, amounts, now),
    canEditBudget: scope !== 'platform' && info.canEditBudget,
    canManageSource: info.canManageSource,
  };
}

// ---------- overview ----------

interface Agg {
  app: string | null;
  plat: string;
  month: string;
  currency: string;
  e: number;
  last_end: string | null;
}

/** Every visible scope of a kind with this month, the last month and the forecast per currency. */
export function overview(scope: CostScope, now = Date.now()): CostOverview {
  const month = monthOf(now);
  const prev = addMonths(month, -1);
  const agg = db()
    .all<Agg>(
      `SELECT application_id AS app, platform_id AS plat, month, billing_currency AS currency, SUM(effective_cost) AS e, MAX(charge_period_end) AS last_end
         FROM cost_records WHERE month IN (?, ?) GROUP BY application_id, platform_id, month, billing_currency`,
      prev,
      month,
    )
    .map((r) => ({ ...r, e: Number(r.e) }));
  const rows: CostOverviewRow[] = [];
  const totals = new Map<string, { t: number; l: number }>();
  // what each service covers and the budgets, read once for the list (security review 0.19.0 H2)
  const covers = scope === 'service' ? serviceCovers() : null;
  const budgets = scope === 'platform' ? undefined : budgetRows(scope);
  for (const info of visibleScopes(scope)) {
    const c = covers ? covers(info.id) : coverOf(scope, info.id);
    const apps = new Set(c.applications);
    const unassigned = new Set(c.unassignedPlatforms);
    const mine = agg.filter((a) => (c.platform ? a.plat === c.platform : a.app ? apps.has(a.app) : unassigned.has(a.plat)));
    const byCurrency = new Map<string, { t: number; l: number; end: string | null; un: number; any: boolean }>();
    for (const a of mine) {
      const x = byCurrency.get(a.currency) ?? { t: 0, l: 0, end: null, un: 0, any: false };
      if (a.month === month) {
        x.t += a.e;
        x.any = true;
        if (!x.end || (a.last_end && a.last_end > x.end)) x.end = a.last_end;
        if (!a.app) x.un += a.e;
      } else x.l += a.e;
      byCurrency.set(a.currency, x);
    }
    const fcs = forecastFromGroups(
      mine.filter((a) => a.month === month).map((a) => ({ plat: a.plat, currency: a.currency, e: a.e, end: a.last_end })),
      month,
      now,
    );
    const budget = scope === 'platform' ? null : budgetOf(scope, info.id, info.amounts, now, currentUser(), budgets);
    // a platform without costs and without a cost source is left out of the list
    if (!byCurrency.size && scope === 'platform' && !db().get('SELECT platform_id FROM cost_sources WHERE platform_id = ? AND enabled = 1', info.id)) continue;
    if (!byCurrency.size)
      rows.push({
        scope,
        id: info.id,
        name: info.name,
        currency: budget?.currency ?? '',
        amountsVisible: info.amounts,
        thisMonth: null,
        lastMonth: null,
        forecast: null,
        changePct: null,
        unassigned: null,
        budgetPct: budget?.pct ?? null,
        budgetState: budget?.state ?? null,
      });
    for (const [currency, x] of [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const forecast = x.any ? (fcs.get(currency) ?? null) : null;
      const show = (n: number | null) => (n === null || !info.amounts ? null : fromMicros(n));
      const b = budget && budget.currency === currency ? budget : null;
      rows.push({
        scope,
        id: info.id,
        name: info.name,
        currency,
        amountsVisible: info.amounts,
        thisMonth: show(x.any ? x.t : null),
        lastMonth: show(x.l || null),
        forecast: show(forecast),
        changePct: forecast !== null && x.l > 0 ? pct(forecast, x.l) : null,
        unassigned: scope === 'platform' ? show(x.un) : null,
        budgetPct: b?.pct ?? null,
        budgetState: b?.state ?? null,
      });
      if (scope === 'platform' && info.amounts) {
        const tt = totals.get(currency) ?? { t: 0, l: 0 };
        tt.t += x.t;
        tt.l += x.l;
        totals.set(currency, tt);
      }
    }
  }
  return {
    scope,
    month,
    rows,
    totals: [...totals.entries()].map(([currency, x]) => ({ currency, thisMonth: fromMicros(x.t), lastMonth: fromMicros(x.l) })),
    hideAmounts: costSettings().hideAmountsFromViewers,
    canManageSettings: capabilities(currentUser()).manageSettings,
  };
}

/** Sums of a scope per currency and month from `fromMonth` on, as `reader` sees it (the monitor check). */
export function scopeMonths(
  scope: CostScope,
  id: string,
  fromMonth: string,
  reader: AuthUser | null,
): Map<string, Map<string, { e: number; end: string | null }>> {
  return sums(coverWhere(coverOf(scope, id, true, reader)), fromMonth);
}
