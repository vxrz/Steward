import { teamsBotRoutes } from '../msteams/routes.js';
import { defineFeature } from './define.js';

/** Approvals in Microsoft Teams (ADR 0013); the bot has its own listener (main.ts). */
export default defineFeature({
  name: 'teamsBot',
  module: 'teamsBot',
  routes: [teamsBotRoutes],
});
