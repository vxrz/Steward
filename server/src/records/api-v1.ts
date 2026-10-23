import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RecordDetail, RecordSummary } from '@sm/shared';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import * as svc from './service.js';
import * as A from './api-schemas.js';

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
        'Change requests and decision records, ordered by number. Access change entries (type AC) only for administrators, auditors, approvers, their owner and who has a right on their platform.',
      query: A.RecordListQuery,
      paginated: true,
      response: pageOf('Record', 'A page of records'),
    },
    async (req, reply) => {
      const q = req.query as { type?: string; status?: string[]; tag?: string; q?: string; cursor?: string; limit: number };
      const list = svc.listRecords({ type: q.type, status: q.status, tag: q.tag, q: q.q, limit: 10000 }).map(mapRecord);
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
}
