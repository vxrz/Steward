import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DATA_GRAPH_LIMITS, DATA_PRODUCT_LIFECYCLES, DATA_PRODUCT_TYPES } from '@sm/shared';
import { lineageView, mapView, pipelineView } from './views.js';

/**
 * The pictures of the data products module in the internal API (ADR 0036 parts 13 and 19, WP6). Read-only; rights are
 * the reader's (a product or an element they may not see answers like a missing one; what a picture holds that they
 * may not see is drawn without a name and counted). Off with the module (404 MODULE_OFF, app.ts).
 *
 *   GET /api/data-products/map                    products and their dependencies (?environment, domain, type, lifecycle, q)
 *   GET /api/data-products/:id/views/pipeline     a product's pipeline in an environment (?environment)
 *   GET /api/data-elements/:id/lineage            an element's lineage, 1–4 steps up and down (?depth)
 */

const name = z.string().trim().min(1).max(200);
const idOf = (req: FastifyRequest): string => name.parse((req.params as Record<string, unknown>).id);

const mapQuery = z
  .object({
    environment: name.optional(),
    domain: name.optional(),
    type: z.enum(DATA_PRODUCT_TYPES).optional(),
    lifecycle: z.enum(DATA_PRODUCT_LIFECYCLES).optional(),
    q: z.string().trim().max(200).optional(),
  })
  .strict();

const pipelineQuery = z.object({ environment: name.optional() }).strict();

const lineageQuery = z.object({ depth: z.coerce.number().int().min(1).max(DATA_GRAPH_LIMITS.lineageDepth).default(2) }).strict();

export async function dataProductViewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/data-products/map', async (req) => mapView(mapQuery.parse(req.query ?? {})));
  app.get('/data-products/:id/views/pipeline', async (req) => pipelineView(idOf(req), pipelineQuery.parse(req.query ?? {}).environment));
  app.get('/data-elements/:id/lineage', async (req) => lineageView(idOf(req), lineageQuery.parse(req.query ?? {}).depth));
}
