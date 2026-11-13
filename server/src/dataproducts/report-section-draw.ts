import type { ReportLang } from '@sm/shared';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import type { ReportSectionDraw } from '../reports/section-draw.js';

/**
 * The draw half of the "Data products" section of scheduled reports (report-section.ts collects its data): data in,
 * PDF out – it runs in the PDF worker (reports/section-draw.ts). 0.24.0, ADR 0036 phase 2, declared as the module's
 * report section (ADR 0034: left out for recipients who do not use the module).
 */

const MAX_ROWS = 300;

const en = {
  title: 'Data products',
  intro:
    'The data products the owner of this report may see, in their production environment (or the one chosen): the maturity now and at the start of the period (from the daily scorecard snapshots), the scorecard parts met, the health, the quality tests of their output elements in the period (dbt tests, Data Metric Functions, contract tests) and breaking changes of their bound contracts. Maturity is computed, never typed: 1 documented and rated, 2 observed, 3 contracted, 4 objectives met for 30 days.',
  products: 'Products',
  rising: 'Maturity up',
  falling: 'Maturity down',
  testsFailed: 'Quality tests failed',
  breaking: 'Breaking contract versions',
  product: 'Product',
  environment: 'Environment',
  maturity: 'Maturity (start → now)',
  parts: 'Parts met',
  health: 'Health',
  quality: 'Quality tests (passed · failed)',
  noSnapshot: 'no snapshot',
  none: 'No data product is visible to the owner of this report.',
  more: (n: number) => `${n} more products are not listed.`,
  health_: {
    met: 'healthy',
    partial: 'degraded',
    notMet: 'down',
    noEvidence: 'no data',
    notApplicable: '–',
  } as Record<string, string>,
};

type Texts = typeof en;

const de: Texts = {
  title: 'Datenprodukte',
  intro:
    'Die Datenprodukte, die der Eigentümer dieses Berichts sehen darf, in ihrer Produktionsumgebung (oder der gewählten): die Reife jetzt und zu Beginn des Zeitraums (aus den täglichen Scorecard-Ständen), die erfüllten Teile der Scorecard, der Zustand, die Qualitätstests ihrer Ausgabe-Elemente im Zeitraum (dbt-Tests, Data Metric Functions, Vertragstests) und inkompatible Änderungen ihrer gebundenen Verträge. Die Reife wird berechnet, nie eingetragen: 1 dokumentiert und bewertet, 2 beobachtet, 3 unter Vertrag, 4 Ziele 30 Tage erfüllt.',
  products: 'Produkte',
  rising: 'Reife gestiegen',
  falling: 'Reife gesunken',
  testsFailed: 'Fehlgeschlagene Qualitätstests',
  breaking: 'Inkompatible Vertragsversionen',
  product: 'Produkt',
  environment: 'Umgebung',
  maturity: 'Reife (Beginn → jetzt)',
  parts: 'Erfüllte Teile',
  health: 'Zustand',
  quality: 'Qualitätstests (bestanden · fehlgeschlagen)',
  noSnapshot: 'kein Stand',
  none: 'Für den Eigentümer dieses Berichts ist kein Datenprodukt sichtbar.',
  more: (n: number) => `${n} weitere Produkte sind nicht aufgeführt.`,
  health_: { met: 'gesund', partial: 'beeinträchtigt', notMet: 'gestört', noEvidence: 'keine Daten', notApplicable: '–' },
};

const tx = (l: ReportLang): Texts => (l === 'de' ? de : en);

export interface DataProductsSectionRow {
  name: string;
  key: string;
  environment: string | null;
  maturity: number;
  /** The maturity of the snapshot at (or before) the start of the period; null: none taken yet */
  maturityBefore: number | null;
  met: number;
  parts: number;
  /** The healthy part's state */
  health: string;
  passed: number;
  failed: number;
  breaking: number;
}

export interface DataProductsSectionData {
  rows: DataProductsSectionRow[];
  /** Products beyond the rows drawn */
  more: number;
  totals: { products: number; rising: number; falling: number; failed: number; breaking: number };
}

const healthTone = (s: string): Tone => (s === 'met' ? 'success' : s === 'partial' ? 'warning' : s === 'notMet' ? 'danger' : 'muted');

export const dataProductsSectionDraw: ReportSectionDraw<DataProductsSectionData> = {
  id: 'dataProducts',
  title: (l) => tx(l).title,
  glance: (d, l) => [
    { label: tx(l).products, value: String(d.totals.products) },
    { label: tx(l).testsFailed, value: String(d.totals.failed), tone: (d.totals.failed ? 'danger' : 'default') as Tone },
  ],
  render: (d, { w, lang, section }) => {
    const x = tx(lang);
    section(x.title);
    w.paragraph(x.intro, { tone: 'muted', size: 8 });
    w.stats([
      { label: x.products, value: String(d.totals.products) },
      { label: x.rising, value: String(d.totals.rising), tone: d.totals.rising ? 'success' : 'default' },
      { label: x.falling, value: String(d.totals.falling), tone: d.totals.falling ? 'warning' : 'default' },
      { label: x.testsFailed, value: String(d.totals.failed), tone: d.totals.failed ? 'danger' : 'default' },
      { label: x.breaking, value: String(d.totals.breaking), tone: d.totals.breaking ? 'warning' : 'default' },
    ]);
    w.table(
      [
        { header: x.product, width: 3 },
        { header: x.environment, width: 1.1 },
        { header: x.maturity, width: 1.5 },
        { header: x.parts, width: 1 },
        { header: x.health, width: 1.2 },
        { header: x.quality, width: 1.6 },
      ],
      d.rows
        .slice(0, MAX_ROWS)
        .map((r): CellInput[] => [
          { text: `${r.name} (${r.key})`, bold: true },
          r.environment ?? '–',
          r.maturityBefore === null
            ? { text: `${x.noSnapshot} → ${r.maturity}`, tone: 'muted' }
            : {
                text: `${r.maturityBefore} → ${r.maturity}`,
                tone: r.maturity > r.maturityBefore ? 'success' : r.maturity < r.maturityBefore ? 'warning' : 'default',
              },
          `${r.met} / ${r.parts}`,
          { text: x.health_[r.health] ?? r.health, tone: healthTone(r.health) },
          r.failed ? { text: `${r.passed} · ${r.failed}`, tone: 'danger' } : `${r.passed} · 0`,
        ]),
      { empty: x.none, size: 7.4 },
    );
    if (d.more > 0 || d.rows.length > MAX_ROWS) w.paragraph(x.more(d.more + Math.max(0, d.rows.length - MAX_ROWS)), { tone: 'muted', size: 7.4 });
  },
};
