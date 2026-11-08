import { z, type ZodType } from 'zod';
import { COST_SCOPES, fromMicros, type CostScope, type ReportLang } from '@sm/shared';
import { db } from '../db.js';
import { registerReportSection } from '../reports/sections.js';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import { coverOf, coverWhere, scopeInfo, visibleScopes } from './access.js';
import { budgetOf } from './query.js';

/**
 * "Costs" section of scheduled summary reports (#226, docs/COSTS.md#dashboards-and-the-api): per service, application, team or
 * platform the costs of the report period against the period before (a monthly schedule: the last month against the
 * month before), per currency, with the budget's state. Collected with the rights of the schedule's owner: scopes they
 * may not see are neither named nor counted; amounts they may not see are left out (only the change in percent).
 */

const MAX_ROWS = 200;

const en = {
  title: 'Costs',
  intro:
    'Costs of the report period from the platforms Steward reads (AWS, Snowflake, Confluent Cloud, AI gateways) and imported FOCUS files – showback, not invoices. Totals are per currency; nothing is converted. Costs without a link to an application are shown per platform as unassigned.',
  scope: { service: 'Service', application: 'Application', team: 'Team', platform: 'Platform' },
  period: 'This period',
  before: 'Period before',
  change: 'Change',
  budget: 'Budget (month)',
  currency: 'Currency',
  unassigned: 'Unassigned',
  none: 'No costs in the report period.',
  hidden: 'amounts not shown',
  total: 'Total',
  exceeded: 'reached',
  warning: '80 % reached',
  ok: 'within',
};
type Texts = typeof en;
const de: Texts = {
  title: 'Kosten',
  intro:
    'Kosten des Berichtszeitraums aus den Plattformen, die Steward liest (AWS, Snowflake, Confluent Cloud, KI-Gateways), und importierten FOCUS-Dateien – Showback, keine Rechnungen. Summen gelten je Währung; nichts wird umgerechnet. Kosten ohne Verknüpfung zu einer Anwendung stehen je Plattform als nicht zugeordnet.',
  scope: { service: 'Service', application: 'Anwendung', team: 'Team', platform: 'Plattform' },
  period: 'Dieser Zeitraum',
  before: 'Zeitraum davor',
  change: 'Änderung',
  budget: 'Budget (Monat)',
  currency: 'Währung',
  unassigned: 'Nicht zugeordnet',
  none: 'Keine Kosten im Berichtszeitraum.',
  hidden: 'Beträge nicht angezeigt',
  total: 'Summe',
  exceeded: 'erreicht',
  warning: '80 % erreicht',
  ok: 'eingehalten',
};
const tx = (l: ReportLang): Texts => (l === 'de' ? de : en);

const schema = z.object({
  /** What the rows are */
  scope: z.enum(COST_SCOPES).default('service'),
  /** Only these (ids); null: every one the owner may see */
  ids: z.array(z.string().min(1).max(100)).max(200).nullable().default(null),
});
type CostConfig = z.infer<typeof schema>;

interface Row {
  name: string;
  currency: string;
  amounts: boolean;
  period: string | null;
  before: string | null;
  changePct: number | null;
  unassigned: string | null;
  budget: { amount: string | null; pct: number | null; state: string } | null;
}

export interface CostSectionData {
  scope: CostScope;
  rows: Row[];
  totals: { currency: string; period: string; before: string }[];
}

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

const money = (lang: ReportLang, v: string | null, currency: string): string =>
  v === null ? '–' : `${Number(v).toLocaleString(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

registerReportSection<CostConfig, CostSectionData>({
  id: 'costs',
  schema: schema as unknown as ZodType<CostConfig>,
  validate: (c) => {
    if (!c.ids) return;
    // a scope the owner may not see reads like a missing one
    const missing = c.ids.filter((id) => !scopeInfo(c.scope, id));
    if (missing.length) throw Object.assign(new Error(`${en.scope[c.scope]}(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  title: (l) => tx(l).title,
  build,
  glance: (d, l) =>
    d.totals.map((t) => ({
      label: `${tx(l).title} (${t.currency})`,
      value: money(l, t.period, t.currency),
    })),
  render: (d, { w, lang, section }) => {
    const x = tx(lang);
    section(x.title);
    w.paragraph(x.intro, { tone: 'muted', size: 8 });
    if (d.totals.length)
      w.stats(d.totals.map((t) => ({ label: `${x.total} ${t.currency}`, value: money(lang, t.period, t.currency), tone: 'default' as Tone })));
    const pct = (v: number | null): CellInput =>
      v === null ? '–' : { text: `${v > 0 ? '+' : ''}${v.toLocaleString(lang)} %`, tone: v > 10 ? 'warning' : 'default' };
    const budget = (r: Row): CellInput =>
      r.budget
        ? {
            text: `${r.budget.amount !== null ? `${money(lang, r.budget.amount, r.currency)} · ` : ''}${r.budget.pct !== null ? `${r.budget.pct.toLocaleString(lang)} % (${x[r.budget.state as 'ok' | 'warning' | 'exceeded']})` : x[r.budget.state as 'ok' | 'warning' | 'exceeded']}`,
            tone: r.budget.state === 'exceeded' ? 'danger' : r.budget.state === 'warning' ? 'warning' : 'default',
          }
        : '–';
    w.table(
      [
        { header: x.scope[d.scope], width: 2.6 },
        { header: x.period, width: 1.4 },
        { header: x.before, width: 1.4 },
        { header: x.change, width: 0.9 },
        ...(d.scope === 'platform' ? [{ header: x.unassigned, width: 1.3 }] : [{ header: x.budget, width: 1.9 }]),
      ],
      d.rows.map((r): CellInput[] => [
        { text: r.name, bold: true },
        r.amounts ? money(lang, r.period, r.currency) : { text: x.hidden, tone: 'muted' },
        r.amounts ? money(lang, r.before, r.currency) : { text: r.currency, tone: 'muted' },
        pct(r.changePct),
        d.scope === 'platform' ? money(lang, r.unassigned, r.currency) : budget(r),
      ]),
      { empty: x.none, size: 7.4 },
    );
  },
});
