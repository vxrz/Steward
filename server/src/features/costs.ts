import { costRoutes } from '../costs/routes.js';
import { costsSection } from '../costs/report-section.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Costs of platforms, services and applications, with budgets (#226). */
export default defineFeature({
  name: 'costs',
  module: 'costs',
  routes: [costRoutes],
  jobs: [
    // AWS, Snowflake and Confluent once a day, AI gateways hourly; budgets and their notices
    every5Minutes('costs', 20 * MINUTE, () => import('../costs/jobs.js').then((m) => m.runCostsJob())),
  ],
  reportSections: [costsSection],
});
