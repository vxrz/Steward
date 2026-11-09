import { onboardingRoutes } from '../onboarding/routes.js';
import { defineFeature } from './define.js';

/** Onboarding: the first steps of a new installation. */
export default defineFeature({
  name: 'onboarding',
  routes: [onboardingRoutes],
});
