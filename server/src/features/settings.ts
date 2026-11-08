import { settingsRoutes } from '../routes/settings.js';
import { moduleRoutes } from '../modules/routes.js';
import { defineFeature } from './define.js';

/** Settings of the instance and the module switches (ADR 0016). */
export default defineFeature({
  name: 'settings',
  routes: [settingsRoutes, moduleRoutes],
});
