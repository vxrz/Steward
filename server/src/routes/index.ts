import type { FastifyInstance } from 'fastify';
import { dashboardRoutes } from './dashboards.js';
import { datasetPublisherRoutes } from './dataset-publishers.js';
import { opsRoutes } from './ops.js';
import { engineExtrasRoutes } from './engine-extras.js';
import { reportRoutes } from './reports.js';
import { triggerRoutes } from './triggers.js';
import { monitorRoutes } from '../monitors/routes.js';
import { recordRoutes } from '../records/routes.js';
import { catalogueRoutes } from '../catalogue/routes.js';
import { scopeRoutes } from '../auth/scope-routes.js';
import { backupRoutes } from '../backup/routes.js';
import { ticketRoutes } from '../tickets/routes.js';
import { dailySummaryRoutes } from '../notifications/summary-routes.js';
import { complianceRoutes } from '../compliance/routes.js';
import { migrationRoutes } from '../migration/routes.js';
import { dutyRoutes } from '../duties/routes.js';
import { scorecardRoutes } from '../scorecard/routes.js';
import { gatusRoutes } from '../gatus/routes.js';
import { changedetectionRoutes } from '../changedetection/routes.js';
import { credentialRoutes } from '../credentials/routes.js';
import { reportScheduleRoutes } from './report-schedules.js';
import { syncRoutes } from '../sync/routes.js';
import { authRoutes } from './auth.js';
import { userRoutes } from './users.js';
import { settingsRoutes } from './settings.js';
import { platformRoutes } from './platforms.js';
import { processRoutes } from './processes.js';
import { auditRoutes } from './audit.js';
import { dashboardHomeRoutes } from './dashboard-home.js';
import { demoSetupRoutes } from './demo-setup.js';
import { onboardingRoutes } from '../onboarding/routes.js';
import { duplicateRoutes } from '../duplicate/routes.js';
import { postmanExportRoutes } from '../export/routes.js';
import { assuranceRoutes } from './assurance.js';
import { aiRoutes } from '../ai/routes.js';
import { databaseRoutes } from '../dbms/routes.js';
import { dbSchemaRoutes } from '../dbschema/routes.js';
import { plantRoutes } from '../plant/routes.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await authRoutes(app);
  await userRoutes(app);
  await settingsRoutes(app);
  await platformRoutes(app);
  await processRoutes(app);
  await auditRoutes(app);
  await dashboardHomeRoutes(app);

  await dashboardRoutes(app);
  await datasetPublisherRoutes(app);
  await scopeRoutes(app);
  await opsRoutes(app);
  await engineExtrasRoutes(app);
  await reportRoutes(app);
  await triggerRoutes(app);
  await monitorRoutes(app);
  await gatusRoutes(app);
  // changedetection.io (#242): watches as components of the platform
  await changedetectionRoutes(app);
  await credentialRoutes(app);
  await reportScheduleRoutes(app);
  await recordRoutes(app);
  await catalogueRoutes(app);
  await backupRoutes(app);
  await dutyRoutes(app);
  await scorecardRoutes(app);
  await syncRoutes(app);
  await ticketRoutes(app);
  await dailySummaryRoutes(app);
  await complianceRoutes(app);
  await assuranceRoutes(app);
  await aiRoutes(app);
  await databaseRoutes(app);
  // database schemas (#222): snapshots, changes, tbls import, export
  await dbSchemaRoutes(app);
  await migrationRoutes(app);
  await onboardingRoutes(app);
  await duplicateRoutes(app);
  await postmanExportRoutes(app);
  // the plant registry module (#218): its routes answer 404 while it is off
  await plantRoutes(app);

  await demoSetupRoutes(app);
}
