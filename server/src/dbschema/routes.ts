import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DB_SCHEMA_EXPORT_FORMATS, DB_SCHEMA_SUBJECTS } from '@sm/shared';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { contentDisposition } from '../records/attachments.js';
import * as svc from './service.js';

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
 */

const subject = (req: FastifyRequest) =>
  z.object({ kind: z.enum(DB_SCHEMA_SUBJECTS), id: z.string().min(1).max(100), snapshotId: z.string().min(1).max(100).optional() }).parse(req.params);
const imports = { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.dbSchemaImport.bytes };

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
}
