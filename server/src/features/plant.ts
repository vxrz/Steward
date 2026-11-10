import { plantRoutes } from '../plant/routes.js';
import { plantApiRoutes } from '../plant/api-v1.js';
import { PLANT_LINK_KINDS } from '../plant/links.js';
import { PLANT_MIGRATIONS } from '../migrations/plant.js';
import { plantReadTools } from '../plant/mcp.js';
import { plantProposalTools } from '../plant/proposals.js';
import { MINUTE, defineFeature } from './define.js';

/** The plant registry (#218, opt-in): sites, assets, their network and map. Its routes answer 404 while it is off. */
export default defineFeature({
  name: 'plant',
  module: 'plant',
  routes: [plantRoutes],
  apiV1: [plantApiRoutes],
  linkKinds: [...PLANT_LINK_KINDS],
  // 0.12.0: read tools and proposals for AI assistants (docs/MCP.md); not listed while the module is off
  mcpTools: [...plantReadTools, ...plantProposalTools],
  migrations: [PLANT_MIGRATIONS],
  jobs: [
    // 0.13.0 (ADR 0020): open change sets expire; closed ones and the history of removed entries go after their retention
    // (plant settings since 0.15.0: 90 days and 3 years by default), baselines beyond the last ones of an entry; rows
    // written before 0.15.0 are compacted, a bounded number per run
    {
      name: 'plant-changes',
      intervalMs: 24 * 60 * MINUTE,
      firstRunAfterMs: 10 * MINUTE,
      timeoutMs: 10 * MINUTE,
      run: () => import('../plant/changesets/core.js').then((m) => m.changeSetUpkeep()),
    },
  ],
});
