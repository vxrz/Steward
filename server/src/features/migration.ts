import { migrationRoutes } from '../migration/routes.js';
import { defineFeature } from './define.js';

/** Moving an instance: migration packages (export and import). */
export default defineFeature({
  name: 'migration',
  routes: [migrationRoutes],
});
