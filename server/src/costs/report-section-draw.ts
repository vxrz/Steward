import { currencyMinorUnits, type CostScope, type ReportLang } from '@sm/shared';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import type { ReportSectionDraw } from '../reports/section-draw.js';

/**
 * The draw half of the section of scheduled summary reports in report-section.ts (which collects its data): data
 * in, PDF out – it runs in the PDF worker (reports/section-draw.ts).
 */

export const en = {
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

export interface Row {
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

/** An amount with the decimals of its currency (no decimals for JPY, three for KWD, 0.17.1). */
const money = (lang: ReportLang, v: string | null, currency: string): string => {
  const digits = currencyMinorUnits(currency);
  return v === null ? '–' : `${Number(v).toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${currency}`;
};

export const costsSectionDraw: ReportSectionDraw<CostSectionData> = {
  id: 'costs',
  title: (l) => tx(l).title,
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
};
