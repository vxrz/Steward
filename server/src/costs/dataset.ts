import { COSTS_DATASET, COST_SCOPES, toMicros, type DatasetRow, type DatasetStatus } from '@sm/shared';
import { db } from '../db.js';
import { publishDataset } from '../dashboards/datasets.js';
import { overview } from './query.js';

/**
 * The built-in dataset "Costs" (`costs`, docs/COSTS.md#dashboards-and-the-api): one row per service, application, team
 * and platform and currency with this month so far, the last month, the forecast, the change and the budget – for
 * dashboards and /api/v1/datasets/costs. Its rows name every scope, so administrators and auditors see it (like the
 * AI usage, dashboards/builtin.ts); everybody else reads costs with their own rights on the costs pages and through
 * /api/v1/costs. Published by the job "costs" at most hourly. Metrics: thisMonth, lastMonth and forecast of the platforms
 * (they do not overlap) in the currency with the highest costs.
 */

const COLUMNS = ['Kind', 'Name', 'Currency', 'This month', 'Last month', 'Forecast', 'Change %', 'Unassigned', 'Budget %', 'Budget'];
let lastPublished = 0;

const num = (v: string | null): number | null => (v === null ? null : (toMicros(v) ?? 0) / 1_000_000);

export function publishCostsDataset(force = false, now = Date.now()): boolean {
  if (!force && now - lastPublished < 3600_000) return false;
  if (!db().get('SELECT id FROM cost_records LIMIT 1') && !db().get('SELECT key FROM datasets WHERE key = ?', COSTS_DATASET)) return false;
  lastPublished = now;
  const rows: DatasetRow[] = [];
  const totals = new Map<string, { t: number; l: number; f: number }>();
  for (const scope of COST_SCOPES) {
    const o = overview(scope, now);
    for (const r of o.rows) {
      if (!r.currency) continue;
      const status: DatasetStatus = r.budgetState === 'exceeded' ? 'serious' : r.budgetState === 'warning' ? 'warning' : 'good';
      rows.push({
        Kind: scope,
        Name: r.name,
        Currency: r.currency,
        'This month': num(r.thisMonth),
        'Last month': num(r.lastMonth),
        Forecast: num(r.forecast),
        'Change %': r.changePct,
        Unassigned: num(r.unassigned),
        'Budget %': r.budgetPct,
        Budget: r.budgetState,
        _key: `${scope}/${r.id}/${r.currency}`,
        _status: status,
        _reason: r.budgetState === 'exceeded' ? 'The monthly budget is reached' : r.budgetState === 'warning' ? '80 % of the monthly budget' : '',
      });
      if (scope === 'platform') {
        const t = totals.get(r.currency) ?? { t: 0, l: 0, f: 0 };
        t.t += num(r.thisMonth) ?? 0;
        t.l += num(r.lastMonth) ?? 0;
        t.f += num(r.forecast) ?? 0;
        totals.set(r.currency, t);
      }
    }
  }
  const main = [...totals.entries()].sort((a, b) => b[1].l + b[1].t - (a[1].l + a[1].t))[0];
  const round = (n: number) => Math.round(n * 100) / 100;
  publishDataset({
    key: COSTS_DATASET,
    title: 'Costs',
    processId: 'costs:model',
    processName: 'Costs (built in)',
    runId: '',
    dryRun: false,
    columns: COLUMNS,
    rows,
    metrics: main ? { thisMonth: round(main[1].t), lastMonth: round(main[1].l), forecast: round(main[1].f) } : {},
    limits: {},
    staleAfterMinutes: 24 * 60 * 2,
    staleAfterFixed: true,
  });
  return true;
}
