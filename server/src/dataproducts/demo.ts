import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { logger } from '../log.js';
import { addKafkaMessages, addKafkaTopic, produceKafka } from '../mock/mockKafka.js';
import { dropSnowflakeObject } from '../mock/mockSnowflake.js';
import { newId, nowIso } from '../util.js';
import { requestAccess } from './access-requests.js';
import { readNow, writeIdentities } from './consumers-actual.js';
import { addProductMatch, setAllocation } from './costs.js';
import { runSource } from './discovery/job.js';
import { createSource } from './discovery/sources.js';
import { applyImport } from './import.js';
import { applyOlEvents, parseOlEvent } from './lineage/openlineage.js';
import { createLineageSource } from './lineage/sources.js';
import { readMeasuredUse } from './measured.js';
import { applyMonitor } from './monitor-draft.js';
import { addConsumer } from './ports.js';
import { recordQualityResults } from './quality.js';
import { setObjectRopaDetails } from './ropa-details.js';
import { saveSemanticVersion } from './semantic.js';
import { takeScorecardSnapshots } from './scorecard-history.js';

/**
 * The data products of the demo (0.22.0, ADR 0036 "Demo", docs/DATA-PRODUCTS.md): invented, on the simulated platforms.
 *
 *   1. Topics on "Kafka (demo)" – orders.v1 and the bundle's shop-events.web and shop-events.app – with messages.
 *   2. Two discovery sources, read once: "Snowflake (demo)" over the databases SHOP and SHOP_DEV (the name rule
 *      `_DEV` → dev, the rest prod) and "Kafka (demo)" over the prefixes orders. and shop-events. (prod).
 *   3. The example files examples/data-products/*.yaml imported (add only): the domains Sales (with Orders), Customer
 *      and Manufacturing, the data objects Customer, Order and Machine measurement with their ratings, a topic bundle
 *      and an API, and the products Orders (dev and prod, a pipeline with a connector, dbt and a task as runners, the
 *      output port orders v2 under the contract "Shop orders", orders v1 deprecated), Customer 360 (rated below its
 *      data object with a reason, under the failing contract "Shop customers"), Sales mart (input ports on both, one
 *      on the deprecated port, a table and an API as outputs) and a draft product.
 *   4. Create monitor on Orders in prod: the disabled draft with a freshness check per element and soft links along
 *      the steps (enable it to see health along the pipeline).
 *   5. Costs from the Confluent Cloud demo lines: the connector to Orders alone, the cluster shared by Orders and Sales
 *      mart **by measured use** (0.24.0: the bytes its topics received, from the Metrics API – orders for Orders,
 *      payments for Sales mart, the rest not attributed), the event source connector shared equally by Orders and
 *      Customer 360.
 *   6. A second Snowflake run after a stage was dropped: the element is marked missing.
 *   7. Phase 2 (0.24.0): an OpenLineage lineage source "Shop Airflow (demo)" with two pushed jobs – one the step
 *      "Region report" documents already, one proposed (orders → daily sales); quality results of the curated orders
 *      (dbt tests) and customers (Data Metric Functions); on Orders' output port a registration the platform sees
 *      (role REPORTING) and one that stays silent, read once from ACCESS_HISTORY; an open access request for
 *      Customer 360's port; 30 days of scorecard history behind today's snapshot (a maturity that rose twice), so
 *      the trend has something to draw.
 *
 * Loaded with the service half of the demo (Home → Load demo, the UI tests), whether the module is on or off: switched
 * on, it is there. Once – a domain "sales" means it was loaded.
 */

const FILES = ['shop-catalogue.data-products.yaml', 'shop-products.data-products.yaml'];

const platformId = (name: string): string | undefined => db().get<{ id: string }>('SELECT id FROM platforms WHERE name = ?', name)?.id;

export async function seedDataProductsDemo(actor: string): Promise<number> {
  if (!config.demo || db().get("SELECT 1 FROM dp_domains WHERE key = 'sales'")) return 0;
  const snowflake = platformId('Snowflake (demo)');
  const kafka = platformId('Kafka (demo)');
  if (!snowflake || !kafka) return 0;

  // 1. the topics of the shop (the mock keeps its other topics as they are)
  addKafkaTopic('orders.v1', 3);
  addKafkaTopic('shop-events.web', 1);
  addKafkaTopic('shop-events.app', 1);
  for (const t of ['orders.v1', 'shop-events.web', 'shop-events.app']) produceKafka(t, 12);

  // 2. discovery
  const sf = createSource({
    name: 'Shop warehouse (demo)',
    platformId: snowflake,
    scope: ['SHOP', 'SHOP_DEV'],
    environmentRules: [
      { match: 'suffix', value: '_DEV', environment: 'dev' },
      { match: 'prefix', value: 'SHOP', environment: 'prod' },
    ],
    intervalMinutes: 1440,
  });
  const kf = createSource({
    name: 'Shop topics (demo)',
    platformId: kafka,
    scope: ['orders.', 'shop-events.'],
    environmentRules: [
      { match: 'prefix', value: 'orders.', environment: 'prod' },
      { match: 'prefix', value: 'shop-events.', environment: 'prod' },
    ],
    intervalMinutes: 1440,
  });
  for (const s of [sf, kf]) {
    const run = await runSource(s.id, { trigger: 'manual', actor });
    if (run.status !== 'succeeded') logger.warn({ source: s.name, status: run.status, error: run.error }, 'demo discovery run did not succeed');
  }

  // 3. the example files, as an administrator imports them
  const files = FILES.map((name) => ({ name, content: fs.readFileSync(path.join(config.examplesDir, 'data-products', name), 'utf8') }));
  const imported = applyImport({ files, mode: 'add' });
  const product = (key: string) => db().get<{ id: string }>('SELECT id FROM dp_products WHERE key = ?', key)!.id;
  const orders = product('orders');

  // 4. Create monitor (a disabled draft for review)
  try {
    await applyMonitor(orders, { environment: 'prod' });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo data product monitor not created');
  }

  // 5. costs from the demo Confluent lines
  const confluent = platformId('Confluent Cloud (demo)');
  if (confluent) {
    try {
      const match = (p: string, value: string) => addProductMatch(p, { platformId: confluent, environment: 'prod', kind: 'resource', value });
      match(orders, 'lcc-demo1');
      match(orders, 'lkc-demo1');
      match(product('sales-mart'), 'lkc-demo1');
      match(orders, 'lcc-demo2');
      match(product('customer-360'), 'lcc-demo2');
      // by measured use (0.24.0): the bytes the cluster's topics received – a topic of neither product is not attributed
      setAllocation({
        platformId: confluent,
        kind: 'resource',
        value: 'lkc-demo1',
        rule: 'measured',
        measure: 'confluentTopic',
        subjects: [
          { productId: orders, subjects: ['orders'] },
          { productId: product('sales-mart'), subjects: ['payments'] },
        ],
      });
      setAllocation({ platformId: confluent, kind: 'resource', value: 'lcc-demo2', rule: 'equal' });
      await readMeasuredUse(Date.now(), { force: true, platformId: confluent });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'demo data product costs not matched');
    }
  }

  // 6. a stage dropped in dev: the second run marks it missing
  dropSnowflakeObject('SHOP_DEV.RAW.LANDING');
  await runSource(sf.id, { trigger: 'manual', actor });

  // 7. phase 2 (0.24.0)
  const el = (qualifiedName: string) =>
    db().get<{ id: string; ol_namespace: string | null; ol_name: string | null }>(
      "SELECT id, ol_namespace, ol_name FROM dp_elements WHERE platform_id = ? AND qualified_name = ? AND environment = 'prod'",
      snowflake,
      qualifiedName,
    );
  try {
    lineageDemo(el);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo lineage source not set up');
  }
  try {
    qualityDemo(el);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo quality results not recorded');
  }
  try {
    scorecardHistoryDemo();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo scorecard history not written');
  }
  try {
    await consumersDemo(orders, product('customer-360'));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo consumers and access request not set up');
  }
  // 8. phase 3, package D (0.25.0): Orders' semantic model, messages to peek at, the Art. 30 details of Customer
  try {
    semanticDemo(orders);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo semantic model not saved');
  }
  return imported.counts.add;
}

/**
 * Version 1 of Orders' semantic model (examples/data-products/orders.semantic-model.yaml), signed off by the demo's
 * approver; a few invented events on orders.v1 for the peek; the data object Customer's transfer to a third country
 * and the reference to the technical and organisational measures (Art. 30(1)(e) and (g)).
 */
function semanticDemo(orders: string): void {
  const text = fs.readFileSync(path.join(config.examplesDir, 'data-products', 'orders.semantic-model.yaml'), 'utf8');
  const saved = saveSemanticVersion(orders, { document: text, note: 'The governed copy of the shop’s semantic layer (invented)' });
  const approver = db().get<{ username: string }>("SELECT username FROM users WHERE username = 'adam'");
  if (saved.created && approver)
    db().run(
      'INSERT INTO dp_semantic_signoffs (id, product_id, version_id, version, sha256, valid_from, note, signed_by, signed_at) SELECT ?, product_id, id, version, sha256, ?, ?, ?, ? FROM dp_semantic_versions WHERE product_id = ? AND version = ?',
      newId(),
      nowIso().slice(0, 10),
      'Checked against the contract Shop orders',
      approver.username,
      nowIso(),
      orders,
      saved.version.version,
    );
  addKafkaMessages(
    'orders.v1',
    [1, 2, 3].map((i) => ({
      key: `o-${2000 + i}`,
      value: JSON.stringify({ orderId: `o-${2000 + i}`, customerId: `c-${300 + i}`, email: `buyer${i}@example.com`, total: 19.9 * i, status: 'confirmed' }),
    })),
  );
  const customer = db().get<{ id: string }>("SELECT id FROM dp_objects WHERE key = 'customer'");
  if (customer)
    setObjectRopaDetails(customer.id, {
      transfers: [{ country: 'United States', recipient: 'Invented Cloud Inc.', safeguard: 'scc', note: 'Support tickets with customer names (invented)' }],
      toms: { kind: 'url', url: 'https://wiki.example/security/toms', label: 'Technical and organisational measures (invented)' },
    });
}

type ElementOf = (qualifiedName: string) => { id: string; ol_namespace: string | null; ol_name: string | null } | undefined;

const HOUR = 3_600_000;

/** An OpenLineage source with two pushed jobs: one documented by the step "Region report", one proposed. */
function lineageDemo(el: ElementOf): void {
  const source = createLineageSource({ name: 'Shop Airflow (demo)', kind: 'openlineage' });
  const ds = (qn: string) => {
    const e = el(qn);
    return e?.ol_namespace && e.ol_name ? [{ namespace: e.ol_namespace, name: e.ol_name }] : [];
  };
  const run = (job: string, n: number, inputs: string[], outputs: string[]) =>
    parseOlEvent({
      eventType: 'COMPLETE',
      eventTime: new Date(Date.now() - n * HOUR).toISOString(),
      run: { runId: `0190c3d4-0000-7000-8000-00000000000${n}` },
      job: { namespace: 'airflow-shop', name: job, facets: { jobType: { integration: 'AIRFLOW' } } },
      inputs: inputs.flatMap(ds),
      outputs: outputs.flatMap(ds),
      producer: 'https://airflow.invented.example',
      schemaURL: 'https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent',
    });
  const events = [
    run('shop.region_report', 2, ['SHOP.CURATED.ORDERS', 'SHOP.CURATED.CUSTOMERS'], ['SHOP.MART.ORDERS_BY_REGION']),
    run('shop.refresh_daily_sales', 1, ['SHOP.CURATED.ORDERS'], ['SHOP.MART.DAILY_SALES']),
  ];
  db().tx(() => {
    applyOlEvents(source.id, [], events);
    db().run('UPDATE dp_lineage_sources SET received = received + ?, last_event_at = ? WHERE id = ?', events.length, nowIso(), source.id);
  });
}

const DAY = 24 * HOUR;
const HISTORY_DAYS = 30;

/**
 * The scorecard over time: today's snapshots (as the daily job takes them), and behind them 30 days of history – a
 * level lower 8 to 20 days ago, two lower before that (never below 0), with as many parts more not met – so the
 * maturity trend draws two steps up. Invented like the rest; the daily job adds a day each day.
 */
function scorecardHistoryDemo(now = Date.now()): void {
  takeScorecardSnapshots(now, true);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const today = db().all<{ product_id: string; environment: string; maturity: number; states: string }>(
    'SELECT product_id, environment, maturity, states FROM dp_scorecard_snapshots WHERE day = ?',
    day(now),
  );
  const taken = nowIso();
  db().tx(() => {
    for (const r of today)
      for (let d = 1; d <= HISTORY_DAYS; d++) {
        const maturity = Math.max(0, r.maturity - (d > 20 ? 2 : d > 7 ? 1 : 0));
        const states = JSON.parse(r.states) as Record<string, string>;
        // each level less: two parts that are met today were not met then
        let lower = (r.maturity - maturity) * 2;
        for (const key of Object.keys(states).reverse())
          if (lower > 0 && states[key] === 'met') {
            states[key] = 'notMet';
            lower--;
          }
        db().run(
          `INSERT INTO dp_scorecard_snapshots (product_id, environment, day, maturity, states, taken_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (product_id, environment, day) DO NOTHING`,
          r.product_id,
          r.environment,
          day(now - d * DAY),
          maturity,
          JSON.stringify(states),
          taken,
        );
      }
  });
}

/** Quality results: dbt tests of the curated orders, Data Metric Functions of the curated customers. */
function qualityDemo(el: ElementOf): void {
  const orders = el('SHOP.CURATED.ORDERS')?.id;
  const customers = el('SHOP.CURATED.CUSTOMERS')?.id;
  const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
  recordQualityResults([
    ...(orders
      ? [
          {
            elementId: orders,
            source: 'dbt' as const,
            name: 'not_null_orders_order_id',
            status: 'passed' as const,
            value: 0,
            runRef: 'invented-dbt-run-1',
            observedAt: at(3),
          },
          {
            elementId: orders,
            source: 'dbt' as const,
            name: 'unique_orders_order_id',
            status: 'passed' as const,
            value: 0,
            runRef: 'invented-dbt-run-1',
            observedAt: at(3),
          },
          {
            elementId: orders,
            source: 'dbt' as const,
            name: 'accepted_values_orders_status',
            status: 'warning' as const,
            value: 2,
            runRef: 'invented-dbt-run-1',
            observedAt: at(3),
          },
        ]
      : []),
    ...(customers
      ? [
          { elementId: customers, source: 'dmf' as const, name: 'SNOWFLAKE.CORE.NULL_COUNT(EMAIL)', status: 'failed' as const, value: 14, observedAt: at(1) },
          {
            elementId: customers,
            source: 'dmf' as const,
            name: 'SNOWFLAKE.CORE.DUPLICATE_COUNT(CUSTOMER_ID)',
            status: 'passed' as const,
            value: 0,
            observedAt: at(1),
          },
        ]
      : []),
  ]);
}

/** Orders' output port: a registration the platform sees and one that stays silent, read once; an access request. */
async function consumersDemo(orders: string, customer360: string): Promise<void> {
  const port = (productId: string, name: string) =>
    db().get<{ id: string }>(
      "SELECT id FROM dp_ports WHERE product_id = ? AND direction = 'output' AND name = ? AND lifecycle <> 'deprecated' ORDER BY version DESC",
      productId,
      name,
    )?.id;
  const ordersPort = port(orders, 'orders');
  if (ordersPort) {
    // the service desk's registration names the role it reads with: ACCESS_HISTORY sees it (seen)
    const desk = db().get<{ id: string }>('SELECT id FROM dp_consumers WHERE port_id = ? ORDER BY created_at LIMIT 1', ordersPort);
    if (desk) db().tx(() => writeIdentities(desk.id, ['role:REPORTING']));
    // a registration whose user reads nothing (registered but silent)
    const silent = addConsumer(orders, 'Orders', ordersPort, { kind: 'text', text: 'Invented payroll export', purpose: 'Monthly bonus figures' });
    db().tx(() => writeIdentities(silent.id, ['user:SVC_PAYROLL']));
    await readNow(orders, ordersPort, 'prod');
  }
  const customerPort = port(customer360, 'customer');
  if (customerPort)
    requestAccess(customer360, customerPort, {
      environment: 'prod',
      consumer: { kind: 'text', text: 'Invented marketing analytics' },
      purpose: 'Segments for the spring campaign',
      identities: ['role:MARKETING'],
    });
}
