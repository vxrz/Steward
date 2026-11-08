import { contractsSection } from '../datacontracts/report-section.js';
import { defineFeature } from './define.js';

/** Data contracts (ODCS v3): versions, links and tests. */
export default defineFeature({
  name: 'datacontracts',
  module: 'dataContracts',
  reportSections: [contractsSection],
});
