import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dataActualReadInput, type ReportLang } from '@sm/shared';
import { ACCESS, me } from '../auth/access.js';
import { LINK_PARAM } from '../auth/cookies.js';
import * as actual from './consumers-actual.js';
import * as requests from './access-requests.js';
import * as reviews from './port-reviews.js';
import * as promotion from './promotion.js';
import * as endorsements from './endorsements.js';
import * as ropa from './ropa.js';

/**
 * Consumers, access and governance of data products (0.24.0, ADR 0036 phase 2) in the internal API. Rights are checked
 * in the services (a product the caller may not see answers like a missing one). Session-only: reading the platforms
 * now, decisions on requests, the access settings, port reviews' steps, promotions and endorsements (ADR 0036 security
 * notes: changes of access come from a person signed in); approving a request asks for the step-up `access.grant` in
 * the service (it widens access).
 *
 *   GET        /api/data-products/:id/ports/:portId/actual?environment=      declared against actual consumers
 *   POST       /api/data-products/:id/ports/:portId/actual/read             read the platforms now { environment }
 *   PUT        /api/data-products/:id/ports/:portId/consumers/:consumerId/identities
 *   GET        /api/data-products/access-requests?scope=&status=            requests of products the reader may see
 *   GET        /api/data-products/access-requests/:requestId
 *   POST       /api/data-products/access-requests/:requestId/decision       approve | refuse
 *   POST       /api/data-products/access-requests/:requestId/withdraw
 *   GET        /api/data-products/:id/access-requests
 *   POST       /api/data-products/:id/ports/:portId/access-requests         ask for access
 *   GET|PUT    /api/data-products/:id/access-settings                       process, ticket source, review interval
 *   GET        /api/data-products/:id/port-reviews                          reviews and when the next are due
 *   POST       /api/data-products/:id/ports/:portId/reviews                 start a port access review
 *   GET        /api/data-products/port-reviews/:reviewId[/verify]
 *   PUT        /api/data-products/port-reviews/:reviewId/decisions
 *   POST       /api/data-products/port-reviews/:reviewId/submit|approval
 *   GET        /api/data-products/:id/promotion?from=&to=                   the preview
 *   POST       /api/data-products/:id/promotion                             promote
 *   GET        /api/data-products/:id/promotions
 *   GET|PUT|DELETE /api/data-products/:id/endorsement
 *   GET        /api/data-products/records-of-processing[.csv|.pdf]           the GDPR Art. 30 view
 */

const param = (req: FastifyRequest, name: string): string =>
  z
    .string()
    .min(1)
    .max(200)
    .parse((req.params as Record<string, unknown>)[name]);
/** The query without the download link's session key (`?_sk=`, apiUrl in the web app). */
const queryOf = (req: FastifyRequest) => Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).filter(([k]) => k !== LINK_PARAM));
const envQuery = z.object({ environment: z.string().trim().min(1).max(60) }).strict();

export async function dataProductGovernanceRoutes(app: FastifyInstance): Promise<void> {
  // ---------- the GDPR Art. 30 view (before /data-products/:id) ----------
  app.get('/data-products/records-of-processing', async (req) => ropa.recordsOfProcessing(ropa.ropaRequest.omit({ lang: true }).parse(queryOf(req))));
  app.get('/data-products/records-of-processing.csv', async (req, reply) => {
    const q = ropa.ropaRequest.parse(queryOf(req));
    const { lang, ...filter } = q;
    const r = ropa.recordsOfProcessing(filter);
    ropa.auditRopaExport('csv', r.items.length);
    reply.header('content-disposition', 'attachment; filename="records-of-processing.csv"');
    return reply.type('text/csv; charset=utf-8').send(ropa.ropaCsv(r, lang ?? (await localeOf())));
  });
  app.get('/data-products/records-of-processing.pdf', async (req, reply) => {
    const q = ropa.ropaRequest.parse(queryOf(req));
    const { lang, ...filter } = q;
    const l: ReportLang = lang ?? (await localeOf());
    const r = ropa.recordsOfProcessing(filter);
    const words = ropa.ropaWords(l);
    const { head, rows } = ropa.ropaRows(r, l);
    const { drawPdf } = await import('../reports/pdf/pool.js');
    const { getBranding, logo } = await import('../reports/branding.js');
    const pdf = await drawPdf(
      'ropa',
      {
        lang: l,
        generatedAt: r.generatedAt,
        generatedBy: me().username,
        title: words.title,
        subtitle: words.subtitle,
        disclaimer: words.disclaimer,
        filter: [filter.domain ? `domain ${filter.domain}` : '', filter.personalData ?? '', filter.q ? `“${filter.q}”` : ''].filter(Boolean).join(' · '),
        head,
        rows,
        notice: r.truncated ? words.truncated(r.limit) : '',
      },
      { branding: getBranding(), logo: logo().data },
    );
    ropa.auditRopaExport('pdf', r.items.length);
    reply.header('content-disposition', 'attachment; filename="records-of-processing.pdf"');
    return reply.type('application/pdf').send(pdf);
  });

  // ---------- access requests (before /data-products/:id) ----------
  app.get('/data-products/access-requests', async (req) => requests.listRequests(requests.listQuery.parse(req.query ?? {})));
  app.get('/data-products/access-requests/:requestId', async (req) => requests.getRequest(param(req, 'requestId')));
  app.post('/data-products/access-requests/:requestId/decision', { config: { access: ACCESS.session } }, async (req) =>
    requests.decideRequest(param(req, 'requestId'), req.body),
  );
  app.post('/data-products/access-requests/:requestId/withdraw', async (req) => requests.withdrawRequest(param(req, 'requestId')));
  app.get('/data-products/:id/access-requests', async (req) => requests.productRequests(param(req, 'id')));
  app.post('/data-products/:id/ports/:portId/access-requests', async (req) => requests.requestAccess(param(req, 'id'), param(req, 'portId'), req.body));
  app.get('/data-products/:id/access-settings', async (req) => requests.getSettings(param(req, 'id')));
  app.put('/data-products/:id/access-settings', { config: { access: ACCESS.session } }, async (req) => requests.putSettings(param(req, 'id'), req.body));

  // ---------- declared against actual consumers ----------
  app.get('/data-products/:id/ports/:portId/actual', async (req) => {
    const q = envQuery.parse(req.query ?? {});
    return actual.actualView(param(req, 'id'), param(req, 'portId'), q.environment);
  });
  app.post('/data-products/:id/ports/:portId/actual/read', { config: { access: ACCESS.session } }, async (req) => {
    const b = dataActualReadInput.parse(req.body ?? {});
    return actual.readNow(param(req, 'id'), param(req, 'portId'), b.environment);
  });
  app.put('/data-products/:id/ports/:portId/consumers/:consumerId/identities', async (req) =>
    actual.setConsumerIdentities(param(req, 'id'), param(req, 'portId'), param(req, 'consumerId'), req.body),
  );

  // ---------- port access reviews ----------
  app.get('/data-products/:id/port-reviews', async (req) => reviews.productReviews(param(req, 'id')));
  app.post('/data-products/:id/ports/:portId/reviews', { config: { access: ACCESS.session } }, async (req) =>
    reviews.startReview(param(req, 'id'), param(req, 'portId'), req.body),
  );
  app.get('/data-products/port-reviews/:reviewId', async (req) => reviews.getReview(param(req, 'reviewId')));
  app.get('/data-products/port-reviews/:reviewId/verify', async (req) => reviews.verifyReview(param(req, 'reviewId')));
  app.put('/data-products/port-reviews/:reviewId/decisions', { config: { access: ACCESS.session } }, async (req) =>
    reviews.decideItems(param(req, 'reviewId'), req.body),
  );
  app.post('/data-products/port-reviews/:reviewId/submit', { config: { access: ACCESS.session } }, async (req) => reviews.submitReview(param(req, 'reviewId')));
  app.post('/data-products/port-reviews/:reviewId/approval', { config: { access: ACCESS.session } }, async (req) =>
    reviews.approveReview(param(req, 'reviewId'), req.body),
  );

  // ---------- promotion ----------
  app.get('/data-products/:id/promotion', async (req) => {
    const q = z
      .object({ from: z.string().trim().min(1).max(60), to: z.string().trim().min(1).max(60) })
      .strict()
      .parse(req.query ?? {});
    return promotion.promotionPreview(param(req, 'id'), q.from, q.to);
  });
  app.post('/data-products/:id/promotion', { config: { access: ACCESS.session } }, async (req) => promotion.promote(param(req, 'id'), req.body));
  app.get('/data-products/:id/promotions', async (req) => promotion.listPromotions(param(req, 'id')));

  // ---------- endorsement ----------
  app.get('/data-products/:id/endorsement', async (req) => endorsements.getEndorsement(param(req, 'id')));
  app.put('/data-products/:id/endorsement', { config: { access: ACCESS.session } }, async (req) => endorsements.endorse(param(req, 'id'), req.body ?? {}));
  app.delete('/data-products/:id/endorsement', { config: { access: ACCESS.session } }, async (req) => {
    const q = z
      .object({ reason: z.string().trim().max(2000).default('') })
      .strict()
      .parse(req.query ?? {});
    return endorsements.revokeEndorsement(param(req, 'id'), q.reason);
  });
}

/** The reader's language for exports (their profile's, else the instance's). */
async function localeOf(): Promise<ReportLang> {
  const { requestLang } = await import('../reports/service.js');
  return requestLang();
}
