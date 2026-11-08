import { triggerRoutes } from '../routes/triggers.js';
import { TRIGGER_MIGRATIONS } from '../migrations/triggers.js';
import { defineFeature } from './define.js';

/** Webhook triggers that start runs. */
export default defineFeature({
  name: 'triggers',
  routes: [triggerRoutes],
  migrations: [TRIGGER_MIGRATIONS],
});
