import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The data products module in the public API (/api/v1/data-products, /data-elements, /data-objects) and for AI
 * assistants (MCP read tools, and the data contract read tools) – ADR 0036 parts 14 and 19, WP7: as the token owner,
 * with team scope (a second user sees neither the team's product nor its element, they are counted where a visible
 * item names them), paged, off with the module, and a fixed number of statements per list page.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
const MODERN = '2026-07-28';
let s: TestServer;
let dana: Client;
let vera: Client;
const mcp: Record<string, string> = {};
const rest: Record<string, string> = {};
const counted = new Map<string, number>();
let nextId = 1;
let snowflakeName = '';
let hiddenProduct = '';
let hiddenElement = '';
let sharedElement = '';
let orders = '';

async function rpc(token: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const name = method === 'tools/call' ? params.name : undefined;
  const res = await fetch(`${s.base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        },
      },
    }),
  });
  expect(res.status).toBe(200);
  return res.json();
}
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
  const body = await rpc(token, 'tools/call', { name, arguments: args });
  if (body.error) return { isError: true, data: body.error.message };
  const r = body.result;
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : r.structuredContent };
}
const toolNames = async (token: string): Promise<string[]> => (await rpc(token, 'tools/list')).result.tools.map((t: { name: string }) => t.name);

async function v1(token: string, url: string): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

const DATA_TOOLS = [
  'list_data_products',
  'get_data_product',
  'search_data_elements',
  'get_data_element',
  'get_data_lineage',
  'get_data_product_health',
  'get_data_product_costs',
  'list_data_objects',
  'get_data_object',
];

beforeAll(async () => {
  s = await startTestServer({
    routes: (app) =>
      app.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(req.url, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  await s.api('PUT', '/mcp-server', { enabled: true });
  mcp.dana = (await dana('POST', '/me/tokens', { name: 'mcp dana', scope: 'mcp' })).token;
  mcp.vera = (await vera('POST', '/me/tokens', { name: 'mcp vera', scope: 'mcp' })).token;
  rest.dana = (await dana('POST', '/me/tokens', { name: 'api dana', scope: 'read' })).token;
  rest.vera = (await vera('POST', '/me/tokens', { name: 'api vera', scope: 'read' })).token;
  snowflakeName = ((await s.api('GET', '/platforms')) as { kind: string; name: string }[]).find((p) => p.kind === 'snowflake')!.name;
}, 180_000);

describe('while the module is off', () => {
  it('lists no data product tools and answers 404 on /api/v1; the data contract tools are there', async () => {
    const names = await toolNames(mcp.dana);
    for (const t of DATA_TOOLS) expect(names).not.toContain(t);
    expect(names).toEqual(expect.arrayContaining(['list_data_contracts', 'get_data_contract']));
    expect((await call(mcp.dana, 'list_data_products')).isError).toBe(true);
    expect((await v1(rest.dana, '/data-products')).status).toBe(404);
    expect((await v1(rest.dana, '/data-elements')).status).toBe(404);
    expect((await v1(rest.dana, '/data-objects')).status).toBe(404);
  });
});

describe('with the module on', () => {
  beforeAll(async () => {
    await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
    const el = (q: string, layer = 'curated') => ({ platform: snowflakeName, kind: 'snowflake.table', qualified_name: q, environment: 'prod', layer });
    const ref = (q: string) => ({ platform: snowflakeName, kind: 'snowflake.table', qualified_name: q, environment: 'prod' });
    const doc = {
      version: 1,
      domains: [{ key: 'sales', name: 'Sales' }],
      data_objects: [{ key: 'customer', name: 'Customer', classification: 'confidential', personal_data: 'personal', domain: 'sales' }],
      elements: [el('CRM.PUBLIC.CUSTOMERS', 'source'), el('SHOP.RAW.ORDERS', 'raw'), el('SHOP.CURATED.ORDERS')],
      data_products: [
        {
          key: 'orders',
          name: 'Orders',
          domain: 'sales',
          type: 'sourceAligned',
          owners: ['user:dana'],
          members: [{ element: ref('CRM.PUBLIC.CUSTOMERS'), role: 'input' }, { element: ref('SHOP.RAW.ORDERS') }],
          ports: [{ direction: 'output', name: 'orders', version: 'v1', data_objects: ['customer'], bindings: [{ environment: 'prod', elements: [ref('SHOP.CURATED.ORDERS')] }] }],
          steps: [
            { name: 'Load', kind: 'ingest', inputs: [ref('CRM.PUBLIC.CUSTOMERS')], outputs: [ref('SHOP.RAW.ORDERS')] },
            { name: 'Curate', kind: 'curate', inputs: [ref('SHOP.RAW.ORDERS')], outputs: [ref('SHOP.CURATED.ORDERS')] },
          ],
        },
      ],
    };
    const r = await dana('POST', '/data-products/import', { files: [{ name: 'a.yaml', content: YAML.stringify(doc) }], mode: 'update' });
    expect(r.counts.add).toBe(6);
    orders = (await dana('GET', '/data-products')).items[0].id;
    sharedElement = (await dana('GET', '/data-elements?prefix=crm.public.customers')).items[0].id;
    // a team's product with an element of its own, which also reads the shared element
    const team = (await s.api('POST', '/teams', { name: 'Secret team', members: ['dana'] })).id;
    const p = await dana('POST', '/data-products', { key: 'secret-product', name: 'Secret product' });
    hiddenProduct = p.id;
    const e = await dana('POST', '/data-elements', {
      platformId: ((await s.api('GET', '/platforms')) as { id: string; kind: string }[]).find((x) => x.kind === 'snowflake')!.id,
      kind: 'snowflake.table',
      qualifiedName: 'SECRET.S.T',
      environment: 'prod',
    });
    hiddenElement = e.id;
    for (const [kind, id] of [
      ['data_product', p.id],
      ['data_element', e.id],
    ])
      await s.api('PUT', `/owning-teams/${kind}/${id}`, { teamIds: [team] });
    await dana('POST', `/data-products/${p.id}/members`, { elementIds: [sharedElement, e.id], role: 'input' });
  });

  it('lists the read tools to who uses the module, and names only what the token owner may see', async () => {
    for (const t of [mcp.dana, mcp.vera]) expect(await toolNames(t)).toEqual(expect.arrayContaining(DATA_TOOLS));
    const asDana = (await call(mcp.dana, 'list_data_products')).data;
    expect(asDana.items.map((x: { key: string }) => x.key).sort()).toEqual(['orders', 'secret-product']);
    const asVera = (await call(mcp.vera, 'list_data_products')).data;
    expect(asVera.items.map((x: { key: string }) => x.key)).toEqual(['orders']);
    expect(asVera.total).toBe(1);
    expect(asVera.items[0]).toMatchObject({ domain: 'Sales', health: 'noData', type: 'sourceAligned' });
    // a product they may not see is like a missing one
    const hidden = await call(mcp.vera, 'get_data_product', { productId: hiddenProduct });
    expect(hidden.isError).toBe(true);
    expect(hidden.data).toMatch(/or you may not see it/);
    expect((await call(mcp.vera, 'get_data_product', { productId: 'secret-product' })).isError).toBe(true);
    // the shared element: the hidden product counted, never named
    const shared = (await call(mcp.vera, 'get_data_element', { elementId: sharedElement })).data;
    expect(shared.products).toEqual({ visible: 1, hidden: 1 });
    expect(JSON.stringify(shared)).not.toContain('Secret product');
    const search = (await call(mcp.vera, 'search_data_elements', { prefix: 'SECRET.' })).data;
    expect(search.total).toBe(0);
    expect((await call(mcp.dana, 'search_data_elements', { prefix: 'SECRET.' })).data.total).toBe(1);
  });

  it('gives a product with ports, members, steps, health and the scorecard; pages members', async () => {
    const p = (await call(mcp.vera, 'get_data_product', { productId: 'orders', memberLimit: 1 })).data;
    expect(p).toMatchObject({ key: 'orders', memberCounts: { input: 1, internal: 1, output: 1 }, scorecard: { available: false } });
    expect(p.ports[0]).toMatchObject({ name: 'orders', version: 'v1', objects: { declared: [{ key: 'customer' }] } });
    expect(p.members.items).toHaveLength(1);
    expect(p.members.nextCursor).toBeTruthy();
    const next = (await call(mcp.vera, 'get_data_product', { productId: orders, memberCursor: p.members.nextCursor, memberLimit: 5 })).data;
    expect(next.members.items).toHaveLength(2);
    expect(p.steps.map((x: { name: string }) => x.name).sort()).toEqual(['Curate', 'Load']);
    const health = (await call(mcp.vera, 'get_data_product_health', { productId: 'orders' })).data;
    expect(health.environments[0]).toMatchObject({ environment: 'prod', status: 'noData' });
    const costs = (await call(mcp.vera, 'get_data_product_costs', { productId: 'orders' })).data;
    expect(costs).toMatchObject({ available: false, months: [] });
  });

  it('follows the lineage of an element and of a product, hidden products counted', async () => {
    const curated = (await call(mcp.vera, 'search_data_elements', { prefix: 'SHOP.CURATED.' })).data.items[0].id;
    const l = (await call(mcp.vera, 'get_data_lineage', { elementId: curated, depth: 4 })).data;
    expect(l.view).toBe('lineage');
    expect(l.nodes.some((n: { label?: string }) => n.label === 'CUSTOMERS')).toBe(true);
    const pl = (await call(mcp.vera, 'get_data_lineage', { productId: 'orders' })).data;
    expect(pl.view).toBe('pipeline');
    expect(JSON.stringify(pl)).not.toContain('Secret product');
    expect((await call(mcp.vera, 'get_data_lineage', {})).isError).toBe(true);
  });

  it('lists and gives data objects', async () => {
    const list = (await call(mcp.vera, 'list_data_objects', { personalData: 'personal' })).data;
    expect(list.items.map((o: { key: string }) => o.key)).toEqual(['customer']);
    const o = (await call(mcp.vera, 'get_data_object', { objectId: 'customer' })).data;
    expect(o).toMatchObject({ key: 'customer', classification: 'confidential', domain: 'Sales', products: { items: [{ key: 'orders' }], hidden: 0 } });
  });

  it('reads data contracts: the list and a contract with its YAML, findings and last test', async () => {
    // made by the administrator (no owning team): every working role sees it; dana's new items would go to her team
    const c = await s.api('POST', '/data-contracts', {
      yaml: 'apiVersion: v3.0.2\nkind: DataContract\nid: crm-customers\nname: CRM customers\nversion: 1.0.0\nstatus: active\nschema:\n  - name: customers\n',
    });
    const id = c.id ?? c.contract.id;
    const list = (await call(mcp.vera, 'list_data_contracts', { query: 'crm' })).data;
    expect(list.items.map((x: { key: string }) => x.key)).toEqual(['crm-customers']);
    const got = (await call(mcp.vera, 'get_data_contract', { contractId: id })).data;
    expect(got).toMatchObject({ key: 'crm-customers', version: 1, lastTest: null });
    expect(got.yaml).toContain('id: crm-customers');
    expect((await call(mcp.vera, 'get_data_contract', { contractId: id, version: 9 })).isError).toBe(true);
  });

  it('serves /api/v1 with paging, filters and team scope', async () => {
    const all = await v1(rest.dana, '/data-products?limit=1');
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(1);
    expect(all.body.nextCursor).toBeTruthy();
    expect(all.headers.get('link')).toContain('rel="next"');
    const second = await v1(rest.dana, `/data-products?limit=1&cursor=${all.body.nextCursor}`);
    expect(second.body.items[0].key).not.toBe(all.body.items[0].key);
    expect(second.body.nextCursor).toBeNull();
    const asVera = await v1(rest.vera, '/data-products');
    expect(asVera.body.items.map((x: { key: string }) => x.key)).toEqual(['orders']);
    expect((await v1(rest.vera, `/data-products/${hiddenProduct}`)).status).toBe(404);
    expect((await v1(rest.vera, `/data-elements/${hiddenElement}`)).status).toBe(404);
    expect((await v1(rest.vera, '/data-products?type=aggregate')).body.items).toEqual([]);
    expect((await v1(rest.vera, '/data-products?lifecycle=proposed')).body.items).toHaveLength(1);
    const detail = (await v1(rest.vera, `/data-products/${orders}`)).body;
    expect(detail).toMatchObject({ key: 'orders', health: { environment: 'prod', status: 'noData' }, scorecard: { available: false } });
    expect(detail.ports[0].bindings[0]).toMatchObject({ environment: 'prod', contractId: null, contractKey: null });
    const lineage = (await v1(rest.vera, `/data-products/${orders}/lineage`)).body;
    expect(lineage).toMatchObject({ view: 'pipeline', product: { key: 'orders' }, environment: 'prod' });
    const el = (await v1(rest.vera, `/data-products/${orders}/lineage?element=${sharedElement}&depth=2`)).body;
    expect(el).toMatchObject({ view: 'lineage', element: { qualifiedName: 'CRM.PUBLIC.CUSTOMERS' } });
    expect((await v1(rest.vera, `/data-products/${orders}/lineage?element=${hiddenElement}`)).status).toBe(404);
    const elements = (await v1(rest.vera, '/data-elements?prefix=shop.')).body;
    expect(elements.items.map((x: { qualifiedName: string }) => x.qualifiedName)).toEqual(['SHOP.CURATED.ORDERS', 'SHOP.RAW.ORDERS']);
    const shared = (await v1(rest.vera, `/data-elements/${sharedElement}`)).body;
    expect(shared.products).toEqual({ visible: 1, hidden: 1 });
    expect(JSON.stringify(shared)).not.toContain('Secret');
    const objects = (await v1(rest.vera, '/data-objects?classification=confidential')).body;
    expect(objects.items.map((x: { key: string }) => x.key)).toEqual(['customer']);
    const object = (await v1(rest.vera, `/data-objects/${objects.items[0].id}`)).body;
    expect(object.products).toEqual({ items: [{ id: orders, key: 'orders', name: 'Orders', hidden: false }], hidden: 0 });
    expect((await v1(rest.vera, '/data-products?cursor=garbage')).status).toBe(400);
  });

  it('reads a list page with a fixed number of statements, whatever the number of products and elements', async () => {
    const statements = async (url: string) => {
      await v1(rest.dana, url);
      counted.delete(`/api/v1${url}`);
      await v1(rest.dana, url);
      return counted.get(`/api/v1${url}`) ?? -1;
    };
    const grow = async (n: number, tag: string) => {
      const doc = {
        version: 1,
        data_objects: Array.from({ length: n }, (_, i) => ({ key: `obj-${tag}-${i}`, name: `Object ${tag} ${i}` })),
        elements: Array.from({ length: n }, (_, i) => ({ platform: snowflakeName, kind: 'snowflake.table', qualified_name: `GROW.${tag}.T${i}`, environment: 'prod' })),
        data_products: Array.from({ length: n }, (_, i) => ({
          key: `grown-${tag}-${i}`,
          name: `Grown ${tag} ${i}`,
          members: [{ element: { platform: snowflakeName, kind: 'snowflake.table', qualified_name: `GROW.${tag}.T${i}`, environment: 'prod' }, role: 'output' }],
          ports: [{ direction: 'output', name: 'out', data_objects: [`obj-${tag}-${i}`] }],
        })),
      };
      await dana('POST', '/data-products/import', { files: [{ name: `${tag}.yaml`, content: YAML.stringify(doc) }], mode: 'update' });
    };
    const urls = ['/data-products', '/data-elements', '/data-objects'];
    await grow(2, 'a');
    const before: number[] = [];
    for (const u of urls) before.push(await statements(u));
    await grow(8, 'b');
    const after: number[] = [];
    for (const u of urls) after.push(await statements(u));
    console.log('statements', Object.fromEntries(urls.map((u, i) => [u, after[i]])));
    expect(after).toEqual(before);
    for (const n of after) expect(n).toBeLessThanOrEqual(40);
  });
});
