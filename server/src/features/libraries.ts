import { libraryRoutes } from '../libraries/routes.js';
import { LIBRARY_MIGRATIONS } from '../migrations/libraries.js';
import { defineFeature } from './define.js';

/** Shared procedure libraries (#238, ADR 0014). */
export default defineFeature({
  name: 'libraries',
  module: 'libraries',
  routes: [libraryRoutes],
  migrations: [LIBRARY_MIGRATIONS],
});
