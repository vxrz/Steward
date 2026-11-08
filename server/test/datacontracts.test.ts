import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { DATA_CONTRACT_SERVICE_KIND, DATABASE_KIND } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Data contracts through the API (#221): the demo's contracts and their first tests, creating and saving versions (lint
 * on save, breaking changes, the change record a contract can require), links (only what the caller may see, server
 * links need "use"), tests through the data contract service (credentials per request in the CLI's headers, never in
 * the contract, the report or the audit log), Steward's own findings, drafts, import and export, rights, the monitor
 * check, the process step, the message to the owning team and the report section. Unit tests: datacontracts-unit.test.ts.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
const DB_PASSWORD = 'demo-reader-password';
const KEY = 'demo-datacontract-key';

let s: TestServer;
let dana: Client;
let olivia: Client;
let vera: Client;
let shop: string;
let service: string;
let orders: { id: string; key: string };
let customers: { id: string; key: string };

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: { status: number; body: Record<string, unknown> }) => e,
  );
const calls = async (): Promise<{ path: string; server: string | null; headerNames: string[]; credentialsMatched: boolean; contractId: string | null }[]> =>
  (await fetch(`${s.base}/mock/datacontract/_mock/calls`, { headers: { 'x-api-key': KEY } })).json();
const resetMock = () => fetch(`${s.base}/mock/datacontract/_mock/reset`, { method: 'POST', headers: { 'x-api-key': KEY } });
const auditOf = async (action: string) => (await s.api('GET', `/audit?action=${action}&limit=100`)) as { summary: string; details?: unknown }[];

/** A small valid contract of the demo shop's products table. */
function productsYaml(extra: (doc: any) => void = () => {}): string {
  const doc: any = {
    apiVersion: 'v3.0.2',
    kind: 'DataContract',
    id: 'shop-products',
    name: 'Shop products',
    version: '1.0.0',
    status: 'active',
    servers: [{ server: 'production', type: 'postgresql', host: 'postgres.demo.invalid', port: 5432, database: 'shop', schema: 'public' }],
    schema: [
      {
        name: 'products',
        physicalName: 'public.products',
        physicalType: 'table',
        properties: [
          { name: 'id', logicalType: 'integer', required: true },
          { name: 'sku', logicalType: 'string', required: true, logicalTypeOptions: { maxLength: 40 } },
          { name: 'title', logicalType: 'string' },
          { name: 'price', logicalType: 'number', quality: [{ rule: 'nullValues', mustBeLessThan: 5 }] },
        ],
      },
    ],
  };
  extra(doc);
  return YAML.stringify(doc);
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  const platforms = await s.api('GET', '/platforms');
  shop = platforms.find((p: { kind: string; name: string }) => p.kind === DATABASE_KIND && p.name === 'Shop database (demo)').id;
  service = platforms.find((p: { kind: string }) => p.kind === DATA_CONTRACT_SERVICE_KIND).id;
  const list = await s.api('GET', '/data-contracts');
  orders = list.find((c: { key: string }) => c.key === 'shop-orders');
  customers = list.find((c: { key: string }) => c.key === 'shop-customers');
}, 120_000);

describe('the demo', () => {
  it('has a data contract service and two contracts, tested once: orders hold, customers do not', async () => {
    expect(orders).toBeTruthy();
    expect(customers).toBeTruthy();
    const o = await s.api('GET', `/data-contracts/${orders.id}`);
    expect(o).toMatchObject({ key: 'shop-orders', status: 'active', currentVersion: 1, lintErrors: 0, servicePlatformId: service, testServer: 'production' });
    expect(o.lastRun.result).toBe('passed');
    expect(o.links.map((l: { kind: string }) => l.kind).sort()).toEqual(expect.arrayContaining(['server', 'table']));
    const c = await s.api('GET', `/data-contracts/${customers.id}`);
    expect(c.lastRun.result).toBe('failed');
    expect(c.findingList.map((f: { kind: string }) => f.kind)).toEqual(expect.arrayContaining(['lastTestFailed', 'noOwner']));
    const run = await s.api('GET', `/data-contracts/${customers.id}/runs/${c.lastRun.id}`);
    expect(run.headline).toContain('phone');
    expect(run.report.checks.some((x: { field?: string; result: string }) => x.field === 'phone' && x.result === 'failed')).toBe(true);
  });
});

describe('creating and saving', () => {
  it('creates a contract (lint on save), refuses what is not a contract, YAML bombs and oversized texts', async () => {
    const made = await dana('POST', '/data-contracts', { yaml: productsYaml() });
    expect(made).toMatchObject({ key: 'shop-products', currentVersion: 1, lint: [], permissions: ['view', 'test', 'edit'] });
    expect((await auditOf('contract.created')).some((a) => a.summary.includes('Shop products'))).toBe(true);
    // lint findings are stored with the version; the contract is still saved
    const linted = await dana('POST', '/data-contracts', {
      yaml: productsYaml((d) => {
        d.id = 'shop-products-linted';
        d.schema[0].properties[0].logicalType = 'int';
        d.unknownField = 1;
      }),
    });
    expect(linted.lintErrors).toBe(2);
    expect(linted.lint.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['/', '/schema/0/properties/0/logicalType']));
    // not a contract at all
    const notOdcs = await failure(dana('POST', '/data-contracts', { yaml: 'kind: Something\napiVersion: v2.2.0\n' }));
    expect(notOdcs).toMatchObject({ status: 400, body: { code: 'DATA_CONTRACT_INVALID' } });
    // a billion laughs: aliases are not expanded
    const bomb = [
      'a: &a [x,x,x,x,x,x,x,x,x,x]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]',
    ].join('\n');
    expect(await failure(dana('POST', '/data-contracts', { yaml: bomb }))).toMatchObject({ status: 400, body: { code: 'DATA_CONTRACT_INVALID' } });
    // nested deeper than allowed
    const deep = `${Array.from({ length: 40 }, (_, i) => `${'  '.repeat(i)}k${i}:`).join('\n')} 1\n`;
    expect(await failure(dana('POST', '/data-contracts', { yaml: deep }))).toMatchObject({ status: 400, body: { code: 'DATA_CONTRACT_INVALID' } });
    // larger than 1 MB
    const big = `apiVersion: v3.0.2\nkind: DataContract\nid: big\ndescription:\n  purpose: "${'x'.repeat(1024 * 1024 + 10)}"\n`;
    expect([400, 413]).toContain((await failure(dana('POST', '/data-contracts', { yaml: big }))).status);
    // a viewer and an operator may not create contracts
    expect((await failure(vera('POST', '/data-contracts', { yaml: productsYaml((d) => (d.id = 'v')) }))).status).toBe(403);
    expect((await failure(olivia('POST', '/data-contracts', { yaml: productsYaml((d) => (d.id = 'o')) }))).status).toBe(403);
  });

  it('saves versions with their changes; breaking changes are marked and can require an approved change record', async () => {
    // the demo's orders contract requires a change record for breaking changes
    const cur = await s.api('GET', `/data-contracts/${orders.id}`);
    const doc = YAML.parse(cur.yaml);
    doc.version = '2.0.0';
    doc.schema[0].properties = doc.schema[0].properties.filter((p: { name: string }) => p.name !== 'customer_id');
    doc.schema[0].properties.find((p: { name: string }) => p.name === 'status').logicalTypeOptions.maxLength = 10;
    doc.schema[0].properties.push({ name: 'channel', logicalType: 'string', required: true });
    doc.schema[0].properties.find((p: { name: string }) => p.name === 'total').quality[0].mustBeLessThan = 1;
    const yaml = YAML.stringify(doc);
    const preview = await dana('POST', `/data-contracts/${orders.id}/check`, { yaml });
    expect(preview.needsChangeRecord).toBe(true);
    const kinds = preview.diff.changes.map((c: { kind: string; breaking: boolean }) => `${c.kind}${c.breaking ? '!' : ''}`);
    expect(kinds).toEqual(expect.arrayContaining(['version-changed', 'field-removed!', 'type-narrowed!', 'field-added!', 'quality-tightened!']));
    expect(preview.diff.breaking).toBe(4);
    const refused = await failure(dana('POST', `/data-contracts/${orders.id}/versions`, { yaml }));
    expect(refused).toMatchObject({ status: 409, body: { code: 'DATA_CONTRACT_NEEDS_CHANGE_RECORD' } });
    // a change record that is not approved yet does not do
    const cr = await dana('POST', '/records', {
      type: 'CR',
      title: 'Orders contract 2.0',
      fields: { reason: 'Customer id moves to its own contract', risk: 'low', rollbackPlan: 'Save version 1 again' },
      body: '## Description\n\nText.\n',
    });
    expect(await failure(dana('POST', `/data-contracts/${orders.id}/versions`, { yaml, changeRecordId: cr.id }))).toMatchObject({
      status: 400,
      body: { code: 'DATA_CONTRACT_CHANGE_RECORD' },
    });
    await dana('POST', `/records/${cr.id}/transition`, { action: 'submit' });
    const adam = await s.as('adam', PW);
    await adam('POST', `/records/${cr.id}/transition`, { action: 'approve' });
    const saved = await dana('POST', `/data-contracts/${orders.id}/versions`, { yaml, changeRecordId: cr.id, note: 'Version 2' });
    expect(saved).toMatchObject({ created: true, contract: { currentVersion: 2, version: '2.0.0' } });
    const versions = await s.api('GET', `/data-contracts/${orders.id}/versions`);
    expect(versions[0]).toMatchObject({ version: 2, breaking: 4, note: 'Version 2', changeRecord: { id: cr.id } });
    const cmp = await s.api('GET', `/data-contracts/${orders.id}/compare?from=2&to=1`);
    expect(cmp.changes.some((c: { kind: string; field?: string }) => c.kind === 'field-added' && c.field === 'customer_id')).toBe(true);
    // the same text again saves nothing
    expect((await dana('POST', `/data-contracts/${orders.id}/versions`, { yaml })).created).toBe(false);
    expect((await auditOf('contract.version_saved')).some((a) => a.summary.includes('4 breaking'))).toBe(true);
  });
});

describe('links', () => {
  it('links what the caller may see; server links need the use right and a fitting DBMS', async () => {
    const c = await dana('POST', '/data-contracts', { yaml: productsYaml((d) => (d.id = 'shop-products-links')) });
    const bad = await failure(dana('POST', `/data-contracts/${c.id}/links`, { kind: 'application', targetId: 'app_missing' }));
    expect(bad).toMatchObject({ status: 400, body: { code: 'DATA_CONTRACT_LINK_TARGET' } });
    // a system of a team dana is not in reads like a missing one
    const team = (await s.api('POST', '/teams', { name: 'Contract owners', members: ['olivia'] })).id;
    const hidden = (await s.api('POST', '/systems', { name: 'Hidden warehouse', kind: 'server' })).id;
    await s.api('PUT', `/owning-teams/system/${hidden}`, { teamIds: [team] });
    const h = await failure(dana('POST', `/data-contracts/${c.id}/links`, { kind: 'system', targetId: hidden }));
    expect(h).toMatchObject({ status: 400, body: { code: 'DATA_CONTRACT_LINK_TARGET' } });
    // an admin may link it; dana sees the link without the system's name
    await s.api('POST', `/data-contracts/${c.id}/links`, { kind: 'system', targetId: hidden });
    const seen = await dana('GET', `/data-contracts/${c.id}`);
    expect(seen.links.find((l: { kind: string }) => l.kind === 'system')).toMatchObject({ name: null, detail: null, targetId: '' });
    expect(JSON.stringify(seen)).not.toContain(hidden);
    expect(JSON.stringify(seen)).not.toContain('Hidden warehouse');
    // a schema object the contract does not have
    expect(
      await failure(
        dana('POST', `/data-contracts/${c.id}/links`, { kind: 'table', targetKind: 'platform', targetId: shop, detail: 'public.x', schema: 'nope' }),
      ),
    ).toMatchObject({
      body: { code: 'DATA_CONTRACT_LINK_SCHEMA' },
    });
    // a server link: the server must be the contract's, the platform a database dana may use
    expect(await failure(dana('POST', `/data-contracts/${c.id}/links`, { kind: 'server', targetId: shop, detail: 'staging' }))).toMatchObject({
      body: { code: 'DATA_CONTRACT_LINK_SERVER' },
    });
    expect(await failure(dana('POST', `/data-contracts/${c.id}/links`, { kind: 'server', targetId: service, detail: 'production' }))).toMatchObject({
      body: { code: 'DATA_CONTRACT_LINK_NOT_DATABASE' },
    });
    const l = await dana('POST', `/data-contracts/${c.id}/links`, { kind: 'server', targetId: shop, detail: 'production' });
    expect(l).toMatchObject({ kind: 'server', name: 'Shop database (demo)' });
    // a second link for the same server replaces the first
    await dana('POST', `/data-contracts/${c.id}/links`, { kind: 'server', targetId: shop, detail: 'production' });
    expect((await dana('GET', `/data-contracts/${c.id}`)).links.filter((x: { kind: string }) => x.kind === 'server')).toHaveLength(1);
    await dana('DELETE', `/data-contracts/${c.id}/links/${l.id}`).catch(() => undefined);
    expect((await auditOf('contract.linked')).length).toBeGreaterThan(0);
  });
});

describe('testing through the data contract service', () => {
  it('sends the contract with the credentials in the CLI headers – never in the contract, the report or the audit log', async () => {
    await resetMock();
    const c = await dana('POST', '/data-contracts', {
      yaml: productsYaml((d) => (d.id = 'shop-products-tested')),
      links: [{ kind: 'server', targetId: shop, detail: 'production' }],
      settings: { servicePlatformId: service },
    });
    const run = await olivia('POST', `/data-contracts/${c.id}/test`, {});
    expect(run).toMatchObject({ result: 'passed', server: 'production', via: 'ui', actor: 'olivia', service: { id: service } });
    expect(run.checks.total).toBeGreaterThan(4);
    const [call] = await calls();
    expect(call).toMatchObject({ path: '/test', server: 'production', credentialsMatched: true, contractId: 'shop-products-tested' });
    expect(call!.headerNames).toEqual([
      'datacontract-postgres-database',
      'datacontract-postgres-host',
      'datacontract-postgres-password',
      'datacontract-postgres-port',
      'datacontract-postgres-username',
    ]);
    const stored = await s.api('GET', `/data-contracts/${c.id}`);
    expect(stored.yaml).not.toContain(DB_PASSWORD);
    const full = await s.api('GET', `/data-contracts/${c.id}/runs/${run.id}`);
    expect(JSON.stringify(full)).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(full)).not.toContain(KEY);
    expect(JSON.stringify(await auditOf('contract.tested'))).not.toContain(DB_PASSWORD);
    expect(full.reportSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a test without a service, an unlinked server, or the rights; a viewer may look but not test', async () => {
    const c = await dana('POST', '/data-contracts', { yaml: productsYaml((d) => (d.id = 'shop-products-untested')) });
    expect(await failure(dana('POST', `/data-contracts/${c.id}/test`, {}))).toMatchObject({ status: 409, body: { code: 'DATA_CONTRACT_NO_SERVICE' } });
    await dana('PUT', `/data-contracts/${c.id}/settings`, { servicePlatformId: service, testServer: null, requireChangeRecord: false });
    expect(await failure(dana('POST', `/data-contracts/${c.id}/test`, {}))).toMatchObject({ status: 409, body: { code: 'DATA_CONTRACT_SERVER_NOT_LINKED' } });
    expect((await vera('GET', `/data-contracts/${c.id}`)).permissions).toEqual(['view']);
    expect(await failure(vera('POST', `/data-contracts/${c.id}/test`, {}))).toMatchObject({ status: 403 });
    expect(await failure(vera('POST', `/data-contracts/${c.id}/versions`, { yaml: productsYaml() }))).toMatchObject({ status: 403 });
    // a service platform must be one: not a database platform
    expect(
      await failure(dana('PUT', `/data-contracts/${c.id}/settings`, { servicePlatformId: shop, testServer: null, requireChangeRecord: false })),
    ).toMatchObject({
      body: { code: 'DATA_CONTRACT_NOT_A_SERVICE' },
    });
  });

  it('a failing test of a contract with an owning team notifies the team’s members, once', async () => {
    const team = (await s.api('POST', '/teams', { name: 'Shop data', members: ['olivia'] })).id;
    const c = await s.api('POST', '/data-contracts', {
      yaml: productsYaml((d) => {
        d.id = 'shop-products-failing';
        d.schema[0].properties.push({ name: 'colour', logicalType: 'string' });
      }),
      links: [{ kind: 'server', targetId: shop, detail: 'production' }],
      settings: { servicePlatformId: service },
    });
    await s.api('PUT', `/owning-teams/contract/${c.id}`, { teamIds: [team] });
    const r1 = await s.api('POST', `/data-contracts/${c.id}/test`, {});
    expect(r1.result).toBe('failed');
    await s.api('POST', `/data-contracts/${c.id}/test`, {});
    const mine = (await olivia('GET', '/notifications')).items ?? (await olivia('GET', '/notifications'));
    const about = (Array.isArray(mine) ? mine : []).filter((n: { event: string; link?: string }) => n.event === 'contract.failed' && n.link?.includes(c.id));
    expect(about).toHaveLength(1);
    // vera is not in the team: she does not see the contract, and hears nothing
    expect(await failure(vera('GET', `/data-contracts/${c.id}`))).toMatchObject({ status: 404, body: { code: 'DATA_CONTRACT_NOT_FOUND' } });
    const veras = (await vera('GET', '/notifications')).items ?? (await vera('GET', '/notifications'));
    expect(JSON.stringify(veras)).not.toContain(c.id);
  });

  it('lints with the service', async () => {
    const r = await s.api('POST', `/data-contracts/${orders.id}/service-lint`, {});
    expect(r.findings).toEqual([]);
    const bad = await s.api('POST', `/data-contracts/${orders.id}/service-lint`, { yaml: 'kind: DataContract\n' });
    expect(bad.findings.map((f: { path: string }) => f.path).sort()).toEqual(['apiVersion', 'id']);
  });
});

describe("Steward's own findings, drafts, import and export", () => {
  it('finds columns that no longer match a linked table, once the schema was read', async () => {
    await s.api('POST', `/db-schemas/platform/${shop}/read`);
    const c = await s.api('GET', `/data-contracts/${customers.id}`);
    const f = c.findingList.find((x: { kind: string }) => x.kind === 'columnsMissing');
    expect(f).toMatchObject({ schema: 'customers', fields: ['phone'], severity: 'error' });
    expect(c.findingList.find((x: { kind: string }) => x.kind === 'columnsExtra')).toMatchObject({ fields: ['created_at'] });
  });

  it('drafts a contract from tables, a dataset, an OpenAPI response and a recorded response', async () => {
    const t = await dana('POST', '/data-contracts/draft', { source: 'table', subjectKind: 'platform', subjectId: shop, tables: ['public.invoices'] });
    const doc = YAML.parse(t.yaml);
    expect(doc).toMatchObject({ apiVersion: 'v3.0.2', kind: 'DataContract', status: 'draft' });
    expect(doc.schema[0].properties.find((p: { name: string }) => p.name === 'id')).toMatchObject({ logicalType: 'integer', primaryKey: true, required: true });
    expect(doc.schema[0].properties.find((p: { name: string }) => p.name === 'paid_on')).toMatchObject({ logicalType: 'date' });
    expect(t.links.map((l: { kind: string }) => l.kind).sort()).toEqual(['server', 'table']);
    expect(t.warnings.filter((w: string) => w.startsWith('/'))).toEqual([]);
    // saved with its links, the draft is a contract
    const saved = await dana('POST', '/data-contracts', { yaml: t.yaml, links: t.links });
    expect(saved.lint).toEqual([]);

    const datasets = await s.api('GET', '/datasets');
    if (datasets.length) {
      const d = await dana('POST', '/data-contracts/draft', { source: 'dataset', dataset: datasets[0].key });
      expect(YAML.parse(d.yaml).schema[0].properties.length).toBeGreaterThan(0);
      expect(d.links[0]).toMatchObject({ kind: 'dataset', targetId: datasets[0].key });
    }

    const platforms = await s.api('GET', '/platforms');
    const ih = platforms.find((p: { kind: string }) => p.kind === 'insights-hub');
    const specs = await s.api('GET', `/platforms/${ih.id}/specs`);
    const ops = await s.api('GET', `/platforms/${ih.id}/operations`);
    const op = ops.find((o: { method: string; specId: string }) => o.method === 'GET' && o.specId === specs[0].id);
    const o = await dana('POST', '/data-contracts/draft', {
      source: 'openapi',
      platformId: ih.id,
      specId: specs[0].id,
      method: op.method,
      path: op.specPath ?? op.path,
    });
    expect(YAML.parse(o.yaml).schema).toHaveLength(1);
    expect(o.links[0]).toMatchObject({ kind: 'spec', targetId: specs[0].id });
    // a viewer may not read a platform's specification (no "use" right): like a missing one
    expect(
      await failure(vera('POST', '/data-contracts/draft', { source: 'openapi', platformId: ih.id, specId: specs[0].id, method: 'GET', path: '/x' })),
    ).toMatchObject({
      status: 400,
      body: { code: 'DATA_CONTRACT_DRAFT_SOURCE' },
    });

    const rec = await s.api('POST', `/platforms/${ih.id}/recordings`, {
      method: 'GET',
      path: '/api/things',
      status: 200,
      body: [
        { id: 1, name: 'a', at: '2026-11-01T10:00:00Z', tags: ['x'] },
        { id: 2, name: null, at: '2026-11-02T10:00:00Z', tags: [] },
      ],
    });
    const r = await s.api('POST', '/data-contracts/draft', { source: 'recording', platformId: ih.id, recordingId: rec.id });
    const props = YAML.parse(r.yaml).schema[0].properties;
    expect(props.find((p: { name: string }) => p.name === 'id')).toMatchObject({ logicalType: 'integer', required: true });
    expect(props.find((p: { name: string }) => p.name === 'name').required).toBeUndefined();
    expect(props.find((p: { name: string }) => p.name === 'at')).toMatchObject({ logicalType: 'date' });
  });

  it('exports a version as YAML and imports a file as a new version of the same contract', async () => {
    const yaml = await s.api('GET', `/data-contracts/${customers.id}/export`);
    expect(String(yaml)).toContain('id: shop-customers');
    const doc = YAML.parse(String(yaml));
    doc.version = '0.4.0';
    const r = await s.api('POST', '/data-contracts/import', { yaml: YAML.stringify(doc) });
    expect(r).toMatchObject({ action: 'version', contract: { id: customers.id, currentVersion: 2, version: '0.4.0' } });
    expect((await s.api('POST', '/data-contracts/import', { yaml: YAML.stringify(doc) })).action).toBe('unchanged');
    const fresh = await s.api('POST', '/data-contracts/import', { yaml: productsYaml((d) => (d.id = 'imported-products')) });
    expect(fresh.action).toBe('created');
  });
});
