import { z, type ZodType } from 'zod';
import type { DataContractResult } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { currentDoc, findingsOf, linkRows, permissionsOf, type ContractRow, type RunRow } from './service.js';
import type { ReportSectionDef } from '../reports/sections.js';
import { contractsSectionDraw, type Row, type ContractsSectionData } from './report-section-draw.js';

/**
 * "Data contracts" section of scheduled summary reports (#221, docs/DATA-CONTRACTS.md#monitors-processes-scorecard-and-reports): per contract the
 * owner may see, its current version, the tests of the report period (passed, warnings, failed – from monitors,
 * processes and by hand; dry runs left out), the last test and Steward's own findings, and the versions saved in the
 * period with their breaking changes. The full test reports stay with the contracts (evidence).
 */

const schema = z.object({
  /** Contracts to include; null: every contract the owner may see */
  contractIds: z.array(z.string().min(1).max(100)).max(200).nullable().default(null),
});

type ContractsConfig = z.infer<typeof schema>;

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

export const contractsSection: ReportSectionDef<ContractsConfig, ContractsSectionData> = {
  ...contractsSectionDraw,
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
  build,
};
