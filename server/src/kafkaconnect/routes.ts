import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KAFKA_CONNECT_KIND } from '@sm/shared';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { me } from '../auth/access.js';
import { requirePlatform } from '../routes/helpers.js';
import { requireVisiblePlatform } from '../monitors/platforms.js';
import { HttpError } from '../util.js';
import { connectorConfig, getConnectView, refreshConnect } from './service.js';

/**
 * Kafka Connect platforms (0.9.0, #223, docs/KAFKA.md), mounted under /api: the last readout with its links (who sees
 * the platform), "Read now" and a connector's configuration – read now, secret-looking values removed, never stored,
 * audited (who may use the platform). Read-only: there is no route that changes, restarts, pauses or resumes a
 * connector. Not in the public API (/api/v1).
 */
const idParam = (req: FastifyRequest) => z.object({ id: z.string().min(1).max(64) }).parse(req.params).id;

function connectPlatform(id: string, perm: 'use' | null) {
  const p = perm ? requirePlatform(id, perm, 'use this platform') : requireVisiblePlatform(id);
  if (p.kind !== KAFKA_CONNECT_KIND) throw new HttpError(400, 'Choose a Kafka Connect platform', 'KAFKA_CONNECT_PLATFORM');
  return p;
}

export async function kafkaConnectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/platforms/:id/kafka-connect', async (req) => getConnectView(connectPlatform(idParam(req), null).id));

  app.post('/platforms/:id/kafka-connect/read', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const p = connectPlatform(idParam(req), 'use');
    await refreshConnect(p.id, me().username);
    return getConnectView(p.id);
  });

  app.get('/platforms/:id/kafka-connect/connectors/:name/config', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const { name } = z.object({ name: z.string().min(1).max(255) }).parse(req.params);
    const p = connectPlatform(idParam(req), 'use');
    return connectorConfig(p.id, name, me().username);
  });
}
