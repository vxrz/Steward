import { contactRoutes } from '../contacts/routes.js';
import { CONTACTS_MIGRATIONS } from '../migrations/contacts.js';
import { defineFeature } from './define.js';

/**
 * The contacts directory (0.25.1, ADR 0038 part 1): core, always on. The modules that name contacts register their link
 * kinds in their own manifests (`contactKinds`).
 */
export default defineFeature({
  name: 'contacts',
  routes: [contactRoutes],
  migrations: [CONTACTS_MIGRATIONS],
});
