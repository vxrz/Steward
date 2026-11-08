import { dutyRoutes } from '../duties/routes.js';
import { dutyApiRoutes } from '../duties/api-v1.js';
import { dutiesSection } from '../duties/report-section.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Service duties: what has to be done for a service, and when. */
export default defineFeature({
  name: 'duties',
  routes: [dutyRoutes],
  apiV1: [dutyApiRoutes],
  jobs: [
    // store and close periods, reminders and "missed" messages (duties/jobs.ts)
    every5Minutes('duties', 5 * MINUTE, () => import('../duties/jobs.js').then((m) => m.runDutyJob())),
  ],
  reportSections: [dutiesSection],
});
