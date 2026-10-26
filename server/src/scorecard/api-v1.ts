import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { ObjectiveSummary, ServiceScorecard } from '@sm/shared';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { ObjectiveListQuery, ObjectiveSamplesQuery, ScorecardTrendQuery } from './api-schemas.js';
import { listObjectives, objectiveRow, objectiveSamples } from './objectives.js';
import { scorecardOverview, scorecardTrend, serviceScorecard } from './scorecard.js';

/**
 * Availability objectives and the service scorecard in the public, read-only API (#86): everyone who can sign in
 * reads them, as services; the Gatus platform and endpoint of an objective only for token owners who may see the
 * platform, and documents only when the token owner may read them.
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const mapObjective = (o: ObjectiveSummary) => ({
  id: o.id,
  serviceId: o.serviceId,
  serviceName: o.serviceName,
  applicationId: o.applicationId,
  applicationName: o.applicationName,
  name: o.name,
  description: o.description,
  platformVisible: o.platformVisible,
  platformId: o.platformId,
  platformName: o.platformName,
  endpointKey: o.endpointKey,
  endpointName: o.endpointName,
  targets: o.targets,
  windows: o.windows,
  status: o.status,
  noDataReason: o.noDataReason,
  valuesAt: o.valuesAt,
  notify: o.notify,
  breach: o.breach,
  createdAt: o.createdAt,
  createdBy: o.createdBy,
  updatedAt: o.updatedAt,
  updatedBy: o.updatedBy,
});

const mapCard = (c: ServiceScorecard) => ({
  serviceId: c.serviceId,
  serviceName: c.serviceName,
  owners: c.owners,
  criticality: c.criticality,
  attention: c.attention,
  duties: c.duties,
  availability: c.availability,
  documentation: c.documentation,
  protection: c.protection,
});

function found<T>(f: () => T, what: string): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && (e.statusCode === 404 || e.statusCode === 409))
      throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: `${what} not found` });
    throw e;
  }
}

const page = (ref: string, description: string) => ({
  type: 'object',
  description,
  required: ['items', 'nextCursor'],
  properties: { items: { type: 'array', items: { $ref: `${ref}#` } }, nextCursor: { type: ['string', 'null'] } },
  additionalProperties: false,
});

export function scorecardApiRoutes(get: Get): void {
  get(
    '/scorecard',
    {
      operationId: 'getScorecard',
      tag: 'Services',
      summary: 'The service scorecard',
      description:
        'Per service (not archived) four parts, each with its own status – duties, availability objectives, documentation, protection need – and `attention` when any part needs attention (no weighting). With the rollup overall and per owner (a user or a team). Documents the token owner may not read do not count.',
      response: { $ref: 'ScorecardEntry#' },
    },
    async () => {
      const o = scorecardOverview();
      return { generatedAt: o.generatedAt, services: o.services.map(mapCard), rollup: o.rollup };
    },
  );

  get(
    '/scorecard/trend',
    {
      operationId: 'getScorecardTrend',
      tag: 'Services',
      summary: 'Trend of the service scorecard',
      description:
        'The rollup of the stored daily snapshots, oldest first: how many services needed attention on each day, per part. A snapshot is written during its day and never after, so the trend does not change with later data.',
      query: ScorecardTrendQuery,
      response: {
        type: 'object',
        description: 'One entry per stored day',
        required: ['items'],
        properties: { items: { type: 'array', items: { $ref: 'ScorecardTrendEntry#' } } },
        additionalProperties: false,
      },
    },
    async (req) => {
      const q = req.query as z.infer<typeof ScorecardTrendQuery>;
      return { items: scorecardTrend({ days: q.days, owner: q.owner }) };
    },
  );

  get(
    '/services/:serviceId/scorecard',
    {
      operationId: 'getServiceScorecard',
      tag: 'Services',
      summary: 'The scorecard of a service',
      description: 'Its four parts with their details, and the stored daily snapshots of the last 90 days.',
      params: { serviceId: 'Service id (svc_…)' },
      response: { $ref: 'ServiceScorecardEntry#' },
    },
    async (req) => {
      const c = found(() => serviceScorecard((req.params as { serviceId: string }).serviceId), 'Service');
      return { ...mapCard(c), history: c.history };
    },
  );

  get(
    '/objectives',
    {
      operationId: 'listObjectives',
      tag: 'Services',
      summary: 'List availability objectives',
      description:
        "Targets per Gatus endpoint for the windows Gatus reports (1 h, 24 h, 7 d, 30 d), attached to a service or one of its applications, with Gatus' current uptime figures and the status per window: met, below target or no data. Objectives of archived services are left out.",
      query: ObjectiveListQuery,
      paginated: true,
      response: page('ObjectiveEntry', 'A page of objectives'),
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof ObjectiveListQuery>;
      const list = listObjectives({ serviceId: q.serviceId, applicationId: q.applicationId })
        .filter((o) => !q.status || o.status === q.status)
        .map(mapObjective);
      const p = pageArray(list, (o) => [o.serviceName.toLowerCase(), o.name.toLowerCase(), o.id], q, q);
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );

  get(
    '/objectives/:objectiveId/samples',
    {
      operationId: 'listObjectiveSamples',
      tag: 'Services',
      summary: 'Hourly samples of an availability objective',
      description: "Newest first: the values Steward had read from Gatus at each hour, with the objective's status then (kept 90 days).",
      params: { objectiveId: 'Objective id (obj_…)' },
      query: ObjectiveSamplesQuery,
      paginated: true,
      response: page('ObjectiveSampleEntry', 'A page of samples'),
    },
    async (req, reply) => {
      const id = (req.params as { objectiveId: string }).objectiveId;
      const q = req.query as z.infer<typeof ObjectiveSamplesQuery>;
      found(() => objectiveRow(id), 'Objective');
      const norm = (x?: string) => (x ? new Date(x).toISOString() : undefined);
      const list = objectiveSamples(id, { from: norm(q.from), to: norm(q.to) });
      const p = pageArray(list, (s) => [-Date.parse(s.at)], q, { ...q, id });
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );
}
