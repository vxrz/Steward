import { recordRoutes } from '../records/routes.js';
import { recordApiRoutes } from '../records/api-v1.js';
import { recordsSection } from '../records/report-section.js';
import { RECORD_MIGRATIONS } from '../migrations/records.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';
import { recordShareKind } from '../auth/item-shares.js';

/** Records: change requests, decision records, incident reviews and living documents. */
export default defineFeature({
  name: 'records',
  shareKinds: [recordShareKind()],
  routes: [recordRoutes],
  apiV1: [(get, app) => recordApiRoutes(app, get)],
  jobs: [
    // living documents: periodic review reminders (records/documents.ts)
    every5Minutes('document-reviews', 2 * MINUTE, () => import('../records/documents.js').then((m) => m.checkDocumentReviews())),
    // measures from incident reviews: due and overdue reminders (records/reviews.ts)
    every5Minutes('measure-reminders', 2 * MINUTE, () => import('../records/reviews.js').then((m) => m.runMeasureJob())),
  ],
  reportSections: [recordsSection],
  migrations: [RECORD_MIGRATIONS],
});
