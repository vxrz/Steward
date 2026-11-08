import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Connected platforms: their connection, credentials, specifications and documents. */
export default defineFeature({
  name: 'platforms',
  jobs: [
    // periodic connection tests of the platforms that turned them on (platforms/health.ts)
    every5Minutes('platform-health', 5 * MINUTE, () => import('../platforms/health.js').then((m) => m.runPlatformHealthJob())),
  ],
});
