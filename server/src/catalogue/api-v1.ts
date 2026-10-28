import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { CIA_DIMENSIONS, type ApplicationRating, type ItemLink, type ServiceProtectionNeed } from '@sm/shared';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { linkTypeByKey } from '../records/link-types.js';
import { ApplicationDocumentsQuery, ApplicationListQuery, ServiceListQuery } from './api-schemas.js';
import * as svc from './service.js';
import * as apps from './applications.js';
import { currentScale, levelLabel } from './cia.js';

/**
 * The service catalogue in the public, read-only API. Every token owner may read services, as in the UI; the
 * counts and links only reflect what the owner may see (links to hidden items: visible false, no id or name).
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

type Scale = ReturnType<typeof currentScale>;

const mapRating = (r: ApplicationRating, scale: Scale) =>
  Object.fromEntries(
    CIA_DIMENSIONS.map((d) => {
      const x = r[d];
      return [
        d,
        x
          ? {
              level: x.level,
              levelLabel: levelLabel(d, x.level, scale) ?? x.level,
              justification: x.justification,
              ratedAt: x.ratedAt,
              ratedBy: x.ratedBy,
              needsRerating: x.needsRerating,
              previousLabel: x.previousLabel,
            }
          : null,
      ];
    }),
  );

const mapNeed = (n: ServiceProtectionNeed, scale: Scale) =>
  Object.fromEntries(
    CIA_DIMENSIONS.map((d) => {
      const x = n[d];
      return [
        d,
        {
          derived: x.derived,
          derivedLabel: levelLabel(d, x.derived, scale),
          derivedFrom: x.derivedFrom,
          rated: x.rated,
          total: x.total,
          needsRerating: x.needsRerating,
          archived: x.archived,
          scaleInvalid: x.scaleInvalid,
          override: x.override ? { ...x.override, levelLabel: levelLabel(d, x.override.level, scale) ?? x.override.level } : null,
          effective: x.effective,
          effectiveLabel: levelLabel(d, x.effective, scale),
        },
      ];
    }),
  );

/** The applications of each service (id, name, role), for the public API's service list. */
function applicationsByService(): Map<string, { id: string; name: string; archived: boolean; role: string | null; roleText: string }[]> {
  const out = new Map<string, { id: string; name: string; archived: boolean; role: string | null; roleText: string }[]>();
  for (const a of apps.listApplications({ archived: true }))
    for (const s of a.services) out.set(s.id, [...(out.get(s.id) ?? []), { id: a.id, name: a.name, archived: a.archived, role: s.role, roleText: s.roleText }]);
  return out;
}

const map = (s: svc.ServiceEntry, scale: Scale, applications: Map<string, unknown[]>) => ({
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
  applications: applications.get(s.id) ?? [],
  protectionNeed: mapNeed(s.protectionNeed, scale),
  createdAt: s.createdAt,
  createdBy: s.createdBy,
  updatedAt: s.updatedAt,
  updatedBy: s.updatedBy,
});

const mapApplication = (a: apps.ApplicationEntry, scale: Scale) => ({
  id: a.id,
  name: a.name,
  description: a.description,
  vendor: a.vendor,
  version: a.version,
  url: a.url,
  criticality: a.criticality,
  owners: a.owners,
  tags: a.tags,
  cmdb: a.cmdb,
  archived: a.archived,
  services: a.services,
  integrationCount: a.integrationCount,
  rating: mapRating(a.rating, scale),
  scaleInvalid: !!scale.storedInvalid,
  documentCount: a.documentCount,
  overdueDocuments: a.overdueDocuments,
  componentCount: a.componentCount,
  createdAt: a.createdAt,
  createdBy: a.createdBy,
  updatedAt: a.updatedAt,
  updatedBy: a.updatedBy,
});

const notFound = (what: string) => new ProblemError(404, { type: 'not-found', title: 'Not found', detail: `${what} not found` });
function found<T>(f: () => T, what: string): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) throw notFound(what);
    throw e;
  }
}

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
      const scale = currentScale();
      const byService = applicationsByService();
      const list = svc
        .listServiceEntries({ archived: q.archived !== 'exclude' })
        .filter((s) => q.archived !== 'only' || s.archived)
        .map((s) => map(s, scale, byService));
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
      const s = found(() => svc.getService((req.params as { serviceId: string }).serviceId), 'Service');
      const applications = new Map([[s.id, s.applications.map((a) => ({ id: a.id, name: a.name, archived: a.archived, role: a.role, roleText: a.roleText }))]]);
      return { ...map(s, currentScale(), applications), links: s.links.map(mapLink) };
    },
  );

  // ---------- applications ----------
  get(
    '/applications',
    {
      operationId: 'listApplications',
      tag: 'Services',
      summary: 'List applications',
      description:
        'The applications of the service catalogue (what people call a platform, e.g. Insights Hub, and smaller applications), ordered by name: vendor, version, criticality, responsible users and teams, the services that consist of them, the number of mapped Steward platforms, and the CIA rating. Archived applications are left out unless `archived` says otherwise.',
      query: ApplicationListQuery,
      paginated: true,
      response: {
        type: 'object',
        description: 'A page of applications',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'ApplicationEntry#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof ApplicationListQuery>;
      const scale = currentScale();
      const list = apps
        .listApplicationEntries({ archived: q.archived !== 'exclude' })
        .filter((a) => q.archived !== 'only' || a.archived)
        .map((a) => mapApplication(a, scale));
      const page = pageArray(list, (a) => [a.name.toLowerCase(), a.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/applications/:applicationId',
    {
      operationId: 'getApplication',
      tag: 'Services',
      summary: 'Get an application with its integrations, links, components and tech stack',
      description:
        'Archived applications too. Platforms the token owner may not see are listed with visible false. Its living documents: `/applications/{applicationId}/documents`.',
      params: { applicationId: 'Application id (app_…)' },
      response: { $ref: 'ApplicationEntryDetail#' },
    },
    async (req) => {
      const a = found(() => apps.getApplication((req.params as { applicationId: string }).applicationId), 'Application');
      return {
        ...mapApplication(a, currentScale()),
        integrations: a.integrations.map((i) => ({
          visible: i.visible,
          platformId: i.platformId,
          name: i.name,
          kind: i.kind,
          environment: i.environment,
          mappedAt: i.mappedAt,
          mappedBy: i.mappedBy,
        })),
        links: a.links.map(mapLink),
        components: a.components,
        stack: a.stack,
      };
    },
  );

  get(
    '/applications/:applicationId/documents',
    {
      operationId: 'listApplicationDocuments',
      tag: 'Services',
      summary: 'Living documents that apply to an application',
      description:
        'Records of the workflow "document" whose scope names the application (e.g. an ICAM concept for Insights Hub), ordered by number, with the current edition and review status. Documents the token owner may not read are left out.',
      params: { applicationId: 'Application id (app_…)' },
      query: ApplicationDocumentsQuery,
      paginated: true,
      response: {
        type: 'object',
        description: 'A page of documents',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'ApplicationDocument#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const id = (req.params as { applicationId: string }).applicationId;
      const q = req.query as z.infer<typeof ApplicationDocumentsQuery>;
      const list = found(() => apps.getApplicationDocuments(id), 'Application');
      const page = pageArray(list, (d) => [d.number, d.id], q, { ...q, id });
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/cia-scale',
    {
      operationId: 'getCiaScale',
      tag: 'Services',
      summary: 'The CIA scale (protection need levels)',
      description:
        'The levels ratings and protection needs use, lowest first: by default the BSI IT-Grundschutz protection needs normal, high and very high; administrators can define one custom scale for all three dimensions or one per dimension.',
      response: { $ref: 'CiaScaleEntry#' },
    },
    async () => {
      const s = currentScale();
      return { mode: s.mode, levels: s.levels, updatedAt: s.updatedAt, updatedBy: s.updatedBy, storedInvalid: !!s.storedInvalid };
    },
  );
}
