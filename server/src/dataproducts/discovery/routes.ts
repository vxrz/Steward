import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS } from '../../auth/access.js';
import * as sources from './sources.js';

/**
 * Discovery sources of the data products module in the internal API (ADR 0036 parts 5 and 19). Rights are checked in
 * sources.ts (a source the caller may not see answers like a missing one); the module's switch covers the prefix
 * /api/data-products. Every change – and Read now – needs a signed-in session (ADR 0036 security notes: discovery
 * sources are session-only).
 *
 *   GET|POST   /api/data-products/discovery-sources              ?platformId= filters
 *   GET|PUT|DELETE /api/data-products/discovery-sources/:id
 *   POST       /api/data-products/discovery-sources/:id/run      Read now (202: the run goes on in the background)
 *   GET        /api/data-products/discovery-sources/:id/runs     the newest runs
 */

const idOf = (req: FastifyRequest) =>
  z
    .string()
    .min(1)
    .max(100)
    .parse((req.params as Record<string, unknown>).id);

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  const base = '/data-products/discovery-sources';
  app.get(base, async (req) => {
    const q = z.object({ platformId: z.string().min(1).max(100).optional() }).parse(req.query);
    return sources.listSources(q.platformId);
  });
  app.post(base, { config: { access: ACCESS.session } }, async (req) => sources.createSource(req.body));
  app.get(`${base}/:id`, async (req) => sources.getSource(idOf(req)));
  app.put(`${base}/:id`, { config: { access: ACCESS.session } }, async (req) => sources.updateSource(idOf(req), req.body));
  app.delete(`${base}/:id`, { config: { access: ACCESS.session } }, async (req, reply) => {
    sources.deleteSource(idOf(req));
    return reply.code(204).send();
  });
  app.post(`${base}/:id/run`, { config: { access: ACCESS.session } }, async (req, reply) => reply.code(202).send(sources.readNow(idOf(req))));
  app.get(`${base}/:id/runs`, async (req) => sources.listRuns(idOf(req)));
}
