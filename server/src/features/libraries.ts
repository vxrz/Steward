import { libraryRoutes } from '../libraries/routes.js';
import { defineFeature } from './define.js';

/** Shared procedure libraries (#238, ADR 0014). */
export default defineFeature({
  name: 'libraries',
  module: 'libraries',
  routes: [libraryRoutes],
});
