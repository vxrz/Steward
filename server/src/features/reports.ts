import { availabilitySection, gatusSection, credentialsSection, runsSection } from '../reports/builtin-sections.js';
import { defineFeature } from './define.js';

/** Reports: run reports, summaries and scheduled reports, with the built-in sections of scheduled reports. */
export default defineFeature({
  name: 'reports',
  reportSections: [availabilitySection, gatusSection, credentialsSection, runsSection],
});
