import { scorecardSection } from '../scorecard/report-section.js';
import { defineFeature } from './define.js';

/** The service scorecard and availability objectives. */
export default defineFeature({
  name: 'scorecard',
  module: 'scorecard',
  reportSections: [scorecardSection],
});
