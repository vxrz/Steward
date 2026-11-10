import { postmanExportRoutes } from '../export/routes.js';
import { exportJobRoutes } from '../export/job-routes.js';
import { defineFeature } from './define.js';

/** Exports of platforms as Postman collections, and scheduled exports of readable files to S3 (0.16.0, ADR 0027). */
export default defineFeature({
  name: 'export',
  routes: [postmanExportRoutes, exportJobRoutes],
});
