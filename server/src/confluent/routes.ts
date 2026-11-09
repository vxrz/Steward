import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONFLUENT_KIND } from '@sm/shared';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { me } from '../auth/access.js';
import { requirePlatform } from '../routes/helpers.js';
import { requireVisiblePlatform } from '../monitors/platforms.js';
import { HttpError } from '../util.js';
import { getConfluentView, refreshConfluent } from './service.js';

/**
 * Confluent Cloud platforms (0.14.0, #123, docs/CONFLUENT.md), mounted under /api: the last readout with its links (who
 * sees the platform; service accounts and API keys only who may use it) and "Read now" (who may use it). Read-only:
 * there is no route that changes anything in Confluent Cloud. Not in the public API (/api/v1).
 */
const idParam = (req: FastifyRequest) => z.object({ id: z.string().min(1).max(64) }).parse(req.params).id;

function confluentPlatform(id: string, perm: 'use' | null) {
  const p = perm ? requirePlatform(id, perm, 'use this platform') : requireVisiblePlatform(id);
  if (p.kind !== CONFLUENT_KIND) throw new HttpError(400, 'Choose a Confluent Cloud platform', 'CONFLUENT_PLATFORM');
  return p;
}

export async function confluentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platforms/:id/confluent', async (req) => getConfluentView(confluentPlatform(idParam(req), null).id));

  app.post('/platforms/:id/confluent/read', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const p = confluentPlatform(idParam(req), 'use');
    await refreshConfluent(p.id, me().username);
    return getConfluentView(p.id);
  });
}
