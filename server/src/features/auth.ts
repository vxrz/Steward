import { authRoutes } from '../routes/auth.js';
import { userRoutes } from '../routes/users.js';
import { scopeRoutes } from '../auth/scope-routes.js';
import { shareRoutes } from '../auth/share-routes.js';
import { assuranceRoutes } from '../routes/assurance.js';
import { SECURITY_MIGRATIONS } from '../migrations/security.js';
import { SIGN_IN_MIGRATIONS } from '../migrations/sign-in.js';
import { TEAM_MIGRATIONS } from '../migrations/teams.js';
import { ASSURANCE_MIGRATIONS } from '../migrations/assurance.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Signing in, users and teams, roles and scopes, the assurance policy and step-ups. */
export default defineFeature({
  name: 'auth',
  routes: [authRoutes, userRoutes, scopeRoutes, shareRoutes, assuranceRoutes],
  jobs: [
    // assurance policy: requests to loosen it that no second administrator approved within 7 days expire (auth/assurance.ts)
    every5Minutes('assurance-policy-changes', MINUTE, () => import('../auth/assurance.js').then((m) => m.expirePolicyChanges())),
    // shares (ADR 0033): ended ones removed and audited, their Manage holders reminded 7 days before (auth/share-jobs.ts)
    every5Minutes('shares', MINUTE, () => import('../auth/share-jobs.js').then((m) => m.runShareJob())),
  ],
  migrations: [SECURITY_MIGRATIONS, SIGN_IN_MIGRATIONS, TEAM_MIGRATIONS, ASSURANCE_MIGRATIONS],
});
