import { scorecardRoutes } from '../scorecard/routes.js';
import { scorecardApiRoutes } from '../scorecard/api-v1.js';
import { scorecardSection } from '../scorecard/report-section.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** The service scorecard and availability objectives. */
export default defineFeature({
  name: 'scorecard',
  module: 'scorecard',
  routes: [scorecardRoutes],
  apiV1: [scorecardApiRoutes],
  jobs: [
    // Prometheus figures first (#110), then hourly samples, breaches, daily snapshots
    every5Minutes('scorecard', 10 * MINUTE, async () => {
      let promError: unknown;
      await import('../scorecard/objectives.js').then((o) => o.readPromObjectives()).catch((err) => (promError = err));
      // the scorecard still runs on the figures it has
      await import('../scorecard/jobs.js').then((m) => m.runScorecardJob());
      if (promError) throw new Error(`Reading Prometheus figures for objectives failed: ${(promError as Error)?.message ?? promError}`);
    }),
  ],
  reportSections: [scorecardSection],
});
