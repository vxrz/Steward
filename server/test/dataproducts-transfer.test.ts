import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Import and export of the data products module (ADR 0036 part 15, WP7): the file format and its JSON Schema, the
 * preview field by field, add only and add and update, the round trip export → import (nothing changes), the limits
 * of the reader, credential-looking values refused with their places, names the importer may not see refused like
 * unknown ones, team scope in exports, and the ODPS v1.0.0 export checked against the vendored official schema.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let olivia: Client;
let snowflake = '';
let snowflakeName = '';
let kafkaName = '';

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown>; message: string }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown>; error?: string } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {}, message: err.body?.error ?? '' };
  }
  throw new Error('expected a refusal');
};
const file = (content: unknown, name = 'products.yaml') => ({ name, content: typeof content === 'string' ? content : YAML.stringify(content) });
const preview = (c: Client, files: { name: string; content: string }[], mode: 'add' | 'update' = 'update') =>
  c('POST', '/data-products/import/preview', { files, mode });
const importFiles = (c: Client, files: { name: string; content: string }[], mode: 'add' | 'update' = 'update', fingerprint?: string) =>
  c('POST', '/data-products/import', { files, mode, ...(fingerprint ? { fingerprint } : {}) });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  olivia = await s.as('olivia', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string; name: string }[];
  const sf = platforms.find((p) => p.kind === 'snowflake')!;
  snowflake = sf.id;
  snowflakeName = sf.name;
  kafkaName = platforms.find((p) => p.kind === 'kafka')!.name;
}, 180_000);

/** A whole documented product: domains, a data object, elements, ports with bindings, consumers, steps. */
const DOC = () => ({
  version: 1,
  domains: [
    { key: 'sales', name: 'Sales', owners: ['user:dana'] },
    { key: 'orders', name: 'Orders', parent: 'sales' },
  ],
  data_objects: [
    {
      key: 'order',
      name: 'Order',
      definition: 'A customer order with its lines.',
      domain: 'orders',
      lifecycle: 'active',
      classification: 'internal',
      personal_data: 'personal',
      categories: ['identification'],
      attributes: [{ name: 'order_id', description: 'Key', personal: false }],
      owner: 'dana',
      rating: { confidentiality: { level: 'high', justification: 'Order values' } },
      elements: [
        { element: { platform: snowflakeName, kind: 'snowflake.table', qualified_name: 'SHOP.CURATED.ORDERS', environment: 'prod' }, note: 'all orders' },
      ],
    },
  ],
  elements: [
    { platform: kafkaName, kind: 'kafka.topic', qualified_name: 'orders.v1', environment: 'prod', layer: 'source', description: 'Order events' },
    { platform: snowflakeName, kind: 'snowflake.database', qualified_name: 'SHOP', environment: 'prod' },
    { platform: snowflakeName, kind: 'snowflake.schema', qualified_name: 'SHOP.CURATED', environment: 'prod', parent: 'SHOP' },
    { platform: snowflakeName, kind: 'snowflake.schema', qualified_name: 'SHOP.RAW', environment: 'prod', parent: 'SHOP' },
    { platform: snowflakeName, kind: 'snowflake.table', qualified_name: 'SHOP.RAW.ORDERS', environment: 'prod', parent: 'SHOP.RAW', layer: 'raw' },
    { platform: snowflakeName, kind: 'snowflake.table', qualified_name: 'SHOP.CURATED.ORDERS', environment: 'prod', parent: 'SHOP.CURATED', layer: 'curated' },
  ],
  data_products: [
    {
      key: 'orders',
      name: 'Orders',
      description: 'Every order of the shop.',
      purpose: 'Order analytics',
      type: 'sourceAligned',
      domain: 'orders',
      owners: ['user:dana'],
      support: { channel: '#orders', url: 'https://wiki.example/orders', hours: '8–17' },
      criticality: 'high',
      tier: 2,
      version: '2.1',
      value_statement: 'Revenue reporting',
      value_tier: 'high',
      value_amount: 125000.5,
      value_currency: 'EUR',
      tags: ['shop'],
      external_refs: [{ label: 'Wiki', url: 'https://wiki.example/orders' }],
      lifecycle: 'active',
      rating: { confidentiality: { level: 'high', justification: 'Order values' } },
      environments: [{ environment: 'prod', state: 'available' }],
      members: [
        { element: { platform: kafkaName, kind: 'kafka.topic', qualified_name: 'orders.v1', environment: 'prod' }, role: 'input' },
        { element: { platform: snowflakeName, kind: 'snowflake.table', qualified_name: 'SHOP.RAW.ORDERS', environment: 'prod' }, role: 'internal' },
      ],
      ports: [
        {
          direction: 'output',
          name: 'orders',
          version: 'v2',
          type: 'table',
          lifecycle: 'active',
          objectives: { freshness_minutes: 60 },
          data_objects: ['order'],
          bindings: [
            {
              environment: 'prod',
              elements: [{ platform: snowflakeName, kind: 'snowflake.table', qualified_name: 'SHOP.CURATED.ORDERS', environment: 'prod' }],
              objectives: { availability_pct: 99.5 },
            },
          ],
          consumers: [
            { kind: 'team', subject: 'team:finance', purpose: 'Monthly close' },
            { kind: 'text', text: 'Controlling', purpose: 'Reports', since: '2026-01-01' },
          ],
        },
        { direction: 'input', name: 'events', type: 'topic', source: { text: 'Shop events, live' } },
      ],
      steps: [
        {
          name: 'Ingest orders',
          kind: 'ingest',
          runner: { kind: 'tool', tool: 'Kafka Connect', text: 'sink connector' },
          inputs: [{ platform: kafkaName, kind: 'kafka.topic', qualified_name: 'orders.v1', environment: 'prod' }],
          outputs: [{ platform: snowflakeName, kind: 'snowflake.table', qualified_name: 'SHOP.RAW.ORDERS', environment: 'prod' }],
          notes: [{ kind: 'rename', text: 'snake case' }],
        },
        {
          name: 'Curate orders',
          kind: 'curate',
          runner: { kind: 'tool', tool: 'dbt', text: '' },
          schedule: 'hourly',
          inputs: [{ platform: snowflakeName, kind: 'snowflake.table', qualified_name: 'SHOP.RAW.ORDERS', environment: 'prod' }],
          outputs: [{ platform: snowflakeName, kind: 'snowflake.table', qualified_name: 'SHOP.CURATED.ORDERS', environment: 'prod' }],
        },
      ],
    },
  ],
});

describe('the format', () => {
  it('has its JSON Schema up to date in docs and at GET /api/data-products/schema', async () => {
    const { dataProductsJsonSchema } = await import('../src/dataproducts/format.js');
    const committed = fs.readFileSync(path.resolve(__dirname, '../../docs/data-products/data-products-1.schema.json'), 'utf8');
    expect(committed, 'run npx tsx server/src/cli/data-products-schema.ts').toBe(JSON.stringify(dataProductsJsonSchema(), null, 2) + '\n');
    const served = await dana('GET', '/data-products/schema');
    expect(served.$id).toContain('data-products-1.schema.json');
    expect(Object.keys(served.$defs)).toEqual(expect.arrayContaining(['DataProduct', 'ElementRef', 'Port']));
  });
});

describe('import', () => {
  let productId = '';
  it('previews what it adds, then imports everything in one go, audited with counts and SHA-256', async () => {
    const files = [file(DOC())];
    const p = await preview(dana, files);
    expect(p.problems, JSON.stringify(p.problems)).toEqual([]);
    expect(p.counts).toEqual({ add: 10, change: 0, unchanged: 0, skip: 0 });
    expect(p.changes.find((c: { kind: string }) => c.kind === 'dataProduct')).toMatchObject({ key: 'orders', action: 'add' });
    // nothing was written by the preview (and nothing audited)
    expect((await dana('GET', '/data-products')).total).toBe(0);
    const r = await importFiles(dana, files, 'update', p.fingerprint);
    expect(r.counts).toEqual(p.counts);
    const list = await dana('GET', '/data-products');
    productId = list.items[0].id;
    const got = await dana('GET', `/data-products/${productId}`);
    expect(got).toMatchObject({
      key: 'orders',
      lifecycle: 'active',
      type: 'sourceAligned',
      domain: { key: 'orders' },
      valueAmount: 125000500000,
      memberCounts: { input: 1, internal: 1, output: 1 },
    });
    const out = got.ports.find((x: { direction: string }) => x.direction === 'output');
    expect(out).toMatchObject({ name: 'orders', version: 'v2', consumers: { registered: 2 }, objects: { declared: [{ key: 'order' }] } });
    expect(out.bindings[0].objectives).toEqual({ availabilityPct: 99.5 });
    expect((await dana('GET', `/data-products/${productId}/steps`)).map((x: { name: string }) => x.name).sort()).toEqual(['Curate orders', 'Ingest orders']);
    const imported = (await dana('GET', '/data-elements?prefix=shop.raw.orders')).items[0];
    expect(imported).toMatchObject({ source: 'imported', parentId: expect.any(String) });
    const audit = await s.api('GET', '/audit?action=dataproduct.imported');
    const entry = (audit.items ?? audit)[0];
    expect(entry.details).toMatchObject({
      mode: 'update',
      counts: { add: 10 },
      files: [{ name: 'products.yaml', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }],
    });
  });

  it('exports and imports again without a change (the round trip)', async () => {
    for (const url of [`/data-products/${productId}/export`, '/data-products/export', `/data-products/${productId}/export?format=json`]) {
      const body = (await dana('GET', url)) as string | Record<string, unknown>;
      const content = typeof body === 'string' ? body : JSON.stringify(body);
      if (typeof body === 'string') expect(body).toMatch(/^# Steward data products, format 1/);
      const p = await preview(dana, [file(content, url.includes('json') ? 'x.json' : 'x.yaml')]);
      expect(p.problems, `${url}: ${JSON.stringify(p.problems)}`).toEqual([]);
      expect(p.counts, `${url}: ${JSON.stringify(p.changes)}`).toMatchObject({ add: 0, change: 0, skip: 0 });
      expect(p.counts.unchanged).toBeGreaterThanOrEqual(8);
    }
    // the pages download through links: their link key (?_sk=) is not a parameter of the export
    expect((await dana('GET', `/data-products/${productId}/export?format=yaml&_sk=link`)) as string).toMatch(/^# Steward data products, format 1/);
    expect(String(await dana('GET', `/data-products/${productId}/odps?_sk=link`))).toContain('kind: DataProduct');
    // the file holds no readouts, check states, costs or run-as users
    const text = (await dana('GET', '/data-products/export')) as string;
    expect(text).not.toMatch(/^\s*-?\s*(readout|run_as|read_at|row_count|status|cost\w*|secrets?|variables)\s*:/im);
  });

  it('shows changes field by field and applies them (add and update); add only skips what exists', async () => {
    const doc = DOC();
    const p0 = doc.data_products[0]!;
    p0.description = 'Every order of the shop, since 2020.';
    p0.ports[0]!.bindings![0]!.objectives = { availability_pct: 99.9 };
    p0.ports[0]!.consumers!.push({ kind: 'text', text: 'Sales planning', purpose: 'Forecasts', since: '2026-02-01' });
    const p = await preview(dana, [file({ version: 1, data_products: [p0] })]);
    expect(p.counts).toMatchObject({ change: 1, add: 0 });
    const fields = p.changes[0].fields.map((f: { field: string }) => f.field);
    expect(fields).toEqual(
      expect.arrayContaining(['description', 'ports[output orders v2].bindings[prod].objectives', 'ports[output orders v2].consumers[text:sales planning]']),
    );
    const skipped = await preview(dana, [file({ version: 1, data_products: [p0] })], 'add');
    expect(skipped.counts).toMatchObject({ skip: 1, change: 0 });
    await importFiles(dana, [file({ version: 1, data_products: [p0] })]);
    const got = await dana('GET', `/data-products/${productId}`);
    expect(got.description).toBe('Every order of the shop, since 2020.');
    expect(got.ports.find((x: { direction: string }) => x.direction === 'output').consumers.registered).toBe(3);
    // a key the file leaves out keeps Steward's value
    await importFiles(dana, [file({ version: 1, data_product: { key: 'orders', name: 'Orders' } })]);
    expect((await dana('GET', `/data-products/${productId}`)).description).toBe('Every order of the shop, since 2020.');
  });

  it('refuses what the services refuse in the preview already, and imports nothing then', async () => {
    const bad = { version: 1, data_product: { key: 'broken', name: 'Broken', lifecycle: 'active' } };
    const p = await preview(dana, [file(bad)]);
    expect(p.problems.map((x: { code: string }) => x.code)).toContain('DATA_PRODUCT_LIFECYCLE');
    // the import itself stops at the service's refusal (the whole import is one transaction), naming the entry
    const refused = await fail(importFiles(dana, [file(bad)]));
    expect(refused).toMatchObject({ status: 409, code: 'DATA_PRODUCT_LIFECYCLE' });
    expect(refused.message).toContain('data_products[broken]');
    // what the reader finds is refused before anything is written
    expect(await fail(importFiles(dana, [file({ version: 1, data_product: { key: 'broken', name: 'Broken', colour: 'red' } })]))).toMatchObject({
      status: 400,
      code: 'DATA_PRODUCT_IMPORT_INVALID',
    });
    expect((await dana('GET', '/data-products?q=broken')).total).toBe(0);
    // viewers import nothing
    expect((await fail(importFiles(vera, [file({ version: 1, data_product: { key: 'mine', name: 'Mine' } })]))).status).toBe(403);
    // a changed state since the preview is refused
    expect(await fail(importFiles(dana, [file({ version: 1, data_product: { key: 'x1', name: 'X1' } })], 'update', 'not-the-fingerprint'))).toMatchObject({
      status: 409,
      code: 'DATA_PRODUCT_IMPORT_CHANGED',
    });
  });

  it('is session-only: an API token imports nothing', async () => {
    const tok = (await dana('POST', '/me/tokens', { name: 'ci', scope: 'full' })).token;
    const res = await fetch(`${s.base}/api/data-products/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ files: [file({ version: 1, data_product: { key: 'ci', name: 'CI' } })], mode: 'add' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('the reader', () => {
  it('keeps to the limits: size, files, depth, aliases, duplicate keys and the format', async () => {
    expect(await fail(preview(dana, [file('x'.repeat(8 * 1024 * 1024 + 10))]))).toMatchObject({ status: 413, code: 'DATA_PRODUCT_IMPORT_TOO_LARGE' });
    expect(
      (
        await fail(
          preview(
            dana,
            Array.from({ length: 501 }, (_, i) => file('version: 1\n', `f${i}.yaml`)),
          ),
        )
      ).status,
    ).toBe(400);
    let deep: unknown = 'x';
    for (let i = 0; i < 14; i++) deep = { a: deep };
    const d = await preview(dana, [file({ version: 1, domains: [{ key: 'deep', name: 'Deep', description: deep }] })]);
    expect(d.problems[0].message).toMatch(/nested deeper than 12/);
    const aliases = 'version: 1\na: &a [x, x, x, x, x, x, x, x, x, x]\n' + Array.from({ length: 120 }, (_, i) => `b${i}: *a`).join('\n');
    expect((await preview(dana, [file(aliases)])).problems.length).toBeGreaterThan(0);
    const dup = await preview(dana, [file('version: 1\ndata_product:\n  key: a\n  key: b\n  name: A\n')]);
    expect(dup.problems[0].message).toMatch(/unique/i);
    const unknown = await preview(dana, [file({ version: 1, data_product: { key: 'a', name: 'A', colour: 'red' } })]);
    expect(unknown.problems[0]).toMatchObject({ path: 'data_product', message: expect.stringMatching(/Unknown key "colour"/) });
    const twice = await preview(dana, [
      file({ version: 1, data_product: { key: 'a', name: 'A' } }, 'a.yaml'),
      file({ version: 1, data_product: { key: 'a', name: 'A' } }, 'b.yaml'),
    ]);
    expect(twice.problems[0].message).toMatch(/twice/);
    const elements = Array.from({ length: 20_001 }, (_, i) => ({ kind: 'other', qualified_name: `x${i}` }));
    const many = await preview(dana, [file(JSON.stringify({ version: 1, elements }), 'many.json')]);
    expect(many.problems[0]).toMatchObject({ path: 'elements', message: expect.stringMatching(/20000/) });
  });

  it('refuses credential-looking values and names their places, never their values', async () => {
    const doc = {
      version: 1,
      data_product: {
        key: 'leaky',
        name: 'Leaky',
        external_refs: [{ label: 'Repo', url: 'https://ci:hunter2secret@git.example/repo' }],
        support: { channel: 'x', url: 'https://wiki.example', hours: '' },
      },
      elements: [{ kind: 'other', qualified_name: 'leaky.thing', flags: { password: 'hunter2secret' } }],
    };
    const p = await preview(dana, [file(doc)]);
    expect(p.problems.map((x: { path: string }) => x.path).sort()).toEqual(['data_product.external_refs[0].url', 'elements[0].flags.password']);
    expect(JSON.stringify(p)).not.toContain('hunter2secret');
    const r = await fail(importFiles(dana, [file(doc)]));
    expect(r).toMatchObject({ status: 400, code: 'DATA_PRODUCT_IMPORT_SECRET', params: { count: 2 } });
    expect(JSON.stringify(r)).not.toContain('hunter2secret');
  });

  it('refuses names the importer may not see like unknown ones', async () => {
    const team = (await s.api('POST', '/teams', { name: 'Hidden data team', members: ['dana'] })).id;
    const hidden = await dana('POST', '/data-products', { key: 'hidden-product', name: 'Hidden product' });
    await s.api('PUT', `/owning-teams/data_product/${hidden.id}`, { teamIds: [team] });
    const hiddenEl = await dana('POST', '/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: 'HIDDEN.S.T', environment: 'prod' });
    await s.api('PUT', `/owning-teams/data_element/${hiddenEl.id}`, { teamIds: [team] });
    // olivia (operator, not a member) may see neither: as if they did not exist
    const doc = {
      version: 1,
      data_product: {
        key: 'olivias',
        name: 'Olivia’s',
        successor: 'hidden-product',
        members: [{ element: { platform: snowflakeName, kind: 'snowflake.table', qualified_name: 'HIDDEN.S.T', environment: 'prod' } }],
      },
    };
    const p = await preview(olivia, [file(doc)]);
    const text = JSON.stringify(p.problems);
    expect(text).toMatch(/HIDDEN\.S\.T .*is not known/);
    expect(text).not.toContain(hidden.id);
    // a member of the team sees it: the same file is a change of her product
    const mine = await preview(dana, [file({ version: 1, data_product: { key: 'hidden-product', name: 'Hidden product' } })]);
    expect(mine.counts).toMatchObject({ unchanged: 1, add: 0 });
  });
});

describe('export', () => {
  it('writes only what the reader may see', async () => {
    const team = ((await s.api('GET', '/teams')) as { id: string; name: string }[]).find((t) => t.name === 'Hidden data team')!.id;
    const secret = await dana('POST', '/data-objects', { key: 'secret-object', name: 'Secret object' });
    await s.api('PUT', `/owning-teams/data_object/${secret.id}`, { teamIds: [team] });
    const all = (await vera('GET', '/data-products/export')) as string;
    expect(all).not.toContain('hidden-product');
    expect(all).not.toContain('secret-object');
    expect(all).not.toContain('HIDDEN.S.T');
    expect(all).toContain('key: orders');
    const mine = (await dana('GET', '/data-products/export')) as string;
    expect(mine).toContain('hidden-product');
    expect(mine).toContain('secret-object');
    // a domain, an environment
    const sales = (await dana('GET', '/data-domains')).find((d: { key: string }) => d.key === 'sales');
    const byDomain = YAML.parse((await dana('GET', `/data-products/export?domain=${sales.id}`)) as string);
    expect(byDomain.data_products.map((p: { key: string }) => p.key)).toEqual(['orders']);
    expect(byDomain.domains.map((d: { key: string }) => d.key)).toEqual(['sales', 'orders']);
    const dev = YAML.parse((await dana('GET', '/data-products/export?environment=dev')) as string);
    expect(dev.data_products ?? []).toEqual([]);
  });
});

describe('ODPS', () => {
  it('exports a product as ODPS v1.0.0, valid against the vendored official schema', async () => {
    const { odpsProblems } = await import('../src/dataproducts/odps.js');
    const id = (await dana('GET', '/data-products?q=orders')).items.find((p: { key: string }) => p.key === 'orders').id;
    // a contract for the output port, so it carries its ODCS id
    const contract = await dana('POST', '/data-contracts', {
      yaml: 'apiVersion: v3.0.2\nkind: DataContract\nid: shop-orders\nname: Shop orders\nversion: 1.0.0\nstatus: active\nschema:\n  - name: orders\n    properties:\n      - name: order_id\n        logicalType: string\n',
    });
    const got = await dana('GET', `/data-products/${id}`);
    const out = got.ports.find((x: { direction: string }) => x.direction === 'output');
    const element = out.bindings[0].elementIds;
    await dana('PUT', `/data-products/${id}/ports/${out.id}/bindings/prod`, { elementIds: element, contractId: contract.id ?? contract.contract?.id });
    const text = (await dana('GET', `/data-products/${id}/odps`)) as string;
    const doc = YAML.parse(text);
    expect(odpsProblems(doc)).toEqual([]);
    expect(doc).toMatchObject({
      apiVersion: 'v1.0.0',
      kind: 'DataProduct',
      id: 'orders',
      name: 'Orders',
      status: 'active',
      version: '2.1',
      domain: 'Orders',
      description: { purpose: 'Order analytics' },
      tags: ['shop'],
      outputPorts: [{ name: 'orders', version: 'v2', contractId: 'shop-orders' }],
      team: { members: [{ username: 'dana', role: 'productOwner' }] },
      support: [{ channel: '#orders', url: 'https://wiki.example/orders' }],
    });
    // an input port without a contract is not an ODPS input port (it needs one): kept under customProperties
    expect(doc.inputPorts).toBeUndefined();
    expect(doc.customProperties.find((c: { property: string }) => c.property === 'inputsWithoutContract').value[0]).toMatchObject({ name: 'events' });
    // the schema really checks: a document without a status is refused
    const { status: _s, ...noStatus } = doc;
    expect(odpsProblems(noStatus).length).toBeGreaterThan(0);
    // the same through /api/v1 (JSON)
    const tok = (await dana('POST', '/me/tokens', { name: 'odps', scope: 'read' })).token;
    const v1 = await fetch(`${s.base}/api/v1/data-products/${id}/odps`, { headers: { authorization: `Bearer ${tok}` } });
    expect(v1.status).toBe(200);
    expect(odpsProblems(await v1.json())).toEqual([]);
  });
});
