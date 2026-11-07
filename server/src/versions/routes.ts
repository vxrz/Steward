import type { FastifyInstance } from 'fastify';
import { ROUTE_LIMITS } from '../rateLimits.js';
import * as v from './service.js';

/**
 * The version watch (#241), internal API:
 *   GET  /api/catalogue/versions                  status and settings (everyone who signs in; counts only)
 *   PUT  /api/catalogue/versions                  settings (administrators)
 *   POST /api/catalogue/versions/refresh          read every lookup now (administrators, designers)
 *   GET  /api/catalogue/versions/entry            one stack entry: its setting, what each source said, vulnerabilities
 *   PUT  /api/catalogue/versions/entry            its setting (whoever may change the application or system)
 *   POST /api/catalogue/versions/entry/read       read its sources now (the same)
 * Entries of applications or systems the caller may not see answer 404, like missing ones.
 */
export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/catalogue/versions', async () => v.versionStatus());
  app.put('/catalogue/versions', async (req) => v.saveVersionSettings(v.versionSettingsInput.parse(req.body)));
  app.post('/catalogue/versions/refresh', { config: { rateLimit: ROUTE_LIMITS.action } }, async () => v.refreshVersionsNow());
  app.get('/catalogue/versions/entry', async (req) => v.versionEntry(v.entryRef.parse(req.query)));
  app.put('/catalogue/versions/entry', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ref = v.entryRef.parse({ holder: body.holder, id: body.id, product: body.product });
    return v.saveVersionEntry(ref, v.watchConfigInput.parse(body.config));
  });
  app.post('/catalogue/versions/entry/read', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => v.readVersionEntry(v.entryRef.parse(req.body)));
}
