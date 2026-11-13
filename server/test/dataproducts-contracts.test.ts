import YAML from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { DATA_CONTRACT_SERVICE_KIND } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Data products and data contracts (0.24.0, ADR 0036 phase 2, package B): `dataproduct.contract_breaking` – a new
 * contract version the comparison calls breaking tells the registered consumers and the owners of consuming products of
 * the output ports that follow the contract, once per version, only who may see the product, the contract named only to
 * who may see it; contract tests through the datacontract CLI for Snowflake and Kafka servers (the platform's identity
 * in the CLI's headers – an allow-list of header names, no secret in the stored run), their checks as quality results of
 * the bound elements; personal fields of bound contracts on products, elements and data objects.
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
let audrey: Client;
let vera: Client;
let sf = '';
let kafka = '';
let service = '';
let product = '';
let port = '';
let pinnedPort = '';
let element = '';
let topic = '';
let contract = '';
let object = '';
let mart = '';

interface Note {
  event: string;
  title: string;
  body: string;
  link?: string;
}
const notes = async (who: Client, about = product): Promise<Note[]> => {
  const r = (await who('GET', '/notifications?limit=500')) as { items?: Note[] } | Note[];
  const list = (Array.isArray(r) ? r : (r.items ?? [])) as Note[];
  return list.filter((n) => n.event === 'dataproduct.contract_breaking' && String(n.link ?? '').includes(about));
};
/** The hook runs after the save (a lazy import): wait for the notices a little. */
const settle = async (who: Client, count: number): Promise<Note[]> => {
  for (let i = 0; i < 40; i++) {
    const n = await notes(who);
    if (n.length >= count) return n;
    await new Promise((r) => setTimeout(r, 50));
  }
  return notes(who);
};
const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string } };
    return { status: err.status, code: err.body?.code ?? '' };
  }
  throw new Error('expected a refusal');
};
const calls = async (): Promise<
  { path: string; server: string | null; headerNames: string[]; settings?: Record<string, string>; credentialsMatched: boolean }[]
> => (await fetch(`${s.base}/mock/datacontract/_mock/calls`, { headers: { 'x-api-key': KEY } })).json();
const resetMock = () => fetch(`${s.base}/mock/datacontract/_mock/reset`, { method: 'POST', headers: { 'x-api-key': KEY } });

/** A Snowflake contract of SHOP.SALES.ORDERS: an email field marked personal, a quality rule. */
function ordersYaml(extra: (doc: any) => void = () => {}): string {
  const doc: any = {
    apiVersion: 'v3.0.2',
    kind: 'DataContract',
    id: 'dp-sf-orders',
    name: 'Invented orders (Snowflake)',
    version: '1.0.0',
    status: 'active',
    servers: [{ server: 'prod', type: 'snowflake', account: 'DEMO12345', database: 'SHOP', schema: 'SALES' }],
    schema: [
      {
        name: 'orders',
        physicalName: 'ORDERS',
        properties: [
          { name: 'ORDER_ID', logicalType: 'integer', required: true, quality: [{ rule: 'nullValues', mustBeLessThan: 1 }] },
          { name: 'CUSTOMER_EMAIL', logicalType: 'string', classification: 'confidential', customProperties: [{ property: 'personalData', value: true }] },
          { name: 'REGION', logicalType: 'string', classification: 'internal' },
          { name: 'TOTAL', logicalType: 'number' },
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
  await s.api('POST', '/demo/setup', { applications: false });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
  adam = await s.as('adam', PW);
  audrey = await s.as('audrey', PW);
  vera = await s.as('vera', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  sf = platforms.find((p) => p.kind === 'snowflake')!.id;
  kafka = platforms.find((p) => p.kind === 'kafka')!.id;
  service = platforms.find((p) => p.kind === DATA_CONTRACT_SERVICE_KIND)!.id;
  const { db } = await import('../src/db.js');
  contract = (
    await dana('POST', '/data-contracts', {
      yaml: ordersYaml(),
      links: [{ kind: 'server', targetId: sf, detail: 'prod' }],
      settings: { servicePlatformId: service },
    })
  ).id;
  element = (await dana('POST', '/data-elements', { platformId: sf, kind: 'snowflake.table', qualifiedName: 'SHOP.SALES.ORDERS', environment: 'prod' })).id;
  topic = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'orders', environment: 'prod' })).id;
  object = (await dana('POST', '/data-objects', { key: 'invented-order', name: 'Invented order' })).id;
  product = (await dana('POST', '/data-products', { key: 'dp-b-orders', name: 'Invented orders', owners: ['user:dana'] })).id;
  port = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table', version: 'v1', objectIds: [object] })).id;
  await dana('PUT', `/data-products/${product}/ports/${port}/bindings/prod`, { elementIds: [element], contractId: contract, contractServer: 'prod' });
  await dana('POST', `/data-products/${product}/ports/${port}/consumers`, { kind: 'user', subject: 'user:adam', contacts: ['user:audrey'] });
  // a port held to version 1: a new version does not move it
  pinnedPort = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'orders-pinned', type: 'table', version: 'v1' })).id;
  await dana('PUT', `/data-products/${product}/ports/${pinnedPort}/bindings/prod`, { elementIds: [element], contractId: contract, contractVersion: 1 });
  await dana('POST', `/data-products/${product}/ports/${pinnedPort}/consumers`, { kind: 'user', subject: 'user:vera' });
  // consuming products: olivia owns one she may see
  mart = (await dana('POST', '/data-products', { key: 'dp-b-mart', name: 'Invented mart', owners: ['user:olivia'] })).id;
  await dana('POST', `/data-products/${mart}/ports`, { direction: 'input', name: 'orders', source: { kind: 'port', portId: port } });
  // the contract belongs to a team of dana and audrey: olivia and adam may not see it (made last: new entries get their
  // creator's teams)
  const contractTeam = (await s.api('POST', '/teams', { name: 'Invented contract team', members: ['dana', 'audrey'] })).id;
  db().run("DELETE FROM resource_teams WHERE kind = 'contract' AND resource_id = ?", contract);
  db().run(
    "INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('contract', ?, ?, ?)",
    contract,
    contractTeam,
    new Date().toISOString(),
  );
}, 180_000);

describe('contract tests on Snowflake and Kafka servers', () => {
  it('gives the CLI the Snowflake platform’s account and key pair in an allow-list of headers, never stored', async () => {
    await resetMock();
    const run = await dana('POST', `/data-contracts/${contract}/test`, {});
    expect(run).toMatchObject({ result: 'passed', server: 'prod' });
    const [call] = await calls();
    expect(call).toMatchObject({ path: '/test', server: 'prod', credentialsMatched: true });
    expect(call!.headerNames).toEqual([
      'datacontract-snowflake-account',
      'datacontract-snowflake-private-key',
      'datacontract-snowflake-role',
      'datacontract-snowflake-username',
      'datacontract-snowflake-warehouse',
    ]);
    // the account pins where the CLI connects
    expect(call!.settings).toMatchObject({ 'datacontract-snowflake-account': 'DEMO12345' });
    const full = await s.api('GET', `/data-contracts/${contract}/runs/${run.id}`);
    expect(JSON.stringify(full)).not.toContain('PRIVATE KEY');
    // the key goes as base64 DER (one line – a header carries no line breaks)
    expect(call!.settings).not.toHaveProperty('datacontract-snowflake-private-key');
    expect(JSON.stringify(await s.api('GET', '/audit?action=contract.tested&limit=50'))).not.toContain('PRIVATE KEY');
  });

  it('stores the checks that map to a quality dimension as results of the bound elements', async () => {
    const q = await dana('GET', `/data-elements/${element}/quality`);
    const dims = Object.fromEntries(q.summary.map((x: { dimension: string; tests: number; passed: number }) => [x.dimension, x]));
    expect(dims.completeness).toMatchObject({ passed: 1, failed: 0 });
    expect(dims.accuracy.tests).toBeGreaterThan(0);
    expect(q.results.every((r: { source: string; runRef: string }) => r.source === 'contract' && r.runRef)).toBe(true);
    // the topic is not bound to the contract
    expect((await dana('GET', `/data-elements/${topic}/quality`)).results).toEqual([]);
  });

  it('tests a Kafka server when its host is a bootstrap server of the platform, with SASL in the headers', async () => {
    const yaml = YAML.stringify({
      apiVersion: 'v3.0.2',
      kind: 'DataContract',
      id: 'dp-kafka-orders',
      name: 'Invented order events',
      version: '1.0.0',
      status: 'active',
      servers: [{ server: 'events', type: 'kafka', host: 'kafka.demo.invalid:9092', topic: 'orders', format: 'json' }],
      schema: [{ name: 'orders', physicalName: 'orders', properties: [{ name: 'order_id', logicalType: 'integer', required: true }] }],
    });
    const k = await dana('POST', '/data-contracts', {
      yaml,
      links: [{ kind: 'server', targetId: kafka, detail: 'events' }],
      settings: { servicePlatformId: service },
    });
    await resetMock();
    expect(await dana('POST', `/data-contracts/${k.id}/test`, {})).toMatchObject({ result: 'passed', server: 'events' });
    const [call] = await calls();
    expect(call!.credentialsMatched).toBe(true);
    expect(call!.headerNames).toEqual([
      'datacontract-kafka-group-prefix',
      'datacontract-kafka-max-messages',
      'datacontract-kafka-sasl-mechanism',
      'datacontract-kafka-sasl-password',
      'datacontract-kafka-sasl-username',
    ]);
    expect(JSON.stringify(call!.settings)).not.toContain('demo-kafka-secret');
    // another host: the CLI would connect where the contract says – refused
    const other = await dana('POST', '/data-contracts', {
      yaml: yaml.replace('dp-kafka-orders', 'dp-kafka-other').replace('kafka.demo.invalid:9092', 'kafka.elsewhere.example:9092'),
      links: [{ kind: 'server', targetId: kafka, detail: 'events' }],
      settings: { servicePlatformId: service },
    });
    expect(await fail(dana('POST', `/data-contracts/${other.id}/test`, {}))).toMatchObject({ status: 409, code: 'DATA_CONTRACT_SERVER_HOST' });
    // a Kafka server is not answered by a Snowflake platform
    expect(await fail(dana('POST', `/data-contracts/${k.id}/links`, { kind: 'server', targetId: sf, detail: 'events' }))).toMatchObject({
      status: 400,
      code: 'DATA_CONTRACT_SERVER_TYPE',
    });
  });

  it('refuses SQL quality rules on a Snowflake server', async () => {
    const c = await dana('POST', '/data-contracts', {
      yaml: ordersYaml((d) => {
        d.id = 'dp-sf-sql';
        d.schema[0].quality = [{ type: 'sql', query: 'SELECT COUNT(*) FROM ORDERS', mustBeGreaterThan: 0 }];
      }),
      links: [{ kind: 'server', targetId: sf, detail: 'prod' }],
      settings: { servicePlatformId: service },
    });
    expect(await fail(dana('POST', `/data-contracts/${c.id}/test`, {}))).toMatchObject({ status: 409, code: 'DATA_CONTRACT_SQL_PLATFORM' });
  });
});

describe('personal fields from contracts', () => {
  it('lists the personal and classified fields of the bound contract on the product, the element and the data object', async () => {
    const p = await dana('GET', `/data-products/${product}/personal-fields`);
    expect(p).toMatchObject({ personal: 1, classified: 2, hiddenContracts: 0 });
    expect(p.groups[0].contract).toMatchObject({ id: contract, key: 'dp-sf-orders' });
    expect(p.groups[0].fields).toEqual([
      { schema: 'orders', field: 'CUSTOMER_EMAIL', classification: 'confidential', personal: true },
      { schema: 'orders', field: 'REGION', classification: 'internal', personal: false },
    ]);
    expect(p.groups[0].ports.map((x: { portName: string }) => x.portName).sort()).toEqual(['orders v1', 'orders-pinned v1']);
    expect((await dana('GET', `/data-elements/${element}/personal-fields`)).personal).toBe(1);
    expect((await dana('GET', `/data-objects/${object}/personal-fields`)).personal).toBe(1);
  });

  it('counts a contract the reader may not see, never names it or its fields', async () => {
    const p = await olivia('GET', `/data-products/${product}/personal-fields`);
    expect(p).toEqual({ groups: [], personal: 0, classified: 0, hiddenContracts: 1 });
    expect(JSON.stringify(await olivia('GET', `/data-elements/${element}/personal-fields`))).not.toContain('CUSTOMER_EMAIL');
  });

  it('is evidence of confidentiality in the scorecard: personal fields while no exposed data object holds personal data', async () => {
    const card = await dana('GET', `/data-products/${product}/scorecard?environment=prod`);
    const conf = card.parts.find((x: { id: string }) => x.id === 'confidentiality');
    expect(conf.evidence.map((e: { key: string }) => e.key)).toContain('evidence.confidentiality.personalFieldsUndocumented');
  });
});

describe('dataproduct.contract_breaking', () => {
  it('tells the consumers of the ports that follow the contract once per version, the contract named only to who may see it', async () => {
    const v2 = ordersYaml((d) => {
      d.version = '2.0.0';
      d.schema[0].properties = d.schema[0].properties.filter((x: { name: string }) => x.name !== 'TOTAL');
    });
    const saved = await dana('POST', `/data-contracts/${contract}/versions`, { yaml: v2 });
    expect(saved.diff.breaking).toBeGreaterThan(0);
    // the registered consumer (adam), his contact (audrey) and the owner of the consuming product (olivia)
    const [a] = await settle(adam, 1);
    const [au] = await settle(audrey, 1);
    const [o] = await settle(olivia, 1);
    expect(a!.title).toContain('orders v1');
    expect(a!.body).toContain('registered as a consumer');
    // adam and olivia may not see the contract: neither its name nor its changes
    expect(a!.body).not.toContain('Invented orders (Snowflake)');
    expect(a!.body).not.toContain('TOTAL');
    expect(o!.body).toContain('Invented mart');
    expect(o!.body).not.toContain('Invented orders (Snowflake)');
    // audrey may: the contract and the change
    expect(au!.body).toContain('Invented orders (Snowflake)');
    expect(au!.body).toContain('TOTAL');
    // the pinned port's consumer is not told; the product's owner neither (not a consumer)
    expect(await notes(vera)).toHaveLength(0);
    expect(await notes(dana)).toHaveLength(0);
  });

  it('is sent once per version: a change that breaks nothing tells nobody, the next breaking version tells again', async () => {
    const before = (await notes(adam)).length;
    const v3 = ordersYaml((d) => {
      d.version = '2.1.0';
      d.schema[0].properties = d.schema[0].properties.filter((x: { name: string }) => x.name !== 'TOTAL');
      d.schema[0].properties.push({ name: 'NOTE', logicalType: 'string' });
    });
    expect((await dana('POST', `/data-contracts/${contract}/versions`, { yaml: v3 })).diff.breaking).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(await notes(adam)).toHaveLength(before);
    const { onContractVersionSaved } = await import('../src/dataproducts/contract-hooks.js');
    // the hook again for version 2 (a repeated call): nothing more
    expect(onContractVersionSaved({ contractId: contract, contractName: 'x', contractKey: 'x', version: 2, breaking: 1, changes: [] })).toBe(0);
    const v4 = ordersYaml((d) => {
      d.version = '3.0.0';
      d.schema[0].properties = d.schema[0].properties.filter((x: { name: string }) => !['TOTAL', 'REGION'].includes(x.name));
      d.schema[0].properties.push({ name: 'NOTE', logicalType: 'string' });
    });
    await dana('POST', `/data-contracts/${contract}/versions`, { yaml: v4 });
    expect(await settle(adam, before + 1)).toHaveLength(before + 1);
  });

  it('flags the endorsement of a product whose port follows the contract for a review (once per version)', async () => {
    // audrey shares dana's teams: she sees the product and, as the domain's owner, endorses it
    const domain = (await s.api('POST', '/data-domains', { key: 'dp-b-endorsed', name: 'Invented endorsed', owners: ['user:audrey'] })).id;
    const p = (await dana('POST', '/data-products', { key: 'dp-b-endorsed', name: 'Invented endorsed orders', owners: ['user:dana'], domainId: domain })).id;
    const pp = (await dana('POST', `/data-products/${p}/ports`, { direction: 'output', name: 'orders', type: 'table' })).id;
    await dana('PUT', `/data-products/${p}/ports/${pp}/bindings/prod`, { elementIds: [element], contractId: contract });
    expect((await audrey('PUT', `/data-products/${p}/endorsement`, {})).endorsement).toMatchObject({ valid: true, review: null });
    const v5 = ordersYaml((d) => {
      d.version = '4.0.0';
      d.schema[0].properties = d.schema[0].properties.filter((x: { name: string }) => !['TOTAL', 'REGION'].includes(x.name));
    });
    expect((await dana('POST', `/data-contracts/${contract}/versions`, { yaml: v5 })).diff.breaking).toBeGreaterThan(0);
    let e: { valid: boolean; review: string | null } | null = null;
    for (let i = 0; i < 40 && e?.review !== 'breakingChange'; i++) {
      e = (await dana('GET', `/data-products/${p}/endorsement`)).endorsement;
      if (e?.review !== 'breakingChange') await new Promise((r) => setTimeout(r, 50));
    }
    expect(e).toMatchObject({ valid: false, review: 'breakingChange' });
    // endorsed again: the same version does not flag it again
    expect((await audrey('PUT', `/data-products/${p}/endorsement`, {})).endorsement.valid).toBe(true);
    const { onContractVersionSaved } = await import('../src/dataproducts/contract-hooks.js');
    const version = Number((await dana('GET', `/data-contracts/${contract}`)).currentVersion);
    onContractVersionSaved({ contractId: contract, contractName: 'x', contractKey: 'x', version, breaking: 1, changes: [] });
    expect((await dana('GET', `/data-products/${p}/endorsement`)).endorsement).toMatchObject({ valid: true, review: null });
  });

  it('tells nobody who may not see the product', async () => {
    const { db } = await import('../src/db.js');
    const team = (await s.api('POST', '/teams', { name: 'Invented hidden product team', members: ['dana'] })).id;
    const hidden = (await dana('POST', '/data-products', { key: 'dp-b-hidden', name: 'Invented hidden', owners: ['user:dana'] })).id;
    db().run("DELETE FROM resource_teams WHERE kind = 'data_product' AND resource_id = ?", hidden);
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)", hidden, team, new Date().toISOString());
    const hp = (await dana('POST', `/data-products/${hidden}/ports`, { direction: 'output', name: 'secret', type: 'table' })).id;
    await dana('PUT', `/data-products/${hidden}/ports/${hp}/bindings/prod`, { elementIds: [element], contractId: contract });
    await dana('POST', `/data-products/${hidden}/ports/${hp}/consumers`, { kind: 'user', subject: 'user:vera' });
    const { onContractVersionSaved } = await import('../src/dataproducts/contract-hooks.js');
    onContractVersionSaved({ contractId: contract, contractName: 'x', contractKey: 'x', version: 99, breaking: 1, changes: [] });
    expect(await notes(vera, hidden)).toHaveLength(0);
  });
});
