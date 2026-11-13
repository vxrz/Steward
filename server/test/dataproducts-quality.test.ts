import { beforeAll, describe, expect, it } from 'vitest';
import { qualityDimensionOf } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Quality and the scorecard over time (0.24.0, ADR 0036 phase 2, package B): quality results (the write function,
 * hourly rows, dimensions), the `data-element` check's volume mode (Snowflake ROW_COUNT and BYTES, Kafka end offsets)
 * and quality mode (Data Metric Function results, recorded results) against the mocks with their statement allow-list,
 * the ISO/IEC 25012 dimensions accuracy, completeness and consistency and the completeness objective in the scorecard,
 * daily snapshots with the history route and their statement counts, and the report section.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let sf = '';
let kafka = '';
let orders = '';
let customers = '';
let topic = '';
let product = '';
let hidden = '';
const counted = new Map<string, number>();

const preview = (c: Client, check: Record<string, unknown>) =>
  c('POST', '/monitors/check-preview', { check: { id: 'x', name: 'Element', type: 'data-element', ...check } }) as Promise<{ status: string; message: string }>;
const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string } };
    return { status: err.status, code: err.body?.code ?? '' };
  }
  throw new Error('expected a refusal');
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

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
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
  sf = platforms.find((p) => p.kind === 'snowflake')!.id;
  kafka = platforms.find((p) => p.kind === 'kafka')!.id;
  const el = async (platformId: string, kind: string, qualifiedName: string) =>
    (await dana('POST', '/data-elements', { platformId, kind, qualifiedName, environment: 'prod' })).id as string;
  orders = await el(sf, 'snowflake.table', 'SHOP.SALES.ORDERS');
  customers = await el(sf, 'snowflake.table', 'SHOP.SALES.CUSTOMERS');
  topic = await el(kafka, 'kafka.topic', 'orders');
  product = (await dana('POST', '/data-products', { key: 'dp-q-orders', name: 'Invented quality orders', owners: ['user:dana'] })).id;
  const port = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table', version: 'v1' })).id;
  await dana('PUT', `/data-products/${product}/ports/${port}/bindings/prod`, { elementIds: [orders, customers], objectives: { completenessPct: 90 } });
  // an element vera may not see
  const team = (await s.api('POST', '/teams', { name: 'Invented quality team', members: ['dana'] })).id;
  hidden = await el(sf, 'snowflake.table', 'SHOP.SALES.HIDDEN_Q');
  const { db } = await import('../src/db.js');
  db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_element', ?, ?, ?)", hidden, team, new Date().toISOString());
}, 180_000);

describe('quality results', () => {
  it('maps ODCS dimensions, dbt tests, DMF and contract checks to ISO/IEC 25012 dimensions', () => {
    expect(qualityDimensionOf('conformity')).toBe('accuracy');
    expect(qualityDimensionOf('uniqueness')).toBe('consistency');
    expect(qualityDimensionOf('coverage')).toBe('completeness');
    expect(qualityDimensionOf(null, 'not_null_orders_order_id')).toBe('completeness');
    expect(qualityDimensionOf(null, 'unique_orders_order_id')).toBe('consistency');
    expect(qualityDimensionOf(null, 'relationships_orders_customer_id__customer_id__ref_customers_')).toBe('consistency');
    expect(qualityDimensionOf(null, 'accepted_values_orders_status')).toBe('accuracy');
    expect(qualityDimensionOf(null, 'SNOWFLAKE.CORE.NULL_COUNT(EMAIL)')).toBe('completeness');
    expect(qualityDimensionOf(null, 'SNOWFLAKE.CORE.DUPLICATE_COUNT')).toBe('consistency');
    expect(qualityDimensionOf(null, 'nullValues')).toBe('completeness');
    expect(qualityDimensionOf(null, 'something_else')).toBeNull();
  });

  it('records results through the one write function: one row per element, source, name and hour; unknown elements skipped', async () => {
    const { recordQualityResults } = await import('../src/dataproducts/quality.js');
    const r = recordQualityResults([
      { elementId: customers, source: 'dbt', name: 'not_null_customers_email', status: 'failed', value: 12, observedAt: hoursAgo(2.1), runRef: 'inv-1' },
      { elementId: customers, source: 'dbt', name: 'not_null_customers_email', status: 'passed', observedAt: hoursAgo(1.2), runRef: 'inv-2' },
      { elementId: customers, source: 'dbt', name: 'not_null_customers_email', status: 'warning', observedAt: hoursAgo(1.1), runRef: 'inv-3' },
      { elementId: customers, source: 'dbt', name: 'unique_customers_id', status: 'passed', dimension: 'uniqueness' },
      { elementId: 'dpe_unknown', source: 'dbt', name: 'not_null_x', status: 'passed' },
    ]);
    expect(r).toEqual({ recorded: 4, skipped: 1 });
    const q = await dana('GET', `/data-elements/${customers}/quality`);
    // two hours: 2.1 h ago, and 1.2 h / 1.1 h ago in the same hour (the later one kept) – unless the hours fall otherwise
    const rows = q.results.filter((x: { name: string }) => x.name === 'not_null_customers_email');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows[0]).toMatchObject({ status: 'warning', runRef: 'inv-3', dimension: 'completeness' });
    const dims = Object.fromEntries(q.summary.map((x: { dimension: string }) => [x.dimension, x]));
    // the latest of each test counts
    expect(dims.completeness).toMatchObject({ tests: 1, warning: 1, failed: 0 });
    expect(dims.consistency).toMatchObject({ tests: 1, passed: 1 });
    // refused input: an invalid status
    expect(() => recordQualityResults([{ elementId: customers, source: 'dbt', name: 'x', status: 'nope' as never }])).toThrow();
  });

  it('shows an element’s results only to who may see it', async () => {
    expect(await fail(vera('GET', `/data-elements/${hidden}/quality`))).toMatchObject({ status: 404, code: 'DATA_ELEMENT_NOT_FOUND' });
    expect((await vera('GET', `/data-elements/${customers}/quality`)).elementId).toBe(customers);
  });
});

describe('the volume mode', () => {
  it('reads ROW_COUNT from Snowflake metadata and judges it against the reading before', async () => {
    const mock = await import('../src/mock/mockDataElements.js');
    const { db } = await import('../src/db.js');
    expect(await preview(dana, { element: orders, mode: 'volume', minRows: 1000 })).toMatchObject({
      status: 'up',
      message: expect.stringContaining('125,000 rows'),
    });
    expect(await preview(dana, { element: orders, mode: 'volume', minRows: 200_000 })).toMatchObject({
      status: 'down',
      message: expect.stringContaining('(at least 200,000)'),
    });
    // a reading two hours ago: grown by 5,000 since; too little growth and too large a change fail
    db().run("INSERT INTO dp_volume_readings (element_id, measure, read_at, value) VALUES (?, 'rows', ?, 120000)", orders, hoursAgo(2));
    expect(await preview(dana, { element: orders, mode: 'volume' })).toMatchObject({ status: 'up', message: expect.stringContaining('+5,000 rows since') });
    expect(await preview(dana, { element: orders, mode: 'volume', minGrowth: 10_000, failAs: 'degraded' })).toMatchObject({
      status: 'degraded',
      message: expect.stringContaining('grew by 5,000 rows (at least 10,000)'),
    });
    mock.setTableVolume('SHOP.SALES.ORDERS', 60_000);
    expect(await preview(dana, { element: orders, mode: 'volume', maxChangePct: 20 })).toMatchObject({
      status: 'down',
      message: expect.stringContaining('changed by 50 % (at most 20 %)'),
    });
    mock.resetDataElementMock();
    // bytes
    expect(await preview(dana, { element: customers, mode: 'volume', measure: 'bytes' })).toMatchObject({ status: 'up', message: expect.stringContaining('640,000 bytes') });
    // the verdicts are completeness results of the element
    const q = await dana('GET', `/data-elements/${orders}/quality`);
    expect(q.results.some((r: { source: string; name: string }) => r.source === 'check' && r.name === 'volume:rows')).toBe(true);
  });

  it('reads a Kafka topic’s messages from its end offsets – no consumer, no message read', async () => {
    const { kafkaCalls, resetKafkaCalls, produceKafka } = await import('../src/mock/mockKafka.js');
    resetKafkaCalls();
    const { db } = await import('../src/db.js');
    const first = await preview(dana, { element: topic, mode: 'volume' });
    expect(first).toMatchObject({ status: 'up', message: expect.stringContaining('messages') });
    const total = Number(/: ([\d,]+) messages/.exec(first.message)![1]!.replaceAll(',', ''));
    db().run("INSERT INTO dp_volume_readings (element_id, measure, read_at, value) VALUES (?, 'offsets', ?, ?)", topic, hoursAgo(2), total);
    expect(await preview(dana, { element: topic, mode: 'volume', minGrowth: 1 })).toMatchObject({ status: 'down', message: expect.stringContaining('grew by 0 messages') });
    produceKafka('orders', 5);
    expect(await preview(dana, { element: topic, mode: 'volume', minGrowth: 1 })).toMatchObject({ status: 'up', message: expect.stringContaining('+5 messages') });
    expect(await preview(dana, { element: topic, mode: 'volume', measure: 'bytes' })).toMatchObject({ status: 'unknown' });
    for (const c of kafkaCalls()) expect(c).toMatch(/^(metadata|ends) /);
  });

  it('keeps at most one reading per 5 minutes', async () => {
    const { db } = await import('../src/db.js');
    const n = () => Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM dp_volume_readings WHERE element_id = ? AND measure = 'rows'", customers)!.n);
    await preview(dana, { element: customers, mode: 'volume' });
    const before = n();
    expect(before).toBeGreaterThan(0);
    await preview(dana, { element: customers, mode: 'volume' });
    expect(n()).toBe(before);
  });
});

describe('the quality mode', () => {
  it('judges Data Metric Function results: by default null, blank and duplicate counts must be 0', async () => {
    expect(await preview(dana, { element: orders, mode: 'quality', qualitySource: 'dmf' })).toMatchObject({
      status: 'up',
      message: expect.stringContaining('all 2 metrics within their limits'),
    });
    expect(await preview(dana, { element: customers, mode: 'quality', qualitySource: 'dmf' })).toMatchObject({
      status: 'down',
      message: expect.stringContaining('NULL_COUNT(EMAIL) = 12 (≤ 0)'),
    });
    // limits of its own
    expect(
      await preview(dana, { element: customers, mode: 'quality', qualitySource: 'dmf', metrics: [{ metric: 'NULL_COUNT', column: 'EMAIL', max: 20 }] }),
    ).toMatchObject({ status: 'up' });
    expect(await preview(dana, { element: orders, mode: 'quality', qualitySource: 'dmf', metrics: [{ metric: 'ROW_COUNT', min: 200_000 }] })).toMatchObject({
      status: 'down',
    });
    // outside the window: nothing to judge
    expect(await preview(dana, { element: customers, mode: 'quality', qualitySource: 'dmf', withinHours: 1 })).toMatchObject({ status: 'unknown' });
    // judged metrics are quality results of the element (source dmf)
    const q = await dana('GET', `/data-elements/${orders}/quality`);
    expect(q.results.filter((r: { source: string }) => r.source === 'dmf').length).toBeGreaterThan(0);
  });

  it('judges the recorded results without reading a platform', async () => {
    const { recordQualityResults } = await import('../src/dataproducts/quality.js');
    recordQualityResults([{ elementId: topic, source: 'dbt', name: 'not_null_orders_id', status: 'passed' }]);
    expect(await preview(dana, { element: topic, mode: 'quality' })).toMatchObject({ status: 'up', message: expect.stringContaining('all 1 quality tests passed') });
    recordQualityResults([{ elementId: topic, source: 'contract', name: 'field_required:orders.id', status: 'failed' }]);
    expect(await preview(dana, { element: topic, mode: 'quality', failAs: 'degraded' })).toMatchObject({ status: 'degraded' });
  });

  it('sends statements of an allow-list only: the table’s INFORMATION_SCHEMA row and the DMF results view, names bound', async () => {
    const { qualityStatements } = await import('../src/mock/mockDataElements.js');
    expect(qualityStatements.length).toBeGreaterThan(3);
    const ALLOWED = [
      /^\/\* steward:dp-table-volume \*\/ SELECT ROW_COUNT, BYTES FROM IDENTIFIER\(\?\) WHERE TABLE_SCHEMA = \? AND TABLE_NAME = \?$/,
      /^\/\* steward:dp-dmf-results \*\/ SELECT [^;]+ FROM SNOWFLAKE\.LOCAL\.DATA_QUALITY_MONITORING_RESULTS\s+WHERE TABLE_DATABASE = \? AND TABLE_SCHEMA = \? AND TABLE_NAME = \? AND [^;]+$/,
    ];
    for (const { sql, bindings } of qualityStatements) {
      expect(ALLOWED.some((re) => re.test(sql.replace(/\s+/g, ' ').replace('RESULTS WHERE', 'RESULTS\nWHERE')))).toBe(true);
      expect(sql).not.toMatch(/SELECT \*|\bSAMPLE\b|\bFROM SHOP\.|INSERT|UPDATE|DELETE|MERGE|CALL /i);
      if (sql.includes('IDENTIFIER(?)')) expect(bindings[0]).toMatch(/^[A-Z_]+\.INFORMATION_SCHEMA\.TABLES$/);
    }
  });
});

describe('the scorecard', () => {
  it('maps quality results to accuracy, completeness and consistency, and judges the completeness objective', async () => {
    const card = await dana('GET', `/data-products/${product}/scorecard?environment=prod`);
    const part = (id: string) => card.parts.find((x: { id: string }) => x.id === id);
    expect(part('completeness').state).toBe('notMet');
    expect(part('completeness').evidence[0].key).toBe('evidence.quality.results');
    expect(part('consistency').state).toBe('met');
    // the objective: the share of completeness results that passed (some failed above)
    const obj = part('objectivesMet');
    expect(obj.evidence.map((e: { key: string }) => e.key)).toContain('evidence.objectives.completeness');
    expect(obj.state).toBe('notMet');
    expect(part('credibility').state).toBe('noEvidence');
  });
});

describe('scorecard history', () => {
  it('takes one snapshot a day per product and environment, keeps 400 days, and draws the history', async () => {
    const { takeScorecardSnapshots } = await import('../src/dataproducts/scorecard-history.js');
    const { db } = await import('../src/db.js');
    const n0 = takeScorecardSnapshots();
    expect(n0).toBeGreaterThan(0);
    // once a day
    expect(takeScorecardSnapshots()).toBe(0);
    // earlier days, and one beyond the retention
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    for (const d of [1, 2, 3])
      db().run(
        "INSERT INTO dp_scorecard_snapshots (product_id, environment, day, maturity, states, taken_at) VALUES (?, 'prod', ?, ?, '{\"documented\":\"met\"}', ?)",
        product,
        day(d),
        d === 3 ? 0 : 1,
        new Date().toISOString(),
      );
    db().run(
      "INSERT INTO dp_scorecard_snapshots (product_id, environment, day, maturity, states, taken_at) VALUES (?, 'prod', ?, 1, '{}', ?)",
      product,
      day(500),
      new Date().toISOString(),
    );
    takeScorecardSnapshots(Date.now(), true);
    expect(db().get('SELECT 1 FROM dp_scorecard_snapshots WHERE day = ?', day(500))).toBeUndefined();
    const h = await dana('GET', `/data-products/${product}/scorecard/history?environment=prod&days=30`);
    expect(h.points.map((p: { day: string }) => p.day)).toEqual([day(3), day(2), day(1), day(0)]);
    expect(h.points[0]).toMatchObject({ maturity: 0, met: 1 });
    expect(h.points[3].states.healthy).toBeDefined();
    // a product the reader may not see answers like a missing one
    const team = (await s.api('POST', '/teams', { name: 'Invented history team', members: ['dana'] })).id;
    const secret = (await dana('POST', '/data-products', { key: 'dp-q-secret', name: 'Invented secret' })).id;
    db().run("DELETE FROM resource_teams WHERE kind = 'data_product' AND resource_id = ?", secret);
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)", secret, team, new Date().toISOString());
    expect(await fail(vera('GET', `/data-products/${secret}/scorecard/history`))).toMatchObject({ status: 404, code: 'DATA_PRODUCT_NOT_FOUND' });
  });

  it('reads the history and the scorecard with a fixed number of statements', async () => {
    const url = (days: number) => `/api/data-products/${product}/scorecard/history?environment=prod&days=${days}`;
    await dana('GET', url(7).slice(4));
    await dana('GET', url(400).slice(4));
    expect(counted.get(url(400))!).toBe(counted.get(url(7)));
    expect(counted.get(url(400))!).toBeLessThanOrEqual(15);
    // the scorecard: the same number of statements with one output element or two
    const one = (await dana('POST', '/data-products', { key: 'dp-q-one', name: 'Invented one' })).id;
    const p1 = (await dana('POST', `/data-products/${one}/ports`, { direction: 'output', name: 'o', type: 'table' })).id;
    await dana('PUT', `/data-products/${one}/ports/${p1}/bindings/prod`, { elementIds: [orders] });
    const a = `/api/data-products/${one}/scorecard?environment=prod`;
    const b = `/api/data-products/${product}/scorecard?environment=prod`;
    await dana('GET', a.slice(4));
    await dana('GET', b.slice(4));
    expect(counted.get(b)).toBe(counted.get(a));
  });
});

describe('the report section', () => {
  it('lists the products the owner may see with maturity at the start and now, and their quality tests', async () => {
    const { reportSection } = await import('../src/reports/sections.js');
    const sec = reportSection('dataProducts')!;
    expect(sec).toBeTruthy();
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const from = Date.now() - 2 * 86_400_000;
    const build = (user: string, cfg: Record<string, unknown> = {}) =>
      runAs(toAuthUser(findUserByName(user)!), () => sec.build(sec.schema.parse(cfg), { from, to: Date.now() + 1000, now: Date.now(), lang: 'en' })) as {
        rows: { key: string; maturityBefore: number | null; failed: number; passed: number }[];
        totals: { products: number };
      };
    const d = build('dana', { environment: 'prod' });
    const row = d.rows.find((r) => r.key === 'dp-q-orders')!;
    expect(row.maturityBefore).toBe(1);
    expect(row.passed + row.failed).toBeGreaterThan(0);
    expect(d.rows.some((r) => r.key === 'dp-q-secret')).toBe(true);
    // vera may not see the secret product: neither listed nor counted
    const v = build('vera', { environment: 'prod' });
    expect(v.rows.some((r) => r.key === 'dp-q-secret')).toBe(false);
    expect(v.totals.products).toBe(v.rows.length);
    expect(v.totals.products).toBeLessThan(d.totals.products);
    // a product the owner may not see is refused in the configuration like a missing one
    const secret = d.rows.find((r) => r.key === 'dp-q-secret');
    expect(secret).toBeTruthy();
    const { db } = await import('../src/db.js');
    const secretId = db().get<{ id: string }>("SELECT id FROM dp_products WHERE key = 'dp-q-secret'")!.id;
    expect(() => runAs(toAuthUser(findUserByName('vera')!), () => sec.validate!(sec.schema.parse({ productIds: [secretId] })))).toThrow(/not found/);
    // the draw half is known to the PDF worker
    const { SECTION_DRAWERS } = await import('../src/reports/pdf/drawers.js');
    expect(SECTION_DRAWERS.some((x) => x.id === 'dataProducts')).toBe(true);
  });
});
