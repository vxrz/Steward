import { beforeAll, describe, expect, it } from 'vitest';
import { DATA_GRAPH_LIMITS, collapsePipeline, drawnNodes, type DataLineageView, type DataPipelineView, type DataProductMapView } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The pictures of the data products module (ADR 0036 part 13, WP6) through their routes: a product's pipeline per
 * environment, the product map with its filters, the lineage of an element across products; team scope (what a reader
 * may not see is drawn without a name or id, and counted); a fixed number of statements per request; a pipeline of
 * 2,000 elements answered quickly.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let snowflake = '';
let kafka = '';
const counted = new Map<string, number>();
const ids: Record<string, string> = {};

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string } };
    return { status: err.status, code: err.body?.code ?? '' };
  }
  throw new Error('expected a refusal');
};

const element = async (qualifiedName: string, layer: string, environment = 'prod', kind = 'snowflake.table', platformId = snowflake) =>
  (await dana('POST', '/data-elements', { platformId, kind, qualifiedName, environment, layer })).id as string;

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
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  kafka = platforms.find((p) => p.kind === 'kafka')!.id;

  // Sales (sub-domain Orders); products Orders (source-aligned) → Sales mart (consumer-aligned) through a port
  const sales = (await dana('POST', '/data-domains', { key: 'sales', name: 'Sales' })).id;
  ids.ordersDomain = (await dana('POST', '/data-domains', { key: 'orders', name: 'Orders', parentId: sales })).id;
  ids.orders = (await dana('POST', '/data-products', { key: 'orders', name: 'Orders', type: 'sourceAligned', domainId: ids.ordersDomain })).id;
  ids.mart = (await dana('POST', '/data-products', { key: 'sales-mart', name: 'Sales mart', type: 'consumerAligned', domainId: sales })).id;
  ids.topic = await element('orders.v1', 'source', 'prod', 'kafka.topic', kafka);
  ids.raw = await element('SHOP.RAW.ORDERS', 'raw');
  ids.staged = await element('SHOP.STAGED.ORDERS', 'staged');
  ids.curated = await element('SHOP.CURATED.ORDERS', 'curated');
  ids.devRaw = await element('SHOP_DEV.RAW.ORDERS', 'raw', 'dev');
  ids.martTable = await element('SHOP.MART.REVENUE', 'mart');
  await dana('POST', `/data-products/${ids.orders}/members`, { elementIds: [ids.topic], role: 'input' });
  await dana('POST', `/data-products/${ids.orders}/members`, { elementIds: [ids.raw, ids.staged, ids.devRaw], role: 'internal' });
  const out = await dana('POST', `/data-products/${ids.orders}/ports`, { direction: 'output', name: 'orders', type: 'table', version: 'v2' });
  ids.outPort = out.id;
  await dana('PUT', `/data-products/${ids.orders}/ports/${out.id}/bindings/prod`, { elementIds: [ids.curated] });
  await dana('POST', `/data-products/${ids.orders}/steps`, {
    name: 'ingest',
    kind: 'ingest',
    inputs: [ids.topic],
    outputs: [ids.raw],
    runner: { kind: 'tool', tool: 'Kafka Connect', text: '' },
  });
  await dana('POST', `/data-products/${ids.orders}/steps`, { name: 'stage', kind: 'stage', inputs: [ids.raw], outputs: [ids.staged] });
  await dana('POST', `/data-products/${ids.orders}/steps`, { name: 'curate', kind: 'curate', inputs: [ids.staged], outputs: [ids.curated] });
  await dana('POST', `/data-products/${ids.mart}/members`, { elementIds: [ids.martTable], role: 'output' });
  const inPort = await dana('POST', `/data-products/${ids.mart}/ports`, { direction: 'input', name: 'orders', source: { kind: 'port', portId: out.id } });
  ids.inPort = inPort.id;
  await dana('POST', `/data-products/${ids.mart}/steps`, { name: 'revenue', kind: 'transform', inputs: [ids.curated], outputs: [ids.martTable] });

  // a team's product and element that vera may not see: it feeds Orders' raw table
  const team = (await s.api('POST', '/teams', { name: 'Secret team', members: ['dana'] })).id;
  ids.secret = (await dana('POST', '/data-products', { key: 'secret-crm', name: 'Secret CRM' })).id;
  ids.secretEl = await element('SECRET.CRM.CUSTOMERS', 'raw');
  await s.api('PUT', `/owning-teams/data_product/${ids.secret}`, { teamIds: [team] });
  await s.api('PUT', `/owning-teams/data_element/${ids.secretEl}`, { teamIds: [team] });
  await dana('POST', `/data-products/${ids.secret}/members`, { elementIds: [ids.secretEl], role: 'output' });
  const secretOut = await dana('POST', `/data-products/${ids.secret}/ports`, { direction: 'output', name: 'customers', version: 'v1' });
  await dana('POST', `/data-products/${ids.orders}/ports`, { direction: 'input', name: 'customers', source: { kind: 'port', portId: secretOut.id } });
  await dana('POST', `/data-products/${ids.orders}/steps`, { name: 'enrich', kind: 'transform', inputs: [ids.secretEl, ids.raw], outputs: [ids.staged] });
}, 180_000);

describe('the pipeline of a product', () => {
  it('draws the members in columns by role and layer in production first, with steps and ports', async () => {
    const v = (await dana('GET', `/data-products/${ids.orders}/views/pipeline`)) as DataPipelineView;
    expect(v).toMatchObject({ view: 'pipeline', product: { id: ids.orders, name: 'Orders' }, environment: 'prod' });
    expect(v.environments).toEqual(['prod', 'dev']);
    const node = (id: string) => v.nodes.find((n) => n.id === id);
    expect(node(ids.topic)).toMatchObject({ role: 'input', column: 1, elementKind: 'kafka.topic', health: 'noData' });
    expect(node(ids.curated)).toMatchObject({ role: 'output', ports: ['orders v2'] });
    // the dev element is not in production's picture
    expect(node(ids.devRaw)).toBeUndefined();
    // Sales mart's table reads the output: a neighbour downstream, named with its product
    expect(node(ids.martTable)).toMatchObject({ outside: true, products: ['Sales mart'] });
    // the secret CRM table feeds raw: upstream; the mart table reads the output: downstream
    expect(v.columns.map((c) => c.kind)).toEqual(['upstream', 'input', 'layer', 'layer', 'output', 'downstream']);
    expect(v.edges.find((e) => e.from === ids.topic && e.to === ids.raw)).toMatchObject({ labels: ['ingest'], stepKind: 'ingest' });
    expect(v.steps.find((x) => x.name === 'ingest')?.runner).toBe('Kafka Connect');
  });

  it('switches to another environment', async () => {
    const v = (await dana('GET', `/data-products/${ids.orders}/views/pipeline?environment=dev`)) as DataPipelineView;
    expect(v.environment).toBe('dev');
    expect(v.nodes.map((n) => n.id)).toEqual([ids.devRaw]);
  });

  it('draws what the reader may not see without a name or id, and counts it', async () => {
    const mine = (await dana('GET', `/data-products/${ids.orders}/views/pipeline`)) as DataPipelineView;
    expect(mine.nodes.find((n) => n.id === ids.secretEl)).toMatchObject({ label: 'CUSTOMERS', products: ['Secret CRM'] });
    const v = (await vera('GET', `/data-products/${ids.orders}/views/pipeline`)) as DataPipelineView;
    const text = JSON.stringify(v);
    expect(text).not.toContain(ids.secretEl);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('Secret CRM');
    expect(text).not.toContain(ids.secret);
    expect(v.hidden.elements).toBe(1);
    const hidden = v.nodes.find((n) => n.hidden)!;
    expect(hidden).toMatchObject({ id: 'hidden-1', label: '', outside: true, path: null });
    // the step from it stays: the picture is true
    expect(v.edges.find((e) => e.from === hidden.id)).toMatchObject({ to: ids.staged, labels: ['enrich'] });
  });

  it('answers 404 for a product the reader may not see', async () => {
    expect(await fail(vera('GET', `/data-products/${ids.secret}/views/pipeline`))).toMatchObject({ status: 404, code: 'DATA_PRODUCT_NOT_FOUND' });
    expect(await fail(dana('GET', `/data-products/dpr_none/views/pipeline`))).toMatchObject({ status: 404, code: 'DATA_PRODUCT_NOT_FOUND' });
  });
});

describe('the product map', () => {
  it('draws products in their domains with the dependencies from output to input port', async () => {
    const v = (await dana('GET', '/data-products/map')) as DataProductMapView;
    expect(v.view).toBe('map');
    expect(v.nodes.find((n) => n.id === ids.orders)).toMatchObject({ parent: `domain:${ids.ordersDomain}`, productType: 'sourceAligned', health: 'noData' });
    expect(v.nodes.find((n) => n.id === `domain:${ids.ordersDomain}`)).toMatchObject({ group: true, label: 'Orders' });
    expect(v.edges.find((e) => e.from === ids.orders && e.to === ids.mart)).toMatchObject({ labels: ['orders v2'] });
    expect(v.edges.find((e) => e.from === ids.secret && e.to === ids.orders)).toMatchObject({ labels: ['customers v1'] });
    expect(v.options.domains.map((d) => d.name).sort()).toEqual(['Orders', 'Sales']);
  });

  it('filters by domain, type, lifecycle and environment, keeping the neighbours of what matches', async () => {
    const byType = (await dana('GET', '/data-products/map?type=consumerAligned')) as DataProductMapView;
    expect(byType.matching).toBe(1);
    expect(byType.nodes.find((n) => n.id === ids.mart)?.outside).toBeFalsy();
    expect(byType.nodes.find((n) => n.id === ids.orders)?.outside).toBe(true);
    // a domain includes its sub-domains
    const sales = (await dana('GET', '/data-products/map')) as DataProductMapView;
    const salesId = sales.options.domains.find((d) => d.name === 'Sales')!.id;
    expect(((await dana('GET', `/data-products/map?domain=${salesId}`)) as DataProductMapView).matching).toBe(2);
    expect(((await dana('GET', '/data-products/map?lifecycle=retired')) as DataProductMapView).nodes).toEqual([]);
    expect(((await dana('GET', '/data-products/map?environment=dev')) as DataProductMapView).matching).toBe(1);
    expect((await fail(dana('GET', '/data-products/map?type=nonsense'))).status).toBe(400);
  });

  it('draws products the reader may not see without a name or id', async () => {
    const v = (await vera('GET', '/data-products/map')) as DataProductMapView;
    const text = JSON.stringify(v);
    expect(text).not.toContain(ids.secret);
    expect(text).not.toContain('Secret CRM');
    expect(text).not.toContain('customers v1');
    expect(v.hidden.products).toBe(1);
    expect(v.edges.find((e) => e.to === ids.orders)).toMatchObject({ from: 'hidden-1', labels: [] });
  });
});

describe('the lineage of an element', () => {
  it('walks upstream and downstream across products, 1 to 4 steps', async () => {
    const v = (await dana('GET', `/data-elements/${ids.staged}/lineage?depth=1`)) as DataLineageView;
    expect(v).toMatchObject({ view: 'lineage', depth: 1, element: { id: ids.staged, qualifiedName: 'SHOP.STAGED.ORDERS' } });
    const dist = (id: string) => v.nodes.find((n) => n.id === id)?.distance;
    expect([dist(ids.raw), dist(ids.staged), dist(ids.curated), dist(ids.martTable)]).toEqual([-1, 0, 1, undefined]);
    const deep = (await dana('GET', `/data-elements/${ids.staged}/lineage?depth=4`)) as DataLineageView;
    expect(deep.nodes.find((n) => n.id === ids.martTable)).toMatchObject({ distance: 2, parent: `product:${ids.mart}` });
    expect(deep.nodes.find((n) => n.id === `product:${ids.orders}`)).toMatchObject({ group: true, label: 'Orders' });
    expect((await fail(dana('GET', `/data-elements/${ids.staged}/lineage?depth=5`))).status).toBe(400);
  });

  it('keeps hidden elements in the lineage without a name or id', async () => {
    const v = (await vera('GET', `/data-elements/${ids.staged}/lineage?depth=2`)) as DataLineageView;
    const text = JSON.stringify(v);
    expect(text).not.toContain(ids.secretEl);
    expect(text).not.toContain('SECRET');
    expect(v.hidden.elements).toBe(1);
    expect(v.nodes.find((n) => n.hidden)).toMatchObject({ distance: -1, label: '' });
    expect(await fail(vera('GET', `/data-elements/${ids.secretEl}/lineage`))).toMatchObject({ status: 404, code: 'DATA_ELEMENT_NOT_FOUND' });
  });
});

describe('statements and time', () => {
  /** Statements of one GET as dana (the second call: caches of the first are warm). */
  async function statements(url: string): Promise<number> {
    await dana('GET', url);
    counted.delete(`/api${url}`);
    await dana('GET', url);
    return counted.get(`/api${url}`) ?? -1;
  }

  it('stay the same for the pipeline, the map and lineage with more products, members and steps', async () => {
    const p = ids.orders;
    const grow = async (n: number, tag: string) => {
      for (let i = 0; i < n; i++) {
        const prod = (await dana('POST', '/data-products', { key: `grown-${tag}-${i}`, name: `Grown ${tag} ${i}` })).id;
        const a = await element(`GROW.${tag}.A${i}`, 'staged');
        const b = await element(`GROW.${tag}.B${i}`, 'curated');
        await dana('POST', `/data-products/${p}/members`, { elementIds: [a], role: 'internal' });
        await dana('POST', `/data-products/${prod}/members`, { elementIds: [b], role: 'output' });
        await dana('POST', `/data-products/${p}/steps`, { name: `grow ${i}`, inputs: [ids.staged], outputs: [a], runner: { kind: 'platform', id: snowflake } });
        await dana('POST', `/data-products/${prod}/steps`, { name: `out ${i}`, inputs: [a], outputs: [b] });
        await dana('POST', `/data-products/${prod}/ports`, { direction: 'input', name: 'orders', source: { kind: 'port', portId: ids.outPort } });
      }
    };
    await grow(2, 'a');
    const urls = [`/data-products/${p}/views/pipeline`, '/data-products/map', `/data-elements/${ids.staged}/lineage?depth=4`];
    const before = await Promise.all(urls.map(async (u) => [u, await statements(u)]));
    await grow(6, 'b');
    const after = await Promise.all(urls.map(async (u) => [u, await statements(u)]));
    console.log('statements', Object.fromEntries(after));
    expect(after).toEqual(before);
    for (const [, n] of after) expect(n as number).toBeLessThanOrEqual(40);
  });

  it('answers a pipeline of 2,000 elements and 2,000 steps quickly, and its picture collapses', async () => {
    const { db } = await import('../src/db.js');
    const big = (await dana('POST', '/data-products', { key: 'big', name: 'Big' })).id;
    const now = new Date().toISOString();
    const n = DATA_GRAPH_LIMITS.nodes;
    db().tx(() => {
      for (let i = 0; i < n; i++) {
        const layer = ['raw', 'staged', 'curated', 'mart'][i % 4]!;
        db().run(
          `INSERT INTO dp_elements (id, platform_id, kind, qualified_name, name_norm, display_name, environment, layer, source, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'snowflake.table', ?, ?, ?, 'prod', ?, 'entered', ?, 'dana', ?, 'dana')`,
          `dpe_big${i}`,
          snowflake,
          `BIG.${layer.toUpperCase()}.T${i}`,
          `big.${layer}.t${i}`,
          `T${i}`,
          layer,
          now,
          now,
        );
        db().run(
          `INSERT INTO dp_members (product_id, element_id, role, include_descendants, note, added_by, added_at) VALUES (?, ?, 'internal', 0, '', 'dana', ?)`,
          big,
          `dpe_big${i}`,
          now,
        );
        if (i > 0) {
          db().run(
            `INSERT INTO dp_steps (id, name, step_kind, schedule, description, notes, created_at, created_by, updated_at, updated_by) VALUES (?, ?, 'transform', '', '', '[]', ?, 'dana', ?, 'dana')`,
            `dps_big${i}`,
            `step ${i}`,
            now,
            now,
          );
          db().run(`INSERT INTO dp_step_elements (step_id, element_id, direction) VALUES (?, ?, 'in')`, `dps_big${i}`, `dpe_big${i - 1}`);
          db().run(`INSERT INTO dp_step_elements (step_id, element_id, direction) VALUES (?, ?, 'out')`, `dps_big${i}`, `dpe_big${i}`);
        }
      }
    });
    const url = `/data-products/${big}/views/pipeline`;
    await dana('GET', url);
    const t0 = performance.now();
    const v = (await dana('GET', url)) as DataPipelineView;
    const ms = performance.now() - t0;
    console.log('pipeline of 2,000', { ms: Math.round(ms), statements: counted.get(`/api${url}`) });
    expect(drawnNodes(v)).toHaveLength(n);
    expect(v.edges).toHaveLength(n - 1);
    expect(ms).toBeLessThan(3_000);
    expect(counted.get(`/api${url}`)).toBeLessThanOrEqual(80);
    expect(drawnNodes(collapsePipeline(v)).length).toBeLessThanOrEqual(DATA_GRAPH_LIMITS.pipelinePicture);
  });
});
