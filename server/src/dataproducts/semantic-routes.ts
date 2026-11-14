import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS } from '../auth/access.js';
import { LINK_PARAM } from '../auth/cookies.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import * as semantic from './semantic.js';
import * as previews from './previews.js';
import * as ropa from './ropa-details.js';

/**
 * Data products phase 3, package D (0.25.0, ADR 0037 parts 4 and 6, and the GDPR Art. 30 carry-over) in the internal
 * API. Rights are checked in the services (a product the caller may not see answers like a missing one). Session-only:
 * signing off a semantic model (a person's approval, like a record's) and the Kafka peek (it reads messages).
 *
 *   GET        /api/data-products/:id/semantic-model                          versions, the current and the valid one
 *   GET        /api/data-products/:id/semantic-model/versions/:n              the document with lint and drift findings
 *   POST       /api/data-products/:id/semantic-model/versions                 save a version { document, note, origin }
 *   POST       /api/data-products/:id/semantic-model/versions/:n/sign-off     sign off { sha256, note }
 *   GET        /api/data-products/:id/semantic-model/valid?date=              which version was valid that day, who approved it
 *   GET        /api/data-products/:id/semantic-model/draft?environment=&revision=   Start from the bound contracts and data objects
 *   GET        /api/data-products/:id/semantic-model/export?version=&date=&environment=   as stored (sources rewritten)
 *   GET        /api/data-products/:id/ports/:portId/preview?environment=      contract examples and linked recordings
 *   POST       /api/data-products/:id/ports/:portId/recordings                link a recorded response { recordingId, note }
 *   DELETE     /api/data-products/:id/ports/:portId/recordings/:recordingId
 *   POST       /api/data-elements/:id/peek                                    the Kafka peek of a topic element { count }
 *   GET|PUT    /api/data-objects/:id/ropa-details, /api/data-products/:id/ropa-details   Art. 30(1)(e) and (g)
 */

const param = (req: FastifyRequest, name: string): string =>
  z
    .string()
    .min(1)
    .max(200)
    .parse((req.params as Record<string, unknown>)[name]);
const versionParam = (req: FastifyRequest): number =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .parse((req.params as Record<string, unknown>).n);
/** The query without the download link's session key (`?_sk=`, apiUrl in the web app). */
const queryOf = (req: FastifyRequest) => Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).filter(([k]) => k !== LINK_PARAM));

export async function dataProductSemanticRoutes(app: FastifyInstance): Promise<void> {
  // ---------- semantic models ----------
  app.get('/data-products/:id/semantic-model', async (req) => semantic.semanticModelView(param(req, 'id')));
  app.get('/data-products/:id/semantic-model/valid', async (req) => semantic.semanticValidOn(param(req, 'id'), queryOf(req)));
  app.get('/data-products/:id/semantic-model/draft', async (req) => semantic.semanticDraft(param(req, 'id'), queryOf(req)));
  app.get('/data-products/:id/semantic-model/export', async (req, reply) => {
    const x = semantic.semanticExport(param(req, 'id'), queryOf(req));
    reply.header('content-disposition', `attachment; filename="${x.fileName}"`);
    reply.header('x-steward-semantic-version', String(x.version.version));
    reply.header('x-steward-sha256', x.version.sha256);
    if (x.notRewritten) reply.header('x-steward-sources-not-rewritten', String(x.notRewritten));
    return reply.type(x.contentType).send(x.body);
  });
  app.get('/data-products/:id/semantic-model/versions/:n', async (req) => semantic.semanticVersion(param(req, 'id'), versionParam(req)));
  app.post('/data-products/:id/semantic-model/versions', { bodyLimit: LARGE_BODIES.dataSemanticModel.bytes }, async (req, reply) => {
    const r = semantic.saveSemanticVersion(param(req, 'id'), req.body);
    return reply.code(r.created ? 201 : 200).send(r);
  });
  app.post('/data-products/:id/semantic-model/versions/:n/sign-off', { config: { access: ACCESS.session } }, async (req) =>
    semantic.signOffSemanticVersion(param(req, 'id'), versionParam(req), req.body),
  );

  // ---------- previews ----------
  app.get('/data-products/:id/ports/:portId/preview', async (req) => previews.portPreview(param(req, 'id'), param(req, 'portId'), queryOf(req)));
  app.post('/data-products/:id/ports/:portId/recordings', async (req) => previews.linkPortRecording(param(req, 'id'), param(req, 'portId'), req.body));
  app.delete('/data-products/:id/ports/:portId/recordings/:recordingId', async (req, reply) => {
    previews.unlinkPortRecording(param(req, 'id'), param(req, 'portId'), param(req, 'recordingId'));
    return reply.code(204).send();
  });
  app.post('/data-elements/:id/peek', { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.action } }, async (req) =>
    previews.peekElement(param(req, 'id'), req.body),
  );

  // ---------- GDPR Art. 30 details ----------
  app.get('/data-objects/:id/ropa-details', async (req) => ropa.objectRopaDetails(param(req, 'id')));
  app.put('/data-objects/:id/ropa-details', async (req) => ropa.setObjectRopaDetails(param(req, 'id'), req.body));
  app.get('/data-products/:id/ropa-details', async (req) => ropa.productRopaDetails(param(req, 'id')));
  app.put('/data-products/:id/ropa-details', async (req) => ropa.setProductRopaDetails(param(req, 'id'), req.body));
}
