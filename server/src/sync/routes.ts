import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SYNC_KINDS, SYNC_UPDATE_STATUSES, SYNC_WEBHOOK_MAX_BODY_BYTES } from '@sm/shared';
import { currentActor } from '../auth/context.js';
import * as sources from './service.js';
import * as updates from './updates.js';
import { fetchSource } from './fetch.js';
import { handleSyncHook } from './hook.js';
import { ROUTE_LIMITS } from '../rateLimits.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

const listQuery = z.object({
  status: z
    .string()
    .max(100)
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : []))
    .pipe(z.array(z.enum(SYNC_UPDATE_STATUSES)).max(50)),
  sourceId: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const decision = z.object({ comment: z.string().max(2000).optional(), force: z.boolean().optional() });

/**
 * Git sync API. Sources: administrators (creating, changing and deleting them needs a signed-in
 * session, see SESSION_ONLY_ROUTES in app.ts). Updates inbox: designers and administrators, each
 * decision with the rights of a manual change. Origins: everyone, for the items they can see.
 */
export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // ---------- inbound webhook (public, authenticated by the source's webhook secret) ----------
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: SYNC_WEBHOOK_MAX_BODY_BYTES }, (_req, body, done) => done(null, body));
    hooks.post('/hooks/sync/:id', { config: { rateLimit: ROUTE_LIMITS.webhook }, bodyLimit: SYNC_WEBHOOK_MAX_BODY_BYTES }, async (req, reply) => {
      const res = handleSyncHook({ sourceId: params(req).id!, raw: Buffer.isBuffer(req.body) ? req.body : undefined, headers: req.headers, ip: req.ip });
      reply.header('cache-control', 'no-store');
      if (res.headers) reply.headers(res.headers);
      return reply.code(res.status).send(res.body);
    });
  });

  // ---------- sources ----------
  app.get('/sync-sources', async () => {
    sources.requireAdmin();
    return sources.listSources();
  });
  app.get('/sync-sources/:id', async (req) => {
    sources.requireAdmin();
    return sources.getSource(params(req).id!);
  });
  app.post('/sync-sources', async (req) => {
    sources.requireAdmin();
    return sources.createSource(sources.sourceSchema.parse(req.body));
  });
  app.put('/sync-sources/:id', async (req) => {
    sources.requireAdmin();
    sources.requireSource(params(req).id!);
    return sources.updateSource(params(req).id!, sources.sourceSchema.parse(req.body));
  });
  app.delete('/sync-sources/:id', async (req) => {
    sources.deleteSource(params(req).id!);
    return { ok: true };
  });
  app.post('/sync-sources/:id/rotate-webhook-secret', async (req) => sources.rotateWebhookSecret(params(req).id!));
  app.post('/sync-sources/:id/fetch', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    sources.requireAdmin();
    sources.requireSource(params(req).id!);
    return fetchSource(params(req).id!, 'manual', currentActor());
  });

  // ---------- updates inbox ----------
  app.get('/sync-updates', async (req) => {
    const q = listQuery.parse(req.query ?? {});
    return updates.listUpdates({ status: q.status, sourceId: q.sourceId, limit: q.limit });
  });
  app.get('/sync-updates/:id', async (req) => updates.getUpdate(params(req).id!));
  app.post('/sync-updates/:id/accept', async (req) => {
    const b = decision.parse(req.body ?? {});
    return updates.acceptUpdate(params(req).id!, { comment: b.comment, force: b.force });
  });
  app.post('/sync-updates/:id/reject', async (req) => {
    const b = decision.parse(req.body ?? {});
    return updates.rejectUpdate(params(req).id!, b.comment);
  });

  // ---------- origins (badges) ----------
  app.get('/sync-origins', async (req) => {
    const q = z.object({ kind: z.enum(SYNC_KINDS).optional() }).parse(req.query ?? {});
    return updates.listOrigins(q.kind);
  });
}
