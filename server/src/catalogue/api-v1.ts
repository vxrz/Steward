import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { ItemLink } from '@sm/shared';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { linkTypeByKey } from '../records/link-types.js';
import { ServiceListQuery } from './api-schemas.js';
import * as svc from './service.js';

/**
 * The service catalogue in the public, read-only API. Every token owner may read services, as in the UI; the
 * counts and links only reflect what the owner may see (links to hidden items: visible false, no id or name).
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const map = (s: svc.ServiceEntry) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  criticality: s.criticality,
  contacts: s.contacts.map((c) => ({ role: c.role, email: c.email, name: c.name ?? null })),
  owners: s.owners,
  tags: s.tags,
  cmdb: s.cmdb,
  archived: s.archived,
  linkCount: s.linkCount,
  documentCount: s.documentCount,
  overdueDocuments: s.overdueDocuments,
  createdAt: s.createdAt,
  createdBy: s.createdBy,
  updatedAt: s.updatedAt,
  updatedBy: s.updatedBy,
});

const mapLink = (l: ItemLink) => ({
  kind: l.kind,
  targetId: l.targetId,
  url: l.url,
  linkType: l.linkType,
  linkTypeName: l.linkType ? (linkTypeByKey(l.linkType)?.name ?? null) : null,
  label: l.label,
  note: l.note,
  visible: l.visible,
});

export function serviceApiRoutes(get: Get): void {
  get(
    '/services',
    {
      operationId: 'listServices',
      tag: 'Services',
      summary: 'List services',
      description:
        'The service catalogue, ordered by name: description, criticality, contacts, responsible users and teams, tags and the CMDB entry. Counts of links and living documents only include what the token owner may see. Archived services are left out unless `archived` says otherwise.',
      query: ServiceListQuery,
      paginated: true,
      response: {
        type: 'object',
        description: 'A page of services',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'ServiceEntry#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof ServiceListQuery>;
      const list = svc
        .listServiceEntries({ archived: q.archived !== 'exclude' })
        .filter((s) => q.archived !== 'only' || s.archived)
        .map(map);
      const page = pageArray(list, (s) => [s.name.toLowerCase(), s.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/services/:serviceId',
    {
      operationId: 'getService',
      tag: 'Services',
      summary: 'Get a service with its links',
      description: 'Archived services too. Its living documents: `/services/{serviceId}/documents`.',
      params: { serviceId: 'Service id (svc_…)' },
      response: { $ref: 'ServiceEntryDetail#' },
    },
    async (req) => {
      let s;
      try {
        s = svc.getService((req.params as { serviceId: string }).serviceId);
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: 'Service not found' });
        throw e;
      }
      return { ...map(s), links: s.links.map(mapLink) };
    },
  );
}
