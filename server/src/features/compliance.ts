import { complianceRoutes } from '../compliance/routes.js';
import { complianceApiRoutes } from '../compliance/api-v1.js';
import { correctiveRoutes } from '../compliance/corrective-routes.js';
import { correctiveApiRoutes, correctiveTools } from '../compliance/corrective-api.js';
import { soaRoutes } from '../compliance/soa-routes.js';
import { soaApiRoutes, soaTools } from '../compliance/soa-api.js';
import { ismsSection } from '../compliance/isms-report-section.js';
import { proposalTools } from '../compliance/proposals.js';
import { capabilities } from '../auth/permissions.js';
import { currentUser } from '../auth/context.js';
import { COMPLIANCE_MIGRATIONS } from '../migrations/compliance.js';
import { PROPOSAL_MIGRATIONS } from '../migrations/proposals.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Compliance and evidence: controls, access changes, reconciliation, person reviews, evidence packs, corrective actions, the statement of applicability with the responsibility matrix, the ISMS summary. */
export default defineFeature({
  name: 'compliance',
  module: 'compliance',
  routes: [complianceRoutes, correctiveRoutes, soaRoutes],
  apiV1: [complianceApiRoutes, correctiveApiRoutes, soaApiRoutes],
  // the ISMS summary of scheduled reports (ADR 0029 part 4): figures of the parts above, no state of its own
  reportSections: [ismsSection],
  jobs: [
    // corrective actions (ADR 0029): suggestions from Steward's events (hourly), reminders of actions, the dataset
    every5Minutes('corrective-actions', 5 * MINUTE, () => import('../compliance/corrective-jobs.js').then((m) => m.runCorrectiveJob())),
    // statement of applicability (ADR 0029 part 2): the dataset compliance.soa, at most hourly
    every5Minutes('soa', 5 * MINUTE, () => import('../compliance/soa.js').then((m) => m.runSoaJob())),
  ],
  datasets: [
    // its rows name every service: administrators and auditors, like costs.plans
    { name: 'compliance', owns: (id) => id.startsWith('compliance:'), visible: () => capabilities(currentUser()).viewAudit },
  ],
  mcpTools: [...proposalTools, ...correctiveTools, ...soaTools],
  migrations: [COMPLIANCE_MIGRATIONS, PROPOSAL_MIGRATIONS],
});
