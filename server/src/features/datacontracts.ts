import { dataContractRoutes } from '../datacontracts/routes.js';
import { contractsSection } from '../datacontracts/report-section.js';
import { DATA_CONTRACT_MIGRATIONS } from '../migrations/datacontracts.js';
import { dataContractTools } from '../datacontracts/mcp.js';
import { defineFeature } from './define.js';

/** Data contracts (#221): ODCS v3 versions, links and tests. */
export default defineFeature({
  name: 'datacontracts',
  module: 'dataContracts',
  routes: [dataContractRoutes],
  reportSections: [contractsSection],
  // 0.22.0 (ADR 0036 part 14): read tools for AI assistants; not listed while the module is off
  mcpTools: dataContractTools,
  migrations: [DATA_CONTRACT_MIGRATIONS],
});
