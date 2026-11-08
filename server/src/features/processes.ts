import { defineFeature, MINUTE } from './define.js';

/** Processes, their runs and the run engine: schedules, manual steps, debugging, the step palette. */
export default defineFeature({
  name: 'processes',
  jobs: [
    // the scheduler's "still running" mark: fires after the last mark count as missed at the next start (scheduler.ts)
    { name: 'scheduler-heartbeat', intervalMs: MINUTE, timeoutMs: MINUTE, run: () => import('../scheduler.js').then((m) => m.recordAlive()) },
  ],
});
