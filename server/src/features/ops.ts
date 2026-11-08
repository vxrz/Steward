import { opsRoutes } from '../routes/ops.js';
import { OPS_MIGRATIONS } from '../migrations/ops.js';
import { PERF_MIGRATIONS } from '../migrations/perf.js';
import { defineFeature, MINUTE } from './define.js';

/** Operations: the notification inbox, API tokens, retention clean-up. */
export default defineFeature({
  name: 'ops',
  routes: [opsRoutes],
  jobs: [
    // retention clean-up: one minute after the start, then daily (maintenance.ts)
    {
      name: 'cleanup',
      intervalMs: 24 * 60 * MINUTE,
      firstRunAfterMs: MINUTE,
      timeoutMs: 30 * MINUTE,
      run: () => import('../maintenance.js').then((m) => m.runCleanup()),
    },
  ],
  migrations: [OPS_MIGRATIONS, PERF_MIGRATIONS],
});
