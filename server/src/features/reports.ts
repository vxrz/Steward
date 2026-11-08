import { reportRoutes } from '../routes/reports.js';
import { reportScheduleRoutes } from '../routes/report-schedules.js';
import { availabilitySection, gatusSection, credentialsSection, runsSection } from '../reports/builtin-sections.js';
import { REPORT_MIGRATIONS } from '../migrations/reports.js';
import { REPORT_SCHEDULE_MIGRATIONS } from '../migrations/report-schedules.js';
import { defineFeature } from './define.js';

/** Reports: run reports, summaries and scheduled reports, with the built-in sections of scheduled reports. */
export default defineFeature({
  name: 'reports',
  routes: [reportRoutes, reportScheduleRoutes],
  reportSections: [availabilitySection, gatusSection, credentialsSection, runsSection],
  migrations: [REPORT_MIGRATIONS, REPORT_SCHEDULE_MIGRATIONS],
});
