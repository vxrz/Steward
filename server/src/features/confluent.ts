import { confluentRoutes } from '../confluent/routes.js';
import { CONFLUENT_MIGRATIONS } from '../migrations/confluent.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Confluent Cloud platforms (#123): environments, clusters, Schema Registry, service accounts, API keys, connectors – read-only. */
export default defineFeature({
  name: 'confluent',
  routes: [confluentRoutes],
  jobs: [
    // every hour (CONFLUENT_READ_LIMITS.refreshMinutes)
    every5Minutes('confluent', 15 * MINUTE, () => import('../confluent/service.js').then((m) => m.runConfluentJob())),
  ],
  migrations: [CONFLUENT_MIGRATIONS],
});
