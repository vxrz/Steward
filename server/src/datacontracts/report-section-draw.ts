import type { DataContractResult, ReportLang } from '@sm/shared';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import type { ReportSectionDraw } from '../reports/section-draw.js';

/**
 * The draw half of the section of scheduled summary reports in report-section.ts (which collects its data): data
 * in, PDF out – it runs in the PDF worker (reports/section-draw.ts).
 */

const MAX_ROWS = 300;

const en = {
  title: 'Data contracts',
  intro:
    'ODCS data contracts with their tests in the report period (through the data contract service, from monitors, processes and by hand – dry runs left out), the last test, Steward’s own findings (no owner, not tested, columns that no longer match) and the versions saved in the period. The full test reports are kept with each contract.',
  contracts: 'Contracts',
  tests: 'Tests',
  passed: 'Passed',
  warning: 'Warnings',
  failed: 'Failed',
  breaking: 'Breaking changes',
  contract: 'Contract',
  version: 'Version',
  lastTest: 'Last test',
  inPeriod: 'Tests in the period (passed · warnings · failed)',
  findings: 'Findings',
  versions: 'Versions saved in the period',
  saved: 'Saved',
  changes: 'Changes',
  by: 'By',
  never: 'never',
  none: 'No data contract is visible to the owner of this report.',
  noVersions: 'No version was saved in the report period.',
  results: { passed: 'passed', warning: 'warnings', failed: 'failed', error: 'error' } as Record<DataContractResult, string>,
};

type Texts = typeof en;

const de: Texts = {
  title: 'Datenverträge',
  intro:
    'ODCS-Datenverträge mit ihren Tests im Berichtszeitraum (über den Datenvertragsdienst, aus Monitoren, Prozessen und von Hand – ohne Probeläufe), dem letzten Test, Stewards eigenen Befunden (kein Eigentümer, nicht getestet, Spalten, die nicht mehr passen) und den im Zeitraum gespeicherten Versionen. Die vollständigen Testberichte bleiben beim jeweiligen Vertrag.',
  contracts: 'Verträge',
  tests: 'Tests',
  passed: 'Bestanden',
  warning: 'Warnungen',
  failed: 'Fehlgeschlagen',
  breaking: 'Inkompatible Änderungen',
  contract: 'Vertrag',
  version: 'Version',
  lastTest: 'Letzter Test',
  inPeriod: 'Tests im Zeitraum (bestanden · Warnungen · fehlgeschlagen)',
  findings: 'Befunde',
  versions: 'Im Zeitraum gespeicherte Versionen',
  saved: 'Gespeichert',
  changes: 'Änderungen',
  by: 'Von',
  never: 'nie',
  none: 'Für den Eigentümer dieses Berichts ist kein Datenvertrag sichtbar.',
  noVersions: 'Im Berichtszeitraum wurde keine Version gespeichert.',
  results: { passed: 'bestanden', warning: 'Warnungen', failed: 'fehlgeschlagen', error: 'Fehler' },
};

const tx = (l: ReportLang): Texts => (l === 'de' ? de : en);

export interface Row {
  name: string;
  key: string;
  version: string;
  current: number;
  last: { result: DataContractResult; at: string } | null;
  passed: number;
  warning: number;
  failed: number;
  findings: number;
}

export interface ContractsSectionData {
  rows: Row[];
  versions: { name: string; version: number; odcs: string; at: string; by: string; changes: number; breaking: number }[];
  totals: { contracts: number; tests: number; passed: number; warning: number; failed: number; breaking: number };
}

const tone = (r: DataContractResult): Tone => (r === 'passed' ? 'success' : r === 'warning' ? 'warning' : 'danger');

export const contractsSectionDraw: ReportSectionDraw<ContractsSectionData> = {
  id: 'contracts',
  title: (l) => tx(l).title,
  glance: (d, l) => [
    { label: tx(l).tests, value: String(d.totals.tests) },
    { label: tx(l).failed, value: String(d.totals.failed), tone: (d.totals.failed ? 'danger' : 'default') as Tone },
  ],
  render: (d, { w, lang, section }) => {
    const x = tx(lang);
    const date = (s: string) => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s));
    section(x.title);
    w.paragraph(x.intro, { tone: 'muted', size: 8 });
    w.stats([
      { label: x.contracts, value: String(d.totals.contracts) },
      { label: x.tests, value: String(d.totals.tests) },
      { label: x.passed, value: String(d.totals.passed), tone: d.totals.passed ? 'success' : 'default' },
      { label: x.warning, value: String(d.totals.warning), tone: d.totals.warning ? 'warning' : 'default' },
      { label: x.failed, value: String(d.totals.failed), tone: d.totals.failed ? 'danger' : 'default' },
      { label: x.breaking, value: String(d.totals.breaking), tone: d.totals.breaking ? 'warning' : 'default' },
    ]);
    w.table(
      [
        { header: x.contract, width: 3 },
        { header: x.version, width: 1.1 },
        { header: x.lastTest, width: 1.8 },
        { header: x.inPeriod, width: 2 },
        { header: x.findings, width: 0.9 },
      ],
      d.rows
        .slice(0, MAX_ROWS)
        .map((r): CellInput[] => [
          { text: `${r.name} (${r.key})`, bold: true },
          `${r.version} · v${r.current}`,
          r.last ? { text: `${x.results[r.last.result]} · ${date(r.last.at)}`, tone: tone(r.last.result) } : { text: x.never, tone: 'muted' },
          `${r.passed} · ${r.warning} · ${r.failed}`,
          r.findings ? { text: String(r.findings), tone: 'warning' } : '0',
        ]),
      { empty: x.none, size: 7.4 },
    );
    w.subheading(x.versions);
    w.table(
      [
        { header: x.contract, width: 3 },
        { header: x.version, width: 1.2 },
        { header: x.saved, width: 1.4 },
        { header: x.by, width: 1.2 },
        { header: x.changes, width: 1.6 },
      ],
      d.versions
        .slice(0, MAX_ROWS)
        .map((v): CellInput[] => [
          v.name,
          `${v.odcs} · v${v.version}`,
          date(v.at),
          v.by,
          v.breaking ? { text: `${v.changes} · ${x.breaking}: ${v.breaking}`, tone: 'warning' } : String(v.changes),
        ]),
      { empty: x.noVersions, size: 7.4 },
    );
  },
};
