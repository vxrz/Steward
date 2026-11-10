import { plantRoutes } from '../plant/routes.js';
import { plantApiRoutes } from '../plant/api-v1.js';
import { advisoryApiRoutes } from '../plant/advisories/api-v1.js';
import { PLANT_LINK_KINDS } from '../plant/links.js';
import { PLANT_MIGRATIONS } from '../migrations/plant.js';
import { plantReadTools } from '../plant/mcp.js';
import { plantProposalTools } from '../plant/proposals.js';
import { advisoryTools } from '../plant/advisories/mcp.js';
import { MINUTE, defineFeature, every5Minutes } from './define.js';

/** The plant registry (#218, opt-in): sites, assets, their network and map. Its routes answer 404 while it is off. */
export default defineFeature({
  name: 'plant',
  module: 'plant',
  routes: [plantRoutes],
  apiV1: [plantApiRoutes, advisoryApiRoutes],
  linkKinds: [...PLANT_LINK_KINDS],
  // 0.12.0: read tools and proposals for AI assistants (docs/MCP.md); not listed while the module is off
  // 0.14: security advisories affecting a site
  mcpTools: [...plantReadTools, ...plantProposalTools, ...advisoryTools],
  migrations: [PLANT_MIGRATIONS],
  jobs: [
    // 0.13.0 (ADR 0020): open change sets expire; closed ones go after 90 days, the history of removed entries after 3 years
    {
      name: 'plant-changes',
      intervalMs: 24 * 60 * MINUTE,
      firstRunAfterMs: 10 * MINUTE,
      timeoutMs: 10 * MINUTE,
      run: () => import('../plant/changesets/core.js').then((m) => m.cleanUpChangeSets()),
    },
    // 0.14: security advisories – matches after plant changes, and the configured sources that are due (none by default)
    every5Minutes('plant-advisories', 30 * MINUTE, () => import('../plant/advisories/fetch.js').then((m) => m.runAdvisoryJob())),
  ],
});
