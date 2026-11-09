import { databaseRoutes } from '../dbms/routes.js';
import { defineFeature } from './define.js';

/** Database platforms: the query step and its connections. */
export default defineFeature({
  name: 'dbms',
  routes: [databaseRoutes],
});
