import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Notifications: channels, preferences, quiet hours, digests and daily summaries. */
export default defineFeature({
  name: 'notifications',
  jobs: [
    // dashboard data older than its freshness limit (notifications/service.ts)
    every5Minutes('stale-datasets', 2 * MINUTE, () => import('../notifications/service.js').then((m) => m.checkStaleDatasets())),
    // daily summaries of the people who turned them on (notifications/summary.ts)
    every5Minutes('daily-summary', 10 * MINUTE, () => import('../notifications/summary.js').then((m) => m.runDailySummaries())),
    // quiet hours and digests (ADR 0012): the catch-up at the end of quiet hours, digests when they are due
    every5Minutes('notification-outbox', 10 * MINUTE, () => import('../notifications/outbox.js').then((m) => m.runOutbox())),
    // paused messages of schedules, triggers and monitor outputs: one "still failing" message when a pause ends (#139)
    every5Minutes('pause-ends', 2 * MINUTE, () => import('../notifications/pause.js').then((m) => m.checkPauseEnds())),
  ],
});
