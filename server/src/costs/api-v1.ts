import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { COST_SCOPES, type CostScope } from '@sm/shared';
import { HttpError } from '../util.js';
import { notFound } from '../api/v1/helpers.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { CostCommitmentsQuery, CostListQuery, CostPlanQuery } from './api-schemas.js';
import { overview, scopeDetail } from './query.js';
import { planYear, platformPlanYear } from './plans.js';
import { commitments } from './commitments.js';
import { costAttribution } from './attribution.js';

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
  get(
    '/services/:serviceId/cost-plan',
    {
      operationId: 'getServiceCostPlan',
      tag: 'Costs',
      summary: 'Get the cost plan of a service for a fiscal year',
      description:
        'Service cost planning (docs/COSTS.md#planning-per-service): the plan lines and cost entries of a fiscal year (one start month for the whole instance), per line and currency planned, planned to date, incurred to date, expected and the difference, the months, the cloud and platform costs read for the service (only when the token owner sees every application of it), unplanned entries and renewals in the next 90 days. Not paged: a service has at most 200 plan lines and 2,000 cost entries per fiscal year, so the answer is bounded.',
      params: { serviceId: 'The id of the service' },
      query: CostPlanQuery,
      response: { $ref: 'CostPlanYear#' },
    },
    async (req) => {
      const p = req.params as { serviceId: string };
      const q = req.query as z.infer<typeof CostPlanQuery>;
      try {
        return { ...planYear(p.serviceId, q.fiscalYear), commitments: commitments({ serviceId: p.serviceId }).rows };
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Service ${p.serviceId}`);
        throw e;
      }
    },
  );
  get(
    '/platforms/:platformId/cost-plan',
    {
      operationId: 'getPlatformCostPlan',
      tag: 'Costs',
      summary: 'Get the cost plan of a platform for a fiscal year',
      description:
        "A platform's own cost plan (0.19.0, docs/COSTS.md#planning-per-platform): its plan lines and cost entries of a fiscal year, set against the platform's whole bill as Steward reads it, per line and currency planned, to date, incurred, expected and the difference; use drawn from prepaid volumes (shown, not counted again); its volumes with use, what is left and a linear estimate; and the schedules it pays (commitments). The shape of the service cost plan, with `owner.kind` platform and `serviceId` empty. Not paged: at most 200 plan lines and 2,000 entries per fiscal year.",
      params: { platformId: 'The id of the platform' },
      query: CostPlanQuery,
      response: { $ref: 'CostPlanYear#' },
    },
    async (req) => {
      const p = req.params as { platformId: string };
      const q = req.query as z.infer<typeof CostPlanQuery>;
      try {
        return { ...platformPlanYear(p.platformId, q.fiscalYear), commitments: commitments({ platformId: p.platformId }).rows };
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Platform ${p.platformId}`);
        throw e;
      }
    },
  );
  for (const kind of ['application', 'system'] as const)
    get(
      kind === 'application' ? '/applications/:applicationId/cost-attribution' : '/systems/:systemId/cost-attribution',
      {
        operationId: kind === 'application' ? 'getApplicationCostAttribution' : 'getSystemCostAttribution',
        tag: 'Costs',
        summary: `Get the costs and contracts of ${kind === 'application' ? 'an application' : 'a system'}`,
        description: `Attribution, not a plan (0.19.0, docs/COSTS.md#costs-and-contracts-of-an-application-or-system): the contracts that name the ${kind} for a covered service or that its lines, entries and payment schedules pay for, and those lines, entries and schedules in the services that use it – each counted once – with totals per fiscal year and currency. Only what the token owner may see; amounts null where they may not see a service's amounts.`,
        params: kind === 'application' ? { applicationId: 'The id of the application' } : { systemId: 'The id of the system' },
        query: CostPlanQuery,
        response: { $ref: 'CostAttribution#' },
      },
      async (req) => {
        const p = req.params as { applicationId?: string; systemId?: string };
        const id = (kind === 'application' ? p.applicationId : p.systemId) ?? '';
        const q = req.query as z.infer<typeof CostPlanQuery>;
        try {
          return costAttribution(kind, id, q.fiscalYear);
        } catch (e) {
          if (e instanceof HttpError && e.statusCode === 404) throw notFound(`${kind === 'application' ? 'Application' : 'System'} ${id}`);
          throw e;
        }
      },
    );
  get(
    '/cost-commitments',
    {
      operationId: 'listCostCommitments',
      tag: 'Costs',
      summary: 'List the commitments of payment schedules',
      description:
        "What supplier contracts still owe under their payment schedules (docs/COSTS.md#commitments): per schedule of a service or platform the token owner may see, the scheduled payments dated today or later – to contract end and to the earliest exit, per fiscal year (the current one and the next four) and later – the next payment, the notice-by date and the notice warning. Scheduled payments, not liabilities: entries are not subtracted; amounts per currency, never converted, null where the token owner may not see the paying service's amounts. Notice warnings first.",
      query: CostCommitmentsQuery,
      paginated: true,
      response: {
        type: 'object',
        required: ['items', 'nextCursor'],
        additionalProperties: false,
        properties: { items: { type: 'array', items: { $ref: 'CostCommitment#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof CostCommitmentsQuery>;
      let rows;
      try {
        rows = commitments({ serviceId: q.serviceId, platformId: q.platformId, teamId: q.teamId, supplierId: q.supplierId, currency: q.currency }).rows;
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404)
          throw notFound(
            q.serviceId ? `Service ${q.serviceId}` : q.platformId ? `Platform ${q.platformId}` : q.teamId ? `Team ${q.teamId}` : `Supplier ${q.supplierId}`,
          );
        throw e;
      }
      const p = pageArray(rows, (r) => [r.warning ? 0 : 1, r.payer.name.toLowerCase(), r.title.toLowerCase(), r.scheduleId], q, {
        serviceId: q.serviceId,
        platformId: q.platformId,
        teamId: q.teamId,
        supplierId: q.supplierId,
        currency: q.currency,
      });
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );
}
