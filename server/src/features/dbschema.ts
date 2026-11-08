import { dbSchemaRoutes } from '../dbschema/routes.js';
import { dbSchemaApiRoutes } from '../dbschema/api-v1.js';
import { DBSCHEMA_MIGRATIONS } from '../migrations/dbschema.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Database schemas (#222): snapshots, changes, tbls import, export. */
export default defineFeature({
  name: 'dbschema',
  routes: [dbSchemaRoutes],
  apiV1: [dbSchemaApiRoutes],
  jobs: [
    // scheduled reads of the platforms that turned them on, snapshots of deleted ones removed
    every5Minutes('db-schemas', 15 * MINUTE, () => import('../dbschema/service.js').then((m) => m.runSchemaJob())),
  ],
  migrations: [DBSCHEMA_MIGRATIONS],
});
