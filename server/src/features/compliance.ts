import { complianceRoutes } from '../compliance/routes.js';
import { complianceApiRoutes } from '../compliance/api-v1.js';
import { proposalTools } from '../compliance/proposals.js';
import { defineFeature } from './define.js';

/** Compliance and evidence: controls, access changes, reconciliation, person reviews, evidence packs. */
export default defineFeature({
  name: 'compliance',
  module: 'compliance',
  routes: [complianceRoutes],
  apiV1: [complianceApiRoutes],
  mcpTools: [...proposalTools],
});
