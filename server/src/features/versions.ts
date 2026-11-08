import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** The version watch and end of life of the tech stacks (#241). */
export default defineFeature({
  name: 'versions',
  module: 'versionWatch',
  jobs: [
    // end of life of the tech stacks: daily refresh from endoflife.date and messages to application owners
    every5Minutes('end-of-life', 15 * MINUTE, () => import('../catalogue/lifecycle.js').then((m) => m.runLifecycleJob())),
    // due lookups (once a day per source by default) and "new major release" messages
    every5Minutes('version-watch', 20 * MINUTE, () => import('../versions/service.js').then((m) => m.runVersionJob())),
  ],
});
