import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../util.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { getPlatform } from '../platforms/service.js';
import { getHealth, healthInput, setHealth } from '../platforms/health.js';
import { requirePlatform } from '../routes/helpers.js';
import { listBundles, setupBundle, setupInput, turnOnBundle, turnOnInput } from './bundles.js';
import { getStarted } from './getStarted.js';
import { kafkaPrefixRoutes } from '../kafka/routes.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

/** A platform the current user has some permission on (404 otherwise, so ids can't be probed). */
function visiblePlatform(id: string) {
  const p = getPlatform(id);
  if (!p.permissions.length) throw new HttpError(404, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
  return p;
}

/** Onboarding (v0.4.0): template bundles, "get started" with a platform, platform health, Kafka topics by prefix. */
export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  // ---------- template bundles ----------
  app.get('/template-bundles', async () => listBundles());
  app.post('/template-bundles/:id/setup', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) =>
    setupBundle(params(req).id!, setupInput.parse(req.body ?? {})),
  );
  app.post('/template-bundles/:id/turn-on', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) =>
    turnOnBundle(params(req).id!, turnOnInput.parse(req.body ?? {})),
  );

  // ---------- platforms: what's next, health ----------
  app.get('/platforms/:id/get-started', async (req) => getStarted(visiblePlatform(params(req).id!).kind));
  app.get('/platforms/:id/health', async (req) => getHealth(visiblePlatform(params(req).id!).id));
  app.put('/platforms/:id/health', async (req) => {
    requirePlatform(params(req).id!, 'manage', 'change the connection test of this platform');
    return setHealth(params(req).id!, healthInput.parse(req.body));
  });

  await kafkaPrefixRoutes(app);
}
