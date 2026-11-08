import { dutiesSection } from '../duties/report-section.js';
import { defineFeature } from './define.js';

/** Service duties: what has to be done for a service, and when. */
export default defineFeature({
  name: 'duties',
  reportSections: [dutiesSection],
});
