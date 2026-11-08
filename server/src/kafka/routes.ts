import type { FastifyInstance } from 'fastify';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { environmentValue } from '../catalogue/environments.js';
import { addInput, addTopics, checkSyncNow, dismissInput, dismissTopics, listInput, listSyncs, listTopics, stopSync } from './prefixes.js';
import { params } from '../routes/params.js';

/** Kafka topics by prefix of an application (v0.4.0, docs/KAFKA.md); mounted under /api. */
export async function kafkaPrefixRoutes(app: FastifyInstance): Promise<void> {
  // the cluster's topics under a prefix (read-only); POST because the prefix is part of the request body
  app.post('/applications/:id/kafka-topics/list', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const b = listInput.extend({ environment: environmentValue.default('') }).parse(req.body);
    return listTopics(params(req).id!, { platformId: b.platformId, prefix: b.prefix }, b.environment);
  });
  app.post('/applications/:id/kafka-topics', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const r = await addTopics(params(req).id!, addInput.parse(req.body));
    const { getApplication } = await import('../catalogue/applications.js');
    return { ...r, application: getApplication(params(req).id!) };
  });
  app.get('/applications/:id/topic-prefixes', async (req) => listSyncs(params(req).id!));
  app.post('/applications/:id/topic-prefixes/:syncId/check', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) =>
    checkSyncNow(params(req).id!, params(req).syncId!),
  );
  app.post('/applications/:id/topic-prefixes/:syncId/dismiss', async (req) =>
    dismissTopics(params(req).id!, params(req).syncId!, dismissInput.parse(req.body).topics),
  );
  app.delete('/applications/:id/topic-prefixes/:syncId', async (req) => {
    await stopSync(params(req).id!, params(req).syncId!);
    return { ok: true };
  });
}
