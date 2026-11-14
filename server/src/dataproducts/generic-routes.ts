import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS } from '../auth/access.js';
import { LINK_PARAM } from '../auth/cookies.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { convertElement } from './elements.js';
import { connectorStepDraft, createConnectorStep, listConnectors } from './connector-steps.js';
import { openLineageExport } from './openlineage-export.js';
import { editableProduct } from './service.js';
import { deleteTechnology, putTechnology, technologyList } from './technologies.js';

/**
 * Generic parts, bridges and connectors in the internal API (0.25.0, ADR 0037 parts 0, 1 and 5). Rights are checked in
 * the services; the module's switch in app.ts (404 MODULE_OFF while it is off).
 *
 *   GET        /api/data-products/technologies               the technology list (every reader of the module)
 *   PUT|DELETE /api/data-products/technologies/:key          an administrator's own entry (administrators)
 *   POST       /api/data-elements/:id/convert                Convert to … (who may change the element)
 *   GET        /api/data-products/connectors                 Kafka Connect and Confluent connectors the reader may see
 *   GET        /api/data-products/:id/steps/from-connector   the step a connector would be (?platformId=&connector=)
 *   POST       /api/data-products/:id/steps/from-connector   Create step from connector (who may change the product)
 *   GET        /api/data-products/:id/openlineage            the OpenLineage static export (?environment=&step=), JSON Lines
 *   GET        /api/data-products/:id/steps/:stepId/openlineage   the export of one step
 */

const param = (req: FastifyRequest, name: string): string =>
  z
    .string()
    .min(1)
    .max(200)
    .parse((req.params as Record<string, unknown>)[name]);
const exportQuery = z.object({ environment: z.string().trim().max(60).optional(), step: z.string().trim().min(1).max(100).optional() }).strict();

/** The query without the link key: the downloads are links (`?_sk=` authenticates them, app.ts), the rest is strict. */
const queryOf = (req: FastifyRequest): Record<string, unknown> =>
  Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).filter(([k]) => k !== LINK_PARAM));

function sendLines(reply: FastifyReply, f: { fileName: string; body: string }) {
  reply.header('content-disposition', `attachment; filename="${f.fileName}"`);
  reply.header('cache-control', 'no-store');
  return reply.type('application/x-ndjson; charset=utf-8').send(f.body);
}

export async function dataProductGenericRoutes(app: FastifyInstance): Promise<void> {
  // ---------- the technology list ----------
  app.get('/data-products/technologies', async () => technologyList());
  app.put('/data-products/technologies/:key', { config: { access: ACCESS.admin } }, async (req) => putTechnology(param(req, 'key'), req.body));
  app.delete('/data-products/technologies/:key', { config: { access: ACCESS.admin } }, async (req, reply) => {
    deleteTechnology(param(req, 'key'));
    return reply.code(204).send();
  });

  // ---------- Convert to … ----------
  app.post('/data-elements/:id/convert', async (req) => convertElement(param(req, 'id'), req.body));

  // ---------- steps from connectors ----------
  app.get('/data-products/connectors', async () => listConnectors());
  app.get('/data-products/:id/steps/from-connector', async (req) => {
    editableProduct(param(req, 'id'));
    return connectorStepDraft(req.query);
  });
  app.post('/data-products/:id/steps/from-connector', async (req) => {
    const p = editableProduct(param(req, 'id')).row;
    return createConnectorStep(p.id, p.name, req.body);
  });

  // ---------- the OpenLineage static export ----------
  const heavy = { config: { rateLimit: ROUTE_LIMITS.heavy } };
  app.get('/data-products/:id/openlineage', heavy, async (req, reply) => {
    const q = exportQuery.parse(queryOf(req));
    return sendLines(reply, openLineageExport(param(req, 'id'), { environment: q.environment, stepId: q.step }));
  });
  app.get('/data-products/:id/steps/:stepId/openlineage', heavy, async (req, reply) => {
    const q = exportQuery.omit({ step: true }).parse(queryOf(req));
    return sendLines(reply, openLineageExport(param(req, 'id'), { environment: q.environment, stepId: param(req, 'stepId') }));
  });
}
