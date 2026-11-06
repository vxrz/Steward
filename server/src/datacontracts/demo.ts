import fs from 'node:fs';
import path from 'node:path';
import { DATA_CONTRACT_SERVICE_KIND, DATABASE_KIND } from '@sm/shared';
import { config } from '../config.js';
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

/** The demo's contracts: the example library's files (examples/data-contracts). */
const example = (file: string) => fs.readFileSync(path.join(config.examplesDir, 'data-contracts', file), 'utf8');

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
  const made = [example('shop-orders.odcs.yaml'), example('shop-customers.odcs.yaml')].map((yaml, i) =>
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
