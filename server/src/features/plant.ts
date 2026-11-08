import { plantRoutes } from '../plant/routes.js';
import { defineFeature } from './define.js';

/** The plant registry (#218, opt-in): sites, assets, their network and map. Its routes answer 404 while it is off. */
export default defineFeature({
  name: 'plant',
  module: 'plant',
  routes: [plantRoutes],
});
