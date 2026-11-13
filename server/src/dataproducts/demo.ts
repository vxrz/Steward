import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { logger } from '../log.js';
import { addKafkaTopic, produceKafka } from '../mock/mockKafka.js';
import { dropSnowflakeObject } from '../mock/mockSnowflake.js';
import { addProductMatch, setAllocation } from './costs.js';
import { runSource } from './discovery/job.js';
import { createSource } from './discovery/sources.js';
import { applyImport } from './import.js';
import { applyMonitor } from './monitor-draft.js';

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
 *      mart by weight (70/20 – a tenth not attributed), the event source connector shared equally by Orders and
 *      Customer 360.
 *   6. A second Snowflake run after a stage was dropped: the element is marked missing.
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
      setAllocation({
        platformId: confluent,
        kind: 'resource',
        value: 'lkc-demo1',
        rule: 'weight',
        weights: [
          { productId: orders, pct: 70 },
          { productId: product('sales-mart'), pct: 20 },
        ],
      });
      setAllocation({ platformId: confluent, kind: 'resource', value: 'lcc-demo2', rule: 'equal' });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'demo data product costs not matched');
    }
  }

  // 6. a stage dropped in dev: the second run marks it missing
  dropSnowflakeObject('SHOP_DEV.RAW.LANDING');
  await runSource(sf.id, { trigger: 'manual', actor });
  return imported.counts.add;
}
