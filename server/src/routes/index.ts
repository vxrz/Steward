import type { FastifyInstance } from 'fastify';
import { FEATURES } from '../features/index.js';

/**
 * The internal API under /api (app.ts registers it with that prefix): the routes of every feature, in the order of
 * the composition root (features/index.ts). The plant registry's routes answer 404 while it is off, like those of
 * any switched-off module (modules/registry.ts).
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  for (const f of FEATURES) for (const routes of f.routes ?? []) await routes(app);
}
