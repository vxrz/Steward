import { costRoutes } from '../costs/routes.js';
import { costApiRoutes } from '../costs/api-v1.js';
import { costsSection } from '../costs/report-section.js';
import { capabilities } from '../auth/permissions.js';
import { currentUser } from '../auth/context.js';
import { COSTS_MIGRATIONS } from '../migrations/costs.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Costs of platforms, services and applications, with budgets (#226). */
export default defineFeature({
  name: 'costs',
  module: 'costs',
  routes: [costRoutes],
  apiV1: [costApiRoutes],
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
