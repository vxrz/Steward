import {
  DATA_CONTRACT_LIMITS,
  DATA_CONTRACT_SERVER_DIALECTS,
  DATA_CONTRACT_SERVICE_KIND,
  DATABASE_KIND,
  dataContractCreateInput,
  dataContractLinkInput,
  dataContractSettingsInput,
  dataContractVersionInput,
  qualifiedTable,
  type DataContractDetail,
  type DataContractDiff,
  type DataContractFacts,
  type DataContractFinding,
  type DataContractImportResult,
  type DataContractLink,
  type DataContractLinkInput,
  type DataContractLintFinding,
  type DataContractPermission,
  type DataContractPreview,
  type DataContractResult,
  type DataContractRun,
  type DataContractRunSummary,
  type DataContractRunVia,
  type DataContractSettings,
  type DataContractSummary,
  type DataContractVersion,
  type DataContractVersionSummary,
  type Platform,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { forbid, me } from '../auth/access.js';
import { capabilities, require as requirePermission } from '../auth/permissions.js';
import { assignCreatorTeams, contractAccess, forgetOwningTeams, owningTeams } from '../auth/policy.js';
import { canReadRecordRow, canViewCatalogue } from '../records/access.js';
import { getDatasetMeta } from '../dashboards/datasets.js';
import { getPlatform, specPlatformId } from '../platforms/service.js';
import { getSnapshot, subjectOf as schemaSubjectOf } from '../dbschema/service.js';
import { HttpError, newId, nowIso, parseJson, sha256, slugify } from '../util.js';
import { diffContracts } from './diff.js';
import { factsOf, parseContract, readContract, type OdcsDoc } from './odcs.js';
import { assertSqlRules, contractDialects, sqlRules } from './sqlrules.js';

/**
 * Data contracts (0.9.0, #221, docs/DATA-CONTRACTS.md): ODCS v3 contracts, every saved version, the changes between
 * versions (breaking ones marked; a breaking change can require an approved change record), links to what Steward
 * knows, Steward's own checks (no owner, not tested for N days, the last test failed, dataset or table columns that no
 * longer match), YAML import and export. The test runs through the data contract service are in testing.ts.
 *
 * Rights (policy.ts, contractAccess): view, test, edit; a contract the caller may not see answers like a missing one.
 * Links name what the caller may see when they are made; later readers who may not see a target get the link without
 * its name.
 */

const L = DATA_CONTRACT_LIMITS;

export interface ContractRow {
  id: string;
  contract_key: string;
  name: string;
  status: string;
  odcs_version: string;
  current_version: number;
  lint_errors: number;
  service_platform_id: string | null;
  test_server: string | null;
  require_change_record: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface VersionRow {
  contract_id: string;
  version: number;
  odcs_version: string;
  status: string;
  yaml: string;
  sha256: string;
  lint: string;
  lint_errors: number;
  changes: string | null;
  change_count: number;
  breaking_count: number;
  change_record_id: string | null;
  note: string;
  created_at: string;
  created_by: string;
}

interface LinkRow {
  id: string;
  contract_id: string;
  kind: DataContractLink['kind'];
  target_id: string;
  target_kind: 'platform' | 'system' | null;
  detail: string | null;
  schema_name: string | null;
  created_at: string;
  created_by: string;
}

export interface RunRow {
  id: string;
  contract_id: string;
  version: number;
  result: DataContractResult;
  via: DataContractRunVia;
  source_id: string | null;
  service_platform_id: string | null;
  server: string | null;
  checks_total: number;
  checks_passed: number;
  checks_warning: number;
  checks_failed: number;
  headline: string;
  report: string;
  report_sha256: string;
  truncated: number;
  dry_run: number;
  started_at: string;
  duration_ms: number;
  actor: string;
}

const actorName = () => currentUser()?.username ?? 'system';
const lintErrors = (lint: DataContractLintFinding[]) => lint.filter((f) => f.severity === 'error').length;

// ---------- reading and rights ----------

export const contractNotFound = (id: string) => new HttpError(404, `Data contract ${id} not found`, 'DATA_CONTRACT_NOT_FOUND', { id });

export function contractRow(id: string): ContractRow | undefined {
  return db().get<ContractRow>('SELECT * FROM data_contracts WHERE id = ?', id);
}

/** The rights of the caller (jobs without a caller: every right). */
export function permissionsOf(r: Pick<ContractRow, 'id'>, u: AuthUser | null = currentUser()): DataContractPermission[] {
  if (!u) return ['view', 'test', 'edit', 'manage'];
  return contractAccess(u, r).permissions;
}

/** A contract the caller may see (404 otherwise, like one that does not exist), with the caller's rights. */
export function visibleContract(id: string): { row: ContractRow; perms: DataContractPermission[] } {
  const row = contractRow(id);
  if (!row) throw contractNotFound(id);
  const perms = permissionsOf(row);
  if (!perms.includes('view')) throw contractNotFound(id);
  return { row, perms };
}

export function currentVersionRow(r: Pick<ContractRow, 'id' | 'current_version'>): VersionRow {
  const v = db().get<VersionRow>('SELECT * FROM data_contract_versions WHERE contract_id = ? AND version = ?', r.id, r.current_version);
  if (!v) throw new HttpError(500, `Data contract ${r.id} has no version ${r.current_version}`, 'DATA_CONTRACT_NOT_FOUND', { id: r.id });
  return v;
}

/** The current version as a parsed document (stored versions always parse: they were checked on save). */
export function currentDoc(r: Pick<ContractRow, 'id' | 'current_version'>): { doc: OdcsDoc; facts: DataContractFacts; yaml: string; version: number } {
  const v = currentVersionRow(r);
  const doc = parseContract(v.yaml).doc;
  return { doc, facts: factsOf(doc), yaml: v.yaml, version: v.version };
}

// ---------- links ----------

function linkRows(contractId: string): LinkRow[] {
  return db().all<LinkRow>('SELECT * FROM data_contract_links WHERE contract_id = ? ORDER BY kind, created_at, id', contractId);
}

const platformVisible = (id: string, u: AuthUser | null): Platform | null => {
  try {
    const p = getPlatform(id);
    return !u || p.permissions.length ? p : null;
  } catch {
    return null; // gone: shown without its name
  }
};

/** The name of a link's target as `u` may see it (null: hidden or gone). */
function targetName(l: Pick<LinkRow, 'kind' | 'target_id' | 'target_kind' | 'detail'>, u: AuthUser | null): string | null {
  switch (l.kind) {
    case 'application':
    case 'system': {
      const r = db().get<{ id: string; name: string; owners: string }>(
        `SELECT id, name, owners FROM ${l.kind === 'application' ? 'applications' : 'systems'} WHERE id = ?`,
        l.target_id,
      );
      return r && (!u || canViewCatalogue(u, { kind: l.kind, id: r.id, owners: parseJson<string[]>(r.owners, []) })) ? r.name : null;
    }
    case 'dataset':
      try {
        return getDatasetMeta(l.target_id).title || l.target_id;
      } catch {
        return null;
      }
    case 'spec': {
      const platformId = specPlatformId(l.target_id);
      const p = platformId ? platformVisible(platformId, u) : null;
      if (!p) return null;
      const spec = db().get<{ name: string }>('SELECT name FROM platform_specs WHERE id = ?', l.target_id);
      return spec ? `${p.name} · ${spec.name}` : null;
    }
    case 'server': {
      const p = platformVisible(l.target_id, u);
      return p ? p.name : null;
    }
    case 'table':
      try {
        return schemaSubjectOf(l.target_kind === 'system' ? 'system' : 'platform', l.target_id).name;
      } catch {
        return null;
      }
  }
}

function toLink(l: LinkRow, u: AuthUser | null): DataContractLink {
  const name = targetName(l, u);
  // what a hidden target is stays hidden: no id, table, operation or server name – only that a link exists
  const hidden = name === null && !!u;
  return {
    id: l.id,
    kind: l.kind,
    targetId: hidden ? '' : l.target_id,
    targetKind: hidden ? null : l.target_kind,
    detail: hidden ? null : l.detail,
    schema: l.schema_name,
    name,
    createdAt: l.created_at,
    createdBy: l.created_by,
  };
}

/**
 * Checks a new link: the caller must see the target (a hidden one answers like a missing one), the schema object must
 * be one of the contract's, and a server link needs the "use" right on the database platform – its credentials are
 * what the tests send to the service.
 */
function checkLink(input: DataContractLinkInput, facts: DataContractFacts, u: AuthUser): Omit<LinkRow, 'id' | 'contract_id' | 'created_at' | 'created_by'> {
  const schema = input.schema?.trim() || null;
  if (schema && !facts.schemas.some((s) => s.name === schema))
    throw new HttpError(400, `"${schema}" is not a schema object of the contract`, 'DATA_CONTRACT_LINK_SCHEMA', { schema });
  const base = {
    kind: input.kind,
    target_id: input.targetId,
    target_kind: null as LinkRow['target_kind'],
    detail: input.detail?.trim() || null,
    schema_name: schema,
  };
  const missing = () =>
    new HttpError(400, `${input.kind} "${input.targetId}" not found`, 'DATA_CONTRACT_LINK_TARGET', { kind: input.kind, id: input.targetId });
  switch (input.kind) {
    case 'application':
    case 'system':
    case 'dataset':
      if (targetName({ ...base, target_kind: null }, u) === null) throw missing();
      return { ...base, detail: null };
    case 'spec': {
      if (targetName(base, u) === null) throw missing();
      return base;
    }
    case 'table': {
      const kind = input.targetKind === 'system' ? 'system' : 'platform';
      if (!base.detail) throw new HttpError(400, 'Name the table (schema.table)', 'DATA_CONTRACT_LINK_TABLE');
      try {
        schemaSubjectOf(kind, input.targetId);
      } catch {
        throw missing();
      }
      return { ...base, target_kind: kind };
    }
    case 'server': {
      const server = base.detail;
      if (!server || !facts.servers.some((s) => s.server === server))
        throw new HttpError(400, `"${server ?? ''}" is not a server of the contract`, 'DATA_CONTRACT_LINK_SERVER', { server: server ?? '' });
      const p = platformVisible(input.targetId, u);
      if (!p) throw missing();
      if (p.kind !== DATABASE_KIND) throw new HttpError(400, `"${p.name}" is not a database platform`, 'DATA_CONTRACT_LINK_NOT_DATABASE', { name: p.name });
      if (!p.permissions.includes('use'))
        throw new HttpError(403, `You are not allowed to use platform "${p.name}"`, 'PLATFORM_USE_FORBIDDEN', { name: p.name });
      const type = facts.servers.find((s) => s.server === server)!.type;
      const dialect = DATA_CONTRACT_SERVER_DIALECTS[type];
      const has = (p.config.database as { dialect?: string } | undefined)?.dialect;
      if (!dialect || (has && has !== dialect))
        throw new HttpError(400, `Server "${server}" (type ${type}) cannot be answered by "${p.name}"`, 'DATA_CONTRACT_SERVER_TYPE', {
          server,
          type,
          name: p.name,
        });
      return base;
    }
  }
}

function insertLink(contractId: string, l: Omit<LinkRow, 'id' | 'contract_id' | 'created_at' | 'created_by'>): LinkRow {
  const row: LinkRow = { id: newId('dcl_'), contract_id: contractId, ...l, created_at: nowIso(), created_by: actorName() };
  // a server is answered by one platform: a new link replaces the one before
  if (l.kind === 'server') db().run("DELETE FROM data_contract_links WHERE contract_id = ? AND kind = 'server' AND detail = ?", contractId, l.detail);
  db().run(
    'INSERT INTO data_contract_links (id, contract_id, kind, target_id, target_kind, detail, schema_name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.id,
    row.contract_id,
    row.kind,
    row.target_id,
    row.target_kind,
    row.detail,
    row.schema_name,
    row.created_at,
    row.created_by,
  );
  return row;
}

export function addLink(id: string, body: unknown): DataContractLink {
  const u = me();
  const { row, perms } = visibleContract(id);
  requirePermission(perms, 'edit', 'change this data contract');
  const input = dataContractLinkInput.parse(body);
  if (linkRows(id).length >= L.links) throw new HttpError(409, `A contract has at most ${L.links} links`, 'DATA_CONTRACT_LINK_LIMIT', { max: L.links });
  const l = checkLink(input, currentDoc(row).facts, u);
  const made = db().tx(() => {
    const r = insertLink(id, l);
    touch(id);
    audit({
      action: 'contract.linked',
      entityType: 'contract',
      entityId: id,
      summary: `Data contract "${row.name}": linked ${l.kind} ${l.target_id}${l.detail ? ` (${l.detail})` : ''}${l.schema_name ? ` for ${l.schema_name}` : ''}`,
    });
    return r;
  });
  return toLink(made, u);
}

export function deleteLink(id: string, linkId: string): void {
  const { row, perms } = visibleContract(id);
  requirePermission(perms, 'edit', 'change this data contract');
  const l = db().get<LinkRow>('SELECT * FROM data_contract_links WHERE id = ? AND contract_id = ?', linkId, id);
  if (!l) throw new HttpError(404, `Link ${linkId} not found`, 'DATA_CONTRACT_LINK_NOT_FOUND', { id: linkId });
  db().tx(() => {
    db().run('DELETE FROM data_contract_links WHERE id = ?', linkId);
    touch(id);
    audit({
      action: 'contract.unlinked',
      entityType: 'contract',
      entityId: id,
      summary: `Data contract "${row.name}": removed the ${l.kind} link ${l.target_id}`,
    });
  });
}

const touch = (id: string) => db().run('UPDATE data_contracts SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), actorName(), id);

// ---------- runs ----------

export function lastRun(contractId: string, opts: { realOnly?: boolean } = {}): RunRow | undefined {
  return db().get<RunRow>(
    `SELECT * FROM data_contract_runs WHERE contract_id = ?${opts.realOnly ? ' AND dry_run = 0' : ''} ORDER BY started_at DESC, id DESC LIMIT 1`,
    contractId,
  );
}

export function toRunSummary(r: RunRow): DataContractRunSummary {
  return {
    id: r.id,
    version: r.version,
    result: r.result,
    via: r.via,
    sourceId: r.source_id,
    server: r.server,
    checks: { total: r.checks_total, passed: r.checks_passed, warning: r.checks_warning, failed: r.checks_failed },
    headline: r.headline,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    actor: r.actor,
    dryRun: !!r.dry_run,
  };
}

export function listRuns(id: string, limit = 100): DataContractRunSummary[] {
  visibleContract(id);
  return db()
    .all<RunRow>('SELECT * FROM data_contract_runs WHERE contract_id = ? ORDER BY started_at DESC, id DESC LIMIT ?', id, Math.min(limit, L.runsKept))
    .map(toRunSummary);
}

export function getRun(id: string, runId: string): DataContractRun {
  visibleContract(id);
  const r = db().get<RunRow>('SELECT * FROM data_contract_runs WHERE id = ? AND contract_id = ?', runId, id);
  if (!r) throw new HttpError(404, `Test run ${runId} not found`, 'DATA_CONTRACT_RUN_NOT_FOUND', { id: runId });
  const service = r.service_platform_id ? platformVisible(r.service_platform_id, currentUser()) : null;
  return {
    ...toRunSummary(r),
    report: parseJson<unknown>(r.report, null),
    reportSha256: r.report_sha256,
    truncated: !!r.truncated,
    service: service ? { id: service.id, name: service.name } : null,
  };
}

// ---------- Steward's own checks ----------

/** Column names of a linked dataset or table, as `u` may see them (null: hidden, gone or no snapshot yet). */
function targetColumns(l: LinkRow): string[] | null {
  if (l.kind === 'dataset') {
    try {
      return getDatasetMeta(l.target_id).columns;
    } catch {
      return null;
    }
  }
  if (l.kind === 'table' && l.detail) {
    try {
      const snap = getSnapshot(l.target_kind === 'system' ? 'system' : 'platform', l.target_id, 'latest');
      const want = l.detail.toLowerCase();
      const t = snap.schema.tables.find((x) => qualifiedTable(x).toLowerCase() === want) ?? snap.schema.tables.find((x) => x.name.toLowerCase() === want);
      return t ? t.columns.map((c) => c.name) : [];
    } catch {
      return null;
    }
  }
  return null;
}

/** The top-level fields of a schema object as the source names them (physicalName, else name). */
function schemaFields(doc: OdcsDoc, schema: string | null): { schema: string; fields: string[] } | null {
  const objects = (Array.isArray(doc.schema) ? doc.schema : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const s = schema ? objects.find((x) => x.name === schema) : objects.length === 1 ? objects[0] : undefined;
  if (!s) return null;
  const props = (Array.isArray(s.properties) ? s.properties : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  return {
    schema: String(s.name ?? ''),
    fields: props.map((p) => String(typeof p.physicalName === 'string' && p.physicalName ? p.physicalName : (p.name ?? ''))).filter(Boolean),
  };
}

export interface FindingOptions {
  /** "Not tested" after this many days (default 7) */
  testedWithinDays?: number;
  now?: number;
}

/**
 * Steward's own checks of a contract, without the service: no owner (no owning team and nobody in the contract's team
 * section), not tested within N days, the last test failed, linked datasets or tables whose columns no longer match
 * (fields of the contract missing in the source: error; columns the contract does not name: warning), lint errors.
 */
export function findingsOf(row: ContractRow, doc: OdcsDoc, links: LinkRow[], opts: FindingOptions = {}): DataContractFinding[] {
  const out: DataContractFinding[] = [];
  const now = opts.now ?? Date.now();
  const days = opts.testedWithinDays ?? L.testedWithinDays.default;
  if (!owningTeams('contract', row.id).length && !factsOf(doc).team.length) out.push({ kind: 'noOwner', severity: 'warning' });
  const last = lastRun(row.id, { realOnly: true });
  if (!last) out.push({ kind: 'notTested', severity: 'warning' });
  else {
    const age = Math.floor((now - Date.parse(last.started_at)) / 86_400_000);
    if (age >= days) out.push({ kind: 'notTested', count: age, severity: 'warning' });
    if (last.result === 'failed' || last.result === 'error') out.push({ kind: 'lastTestFailed', severity: 'error' });
  }
  for (const l of links) {
    if (l.kind !== 'dataset' && l.kind !== 'table') continue;
    const columns = targetColumns(l);
    const want = schemaFields(doc, l.schema_name);
    if (columns === null || !want) continue;
    const have = new Set(columns.map((c) => c.toLowerCase()));
    const named = new Set(want.fields.map((c) => c.toLowerCase()));
    const missing = want.fields.filter((f) => !have.has(f.toLowerCase()));
    const extra = columns.filter((c) => !named.has(c.toLowerCase()) && c !== '_source');
    if (missing.length) out.push({ kind: 'columnsMissing', schema: want.schema, link: l.id, fields: missing.slice(0, 50), severity: 'error' });
    if (extra.length) out.push({ kind: 'columnsExtra', schema: want.schema, link: l.id, fields: extra.slice(0, 50), severity: 'warning' });
  }
  if (row.lint_errors > 0) out.push({ kind: 'lint', count: row.lint_errors, severity: 'warning' });
  return out;
}

// ---------- lists and details ----------

function summaryOf(r: ContractRow, findings: number, links: number): DataContractSummary {
  const last = lastRun(r.id);
  return {
    id: r.id,
    key: r.contract_key,
    name: r.name,
    status: r.status,
    version: r.odcs_version,
    currentVersion: r.current_version,
    owningTeams: owningTeams('contract', r.id),
    lintErrors: r.lint_errors,
    lastRun: last ? { id: last.id, result: last.result, startedAt: last.started_at } : null,
    findingCount: findings,
    linkCount: links,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function listContracts(): DataContractSummary[] {
  return db()
    .all<ContractRow>('SELECT * FROM data_contracts ORDER BY name, id')
    .filter((r) => permissionsOf(r).includes('view'))
    .map((r) => {
      const links = linkRows(r.id);
      return summaryOf(r, findingsOf(r, currentDoc(r).doc, links).length, links.length);
    });
}

export function getContract(id: string): DataContractDetail {
  const { row, perms } = visibleContract(id);
  const u = currentUser();
  const v = currentVersionRow(row);
  const doc = parseContract(v.yaml).doc;
  const links = linkRows(id);
  const findingList = findingsOf(row, doc, links);
  const service = row.service_platform_id ? platformVisible(row.service_platform_id, u) : null;
  return {
    ...summaryOf(row, findingList.length, links.length),
    ...settingsOf(row),
    yaml: v.yaml,
    facts: factsOf(doc),
    lint: parseJson<DataContractLintFinding[]>(v.lint, []),
    links: links.map((l) => toLink(l, u)),
    findingList,
    // a hidden service platform is not named, and its id is not given either
    servicePlatformId: service ? row.service_platform_id : row.service_platform_id && u ? null : row.service_platform_id,
    serviceName: service?.name ?? null,
    permissions: perms,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

const settingsOf = (r: ContractRow): DataContractSettings => ({
  servicePlatformId: r.service_platform_id,
  testServer: r.test_server,
  requireChangeRecord: !!r.require_change_record,
});

// ---------- creating and saving versions ----------

/** Who may create contracts: designers and administrators (like processes and monitors). */
function requireCreate(u: AuthUser): void {
  if (!capabilities(u).createProcesses) forbid('create data contracts', 'createContract');
}

/** A service platform the caller may use (400 otherwise, like a missing one). */
function checkServicePlatform(platformId: string, u: AuthUser): Platform {
  const p = platformVisible(platformId, u);
  if (!p) throw new HttpError(400, `Platform "${platformId}" not found`, 'PLATFORM_NOT_FOUND', { id: platformId });
  if (p.kind !== DATA_CONTRACT_SERVICE_KIND)
    throw new HttpError(400, `"${p.name}" is not a data contract service (kind ${DATA_CONTRACT_SERVICE_KIND})`, 'DATA_CONTRACT_NOT_A_SERVICE', {
      name: p.name,
    });
  if (!p.permissions.includes('use')) throw new HttpError(403, `You are not allowed to use platform "${p.name}"`, 'PLATFORM_USE_FORBIDDEN', { name: p.name });
  return p;
}

/**
 * A contract with SQL quality rules (docs/DATA-CONTRACTS.md#sql-quality-rules): every rule passes Steward's statement
 * check for the DBMS of the contract's servers, and whoever saves it has the "use" right on every database platform
 * linked to its servers – the service runs the SQL with that platform's credentials. A platform the caller may not see
 * is not named.
 */
function checkSqlRules(doc: OdcsDoc, serverPlatformIds: string[], u: AuthUser): void {
  const rules = sqlRules(doc);
  if (!rules.length) return;
  assertSqlRules(rules, contractDialects(doc));
  for (const pid of new Set(serverPlatformIds)) {
    const p = platformVisible(pid, u);
    if (!p)
      throw new HttpError(403, 'SQL quality rules need the "use" right on the database platforms linked to the contract', 'DATA_CONTRACT_SQL_NEEDS_USE', {
        count: rules.length,
      });
    if (!p.permissions.includes('use'))
      throw new HttpError(
        403,
        `SQL quality rules run with the credentials of "${p.name}": you need its "use" right to save them`,
        'DATA_CONTRACT_SQL_NEEDS_USE_PLATFORM',
        { name: p.name, count: rules.length },
      );
  }
}

const serverLinkTargets = (contractId: string): string[] =>
  linkRows(contractId)
    .filter((l) => l.kind === 'server')
    .map((l) => l.target_id);

/** Why a text that parses cannot be saved for its SQL rules (the editor's live check), or null. */
function sqlProblemsOf(doc: OdcsDoc): DataContractLintFinding[] {
  try {
    assertSqlRules(sqlRules(doc), contractDialects(doc));
    return [];
  } catch (e) {
    const err = e as HttpError & { params?: Record<string, unknown> };
    return [{ path: String(err.params?.path ?? '/'), message: err.message, severity: 'error', source: 'yaml' }];
  }
}

function insertVersion(
  contractId: string,
  version: number,
  yaml: string,
  facts: DataContractFacts,
  lint: DataContractLintFinding[],
  diff: DataContractDiff | null,
  extra: { note: string; changeRecordId: string | null },
): void {
  db().run(
    `INSERT INTO data_contract_versions (contract_id, version, odcs_version, status, yaml, sha256, lint, lint_errors, changes, change_count, breaking_count, change_record_id, note, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    contractId,
    version,
    facts.version,
    facts.status,
    yaml,
    sha256(yaml),
    JSON.stringify(lint),
    lintErrors(lint),
    diff ? JSON.stringify(diff) : null,
    diff?.total ?? 0,
    diff?.breaking ?? 0,
    extra.changeRecordId,
    extra.note,
    nowIso(),
    actorName(),
  );
}

export function createContract(body: unknown): DataContractDetail {
  const u = me();
  requireCreate(u);
  const input = dataContractCreateInput.parse(body);
  const { facts, lint, doc } = readContract(input.yaml);
  const links = input.links.map((l) => checkLink(dataContractLinkInput.parse(l), facts, u));
  checkSqlRules(
    doc,
    links.filter((l) => l.kind === 'server').map((l) => l.target_id),
    u,
  );
  const settings = input.settings ?? {};
  if (settings.servicePlatformId) checkServicePlatform(settings.servicePlatformId, u);
  if (settings.testServer && !facts.servers.some((s) => s.server === settings.testServer))
    throw new HttpError(400, `"${settings.testServer}" is not a server of the contract`, 'DATA_CONTRACT_LINK_SERVER', { server: settings.testServer });
  // a contract with this ODCS id was deleted while its breaking changes needed a change record: the new one starts with
  // the rule (an administrator or approver can switch it off – setSettings)
  const kept = !!db().get<{ require_change_record: number }>('SELECT require_change_record FROM data_contract_kept_rules WHERE contract_key = ?', facts.key)
    ?.require_change_record;
  const requireChangeRecord = !!settings.requireChangeRecord || kept;
  const id = newId('dct_');
  const ts = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO data_contracts (id, contract_key, name, status, odcs_version, current_version, lint_errors, service_platform_id, test_server, require_change_record, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      facts.key,
      facts.name,
      facts.status,
      facts.version,
      lintErrors(lint),
      settings.servicePlatformId ?? null,
      settings.testServer ?? null,
      requireChangeRecord ? 1 : 0,
      ts,
      u.username,
      ts,
      u.username,
    );
    insertVersion(id, 1, input.yaml, facts, lint, null, { note: input.note, changeRecordId: null });
    for (const l of links) insertLink(id, l);
    assignCreatorTeams('contract', id, u);
    audit({
      action: 'contract.created',
      entityType: 'contract',
      entityId: id,
      summary: `Data contract "${facts.name}" (${facts.key} ${facts.version}) created${lint.length ? ` – ${lintErrors(lint)} lint error(s)` : ''}${kept && !settings.requireChangeRecord ? ' – breaking changes need a change record, as for the deleted contract with this id' : ''}`,
      details: { key: facts.key, version: facts.version, sha256: sha256(input.yaml), links: links.length, requireChangeRecord },
    });
  });
  return getContract(id);
}

const APPROVED_CHANGE = ['approved', 'implemented', 'verified', 'closed'];

/** An approved change record the caller may read (400 otherwise, like a missing one). */
function checkChangeRecord(recordId: string, u: AuthUser): { id: string; number: string; title: string } {
  const r = db().get<{ id: string; number: string; title: string; type_id: string; fields: string; owner: string; status: string; workflow: string }>(
    'SELECT r.id, r.number, r.title, r.type_id, r.fields, r.owner, r.status, t.workflow FROM records r JOIN record_types t ON t.id = r.type_id WHERE r.id = ? OR r.number = ?',
    recordId,
    recordId,
  );
  if (!r || !canReadRecordRow(u, r)) throw new HttpError(400, `Record ${recordId} not found`, 'RECORD_NOT_FOUND', { id: recordId });
  if (r.workflow !== 'change' || !APPROVED_CHANGE.includes(r.status))
    throw new HttpError(400, `${r.number} is not an approved change record`, 'DATA_CONTRACT_CHANGE_RECORD', { number: r.number });
  // a change record covers one version of one contract: it cannot be used again, here or for another contract
  if (db().get('SELECT 1 FROM data_contract_versions WHERE change_record_id = ?', r.id))
    throw new HttpError(
      409,
      `${r.number} was already used for a version of a data contract – each version needs its own change record`,
      'DATA_CONTRACT_CHANGE_RECORD_USED',
      {
        number: r.number,
      },
    );
  return { id: r.id, number: r.number, title: r.title };
}

/** Checks a text against the current version without saving it (the editor's live check). */
export function previewVersion(id: string | null, yaml: string): DataContractPreview {
  if (id === null) {
    me();
    const p = parseContract(yaml);
    const problems = p.problems.length ? p.problems : sqlProblemsOf(p.doc);
    if (problems.length) return { facts: null, lint: problems, diff: null, unchanged: false, needsChangeRecord: false };
    return { facts: factsOf(p.doc), lint: readContract(yaml).lint, diff: null, unchanged: false, needsChangeRecord: false };
  }
  const { row } = visibleContract(id);
  const p = parseContract(yaml);
  const problems = p.problems.length ? p.problems : sqlProblemsOf(p.doc);
  if (problems.length) return { facts: null, lint: problems, diff: null, unchanged: false, needsChangeRecord: false };
  const cur = currentDoc(row);
  const diff = diffContracts(cur.doc, p.doc);
  return {
    facts: factsOf(p.doc),
    lint: readContract(yaml).lint,
    diff,
    unchanged: cur.yaml === yaml,
    needsChangeRecord: !!row.require_change_record && diff.breaking > 0,
  };
}

export function saveVersion(id: string, body: unknown): { contract: DataContractDetail; created: boolean; diff: DataContractDiff | null } {
  const u = me();
  const { row, perms } = visibleContract(id);
  requirePermission(perms, 'edit', 'change this data contract');
  const input = dataContractVersionInput.parse(body);
  const { facts, lint, doc } = readContract(input.yaml);
  const cur = currentDoc(row);
  if (cur.yaml === input.yaml) return { contract: getContract(id), created: false, diff: null };
  checkSqlRules(doc, serverLinkTargets(id), u);
  const diff = diffContracts(cur.doc, doc);
  let record: { id: string; number: string } | null = null;
  if (input.changeRecordId) record = checkChangeRecord(input.changeRecordId, u);
  if (row.require_change_record && diff.breaking > 0 && !record)
    throw new HttpError(
      409,
      `${diff.breaking} breaking change(s): this contract needs an approved change record for them`,
      'DATA_CONTRACT_NEEDS_CHANGE_RECORD',
      {
        count: diff.breaking,
      },
    );
  const next = row.current_version + 1;
  db().tx(() => {
    // the record was checked above: again within the transaction, so two saves cannot use one record
    if (record) checkChangeRecord(record.id, u);
    insertVersion(id, next, input.yaml, facts, lint, diff, { note: input.note, changeRecordId: record?.id ?? null });
    db().run(
      'UPDATE data_contracts SET contract_key = ?, name = ?, status = ?, odcs_version = ?, current_version = ?, lint_errors = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      facts.key,
      facts.name,
      facts.status,
      facts.version,
      next,
      lintErrors(lint),
      nowIso(),
      u.username,
      id,
    );
    // a test server the contract no longer names is forgotten, and so are links to schema objects and servers it dropped
    if (row.test_server && !facts.servers.some((s) => s.server === row.test_server)) db().run('UPDATE data_contracts SET test_server = NULL WHERE id = ?', id);
    audit({
      action: 'contract.version_saved',
      entityType: 'contract',
      entityId: id,
      summary: `Data contract "${facts.name}": version ${next} (${facts.version}) saved – ${diff.total} change(s), ${diff.breaking} breaking${record ? `, change record ${record.number}` : ''}`,
      details: { version: next, sha256: sha256(input.yaml), changes: diff.total, breaking: diff.breaking, changeRecord: record?.number ?? null },
    });
  });
  return { contract: getContract(id), created: true, diff };
}

export function setSettings(id: string, body: unknown): DataContractDetail {
  const u = me();
  const { row, perms } = visibleContract(id);
  const input = dataContractSettingsInput.parse(body);
  // switching off "breaking changes need a change record" is the decision of who approves changes (manage) – who has
  // only that right (an approver) changes nothing else
  const switchedOff = !!row.require_change_record && !input.requireChangeRecord;
  if (switchedOff) requirePermission(perms, 'manage', 'switch off the change record rule of this data contract');
  // a service the caller may not see is not named to them (null): it stays as it is unless they choose another one
  const hidden = !!row.service_platform_id && !platformVisible(row.service_platform_id, u);
  const service = input.servicePlatformId === null && hidden ? row.service_platform_id : (input.servicePlatformId ?? null);
  const onlyTheRule = service === row.service_platform_id && (input.testServer || null) === row.test_server;
  if (!(switchedOff && onlyTheRule)) requirePermission(perms, 'edit', 'change this data contract');
  if (service && service !== row.service_platform_id) checkServicePlatform(service, u);
  const facts = currentDoc(row).facts;
  if (input.testServer && !facts.servers.some((s) => s.server === input.testServer))
    throw new HttpError(400, `"${input.testServer}" is not a server of the contract`, 'DATA_CONTRACT_LINK_SERVER', { server: input.testServer });
  db().tx(() => {
    db().run(
      'UPDATE data_contracts SET service_platform_id = ?, test_server = ?, require_change_record = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      service,
      input.testServer || null,
      input.requireChangeRecord ? 1 : 0,
      nowIso(),
      u.username,
      id,
    );
    audit({
      action: 'contract.settings_changed',
      entityType: 'contract',
      entityId: id,
      summary: `Data contract "${row.name}": test settings changed (service ${service ?? 'none'}, server ${input.testServer || 'the only one'}, change record for breaking changes ${input.requireChangeRecord ? 'required' : 'not required'})${switchedOff ? ' – the change record rule was switched off' : ''}`,
      details: { requireChangeRecord: { before: !!row.require_change_record, after: input.requireChangeRecord } },
    });
    // switched off by who may decide it: a rule kept from a deleted contract with this ODCS id goes too
    if (switchedOff) db().run('DELETE FROM data_contract_kept_rules WHERE contract_key = ?', row.contract_key);
  });
  return getContract(id);
}

export function deleteContract(id: string): void {
  const { row, perms } = visibleContract(id);
  requirePermission(perms, 'edit', 'delete this data contract');
  db().tx(() => {
    for (const t of ['data_contract_versions', 'data_contract_links', 'data_contract_runs']) db().run(`DELETE FROM ${t} WHERE contract_id = ?`, id);
    db().run('DELETE FROM data_contracts WHERE id = ?', id);
    forgetOwningTeams('contract', id);
    // the change record rule outlives the contract: a new one with this ODCS id (an import) starts with it
    if (row.require_change_record) {
      db().run('DELETE FROM data_contract_kept_rules WHERE contract_key = ?', row.contract_key);
      db().run(
        'INSERT INTO data_contract_kept_rules (contract_key, require_change_record, deleted_at, deleted_by) VALUES (?, 1, ?, ?)',
        row.contract_key,
        nowIso(),
        actorName(),
      );
    }
    audit({
      action: 'contract.deleted',
      entityType: 'contract',
      entityId: id,
      summary: `Data contract "${row.name}" (${row.contract_key}) deleted with its versions and test runs`,
    });
  });
}

// ---------- versions ----------

function toVersionSummary(v: VersionRow, u: AuthUser | null): DataContractVersionSummary {
  let changeRecord: DataContractVersionSummary['changeRecord'] = null;
  if (v.change_record_id) {
    const r = db().get<{ id: string; number: string; title: string; type_id: string; fields: string; owner: string }>(
      'SELECT id, number, title, type_id, fields, owner FROM records WHERE id = ?',
      v.change_record_id,
    );
    if (r && (!u || canReadRecordRow(u, r))) changeRecord = { id: r.id, number: r.number, title: r.title };
  }
  return {
    version: v.version,
    odcsVersion: v.odcs_version,
    status: v.status,
    sha256: v.sha256,
    changes: v.change_count,
    breaking: v.breaking_count,
    lintErrors: v.lint_errors,
    note: v.note,
    changeRecord,
    createdAt: v.created_at,
    createdBy: v.created_by,
  };
}

export function listVersions(id: string): DataContractVersionSummary[] {
  visibleContract(id);
  const u = currentUser();
  return db()
    .all<VersionRow>('SELECT * FROM data_contract_versions WHERE contract_id = ? ORDER BY version DESC', id)
    .map((v) => toVersionSummary(v, u));
}

function versionRow(id: string, version: number): VersionRow {
  const v = db().get<VersionRow>('SELECT * FROM data_contract_versions WHERE contract_id = ? AND version = ?', id, version);
  if (!v) throw new HttpError(404, `Version ${version} not found`, 'DATA_CONTRACT_VERSION_NOT_FOUND', { version: String(version) });
  return v;
}

export function getVersion(id: string, version: number): DataContractVersion {
  visibleContract(id);
  const v = versionRow(id, version);
  return {
    ...toVersionSummary(v, currentUser()),
    yaml: v.yaml,
    lint: parseJson<DataContractLintFinding[]>(v.lint, []),
    diff: parseJson<DataContractDiff | null>(v.changes, null),
  };
}

/** The changes from one version to another (any two, in either order). */
export function compareVersions(id: string, from: number, to: number): DataContractDiff & { from: number; to: number } {
  visibleContract(id);
  const a = parseContract(versionRow(id, from).yaml).doc;
  const b = parseContract(versionRow(id, to).yaml).doc;
  return { ...diffContracts(a, b), from, to };
}

// ---------- import and export ----------

export function exportYaml(id: string, version?: number): { fileName: string; body: string } {
  const { row } = visibleContract(id);
  const v = version ? versionRow(id, version) : currentVersionRow(row);
  const fileName = `${slugify(row.contract_key)}-v${v.version}.odcs.yaml`;
  return { fileName, body: v.yaml };
}

/**
 * Imports a contract file: a new version of the visible contract with the same ODCS id that the caller may change, or
 * a new contract. Contracts the caller may not see are not looked at – a second contract with the same id is made.
 */
export function importContract(body: unknown): DataContractImportResult {
  const u = me();
  const yaml = dataContractVersionInput.pick({ yaml: true }).parse(body).yaml;
  const { facts } = readContract(yaml);
  const mine = db()
    .all<ContractRow>('SELECT * FROM data_contracts WHERE contract_key = ? ORDER BY created_at, id', facts.key)
    .filter((r) => permissionsOf(r, u).includes('edit'));
  if (mine.length > 1)
    throw new HttpError(
      409,
      `${mine.length} data contracts have the id "${facts.key}" – open the one to change and save the file there`,
      'DATA_CONTRACT_KEY_AMBIGUOUS',
      {
        key: facts.key,
        count: mine.length,
      },
    );
  if (mine.length === 1) {
    const r = saveVersion(mine[0]!.id, { yaml, note: 'Imported' });
    return { action: r.created ? 'version' : 'unchanged', contract: r.contract, diff: r.diff };
  }
  const made = createContract({ yaml, note: 'Imported' });
  return { action: 'created', contract: made, diff: null };
}

// ---------- for checks, the report section and the scorecard ----------

/** Contracts linked to applications or systems (the scorecard's services): contract ids per target. */
export function contractsLinkedTo(kind: 'application' | 'system', ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  for (const r of db().all<{ contract_id: string; target_id: string }>(
    `SELECT DISTINCT contract_id, target_id FROM data_contract_links WHERE kind = ? AND target_id IN (${ids.map(() => '?').join(', ')})`,
    kind,
    ...ids,
  )) {
    const list = out.get(r.target_id) ?? [];
    list.push(r.contract_id);
    out.set(r.target_id, list);
  }
  return out;
}

/** What the scorecard needs of a contract: its last real test and Steward's own findings. */
export interface ContractState {
  id: string;
  name: string;
  result: DataContractResult | null;
  testedAt: string | null;
  findings: number;
  errors: number;
}

/** The states of these contracts, those `viewer` may see (null: every contract – the daily snapshot). */
export function contractStates(ids: string[], viewer: AuthUser | null): Map<string, ContractState> {
  const out = new Map<string, ContractState>();
  for (const id of new Set(ids)) {
    const r = contractRow(id);
    if (!r || (viewer && !permissionsOf(r, viewer).includes('view'))) continue;
    const last = lastRun(r.id, { realOnly: true });
    const f = findingsOf(r, currentDoc(r).doc, linkRows(r.id));
    out.set(id, {
      id,
      name: r.name,
      result: last?.result ?? null,
      testedAt: last?.started_at ?? null,
      findings: f.length,
      errors: f.filter((x) => x.severity === 'error').length,
    });
  }
  return out;
}

export { linkRows };
export type { LinkRow };
