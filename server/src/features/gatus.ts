import { gatusRoutes } from '../gatus/routes.js';
import { GATUS_MIGRATIONS } from '../migrations/gatus.js';
import { defineFeature } from './define.js';

/** Gatus: endpoint status and availability as components of a platform. */
export default defineFeature({
  name: 'gatus',
  routes: [gatusRoutes],
  migrations: [GATUS_MIGRATIONS],
});
