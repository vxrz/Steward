import { aiSection } from '../ai/report-section.js';
import { defineFeature } from './define.js';

/** AI models: the AI step, gateways, budgets and the usage log. */
export default defineFeature({
  name: 'ai',
  module: 'ai',
  reportSections: [aiSection],
});
