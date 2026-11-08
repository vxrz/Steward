import { duplicateRoutes } from '../duplicate/routes.js';
import { defineFeature } from './define.js';

/** Finding duplicates. */
export default defineFeature({
  name: 'duplicate',
  routes: [duplicateRoutes],
});
