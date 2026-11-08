import { versionRoutes } from '../versions/routes.js';
import { capabilities } from '../auth/permissions.js';
import { currentUser } from '../auth/context.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** The version watch and end of life of the tech stacks (#241). */
export default defineFeature({
  name: 'versions',
  module: 'versionWatch',
  routes: [versionRoutes],
  jobs: [
    // end of life of the tech stacks: daily refresh from endoflife.date and messages to application owners
    every5Minutes('end-of-life', 15 * MINUTE, () => import('../catalogue/lifecycle.js').then((m) => m.runLifecycleJob())),
    // due lookups (once a day per source by default) and "new major release" messages
    every5Minutes('version-watch', 20 * MINUTE, () => import('../versions/service.js').then((m) => m.runVersionJob())),
  ],
  datasets: [
    // "Component versions" names every application, also those of teams others may not see
    { name: 'versions', owns: (id) => id === 'catalogue:versions', visible: () => capabilities(currentUser()).viewAudit },
  ],
});
