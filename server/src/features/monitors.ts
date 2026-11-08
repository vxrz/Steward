import { monitorRoutes } from '../monitors/routes.js';
import { defineFeature } from './define.js';

/** Monitors and their checks, outputs and status pages. */
export default defineFeature({
  name: 'monitors',
  routes: [monitorRoutes],
});
