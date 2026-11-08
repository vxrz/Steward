import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** The credentials register: documentation of credentials, never their values. */
export default defineFeature({
  name: 'credentials',
  jobs: [
    // expiry / rotation / review reminders (credentials/reminders.ts)
    every5Minutes('credential-reminders', 2 * MINUTE, () => import('../credentials/reminders.js').then((m) => m.checkCredentialReminders())),
    // entries linked to their IBM Verify Privilege Vault secret (#205): metadata every few hours
    every5Minutes('vault-links', 30 * MINUTE, () => import('../credentials/vault.js').then((m) => m.runVaultLinkJob())),
  ],
});
