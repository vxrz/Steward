import { recordsSection } from '../records/report-section.js';
import { defineFeature } from './define.js';

/** Records: change requests, decision records, incident reviews and living documents. */
export default defineFeature({
  name: 'records',
  reportSections: [recordsSection],
});
