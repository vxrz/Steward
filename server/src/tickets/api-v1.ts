import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { TicketDetail, TicketReference } from '@sm/shared';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { TicketListQuery } from './api-schemas.js';
import * as svc from './service.js';

/** Ticket references in the public, read-only API. Every token owner may read them, as in the UI. */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const map = (t: TicketReference) => ({
  id: t.id,
  source: t.source,
  sourceLabel: t.sourceLabel,
  vendorSource: t.vendorSource,
  externalNumber: t.externalNumber,
  externalUrl: t.externalUrl,
  title: t.title,
  note: t.note,
  vendor: t.vendor,
  responsible: t.responsible,
  status: t.status,
  openedAt: t.openedAt,
  resolvedAt: t.resolvedAt,
  lastCheckedAt: t.lastCheckedAt,
  ageDays: t.ageDays,
  affected: t.links.map((l) => ({ kind: l.kind ?? 'external', targetId: l.targetId, label: l.label, visible: l.visible })),
  createdAt: t.createdAt,
  createdBy: t.createdBy,
  updatedAt: t.updatedAt,
  updatedBy: t.updatedBy,
});

const mapDetail = (t: TicketDetail) => ({
  ...map(t),
  history: t.events.map((e) => ({ ts: e.ts, actor: e.actor, kind: e.kind, fromStatus: e.fromStatus, toStatus: e.toStatus, comment: e.comment })),
});

export function ticketApiRoutes(get: Get): void {
  get(
    '/ticket-references',
    {
      operationId: 'listTicketReferences',
      tag: 'Ticket references',
      summary: 'List ticket references',
      description:
        'Tickets in other systems that Steward documents: ServiceNow incidents users reported and tickets with vendors – source, number, link, status, responsible people and the affected services, platforms, credentials and records. Newest first.',
      query: TicketListQuery,
      paginated: true,
      response: {
        type: 'object',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'TicketReferenceEntry#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof TicketListQuery>;
      const list = svc.listTickets({ status: q.status, state: q.state, source: q.source, vendor: q.vendor, link: q.affected, q: q.q }).map(map);
      const page = pageArray(list, (t) => [-Date.parse(t.openedAt), t.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/ticket-references/:ticketId',
    {
      operationId: 'getTicketReference',
      tag: 'Ticket references',
      summary: 'Get a ticket reference with its history',
      params: { ticketId: 'Entry id (tkt_…)' },
      response: { $ref: 'TicketReferenceDetail#' },
    },
    async (req) => {
      try {
        return mapDetail(svc.getTicket((req.params as { ticketId: string }).ticketId));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404)
          throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: 'Ticket reference not found' });
        throw e;
      }
    },
  );
}
