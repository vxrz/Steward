import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pageWatchLinkInput } from '@sm/shared';
import { me } from '../auth/access.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { CheckSetupError } from '../monitors/platforms.js';
import { HttpError } from '../util.js';
import { cdPlatform, listWatches, refreshWatches, setWatchLink, watchHistory } from './service.js';

/**
 * The watches of a changedetection.io platform as its components (#242), mounted under /api:
 *   GET  /changedetection/:platformId/watches                 the stored watches with their links (platform viewers)
 *   POST /changedetection/:platformId/watches/read            read them now (platform users)
 *   PUT  /changedetection/:platformId/watches/:uuid/link      link to an application, service or vendor (platform managers; audited)
 *   GET  /changedetection/:platformId/watches/:uuid/history   snapshot times, read now (platform users)
 * Rights are checked on the platform (404 for a platform the caller may not see).
 */

const params = (req: FastifyRequest) => req.params as Record<string, string>;

/** A setup problem of the caller (the vault is locked, no use right) is a client error, not a server failure. */
const asHttp = (e: unknown): unknown => (e instanceof CheckSetupError ? new HttpError(409, e.message, 'CHANGEDETECTION_READ_FAILED') : e);

export async function changedetectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/changedetection/:platformId/watches', async (req) => {
    me();
    return listWatches(params(req).platformId!);
  });

  app.post('/changedetection/:platformId/watches/read', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const p = cdPlatform(params(req).platformId!, 'use');
    try {
      const r = await refreshWatches(p.id, me().username);
      return { ok: true, ...r };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // a failed read (the API key, the network, a locked vault) is stored on the platform and shown with the list
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    }
  });

  app.put('/changedetection/:platformId/watches/:uuid/link', async (req) => {
    const input = pageWatchLinkInput.parse(req.body ?? {});
    return setWatchLink(params(req).platformId!, params(req).uuid!, input, me().username);
  });

  app.get('/changedetection/:platformId/watches/:uuid/history', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    try {
      return await watchHistory(params(req).platformId!, params(req).uuid!, me().username);
    } catch (e) {
      throw asHttp(e);
    }
  });
}
