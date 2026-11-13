import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Checks and health of the data products module (ADR 0036 part 10, WP3): the monitor check type `data-element`
 * (freshness by metadata from Snowflake and Kafka, schema against the bound contract with the contract comparison),
 * against the mocks; the owner's rights; checks linked, found and hidden; health of elements and products from stored
 * states with a fixed number of statements; Create monitor / Update monitor with soft links along the steps and the
 * root cause upstream; contract drafts from an element.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let olivia: Client;
let sf = '';
let kafka = '';
const counted = new Map<string, number>();
const el: Record<string, string> = {};

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};

const preview = (c: Client, check: Record<string, unknown>) =>
  c('POST', '/monitors/check-preview', { check: { id: 'x', name: 'Element', type: 'data-element', ...check } }) as Promise<{ status: string; message: string }>;

async function element(kind: string, qualifiedName: string, platformId = sf, extra: Record<string, unknown> = {}): Promise<string> {
  return (await dana('POST', '/data-elements', { platformId, kind, qualifiedName, environment: 'prod', ...extra })).id;
}

const evaluate = async (monitorId: string) => (await import('../src/monitors/engine.js')).evaluateMonitorNow(monitorId);

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
  await s.api('POST', '/demo/setup', { applications: false });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  olivia = await s.as('olivia', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  sf = platforms.find((p) => p.kind === 'snowflake')!.id;
  // the demo's example monitors watch SHOP.SALES.ORDERS and the topic orders: without them, what the draft proposes is this test's
  for (const m of (await s.api('GET', '/monitors')) as { id: string }[]) {
    const d = await s.api('GET', `/monitors/${m.id}`);
    if (d.definition.checks.some((c: { type: string }) => c.type === 'snowflake' || c.type === 'kafka')) await s.api('DELETE', `/monitors/${m.id}`);
  }
  kafka = platforms.find((p) => p.kind === 'kafka')!.id;
  el.orders = await element('snowflake.table', 'SHOP.SALES.ORDERS');
  el.customers = await element('snowflake.table', 'SHOP.SALES.CUSTOMERS');
  el.raw = await element('snowflake.table', 'SHOP.STAGING.RAW_EVENTS');
  el.revenue = await element('snowflake.view', 'SHOP.REPORTING.DAILY_REVENUE');
  el.dyn = await element('snowflake.dynamicTable', 'SHOP.SALES.ORDERS_DT');
  el.task = await element('snowflake.task', 'SHOP.STAGING.LOAD_EVENTS');
  el.sales = await element('snowflake.schema', 'SHOP.SALES');
  el.stream = await element('snowflake.stream', 'SHOP.STAGING.EVENTS_STREAM');
  el.contacts = await element('snowflake.table', 'CRM.CORE.CONTACTS');
  el.topic = await element('kafka.topic', 'orders', kafka);
  el.payments = await element('kafka.topic', 'payments', kafka);
  el.events = await element('kafka.topic', 'shop-events', kafka);
  el.cdcOrders = await element('kafka.topic', 'shop.public.orders', kafka);
  el.cdcCustomers = await element('kafka.topic', 'shop.public.customers', kafka);
  el.bundle = await element('kafka.topicBundle', 'shop*', kafka);
}, 180_000);

describe('the data-element check', () => {
  it('reads freshness from Snowflake metadata: tables, dynamic tables, tasks and a schema (any or every table)', async () => {
    expect(await preview(dana, { element: el.orders, maxAgeMinutes: 60 })).toMatchObject({
      status: 'up',
      message: expect.stringMatching(/SHOP\.SALES\.ORDERS changed 1[12] minutes ago/),
    });
    expect(await preview(dana, { element: el.raw, maxAgeMinutes: 60 })).toMatchObject({
      status: 'down',
      message: expect.stringContaining('last changed 3 days ago (at most 60 minutes)'),
    });
    expect(await preview(dana, { element: el.raw, maxAgeMinutes: 60, failAs: 'degraded' })).toMatchObject({ status: 'degraded' });
    expect(await preview(dana, { element: el.dyn, maxAgeMinutes: 60 })).toMatchObject({ status: 'up', message: expect.stringContaining('dynamic table') });
    // a task: the last successful run is 26 hours old and the last run failed
    expect(await preview(dana, { element: el.task, maxAgeMinutes: 1440 })).toMatchObject({
      status: 'down',
      message: expect.stringContaining('the last run failed'),
    });
    expect(await preview(dana, { element: el.task, maxAgeMinutes: 2000 })).toMatchObject({ status: 'degraded' });
    expect(await preview(dana, { element: el.task, maxAgeMinutes: 2000, warningAs: 'up' })).toMatchObject({ status: 'up' });
    // a schema: the newest table counts (any), or the oldest (every)
    expect(await preview(dana, { element: el.sales, maxAgeMinutes: 60 })).toMatchObject({
      status: 'up',
      message: expect.stringContaining('newest of 2 tables'),
    });
    expect(await preview(dana, { element: el.sales, maxAgeMinutes: 60, each: 'every' })).toMatchObject({
      status: 'down',
      message: expect.stringContaining('1 of 2 tables not changed within 60 minutes – the oldest, SALES.CUSTOMERS'),
    });
    const mock = await import('../src/mock/mockDataElements.js');
    mock.setDynamicRefresh('SHOP.SALES.ORDERS_DT', 0.5, 'FAILED');
    expect(await preview(dana, { element: el.dyn, maxAgeMinutes: 60 })).toMatchObject({
      status: 'degraded',
      message: expect.stringContaining('the last refresh failed'),
    });
    mock.setDynamicRefresh('SHOP.SALES.ORDERS_DT', 0.25);
    // a stream has no freshness of its own: refused when saved or tried
    expect(await fail(preview(dana, { element: el.stream }))).toMatchObject({ status: 400, code: 'DATA_ELEMENT_CHECK_MODE' });
  });

  it('reads Kafka: the newest message, a consumer group’s lag, and a bundle’s topics (any or every)', async () => {
    expect(await preview(dana, { element: el.topic, maxAgeMinutes: 15 })).toMatchObject({
      status: 'up',
      message: expect.stringContaining('the newest message is 1 minutes old'),
    });
    expect(await preview(dana, { element: el.payments, maxAgeMinutes: 60 })).toMatchObject({ status: 'down', message: expect.stringContaining('3 hours old') });
    expect(await preview(dana, { element: el.topic, maxAgeMinutes: 15, group: 'billing', maxLag: 100 })).toMatchObject({
      status: 'degraded',
      message: expect.stringContaining('group billing lag'),
    });
    expect(await preview(dana, { element: el.bundle, maxAgeMinutes: 30 })).toMatchObject({
      status: 'up',
      message: expect.stringContaining('of 3 topics of shop*'),
    });
    expect(await preview(dana, { element: el.bundle, maxAgeMinutes: 30, each: 'every' })).toMatchObject({
      status: 'down',
      message: expect.stringContaining('1 of 3 topics of shop* without a new message for more than 30 minutes: shop.public.customers'),
    });
  });

  it('sends metadata statements only (the mock records them)', async () => {
    const { dataElementStatements } = await import('../src/mock/mockDataElements.js');
    expect(dataElementStatements.length).toBeGreaterThan(5);
    for (const { sql, bindings } of dataElementStatements) {
      expect(sql).toMatch(/^\/\* steward:dp-[a-z-]+ \*\//);
      // every statement reads a database's INFORMATION_SCHEMA (in the text, or the view an IDENTIFIER(?) binds) – never a
      // user table, never a sample
      const views = sql.includes('IDENTIFIER(?)') ? bindings.filter((b) => b.includes('.INFORMATION_SCHEMA.')) : [];
      expect(sql.includes('.INFORMATION_SCHEMA.') || views.length === 1).toBe(true);
      for (const v of views) expect(v).toMatch(/^[A-Z_]+\.INFORMATION_SCHEMA\.(TABLES|COLUMNS)$/);
      expect(sql).not.toMatch(/SELECT \*|\bSAMPLE\b|\bFROM SHOP\./i);
    }
  });

  it('compares the columns with the contract of the output port: missing fields and types fail, nullability and extra columns warn', async () => {
    const yaml = (props: string) => `apiVersion: v3.0.2
kind: DataContract
id: wp3-orders
name: WP3 orders
version: 1.0.0
status: active
schema:
  - name: orders
    physicalName: SHOP.SALES.ORDERS
    properties:
${props}`;
    const base = [
      '      - { name: order_id, logicalType: integer, required: true }',
      '      - { name: customer_id, logicalType: integer, required: true }',
      '      - { name: total, logicalType: number }',
      '      - { name: status, logicalType: string, required: true }',
      '      - { name: created_at, logicalType: date, required: true }',
    ];
    const contract = await dana('POST', '/data-contracts', { yaml: yaml([...base, '      - { name: channel, logicalType: string }'].join('\n')) });
    const product = await dana('POST', '/data-products', { key: 'wp3-schema', name: 'WP3 schema' });
    const port = await dana('POST', `/data-products/${product.id}/ports`, { direction: 'output', name: 'orders', type: 'table' });
    // not bound yet: nothing to compare with
    expect(await preview(dana, { element: el.orders, mode: 'schema' })).toMatchObject({
      status: 'unknown',
      message: expect.stringContaining('bound to no output port'),
    });
    await dana('PUT', `/data-products/${product.id}/ports/${port.id}/bindings/prod`, { elementIds: [el.orders], contractId: contract.id });
    const r1 = await preview(dana, { element: el.orders, mode: 'schema' });
    expect(r1).toMatchObject({ status: 'down', message: expect.stringContaining('channel missing') });
    expect(r1.message).toContain('status is nullable (contract: required)');
    // without the missing column only the warning is left
    await dana('POST', `/data-contracts/${contract.id}/versions`, { yaml: yaml(base.join('\n')).replace('version: 1.0.0', 'version: 1.1.0') });
    expect(await preview(dana, { element: el.orders, mode: 'schema' })).toMatchObject({ status: 'degraded' });
    expect(await preview(dana, { element: el.orders, mode: 'schema', warningAs: 'up' })).toMatchObject({ status: 'up' });
    // a column of another type family fails; the binding may pin the first version
    const mock = await import('../src/mock/mockDataElements.js');
    mock.setColumns('SHOP.SALES.ORDERS', [
      { name: 'ORDER_ID', type: 'TEXT', nullable: false },
      { name: 'CUSTOMER_ID', type: 'NUMBER', nullable: false, precision: 38, scale: 0 },
      { name: 'TOTAL', type: 'NUMBER', nullable: true, precision: 12, scale: 2 },
      { name: 'STATUS', type: 'TEXT', nullable: false },
      { name: 'CREATED_AT', type: 'TIMESTAMP_NTZ', nullable: false },
      { name: 'NOTE', type: 'TEXT', nullable: true },
    ]);
    const r2 = await preview(dana, { element: el.orders, mode: 'schema' });
    expect(r2).toMatchObject({ status: 'down', message: expect.stringContaining('order_id is string (contract: integer)') });
    expect(r2.message).toContain('note not in the contract');
    mock.resetDataElementMock();
    // Kafka: the subject's Avro fields against a contract of the topic (version 1 has no total)
    const topicContract = await dana('POST', '/data-contracts', {
      yaml: `apiVersion: v3.0.2
kind: DataContract
id: wp3-order-events
name: WP3 order events
version: 1.0.0
status: active
schema:
  - name: orders
    properties:
      - { name: orderId, logicalType: string, required: true }
      - { name: total, logicalType: number, required: true }
`,
    });
    const events = await dana('POST', `/data-products/${product.id}/ports`, { direction: 'output', name: 'order-events', type: 'topic' });
    await dana('PUT', `/data-products/${product.id}/ports/${events.id}/bindings/prod`, { elementIds: [el.topic], contractId: topicContract.id });
    expect(await preview(dana, { element: el.topic, mode: 'schema' })).toMatchObject({ status: 'up', message: expect.stringContaining('matches') });
    expect(await preview(dana, { element: el.topic, mode: 'schema', schemaVersion: 1 })).toMatchObject({
      status: 'down',
      message: expect.stringContaining('total missing'),
    });
  });

  it('runs with the owner’s rights: an element the editor or the owner may not see answers like a missing one', async () => {
    const team = (await s.api('POST', '/teams', { name: 'Platform team', members: ['olivia'] })).id;
    const hidden = (await s.api('POST', '/data-elements', { platformId: sf, kind: 'snowflake.table', qualifiedName: 'CRM.CORE.HIDDEN', environment: 'prod' }))
      .id;
    await s.api('PUT', `/owning-teams/data_element/${hidden}`, { teamIds: [team] });
    expect(await fail(preview(dana, { element: hidden }))).toMatchObject({ status: 400, code: 'DATA_ELEMENT_NOT_FOUND' });
    expect(
      await fail(
        dana('POST', '/monitors', { definition: { name: 'Hidden element', checks: [{ id: 'h', name: 'H', type: 'data-element', element: hidden }] } }),
      ),
    ).toMatchObject({ status: 400, code: 'DATA_ELEMENT_NOT_FOUND' });
    // the owner loses sight of an element after saving: the check cannot run and says why
    const { monitor } = await dana('POST', '/monitors', {
      definition: {
        name: 'Contacts fresh',
        failuresBeforeDown: 1,
        checks: [{ id: 'contacts', name: 'Contacts', type: 'data-element', element: el.contacts, maxAgeMinutes: 120 }],
      },
    });
    await evaluate(monitor.id);
    expect((await dana('GET', `/monitors/${monitor.id}`)).checks.find((c: { checkId: string }) => c.checkId === 'contacts')).toMatchObject({ status: 'up' });
    await s.api('PUT', `/owning-teams/data_element/${el.contacts}`, { teamIds: [team] });
    await evaluate(monitor.id);
    const after = (await s.api('GET', `/monitors/${monitor.id}`)).checks.find((c: { checkId: string }) => c.checkId === 'contacts');
    expect(after.status).toBe('unknown');
    expect(after.last.message).toContain('does not exist or the monitor owner may not see it');
    await s.api('PUT', `/owning-teams/data_element/${el.contacts}`, { teamIds: [] });
    await s.api('DELETE', `/monitors/${monitor.id}`);
  });
});

describe('Create monitor and Update monitor', () => {
  let product = '';
  let monitor = '';
  let watcher = '';
  it('proposes a check per element along the pipeline, schema and contract checks, and soft links following the steps', async () => {
    // a check elsewhere watches the raw table already: found by its fields, not repeated
    watcher = (
      await dana('POST', '/monitors', {
        definition: { name: 'Raw events watched', checks: [{ id: 'raw', name: 'Raw events', type: 'data-element', element: el.raw, maxAgeMinutes: 4320 }] },
      })
    ).monitor.id;
    const p = await dana('POST', '/data-products', { key: 'wp3-orders', name: 'WP3 orders pipeline' });
    product = p.id;
    await dana('POST', `/data-products/${product}/members`, { elementIds: [el.topic], role: 'input' });
    await dana('POST', `/data-products/${product}/members`, { elementIds: [el.raw, el.dyn, el.stream], role: 'internal' });
    await dana('POST', `/data-products/${product}/members`, { elementIds: [el.revenue], role: 'output' });
    const contract = ((await dana('GET', '/data-contracts')) as { id: string; key: string }[]).find((c) => c.key === 'wp3-orders')!;
    const port = await dana('POST', `/data-products/${product}/ports`, {
      direction: 'output',
      name: 'orders',
      type: 'table',
      objectives: { freshnessMinutes: 30 },
    });
    await dana('PUT', `/data-products/${product}/ports/${port.id}/bindings/prod`, { elementIds: [el.orders], contractId: contract.id });
    // topic → raw → dynamic table → orders and the revenue view
    await dana('POST', `/data-products/${product}/steps`, { name: 'Ingest', kind: 'ingest', inputs: [el.topic], outputs: [el.raw] });
    await dana('POST', `/data-products/${product}/steps`, { name: 'Stage', kind: 'stage', inputs: [el.raw], outputs: [el.dyn] });
    await dana('POST', `/data-products/${product}/steps`, { name: 'Curate', kind: 'curate', inputs: [el.dyn], outputs: [el.orders, el.revenue] });
    // an element dana may not see, added by an administrator: left out and counted, never named
    const team = ((await s.api('GET', '/teams')) as { id: string; name: string }[]).find((t) => t.name === 'Platform team')!.id;
    const hidden = (await s.api('POST', '/data-elements', { platformId: sf, kind: 'snowflake.table', qualifiedName: 'SHOP.SALES.SECRET', environment: 'prod' }))
      .id;
    await s.api('PUT', `/owning-teams/data_element/${hidden}`, { teamIds: [team] });
    await s.api('POST', `/data-products/${product}/members`, { elementIds: [hidden], role: 'internal' });

    const prop = await dana('GET', `/data-products/${product}/monitor`);
    expect(prop).toMatchObject({ environment: 'prod', monitor: null, canApply: true });
    const byElement = (id: string, mode = 'freshness') => prop.checks.find((c: { elementId: string; mode: string }) => c.elementId === id && c.mode === mode);
    expect(byElement(el.orders)).toMatchObject({ critical: true, maxAgeMinutes: 30, role: 'output' });
    expect(byElement(el.revenue)).toMatchObject({ critical: true, maxAgeMinutes: 1440, role: 'output' });
    expect(byElement(el.dyn)).toMatchObject({ critical: false, maxAgeMinutes: 30, role: 'internal' });
    expect(byElement(el.topic)).toMatchObject({ critical: false, role: 'input' });
    expect(byElement(el.raw)).toBeUndefined();
    expect(byElement(el.orders, 'schema')).toMatchObject({ critical: true, contractId: contract.id });
    expect(prop.checks.filter((c: { type: string }) => c.type === 'data-contract')).toEqual([
      expect.objectContaining({ mode: 'findings', contractId: contract.id }),
    ]);
    const id = (e: string) => byElement(e).id;
    // the watched raw table is bridged: the topic's check explains the dynamic table's
    expect(prop.links).toEqual(
      expect.arrayContaining([
        { from: id(el.topic), to: id(el.dyn) },
        { from: id(el.dyn), to: id(el.orders) },
        { from: id(el.dyn), to: id(el.revenue) },
      ]),
    );
    expect(prop.links).toHaveLength(3);
    const skipped = Object.fromEntries(prop.skipped.map((x: { reason: string }) => [x.reason, x]));
    expect(skipped.watched).toMatchObject({ count: 1, elements: [{ id: el.raw }] });
    expect(skipped.unsupported).toMatchObject({ count: 1, elements: [{ id: el.stream }] });
    expect(skipped.hidden).toMatchObject({ count: 1, elements: [] });
    expect(JSON.stringify(prop)).not.toContain('SECRET');
  });

  it('creates a disabled draft linked to its elements; the root cause points upstream once it runs', async () => {
    expect((await fail(vera('POST', `/data-products/${product}/monitor`, {}))).status).toBe(403);
    expect((await fail(olivia('POST', `/data-products/${product}/monitor`, {}))).status).toBe(403);
    const r = await dana('POST', `/data-products/${product}/monitor`, {});
    monitor = r.monitor.id;
    expect(r).toMatchObject({ created: true, added: 6, monitor: { enabled: false } });
    const m = await dana('GET', `/monitors/${monitor}`);
    expect(m.definition.aggregate).toEqual({ rule: 'critical' });
    expect(m.definition.links.every((l: { mode: string }) => l.mode === 'soft')).toBe(true);
    expect((await dana('GET', `/data-products/${product}`)).environmentDetails).toEqual([expect.objectContaining({ environment: 'prod', monitorId: monitor })]);
    // made links, and the found check of the raw table is linked now
    const raw = await dana('GET', `/data-elements/${el.raw}/checks`);
    expect(raw.checks).toEqual([expect.objectContaining({ origin: 'found', linkId: expect.any(String), monitor: expect.objectContaining({ id: watcher }) })]);
    const orders = await dana('GET', `/data-elements/${el.orders}/checks`);
    expect(
      orders.checks
        .filter((c: { origin: string }) => c.origin === 'made')
        .map((c: { purpose: string }) => c.purpose)
        .sort(),
    ).toEqual(['freshness', 'schema']);
    // a disabled draft does not speak for the product: its elements do – here only the raw table's check elsewhere runs (not evaluated yet)
    const h0 = await dana('GET', `/data-products/${product}/health`);
    expect(h0).toEqual([expect.objectContaining({ environment: 'prod', status: 'unknown', source: 'elements', monitorId: null })]);
    // enabled by a person: the stale dynamic table explains the stale view below it
    const mock = await import('../src/mock/mockDataElements.js');
    mock.setDynamicRefresh('SHOP.SALES.ORDERS_DT', 30);
    await dana('POST', `/monitors/${monitor}/enabled`, { enabled: true });
    await evaluate(monitor);
    await evaluate(monitor);
    const run = await dana('GET', `/monitors/${monitor}`);
    const dynCheck = (await dana('GET', `/data-elements/${el.dyn}/checks`)).checks[0].check.id;
    expect(run.rootCauses.map((c: { checkId: string }) => c.checkId)).toContain(dynCheck);
    expect(run.checks.find((c: { checkId: string }) => c.checkId.startsWith('fresh-shop-reporting'))).toMatchObject({
      status: 'down',
      causedBy: [expect.objectContaining({ checkId: dynCheck })],
    });
    const h1 = await dana('GET', `/data-products/${product}/health`);
    expect(h1[0]).toMatchObject({ source: 'monitor', monitorId: monitor, status: run.status });
    mock.resetDataElementMock();
  });

  it('proposes the checks for elements added since, and adds them when applied', async () => {
    await dana('POST', `/data-products/${product}/members`, { elementIds: [el.customers], role: 'output' });
    await dana('POST', `/data-products/${product}/steps`, { name: 'Customers', kind: 'curate', inputs: [el.orders], outputs: [el.customers] });
    const prop = await dana('GET', `/data-products/${product}/monitor`);
    expect(prop.monitor).toMatchObject({ id: monitor });
    expect(prop.checks).toEqual([expect.objectContaining({ elementId: el.customers, mode: 'freshness' })]);
    const ordersCheck = (await dana('GET', `/data-elements/${el.orders}/checks`)).checks.find(
      (c: { purpose: string; origin: string }) => c.purpose === 'freshness' && c.origin === 'made',
    ).check.id;
    expect(prop.links).toEqual([{ from: ordersCheck, to: prop.checks[0].id }]);
    const before = (await dana('GET', `/monitors/${monitor}`)).version;
    const r = await dana('POST', `/data-products/${product}/monitor`, {});
    expect(r).toMatchObject({ created: false, added: 1, monitor: { id: monitor } });
    const m = await dana('GET', `/monitors/${monitor}`);
    expect(m.version).toBe(before + 1);
    expect(m.definition.checks).toHaveLength(7);
    expect(await fail(dana('POST', `/data-products/${product}/monitor`, {}))).toMatchObject({
      status: 409,
      code: 'DATA_PRODUCT_MONITOR_EMPTY',
      params: { context: 'nothingToAdd' },
    });
    const audit = (await s.api('GET', '/audit?action=dataproduct.monitor_created')) as { items?: { summary: string }[] } | { summary: string }[];
    expect(JSON.stringify(audit)).toContain('1 check(s) added');
  });
});

describe('checks linked to an element', () => {
  let mine = '';
  let theirs = '';
  it('offers checks found by their fields, links them, and shows a check of a monitor the reader may not see by its status only', async () => {
    mine = (
      await dana('POST', '/monitors', {
        definition: {
          name: 'Contacts by hand',
          failuresBeforeDown: 1,
          checks: [{ id: 'sf', name: 'Contacts table', type: 'snowflake', platform: sf, mode: 'freshness', object: 'CRM.CORE.CONTACTS', maxAgeMinutes: 120 }],
        },
      })
    ).monitor.id;
    const found = await dana('GET', `/data-elements/${el.contacts}/checks`);
    expect(found).toMatchObject({ canLink: true, health: { status: 'noData', checks: { visible: 0, hidden: 0 } } });
    expect(found.checks).toEqual([expect.objectContaining({ linkId: null, origin: 'found', check: { id: 'sf', name: 'Contacts table', type: 'snowflake' } })]);
    expect((await fail(vera('POST', `/data-elements/${el.contacts}/checks`, { monitor: mine, checkId: 'sf' }))).status).toBe(403);
    expect(await fail(dana('POST', `/data-elements/${el.contacts}/checks`, { monitor: mine, checkId: 'nope' }))).toMatchObject({
      code: 'DATA_CHECK_NOT_FOUND',
    });
    await evaluate(mine);
    const linked = await dana('POST', `/data-elements/${el.contacts}/checks`, { monitor: mine, checkId: 'sf', purpose: 'freshness' });
    expect(linked.health).toEqual({ elementId: el.contacts, status: 'up', checks: { visible: 1, hidden: 0 } });
    // an administrator's monitor dana may not see, with a failing check linked to the same element
    theirs = (
      await s.api('POST', '/monitors', {
        definition: {
          name: 'Secret watcher',
          failuresBeforeDown: 1,
          checks: [{ id: 'stale', name: 'Stale secret', type: 'data-element', element: el.contacts, maxAgeMinutes: 1 }],
        },
      })
    ).monitor.id;
    await s.api('PUT', `/monitors/${theirs}/access`, { acl: [{ subject: 'user:admin', permissions: ['view', 'edit'] }] });
    await evaluate(theirs);
    await s.api('POST', `/data-elements/${el.contacts}/checks`, { monitor: theirs, checkId: 'stale', purpose: 'freshness' });
    const seen = await dana('GET', `/data-elements/${el.contacts}/checks`);
    expect(seen.health).toEqual({ elementId: el.contacts, status: 'down', checks: { visible: 1, hidden: 1 } });
    const hiddenOne = seen.checks.find((c: { hidden: boolean }) => c.hidden);
    expect(hiddenOne).toMatchObject({ status: 'down', monitor: null, check: null, message: null, createdBy: '' });
    expect(JSON.stringify(seen)).not.toContain('Secret watcher');
    expect(JSON.stringify(seen)).not.toContain(theirs);
  });

  it('unlinks a check', async () => {
    const before = await dana('GET', `/data-elements/${el.contacts}/checks`);
    const link = before.checks.find((c: { monitor: { id: string } | null }) => c.monitor?.id === mine).linkId;
    await dana('DELETE', `/data-elements/${el.contacts}/checks/${link}`);
    const after = await dana('GET', `/data-elements/${el.contacts}/checks`);
    // found again, no longer linked
    expect(after.checks.find((c: { monitor: { id: string } | null }) => c.monitor?.id === mine)).toMatchObject({ linkId: null, origin: 'found' });
    expect(after.health.checks).toEqual({ visible: 0, hidden: 1 });
  });
});

describe('health of products', () => {
  it('is the output elements’ worst status with internal ones only degrading, no data without checks, and hidden products left out', async () => {
    const team = ((await s.api('GET', '/teams')) as { id: string; name: string }[]).find((t) => t.name === 'Platform team')!.id;
    const mk = async (key: string, output: string, internal?: string) => {
      const p = await dana('POST', '/data-products', { key, name: key });
      await dana('POST', `/data-products/${p.id}/members`, { elementIds: [output], role: 'output' });
      if (internal) await dana('POST', `/data-products/${p.id}/members`, { elementIds: [internal], role: 'internal' });
      return p.id as string;
    };
    // contacts: down (the hidden check) as output; as internal it only degrades
    const a = await mk('wp3-health-a', el.contacts);
    const b = await mk('wp3-health-b', el.customers, el.contacts);
    const c = await mk('wp3-health-c', el.payments);
    const hidden = await mk('wp3-health-hidden', el.payments);
    await s.api('PUT', `/owning-teams/data_product/${hidden}`, { teamIds: [team] });
    const list = await dana('GET', `/data-products/health?ids=${[a, b, c, hidden].join(',')}`);
    expect(list.map((h: { productId: string; status: string; source: string }) => [h.productId, h.status, h.source])).toEqual([
      [a, 'down', 'elements'],
      [b, 'degraded', 'elements'],
      [c, 'noData', 'none'],
    ]);
    expect(JSON.stringify(list)).not.toContain(hidden);
  });

  it('takes a fixed number of statements whatever the number of products', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await dana('POST', '/data-products', { key: `wp3-many-${i}`, name: `Many ${i}` });
      await dana('POST', `/data-products/${p.id}/members`, { elementIds: [i % 2 ? el.contacts : el.customers], role: 'output' });
      ids.push(p.id);
    }
    const url = (n: number) => `/api/data-products/health?ids=${ids.slice(0, n).join(',')}`;
    await dana('GET', url(2).slice(4));
    const few = counted.get(url(2))!;
    await dana('GET', url(12).slice(4));
    const many = counted.get(url(12))!;
    expect(few).toBeGreaterThan(0);
    expect(many).toBe(few);
    expect(many).toBeLessThanOrEqual(20);
    console.log('health statements', { few, many });
  });
});

describe('contract drafts from an element', () => {
  it('drafts from Snowflake columns and a Kafka subject, never from an element the person may not see', async () => {
    const t = await dana('POST', '/data-contracts/draft', { source: 'element', elementId: el.orders });
    expect(t.yaml).toContain('name: ORDER_ID');
    expect(t.yaml).toContain('physicalType: NUMBER(38,0)');
    expect(t.yaml).toContain('account: DEMO12345');
    const k = await dana('POST', '/data-contracts/draft', { source: 'element', elementId: el.topic });
    expect(k.yaml).toContain('name: orderId');
    expect(k.yaml).toContain('type: kafka');
    const hidden = ((await s.api('GET', '/data-elements?prefix=CRM.CORE.HIDDEN')) as { items: { id: string }[] }).items[0]!.id;
    expect(await fail(dana('POST', '/data-contracts/draft', { source: 'element', elementId: hidden }))).toMatchObject({
      status: 400,
      code: 'DATA_CONTRACT_DRAFT_SOURCE',
    });
  });
});

describe('Snowflake names in statements', () => {
  it('upper-cases unquoted parts, keeps quoted ones, and refuses what does not belong into a statement', async () => {
    const { snowflakeParts, snowflakeIdent } = await import('../src/dataproducts/checks/freshness.js');
    expect(snowflakeParts('shop.sales.orders')).toEqual(['SHOP', 'SALES', 'ORDERS']);
    expect(snowflakeParts('"Shop".SALES."Orders-2"')).toEqual(['Shop', 'SALES', 'Orders-2']);
    expect(snowflakeParts('SHOP.SALES.ORDERS; DROP TABLE X')).toBeNull();
    expect(snowflakeParts('A.B.C.D')).toBeNull();
    expect(snowflakeParts('"SHOP.SALES')).toBeNull();
    expect(snowflakeIdent('SHOP')).toBe('SHOP');
    expect(snowflakeIdent('Shop')).toBe('"Shop"');
  });
});

describe('the module switch', () => {
  it('reports the check unknown while the module is off', async () => {
    await s.api('PUT', '/settings/modules/dataProducts', { enabled: false });
    try {
      const { dataElementCheck } = await import('../src/dataproducts/checks/element.js');
      const r = await dataElementCheck(
        { id: 'x', name: 'x', type: 'data-element', element: el.orders, mode: 'freshness', each: 'any', failAs: 'down', warningAs: 'degraded' },
        {
          owner: 'dana',
          now: () => Date.now(),
        },
      );
      expect(r).toMatchObject({ status: 'unknown', message: 'The data products module is off' });
    } finally {
      await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
    }
  });
});
