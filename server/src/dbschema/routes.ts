import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DB_SCHEMA_EXPORT_FORMATS, DB_SCHEMA_SUBJECTS } from '@sm/shared';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { ACCESS } from '../auth/access.js';
import { contentDisposition } from '../records/attachments.js';
import * as svc from './service.js';
import {
  authorizePush,
  createPushToken,
  importPush,
  listPushTokens,
  REFUSED,
  revokePushToken,
  rotatePushToken,
  type PushResponse,
  type VerifiedPushToken,
} from './push.js';

/**
 * Database schemas (0.8.0, #222, docs/DATABASES.md#database-schemas) in the internal API. `:kind` is platform or
 * system; rights are checked in the service (the subject's own rights, a hidden one answers 404).
 *
 *   GET  /api/db-schemas/:kind/:id                                  settings, rights and the snapshots
 *   POST /api/db-schemas/:kind/:id/read                             read the database now (database platforms)
 *   PUT  /api/db-schemas/:kind/:id/settings                         retention and the scheduled read
 *   POST /api/db-schemas/:kind/:id/import/preview | /import         a tbls schema.json (and tbls lint output)
 *   GET  /api/db-schemas/:kind/:id/snapshots/:snapshotId            a snapshot with its schema, checks and changes (or "latest")
 *   GET  /api/db-schemas/:kind/:id/snapshots/:snapshotId/export     DBML, SQL DDL or JSON
 *   GET  /api/db-schemas/:kind/:id/compare?from=&to=                the changes between two snapshots
 *   GET|POST /api/db-schemas/:kind/:id/push-tokens, POST …/:tokenId/rotate, DELETE …/:tokenId   push tokens for CI
 *   POST /api/hooks/db-schema/:kind/:id                             the push from CI (its push token only, push.ts)
 */

const subject = (req: FastifyRequest) =>
  z.object({ kind: z.enum(DB_SCHEMA_SUBJECTS), id: z.string().min(1).max(100), snapshotId: z.string().min(1).max(100).optional() }).parse(req.params);
const imports = { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.dbSchemaImport.bytes };
const tokenId = (req: FastifyRequest) => z.object({ tokenId: z.string().min(1).max(100) }).parse(req.params).tokenId;

export async function dbSchemaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/db-schemas/:kind/:id', async (req) => {
    const s = subject(req);
    return svc.overview(s.kind, s.id);
  });
  app.post('/db-schemas/:kind/:id/read', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => {
    const s = subject(req);
    const r = await svc.readNow(s.kind, s.id, 'ui');
    return { snapshot: r.snapshot, created: r.created, diff: r.diff };
  });
  app.put('/db-schemas/:kind/:id/settings', async (req) => {
    const s = subject(req);
    return svc.setSettings(s.kind, s.id, req.body);
  });
  app.post('/db-schemas/:kind/:id/import/preview', imports, async (req) => {
    const s = subject(req);
    return svc.previewImport(s.kind, s.id, req.body);
  });
  app.post('/db-schemas/:kind/:id/import', imports, async (req) => {
    const s = subject(req);
    const r = svc.importTbls(s.kind, s.id, req.body, 'ui');
    return { snapshot: r.snapshot, created: r.created, diff: r.diff, warnings: r.warnings };
  });
  app.get('/db-schemas/:kind/:id/snapshots/:snapshotId', async (req) => {
    const s = subject(req);
    return svc.getSnapshot(s.kind, s.id, s.snapshotId!);
  });
  app.get('/db-schemas/:kind/:id/snapshots/:snapshotId/export', async (req, reply) => {
    const s = subject(req);
    const { format } = z.object({ format: z.enum(DB_SCHEMA_EXPORT_FORMATS).default('dbml') }).parse(req.query);
    const f = svc.exportSnapshot(s.kind, s.id, s.snapshotId!, format);
    reply.header('content-disposition', contentDisposition(f.fileName));
    return reply.type(f.contentType).send(f.body);
  });
  app.get('/db-schemas/:kind/:id/compare', async (req) => {
    const s = subject(req);
    const q = z.object({ from: z.string().min(1).max(100), to: z.string().min(1).max(100) }).parse(req.query);
    return svc.compareSnapshots(s.kind, s.id, q.from, q.to);
  });

  // ---------- push tokens for CI ----------
  app.get('/db-schemas/:kind/:id/push-tokens', async (req) => {
    const s = subject(req);
    return listPushTokens(s.kind, s.id);
  });
  // a push token outlives the API token that would create it: sessions only (revoking stays open to tokens)
  app.post('/db-schemas/:kind/:id/push-tokens', { config: { access: ACCESS.session } }, async (req) => {
    const s = subject(req);
    return createPushToken(s.kind, s.id, req.body);
  });
  app.post('/db-schemas/:kind/:id/push-tokens/:tokenId/rotate', { config: { access: ACCESS.session } }, async (req) => {
    const s = subject(req);
    return rotatePushToken(s.kind, s.id, tokenId(req));
  });
  app.delete('/db-schemas/:kind/:id/push-tokens/:tokenId', async (req, reply) => {
    const s = subject(req);
    revokePushToken(s.kind, s.id, tokenId(req));
    return reply.code(204).send();
  });

  // ---------- the push from CI: machine to machine, its push token only (like heartbeats and webhook triggers) ----------
  await app.register(async (hooks) => {
    // the body as bytes: its SHA-256 is that of the file as sent
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: LARGE_BODIES.dbSchemaImport.bytes }, (_req, body, done) => done(null, body));
    const verified = new WeakMap<FastifyRequest, VerifiedPushToken>();
    const answer = (reply: FastifyReply, res: PushResponse) => {
      reply.header('cache-control', 'no-store');
      if (res.headers) reply.headers(res.headers);
      return reply.code(res.status).send(res.body);
    };
    const target = (req: FastifyRequest) => {
      const p = req.params as { kind?: string; id?: string };
      return { kind: String(p.kind ?? ''), id: String(p.id ?? '') };
    };
    hooks.post(
      '/hooks/db-schema/:kind/:id',
      {
        config: { rateLimit: ROUTE_LIMITS.webhook },
        bodyLimit: LARGE_BODIES.dbSchemaImport.bytes,
        // the token is checked from the headers before the body is read: without a valid one, nothing of up to 10 MB is buffered
        onRequest: async (req, reply) => {
          const a = authorizePush({ ...target(req), contentType: req.headers['content-type'], headers: req.headers, ip: req.ip });
          if (!a.ok) return answer(reply, a.res);
          verified.set(req, a.token);
        },
      },
      async (req, reply) => {
        const token = verified.get(req);
        if (!token) return answer(reply, REFUSED);
        return answer(reply, importPush(token, { raw: Buffer.isBuffer(req.body) ? req.body : undefined, ip: req.ip }));
      },
    );
  });
}
