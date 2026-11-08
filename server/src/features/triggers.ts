import { triggerRoutes } from '../routes/triggers.js';
import { defineFeature } from './define.js';

/** Webhook triggers that start runs. */
export default defineFeature({
  name: 'triggers',
  routes: [triggerRoutes],
});
