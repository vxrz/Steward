import { syncRoutes } from '../sync/routes.js';
import { defineFeature, MINUTE } from './define.js';

/** Git sync of processes and dashboards. */
export default defineFeature({
  name: 'sync',
  routes: [syncRoutes],
  jobs: [
    // scheduled Git sync fetches: once a minute, every source whose interval has passed (sync/engine.ts)
    { name: 'git-sync', intervalMs: MINUTE, timeoutMs: 15 * MINUTE, run: () => import('../sync/engine.js').then((m) => m.tick()) },
  ],
});
