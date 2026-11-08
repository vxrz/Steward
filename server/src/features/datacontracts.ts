import { dataContractRoutes } from '../datacontracts/routes.js';
import { contractsSection } from '../datacontracts/report-section.js';
import { defineFeature } from './define.js';

/** Data contracts (#221): ODCS v3 versions, links and tests. */
export default defineFeature({
  name: 'datacontracts',
  module: 'dataContracts',
  routes: [dataContractRoutes],
  reportSections: [contractsSection],
});
