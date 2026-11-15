import { supportRoutes } from '../support/routes.js';
import { SUPPORT_MIGRATIONS } from '../migrations/support.js';
import { defineFeature } from './define.js';

/**
 * Support channels, support levels and guides (0.26.0, ADR 0039 parts 4–8): core, always on. The level catalogue is
 * here; data products, services and applications carry their channels, level and guides on their own routes.
 */
export default defineFeature({
  name: 'support',
  routes: [supportRoutes],
  migrations: [SUPPORT_MIGRATIONS],
});
