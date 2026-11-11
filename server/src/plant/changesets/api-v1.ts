import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MCP_REQUEST_LIMITS, PLANT_PROPOSAL_LIMITS, boundedRecord, type PlantChangeSetSummary } from '@sm/shared';
import { db } from '../../db.js';
import { config } from '../../config.js';
import type { AuthUser } from '../../auth/context.js';
import { me } from '../../auth/access.js';
import { HttpError, parseJson } from '../../util.js';
import { LARGE_BODIES } from '../../bodyLimits.js';
import type { Get } from '../../api/v1/helpers.js';
import { ProblemError } from '../../api/v1/problem.js';
import { OPERATION_ERRORS, schemaOf } from '../../api/v1/routes.js';
import { decodeCursor, encodeCursor, linkNext, pageArray } from '../../api/v1/pagination.js';
import * as S from '../../api/v1/schemas.js';
import type { ApiPrincipal } from '../../api/v1/auth.js';
import { siteRights } from '../access.js';
import { requirePlant } from '../settings.js';
import { found } from '../api-v1.js';
import { PlantChangeOperationListQuery, PlantChangeSetListQuery } from '../api-schemas.js';
import { ApiProposalRefused, proposeViaApi } from '../proposals.js';
import { canSee, expireChangeSets, isAuthor, operationsFor, opsOf, rowOf, summariesOf, visibleRow, type CsRow } from './core.js';
import { notifyProposed } from './notify.js';

/**
 * Change sets in the public API (0.19.0, ADR 0020 "Built in 0.19.0", docs/PLANT.md "Change sets"): read them – the list,
 * one with its status, its operations – with the token owner's sight (drafts only their own; operations of sites they
 * may not see left out and counted), and propose changes from a CI job: `POST /plant/proposals` with a token of the
 * scope _Full access_ lands for review exactly as an assistant's proposal does – never applied by the call.
 */

const MODULE = 'Only while the plant registry module is on (Settings → Modules); otherwise 404.';
const page = (name: string, description: string) => ({
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  description,
  properties: { items: { type: 'array', items: { $ref: `${name}#` } }, nextCursor: { type: ['string', 'null'] } },
});

/** Rows read per round of a page of change sets (the token owner's sight is checked on each). */
const SCAN = 500;
const ROUNDS = 10;

type Entry = Omit<PlantChangeSetSummary, 'mcpRequestId'> & { counts: Record<string, number> | null; path: string };

const entriesOf = (rows: CsRow[], u: AuthUser): Entry[] =>
  summariesOf(rows, u).map((s, i) => {
    const { mcpRequestId: _m, ...rest } = s;
    const r = rows[i]!;
    return { ...rest, counts: r.state === 'applied' ? parseJson<Record<string, number> | null>(r.counts, null) : null, path: `/plant/changes/${r.id}` };
  });

/** The body of POST /plant/proposals. */
const ProposalBody = z
  .object({
    title: z.string().trim().min(3).max(PLANT_PROPOSAL_LIMITS.title).describe('What the changes are, in a few words'),
    rationale: z.string().trim().min(5).max(MCP_REQUEST_LIMITS.reason).describe('Why, and where the information comes from – the reviewer sees it'),
    document: boundedRecord(z.unknown(), 64).describe(
      `A document of the plant import format (docs/plant/plant-registry-1.schema.json), version 1 – adding and changing only; at most ${PLANT_PROPOSAL_LIMITS.totalBytes / 1024 / 1024} MB`,
    ),
  })
  .strict();

/** Keys of an import that remove, rename or replace: never in a proposal (the words of the MCP tool). */
const REFUSED = new Set(['remove', 'removeMissing', 'cascade', 'idMap', 'renames', 'rename', 'mode', 'missing', 'replaces']);

/** The body as documented and checked: the import's keys that remove, rename or replace are named – and refused. */
function proposalBodySchema(): Record<string, unknown> {
  const js = S.toJsonSchema(ProposalBody, 'input') as { properties?: Record<string, unknown> };
  return {
    ...js,
    properties: {
      ...js.properties,
      ...Object.fromEntries([...REFUSED].map((k) => [k, { not: {}, description: 'Not part of a proposal: it only adds and changes (refused)' }])),
    },
  };
}

export function changeSetApiRoutes(get: Get, app: FastifyInstance): void {
  get(
    '/plant/change-sets',
    {
      operationId: 'listPlantChangeSets',
      tag: 'Plant',
      summary: 'List change sets of the plant registry',
      description: `Change sets – drafts, proposals, applied and closed ones – newest first, as the token owner may see them: their own drafts, and the others of sites they see (docs/PLANT.md "Change sets"). ${MODULE}`,
      query: PlantChangeSetListQuery,
      paginated: true,
      response: page('PlantChangeSetEntry', 'A page of change sets'),
    },
    (req, reply) => {
      const q = req.query as z.infer<typeof PlantChangeSetListQuery>;
      const { limit, cursor, ...filters } = q;
      found(() => requirePlant(), 'Plant registry');
      expireChangeSets();
      const u = me();
      const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
      const after = decodeCursor(cursor, filters) as [string, string] | undefined;
      // newest first, read in rounds: only what the token owner may see is kept (and counted)
      const out: CsRow[] = [];
      let key: [string, string] | undefined = after;
      let exhausted = false;
      for (let round = 0; round < ROUNDS && out.length <= limit && !exhausted; round++) {
        const where: string[] = [];
        const params: unknown[] = [];
        if (filters.state) {
          where.push('state = ?');
          params.push(filters.state);
        }
        if (filters.source) {
          where.push('source = ?');
          params.push(filters.source);
        }
        if (key) {
          where.push('(created_at < ? OR (created_at = ? AND id < ?))');
          params.push(key[0], key[0], key[1]);
        }
        const rows = db().all<CsRow>(
          `SELECT * FROM plant_change_sets${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${SCAN}`,
          ...params,
        );
        exhausted = rows.length < SCAN;
        for (const r of rows) {
          key = [r.created_at, r.id];
          if (!canSee(r, u, rights)) continue;
          if (filters.mine && !isAuthor(r, u)) continue;
          if (filters.site && !parseJson<string[]>(r.sites, []).includes(filters.site)) continue;
          out.push(r);
          if (out.length > limit) break;
        }
      }
      const items = out.slice(0, limit);
      const last = items.at(-1);
      // more after this page: the next one starts after its last item – or, when the rounds ran out, after what was read
      const nextCursor = out.length > limit && last ? encodeCursor([last.created_at, last.id], filters) : !exhausted && key ? encodeCursor(key, filters) : null;
      linkNext(req, reply, nextCursor);
      return { items: entriesOf(items, u), nextCursor };
    },
  );

  get(
    '/plant/change-sets/:changeSetId',
    {
      operationId: 'getPlantChangeSet',
      tag: 'Plant',
      summary: 'Get a change set and its status',
      description: `Its state (proposed, applied, rejected …), who wrote, proposed and decided it, whether a second person applies it, the reviewer’s comment and what it changed once applied. A change set the token owner may not see answers 404. ${MODULE}`,
      params: { changeSetId: 'Change set id (pcs_…)' },
      response: { $ref: 'PlantChangeSetDetailEntry#' },
    },
    (req) => {
      const u = me();
      const r = found(() => visibleRow((req.params as { changeSetId: string }).changeSetId, u), 'Change set');
      const { hidden } = operationsFor(r, u);
      const op = r.source === 'api' ? opsOf(r.id).find((x) => x.op === 'import') : undefined;
      const v = parseJson<{ rationale?: unknown; tokenName?: unknown }>(op?.value ?? '{}', {});
      return {
        ...entriesOf([r], u)[0]!,
        hiddenOperations: hidden,
        proposal: op ? { rationale: typeof v.rationale === 'string' ? v.rationale : '', tokenName: typeof v.tokenName === 'string' ? v.tokenName : '' } : null,
      };
    },
  );

  get(
    '/plant/change-sets/:changeSetId/operations',
    {
      operationId: 'listPlantChangeSetOperations',
      tag: 'Plant',
      summary: 'List the operations of a change set',
      description: `In order: set, add, remove and rename of single entries with their values (and, for set, the revision and values the author saw), and documents (an import, a bulk change, a move, a collection import) with their options – their files are left out. Operations of sites the token owner may not see are left out (counted as \`hiddenOperations\` of the change set). ${MODULE}`,
      params: { changeSetId: 'Change set id (pcs_…)' },
      query: PlantChangeOperationListQuery,
      paginated: true,
      response: page('PlantChangeOperationEntry', 'A page of operations'),
    },
    (req, reply) => {
      const u = me();
      const r = found(() => visibleRow((req.params as { changeSetId: string }).changeSetId, u), 'Change set');
      const q = req.query as z.infer<typeof PlantChangeOperationListQuery>;
      const p = pageArray(operationsFor(r, u).operations, (x) => [x.seq], q, { changeSet: r.id });
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );

  // ---------- proposals from CI ----------
  const opId = 'proposePlantChanges';
  const op = {
    operationId: opId,
    tag: 'Plant',
    summary: 'Propose changes to the plant registry (for review)',
    description: [
      'Proposes additions and changes as a document of the plant import format – for example from a CI job that keeps device profiles in a repository. It is checked like an assistant’s proposal (docs/PLANT.md "Proposals from assistants"): the import’s preview with the token owner’s rights (their _propose_ right counts), only adding and changing – `remove`, renaming ids and dropping an item from a list inside an entry are refused –, never a credential, at most 1 MB. It lands as a proposed change set that a person reviews and applies in Steward (Plant → Changes); this call never applies it, and where a site needs a second person the token owner never applies it either.',
      'Needs a token with the scope _Full access_ (a read-only token answers 403 `token-scope`). Answers 201 with the change set; follow it with `GET /plant/change-sets/{changeSetId}`. A refused document answers 400 `proposal-refused` with the places in `errors`.',
      MODULE,
    ].join('\n\n'),
  };
  OPERATION_ERRORS.set(opId, [400, 401, 403, 404, 409, 429]);
  const base = schemaOf({ ...op, response: { $ref: 'PlantProposalResult#' } });
  app.post(
    '/plant/proposals',
    {
      bodyLimit: LARGE_BODIES.plantProposalApi.bytes,
      schema: {
        tags: base.tags,
        operationId: base.operationId,
        summary: base.summary,
        description: base.description,
        body: proposalBodySchema(),
        response: { 201: { description: 'Proposed: the change set waits for review', $ref: 'PlantProposalResult#' } },
      },
      config: { smAuth: 'token' },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const p = (req as unknown as { smApi: ApiPrincipal }).smApi;
      if (p.scope !== 'full')
        throw new ProblemError(403, {
          type: 'token-scope',
          title: 'Forbidden',
          detail: 'Proposing changes needs a token with the scope "Full access" – read-only tokens only read',
        });
      found(() => requirePlant(), 'Plant registry');
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const refused = Object.keys(raw).filter((k) => REFUSED.has(k));
      if (refused.length)
        throw new ProblemError(400, {
          type: 'proposal-refused',
          title: 'Proposal refused',
          detail: 'A proposal may only add and change entries with a document: give title, rationale and document',
          errors: refused.map((k) => ({ in: 'body', name: k, message: 'not part of a proposal' })),
        });
      const parsed = ProposalBody.safeParse(raw);
      if (!parsed.success)
        throw new ProblemError(400, {
          type: 'validation-error',
          title: 'Invalid request',
          detail: 'Give title, rationale and document',
          errors: parsed.error.issues.slice(0, 20).map((i) => ({ in: 'body', name: i.path.join('.') || '(body)', message: i.message })),
        });
      const body = parsed.data;
      let done: ReturnType<typeof proposeViaApi>;
      try {
        done = proposeViaApi(body as { title: string; rationale: string; document: Record<string, unknown> }, { id: p.tokenId, name: p.tokenName });
      } catch (e) {
        if (e instanceof ApiProposalRefused)
          throw new ProblemError(400, {
            type: 'proposal-refused',
            title: 'Proposal refused',
            detail: e.message,
            errors: e.places.map((x) => ({ in: 'body', name: x.name, message: x.message })),
          });
        if (e instanceof HttpError && e.statusCode === 413)
          throw new ProblemError(400, { type: 'proposal-refused', title: 'Proposal refused', detail: e.message });
        throw e;
      }
      notifyProposed(done.changeSetId);
      const u = me();
      reply.code(201).header('location', `${config.basePath}/api/v1/plant/change-sets/${done.changeSetId}`);
      return { changeSet: entriesOf([rowOf(done.changeSetId)!], u)[0]!, counts: done.counts, checks: done.checks, warnings: done.warnings };
    },
  );
}
