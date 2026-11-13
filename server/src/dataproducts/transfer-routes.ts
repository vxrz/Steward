import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS } from '../auth/access.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { dataProductsJsonSchema } from './format.js';
import { exportFile } from './export.js';
import { odpsFile } from './odps.js';
import { applyImport, previewImport } from './import.js';

/**
 * Import and export of the data products module in the internal API (ADR 0036 parts 15 and 19, WP7). Exports read with
 * the caller's rights (what they may not see is not in the file); imports are session-only (security notes: no API
 * token imports) and write through the module's services with the caller's rights. Off with the module (404
 * MODULE_OFF, app.ts).
 *
 *   GET  /api/data-products/schema                   the JSON Schema of the file format
 *   GET  /api/data-products/export                   everything the caller may see, or a domain (?domain, environment, format)
 *   GET  /api/data-products/:id/export               one product (?environment, format)
 *   GET  /api/data-products/:id/odps                 ODPS v1.0.0 (?environment: whose contracts; default production)
 *   POST /api/data-products/import/preview           what an import would add, change and skip
 *   POST /api/data-products/import                   the import (add only, or add and update)
 */

const name = z.string().trim().min(1).max(200);
const idOf = (req: FastifyRequest): string => name.parse((req.params as Record<string, unknown>).id);
const exportQuery = z
  .object({ domain: name.optional(), environment: z.string().trim().max(60).optional(), format: z.enum(['yaml', 'json']).default('yaml') })
  .strict();
const productExportQuery = exportQuery.omit({ domain: true });
const odpsQuery = z.object({ environment: z.string().trim().max(60).optional() }).strict();

const send = (reply: FastifyReply, f: { fileName: string; body: string; elementsLeftOut?: number }, type: string) => {
  reply.header('content-disposition', `attachment; filename="${f.fileName}"`);
  reply.header('cache-control', 'no-store');
  if (f.elementsLeftOut) reply.header('x-steward-elements-left-out', String(f.elementsLeftOut));
  return reply.type(type).send(f.body);
};
const typeOf = (format: 'yaml' | 'json') => (format === 'json' ? 'application/json; charset=utf-8' : 'application/yaml; charset=utf-8');

export async function dataProductTransferRoutes(app: FastifyInstance): Promise<void> {
  const heavy = { config: { rateLimit: ROUTE_LIMITS.heavy } };
  const imports = { config: { rateLimit: ROUTE_LIMITS.heavy, access: ACCESS.session }, bodyLimit: LARGE_BODIES.dataProductImport.bytes };

  app.get('/data-products/schema', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return dataProductsJsonSchema();
  });
  app.get('/data-products/export', heavy, async (req, reply) => {
    const q = exportQuery.parse(req.query ?? {});
    return send(reply, exportFile({ domainId: q.domain, environment: q.environment }, q.format), typeOf(q.format));
  });
  app.get('/data-products/:id/export', heavy, async (req, reply) => {
    const q = productExportQuery.parse(req.query ?? {});
    return send(reply, exportFile({ productId: idOf(req), environment: q.environment }, q.format), typeOf(q.format));
  });
  app.get('/data-products/:id/odps', async (req, reply) => {
    const q = odpsQuery.parse(req.query ?? {});
    return send(reply, odpsFile(idOf(req), q.environment), 'application/yaml; charset=utf-8');
  });
  app.post('/data-products/import/preview', imports, async (req) => previewImport(req.body));
  app.post('/data-products/import', imports, async (req) => applyImport(req.body));
}
