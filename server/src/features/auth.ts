import { authRoutes } from '../routes/auth.js';
import { userRoutes } from '../routes/users.js';
import { scopeRoutes } from '../auth/scope-routes.js';
import { assuranceRoutes } from '../routes/assurance.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Signing in, users and teams, roles and scopes, the assurance policy and step-ups. */
export default defineFeature({
  name: 'auth',
  routes: [authRoutes, userRoutes, scopeRoutes, assuranceRoutes],
  jobs: [
    // assurance policy: requests to loosen it that no second administrator approved within 7 days expire (auth/assurance.ts)
    every5Minutes('assurance-policy-changes', MINUTE, () => import('../auth/assurance.js').then((m) => m.expirePolicyChanges())),
  ],
});
