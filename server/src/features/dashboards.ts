import { dashboardRoutes } from '../routes/dashboards.js';
import { datasetPublisherRoutes } from '../routes/dataset-publishers.js';
import { defineFeature } from './define.js';

/** Dashboards and the datasets processes publish to them. */
export default defineFeature({
  name: 'dashboards',
  routes: [dashboardRoutes, datasetPublisherRoutes],
});
