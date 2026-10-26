import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { DutyPeriod, DutySummary } from '@sm/shared';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { DutyListQuery, DutyPeriodsQuery } from './api-schemas.js';
import { getDuty, listDuties } from './service.js';

/**
 * Service duties in the public, read-only API: everyone who can sign in reads them, as services; names of processes
 * the token owner may not view are left out. The stored periods are what the service scorecard reads.
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const mapPeriod = (p: DutyPeriod) => ({
  key: p.key,
  start: p.start,
  end: p.end,
  graceEndsAt: p.graceEndsAt,
  status: p.status,
  closed: p.closed,
  closedAt: p.closedAt,
  inGrace: p.inGrace,
  run: p.run,
  failedRuns: p.failedRuns,
  runsInProgress: p.runsInProgress,
  skip: p.skip
    ? {
        id: p.skip.id,
        periodKey: p.skip.periodKey,
        status: p.skip.status,
        reason: p.skip.reason,
        requestedBy: p.skip.requestedBy,
        requestedAt: p.skip.requestedAt,
        decidedBy: p.skip.decidedBy,
        decidedAt: p.skip.decidedAt,
        comment: p.skip.comment,
      }
    : null,
  snapshot: p.snapshot,
});

const map = (d: DutySummary) => ({
  id: d.id,
  serviceId: d.serviceId,
  serviceName: d.serviceName,
  applicationId: d.applicationId,
  applicationName: d.applicationName,
  name: d.name,
  description: d.description,
  processId: d.processId,
  processName: d.processName,
  scheduleId: d.schedule?.id ?? null,
  interval: d.interval,
  level: d.level,
  graceDays: d.graceDays,
  remindDays: d.remindDays,
  owners: d.owners,
  archived: d.archived,
  timeZone: d.timeZone,
  current: d.current ? mapPeriod(d.current) : null,
  previous: d.previous ? mapPeriod(d.previous) : null,
  pendingSkips: d.pendingSkips,
  createdAt: d.createdAt,
  createdBy: d.createdBy,
  updatedAt: d.updatedAt,
  updatedBy: d.updatedBy,
});

function found<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: 'Duty not found' });
    throw e;
  }
}

export function dutyApiRoutes(get: Get): void {
  get(
    '/duties',
    {
      operationId: 'listDuties',
      tag: 'Services',
      summary: 'List service duties',
      description:
        'Recurring tasks of services (an access review every quarter, a restore test every month): the process whose real runs count, the interval of calendar periods in the instance time zone, the level, the grace period, the owners, and the status of the current and the previous period. Ordered by service and name. Archived duties are left out unless `archived` says otherwise.',
      query: DutyListQuery,
      paginated: true,
      response: {
        type: 'object',
        description: 'A page of duties',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'DutyEntry#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof DutyListQuery>;
      const list = listDuties({ serviceId: q.serviceId, applicationId: q.applicationId, archived: q.archived !== 'exclude' })
        .filter((d) => (q.archived !== 'only' || d.archived) && (!q.level || d.level === q.level))
        .map(map);
      const page = pageArray(list, (d) => [d.serviceName.toLowerCase(), d.name.toLowerCase(), d.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/duties/:dutyId',
    {
      operationId: 'getDuty',
      tag: 'Services',
      summary: 'Get a service duty',
      description: 'Archived duties too. All its periods: `/duties/{dutyId}/periods`.',
      params: { dutyId: 'Duty id (dty_…)' },
      response: { $ref: 'DutyEntry#' },
    },
    async (req) => map(found(() => getDuty((req.params as { dutyId: string }).dutyId))),
  );

  get(
    '/duties/:dutyId/periods',
    {
      operationId: 'listDutyPeriods',
      tag: 'Services',
      summary: 'Periods of a service duty',
      description:
        'Newest first: the open periods (evaluated now) and every stored period. A closed period keeps its status and what it was judged against (name, level, interval, grace period, process name) – later changes of the duty or the process do not change it.',
      params: { dutyId: 'Duty id (dty_…)' },
      query: DutyPeriodsQuery,
      paginated: true,
      response: {
        type: 'object',
        description: 'A page of periods',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'DutyPeriodEntry#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const id = (req.params as { dutyId: string }).dutyId;
      const q = req.query as z.infer<typeof DutyPeriodsQuery>;
      const d = found(() => getDuty(id));
      const list = d.periods
        .filter(
          (p) =>
            (!q.status || p.status === q.status) &&
            (q.closed === undefined || p.closed === q.closed) &&
            (!q.from || Date.parse(p.end) > Date.parse(q.from)) &&
            (!q.to || Date.parse(p.start) < Date.parse(q.to)),
        )
        .map(mapPeriod);
      const page = pageArray(list, (p) => [-Date.parse(p.start), p.key], q, { ...q, id });
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );
}
