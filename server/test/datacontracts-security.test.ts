import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { DATA_CONTRACT_LIMITS, DATA_CONTRACT_SERVICE_KIND, DATABASE_KIND } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Regression tests of the 0.9.0 security review of data contracts (#221) through the API: SQL quality rules need the
 * "use" right on the linked database platform and pass Steward's statement check, on save and before each test (M1);
 * the data contract service is refused to ad-hoc requests (M2); TLS of the tested platform is honoured (M3); the tested
 * host is resolved and checked by Steward (L4); the change record rule cannot be got around (L1); scorecard history
 * hides contracts the reader may not see (L2); failed test reports are kept (L3). Without a server:
 * datacontracts-security-unit.test.ts.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
const KEY = 'demo-datacontract-key';

let s: TestServer;
let dana: Client;
let olivia: Client;
let adam: Client;
let shop: string;
let service: string;
let orders: { id: string; key: string };

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: { status: number; body: Record<string, unknown> }) => e,
  );
type Call = { path: string; server: string | null; headerNames: string[]; settings?: Record<string, string>; contractId: string | null };
const calls = async (): Promise<Call[]> => (await fetch(`${s.base}/mock/datacontract/_mock/calls`, { headers: { 'x-api-key': KEY } })).json();
const resetMock = () => fetch(`${s.base}/mock/datacontract/_mock/reset`, { method: 'POST', headers: { 'x-api-key': KEY } });
const auditOf = async (action: string) => (await s.api('GET', `/audit?action=${action}&limit=100`)) as { summary: string; details?: any }[];

function contractYaml(id: string, extra: (doc: any) => void = () => {}, type = 'postgresql'): string {
  const doc: any = {
    apiVersion: 'v3.0.2',
    kind: 'DataContract',
    id,
    name: `Contract ${id}`,
    version: '1.0.0',
    status: 'active',
    servers: [{ server: 'production', type, host: 'postgres.demo.invalid', port: 5432, database: 'shop' }],
    schema: [
      {
        name: 'products',
        physicalName: 'public.products',
        properties: [
          { name: 'id', logicalType: 'integer', required: true },
          { name: 'sku', logicalType: 'string', required: true },
        ],
      },
    ],
  };
  extra(doc);
  return YAML.stringify(doc);
}
const withSql = (query: string) => (d: any) => (d.schema[0].quality = [{ type: 'sql', name: 'some rows', query, mustBeGreaterThan: 0 }]);

/** A database platform of Steward (not the demo database): the service is asked to connect where it points. */
async function databasePlatform(name: string, database: Record<string, unknown>): Promise<string> {
  return (
    await s.api('POST', '/platforms', {
      name,
      kind: DATABASE_KIND,
      baseUrl: '',
      config: { auth: { type: 'none' }, variables: {}, http: {}, database: { port: 55432, database: 'shop', limits: {}, auth: 'password', ...database } },
      secrets: { username: 'reader', password: 'reader-password-1' },
    })
  ).id;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
  adam = await s.as('adam', PW);
  const platforms = await s.api('GET', '/platforms');
  shop = platforms.find((p: { kind: string; name: string }) => p.kind === DATABASE_KIND && p.name === 'Shop database (demo)').id;
  service = platforms.find((p: { kind: string }) => p.kind === DATA_CONTRACT_SERVICE_KIND).id;
  orders = (await s.api('GET', '/data-contracts')).find((c: { key: string }) => c.key === 'shop-orders');
}, 120_000);
afterAll(async () => {
  await s?.app.close();
});

describe('M1: SQL quality rules', () => {
  it('pass the statement check on save – a refused rule is named, and the editor sees it before saving', async () => {
    const bad = contractYaml('sql-refused', withSql('WITH d AS (DELETE FROM products RETURNING 1) SELECT count(*) FROM d'));
    const r = await failure(dana('POST', '/data-contracts', { yaml: bad }));
    expect(r).toMatchObject({ status: 400, body: { code: 'DATA_CONTRACT_SQL_REFUSED', params: { rule: 'some rows', path: '/schema/0/quality/0' } } });
    const preview = await dana('POST', '/data-contracts/check', { yaml: bad });
    expect(preview.facts).toBeNull();
    expect(preview.lint[0]).toMatchObject({ path: '/schema/0/quality/0', severity: 'error' });
    // a variable the service would fill in from its own environment
    expect(
      await failure(
        dana('POST', '/data-contracts', {
          yaml: contractYaml('sql-variable', withSql("SELECT count(*) FROM {model} WHERE '${DATACONTRACT_CLI_API_KEY}' > ''")),
        }),
      ),
    ).toMatchObject({ status: 400, body: { code: 'DATA_CONTRACT_SQL_REFUSED' } });
    // a plain read with the CLI's placeholders is fine
    const ok = await dana('POST', '/data-contracts', {
      yaml: contractYaml('sql-ok', withSql('SELECT COUNT(*) FROM {model}')),
      links: [{ kind: 'server', targetId: shop, detail: 'production' }],
      settings: { servicePlatformId: service },
    });
    expect(ok.currentVersion).toBe(1);
  });

  it('need the "use" right on the linked database platform to save them, and again for every test', async () => {
    const yaml = contractYaml('sql-rights', withSql('SELECT COUNT(*) FROM {model}'));
    const c = await dana('POST', '/data-contracts', {
      yaml,
      links: [{ kind: 'server', targetId: shop, detail: 'production' }],
      settings: { servicePlatformId: service },
    });
    const run = await olivia('POST', `/data-contracts/${c.id}/test`, {});
    expect(run.result).not.toBe('error');
    // the shop database: only olivia may use it now – dana keeps the edit right on the contract
    await s.api('PUT', `/platforms/${shop}/access`, { acl: [{ subject: 'user:olivia', permissions: ['use'] }] });
    try {
      const next = YAML.parse(yaml);
      next.schema[0].quality[0].query = 'SELECT ascii(substr((SELECT secret FROM t LIMIT 1),1,1))';
      const refused = await failure(dana('POST', `/data-contracts/${c.id}/versions`, { yaml: YAML.stringify(next) }));
      // the platform dana may not see is not named
      expect(refused).toMatchObject({ status: 403, body: { code: 'DATA_CONTRACT_SQL_NEEDS_USE' } });
      expect(JSON.stringify(refused.body)).not.toContain('Shop database');
      // a new contract with the rule and the link, or an import of it: refused the same way (the link needs "use" too)
      expect((await failure(dana('POST', '/data-contracts/import', { yaml: YAML.stringify(next) }))).status).toBe(403);
      // a test re-checks "use" for whoever runs it: dana (UI), a monitor owned by dana, a process run by dana
      await resetMock();
      expect((await failure(dana('POST', `/data-contracts/${c.id}/test`, {}))).status).toBeGreaterThanOrEqual(400);
      const check = await dana('POST', '/monitors/check-preview', { check: { id: 'c', name: 'Contract', type: 'data-contract', contract: c.id } });
      expect(check).toMatchObject({ status: 'unknown', message: expect.stringContaining('not found') });
      const { runContractTestAs } = await import('../src/datacontracts/testing.js');
      await expect(runContractTestAs('dana', c.id, { via: 'process', sourceId: 'run_x' })).rejects.toMatchObject({ statusCode: 400 });
      expect(await calls()).toEqual([]);
    } finally {
      await s.api('PUT', `/platforms/${shop}/access`, { acl: [] });
    }
  });

  it('are checked again before each test, for the tested platform’s DBMS', async () => {
    // a version stored before the check existed (written to the table directly)
    const c = await dana('POST', '/data-contracts', {
      yaml: contractYaml('sql-stored', withSql('SELECT COUNT(*) FROM {model}')),
      links: [{ kind: 'server', targetId: shop, detail: 'production' }],
      settings: { servicePlatformId: service },
    });
    const { db } = await import('../src/db.js');
    db().run(
      'UPDATE data_contract_versions SET yaml = ? WHERE contract_id = ?',
      contractYaml('sql-stored', withSql('SELECT pg_terminate_backend(pid) FROM pg_stat_activity')),
      c.id,
    );
    await resetMock();
    expect(await failure(dana('POST', `/data-contracts/${c.id}/test`, {}))).toMatchObject({ status: 400, body: { code: 'DATA_CONTRACT_SQL_REFUSED' } });
    expect(await calls()).toEqual([]);
  });
});

describe('M2: the data contract service answers Steward’s own tests only', () => {
  it('refuses /test and /lint from ad-hoc requests (the explorer, the MCP gateway and process steps use the same path)', async () => {
    const yaml = contractYaml('m2', (d) => (d.servers[0].host = 'steward-db.internal'));
    for (const req of [
      {
        method: 'POST',
        path: '/test',
        query: { server: 'production' },
        headers: { 'content-type': 'application/yaml', 'datacontract-postgres-host': '10.0.0.5' },
        body: yaml,
      },
      { method: 'POST', path: '/lint', body: yaml },
      { method: 'GET', path: '/test' },
    ])
      expect(await failure(s.api('POST', `/platforms/${service}/request`, req))).toMatchObject({ status: 403, body: { code: 'PLATFORM_PATH_DENIED' } });
    // reading the API description (the connection test) still works
    expect((await s.api('POST', `/platforms/${service}/request`, { method: 'GET', path: '/openapi.json' })).status).toBe(200);
    // Steward's own test and lint go through
    await resetMock();
    await olivia('POST', `/data-contracts/${orders.id}/test`, {});
    await s.api('POST', `/data-contracts/${orders.id}/service-lint`, {});
    expect((await calls()).map((c) => c.path).sort()).toEqual(['/lint', '/test']);
  });

  it('refuses /test and /lint sent by a platform of another kind to the service’s address (the destination’s rules)', async () => {
    const svc = (await s.api('GET', `/platforms/${service}`)) as { baseUrl: string };
    const other = await s.api('POST', '/platforms', {
      name: 'Generic at the contract service',
      kind: 'generic',
      baseUrl: svc.baseUrl,
      config: { auth: { type: 'none' }, variables: {}, http: {} },
    });
    await resetMock();
    for (const req of [
      { method: 'POST', path: '/lint', body: contractYaml('m2-dest', () => {}) },
      { method: 'POST', path: '/test', query: { server: 'production' }, body: 'x' },
    ])
      expect(await failure(s.api('POST', `/platforms/${other.id}/request`, req))).toMatchObject({ status: 403, body: { code: 'PLATFORM_PATH_DENIED' } });
    expect(await calls()).toEqual([]);
    await s.api('DELETE', `/platforms/${other.id}`);
  });
});

describe('M3 and L4: TLS and the tested host', () => {
  const linked = async (id: string, platform: string, type = 'postgresql') =>
    s.api('POST', '/data-contracts', {
      yaml: contractYaml(id, () => {}, type),
      links: [{ kind: 'server', targetId: platform, detail: 'production' }],
      settings: { servicePlatformId: service },
    });

  it('refuses PostgreSQL and MySQL with TLS on unless the platform allows the service to connect without verification (audited)', async () => {
    const pg = await databasePlatform('TLS PostgreSQL', { dialect: 'postgresql', host: '127.0.0.1', tls: { mode: 'verify' } });
    const c = await linked('m3-pg', pg);
    await resetMock();
    const refused = await failure(s.api('POST', `/data-contracts/${c.id}/test`, {}));
    expect(refused).toMatchObject({ status: 409, body: { code: 'DATA_CONTRACT_TLS_UNVERIFIED', params: { name: 'TLS PostgreSQL', mode: 'verify' } } });
    const my = await databasePlatform('TLS MySQL', { dialect: 'mysql', host: '127.0.0.1', port: 53306, tls: { mode: 'require' } });
    const m = await linked('m3-my', my, 'mysql');
    expect(await failure(s.api('POST', `/data-contracts/${m.id}/test`, {}))).toMatchObject({ status: 409, body: { code: 'DATA_CONTRACT_TLS_UNVERIFIED' } });
    expect(await calls()).toEqual([]);
    // the platform's manager allows it
    const settings = (await s.api('GET', `/platforms/${pg}`)).config.database;
    await s.api('PUT', `/platforms/${pg}/database`, { ...settings, tls: { ...settings.tls, contractServiceUnverified: true } });
    expect((await auditOf('platform.database_changed')).some((a) => a.summary.includes('without certificate verification allowed'))).toBe(true);
    const run = await s.api('POST', `/data-contracts/${c.id}/test`, {});
    expect(run.server).toBe('production');
    expect((await calls())[0]).toMatchObject({ path: '/test', contractId: 'm3-pg' });
  });

  it('passes SQL Server its TLS settings as the CLI takes them', async () => {
    const ms = await databasePlatform('TLS SQL Server', { dialect: 'sqlserver', host: 'localhost', port: 51433, tls: { mode: 'verify' } });
    const c = await linked('m3-ms', ms, 'sqlserver');
    await resetMock();
    await s.api('POST', `/data-contracts/${c.id}/test`, {});
    expect((await calls())[0]!.settings).toMatchObject({
      'datacontract-sqlserver-encrypted-connection': 'true',
      'datacontract-sqlserver-trust-server-certificate': 'false',
      // "verify" checks the certificate against the name: the name is sent (it resolved on Steward's side)
      'datacontract-sqlserver-host': 'localhost',
    });
  });

  it('sends the address Steward resolved and checked; a name it cannot resolve is refused', async () => {
    const pg = await databasePlatform('Resolved PostgreSQL', { dialect: 'postgresql', host: 'localhost', tls: { mode: 'off' } });
    const c = await linked('l4-resolved', pg);
    await resetMock();
    await s.api('POST', `/data-contracts/${c.id}/test`, {});
    const host = (await calls())[0]!.settings!['datacontract-postgres-host'];
    expect(['127.0.0.1', '::1']).toContain(host);
    const gone = await databasePlatform('Unresolvable PostgreSQL', { dialect: 'postgresql', host: 'db.nowhere.invalid', tls: { mode: 'off' } });
    const u = await linked('l4-unresolved', gone);
    expect(await failure(s.api('POST', `/data-contracts/${u.id}/test`, {}))).toMatchObject({
      status: 409,
      body: { code: 'DATA_CONTRACT_HOST_UNRESOLVED', params: { host: 'db.nowhere.invalid' } },
    });
  });
});

describe('L1: the change record rule', () => {
  const breaking = (yaml: string) => {
    const d = YAML.parse(yaml);
    d.schema[0].properties.pop();
    d.version = `${d.version}.1`;
    return YAML.stringify(d);
  };
  const approvedRecord = async (title: string) => {
    const cr = await dana('POST', '/records', {
      type: 'CR',
      title,
      fields: { reason: 'A field goes', risk: 'low', rollbackPlan: 'Save the version before again' },
      body: '## Description\n\nText.\n',
    });
    await dana('POST', `/records/${cr.id}/transition`, { action: 'submit' });
    await adam('POST', `/records/${cr.id}/transition`, { action: 'approve' });
    return cr.id as string;
  };

  it('is switched off only by who approves changes (manage), audited', async () => {
    const c = await dana('POST', '/data-contracts', { yaml: contractYaml('l1-switch'), settings: { servicePlatformId: service, requireChangeRecord: true } });
    expect(c.permissions).toEqual(['view', 'test', 'edit']);
    const off = { servicePlatformId: service, testServer: null, requireChangeRecord: false };
    expect(await failure(dana('PUT', `/data-contracts/${c.id}/settings`, off))).toMatchObject({ status: 403 });
    expect((await adam('GET', `/data-contracts/${c.id}`)).permissions).toEqual(['view', 'manage']);
    expect((await adam('PUT', `/data-contracts/${c.id}/settings`, off)).requireChangeRecord).toBe(false);
    const a = (await auditOf('contract.settings_changed')).find((x) => x.summary.includes('Contract l1-switch'))!;
    expect(a.summary).toContain('switched off');
    expect(a.details).toMatchObject({ requireChangeRecord: { before: true, after: false } });
    // switching it on stays with the editors
    expect((await dana('PUT', `/data-contracts/${c.id}/settings`, { ...off, requireChangeRecord: true })).requireChangeRecord).toBe(true);
  });

  it('takes one change record per version: not again, not for another contract', async () => {
    const yamlA = contractYaml('l1-record-a');
    const yamlB = contractYaml('l1-record-b');
    const a = await dana('POST', '/data-contracts', { yaml: yamlA, settings: { requireChangeRecord: true } });
    const b = await dana('POST', '/data-contracts', { yaml: yamlB, settings: { requireChangeRecord: true } });
    const cr = await approvedRecord('Contract changes');
    await dana('POST', `/data-contracts/${a.id}/versions`, { yaml: breaking(yamlA), changeRecordId: cr });
    expect(await failure(dana('POST', `/data-contracts/${b.id}/versions`, { yaml: breaking(yamlB), changeRecordId: cr }))).toMatchObject({
      status: 409,
      body: { code: 'DATA_CONTRACT_CHANGE_RECORD_USED' },
    });
    const again = YAML.parse(breaking(yamlA));
    again.schema[0].properties = [];
    expect(await failure(dana('POST', `/data-contracts/${a.id}/versions`, { yaml: YAML.stringify(again), changeRecordId: cr }))).toMatchObject({
      status: 409,
      body: { code: 'DATA_CONTRACT_CHANGE_RECORD_USED' },
    });
  });

  it('survives deleting the contract and importing it again', async () => {
    const yaml = contractYaml('l1-reimport');
    const c = await dana('POST', '/data-contracts', { yaml, settings: { requireChangeRecord: true } });
    await dana('DELETE', `/data-contracts/${c.id}`);
    const imported = await dana('POST', '/data-contracts/import', { yaml });
    expect(imported).toMatchObject({ action: 'created', contract: { requireChangeRecord: true } });
    expect(await failure(dana('POST', `/data-contracts/${imported.contract.id}/versions`, { yaml: breaking(yaml) }))).toMatchObject({
      status: 409,
      body: { code: 'DATA_CONTRACT_NEEDS_CHANGE_RECORD' },
    });
  });

  it('sees renamed columns, moved servers, duplicates and values of the wrong type', async () => {
    const yaml = contractYaml('l1-diff', (d) => (d.schema[0].properties[0].physicalName = 'id'));
    const c = await dana('POST', '/data-contracts', { yaml, settings: { requireChangeRecord: true } });
    const moved = YAML.parse(yaml);
    moved.schema[0].properties[0].physicalName = 'legacy_id';
    moved.servers[0].host = 'other-db.internal';
    const p = await dana('POST', `/data-contracts/${c.id}/check`, { yaml: YAML.stringify(moved) });
    expect(p.diff.changes.map((x: { kind: string; breaking: boolean }) => `${x.kind}${x.breaking ? '!' : ''}`).sort()).toEqual([
      'physical-name-changed!',
      'server-changed!',
    ]);
    expect(p.needsChangeRecord).toBe(true);
    for (const f of [
      (d: any) => d.schema[0].properties.push({ name: 'id', logicalType: 'string' }),
      (d: any) => (d.schema[0].properties[1].required = 'true'),
      (d: any) => (d.schema[0].quality = [{ rule: 'rowCount', mustBeGreaterThan: '5' }]),
    ]) {
      const d = YAML.parse(yaml);
      f(d);
      expect(await failure(dana('POST', `/data-contracts/${c.id}/versions`, { yaml: YAML.stringify(d) }))).toMatchObject({
        status: 400,
        body: { code: 'DATA_CONTRACT_INVALID' },
      });
    }
  });
});

describe('L2 and L3: history and evidence', () => {
  it('the scorecard history shows the contracts part as hidden to a reader who may not see one of its contracts', async () => {
    const svc = await s.api('POST', '/services', { name: 'History shop', owners: [] });
    const app = await s.api('POST', '/applications', { name: 'History shop app', owners: [] });
    await s.api('PUT', `/services/${svc.id}/applications/${app.id}`, { role: 'primary' });
    const team = (await s.api('POST', '/teams', { name: 'History contract owners', members: ['olivia'] })).id;
    const c = await s.api('POST', '/data-contracts', { yaml: contractYaml('l2-hidden') });
    await s.api('PUT', `/owning-teams/contract/${c.id}`, { teamIds: [team] });
    await s.api('POST', `/data-contracts/${c.id}/links`, { kind: 'application', targetId: app.id });
    const jobs = await import('../src/scorecard/jobs.js');
    jobs.snapshotScorecards(Date.now(), true);
    // olivia (in the team) sees the stored status, dana does not – and the live card does not count it for dana either
    const mine = await olivia('GET', `/scorecard/services/${svc.id}`);
    expect(mine.history.at(-1).parts.contracts).toBe('pending');
    const theirs = await dana('GET', `/scorecard/services/${svc.id}`);
    expect(theirs.contracts.status).toBe('none');
    expect(theirs.history.at(-1).parts.contracts).toBe('hidden');
    const trend = await dana('GET', '/scorecard/trend?days=2');
    expect(trend.at(-1).parts.contracts.hidden).toBeGreaterThan(0);
  });

  it('keeps failed test reports and real runs: many dry or passing runs do not push them out', async () => {
    const c = await s.api('POST', '/data-contracts', {
      yaml: contractYaml('l3-evidence'),
      links: [{ kind: 'server', targetId: shop, detail: 'production' }],
      settings: { servicePlatformId: service },
    });
    const { db } = await import('../src/db.js');
    const insert = (id: string, at: string, result: string, dry: number) =>
      db().run(
        `INSERT INTO data_contract_runs (id, contract_id, version, result, via, source_id, service_platform_id, server, checks_total, checks_passed, checks_warning,
           checks_failed, headline, report, report_sha256, truncated, dry_run, started_at, duration_ms, actor) VALUES (?, ?, 1, ?, 'process', NULL, ?, 'production', 1, 0, 0, 1, '', '{}', '', 0, ?, ?, 0, 'dana')`,
        id,
        c.id,
        result,
        service,
        dry,
        at,
      );
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    insert('dcr_failed_old', at(0), 'failed', 0);
    for (let i = 1; i <= DATA_CONTRACT_LIMITS.runsKept + 20; i++) insert(`dcr_pass_${i}`, at(i), 'passed', 0);
    for (let i = 1; i <= DATA_CONTRACT_LIMITS.dryRunsKept + 50; i++) insert(`dcr_dry_${i}`, at(10_000 + i), 'failed', 1);
    // a new test prunes
    await s.api('POST', `/data-contracts/${c.id}/test`, {});
    const count = (where: string) => db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM data_contract_runs WHERE contract_id = ? AND ${where}`, c.id)!.n;
    expect(count("id = 'dcr_failed_old'")).toBe(1);
    expect(count("id = 'dcr_pass_1'")).toBe(0);
    expect(count("dry_run = 0 AND result NOT IN ('failed', 'error')")).toBeLessThanOrEqual(DATA_CONTRACT_LIMITS.runsKept);
    expect(count("id LIKE 'dcr_pass_%'")).toBeGreaterThanOrEqual(DATA_CONTRACT_LIMITS.runsKept - 1);
    expect(count('dry_run = 1')).toBe(DATA_CONTRACT_LIMITS.dryRunsKept);
  });
});
