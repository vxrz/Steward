import { z, type ZodType } from 'zod';
import type { DataContractResult, ReportLang } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { registerReportSection } from '../reports/sections.js';
import type { CellInput, Tone } from '../reports/pdf/engine.js';
import { currentDoc, findingsOf, linkRows, permissionsOf, type ContractRow, type RunRow } from './service.js';

/**
 * "Data contracts" section of scheduled summary reports (#221, docs/DATA-CONTRACTS.md#reports): per contract the
 * owner may see, its current version, the tests of the report period (passed, warnings, failed – from monitors,
 * processes and by hand; dry runs left out), the last test and Steward's own findings, and the versions saved in the
 * period with their breaking changes. The full test reports stay with the contracts (evidence).
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

const schema = z.object({
  /** Contracts to include; null: every contract the owner may see */
  contractIds: z.array(z.string().min(1).max(100)).max(200).nullable().default(null),
});
type ContractsConfig = z.infer<typeof schema>;

interface Row {
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

const iso = (t: number) => new Date(t).toISOString();

function build(c: ContractsConfig, ctx: { from: number; to: number; now: number }): ContractsSectionData {
  const out: ContractsSectionData = { rows: [], versions: [], totals: { contracts: 0, tests: 0, passed: 0, warning: 0, failed: 0, breaking: 0 } };
  if (!currentUser()) return out;
  const from = iso(ctx.from);
  const to = iso(ctx.to);
  const contracts = db()
    .all<ContractRow>('SELECT * FROM data_contracts ORDER BY name, id')
    .filter((r) => (!c.contractIds || c.contractIds.includes(r.id)) && permissionsOf(r).includes('view'));
  for (const r of contracts) {
    const runs = db().all<Pick<RunRow, 'result'>>(
      'SELECT result FROM data_contract_runs WHERE contract_id = ? AND dry_run = 0 AND started_at >= ? AND started_at < ?',
      r.id,
      from,
      to,
    );
    const last = db().get<Pick<RunRow, 'result' | 'started_at'>>(
      'SELECT result, started_at FROM data_contract_runs WHERE contract_id = ? AND dry_run = 0 AND started_at < ? ORDER BY started_at DESC, id DESC LIMIT 1',
      r.id,
      to,
    );
    const count = (x: DataContractResult[]) => runs.filter((y) => x.includes(y.result)).length;
    const row: Row = {
      name: r.name,
      key: r.contract_key,
      version: r.odcs_version,
      current: r.current_version,
      last: last ? { result: last.result, at: last.started_at } : null,
      passed: count(['passed']),
      warning: count(['warning']),
      failed: count(['failed', 'error']),
      findings: findingsOf(r, currentDoc(r).doc, linkRows(r.id), { now: Math.min(ctx.to, ctx.now) }).length,
    };
    out.rows.push(row);
    out.totals.tests += runs.length;
    out.totals.passed += row.passed;
    out.totals.warning += row.warning;
    out.totals.failed += row.failed;
    for (const v of db().all<{ version: number; odcs_version: string; created_at: string; created_by: string; change_count: number; breaking_count: number }>(
      'SELECT version, odcs_version, created_at, created_by, change_count, breaking_count FROM data_contract_versions WHERE contract_id = ? AND created_at >= ? AND created_at < ? ORDER BY version',
      r.id,
      from,
      to,
    )) {
      out.versions.push({
        name: r.name,
        version: v.version,
        odcs: v.odcs_version,
        at: v.created_at,
        by: v.created_by,
        changes: v.change_count,
        breaking: v.breaking_count,
      });
      out.totals.breaking += v.breaking_count;
    }
  }
  out.totals.contracts = out.rows.length;
  return out;
}

const tone = (r: DataContractResult): Tone => (r === 'passed' ? 'success' : r === 'warning' ? 'warning' : 'danger');

registerReportSection<ContractsConfig, ContractsSectionData>({
  id: 'contracts',
  schema: schema as unknown as ZodType<ContractsConfig>,
  validate: (c) => {
    if (!c.contractIds) return;
    const visible = new Set(
      db()
        .all<ContractRow>('SELECT id FROM data_contracts')
        .filter((r) => permissionsOf(r).includes('view'))
        .map((r) => r.id),
    );
    // a contract the owner may not see reads like a missing one
    const missing = c.contractIds.filter((x) => !visible.has(x));
    if (missing.length) throw Object.assign(new Error(`Data contract(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  title: (l) => tx(l).title,
  build,
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
});
