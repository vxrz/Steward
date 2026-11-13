import { dashboardRoutes } from '../routes/dashboards.js';
import { datasetPublisherRoutes } from '../routes/dataset-publishers.js';
import { defineFeature } from './define.js';
import { dashboardShareKind } from '../auth/item-shares.js';
import { dashboardAccess } from '../dashboards/service.js';

/** Dashboards and the datasets processes publish to them. */
export default defineFeature({
  name: 'dashboards',
  shareKinds: [dashboardShareKind((u, r) => dashboardAccess(u, r).permissions)],
  routes: [dashboardRoutes, datasetPublisherRoutes],
});
