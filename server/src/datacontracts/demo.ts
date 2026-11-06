import { DATA_CONTRACT_SERVICE_KIND, DATABASE_KIND } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { createPlatform } from '../platforms/service.js';
import { PRESETS } from '../platforms/presets.js';
import { DEMO_DATACONTRACT } from '../mock/mockDataContract.js';
import { createContract } from './service.js';
import { runContractTest } from './testing.js';

/**
 * The demo's data contracts (#221): the simulated data contract service (mock/mockDataContract.ts) and two contracts
 * of the demo shop database – "Shop orders", which holds, and "Shop customers", which promises a column the table
 * does not have, so its test fails. Both are tested once.
 */

const SERVICE = 'Data contract service (demo)';

const ORDERS = `apiVersion: v3.0.2
kind: DataContract
id: shop-orders
name: Shop orders
version: 1.0.0
status: active
domain: sales
description:
  purpose: Orders of the web shop for invoicing and the sales dashboards
  usage: Read-only; one row per order
  limitations: Orders of the last two years
servers:
  - server: production
    type: postgresql
    host: postgres.demo.invalid
    port: 5432
    database: shop
    schema: public
schema:
  - name: orders
    physicalName: public.orders
    physicalType: table
    description: One order of a customer
    properties:
      - name: id
        logicalType: integer
        physicalType: bigint
        primaryKey: true
        primaryKeyPosition: 1
        required: true
        unique: true
      - name: customer_id
        logicalType: integer
        physicalType: integer
        required: true
      - name: status
        logicalType: string
        physicalType: character varying(20)
        required: true
        logicalTypeOptions:
          maxLength: 20
      - name: total
        logicalType: number
        physicalType: numeric(12,2)
        quality:
          - rule: nullValues
            mustBeLessThan: 5
            unit: percent
      - name: ordered_at
        logicalType: date
        physicalType: timestamp with time zone
        required: true
team:
  - username: dana
    role: owner
slaProperties:
  - property: latency
    value: 4
    unit: h
`;

const CUSTOMERS = `apiVersion: v3.0.2
kind: DataContract
id: shop-customers
name: Shop customers
version: 0.3.0
status: proposed
domain: sales
description:
  purpose: People and companies that order in the web shop
servers:
  - server: production
    type: postgresql
    host: postgres.demo.invalid
    port: 5432
    database: shop
    schema: public
schema:
  - name: customers
    physicalName: public.customers
    physicalType: table
    properties:
      - name: id
        logicalType: integer
        required: true
      - name: email
        logicalType: string
        required: true
        unique: true
      - name: name
        logicalType: string
        required: true
      - name: phone
        logicalType: string
        description: Promised to the call centre – not in the table yet
      - name: country
        logicalType: string
        logicalTypeOptions:
          maxLength: 2
`;

/** The simulated service and the two contracts, once (called by the demo setup, as the administrator loading it). */
export async function seedContractDemo(base: string): Promise<number> {
  let service = db().get<{ id: string }>('SELECT id FROM platforms WHERE name = ?', SERVICE)?.id;
  if (!service) {
    const preset = PRESETS.find((p) => p.kind === DATA_CONTRACT_SERVICE_KIND)!;
    service = createPlatform({
      name: SERVICE,
      kind: DATA_CONTRACT_SERVICE_KIND,
      environment: 'demo',
      description:
        'Simulated datacontract CLI API (datacontract api) served by the built-in mock: it "tests" contracts against the demo shop database. See docs/DATA-CONTRACTS.md.',
      baseUrl: `${base}/datacontract`,
      config: { ...preset.config, http: { ...preset.config.http, proxy: 'none' } },
      secrets: { apiKey: DEMO_DATACONTRACT.apiKey },
    }).id;
  }
  const shop = db().get<{ id: string }>("SELECT id FROM platforms WHERE name = 'Shop database (demo)' AND kind = ?", DATABASE_KIND)?.id;
  if (!shop || db().get("SELECT 1 FROM data_contracts WHERE contract_key IN ('shop-orders', 'shop-customers')")) return 0;
  const app = db().get<{ id: string }>("SELECT id FROM applications WHERE name LIKE '%hop%' ORDER BY name LIMIT 1")?.id;
  const made = [ORDERS, CUSTOMERS].map((yaml, i) =>
    createContract({
      yaml,
      note: 'Demo data',
      settings: { servicePlatformId: service, testServer: 'production', requireChangeRecord: i === 0 },
      links: [
        { kind: 'server', targetId: shop, detail: 'production' },
        {
          kind: 'table',
          targetKind: 'platform',
          targetId: shop,
          detail: i === 0 ? 'public.orders' : 'public.customers',
          schema: i === 0 ? 'orders' : 'customers',
        },
        ...(app ? [{ kind: 'application' as const, targetId: app }] : []),
      ],
    }),
  );
  // a first test of each (the demo service is served by this server)
  for (const c of made)
    await runContractTest(c.id, { via: 'ui' }).catch((err) =>
      logger.warn({ err: (err as Error).message, contract: c.key }, 'demo data contract test did not run'),
    );
  return made.length;
}
