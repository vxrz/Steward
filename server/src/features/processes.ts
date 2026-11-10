import { processRoutes } from '../routes/processes.js';
import { engineExtrasRoutes } from '../routes/engine-extras.js';
import { debugRoutes } from '../routes/debug.js';
import { ENGINE_MIGRATIONS } from '../migrations/engine.js';
import { MANUAL_STEP_MIGRATIONS } from '../migrations/manual-steps.js';
import { RUNTIME_MIGRATIONS } from '../migrations/runtime.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Processes, their runs and the run engine: schedules, manual steps, debugging, the step palette. */
export default defineFeature({
  name: 'processes',
  routes: [processRoutes, engineExtrasRoutes, debugRoutes],
  jobs: [
    // the scheduler's "still running" mark: fires after the last mark count as missed at the next start (scheduler.ts)
    { name: 'scheduler-heartbeat', intervalMs: MINUTE, timeoutMs: MINUTE, run: () => import('../scheduler.js').then((m) => m.recordAlive()) },
    // start approvals of privileged runs that nobody decided within 24 hours: the run is cancelled (0.14.0, ADR 0009 step 4)
    every5Minutes('start-approvals', MINUTE, () => import('../engine/index.js').then((m) => m.expireStartApprovals())),
  ],
  migrations: [ENGINE_MIGRATIONS, MANUAL_STEP_MIGRATIONS, RUNTIME_MIGRATIONS],
});
