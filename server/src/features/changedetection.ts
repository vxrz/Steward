import { changedetectionRoutes } from '../changedetection/routes.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** changedetection.io: watches as components of a platform (#242). */
export default defineFeature({
  name: 'changedetection',
  module: 'changedetection',
  routes: [changedetectionRoutes],
  jobs: [
    // the watches of the platforms read before, every hour as the person who read them last
    every5Minutes('changedetection', 10 * MINUTE, () => import('../changedetection/service.js').then((m) => m.runChangedetectionJob())),
  ],
});
