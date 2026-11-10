import { complianceRoutes } from '../compliance/routes.js';
import { complianceApiRoutes } from '../compliance/api-v1.js';
import { correctiveRoutes } from '../compliance/corrective-routes.js';
import { correctiveApiRoutes, correctiveTools } from '../compliance/corrective-api.js';
import { proposalTools } from '../compliance/proposals.js';
import { capabilities } from '../auth/permissions.js';
import { currentUser } from '../auth/context.js';
import { COMPLIANCE_MIGRATIONS } from '../migrations/compliance.js';
import { PROPOSAL_MIGRATIONS } from '../migrations/proposals.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Compliance and evidence: controls, access changes, reconciliation, person reviews, evidence packs, corrective actions. */
export default defineFeature({
  name: 'compliance',
  module: 'compliance',
  routes: [complianceRoutes, correctiveRoutes],
  apiV1: [complianceApiRoutes, correctiveApiRoutes],
  jobs: [
    // corrective actions (ADR 0029): suggestions from Steward's events (hourly), reminders of actions, the dataset
    every5Minutes('corrective-actions', 5 * MINUTE, () => import('../compliance/corrective-jobs.js').then((m) => m.runCorrectiveJob())),
  ],
  datasets: [
    // its rows name every service: administrators and auditors, like costs.plans
    { name: 'compliance', owns: (id) => id.startsWith('compliance:'), visible: () => capabilities(currentUser()).viewAudit },
  ],
  mcpTools: [...proposalTools, ...correctiveTools],
  migrations: [COMPLIANCE_MIGRATIONS, PROPOSAL_MIGRATIONS],
});
