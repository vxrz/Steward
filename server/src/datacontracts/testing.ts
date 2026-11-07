import {
  DATA_CONTRACT_LIMITS,
  DATA_CONTRACT_SERVER_DIALECTS,
  DATA_CONTRACT_SERVICE_KIND,
  DATABASE_KIND,
  type DataContractLintFinding,
  type DataContractResult,
  type DataContractRun,
  type DataContractRunVia,
  type DatabaseSettings,
  type Platform,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { currentUser, runAs } from '../auth/context.js';
import { require as requirePermission } from '../auth/permissions.js';
import { contractAccess, owningTeams } from '../auth/policy.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { getConnection, getPlatform } from '../platforms/service.js';
import { buildUrl, credentialsAllowed, platformRequest } from '../platforms/http.js';
import { assertAddressSafe, assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { ownCall } from '../platforms/deniedPaths.js';
import { redactSecrets } from '../platforms/testConnection.js';
import { assertDatabaseAllowed, databaseSettings } from '../dbms/service.js';
import { assertNotOwnDatabase, resolveAddresses, type AddressLookup } from '../dbms/own.js';
import { DEMO_DB_HOST } from '../dbms/demo.js';
import { notify, titleName } from '../notifications/service.js';
import { sourceOfRun } from '../engine/notify-source.js';
import { t } from '../i18n/index.js';
import { HttpError, newId, nowIso, sha256 } from '../util.js';
import { currentDoc, getRun, lastRun, permissionsOf, visibleContract, type ContractRow, type RunRow } from './service.js';
import { assertSqlRules, sqlRules } from './sqlrules.js';

/**
 * Testing a data contract through the data contract service (#221, docs/DATA-CONTRACTS.md#testing): the datacontract
 * CLI's API (`datacontract api`, its own container). Steward sends `POST /test?server=<name>` with the contract as YAML
 * and – per request, never in the contract – the credentials of the tested server from the vault, in the CLI's
 * documented `datacontract-*` headers (`datacontract-postgres-username` …). The tested server is a database platform
 * of Steward linked to the contract's server: its host, port and database are sent as headers too, so the service
 * connects where the platform points (the CLI takes these over the contract's own `servers` entry), and the outbound
 * policy is checked for it here – the same rules as for a connection of Steward's own, Steward's own database included.
 * The service itself is called through the outbound policy like every platform; redirects are not followed (the
 * headers carry credentials). The answer – a test run with one check per test – is stored in full as evidence, with
 * every secret of both platforms masked.
 *
 * A test runs with the rights of whoever starts it (the monitor owner for a monitor, the run's actor for a process
 * step): the contract's "test" right and the "use" right on the service and on the tested platform.
 */

const L = DATA_CONTRACT_LIMITS;

/** The header prefix of the CLI's configuration options per DBMS (datacontract/config/settings.py). */
const HEADER_PREFIX: Record<'postgresql' | 'mysql' | 'sqlserver', string> = { postgresql: 'postgres', mysql: 'mysql', sqlserver: 'sqlserver' };

export interface TestOptions {
  via: DataContractRunVia;
  /** The monitor or the process run that started the test */
  sourceId?: string | null;
  /** The ODCS server to test (default: the contract's setting, else its only server) */
  server?: string;
  /** A dry run of a process: stored and shown, but it does not notify and does not count for "last tested" */
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Time limit of the call (default 120 s, at most 300 s) */
  timeoutMs?: number;
}

function usable(id: string, kind: string, what: string): Platform {
  let p: Platform;
  try {
    p = getPlatform(id);
  } catch {
    throw new HttpError(400, `${what} ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  }
  if (currentUser() && !p.permissions.length) throw new HttpError(400, `${what} ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  if (p.kind !== kind)
    throw new HttpError(
      400,
      `"${p.name}" is not a ${kind === DATABASE_KIND ? 'database platform' : 'data contract service'}`,
      kind === DATABASE_KIND ? 'DATA_CONTRACT_LINK_NOT_DATABASE' : 'DATA_CONTRACT_NOT_A_SERVICE',
      { name: p.name },
    );
  if (currentUser() && !p.permissions.includes('use'))
    throw new HttpError(403, `You are not allowed to use platform "${p.name}"`, 'PLATFORM_USE_FORBIDDEN', { name: p.name });
  return p;
}

interface Target {
  row: ContractRow;
  yaml: string;
  version: number;
  server: string;
  service: Platform;
  database: Platform;
  settings: DatabaseSettings;
}

/** Everything a test needs, checked before anything is sent. */
function prepare(contractId: string, opts: Pick<TestOptions, 'server'>): Target {
  const { row, perms } = visibleContract(contractId);
  requirePermission(perms, 'test', 'test this data contract');
  if (!row.service_platform_id) throw new HttpError(409, 'No data contract service is set for this contract', 'DATA_CONTRACT_NO_SERVICE');
  const service = usable(row.service_platform_id, DATA_CONTRACT_SERVICE_KIND, 'Data contract service');
  const { facts, yaml, version, doc } = currentDoc(row);
  const server = opts.server || row.test_server || (facts.servers.length === 1 ? facts.servers[0]!.server : '');
  if (!server) throw new HttpError(409, 'Choose the server to test: the contract names several (or none)', 'DATA_CONTRACT_SERVER_REQUIRED');
  const def = facts.servers.find((s) => s.server === server);
  if (!def) throw new HttpError(400, `"${server}" is not a server of the contract`, 'DATA_CONTRACT_LINK_SERVER', { server });
  const dialect = DATA_CONTRACT_SERVER_DIALECTS[def.type];
  if (!dialect)
    throw new HttpError(409, `Servers of type ${def.type} cannot be tested by Steward yet`, 'DATA_CONTRACT_SERVER_TYPE_UNSUPPORTED', {
      server,
      type: def.type,
    });
  const link = db().get<{ target_id: string }>(
    "SELECT target_id FROM data_contract_links WHERE contract_id = ? AND kind = 'server' AND detail = ?",
    row.id,
    server,
  );
  if (!link)
    throw new HttpError(
      409,
      `Server "${server}" is not linked to a database platform – link it, so the test gets its credentials`,
      'DATA_CONTRACT_SERVER_NOT_LINKED',
      {
        server,
      },
    );
  const database = usable(link.target_id, DATABASE_KIND, 'Database platform');
  const settings = databaseSettings(database);
  if (settings.dialect !== dialect)
    throw new HttpError(400, `Server "${server}" (type ${def.type}) cannot be answered by "${database.name}"`, 'DATA_CONTRACT_SERVER_TYPE', {
      server,
      type: def.type,
      name: database.name,
    });
  // SQL quality rules run with the database platform's credentials: only with a person's rights (the "use" right was
  // checked above for whoever runs the test), and each one passes the statement check for this DBMS again
  const rules = sqlRules(doc);
  if (rules.length) {
    if (!currentUser())
      throw new HttpError(403, 'A contract with SQL quality rules is tested with the rights of a person', 'DATA_CONTRACT_SQL_NEEDS_USE', {
        count: rules.length,
      });
    assertSqlRules(rules, [settings.dialect]);
  }
  assertTlsTestable(database, settings);
  return { row, yaml, version, server, service, database, settings };
}

/**
 * TLS (docs/DATA-CONTRACTS.md#tls-and-the-tested-host): the CLI connects to PostgreSQL and MySQL without verifying the certificate (and
 * PostgreSQL may fall back to no TLS), so a platform that asks for TLS ("verify" or "require") is tested only when it
 * explicitly allows the service to connect without certificate verification. SQL Server gets its TLS settings in the
 * CLI's headers (serverHeaders).
 */
function assertTlsTestable(p: Platform, s: DatabaseSettings): void {
  if (s.dialect === 'sqlserver' || s.tls.mode === 'off' || s.tls.contractServiceUnverified) return;
  // the demo database answers only in demo mode (the simulated service connects nowhere)
  if (config.demo && s.host.toLowerCase() === DEMO_DB_HOST) return;
  throw new HttpError(
    409,
    `"${p.name}" asks for TLS (${s.tls.mode}), but the data contract service cannot verify the certificate of ${s.dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} – allow it under Platform → Database, or test with the CLI where it can`,
    'DATA_CONTRACT_TLS_UNVERIFIED',
    { name: p.name, mode: s.tls.mode },
  );
}

const bare = (h: string) => h.replace(/^\[|\]$/g, '');

/**
 * The host the service connects to (the datacontract-*-host header): Steward resolves the platform's host, refuses a
 * name it cannot resolve, checks every address (Steward's own database, address safety) and sends the address it
 * checked – so the service's own DNS cannot lead it elsewhere. SQL Server with "verify" checks the certificate against
 * the name: there the name is sent (the CLI has no separate name for the certificate check) – see "split DNS" in
 * docs/DATA-CONTRACTS.md#tls-and-the-tested-host.
 */
export async function testedHost(s: DatabaseSettings, lookup: AddressLookup = resolveAddresses): Promise<string> {
  // the demo database answers only in demo mode and has no address
  if (config.demo && s.host.toLowerCase() === DEMO_DB_HOST) return s.host;
  await assertDatabaseAllowed(s);
  const host = bare(s.host);
  const port = s.port ?? (s.dialect === 'postgresql' ? 5432 : s.dialect === 'mysql' ? 3306 : 1433);
  const addresses = await lookup(host);
  if (!addresses.length)
    throw new HttpError(409, `${host} does not resolve here – Steward tests only a host it can resolve and check`, 'DATA_CONTRACT_HOST_UNRESOLVED', { host });
  for (const a of addresses) {
    await assertNotOwnDatabase(a, port, s.database);
    await assertAddressSafe(`http://${a.includes(':') ? `[${a}]` : a}:${port}`);
  }
  return s.dialect === 'sqlserver' && s.tls.mode === 'verify' ? s.host : addresses[0]!;
}

/**
 * The datacontract-* headers of the tested server: where to connect (`host`: the address Steward checked, testedHost)
 * and how to sign in (from the vault); for SQL Server its TLS settings as the CLI takes them (encrypt, trust the
 * certificate – "require" does not verify it).
 */
export function serverHeaders(
  dialect: DatabaseSettings['dialect'],
  s: DatabaseSettings,
  secrets: Record<string, string>,
  host: string = s.host,
): Record<string, string> {
  const p = HEADER_PREFIX[dialect as 'postgresql'];
  const port = s.port ?? (dialect === 'postgresql' ? 5432 : dialect === 'mysql' ? 3306 : 1433);
  const h: Record<string, string> = {
    [`datacontract-${p}-host`]: host,
    [`datacontract-${p}-port`]: String(port),
    [`datacontract-${p}-database`]: s.database,
  };
  if (dialect === 'sqlserver') {
    h['datacontract-sqlserver-encrypted-connection'] = s.tls.mode === 'off' ? 'false' : 'true';
    h['datacontract-sqlserver-trust-server-certificate'] = s.tls.mode === 'require' ? 'true' : 'false';
  }
  if (secrets.username) h[`datacontract-${p}-username`] = secrets.username;
  if (secrets.password) h[`datacontract-${p}-password`] = secrets.password;
  return h;
}

/** The service platform's URL, through the outbound policy like every platform request. */
async function serviceUrl(service: Platform, secrets: Record<string, string>, path: string): Promise<void> {
  const target = await buildUrl(service, secrets, path, {});
  await assertOutboundAllowed(target, outboundContext(), { platformOrigins: (await credentialsAllowed(service, secrets, target)) ? [target] : [] });
}

type Obj = Record<string, unknown>;
const RESULTS: Record<string, DataContractResult> = { passed: 'passed', warning: 'warning', failed: 'failed', error: 'error' };

/** The CLI's run as Steward stores it: counts, a headline, the report within the size limit. */
function judge(report: unknown): { result: DataContractResult; counts: { total: number; passed: number; warning: number; failed: number }; headline: string } {
  const r = report && typeof report === 'object' ? (report as Obj) : {};
  const checks = Array.isArray(r.checks) ? r.checks.filter((c): c is Obj => !!c && typeof c === 'object') : [];
  const counts = { total: checks.length, passed: 0, warning: 0, failed: 0 };
  for (const c of checks) {
    if (c.result === 'passed') counts.passed++;
    else if (c.result === 'warning') counts.warning++;
    else if (c.result === 'failed' || c.result === 'error') counts.failed++;
  }
  // unknown, skipped and info runs did not show the promise holds: a warning
  const result = RESULTS[String(r.result)] ?? (counts.failed ? 'failed' : 'warning');
  const problems = checks
    .filter((c) => c.result !== 'passed')
    .slice(0, 3)
    .map((c) => `${String(c.name ?? c.type ?? 'check')}${c.reason ? `: ${String(c.reason)}` : ''}`);
  const headline = problems.length ? problems.join('; ') : counts.total ? `${counts.passed} of ${counts.total} checks passed` : 'No checks ran';
  return { result, counts, headline: headline.slice(0, 500) };
}

/** The report as stored: secrets masked, logs and then checks cut when it is larger than the limit. */
function storedReport(report: unknown, secrets: Record<string, string>): { text: string; truncated: boolean } {
  const masked = redactSecrets(report, secrets);
  let text = JSON.stringify(masked ?? null);
  if (Buffer.byteLength(text) <= L.reportBytes) return { text, truncated: false };
  const r: Obj = masked && typeof masked === 'object' ? { ...(masked as Obj) } : { value: String(text).slice(0, 1000) };
  r.logs = [];
  const checks = Array.isArray(r.checks) ? [...(r.checks as unknown[])] : [];
  for (let n = checks.length; n >= 0; n = Math.floor(n / 2)) {
    r.checks = checks.slice(0, n);
    r.truncated = true;
    text = JSON.stringify(r);
    if (Buffer.byteLength(text) <= L.reportBytes || n === 0) break;
  }
  return { text: Buffer.byteLength(text) <= L.reportBytes ? text : JSON.stringify({ truncated: true, result: r.result ?? null }), truncated: true };
}

/**
 * Runs the contract's test now and stores the run (evidence). A test that could not be prepared (no service, no
 * linked server, missing rights) throws; a test the service refused or could not finish is stored as result "error".
 */
export async function runContractTest(contractId: string, opts: TestOptions): Promise<DataContractRun> {
  if (!vault().unlocked) throw new HttpError(503, 'The vault is locked', 'VAULT_LOCKED');
  const x = prepare(contractId, opts);
  // the credentials through the resolver (ADR 0009): the default identities of the service and the database
  const { platform: service, secrets: serviceSecrets } = getConnection(x.service.id);
  const { secrets: dbSecrets } = getConnection(x.database.id);
  const allSecrets = maskable(serviceSecrets, dbSecrets);
  // the tested server goes through the outbound policy as a connection of Steward's own would, and the service is sent
  // the address Steward checked
  const host = await testedHost(x.settings);
  await serviceUrl(service, serviceSecrets, '/test');
  const started = Date.now();
  const startedAt = nowIso();
  let report: unknown;
  let judged: ReturnType<typeof judge>;
  try {
    const timeout = Math.min(Math.max(opts.timeoutMs ?? 120_000, 1_000), 300_000);
    // Steward's own call: /test is refused for this kind from steps, the explorer and the MCP gateway (deniedPaths.ts)
    const res = await ownCall(DATA_CONTRACT_SERVICE_KIND, () =>
      platformRequest(
        service,
        serviceSecrets,
        {
          method: 'POST',
          url: '/test',
          query: { server: x.server },
          headers: { 'content-type': 'application/yaml', accept: 'application/json', ...serverHeaders(x.settings.dialect, x.settings, dbSecrets, host) },
          body: x.yaml,
          bodyType: 'text',
          maxResponseBytes: 20 * 1024 * 1024,
          // the headers carry the tested server's credentials: a redirect is answered, not followed
          noRedirects: true,
        },
        AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(timeout)]),
      ),
    );
    if (res.ok && res.body && typeof res.body === 'object') {
      report = res.body;
      judged = judge(report);
    } else {
      const detail = res.body && typeof res.body === 'object' ? (res.body as Obj).detail : res.body;
      report = { result: 'error', status: res.status, detail: typeof detail === 'string' ? detail.slice(0, 2000) : (detail ?? null) };
      judged = {
        result: 'error',
        counts: { total: 0, passed: 0, warning: 0, failed: 0 },
        headline: `The service answered HTTP ${res.status}${typeof detail === 'string' ? `: ${detail.slice(0, 300)}` : ''}`,
      };
    }
  } catch (e) {
    const message = (e as Error).message;
    report = { result: 'error', detail: message.slice(0, 2000) };
    judged = {
      result: 'error',
      counts: { total: 0, passed: 0, warning: 0, failed: 0 },
      headline: `The service could not be reached: ${message.slice(0, 300)}`,
    };
  }
  const stored = storedReport(report, allSecrets);
  const headline = redactSecrets(judged.headline, allSecrets);
  const run: RunRow = {
    id: newId('dcr_'),
    contract_id: x.row.id,
    version: x.version,
    result: judged.result,
    via: opts.via,
    source_id: opts.sourceId ?? null,
    service_platform_id: x.service.id,
    server: x.server,
    checks_total: judged.counts.total,
    checks_passed: judged.counts.passed,
    checks_warning: judged.counts.warning,
    checks_failed: judged.counts.failed,
    headline,
    report: stored.text,
    report_sha256: sha256(stored.text),
    truncated: stored.truncated ? 1 : 0,
    dry_run: opts.dryRun ? 1 : 0,
    started_at: startedAt,
    duration_ms: Date.now() - started,
    actor: currentUser()?.username ?? 'system',
  };
  const before = lastRun(x.row.id, { realOnly: true });
  db().tx(() => {
    db().run(
      `INSERT INTO data_contract_runs (id, contract_id, version, result, via, source_id, service_platform_id, server, checks_total, checks_passed, checks_warning,
         checks_failed, headline, report, report_sha256, truncated, dry_run, started_at, duration_ms, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.contract_id,
      run.version,
      run.result,
      run.via,
      run.source_id,
      run.service_platform_id,
      run.server,
      run.checks_total,
      run.checks_passed,
      run.checks_warning,
      run.checks_failed,
      run.headline,
      run.report,
      run.report_sha256,
      run.truncated,
      run.dry_run,
      run.started_at,
      run.duration_ms,
      run.actor,
    );
    pruneRuns(x.row.id);
    audit({
      action: 'contract.tested',
      entityType: 'contract',
      entityId: x.row.id,
      summary: `Data contract "${x.row.name}" v${x.version} tested on server ${x.server} through "${x.service.name}": ${run.result} (${run.checks_passed}/${run.checks_total} checks passed)${opts.dryRun ? ' – dry run' : ''}`,
      details: { run: run.id, result: run.result, via: run.via, source: run.source_id, reportSha256: run.report_sha256 },
    });
  });
  if (!opts.dryRun && (run.result === 'failed' || run.result === 'error') && !(before && (before.result === 'failed' || before.result === 'error')))
    notifyContractFailed(x.row, run, opts);
  return getRun(x.row.id, run.id);
}

/** Credential fields that identify rather than authenticate: not masked (as platforms/http.ts secretValues). */
const IDENTIFIERS = new Set(['user', 'username', 'login', 'account', 'clientid', 'client_id', 'tenant', 'tenantid', 'tenant_id', 'email']);
/** The secrets of both platforms as one record for masking (keys made unique; identifiers left out). */
const maskable = (...all: Record<string, string>[]): Record<string, string> =>
  Object.fromEntries(
    all
      .flatMap((s) => Object.entries(s))
      .filter(([k]) => !IDENTIFIERS.has(k.toLowerCase()))
      .map(([, v], i) => [`secret${i}`, v]),
  );

/**
 * Keeps the evidence of a contract's tests (docs/DATA-CONTRACTS.md#limits): the newest real runs (runsKept), failed
 * runs and errors beyond them (the newest failedRunsKept of those), and dry runs on their own (dryRunsKept) – many dry
 * runs or passing runs do not push out the record of a failure.
 */
function pruneRuns(contractId: string): void {
  const cut = (where: string, keep: number) =>
    db().get<{ started_at: string }>(
      `SELECT started_at FROM data_contract_runs WHERE contract_id = ? AND ${where} ORDER BY started_at DESC, id DESC LIMIT 1 OFFSET ?`,
      contractId,
      keep,
    )?.started_at;
  const failed = "result IN ('failed', 'error')";
  const dry = cut('dry_run = 1', L.dryRunsKept);
  if (dry) db().run('DELETE FROM data_contract_runs WHERE contract_id = ? AND dry_run = 1 AND started_at <= ?', contractId, dry);
  const real = cut('dry_run = 0', L.runsKept);
  if (real) db().run(`DELETE FROM data_contract_runs WHERE contract_id = ? AND dry_run = 0 AND NOT ${failed} AND started_at <= ?`, contractId, real);
  const bad = cut(`dry_run = 0 AND ${failed}`, L.failedRunsKept);
  if (bad) db().run(`DELETE FROM data_contract_runs WHERE contract_id = ? AND dry_run = 0 AND ${failed} AND started_at <= ?`, contractId, bad);
}

// ---------- the service's lint ----------

/** The CLI's own lint of a text (no data source is contacted, no credentials are sent). */
export async function lintWithService(contractId: string, yaml?: string): Promise<DataContractLintFinding[]> {
  const { row } = visibleContract(contractId);
  if (!row.service_platform_id) throw new HttpError(409, 'No data contract service is set for this contract', 'DATA_CONTRACT_NO_SERVICE');
  const { platform: service, secrets } = getConnection(usable(row.service_platform_id, DATA_CONTRACT_SERVICE_KIND, 'Data contract service').id);
  await serviceUrl(service, secrets, '/lint');
  const text = yaml ?? currentDoc(row).yaml;
  const res = await ownCall(DATA_CONTRACT_SERVICE_KIND, () =>
    platformRequest(
      service,
      secrets,
      {
        method: 'POST',
        url: '/lint',
        query: { all_errors: 'true' },
        headers: { 'content-type': 'application/yaml' },
        body: text,
        bodyType: 'text',
        maxResponseBytes: 5 * 1024 * 1024,
        noRedirects: true,
      },
      AbortSignal.timeout(60_000),
    ),
  );
  if (!res.ok || !res.body || typeof res.body !== 'object')
    throw new HttpError(502, `The data contract service answered HTTP ${res.status}`, 'DATA_CONTRACT_SERVICE_FAILED', { status: res.status });
  const checks = Array.isArray((res.body as Obj).checks) ? ((res.body as Obj).checks as Obj[]) : [];
  return redactSecrets(
    checks
      .filter((c) => c && typeof c === 'object' && c.result !== 'passed')
      .slice(0, L.lintFindings)
      .map((c): DataContractLintFinding => ({
        path: String(c.field ?? c.model ?? '/').slice(0, 300),
        message: String(c.reason ?? c.name ?? 'Lint finding').slice(0, 500),
        severity: c.result === 'warning' ? 'warning' : c.result === 'info' ? 'info' : 'error',
        source: 'service',
      })),
    secrets,
  );
}

// ---------- the message to the owning team ----------

/**
 * A test failed (and the one before did not): the members of the contract's owning teams who may see it hear of it –
 * through the routes of the event contract.failed, or the policy of the schedule or trigger whose run tested it – and
 * the owning teams' own channels get it too. A contract without an owning team: whoever saved it last. Opening a
 * vendor ticket stays a person's decision (docs/DATA-CONTRACTS.md#notifications).
 */
export function notifyContractFailed(row: ContractRow, run: RunRow, opts: Pick<TestOptions, 'via' | 'sourceId'>): void {
  try {
    const users = listUsers().filter((u) => u.active);
    const teams = new Set(owningTeams('contract', row.id).map((t) => t.id));
    const sees = (u: UserInfo) => contractAccess(toAuthUser(u), { id: row.id }).permissions.includes('view');
    let recipients = teams.size ? users.filter((u) => teamMember(u, teams) && sees(u)) : [];
    if (!teams.size) recipients = users.filter((u) => u.username.toLowerCase() === row.updated_by.toLowerCase() && sees(u));
    const source = opts.via === 'process' && opts.sourceId ? sourceOfRun(opts.sourceId) : null;
    notify({
      event: 'contract.failed',
      text: (l) => ({
        title: t(l, 'contractFailed.title', { name: titleName(row.name) }),
        body: t(l, 'contractFailed.body', {
          name: row.name,
          version: String(run.version),
          server: run.server ?? '–',
          result: run.result,
          headline: run.headline.slice(0, 500),
        }),
      }),
      link: `/data-contracts/${encodeURIComponent(row.id)}/tests?run=${encodeURIComponent(run.id)}`,
      recipients,
      inAppKey: `contract:${row.id}:${run.id}`,
      externalKey: `contract:${row.id}`,
      data: { contractId: row.id, key: row.contract_key, name: row.name, version: run.version, result: run.result, run: run.id },
      source,
      ...(opts.via === 'process' && opts.sourceId ? { runId: opts.sourceId } : {}),
      about: { kind: 'contract', id: row.id },
    });
  } catch (err) {
    logger.warn({ err, contract: row.id }, 'could not notify about a failed data contract test');
  }
}

function teamMember(u: UserInfo, teams: Set<string>): boolean {
  const ids = db()
    .all<{ team_id: string }>('SELECT team_id FROM team_members WHERE user_id = ?', u.id)
    .map((r) => r.team_id);
  return ids.some((id) => teams.has(id));
}

/** For the monitor check and the process step: a test with the rights of `username` (a monitor owner, a run's actor). */
export async function runContractTestAs(username: string, contractId: string, opts: TestOptions): Promise<DataContractRun> {
  const u = listUsers().find((x) => x.username.toLowerCase() === username.toLowerCase());
  if (!u || !u.active) throw new HttpError(403, `${username} is missing or deactivated`, 'DATA_CONTRACT_ACTOR_INACTIVE', { user: username });
  return runAs(toAuthUser(u), () => runContractTest(contractId, opts));
}

export { permissionsOf };
