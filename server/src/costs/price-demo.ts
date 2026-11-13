import fs from 'node:fs';
import path from 'node:path';
import { CONFLUENT_KIND, SNOWFLAKE_KIND, fiscalYearOf, shiftMonth, type CostPriceEntryInput } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { ROOT_DIR } from '../root-dir.js';
import { createBook, saveEntries } from './price-books.js';
import { createCalculator } from './calculators.js';
import { confirmEstimateProposals, createEstimate } from './estimates.js';
import { setRate } from './fx.js';
import { startMonth, thisMonth, today } from './plans.js';

/**
 * Demo price books, calculators and estimates (0.21.0, ADR 0035): the three example calculators, list books of invented
 * prices for Snowflake, Confluent and an invented SaaS provider, a contracted book of the demo Snowflake platform with
 * a price change ahead, a manual exchange rate, and two estimates – one of the shop with ranges and an ad-hoc
 * adjustment and plan lines made from it, one of the demo Confluent platform. Every price here is invented and says so;
 * only the credits per hour of the warehouse sizes are technical factors. Only when there are no price books yet.
 */

const INVENTED = 'Invented prices for the demo – not the provider’s.';

const warehouses = (credit: string): CostPriceEntryInput[] =>
  (
    [
      ['XS', 1],
      ['S', 2],
      ['M', 4],
      ['L', 8],
      ['XL', 16],
      ['2XL', 32],
      ['3XL', 64],
      ['4XL', 128],
    ] as const
  ).map(([size, credits]) => ({
    sku: `warehouse-${size}`,
    name: `Standard warehouse ${size}`,
    service: 'Warehouse',
    category: 'Analytics',
    driver: 'runtime',
    unit: 'h',
    charge: 'usage',
    price: String(credits),
    creditSku: credit,
    sourceNote: 'Credits per hour of a standard warehouse (technical factor, checked 2026-11-12)',
  }));

export async function setupPriceDemo(now = Date.now()): Promise<number> {
  if (db().get('SELECT id FROM cost_price_books LIMIT 1')) return 0;
  let n = 0;
  const step = async <T>(what: string, fn: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      const r = await fn();
      n++;
      return r;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, `demo ${what} not added`);
      return undefined;
    }
  };
  // ---- the example calculators ----
  const calcDir = path.join(ROOT_DIR, 'examples', 'costs', 'calculators');
  const calcIds = new Map<string, string>();
  for (const f of fs.existsSync(calcDir) ? fs.readdirSync(calcDir).sort() : []) {
    if (!/\.ya?ml$/.test(f)) continue;
    const c = await step(`calculator ${f}`, () => createCalculator({ definition: fs.readFileSync(path.join(calcDir, f), 'utf8'), publish: true }));
    if (c) calcIds.set(c.parsed?.id ?? f, c.id);
  }
  // ---- list books (invented prices) ----
  const snowList = await step('Snowflake list book', () =>
    createBook({ name: 'Snowflake list prices (demo)', kind: 'list', provider: 'Snowflake', currency: 'USD', description: INVENTED, reviewDays: 90 }),
  );
  if (snowList)
    await step('Snowflake list prices', () =>
      saveEntries(snowList.id, {
        mode: 'replace',
        note: 'Demo prices (invented)',
        entries: [
          ...warehouses('compute-credit'),
          {
            sku: 'compute-credit',
            name: 'Compute credit',
            service: 'Compute',
            driver: 'credits',
            unit: '{credit}',
            price: '3.10',
            currency: 'USD',
            sourceNote: INVENTED,
          },
          {
            sku: 'serverless-credit',
            name: 'Serverless credit',
            service: 'Serverless',
            driver: 'credits',
            unit: '{credit}',
            price: '1',
            creditSku: 'compute-credit',
          },
          { sku: 'storage', name: 'Storage', service: 'Storage', driver: 'storage', unit: 'TBy.mo', price: '23', currency: 'USD', sourceNote: INVENTED },
          {
            sku: 'data-transfer',
            name: 'Data transfer out',
            service: 'Transfer',
            driver: 'data transfer',
            unit: 'TBy',
            price: '20',
            currency: 'USD',
            sourceNote: INVENTED,
          },
        ],
      }),
    );
  const confluent = await step('Confluent list book', () =>
    createBook({ name: 'Confluent list prices (demo)', kind: 'list', provider: 'Confluent', currency: 'USD', description: INVENTED, reviewDays: 60 }),
  );
  if (confluent)
    await step('Confluent list prices', () =>
      saveEntries(confluent.id, {
        mode: 'replace',
        note: 'Demo prices (invented)',
        entries: [
          { sku: 'ecku-hour', name: 'Elastic capacity', service: 'Kafka', driver: 'eCKU-hours', unit: '{eCKU}.h', price: '0.14', currency: 'USD' },
          { sku: 'cku-hour', name: 'Dedicated capacity', service: 'Kafka', driver: 'CKU-hours', unit: '{CKU}.h', price: '2.10', currency: 'USD' },
          { sku: 'network-ingress', name: 'Data in', service: 'Kafka', driver: 'GB written', unit: 'GBy', price: '0.05', currency: 'USD' },
          {
            sku: 'network-egress',
            name: 'Data out',
            service: 'Kafka',
            driver: 'GB read',
            unit: 'GBy',
            price: '0.05',
            currency: 'USD',
            tiers: [
              { from: '0', price: '0.05' },
              { from: '10000', price: '0.03' },
            ],
          },
          { sku: 'storage', name: 'Storage', service: 'Kafka', driver: 'storage', unit: 'GBy.mo', price: '0.10', currency: 'USD' },
          {
            sku: 'partition-hour',
            name: 'Partitions',
            service: 'Kafka',
            driver: 'partition-hours',
            unit: '{partition}.h',
            price: '0.0015',
            currency: 'USD',
            included: '36500',
          },
          { sku: 'connector-task-hour', name: 'Connector tasks', service: 'Connect', driver: 'task-hours', unit: '{task}.h', price: '0.03', currency: 'USD' },
          {
            sku: 'connector-throughput',
            name: 'Connector throughput',
            service: 'Connect',
            driver: 'GB processed',
            unit: 'GBy',
            price: '0.025',
            currency: 'USD',
          },
        ],
      }),
    );
  const saas = await step('SaaS list book', () =>
    createBook({
      name: 'Invented Messaging AG price list (demo)',
      kind: 'list',
      provider: 'Invented Messaging AG',
      currency: 'EUR',
      description: INVENTED,
      reviewDays: 30,
    }),
  );
  if (saas)
    await step('SaaS prices', () =>
      saveEntries(saas.id, {
        mode: 'replace',
        note: 'Demo prices (invented)',
        entries: [
          {
            sku: 'api-request',
            name: 'API requests',
            service: 'Messaging API',
            driver: 'requests',
            unit: '{request}',
            price: '0.40',
            block: 1_000_000,
            currency: 'EUR',
            tiers: [
              { from: '0', price: '0.40' },
              { from: '100000000', price: '0.25' },
            ],
          },
          { sku: 'seat', name: 'Console seat', service: 'Console', driver: 'seats', unit: '{seat}.mo', charge: 'recurring', price: '12', currency: 'EUR' },
          { sku: 'setup', name: 'Onboarding', service: 'Services', driver: 'setup', unit: '1', charge: 'oneOff', price: '1500', currency: 'EUR' },
        ],
      }),
    );
  // ---- the demo Snowflake platform's contracted book, with a price change ahead ----
  const demoPlatform = (kind: string) =>
    db()
      .all<{ id: string; name: string }>('SELECT id, name FROM platforms WHERE kind = ? ORDER BY name', kind)
      .find((p) => p.name.endsWith('(demo)'));
  const snowflake = demoPlatform(SNOWFLAKE_KIND);
  if (snowflake) {
    const contracted =
      db().get<{ id: string }>("SELECT id FROM cost_price_books WHERE platform_id = ? AND kind = 'contracted'", snowflake.id) ??
      (await step('Snowflake contracted book', () =>
        createBook({
          name: `${snowflake.name} – contracted prices`,
          kind: 'contracted',
          provider: 'Snowflake',
          currency: 'USD',
          platformId: snowflake.id,
          description: `${INVENTED} The credit's price rises in four months.`,
          reviewDays: 180,
        }),
      ));
    const rise = `${shiftMonth(thisMonth(now), 4)}-01`;
    const dayBefore = new Date(Date.parse(`${rise}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    if (contracted)
      await step('Snowflake contracted prices', () =>
        saveEntries(contracted.id, {
          mode: 'replace',
          note: 'Demo contract (invented)',
          entries: [
            ...warehouses('compute-credit'),
            {
              sku: 'compute-credit',
              name: 'Compute credit',
              service: 'Compute',
              driver: 'credits',
              unit: '{credit}',
              price: '2.65',
              currency: 'USD',
              validTo: dayBefore,
            },
            {
              sku: 'compute-credit',
              name: 'Compute credit',
              service: 'Compute',
              driver: 'credits',
              unit: '{credit}',
              price: '2.85',
              currency: 'USD',
              validFrom: rise,
            },
            {
              sku: 'serverless-credit',
              name: 'Serverless credit',
              service: 'Serverless',
              driver: 'credits',
              unit: '{credit}',
              price: '1',
              creditSku: 'compute-credit',
            },
            { sku: 'storage', name: 'Storage', service: 'Storage', driver: 'storage', unit: 'TBy.mo', price: '20', currency: 'USD' },
          ],
        }),
      );
  }
  // ---- a manual exchange rate (estimates in EUR of USD prices) ----
  await step('exchange rate', () => setRate({ date: today(now), base: 'USD', quote: 'EUR', rate: '0.92' }));
  // ---- estimates ----
  const shop = db().get<{ id: string }>("SELECT id FROM services WHERE name = 'Online shop (demo)'");
  const pipeline = calcIds.get('snowflake-pipeline');
  if (shop && pipeline) {
    const e = await step('shop estimate', () =>
      createEstimate({
        title: 'Order analytics pipeline',
        description: 'Nightly and hourly loads of the order events into Snowflake (demo).',
        ownerKind: 'service',
        ownerId: shop.id,
        calculatorId: pipeline,
        currency: 'EUR',
        appliesFrom: thisMonth(now),
        inputs: [
          { key: 'size', value: 'M' },
          { key: 'minutes', value: { low: 8, expected: 12, high: 20 } },
          { key: 'runs', value: 24 },
          { key: 'serverless', value: 40 },
          { key: 'stored', value: { low: 800, expected: 1200, high: 2000 } },
        ],
        lines: [{ key: 'api', label: 'Order notifications', provider: 'Invented Messaging AG', sku: 'api-request', quantity: '30000000', unit: '{request}' }],
        adjustments: [{ line: 'storage', kind: 'percent', percent: '-10', reason: 'Negotiation target for the renewal' }],
      }),
    );
    if (e) {
      const fy = fiscalYearOf(thisMonth(now), startMonth());
      const keys = (await import('./estimates.js')).estimateProposals(e.id, fy).lines.map((l) => l.key);
      if (keys.length) await step('plan lines from the estimate', () => confirmEstimateProposals(e.id, { fiscalYear: fy, keys, confirmHidden: true }));
    }
  }
  const kafka = demoPlatform(CONFLUENT_KIND);
  const topic = calcIds.get('confluent-topic-cluster');
  if (kafka && topic)
    await step('platform estimate', () =>
      createEstimate({
        title: 'Orders topic',
        ownerKind: 'platform',
        ownerId: kafka.id,
        calculatorId: topic,
        currency: 'USD',
        inputs: [
          { key: 'ingress', value: { low: 0.5, expected: 1, high: 3 } },
          { key: 'fanOut', value: 3 },
          { key: 'partitions', value: 12 },
        ],
      }),
    );
  return n;
}
