import { postmanExportRoutes } from '../export/routes.js';
import { defineFeature } from './define.js';

/** Exports of platforms as Postman collections. */
export default defineFeature({
  name: 'export',
  routes: [postmanExportRoutes],
});
