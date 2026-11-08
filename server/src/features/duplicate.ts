import { duplicateRoutes } from '../duplicate/routes.js';
import { DUPLICATE_MIGRATIONS } from '../migrations/duplicates.js';
import { defineFeature } from './define.js';

/** Finding duplicates. */
export default defineFeature({
  name: 'duplicate',
  routes: [duplicateRoutes],
  migrations: [DUPLICATE_MIGRATIONS],
});
