import { complianceRoutes } from '../compliance/routes.js';
import { defineFeature } from './define.js';

/** Compliance and evidence: controls, access changes, reconciliation, person reviews, evidence packs. */
export default defineFeature({
  name: 'compliance',
  module: 'compliance',
  routes: [complianceRoutes],
});
