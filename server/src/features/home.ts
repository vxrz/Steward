import { dashboardHomeRoutes } from '../routes/dashboard-home.js';
import { defineFeature } from './define.js';

/** The start page. */
export default defineFeature({
  name: 'home',
  routes: [dashboardHomeRoutes],
});
