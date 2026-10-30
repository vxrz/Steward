import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { linkInput, linkUpdate } from '../records/links.js';
import { getPlatform } from '../platforms/service.js';
import { HttpError } from '../util.js';
import { currentUser } from '../auth/context.js';
import * as apps from './applications.js';
import * as cia from './cia.js';
import * as comps from './components.js';
import * as lifecycle from './lifecycle.js';
import * as systems from './systems.js';
import * as envs from './environments.js';
import * as maint from './maintenance.js';
import { contentDisposition } from '../records/attachments.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
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

  // ---------- end of life (#104) ----------
  app.get('/catalogue/lifecycle', async () => lifecycle.lifecycleStatus());
  app.put('/catalogue/lifecycle', async (req) => lifecycle.saveLifecycleSettings(lifecycle.settingsInput.parse(req.body)));
  app.post('/catalogue/lifecycle/refresh', { config: { rateLimit: ROUTE_LIMITS.action } }, async () => lifecycle.refreshLifecycleNow());

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

  // Kubernetes namespace (#111): read deployments, pods and certificates now
  app.post('/applications/:id/components/:componentId/cluster', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const { id, componentId } = params(req);
    const a = apps.getApplication(id!);
    if (!a.canEdit) throw new HttpError(403, 'Only who may change the application reads its namespaces now', 'FORBIDDEN');
    if (!a.components.some((c) => c.id === componentId)) throw new HttpError(404, 'This component does not belong to the application', 'COMPONENT_NOT_FOUND');
    const { refreshNamespace } = await import('./kubernetes.js');
    await refreshNamespace(componentId!, currentUser()!.username);
    return apps.getApplication(id!);
  });

  // Repository (#107): read branch, pipeline, release, alerts, packages, keys and the tech stack now
  app.post('/applications/:id/components/:componentId/repository', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const { id, componentId } = params(req);
    const a = apps.getApplication(id!);
    if (!a.canEdit) throw new HttpError(403, 'Only who may change the application reads its repositories now', 'FORBIDDEN');
    if (!a.components.some((c) => c.id === componentId)) throw new HttpError(404, 'This component does not belong to the application', 'COMPONENT_NOT_FOUND');
    const { refreshRepository } = await import('./repositories.js');
    await refreshRepository(componentId!, currentUser()!.username);
    return apps.getApplication(id!);
  });

  // Kafka topic (#112): read settings, offsets, consumer groups and the schema now
  app.post('/applications/:id/components/:componentId/topic', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const { id, componentId } = params(req);
    const a = apps.getApplication(id!);
    if (!a.canEdit) throw new HttpError(403, 'Only who may change the application reads its topics now', 'FORBIDDEN');
    if (!a.components.some((c) => c.id === componentId)) throw new HttpError(404, 'This component does not belong to the application', 'COMPONENT_NOT_FOUND');
    const { refreshTopic } = await import('../kafka/service.js');
    await refreshTopic(componentId!, currentUser()!.username);
    return apps.getApplication(id!);
  });

  // AWS cloud account (#116): resources with the application tag, IAM users and keys now (costs stay once a day)
  app.post('/applications/:id/components/:componentId/aws', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const { id, componentId } = params(req);
    const a = apps.getApplication(id!);
    if (!a.canEdit) throw new HttpError(403, 'Only who may change the application reads its cloud accounts now', 'FORBIDDEN');
    if (!a.components.some((c) => c.id === componentId)) throw new HttpError(404, 'This component does not belong to the application', 'COMPONENT_NOT_FOUND');
    const { refreshAwsComponent } = await import('../aws/service.js');
    await refreshAwsComponent(componentId!, currentUser()!.username, { force: true });
    return apps.getApplication(id!);
  });

  // Snowflake database (#115): tables, failing tasks and warehouse credits now
  app.post('/applications/:id/components/:componentId/snowflake', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const { id, componentId } = params(req);
    const a = apps.getApplication(id!);
    if (!a.canEdit) throw new HttpError(403, 'Only who may change the application reads its databases now', 'FORBIDDEN');
    if (!a.components.some((c) => c.id === componentId)) throw new HttpError(404, 'This component does not belong to the application', 'COMPONENT_NOT_FOUND');
    const { refreshSnowflakeComponent } = await import('../snowflake/service.js');
    await refreshSnowflakeComponent(componentId!, currentUser()!.username);
    return apps.getApplication(id!);
  });

  // ---------- systems and "runs on" (#129) ----------
  app.get('/systems', async () => systems.listSystems());
  app.post('/systems', async (req) => systems.createSystem(systems.systemInput.parse(req.body)));
  app.get('/systems/:id', async (req) => systems.getSystem(params(req).id!));
  app.put('/systems/:id', async (req) => systems.updateSystem(params(req).id!, systems.systemInput.parse(req.body)));
  app.delete('/systems/:id', async (req) => {
    systems.deleteSystem(params(req).id!);
    return { ok: true };
  });
  app.post('/systems/:id/sbom/preview', { bodyLimit: LARGE_BODIES.sbom.bytes }, async (req) =>
    systems.previewSystemSbom(params(req).id!, comps.sbomInput.parse(req.body)),
  );
  app.post('/systems/:id/sbom', { bodyLimit: LARGE_BODIES.sbom.bytes }, async (req) =>
    systems.importSystemSbom(params(req).id!, comps.sbomInput.parse(req.body)),
  );
  app.post('/applications/:id/systems', async (req) => {
    systems.linkSystem(params(req).id!, systems.systemLinkInput.parse(req.body), apps.canEditApplication);
    return apps.getApplication(params(req).id!);
  });
  app.put('/applications/:id/systems/:systemLinkId', async (req) => {
    systems.updateSystemLink(params(req).id!, params(req).systemLinkId!, systems.systemLinkUpdate.parse(req.body), apps.canEditApplication);
    return apps.getApplication(params(req).id!);
  });
  app.delete('/applications/:id/systems/:systemLinkId', async (req) => {
    systems.unlinkSystem(params(req).id!, params(req).systemLinkId!, apps.canEditApplication);
    return apps.getApplication(params(req).id!);
  });

  // ---------- maintenance windows (#108) ----------
  const maintenanceQuery = z.object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    target: z
      .string()
      .regex(/^(platform|system|application|service):[\w-]{1,80}$/)
      .optional(),
    cancelled: z.enum(['true', 'false']).optional(),
  });
  app.get('/maintenance-windows', async (req) => {
    const q = maintenanceQuery.parse(req.query);
    return maint.listMaintenance({ from: q.from, to: q.to, target: q.target, cancelled: q.cancelled === 'true' });
  });
  app.post('/maintenance-windows', async (req) => maint.createMaintenance(maint.maintenanceInput.parse(req.body)));
  app.get('/maintenance-windows/:id', async (req) => maint.getMaintenance(params(req).id!));
  app.put('/maintenance-windows/:id', async (req) => maint.updateMaintenance(params(req).id!, maint.maintenanceInput.parse(req.body)));
  app.post('/maintenance-windows/:id/cancel', async (req) =>
    maint.cancelMaintenance(params(req).id!, z.object({ reason: z.string().max(500).default('') }).parse(req.body ?? {}).reason),
  );
  app.get('/maintenance-windows/:id/ics', async (req, reply) => {
    const f = maint.maintenanceIcs(params(req).id!);
    reply.header('content-type', 'text/calendar; charset=utf-8');
    reply.header('content-disposition', contentDisposition(f.name));
    return f.body;
  });

  // ---------- environments (#129) ----------
  app.get('/catalogue/environments', async () => envs.environmentSettings());
  app.put('/catalogue/environments', async (req) => envs.saveEnvironments(envs.environmentsInput.parse(req.body)));

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
