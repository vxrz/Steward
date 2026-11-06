import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { DbSchemaSubjectKind } from '@sm/shared';
import { HttpError } from '../util.js';
import { notFound } from '../api/v1/helpers.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import * as svc from './service.js';
import { DbSchemaChangeListQuery, DbSchemaCompareQuery, DbSchemaExportQuery, DbSchemaSnapshotListQuery } from './api-schemas.js';

/**
 * Database schemas in the public API (#222): the snapshots of a database platform or a system, their changes, a
 * comparison of two snapshots and the exports – read-only, with the rights of the web app (a platform or system the
 * token owner may not see answers 404). The tbls import from CI is not part of this read-only API: it takes a push
 * token of its own (push.ts, POST /api/hooks/db-schema/<kind>/<id>).
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const SUBJECTS: { kind: DbSchemaSubjectKind; base: string; param: string; label: string; what: string }[] = [
  { kind: 'platform', base: '/platforms/:platformId/schema', param: 'platformId', label: 'Platform', what: 'a database platform' },
  { kind: 'system', base: '/systems/:systemId/schema', param: 'systemId', label: 'System', what: 'a system (its imported tbls schemas)' },
];

const page = (item: string, description: string) => ({
  type: 'object',
  description,
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: { $ref: `${item}#` } }, nextCursor: { type: ['string', 'null'] } },
});

/** 404 for a subject or snapshot the token owner may not see or that does not exist; 400 for a platform of another kind. */
function found<T>(f: () => T, what: string): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) throw notFound(what);
    throw e;
  }
}

const idOf = (req: FastifyRequest, param: string) => String((req.params as Record<string, string>)[param] ?? '');

export function dbSchemaApiRoutes(get: Get): void {
  for (const x of SUBJECTS) {
    const params = { [x.param]: `${x.label} id` };
    get(
      `${x.base}/snapshots`,
      {
        operationId: `list${x.label}SchemaSnapshots`,
        tag: 'Database schemas',
        summary: `List the schema snapshots of ${x.what}`,
        description:
          'Newest first. A snapshot is stored for every read or tbls import that found a schema other than the latest one (otherwise its `checkedAt` moves on). Older snapshots go by the retention of the database (Schema → Settings).',
        params,
        query: DbSchemaSnapshotListQuery,
        paginated: true,
        response: page('DbSchemaSnapshot', 'A page of snapshots'),
      },
      async (req, reply) => {
        const q = req.query as z.infer<typeof DbSchemaSnapshotListQuery>;
        const id = idOf(req, x.param);
        const list = found(() => svc.listSnapshots(x.kind, id), `${x.label} ${id}`);
        const p = pageArray(list, (s) => [-Date.parse(s.takenAt), s.id], q, { id });
        linkNext(req, reply, p.nextCursor);
        return p;
      },
    );
    get(
      `${x.base}/snapshots/:snapshotId`,
      {
        operationId: `get${x.label}SchemaSnapshot`,
        tag: 'Database schemas',
        summary: `Get a schema snapshot of ${x.what}`,
        description:
          '`latest` for the newest one. With the schema (tables, columns, keys, indexes, comments), the findings of tbls lint and the changes against the snapshot before.',
        params: { ...params, snapshotId: 'Snapshot id, or latest' },
        response: { $ref: 'DbSchemaSnapshotDetail#' },
      },
      async (req) => {
        const id = idOf(req, x.param);
        const snap = idOf(req, 'snapshotId');
        return found(() => svc.getSnapshot(x.kind, id, snap), `Snapshot ${snap}`);
      },
    );
    get(
      `${x.base}/snapshots/:snapshotId/export`,
      {
        operationId: `export${x.label}SchemaSnapshot`,
        tag: 'Database schemas',
        summary: `Export a schema snapshot of ${x.what}`,
        description:
          'DBML (opens in dbdiagram, drawDB, ChartDB), SQL DDL in the dialect of the source (standard SQL for databases Steward does not speak), or the schema as JSON. `latest` for the newest snapshot.',
        params: { ...params, snapshotId: 'Snapshot id, or latest' },
        query: DbSchemaExportQuery,
        response: {
          content: {
            'text/plain': { schema: { type: 'string', description: 'DBML' } },
            'application/sql': { schema: { type: 'string', description: 'SQL DDL' } },
            'application/json': { schema: { $ref: 'DbSchemaDocument#' } },
          },
        },
      },
      async (req, reply) => {
        const id = idOf(req, x.param);
        const snap = idOf(req, 'snapshotId');
        const { format } = req.query as z.infer<typeof DbSchemaExportQuery>;
        const f = found(() => svc.exportSnapshot(x.kind, id, snap, format), `Snapshot ${snap}`);
        reply.header('content-disposition', `attachment; filename="${f.fileName}"`);
        return reply.type(f.contentType).send(f.body);
      },
    );
    get(
      `${x.base}/changes`,
      {
        operationId: `list${x.label}SchemaChanges`,
        tag: 'Database schemas',
        summary: `List the schema changes of ${x.what}`,
        description:
          'One entry per snapshot that has one before it, newest first: added, removed and changed tables, columns (type, null, default), keys and indexes, each marked breaking or not (removed table or column, narrowed or other type, NOT NULL without a default, removed key).',
        params,
        query: DbSchemaChangeListQuery,
        paginated: true,
        response: page('DbSchemaChangeSet', 'A page of change sets'),
      },
      async (req, reply) => {
        const q = req.query as z.infer<typeof DbSchemaChangeListQuery>;
        const id = idOf(req, x.param);
        const list = found(() => svc.listChangeSets(x.kind, id, { since: q.since, breaking: q.breaking }), `${x.label} ${id}`);
        const p = pageArray(list, (s) => [-Date.parse(s.snapshot.takenAt), s.snapshot.id], q, { id, since: q.since, breaking: q.breaking });
        linkNext(req, reply, p.nextCursor);
        return p;
      },
    );
    get(
      `${x.base}/compare`,
      {
        operationId: `compare${x.label}SchemaSnapshots`,
        tag: 'Database schemas',
        summary: `Compare two schema snapshots of ${x.what}`,
        description: 'The changes from `from` to `to`, with the same rules as the change list.',
        params,
        query: DbSchemaCompareQuery,
        response: { $ref: 'DbSchemaComparison#' },
      },
      async (req) => {
        const q = req.query as z.infer<typeof DbSchemaCompareQuery>;
        return found(() => svc.compareSnapshots(x.kind, idOf(req, x.param), q.from, q.to), 'Snapshot');
      },
    );
  }
}
