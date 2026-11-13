import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dataCostAllocationsQuery, dataProductCostsQuery, dataProductScorecardQuery } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import * as costs from './costs.js';
import { productScorecard } from './scorecard.js';

/**
 * Costs and the scorecard of data products in the internal API (ADR 0036 parts 11, 13, 19). Rights in the services: a
 * product or element the caller may not see answers like a missing one; matches follow the product's (or element's)
 * edit right; allocations are set by who may manage the platform, in a signed-in session only.
 *
 *   GET        /api/data-products/:id/costs?environment=&months=          the Costs tab: months, lines, matches, value
 *   POST       /api/data-products/:id/costs/matches                        a match of the product in one environment
 *   DELETE     /api/data-products/:id/costs/matches/:matchId
 *   GET|POST   /api/data-elements/:id/cost-matches, DELETE …/:matchId     an element's matches (inherited by its products)
 *   GET        /api/data-products/cost-allocations?platformId=            shared lines and how they are split
 *   PUT        /api/data-products/cost-allocations                         equal or by weight (session only)
 *   GET        /api/data-products/:id/scorecard?environment=              the scorecard and the maturity
 */

const param = (req: FastifyRequest, name: string): string => {
  const v = (req.params as Record<string, unknown>)[name];
  return z.string().min(1).max(200).parse(v);
};

export async function dataProductCostRoutes(app: FastifyInstance): Promise<void> {
  app.get('/data-products/cost-allocations', async (req) => costs.listAllocations(dataCostAllocationsQuery.parse(req.query)));
  app.put('/data-products/cost-allocations', { config: { access: ACCESS.session } }, async (req) => costs.setAllocation(req.body));

  app.get('/data-products/:id/costs', async (req) => costs.productCosts(param(req, 'id'), dataProductCostsQuery.parse(req.query)));
  app.post('/data-products/:id/costs/matches', async (req) => costs.addProductMatch(param(req, 'id'), req.body));
  app.delete('/data-products/:id/costs/matches/:matchId', async (req, reply) => {
    costs.deleteProductMatch(param(req, 'id'), param(req, 'matchId'));
    return reply.code(204).send();
  });

  app.get('/data-elements/:id/cost-matches', async (req) => costs.elementMatches(param(req, 'id')));
  app.post('/data-elements/:id/cost-matches', async (req) => costs.addElementMatch(param(req, 'id'), req.body));
  app.delete('/data-elements/:id/cost-matches/:matchId', async (req, reply) => {
    costs.deleteElementMatch(param(req, 'id'), param(req, 'matchId'));
    return reply.code(204).send();
  });

  app.get('/data-products/:id/scorecard', async (req) => productScorecard(param(req, 'id'), dataProductScorecardQuery.parse(req.query)));
}
