import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dbSchemaImportInput, DB_SCHEMA_LIMITS, type DbSchemaSubjectKind } from '@sm/shared';
import { HttpError } from '../util.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { notFound } from '../api/v1/helpers.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import { schemaOf, type Op } from '../api/v1/routes.js';
import type { ApiPrincipal } from '../api/v1/auth.js';
import * as svc from './service.js';
import { DbSchemaChangeListQuery, DbSchemaCompareQuery, DbSchemaExportQuery, DbSchemaSnapshotListQuery } from './api-schemas.js';

/**
 * Database schemas in the public API (#222): the snapshots of a database platform or a system, their changes, a
 * comparison of two snapshots and the exports – read-only, with the rights of the web app (a platform or system the
 * token owner may not see answers 404). One endpoint changes data: the tbls import from CI
 * (`POST …/schema/tbls`), which needs a token with scope full and the right to import.
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

export async function dbSchemaApiRoutes(app: FastifyInstance, get: Get): Promise<void> {
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

  // ---------- the tbls import (from CI): the file itself, or { schema, lint, fileName } ----------
  const bodyLimit = LARGE_BODIES.dbSchemaImport.bytes;
  await app.register(async (sub) => {
    // the body is kept as text: its SHA-256 is that of the file as sent
    sub.removeContentTypeParser(['application/json', 'text/plain']);
    sub.addContentTypeParser(['application/json', 'text/plain'], { parseAs: 'string', bodyLimit }, (_req, body, done) => done(null, body));
    for (const x of SUBJECTS) {
      const url = `${x.base}/tbls`;
      const op: Op = {
        operationId: `import${x.label}TblsSchema`,
        tag: 'Database schemas',
        summary: `Import a tbls schema.json for ${x.what}`,
        description: `The one endpoint of the API that changes data; it needs a token with scope **full** (a read token gets 403 \`token-scope\`) whose owner may import (the platform's manage right, or the right to change the system). The body is the file of \`tbls out -t json\` as it is (Content-Type application/json, at most ${DB_SCHEMA_LIMITS.importBytes / 1024 / 1024} MB) – or \`{ "schema": "<the file as text>", "lint": "<output of tbls lint>", "fileName": "schema.json" }\` to add the findings of tbls lint. The file is checked against the tbls JSON format and recorded in the audit log with its SHA-256; a schema that equals the latest snapshot adds none.`,
        params: { [x.param]: `${x.label} id` },
        response: { $ref: 'DbSchemaImportResult#' },
        errors: [400, 404, 409],
      };
      sub.post(
        url,
        {
          schema: {
            ...schemaOf(op),
            body: {
              description: 'The tbls schema.json, or { schema, lint, fileName }',
              type: 'object',
              additionalProperties: true,
            },
          },
          config: { smAuth: 'token' },
          bodyLimit,
          // the body is text (its hash is recorded); it is checked by the tbls parser, not by the route schema
          validatorCompiler: () => () => true,
        },
        async (req) => {
          const p = (req as unknown as { smApi: ApiPrincipal }).smApi;
          if (p.scope !== 'full')
            throw new ProblemError(403, {
              type: 'token-scope',
              title: 'Forbidden',
              detail: 'Importing a schema changes data – use a token with scope "full" (this one is read-only)',
            });
          const id = z.string().min(1).max(200).parse(idOf(req, x.param));
          // who may not import learns nothing from the body
          found(() => svc.assertCanImport(x.kind, id), `${x.label} ${id}`);
          const raw = typeof req.body === 'string' ? req.body : '';
          if (!raw.trim()) throw new HttpError(400, 'The body is empty – send the tbls schema.json', 'DB_SCHEMA_TBLS_INVALID');
          const input = envelope(raw);
          const r = found(() => svc.importTbls(x.kind, id, input, 'api'), `${x.label} ${id}`);
          return { snapshot: r.snapshot, created: r.created, diff: r.diff, warnings: r.warnings };
        },
      );
    }
  });
}

/** `{ "schema": "<text>", "lint": … }` around the file, or the file itself. */
function envelope(raw: string): z.infer<typeof dbSchemaImportInput> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    // not JSON: the tbls parser says so with its own message
    return { schema: raw };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'schema' in parsed && !('tables' in parsed)) {
    const o = parsed as Record<string, unknown>;
    // the schema as a JSON object instead of its text: hashed as sent in this body
    const schema = o.schema && typeof o.schema === 'object' ? JSON.stringify(o.schema) : o.schema;
    const r = dbSchemaImportInput.safeParse({ schema, lint: o.lint, fileName: o.fileName });
    if (!r.success)
      throw new HttpError(400, `Not an import of a tbls schema: ${r.error.issues[0]!.path.join('.')} ${r.error.issues[0]!.message}`, 'DB_SCHEMA_TBLS_INVALID');
    return r.data;
  }
  return { schema: raw };
}
