import { demoSetupRoutes } from '../routes/demo-setup.js';
import { defineFeature } from './define.js';

/** Demo mode: the demo set-up (last: it may use every other feature). */
export default defineFeature({
  name: 'demo',
  routes: [demoSetupRoutes],
});
