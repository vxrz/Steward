import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS } from '../auth/access.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { LINK_PARAM } from '../auth/cookies.js';
import { dataProductsJsonSchema } from './format.js';
import { exportFile } from './export.js';
import { odpsFile } from './odps.js';
import { applyImport, importOrigins, importRemovals, previewImport } from './import.js';
import YAML from 'yaml';
import { me } from '../auth/access.js';
import { dataObjectsSemanticModel } from './ossie.js';

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
 *   GET  /api/data-objects/semantic-model            the data objects as an Apache Ossie model (?version, format; phase 2)
 *   GET  /api/data-products/import-origins           earlier imports' origins with entries the caller may see (phase 2)
 *   POST /api/data-products/import/preview           what an import would add, change and skip
 *   POST /api/data-products/import                   the import (add only, add and update, or replace an earlier import –
 *                                                    removing more than one entry or item asks for the step-up
 *                                                    dataproduct.bulkChange); ODPS documents among the files are read too
 */

const name = z.string().trim().min(1).max(200);
const idOf = (req: FastifyRequest): string => name.parse((req.params as Record<string, unknown>).id);
const exportQuery = z
  .object({ domain: name.optional(), environment: z.string().trim().max(60).optional(), format: z.enum(['yaml', 'json']).default('yaml') })
  .strict();
const productExportQuery = exportQuery.omit({ domain: true });
const odpsQuery = z.object({ environment: z.string().trim().max(60).optional() }).strict();
const ossieQuery = z.object({ version: z.enum(['0.1.1', '0.2.0.dev0']).default('0.1.1'), format: z.enum(['yaml', 'json']).default('yaml') }).strict();

/** The query without the link key: the downloads are links (`?_sk=` authenticates them, app.ts), the rest is strict. */
const queryOf = (req: FastifyRequest): Record<string, unknown> =>
  Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).filter(([k]) => k !== LINK_PARAM));

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
    const q = exportQuery.parse(queryOf(req));
    return send(reply, exportFile({ domainId: q.domain, environment: q.environment }, q.format), typeOf(q.format));
  });
  app.get('/data-products/:id/export', heavy, async (req, reply) => {
    const q = productExportQuery.parse(queryOf(req));
    return send(reply, exportFile({ productId: idOf(req), environment: q.environment }, q.format), typeOf(q.format));
  });
  app.get('/data-products/:id/odps', async (req, reply) => {
    const q = odpsQuery.parse(queryOf(req));
    return send(reply, odpsFile(idOf(req), q.environment), 'application/yaml; charset=utf-8');
  });
  // phase 2: the Ossie export of the data objects the caller may see (a download)
  app.get('/data-objects/semantic-model', heavy, async (req, reply) => {
    const q = ossieQuery.parse(queryOf(req));
    const doc = dataObjectsSemanticModel(me(), q.version);
    const body = q.format === 'json' ? JSON.stringify(doc, null, 2) : YAML.stringify(doc, { lineWidth: 0 });
    return send(reply, { fileName: `data-objects.ossie.${q.format}`, body }, typeOf(q.format));
  });
  // phase 2: what Replace an earlier import can name – session-only, as the imports
  app.get('/data-products/import-origins', { config: { access: ACCESS.session } }, async () => importOrigins());
  app.post('/data-products/import/preview', imports, async (req) => previewImport(req.body));
  // the removals of a replace, counted once per request (`when` asks before the handler)
  const removals = new WeakMap<FastifyRequest, number>();
  const removalsOf = (req: FastifyRequest): number => {
    let n = removals.get(req);
    if (n === undefined) removals.set(req, (n = importRemovals(req.body)));
    return n;
  };
  app.post(
    '/data-products/import',
    { ...imports, config: { ...imports.config, stepUp: { action: 'changeDataProductsInBulk', when: (req: FastifyRequest) => removalsOf(req) > 1 } } },
    async (req) => applyImport(req.body),
  );
}
