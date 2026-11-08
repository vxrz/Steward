import { monitorRoutes } from '../monitors/routes.js';
import { monitorApiRoutes } from '../monitors/api-v1.js';
import { defineFeature } from './define.js';

/** Monitors and their checks, outputs and status pages. */
export default defineFeature({
  name: 'monitors',
  routes: [monitorRoutes],
  apiV1: [(get, app) => monitorApiRoutes(app, get)],
});
