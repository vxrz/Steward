import { monitorRoutes } from '../monitors/routes.js';
import { monitorApiRoutes } from '../monitors/api-v1.js';
import { monitorDatasetVisible } from '../monitors/datasets.js';
import { MONITOR_MIGRATIONS } from '../migrations/monitors.js';
import { defineFeature } from './define.js';

/** Monitors and their checks, outputs and status pages. */
export default defineFeature({
  name: 'monitors',
  routes: [monitorRoutes],
  apiV1: [(get, app) => monitorApiRoutes(app, get)],
  datasets: [{ name: 'monitors', owns: (id) => id.startsWith('monitor:'), visible: (id) => monitorDatasetVisible(id) ?? false }],
  migrations: [MONITOR_MIGRATIONS],
});
