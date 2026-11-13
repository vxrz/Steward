import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The data products module (ADR 0036, WP1): domains, data objects, products, the element catalogue, many-to-many
 * membership with roles, ports with bindings and contracts, consumers, steps; ratings with the floor rule, the
 * lifecycle, environments; rights and team scope on every read; the store's discovery writes; statement counts.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let olivia: Client;
let audrey: Client;
let snowflake = '';
let kafka = '';
const counted = new Map<string, number>();

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};

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
  olivia = await s.as('olivia', PW);
  audrey = await s.as('audrey', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  kafka = platforms.find((p) => p.kind === 'kafka')!.id;
}, 180_000);

describe('the module', () => {
  it('is off by default: its routes answer 404 MODULE_OFF until an administrator switches it on', async () => {
    const v = await s.api('GET', '/settings/modules');
    expect(v.modules.find((m: { id: string }) => m.id === 'dataProducts')).toMatchObject({ enabled: false, defaultOn: false, maturity: 'preview' });
    expect(await fail(s.api('GET', '/data-products'))).toMatchObject({ status: 404, code: 'MODULE_OFF' });
    await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
    expect((await s.api('GET', '/data-products')).items).toEqual([]);
    const st = await s.api('GET', '/auth/status');
    expect(st.me.capabilities.modules.dataProducts).toBe(true);
    // the other modules keep their default (on)
    expect(st.me.capabilities.modules.costs).toBe(true);
  });
});

describe('domains', () => {
  it('have two levels, unique keys, and are kept while they hold something', async () => {
    const sales = await dana('POST', '/data-domains', { key: 'sales', name: 'Sales' });
    const orders = await dana('POST', '/data-domains', { key: 'orders', name: 'Orders', parentId: sales.id });
    expect(orders.parentId).toBe(sales.id);
    expect(await fail(dana('POST', '/data-domains', { key: 'deep', name: 'Too deep', parentId: orders.id }))).toMatchObject({
      status: 400,
      code: 'DATA_DOMAIN_LEVELS',
    });
    expect(await fail(dana('POST', '/data-domains', { key: 'sales', name: 'Again' }))).toMatchObject({ status: 409, code: 'DATA_PRODUCT_KEY_TAKEN' });
    // only the module's managers (designers) create domains
    expect((await fail(olivia('POST', '/data-domains', { key: 'ops', name: 'Ops' }))).status).toBe(403);
    expect(await fail(dana('DELETE', `/data-domains/${sales.id}`))).toMatchObject({ status: 409, code: 'DATA_DOMAIN_IN_USE' });
    expect((await vera('GET', '/data-domains')).map((d: { key: string }) => d.key).sort()).toEqual(['orders', 'sales']);
  });
});

describe('data objects, products and the rating floor', () => {
  let customer = '';
  let product = '';
  let element = '';
  it('rates a data object on the CIA scale with a classification and personal data', async () => {
    const o = await dana('POST', '/data-objects', {
      key: 'customer',
      name: 'Customer',
      definition: 'A person or company that buys.',
      classification: 'confidential',
      personalData: 'personal',
      categories: ['identification', 'contact'],
      subjects: ['customers'],
      legalBasis: 'contract',
      retention: 'P10Y',
      owner: 'dana',
      attributes: [{ name: 'email', description: 'Contact address', personal: true }],
    });
    customer = o.id;
    expect(o).toMatchObject({ key: 'customer', classification: 'confidential', personalData: 'personal', owner: 'dana', lifecycle: 'draft' });
    const rated = await dana('PUT', `/data-objects/${customer}/rating`, {
      confidentiality: { level: 'very_high', justification: 'Contact data of customers' },
    });
    expect(rated.rating.confidentiality).toMatchObject({ level: 'very_high', needsRerating: false });
    expect(await fail(dana('PUT', `/data-objects/${customer}/rating`, { integrity: { level: 'extreme', justification: 'x' } }))).toMatchObject({
      code: 'CIA_LEVEL_UNKNOWN',
    });
    // viewers read, never change
    expect((await vera('GET', `/data-objects/${customer}`)).name).toBe('Customer');
    expect((await fail(vera('PUT', `/data-objects/${customer}/rating`, { confidentiality: null }))).status).toBe(403);
  });

  it('warns when a product is rated below the data objects it exposes, and takes a reason', async () => {
    const p = await dana('POST', '/data-products', { key: 'customer-360', name: 'Customer 360', type: 'aggregate', owners: [] });
    product = p.id;
    expect(p).toMatchObject({ lifecycle: 'proposed', ratingBelowObjects: false, lifecycleDates: { proposed: expect.any(String) } });
    const e = await dana('POST', '/data-elements', {
      platformId: snowflake,
      kind: 'snowflake.table',
      qualifiedName: 'CRM.PUBLIC.CUSTOMERS',
      environment: 'prod',
      layer: 'curated',
    });
    element = e.id;
    await dana('POST', `/data-objects/${customer}/elements`, { elementId: element, note: 'all customers' });
    const port = await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'customer', type: 'table', version: 'v1' });
    await dana('PUT', `/data-products/${product}/ports/${port.id}/bindings/prod`, { elementIds: [element] });
    let got = await dana('GET', `/data-products/${product}`);
    // exposed through the element that implements Customer: C very high and confidential are the floor
    expect(got.ratingBelowObjects).toBe(true);
    expect(got.ratingFloor.findings.map((f: { dimension: string }) => f.dimension).sort()).toEqual(['classification', 'confidentiality']);
    expect(got.ratingFloor.highestClassification).toBe('confidential');
    expect(got.objects.map((o: { key: string }) => o.key)).toEqual(['customer']);
    // a reason for a dimension that is not below: nothing to explain
    expect(await fail(dana('PUT', `/data-products/${product}/rating`, { reasons: { integrity: 'aggregated only' } }))).toMatchObject({
      status: 400,
      code: 'DATA_PRODUCT_RATING_REASON',
    });
    got = await dana('PUT', `/data-products/${product}/rating`, {
      confidentiality: { level: 'high', justification: 'Aggregates only' },
      classification: 'internal',
      reasons: { confidentiality: 'Only aggregated figures leave the product', classification: 'Aggregates only' },
    });
    expect(got.ratingBelowObjects).toBe(false);
    expect(got.ratingFloor.findings.every((f: { reason: string | null }) => !!f.reason)).toBe(true);
    // rated at the floor: the reason goes
    got = await dana('PUT', `/data-products/${product}/rating`, {
      confidentiality: { level: 'very_high', justification: 'As its data' },
      classification: 'confidential',
    });
    expect(got.ratingFloor.findings).toEqual([]);
    expect(got.ratingReasons).toEqual({});
  });

  it('flags product and data object ratings for re-rating when the CIA scale drops their level', async () => {
    const scale = await s.api('GET', '/catalogue/cia-scale');
    expect(scale.usage.confidentiality.very_high).toBeGreaterThanOrEqual(2);
    await s.api('PUT', '/catalogue/cia-scale', {
      mode: 'shared',
      levels: [
        { key: 'normal', label: 'Normal', description: '', color: 'green' },
        { key: 'high', label: 'High', description: '', color: 'orange' },
      ],
    });
    const o = await dana('GET', `/data-objects/${customer}`);
    expect(o.rating.confidentiality).toMatchObject({ level: 'very_high', needsRerating: true, previousLabel: 'Very high' });
    const p = await dana('GET', `/data-products/${product}`);
    expect(p.rating.confidentiality.needsRerating).toBe(true);
    await s.api('PUT', '/catalogue/cia-scale', { mode: 'default' });
  });

  it('keeps the element shared between products: many to many, each with its own role', async () => {
    const other = await dana('POST', '/data-products', { key: 'sales-mart', name: 'Sales mart', type: 'consumerAligned' });
    await dana('POST', `/data-products/${other.id}/members`, { elementIds: [element], role: 'input' });
    const el = await dana('GET', `/data-elements/${element}`);
    expect(el.productRefs.map((r: { product: { key: string }; role: string }) => `${r.product.key}:${r.role}`).sort()).toEqual([
      'customer-360:output',
      'sales-mart:input',
    ]);
    // removing it from one product never touches the other
    await dana('DELETE', `/data-products/${other.id}/members/${element}`);
    expect((await dana('GET', `/data-elements/${element}`)).products).toEqual({ visible: 1, hidden: 0 });
    // the role follows the ports: bound to an output port, it stays an output member
    expect(await fail(dana('PUT', `/data-products/${product}/members/${element}`, { role: 'internal' }))).toMatchObject({ code: 'DATA_PORT_BINDING' });
    // an element in the catalogue cannot be deleted while it is part of a product
    expect(await fail(dana('DELETE', `/data-elements/${element}`))).toMatchObject({ status: 409, code: 'DATA_ELEMENT_IN_USE' });
  });
});

describe('the element catalogue', () => {
  it('keeps an element unique by platform, kind, environment and name, and fits its kind to the platform', async () => {
    await dana('POST', '/data-elements', { platformId: snowflake, kind: 'snowflake.database', qualifiedName: 'SHOP', environment: 'prod' });
    expect(
      await fail(dana('POST', '/data-elements', { platformId: snowflake, kind: 'snowflake.database', qualifiedName: 'shop', environment: 'prod' })),
    ).toMatchObject({
      status: 409,
      code: 'DATA_ELEMENT_EXISTS',
    });
    // the same name in another environment is another element
    await dana('POST', '/data-elements', { platformId: snowflake, kind: 'snowflake.database', qualifiedName: 'SHOP', environment: 'dev' });
    expect(await fail(dana('POST', '/data-elements', { platformId: kafka, kind: 'snowflake.table', qualifiedName: 'X.Y.Z' }))).toMatchObject({
      code: 'DATA_ELEMENT_PLATFORM',
    });
    expect(await fail(dana('POST', '/data-elements', { kind: 'kafka.topic', qualifiedName: 'orders.v1' }))).toMatchObject({ code: 'DATA_ELEMENT_PLATFORM' });
    // an API needs no platform
    await dana('POST', '/data-elements', { kind: 'api.endpoint', qualifiedName: 'https://shop.example/api/orders' });
  });

  it('pages by name with a prefix (by index) and a text search, and says what is in no product', async () => {
    for (let i = 0; i < 5; i++)
      await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: `shop-events.page${i}`, environment: 'prod' });
    const first = await dana('GET', '/data-elements?prefix=shop-events.&limit=2');
    expect(first.items.map((e: { qualifiedName: string }) => e.qualifiedName)).toEqual(['shop-events.page0', 'shop-events.page1']);
    expect(first.total).toBe(5);
    const second = await dana('GET', `/data-elements?prefix=shop-events.&limit=2&cursor=${first.next}`);
    expect(second.items.map((e: { qualifiedName: string }) => e.qualifiedName)).toEqual(['shop-events.page2', 'shop-events.page3']);
    expect((await dana('GET', '/data-elements?q=PAGE4')).items).toHaveLength(1);
    const none = await dana('GET', `/data-elements?inNoProduct=true&platformId=${kafka}`);
    expect(none.total).toBe(5);
    expect(await fail(dana('GET', '/data-elements?cursor=garbage'))).toMatchObject({ status: 400 });
  });
});

describe('ports, consumers and the lifecycle', () => {
  let orders = '';
  let output = '';
  let topic = '';
  it('binds an output port per environment to elements of that environment and a data contract', async () => {
    const p = await dana('POST', '/data-products', { key: 'orders', name: 'Orders', type: 'sourceAligned' });
    orders = p.id;
    topic = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'orders.v1', environment: 'prod' })).id;
    const dev = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'orders.v1', environment: 'dev' })).id;
    const port = await dana('POST', `/data-products/${orders}/ports`, {
      direction: 'output',
      name: 'orders',
      type: 'topic',
      version: 'v2',
      objectives: { freshnessMinutes: 60 },
    });
    output = port.id;
    expect(await fail(dana('PUT', `/data-products/${orders}/ports/${output}/bindings/prod`, { elementIds: [dev] }))).toMatchObject({
      code: 'DATA_ELEMENT_ENVIRONMENT',
    });
    const contract = ((await s.api('GET', '/data-contracts')) as { id: string; key: string }[]).find((c) => c.key === 'shop-orders')!;
    expect(
      await fail(
        dana('PUT', `/data-products/${orders}/ports/${output}/bindings/prod`, { elementIds: [topic], contractId: contract.id, contractServer: 'nowhere' }),
      ),
    ).toMatchObject({ code: 'DATA_PORT_CONTRACT' });
    const bound = await dana('PUT', `/data-products/${orders}/ports/${output}/bindings/prod`, {
      elementIds: [topic],
      contractId: contract.id,
      objectives: { freshnessMinutes: 30 },
    });
    expect(bound.bindings[0]).toMatchObject({
      environment: 'prod',
      elementIds: [topic],
      contract: { key: 'shop-orders' },
      objectives: { freshnessMinutes: 30 },
    });
    // the bound element is an output member, and the product exists in prod
    const members = await dana('GET', `/data-products/${orders}/members`);
    expect(members.items.map((m: { role: string; element: { qualifiedName: string } }) => `${m.element.qualifiedName}:${m.role}`)).toEqual([
      'orders.v1:output',
    ]);
    expect((await dana('GET', `/data-products/${orders}`)).environments).toEqual(['prod']);
    expect(await fail(dana('POST', `/data-products/${orders}/ports`, { direction: 'output', name: 'orders', version: 'v2' }))).toMatchObject({
      code: 'DATA_PORT_EXISTS',
    });
  });

  it('consumes another product’s output port through an input port, and counts consumers', async () => {
    const mart = (await dana('GET', '/data-products?q=sales')).items[0];
    const input = await dana('POST', `/data-products/${mart.id}/ports`, { direction: 'input', name: 'orders', source: { kind: 'port', portId: output } });
    expect(input.source).toMatchObject({ kind: 'port', portId: output, product: { key: 'orders' }, version: 'v2' });
    await dana('POST', `/data-products/${orders}/ports/${output}/consumers`, {
      kind: 'team',
      subject: 'team:Finance',
      purpose: 'Monthly closing',
      contacts: ['user:adam'],
    });
    const app = ((await s.api('GET', '/applications')) as { id: string }[])[0]!;
    await dana('POST', `/data-products/${orders}/ports/${output}/consumers`, { kind: 'application', refId: app.id, purpose: 'Reports' });
    expect(await fail(dana('POST', `/data-products/${orders}/ports/${output}/consumers`, { kind: 'team', subject: 'user:vera' }))).toMatchObject({
      code: 'DATA_CONSUMER_INVALID',
    });
    const got = await dana('GET', `/data-products/${orders}`);
    expect(got.ports.find((p: { id: string }) => p.id === output).consumers).toEqual({ registered: 2, derived: 1 });
    const consumers = await vera('GET', `/data-products/${orders}/ports/${output}/consumers`);
    expect(consumers.map((c: { label: string }) => c.label)).toContain('team:finance');
  });

  it('needs an owner and an output port to become active, a sunset date to be deprecated, a confirmation to retire', async () => {
    expect(await fail(dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'active' }))).toMatchObject({
      status: 409,
      code: 'DATA_PRODUCT_LIFECYCLE',
      params: { context: 'needsOwner' },
    });
    const cur = await dana('GET', `/data-products/${orders}`);
    await dana('PUT', `/data-products/${orders}`, { key: 'orders', name: 'Orders', type: 'sourceAligned', owners: ['user:dana'] });
    expect((await dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'active' })).lifecycle).toBe('active');
    expect(cur.lifecycle).toBe('proposed');
    expect(await fail(dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'deprecated' }))).toMatchObject({
      params: { context: 'needsSunsetDate' },
    });
    const dep = await dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'deprecated', sunsetDate: '2027-03-31' });
    expect(dep).toMatchObject({
      lifecycle: 'deprecated',
      sunsetDate: '2027-03-31',
      lifecycleDates: { active: expect.any(String), deprecated: expect.any(String) },
    });
    const retire = await fail(dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'retired' }));
    expect(retire).toMatchObject({ code: 'DATA_PRODUCT_LIFECYCLE', params: { context: 'consumersRegistered', consumers: 3 } });
    // API tokens may not change the lifecycle (session-only)
    const token = (await s.api('POST', '/me/tokens', { name: 'dp', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/data-products/${orders}/lifecycle`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ lifecycle: 'retired', confirm: true }),
    });
    expect(res.status).toBe(403);
    expect((await dana('POST', `/data-products/${orders}/lifecycle`, { lifecycle: 'retired', confirm: true })).lifecycle).toBe('retired');
    // the consuming product sees that its input consumes a deprecated (retired) port only through the port's lifecycle
    const audit = await s.api('GET', '/audit?action=dataproduct.lifecycle_changed');
    expect(JSON.stringify(audit)).toContain('deprecated → retired');
  });
});

describe('steps and lineage', () => {
  it('documents a step where its result lives and walks the lineage across products', async () => {
    const p = await dana('POST', '/data-products', { key: 'shop-pipeline', name: 'Shop pipeline' });
    const mk = (name: string, layer: string) =>
      dana('POST', '/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: name, environment: 'prod', layer });
    const raw = await mk('SHOP.RAW.ORDERS', 'raw');
    const staged = await mk('SHOP.STAGED.ORDERS', 'staged');
    const curated = await mk('SHOP.CURATED.ORDERS_V', 'curated');
    await dana('POST', `/data-products/${p.id}/members`, { elementIds: [raw.id, staged.id, curated.id], role: 'internal' });
    expect(await fail(dana('POST', `/data-products/${p.id}/steps`, { name: 'x', inputs: [raw.id], outputs: [raw.id] }))).toMatchObject({
      code: 'DATA_STEP_INVALID',
    });
    const outside = await mk('OTHER.X.Y', 'raw');
    expect(await fail(dana('POST', `/data-products/${p.id}/steps`, { name: 'x', inputs: [raw.id], outputs: [outside.id] }))).toMatchObject({
      params: { context: 'noOutputInProduct' },
    });
    await dana('POST', `/data-products/${p.id}/steps`, {
      name: 'stage',
      kind: 'stage',
      inputs: [raw.id],
      outputs: [staged.id],
      runner: { kind: 'tool', tool: 'dbt', text: 'model stg_orders' },
    });
    const curate = await dana('POST', `/data-products/${p.id}/steps`, {
      name: 'curate',
      kind: 'curate',
      inputs: [staged.id],
      outputs: [curated.id],
      notes: [{ kind: 'filter', text: 'only paid orders' }],
    });
    expect(curate).toMatchObject({ canEdit: true, runner: null, inputs: [staged.id], outputs: [curated.id] });
    expect((await dana('GET', `/data-products/${p.id}/steps`)).map((x: { name: string }) => x.name).sort()).toEqual(['curate', 'stage']);
    const { stepsAround } = await import('../src/dataproducts/store.js');
    const around = stepsAround([curated.id], 4);
    expect(around.elements.find((e) => e.id === raw.id)?.distance).toBe(-2);
    expect(around.steps.map((x) => x.name).sort()).toEqual(['curate', 'stage']);
    // a viewer reads the pipeline, never changes it
    expect((await vera('GET', `/data-products/${p.id}/steps`))[0].canEdit).toBe(false);
    expect((await fail(vera('DELETE', `/data-products/${p.id}/steps/${curate.id}`))).status).toBe(403);
  });

  it('keeps a runner the editor may not see when they save the step without one', async () => {
    const p = await dana('POST', '/data-products', { key: 'hidden-runner', name: 'Hidden runner' });
    const mk = (name: string) => dana('POST', '/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: name, environment: 'prod' });
    const a = await mk('RUNNER.RAW.A');
    const b = await mk('RUNNER.STAGED.B');
    await dana('POST', `/data-products/${p.id}/members`, { elementIds: [a.id, b.id], role: 'internal' });
    // the runner: an element of a team dana is not in
    const job = await s.api('POST', '/data-elements', {
      platformId: snowflake,
      kind: 'snowflake.task',
      qualifiedName: 'RUNNER.OPS.LOAD_TASK',
      environment: 'prod',
    });
    const team = (await s.api('POST', '/teams', { name: 'Runner team', members: ['olivia'] })).id;
    await s.api('PUT', `/owning-teams/data_element/${job.id}`, { teamIds: [team] });
    const step = await dana('POST', `/data-products/${p.id}/steps`, { name: 'load', kind: 'stage', inputs: [a.id], outputs: [b.id] });
    const body = { name: 'load', kind: 'stage', inputs: [a.id], outputs: [b.id] };
    await s.api('PUT', `/data-products/${p.id}/steps/${step.id}`, { ...body, runner: { kind: 'element', id: job.id } });
    const seen = (await dana('GET', `/data-products/${p.id}/steps`))[0];
    expect(seen).toMatchObject({ runner: null, runnerHidden: true });
    // dana's form has no runner to send: the stored one stays
    const saved = await dana('PUT', `/data-products/${p.id}/steps/${step.id}`, { ...body, schedule: 'hourly', runner: null });
    expect(saved).toMatchObject({ runner: null, runnerHidden: true, schedule: 'hourly' });
    expect((await s.api('GET', `/data-products/${p.id}/steps`))[0].runner).toEqual({ kind: 'element', id: job.id });
    // a runner of her own replaces it
    await dana('PUT', `/data-products/${p.id}/steps/${step.id}`, { ...body, runner: { kind: 'tool', tool: 'dbt', text: '' } });
    expect((await s.api('GET', `/data-products/${p.id}/steps`))[0].runner).toMatchObject({ kind: 'tool', tool: 'dbt' });
  });
});

describe('team scope', () => {
  it('shows a team’s product, object and element to its members, auditors and administrators only – not listed, counted or named elsewhere', async () => {
    // a shared element of the catalogue, made before the team owns anything (afterwards dana's new items go to the team)
    const shared = await dana('POST', '/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: 'SHARED.S.T', environment: 'prod' });
    const team = (await s.api('POST', '/teams', { name: 'Data team', members: ['dana', 'olivia'] })).id;
    const p = await dana('POST', '/data-products', { key: 'secret-product', name: 'Secret product' });
    const o = await dana('POST', '/data-objects', { key: 'secret-object', name: 'Secret object', classification: 'strictly_confidential' });
    const e = await dana('POST', '/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: 'SECRET.S.T', environment: 'prod' });
    for (const [kind, id] of [
      ['data_product', p.id],
      ['data_object', o.id],
      ['data_element', e.id],
    ])
      await s.api('PUT', `/owning-teams/${kind}/${id}`, { teamIds: [team] });
    // the shared element is part of the team's product
    await dana('POST', `/data-products/${p.id}/members`, { elementIds: [shared.id, e.id], role: 'internal' });

    const listOf = async (c: Client, url: string) => ((await c('GET', url)) as { items: { id: string }[]; total: number }) ?? { items: [], total: 0 };
    for (const [who, c, sees] of [
      ['vera', vera, false],
      ['olivia', olivia, true],
      ['audrey', audrey, true],
      ['admin', s.api, true],
    ] as const) {
      const products = await listOf(c, '/data-products?limit=100');
      expect(
        products.items.some((x) => x.id === p.id),
        `${who} product`,
      ).toBe(sees);
      const objects = await listOf(c, '/data-objects?limit=100');
      expect(
        objects.items.some((x) => x.id === o.id),
        `${who} object`,
      ).toBe(sees);
      const elements = await listOf(c, '/data-elements?prefix=SECRET.');
      expect(elements.total, `${who} element count`).toBe(sees ? 1 : 0);
      if (!sees) {
        expect((await fail(c('GET', `/data-products/${p.id}`))).code).toBe('DATA_PRODUCT_NOT_FOUND');
        // the list's facts leave it out, as the health of a page does
        expect(await c('GET', `/data-products/facts?ids=${p.id}`)).toEqual([]);
        expect((await fail(c('GET', `/data-objects/${o.id}`))).code).toBe('DATA_OBJECT_NOT_FOUND');
        expect((await fail(c('GET', `/data-elements/${e.id}`))).code).toBe('DATA_ELEMENT_NOT_FOUND');
        // the shared element counts the hidden product, never names it
        const sh = await c('GET', `/data-elements/${shared.id}`);
        expect(sh.products).toEqual({ visible: 0, hidden: 1 });
        expect(JSON.stringify(sh)).not.toContain('Secret product');
        // a link picker and a link resolver do not offer or name it
        expect(JSON.stringify(await c('GET', '/link-targets?kind=data-product&q=secret'))).not.toContain(p.id);
      }
    }
    // a team member sees the element they may not see otherwise as the product's content (decision 15) – here all of them
    const members = await olivia('GET', `/data-products/${p.id}/members`);
    expect(members.items.map((m: { element: { visible: boolean } }) => m.element.visible)).toEqual([true, true]);
    // olivia (operator) sees, but does not change it; dana (designer member) does
    expect((await fail(olivia('PUT', `/data-products/${p.id}/rating`, { classification: 'internal' }))).status).toBe(403);
    expect((await dana('PUT', `/data-products/${p.id}/rating`, { classification: 'internal' })).classification).toBe('internal');
  });

  it('asks for the access.grant step-up when owners name someone outside the owning teams', async () => {
    const team = ((await s.api('GET', '/teams')) as { id: string; name: string }[]).find((t) => t.name === 'Data team')!.id;
    const p = await dana('POST', '/data-products', { key: 'team-owned', name: 'Team owned' });
    await s.api('PUT', `/owning-teams/data_product/${p.id}`, { teamIds: [team] });
    const strict = await s.as('dana', PW, { autoStepUp: false });
    // a sign-in counts as a confirmation: ended here
    await strict('DELETE', '/auth/step-up');
    const refused = await fail(strict('PUT', `/data-products/${p.id}`, { key: 'team-owned', name: 'Team owned', owners: ['user:vera'] }));
    expect(refused).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    // a member of the team needs no confirmation
    await strict('PUT', `/data-products/${p.id}`, { key: 'team-owned', name: 'Team owned', owners: ['user:olivia'] });
    // confirmed: granted and audited as an access change
    await dana('PUT', `/data-products/${p.id}`, { key: 'team-owned', name: 'Team owned', owners: ['user:olivia', 'user:vera'] });
    expect((await vera('GET', `/data-products/${p.id}`)).permissions).toEqual(['view', 'edit', 'manage']);
    const entries = await s.api('GET', '/audit?action=access.named_subjects_granted');
    expect(JSON.stringify(entries)).toContain('user:vera');
  });
});

describe('the store (discovery writes)', () => {
  it('adds, renames by external id, keeps people’s fields, marks missing and removes long-missing elements in no product', async () => {
    const store = await import('../src/dataproducts/store.js');
    const { db } = await import('../src/db.js');
    db().run(
      `INSERT INTO dp_discovery_sources (id, name, platform_id, run_as, created_at, created_by, updated_at, updated_by) VALUES ('dpq_test', 'Test', ?, 'admin', 'x', 'admin', 'x', 'admin')`,
      snowflake,
    );
    const r1 = store.upsertDiscovered('dpq_test', [
      { kind: 'snowflake.database', qualifiedName: 'DISC', environment: 'prod' },
      { kind: 'snowflake.schema', qualifiedName: 'DISC.RAW', parentQualifiedName: 'DISC', environment: 'prod' },
      {
        kind: 'snowflake.table',
        qualifiedName: 'DISC.RAW.A',
        parentQualifiedName: 'DISC.RAW',
        environment: 'prod',
        externalId: '101',
        readout: { rowCount: 5 },
      },
      { kind: 'snowflake.table', qualifiedName: 'DISC.RAW.B', parentQualifiedName: 'DISC.RAW', environment: 'prod', externalId: '102' },
    ]);
    expect(r1).toMatchObject({ added: 4, changed: 0, renamed: 0, readouts: 1 });
    const a = (await dana('GET', '/data-elements?prefix=disc.raw.a')).items[0];
    expect(a).toMatchObject({ source: 'discovered', parentId: expect.any(String) });
    await dana('PUT', `/data-elements/${a.id}`, { description: 'People wrote this', layer: 'raw' });
    // unchanged: only the readout; renamed by its id: the same element, people's fields kept
    const r2 = store.upsertDiscovered('dpq_test', [
      { kind: 'snowflake.table', qualifiedName: 'DISC.RAW.A2', parentQualifiedName: 'DISC.RAW', environment: 'prod', externalId: '101' },
      { kind: 'snowflake.table', qualifiedName: 'DISC.RAW.B', parentQualifiedName: 'DISC.RAW', environment: 'prod', externalId: '102' },
    ]);
    expect(r2).toMatchObject({ added: 0, renamed: 1, unchanged: 1 });
    const renamed = await dana('GET', `/data-elements/${a.id}`);
    expect(renamed).toMatchObject({ qualifiedName: 'DISC.RAW.A2', description: 'People wrote this', layer: 'raw', readout: { rowCount: 5 } });
    // a discovered element keeps the name its platform gives it
    expect(await fail(dana('PUT', `/data-elements/${a.id}`, { qualifiedName: 'X' }))).toMatchObject({ code: 'DATA_ELEMENT_DISCOVERED' });
    const missing = store.markMissing('dpq_test', r2.seen, '2026-01-01T00:00:00.000Z');
    expect(missing).toHaveLength(2); // the database and the schema
    expect((await dana('GET', '/data-elements?missing=true&prefix=disc')).total).toBe(2);
    expect(store.removeLongMissing('2026-02-01T00:00:00.000Z', 'dpq_test')).toBe(2);
    expect((await dana('GET', '/data-elements?prefix=disc')).total).toBe(2);
  });
});

describe('statements per request', () => {
  /** Statements of one GET as dana (the second call: caches of the first are warm). */
  async function statements(url: string): Promise<number> {
    await dana('GET', url);
    counted.delete(`/api${url}`);
    await dana('GET', url);
    return counted.get(`/api${url}`) ?? -1;
  }

  it('stay the same for the product list and a product read with more products, members, ports and objects', async () => {
    const p = await dana('POST', '/data-products', { key: 'counted', name: 'Counted' });
    const grow = async (n: number, tag: string) => {
      for (let i = 0; i < n; i++) {
        await dana('POST', '/data-products', { key: `grown-${tag}-${i}`, name: `Grown ${tag} ${i}` });
        const e = await dana('POST', '/data-elements', {
          platformId: snowflake,
          kind: 'snowflake.table',
          qualifiedName: `GROW.${tag}.T${i}`,
          environment: 'prod',
        });
        const o = await dana('POST', '/data-objects', { key: `obj-${tag}-${i}`, name: `Object ${tag} ${i}` });
        await dana('POST', `/data-objects/${o.id}/elements`, { elementId: e.id });
        const port = await dana('POST', `/data-products/${p.id}/ports`, { direction: 'output', name: `port-${tag}-${i}`, objectIds: [o.id] });
        await dana('PUT', `/data-products/${p.id}/ports/${port.id}/bindings/prod`, { elementIds: [e.id] });
        await dana('POST', `/data-products/${p.id}/ports/${port.id}/consumers`, { kind: 'text', text: `Consumer ${i}` });
      }
    };
    // the list's facts (maturity, last month's costs) of the page: one request, in bulk
    const facts = async () => {
      const ids = ((await dana('GET', '/data-products?limit=100')) as { items: { id: string }[] }).items.map((x) => x.id).join(',');
      return statements(`/data-products/facts?ids=${ids}`);
    };
    await grow(2, 'a');
    const before = {
      list: await statements('/data-products'),
      read: await statements(`/data-products/${p.id}`),
      elements: await statements('/data-elements'),
      facts: await facts(),
    };
    await grow(5, 'b');
    const after = {
      list: await statements('/data-products'),
      read: await statements(`/data-products/${p.id}`),
      elements: await statements('/data-elements'),
      facts: await facts(),
    };
    expect(after).toEqual(before);
    const page = ((await dana('GET', '/data-products?limit=100')) as { items: { id: string }[] }).items;
    const listed = await dana('GET', `/data-products/facts?ids=${page.map((x) => x.id).join(',')}`);
    expect(listed.length).toBe(page.length);
    expect(listed.find((x: { productId: string }) => x.productId === p.id)).toMatchObject({ productId: p.id, maturity: expect.any(Number), lastMonth: null });
    // a fixed number: at most 25 for the product page itself (ADR 0036), beyond what every request costs (the
    // sign-in, a product that is not found: one statement)
    await dana('GET', '/data-products/dpr_none').catch(() => undefined);
    counted.delete('/api/data-products/dpr_none');
    await dana('GET', '/data-products/dpr_none').catch(() => undefined);
    const overhead = (counted.get('/api/data-products/dpr_none') ?? 99) - 1;
    console.log('statements', { ...after, overhead });
    expect(after.read - overhead).toBeLessThanOrEqual(25);
    expect(after.list - overhead).toBeLessThanOrEqual(25);
  });
});

describe('shares (ADR 0033)', () => {
  it('a team’s product shared with a viewer; a Restricted product reaches only its shares, owners, auditors and administrators', async () => {
    const team = ((await s.api('GET', '/teams')) as { id: string; name: string }[]).find((t) => t.name === 'Data team')!.id;
    const p = await s.api('POST', '/data-products', { key: 'shared-product', name: 'Shared product' });
    await s.api('PUT', `/owning-teams/data_product/${p.id}`, { teamIds: [team] });
    expect((await fail(vera('GET', `/data-products/${p.id}`))).code).toBe('DATA_PRODUCT_NOT_FOUND');
    await s.api('PUT', `/access/data_product/${p.id}/shares`, { shares: [{ subject: 'user:vera', level: 'view' }] });
    expect((await vera('GET', `/data-products/${p.id}`)).permissions).toEqual(['view']);
    expect(((await vera('GET', '/data-products?limit=100')) as { items: { id: string }[] }).items.some((x) => x.id === p.id)).toBe(true);
    // Edit lets her change it, never its shares (Manage)
    await s.api('PUT', `/access/data_product/${p.id}/shares`, { shares: [{ subject: 'user:vera', level: 'edit' }] });
    expect((await vera('GET', `/data-products/${p.id}`)).permissions).toEqual(['view', 'edit']);
    expect((await fail(vera('PUT', `/access/data_product/${p.id}/shares`, { shares: [] }))).status).toBe(403);
    // Restricted, without owning teams: the instance roles give nothing, the share and the auditor stay
    const r = await s.api('POST', '/data-products', { key: 'restricted-product', name: 'Restricted product' });
    await s.api('PUT', `/access/data_product/${r.id}/scope`, { restricted: true });
    expect((await fail(olivia('GET', `/data-products/${r.id}`))).code).toBe('DATA_PRODUCT_NOT_FOUND');
    expect((await audrey('GET', `/data-products/${r.id}`)).permissions).toEqual(['view']);
    await s.api('PUT', `/access/data_product/${r.id}/shares`, { shares: [{ subject: 'user:olivia', level: 'view' }] });
    expect((await olivia('GET', `/data-products/${r.id}`)).name).toBe('Restricted product');
    const view = await s.api('GET', `/access/data_product/${r.id}/shares`);
    expect(view).toMatchObject({ restricted: true });
    expect(JSON.stringify(await s.api('GET', `/audit?entityId=${r.id}`))).toContain('access.share_added');
  });

  it('go with a deleted product: no share or Restricted mark is left for the share job to remind of', async () => {
    const { db } = await import('../src/db.js');
    const p = await s.api('POST', '/data-products', { key: 'shared-then-deleted', name: 'Shared then deleted' });
    await s.api('PUT', `/access/data_product/${p.id}/scope`, { restricted: true });
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await s.api('PUT', `/access/data_product/${p.id}/shares`, { shares: [{ subject: 'user:olivia', level: 'view', expiresAt: soon }] });
    const left = (table: string) =>
      Number(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE kind = 'data_product' AND resource_id = ?`, p.id)!.n);
    expect(left('resource_shares')).toBe(1);
    expect(left('resource_restrictions')).toBe(1);
    await s.api('DELETE', `/data-products/${p.id}`);
    expect(left('resource_shares')).toBe(0);
    expect(left('resource_restrictions')).toBe(0);
  });
});

describe('module access (ADR 0034)', () => {
  it('restricted to a team: who is not on the list neither reaches the routes nor the items through other surfaces', async () => {
    // made by the administrator: no owning teams, so every working role sees it while the module is open
    const p = await s.api('POST', '/data-products', { key: 'restricted-module', name: 'Restricted module product' });
    const team = (await s.api('POST', '/teams', { name: 'Module users', members: ['dana'] })).id as string;
    expect(team).toBeTruthy();
    await s.api('PUT', '/settings/modules/dataProducts/access', { mode: 'selected', grants: [{ subject: 'team:module users' }] });
    try {
      // the module's routes: 404 MODULE_NO_ACCESS for vera, as before for dana and the auditor
      expect(await fail(vera('GET', '/data-products'))).toMatchObject({ status: 404, code: 'MODULE_NO_ACCESS' });
      // a new sign-in: the session knows dana's teams of its start
      const danaNow = await s.as('dana', PW);
      expect((await danaNow('GET', `/data-products/${p.id}`)).name).toBe('Restricted module product');
      expect((await audrey('GET', `/data-products/${p.id}`)).name).toBe('Restricted module product');
      // the owning-team routes and the link pickers are not the module's: they answer like a missing item
      expect((await fail(vera('GET', `/owning-teams/data_product/${p.id}`))).status).toBe(404);
      expect(JSON.stringify(await vera('GET', '/link-targets?kind=data-product&q=restricted'))).not.toContain(p.id);
      // the rights themselves: none for vera, the module role from the core roles for dana
      const { moduleRoleOf, productAccess } = await import('../src/dataproducts/access.js');
      const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
      const user = (name: string) => toAuthUser(findUserByName(name)!);
      expect(moduleRoleOf(user('vera'))).toBeNull();
      expect(moduleRoleOf(user('dana'))).toBe('manager');
      expect(productAccess(user('vera'), { id: p.id, owners: ['user:vera'] }).permissions).toEqual([]);
    } finally {
      await s.api('PUT', '/settings/modules/dataProducts/access', { mode: 'everyone', grants: [] });
    }
    expect((await vera('GET', `/data-products/${p.id}`)).name).toBe('Restricted module product');
  });
});
