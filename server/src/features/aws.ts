import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** AWS accounts of applications. */
export default defineFeature({
  name: 'aws',
  jobs: [every5Minutes('aws', 30 * MINUTE, () => import('../aws/service.js').then((m) => m.runAwsJob()))],
});
