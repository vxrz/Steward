import { backupRoutes } from '../backup/routes.js';
import { defineFeature } from './define.js';

/** Backups of the database and the data directory. */
export default defineFeature({
  name: 'backup',
  routes: [backupRoutes],
});
