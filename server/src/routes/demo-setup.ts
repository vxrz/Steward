import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { HttpError } from '../util.js';
import { setupDemo } from './demo.js';
import { isAdmin } from '../auth/permissions.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { me } from '../auth/access.js';

/** Loading the demo data (mounted under /api). */
export async function demoSetupRoutes(app: FastifyInstance): Promise<void> {
  // ---------- demo ----------
  app.post('/demo/setup', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => {
    if (!config.demo) throw new HttpError(404, 'Demo mode is not enabled (start with npm run demo)');
    if (!isAdmin(me())) throw new HttpError(403, 'Only administrators can load demo data');
    // { applications: false } leaves out the sample applications (tests that need an empty catalogue); { services: true }
    // adds the service half – services, documents, credential entries, duties, maintenance, a status page (U5)
    const body = (req.body ?? {}) as { applications?: unknown; services?: unknown };
    return setupDemo({ applications: body.applications !== false, services: body.services === true });
  });
}
