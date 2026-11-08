import { plantRoutes } from '../plant/routes.js';
import { plantApiRoutes } from '../plant/api-v1.js';
import { PLANT_LINK_KINDS } from '../plant/links.js';
import { defineFeature } from './define.js';

/** The plant registry (#218, opt-in): sites, assets, their network and map. Its routes answer 404 while it is off. */
export default defineFeature({
  name: 'plant',
  module: 'plant',
  routes: [plantRoutes],
  apiV1: [plantApiRoutes],
  linkKinds: [...PLANT_LINK_KINDS],
});
