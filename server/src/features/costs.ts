import { costRoutes } from '../costs/routes.js';
import { priceRoutes } from '../costs/price-routes.js';
import { costApiRoutes } from '../costs/api-v1.js';
import { priceApiRoutes } from '../costs/price-api.js';
import { costPriceTools } from '../costs/mcp.js';
import { costsSection } from '../costs/report-section.js';
import { priceBookShareKind } from '../costs/price-books.js';
import { capabilities } from '../auth/permissions.js';
import { currentUser } from '../auth/context.js';
import { COSTS_MIGRATIONS } from '../migrations/costs.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Costs of platforms, services and applications, with budgets (#226). */
export default defineFeature({
  name: 'costs',
  module: 'costs',
  routes: [costRoutes, priceRoutes],
  apiV1: [costApiRoutes, priceApiRoutes],
  // price books, calculators, estimates and the dry run (0.21.0, ADR 0035)
  mcpTools: costPriceTools,
  // price books share by level (0.23.0, ADR 0035 part 4: internal rate cards published to other teams)
  shareKinds: [priceBookShareKind],
  jobs: [
    // AWS, Snowflake and Confluent once a day, AI gateways hourly; budgets and their notices
    every5Minutes('costs', 20 * MINUTE, () => import('../costs/jobs.js').then((m) => m.runCostsJob())),
  ],
  reportSections: [costsSection],
  datasets: [
    // its rows name every service, application, team and platform: administrators and auditors
    { name: 'costs', owns: (id) => id.startsWith('costs:'), visible: () => capabilities(currentUser()).viewAudit },
  ],
  migrations: [COSTS_MIGRATIONS],
});
