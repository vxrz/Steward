import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Dependency-Track projects of applications. */
export default defineFeature({
  name: 'dtrack',
  jobs: [every5Minutes('dependency-track', 30 * MINUTE, () => import('../dtrack/service.js').then((m) => m.runDtrackJob()))],
});
