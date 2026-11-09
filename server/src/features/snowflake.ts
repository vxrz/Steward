import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Snowflake accounts of applications. */
export default defineFeature({
  name: 'snowflake',
  jobs: [every5Minutes('snowflake', 30 * MINUTE, () => import('../snowflake/service.js').then((m) => m.runSnowflakeJob()))],
});
