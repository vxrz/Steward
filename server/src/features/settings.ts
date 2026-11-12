import { settingsRoutes } from '../routes/settings.js';
import { moduleRoutes } from '../modules/routes.js';
import { MODULE_MIGRATIONS } from '../migrations/modules.js';
import { defineFeature } from './define.js';

/** Settings of the instance, the module switches (ADR 0016) and module access (ADR 0034). */
export default defineFeature({
  name: 'settings',
  routes: [settingsRoutes, moduleRoutes],
  migrations: [MODULE_MIGRATIONS],
});
