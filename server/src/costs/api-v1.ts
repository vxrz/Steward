import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { COST_SCOPES, type CostScope } from '@sm/shared';
import { HttpError } from '../util.js';
import { notFound } from '../api/v1/helpers.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { CostListQuery } from './api-schemas.js';
import { overview, scopeDetail } from './query.js';

/**
 * Platform costs in the public, read-only API (#226): the overview of a kind and one scope, with the rights of the web
 * app – scopes the token owner may not see are not listed (one asked for answers 404), amounts they may not see are
 * null. The FOCUS push from CI is not part of this API: it takes a push token of its own (POST /api/hooks/costs/…).
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

export function costApiRoutes(get: Get): void {
  get(
    '/costs',
    {
      operationId: 'listCosts',
      tag: 'Costs',
      summary: 'List the costs of services, applications, teams or platforms',
      description:
        'One row per scope and currency (no conversion between currencies) with the current month so far, the last month, the forecast of the current month and the budget. Showback from AWS, Snowflake, Confluent Cloud, AI gateways and FOCUS files (docs/COSTS.md).',
      query: CostListQuery,
      paginated: true,
      response: {
        type: 'object',
        required: ['items', 'nextCursor'],
        additionalProperties: false,
        properties: { items: { type: 'array', items: { $ref: 'CostOverviewRow#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof CostListQuery>;
      const rows = overview(q.scope).rows;
      const p = pageArray(rows, (r) => [r.name.toLowerCase(), r.id, r.currency], q, { scope: q.scope });
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );
  get(
    '/costs/:scope/:id',
    {
      operationId: 'getCosts',
      tag: 'Costs',
      summary: 'Get the costs of a service, application, team or platform',
      description:
        'The last 12 complete months and the current month so far per currency (EffectiveCost and BilledCost, FOCUS), the forecast, the trend, the costs by provider and service, the applications or platforms behind them, what no application is linked to (platforms), the sources and the monthly budget.',
      params: { scope: 'service, application, team or platform', id: 'The id of the service, application, team or platform' },
      response: { $ref: 'CostScopeDetail#' },
    },
    async (req) => {
      const p = req.params as { scope: string; id: string };
      if (!(COST_SCOPES as readonly string[]).includes(p.scope)) throw notFound(`Scope ${p.scope}`);
      try {
        return scopeDetail(p.scope as CostScope, p.id);
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`${p.scope} ${p.id}`);
        throw e;
      }
    },
  );
}
