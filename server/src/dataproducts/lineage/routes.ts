import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS, me } from '../../auth/access.js';
import { LARGE_BODIES } from '../../bodyLimits.js';
import { ROUTE_LIMITS } from '../../rateLimits.js';
import { HttpError } from '../../util.js';
import * as sources from './sources.js';
import * as proposals from './proposals.js';
import {
  authorizeLineagePush,
  importDbtFile,
  pushDbt,
  pushLimit,
  pushOpenLineage,
  REFUSED,
  takeDbtSlot,
  type PushHead,
  type PushResponse,
  type VerifiedLineageToken,
} from './push.js';

/**
 * Lineage from tools in the internal API (0.24.0, ADR 0036 phase 2). Rights are checked in sources.ts and
 * proposals.ts (a source or proposal the caller may not see answers like a missing one); the module's switch covers the
 * prefix /api/data-products and /api/hooks/data-lineage. Every change needs a signed-in session: sources and tokens (a
 * token outlives the API token that would make it), uploads, and the decisions on proposals ("confirmed by a person").
 *
 *   GET|POST       /api/data-products/lineage-sources
 *   GET|PUT|DELETE /api/data-products/lineage-sources/:id
 *   GET|POST       /api/data-products/lineage-sources/:id/tokens, POST …/:tokenId/rotate, DELETE …/:tokenId
 *   POST           /api/data-products/lineage-sources/:id/dbt/manifest | /dbt/run-results   (the file as the body)
 *   GET            /api/data-products/lineage-proposals            ?sourceId=&status=&origin=&elementId=&cursor=
 *   GET            /api/data-products/lineage-proposals/:id
 *   POST           /api/data-products/lineage-proposals/:id/accept | /reject
 *
 * and the push of the tools (push.ts): POST /api/hooks/data-lineage/:sourceId[/api/v1/lineage | /dbt/manifest | /dbt/run-results].
 */

const param = (req: FastifyRequest, name: string) =>
  z
    .string()
    .min(1)
    .max(100)
    .parse((req.params as Record<string, unknown>)[name]);

export async function dataLineageRoutes(app: FastifyInstance): Promise<void> {
  const base = '/data-products/lineage-sources';
  app.get(base, async () => sources.listLineageSources());
  app.post(base, { config: { access: ACCESS.session } }, async (req) => sources.createLineageSource(req.body));
  app.get(`${base}/:id`, async (req) => sources.getLineageSource(param(req, 'id')));
  app.put(`${base}/:id`, { config: { access: ACCESS.session } }, async (req) => sources.updateLineageSource(param(req, 'id'), req.body));
  app.delete(`${base}/:id`, { config: { access: ACCESS.session } }, async (req, reply) => {
    sources.deleteLineageSource(param(req, 'id'));
    return reply.code(204).send();
  });
  app.get(`${base}/:id/tokens`, async (req) => sources.listLineageTokens(param(req, 'id')));
  app.post(`${base}/:id/tokens`, { config: { access: ACCESS.session } }, async (req) => sources.createLineageToken(param(req, 'id'), req.body));
  app.post(`${base}/:id/tokens/:tokenId/rotate`, { config: { access: ACCESS.session } }, async (req) =>
    sources.rotateLineageToken(param(req, 'id'), param(req, 'tokenId')),
  );
  app.delete(`${base}/:id/tokens/:tokenId`, async (req, reply) => {
    sources.revokeLineageToken(param(req, 'id'), param(req, 'tokenId'));
    return reply.code(204).send();
  });

  // dbt files uploaded in the app: the file itself as the body (its SHA-256 is that of the file as sent)
  await app.register(async (uploads) => {
    uploads.removeContentTypeParser('application/json');
    uploads.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: LARGE_BODIES.dataLineageManifest.bytes }, (_req, body, done) =>
      done(null, body),
    );
    for (const [path, file] of [
      ['manifest', 'manifest'],
      ['run-results', 'runResults'],
    ] as const)
      uploads.post(
        `${base}/:id/dbt/${path}`,
        { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: pushLimit(file) },
        async (req, reply) => {
          const { row } = sources.manageableLineageSource(param(req, 'id'));
          if (row.kind !== 'dbt')
            throw new HttpError(400, 'This lineage source takes OpenLineage events, not dbt files', 'DATA_LINEAGE_SOURCE_KIND', { context: row.kind });
          // the source's dbt files a minute, pushed and uploaded together – before the file is parsed
          const busy = takeDbtSlot(row.id);
          if (busy)
            return reply
              .code(busy.status)
              .headers(busy.headers ?? {})
              .send(busy.body);
          return importDbtFile(row, file, Buffer.isBuffer(req.body) ? req.body : undefined, { actor: me().username, via: 'upload' });
        },
      );
  });

  app.get('/data-products/lineage-proposals', async (req) => proposals.listProposals(req.query));
  app.get('/data-products/lineage-proposals/:id', async (req) => proposals.getProposal(param(req, 'id')));
  app.post('/data-products/lineage-proposals/:id/accept', { config: { access: ACCESS.session } }, async (req) =>
    proposals.acceptProposal(param(req, 'id'), req.body),
  );
  app.post('/data-products/lineage-proposals/:id/reject', { config: { access: ACCESS.session } }, async (req) => proposals.rejectProposal(param(req, 'id')));

  // ---------- the push of the tools: machine to machine, the source's push token only ----------
  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: LARGE_BODIES.dataLineageManifest.bytes }, (_req, body, done) => done(null, body));
    const verified = new WeakMap<FastifyRequest, VerifiedLineageToken>();
    const answer = (reply: FastifyReply, res: PushResponse) => {
      reply.header('cache-control', 'no-store');
      if (res.headers) reply.headers(res.headers);
      return reply.code(res.status).send(res.body);
    };
    const routes: [string, PushHead['file']][] = [
      ['/hooks/data-lineage/:sourceId', 'openlineage'],
      // OpenLineage clients append their default endpoint (api/v1/lineage) to the address they are given
      ['/hooks/data-lineage/:sourceId/api/v1/lineage', 'openlineage'],
      ['/hooks/data-lineage/:sourceId/dbt/manifest', 'manifest'],
      ['/hooks/data-lineage/:sourceId/dbt/run-results', 'runResults'],
    ];
    for (const [url, file] of routes)
      hooks.post(
        url,
        {
          config: { rateLimit: ROUTE_LIMITS.webhook },
          bodyLimit: pushLimit(file),
          // the token, the address, the rate, the type and the length are checked from the headers before the body is read
          onRequest: async (req, reply) => {
            const sourceId = String((req.params as { sourceId?: string }).sourceId ?? '');
            const length = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
            const a = authorizeLineagePush({
              sourceId,
              contentType: req.headers['content-type'],
              contentLength: Number.isFinite(length) ? length : null,
              headers: req.headers,
              ip: req.ip,
              file,
            });
            if (!a.ok) return answer(reply, a.res);
            verified.set(req, a.token);
          },
        },
        async (req, reply) => {
          const token = verified.get(req);
          if (!token) return answer(reply, REFUSED);
          const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
          return answer(reply, file === 'openlineage' ? pushOpenLineage(token, { raw, ip: req.ip }) : await pushDbt(token, file, { raw, ip: req.ip }));
        },
      );
  });
}
