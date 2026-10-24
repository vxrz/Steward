import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { EDITION_RE, type RecordDetail, type RecordEdition, type RecordEditionSummary, type RecordSummary, type ReviewStatus } from '@sm/shared';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import * as svc from './service.js';
import * as docs from './documents.js';
import * as A from './api-schemas.js';
import * as catalogue from '../catalogue/service.js';

/** Records in the public, read-only API (list, get, versions). Every token owner may read records, as in the UI – access change entries only who may read them there. */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const params = (req: FastifyRequest) => req.params as Record<string, string>;

function found<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: `${what} not found` });
    throw e;
  }
}

const mapRecord = (r: RecordSummary) => ({
  id: r.id,
  number: r.number,
  typeKey: r.typeKey,
  typeName: r.typeName,
  workflow: r.workflow,
  title: r.title,
  status: r.status,
  tags: r.tags,
  owner: r.owner,
  revision: r.revision,
  version: r.version,
  createdAt: r.createdAt,
  createdBy: r.createdBy,
  updatedAt: r.updatedAt,
  updatedBy: r.updatedBy,
  edition: r.edition ?? null,
  reviewStatus: r.reviewStatus ?? null,
  nextReviewAt: r.nextReviewAt ?? null,
});

const mapEdition = (e: RecordEditionSummary) => ({
  edition: e.edition,
  kind: e.kind,
  revision: e.revision,
  version: e.version,
  title: e.title,
  contentHash: e.contentHash,
  changeSummary: e.changeSummary,
  authors: e.authors,
  submittedBy: e.submittedBy,
  submittedAt: e.submittedAt,
  approvedBy: e.approvedBy,
  approvedAt: e.approvedAt,
  current: e.current,
  intact: e.intact,
});

const mapDetail = (r: RecordDetail) => ({
  ...mapRecord(r),
  body: r.body,
  fields: r.fields,
  contentHash: r.contentHash,
  frozenHash: r.frozenHash,
  frozen: r.frozen,
  submittedBy: r.submittedBy,
  submittedAt: r.submittedAt,
  supersededBy: r.supersededBy,
  attachments: r.attachments.map(({ details: _d, ...a }) => a),
  links: r.links.map((l) => ({ kind: l.kind, targetId: l.targetId, url: l.url, label: l.label, note: l.note, visible: l.visible })),
  events: r.events.map(({ id: _id, ...e }) => e),
  document: r.document
    ? {
        currentEdition: r.document.currentEdition,
        pending: r.document.pending,
        review: {
          status: r.document.review.status,
          intervalMonths: r.document.review.intervalMonths,
          owner: r.document.review.owner,
          lastReviewedAt: r.document.review.lastReviewedAt,
          lastReviewedBy: r.document.review.lastReviewedBy,
          nextReviewAt: r.document.review.nextReviewAt,
          daysLeft: r.document.review.daysLeft,
          updateRequestedAt: r.document.review.updateRequestedAt,
        },
      }
    : null,
});

const ref = (name: keyof typeof A.RECORD_COMPONENTS & string) => ({ $ref: `${name}#` });
const pageOf = (name: keyof typeof A.RECORD_COMPONENTS & string, description: string) => ({
  type: 'object',
  description,
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', items: ref(name) },
    nextCursor: { type: ['string', 'null'], description: 'Opaque cursor for the next page; null on the last page.' },
  },
  additionalProperties: false,
});

export async function recordApiRoutes(_app: FastifyInstance, get: Get): Promise<void> {
  get(
    '/records',
    {
      operationId: 'listRecords',
      tag: 'Records',
      summary: 'List records',
      description:
        'Change requests, decision records and living documents, ordered by number. Access change entries (type AC) only for administrators, auditors, approvers, their owner and who has a right on their platform.',
      query: A.RecordListQuery,
      paginated: true,
      response: pageOf('Record', 'A page of records'),
    },
    async (req, reply) => {
      const q = req.query as {
        type?: string;
        status?: string[];
        tag?: string;
        q?: string;
        workflow?: string;
        reviewStatus?: ReviewStatus[];
        cursor?: string;
        limit: number;
      };
      const list = svc
        .listRecords({ type: q.type, status: q.status, tag: q.tag, q: q.q, workflow: q.workflow, review: q.reviewStatus, limit: 10000 })
        .map(mapRecord);
      const page = pageArray(list, (r) => [r.number, r.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/records/:recordId',
    {
      operationId: 'getRecord',
      tag: 'Records',
      summary: 'Get a record with its content, links, attachments and history',
      params: { recordId: 'Record id or number' },
      response: ref('RecordDetail'),
    },
    async (req) => mapDetail(found(() => svc.getRecord(params(req).recordId!), `Record ${params(req).recordId}`)),
  );

  get(
    '/records/:recordId/versions',
    {
      operationId: 'listRecordVersions',
      tag: 'Records',
      summary: 'Versions of a record',
      description: 'Every saved change of title, text or fields, newest first.',
      params: { recordId: 'Record id or number' },
      query: A.RecordVersionsQuery,
      paginated: true,
      response: pageOf('RecordVersion', 'A page of versions'),
    },
    async (req, reply) => {
      const id = params(req).recordId!;
      const q = req.query as { cursor?: string; limit: number };
      const versions = found(() => svc.listVersions(id), `Record ${id}`);
      const page = pageArray(versions, (v) => [-v.version], q, { ...q, id });
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/records/:recordId/editions',
    {
      operationId: 'listRecordEditions',
      tag: 'Records',
      summary: 'Editions of a living document',
      description:
        'Approved editions (1.0, 1.1, 2.0) of a record of the workflow "document", newest first, each with its content hash and approval. Empty for other records.',
      params: { recordId: 'Record id or number' },
      query: A.RecordEditionsQuery,
      paginated: true,
      response: pageOf('RecordEditionSummary', 'A page of editions'),
    },
    async (req, reply) => {
      const id = params(req).recordId!;
      const q = req.query as { cursor?: string; limit: number };
      const list = found(() => docs.listEditions(id), `Record ${id}`).map(mapEdition);
      const page = pageArray(list, (e) => [-(Number(e.edition.split('.')[0]) * 100000 + Number(e.edition.split('.')[1]))], q, { ...q, id });
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/records/:recordId/editions/:edition',
    {
      operationId: 'getRecordEdition',
      tag: 'Records',
      summary: 'One frozen edition of a living document',
      description: 'Title, text, fields and files of the edition as approved, with its content hash.',
      params: { recordId: 'Record id or number', edition: 'Edition, e.g. 1.0' },
      response: ref('RecordEdition'),
      errors: [409],
    },
    async (req) => {
      const { recordId, edition } = params(req) as { recordId: string; edition: string };
      if (!EDITION_RE.test(edition)) throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: `Edition ${edition} not found` });
      const e: RecordEdition = found(() => docs.getEdition(recordId, edition), `Edition ${edition} of ${recordId}`);
      return { ...mapEdition(e), body: e.body, fields: e.fields, attachments: e.attachments };
    },
  );

  get(
    '/services/:serviceId/documents',
    {
      operationId: 'listServiceDocuments',
      tag: 'Records',
      summary: 'Living documents of a service',
      description:
        'Records of the workflow "document" that link to the service or that the service links to, ordered by number, each with its current edition and review status. Documents the token owner may not read are left out.',
      params: { serviceId: 'Service id' },
      query: A.ServiceDocumentsQuery,
      paginated: true,
      response: pageOf('ServiceDocument', 'A page of documents'),
    },
    async (req, reply) => {
      const id = params(req).serviceId!;
      const q = req.query as { cursor?: string; limit: number };
      const list = found(() => catalogue.getServiceDocuments(id), `Service ${id}`);
      const page = pageArray(list, (d) => [d.number, d.id], q, { ...q, id });
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/records/:recordId/reviews',
    {
      operationId: 'listRecordReviews',
      tag: 'Records',
      summary: 'Periodic reviews of a living document',
      description: 'Reviews ("Reviewed – no change", "Needs update"), newest first. The review status is part of the record (document.review).',
      params: { recordId: 'Record id or number' },
      query: A.RecordReviewsQuery,
      paginated: true,
      response: pageOf('RecordReview', 'A page of reviews'),
    },
    async (req, reply) => {
      const id = params(req).recordId!;
      const q = req.query as { cursor?: string; limit: number };
      const list = found(() => docs.listReviews(id), `Record ${id}`);
      const page = pageArray(list, (v) => [-Date.parse(v.createdAt), v.id], q, { ...q, id });
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );
}
