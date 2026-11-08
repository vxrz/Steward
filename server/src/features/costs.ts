import { costsSection } from '../costs/report-section.js';
import { defineFeature } from './define.js';

/** Costs of platforms, services and applications, with budgets. */
export default defineFeature({
  name: 'costs',
  module: 'costs',
  reportSections: [costsSection],
});
