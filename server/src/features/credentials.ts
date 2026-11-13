import { credentialRoutes } from '../credentials/routes.js';
import { credentialApiRoutes } from '../credentials/api-v1.js';
import { CREDENTIAL_MIGRATIONS } from '../migrations/credentials.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';
import { credentialShareKind } from '../auth/item-shares.js';
import { credentialAccess } from '../credentials/service.js';

/** The credentials register: documentation of credentials, never their values. */
export default defineFeature({
  name: 'credentials',
  shareKinds: [credentialShareKind((u, r) => credentialAccess(u, r).permissions)],
  routes: [credentialRoutes],
  apiV1: [credentialApiRoutes],
  jobs: [
    // expiry / rotation / review reminders (credentials/reminders.ts)
    every5Minutes('credential-reminders', 2 * MINUTE, () => import('../credentials/reminders.js').then((m) => m.checkCredentialReminders())),
    // entries linked to their IBM Verify Privilege Vault secret (#205): metadata every few hours
    every5Minutes('vault-links', 30 * MINUTE, () => import('../credentials/vault.js').then((m) => m.runVaultLinkJob())),
  ],
  migrations: [CREDENTIAL_MIGRATIONS],
});
