import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ADVISORY_SEVERITIES,
  ADVISORY_SORTS,
  ADVISORY_STATUSES,
  advisoryDecisionInput,
  advisoryRemediationInput,
  advisorySiteInput,
  advisorySourceInput,
  advisoryUploadInput,
} from '@sm/shared';
import { ACCESS } from '../../auth/access.js';
import { LARGE_BODIES } from '../../bodyLimits.js';
import { ROUTE_LIMITS } from '../../rateLimits.js';
import { contentDisposition } from '../../records/attachments.js';
import { currentParams } from '../ids.js';
import * as store from './store.js';
import * as sources from './fetch.js';

/**
 * Security advisories of the plant registry (0.14, internal API under /api, docs/ADVISORIES.md):
 *
 *   GET    plant/advisories?site=&status=&severity=&vendor=&q=&affecting=&sort=&order=&offset=&limit=   one page of the list
 *   GET    plant/advisories/summary                      the start page's tile
 *   POST   plant/advisories/upload                       a CSAF document (designers, administrators)
 *   GET    plant/advisories/:advisoryId[/document], DELETE …
 *   PUT    plant/advisories/:advisoryId/assets/:assetId/decision | …/remediation   (who manages the asset's site)
 *   PUT    plant/advisories/:advisoryId/sites/:siteId    not applicable at a site (who manages it)
 *   GET    plant/assets/:assetId/advisories              the asset page's section
 *   …      plant/advisory-sources[/:advisorySourceId[/fetch]]    providers, aggregators, ROLIE feeds (administrators)
 */

const listQuery = z.object({
  site: z.string().max(100).optional(),
  status: z.enum(ADVISORY_STATUSES).optional(),
  severity: z.enum(ADVISORY_SEVERITIES).optional(),
  vendor: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  affecting: z.enum(['1', 'true', '0', 'false']).optional(),
  sort: z.enum(ADVISORY_SORTS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const p = (req: FastifyRequest) => (req.method === 'GET' ? currentParams(req.params as Record<string, string>) : req.params) as Record<string, string>;

export async function advisoryRoutes(app: FastifyInstance): Promise<void> {
  const writeLimit = { config: { rateLimit: ROUTE_LIMITS.action } };
  app.get('/plant/advisories', async (req) => {
    const q = listQuery.parse(req.query ?? {});
    return store.listAdvisories({ ...q, affecting: q.affecting === '1' || q.affecting === 'true' });
  });
  app.get('/plant/advisories/summary', async () => store.advisoryTile());
  app.post('/plant/advisories/upload', { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.plantAdvisoryUpload.bytes }, async (req) =>
    store.uploadAdvisory(advisoryUploadInput.parse(req.body)),
  );
  app.get('/plant/advisories/:advisoryId', async (req) => store.getAdvisory(p(req).advisoryId!));
  app.delete('/plant/advisories/:advisoryId', writeLimit, async (req) => {
    store.deleteAdvisory(p(req).advisoryId!);
    return { ok: true };
  });
  app.get('/plant/advisories/:advisoryId/document', async (req, reply) => {
    const d = store.advisoryDocument(p(req).advisoryId!);
    return reply
      .header('content-disposition', contentDisposition(d.name))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .type('application/json; charset=utf-8')
      .send(d.body);
  });
  app.put('/plant/advisories/:advisoryId/assets/:assetId/decision', writeLimit, async (req) =>
    store.decideMatch(p(req).advisoryId!, p(req).assetId!, advisoryDecisionInput.parse(req.body)),
  );
  app.put('/plant/advisories/:advisoryId/assets/:assetId/remediation', writeLimit, async (req) =>
    store.setRemediation(p(req).advisoryId!, p(req).assetId!, advisoryRemediationInput.parse(req.body)),
  );
  app.put('/plant/advisories/:advisoryId/sites/:siteId', writeLimit, async (req) =>
    store.setSiteState(p(req).advisoryId!, p(req).siteId!, advisorySiteInput.parse(req.body)),
  );
  app.get('/plant/assets/:assetId/advisories', async (req) => store.assetAdvisories(p(req).assetId!));

  // ---------- sources: administrators ----------
  const admin = { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.action } };
  app.get('/plant/advisory-sources', { config: { access: ACCESS.admin } }, async () => sources.listSources());
  app.post('/plant/advisory-sources', admin, async (req) => sources.createSource(advisorySourceInput.parse(req.body)));
  app.put('/plant/advisory-sources/:advisorySourceId', admin, async (req) =>
    sources.updateSource(p(req).advisorySourceId!, advisorySourceInput.parse(req.body)),
  );
  app.delete('/plant/advisory-sources/:advisorySourceId', admin, async (req) => {
    sources.deleteSource(p(req).advisorySourceId!);
    return { ok: true };
  });
  app.post('/plant/advisory-sources/:advisorySourceId/fetch', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async (req) =>
    sources.fetchSource(p(req).advisorySourceId!),
  );
}
