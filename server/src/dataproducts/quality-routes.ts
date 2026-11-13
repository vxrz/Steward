import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { elementPersonalFields, objectPersonalFields, productPersonalFields } from './personal-fields.js';
import { elementQuality } from './quality.js';
import { scorecardHistory } from './scorecard-history.js';

/**
 * Quality, personal fields and the scorecard over time in the internal API (0.24.0, ADR 0036 phase 2, package B).
 * Read-only; a product, element or data object the caller may not see answers like a missing one; the module's
 * switch in app.ts (404 MODULE_OFF while it is off).
 *
 *   GET /api/data-elements/:id/quality                       quality results of the last 30 days, summed up per dimension
 *   GET /api/data-elements/:id/personal-fields               personal and classified fields of the contracts bound to it
 *   GET /api/data-objects/:id/personal-fields                … of the output ports that expose the data object
 *   GET /api/data-products/:id/personal-fields?environment=  … of the product's output ports
 *   GET /api/data-products/:id/scorecard/history?environment=&days=   the daily scorecard snapshots (7–400 days)
 */

const name = z.string().trim().min(1).max(200);
const idOf = (req: FastifyRequest): string => name.parse((req.params as Record<string, unknown>).id);
const envQuery = z.object({ environment: z.string().trim().min(1).max(60).optional() }).strict();

export async function dataProductQualityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/data-elements/:id/quality', async (req) => elementQuality(idOf(req)));
  app.get('/data-elements/:id/personal-fields', async (req) => elementPersonalFields(idOf(req)));
  app.get('/data-objects/:id/personal-fields', async (req) => objectPersonalFields(idOf(req)));
  app.get('/data-products/:id/personal-fields', async (req) => productPersonalFields(idOf(req), envQuery.parse(req.query ?? {})));
  app.get('/data-products/:id/scorecard/history', async (req) => scorecardHistory(idOf(req), req.query));
}
