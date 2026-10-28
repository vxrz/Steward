import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { linkInput, linkUpdate } from '../records/links.js';
import { getPlatform } from '../platforms/service.js';
import { HttpError } from '../util.js';
import * as apps from './applications.js';
import * as cia from './cia.js';
import * as comps from './components.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { getService } from './service.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

/**
 * Applications of the service catalogue, the applications of services, protection needs and the CIA scale, and the
 * scope of living documents: the web UI's API. Every route checks permissions in the service layer.
 */
export async function catalogueRoutes(app: FastifyInstance): Promise<void> {
  // ---------- applications ----------
  app.get('/applications', async (req) => apps.listApplications({ archived: (req.query as { archived?: string }).archived === '1' }));
  app.post('/applications', async (req) => apps.createApplication(apps.applicationInput.parse(req.body)));
  app.get('/applications/:id', async (req) => apps.getApplication(params(req).id!));
  app.put('/applications/:id', async (req) => apps.updateApplication(params(req).id!, apps.applicationInput.parse(req.body)));
  app.post('/applications/:id/archive', async (req) =>
    apps.setApplicationArchived(params(req).id!, z.object({ archived: z.boolean() }).strict().parse(req.body).archived),
  );
  app.put('/applications/:id/rating', async (req) => apps.rateApplication(params(req).id!, cia.ratingInput.parse(req.body)));
  app.post('/applications/:id/platforms', async (req) => apps.addApplicationPlatform(params(req).id!, apps.platformMappingInput.parse(req.body).platformId));
  app.delete('/applications/:id/platforms/:platformId', async (req) => apps.removeApplicationPlatform(params(req).id!, params(req).platformId!));
  app.post('/applications/:id/links', async (req) => apps.addApplicationLink(params(req).id!, linkInput.parse(req.body)));
  app.patch('/applications/:id/links/:linkId', async (req) => apps.updateApplicationLink(params(req).id!, params(req).linkId!, linkUpdate.parse(req.body)));
  app.delete('/applications/:id/links/:linkId', async (req) => {
    apps.removeApplicationLink(params(req).id!, params(req).linkId!);
    return { ok: true };
  });

  // ---------- components and tech stack ----------
  app.get('/catalogue/stack-products', async () => comps.stackProducts());
  app.post('/applications/:id/components', async (req) => {
    comps.addComponent(params(req).id!, comps.componentInput.parse(req.body), apps.canEditApplication);
    return apps.getApplication(params(req).id!);
  });
  app.put('/applications/:id/components/:componentId', async (req) => {
    comps.updateComponent(params(req).id!, params(req).componentId!, comps.componentInput.parse(req.body), apps.canEditApplication);
    return apps.getApplication(params(req).id!);
  });
  app.delete('/applications/:id/components/:componentId', async (req) => {
    comps.removeComponent(params(req).id!, params(req).componentId!, apps.canEditApplication);
    return apps.getApplication(params(req).id!);
  });
  app.post('/applications/:id/components/:componentId/sbom/preview', { bodyLimit: LARGE_BODIES.sbom.bytes }, async (req) =>
    comps.previewSbom(params(req).id!, params(req).componentId!, comps.sbomInput.parse(req.body), apps.canEditApplication),
  );
  app.post('/applications/:id/components/:componentId/sbom', { bodyLimit: LARGE_BODIES.sbom.bytes }, async (req) => {
    const r = await comps.importSbom(params(req).id!, params(req).componentId!, comps.sbomInput.parse(req.body), apps.canEditApplication);
    return { preview: r.preview, application: apps.getApplication(params(req).id!) };
  });

  // the application a platform belongs to (platform page; 404 for platforms the user may not see)
  app.get('/platforms/:id/application', async (req) => {
    if (!getPlatform(params(req).id!).permissions.length)
      throw new HttpError(404, `Platform ${params(req).id} not found`, 'PLATFORM_NOT_FOUND', { id: params(req).id });
    return { application: apps.applicationOfPlatform(params(req).id!) };
  });

  // ---------- services → applications, protection need ----------
  app.put('/services/:id/applications/:applicationId', async (req) => {
    apps.setServiceApplication(params(req).id!, params(req).applicationId!, apps.serviceApplicationInput.parse(req.body ?? {}));
    return getService(params(req).id!);
  });
  app.delete('/services/:id/applications/:applicationId', async (req) => {
    apps.removeServiceApplication(params(req).id!, params(req).applicationId!);
    return getService(params(req).id!);
  });
  app.put('/services/:id/protection-need', async (req) => {
    apps.overrideProtectionNeed(params(req).id!, cia.overrideInput.parse(req.body));
    return getService(params(req).id!);
  });

  // ---------- CIA scale ----------
  app.get('/catalogue/cia-scale', async () => cia.getScale());
  // a scale change maps or flags the ratings of every application at once: administrators, with a fresh confirmation
  app.put('/catalogue/cia-scale', { config: { stepUp: { action: 'changeCiaScale', who: () => cia.canEditScale() } } }, async (req) =>
    cia.saveScale(cia.scaleInput.parse(req.body)),
  );

  // ---------- document scope ----------
  app.put('/records/:id/applications', async (req) => ({ appliesTo: apps.setDocumentScope(params(req).id!, apps.scopeInput.parse(req.body).applicationIds) }));
}
