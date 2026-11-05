import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSET_STATUSES, PLANT_LIMITS } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { config } from '../config.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { logger } from '../log.js';
import { addLink, linkInput, linkUpdate, removeLink, updateLink } from '../records/links.js';
import { HttpError } from '../util.js';
import { plantSettings, plantSettingsInput, requirePlant, updatePlantSettings } from './settings.js';
import * as svc from './service.js';
import { applyImport, exportYaml, importInput, listImports, previewImport } from './import.js';
import { plantJsonSchema } from './format.js';
import { seedPlantDemo } from './demo.js';
import * as cat from './catalogue.js';
import { assignmentInput, deleteAssignment, getAssignment, putAssignment } from './assignments.js';
import './links.js';

/**
 * The plant registry's internal API (#218), mounted under /api. Every route answers 404 PLANT_MODULE_OFF while the
 * module is off (except its switch in the settings); rights are checked per site in the services (plant/access.ts).
 *
 *   GET|PUT /api/settings/plant                          the switch and the settings (administrators)
 *   GET     /api/plant/config | /schema | /hierarchy     what the pages need; the JSON Schema of the import format
 *   …       /api/plant/sites[/:siteId[/nodes|/buildings|/links|/access]]
 *   …       /api/plant/assets[/:assetId[/image|/links|/assignment]]
 *   …       /api/plant/profiles[/:profileId[/points/:pointId]], /api/plant/kpis[/:kpiId]   the catalogues of part 2 (#219)
 *   GET     /api/plant/explore/points, /api/plant/checks
 *   POST    /api/plant/import/preview | /api/plant/import, GET /api/plant/imports, GET /api/plant/export
 */

const p = (req: FastifyRequest) => req.params as Record<string, string>;
const imports = { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.plantImport.bytes };

const assetQuery = z.object({
  site: z.string().max(100).optional(),
  node: z.string().max(100).optional(),
  domain: z.string().max(100).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  tag: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  ref: z.string().max(300).optional(),
  profile: z.string().max(100).optional(),
  dataPoint: z.string().max(120).optional(),
});

export async function plantRoutes(app: FastifyInstance): Promise<void> {
  // ---------- settings (the module switch works while the module is off) ----------
  app.get('/settings/plant', { config: { access: ACCESS.admin } }, async () => plantSettings());
  app.put('/settings/plant', { config: { access: ACCESS.admin } }, async (req) =>
    updatePlantSettings(plantSettingsInput.parse(req.body), () => {
      // the demo shows the module with its invented enterprise once it is turned on
      if (config.demo)
        try {
          seedPlantDemo();
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'plant registry demo data not loaded');
        }
    }),
  );

  // ---------- module ----------
  app.get('/plant/config', async () => svc.plantConfig());
  app.get('/plant/schema', async () => {
    requirePlant();
    return plantJsonSchema();
  });
  app.get('/plant/hierarchy', async (req) => svc.hierarchy(z.object({ site: z.string().max(100).optional() }).parse(req.query).site));

  // ---------- sites ----------
  app.get('/plant/sites', async () => svc.listSites());
  app.post('/plant/sites', async (req) => svc.createSite(svc.siteInput.parse(req.body)));
  app.get('/plant/sites/:siteId', async (req) => svc.getSite(p(req).siteId!));
  app.put('/plant/sites/:siteId', async (req) => svc.updateSite(p(req).siteId!, svc.siteUpdate.parse(req.body)));
  app.delete('/plant/sites/:siteId', async (req) => {
    svc.deleteSite(p(req).siteId!);
    return { ok: true };
  });
  // an access list gives rights to others: confirmed like every other grant (step-up, assurance point access.grant)
  app.put('/plant/sites/:siteId/access', { config: { stepUp: { action: 'grantAccess' } } }, async (req) =>
    svc.setSiteAccess(p(req).siteId!, z.object({ acl: z.array(z.unknown()).max(500) }).parse(req.body).acl),
  );
  app.post('/plant/sites/:siteId/nodes', async (req) => svc.createNode(p(req).siteId!, svc.nodeInput.parse(req.body)));
  app.put('/plant/sites/:siteId/nodes/:nodeId', async (req) => svc.updateNode(p(req).siteId!, p(req).nodeId!, svc.nodeUpdate.parse(req.body)));
  app.delete('/plant/sites/:siteId/nodes/:nodeId', async (req) => svc.deleteNode(p(req).siteId!, p(req).nodeId!));
  app.post('/plant/sites/:siteId/buildings', async (req) => svc.createBuilding(p(req).siteId!, svc.buildingInput.parse(req.body)));
  app.put('/plant/sites/:siteId/buildings/:buildingId', async (req) =>
    svc.updateBuilding(p(req).siteId!, p(req).buildingId!, svc.buildingUpdate.parse(req.body)),
  );
  app.delete('/plant/sites/:siteId/buildings/:buildingId', async (req) => svc.deleteBuilding(p(req).siteId!, p(req).buildingId!));

  // ---------- links of sites and assets (records/links.ts) ----------
  for (const kind of ['site', 'asset'] as const) {
    const base = kind === 'site' ? '/plant/sites/:siteId' : '/plant/assets/:assetId';
    const id = (req: FastifyRequest) => (kind === 'site' ? p(req).siteId! : p(req).assetId!);
    app.post(`${base}/links`, async (req) => addLink(kind, id(req), linkInput.parse(req.body), svc.linkSourceLabel(kind, id(req))));
    app.patch(
      `${base}/links/:linkId`,
      async (req) => updateLink(kind, id(req), p(req).linkId!, linkUpdate.parse(req.body), svc.linkSourceLabel(kind, id(req))).link,
    );
    app.delete(`${base}/links/:linkId`, async (req) => {
      removeLink(kind, id(req), p(req).linkId!, svc.linkSourceLabel(kind, id(req)));
      return { ok: true };
    });
  }

  // ---------- assets ----------
  app.get('/plant/assets', async (req) => svc.listAssets(assetQuery.parse(req.query)));
  app.post('/plant/assets', async (req) => svc.createAsset(svc.assetInput.parse(req.body)));
  app.get('/plant/assets/:assetId', async (req) => svc.getAsset(p(req).assetId!));
  app.put('/plant/assets/:assetId', async (req) => svc.updateAsset(p(req).assetId!, svc.assetUpdate.parse(req.body)));
  app.delete('/plant/assets/:assetId', async (req) => {
    svc.deleteAsset(p(req).assetId!);
    return { ok: true };
  });
  app.put('/plant/assets/:assetId/image', async (req) => {
    const b = z
      .object({
        contentBase64: z
          .string()
          .min(1)
          .max(Math.ceil((PLANT_LIMITS.imageBytes * 4) / 3) + 16),
      })
      .safeParse(req.body ?? {});
    if (!b.success)
      throw new HttpError(400, `Upload a PNG, JPEG or WebP image (at most ${PLANT_LIMITS.imageBytes / 1024} KB)`, 'PLANT_IMAGE_TOO_LARGE', {
        kb: PLANT_LIMITS.imageBytes / 1024,
      });
    return svc.setAssetImage(p(req).assetId!, Buffer.from(b.data.contentBase64, 'base64'));
  });
  app.delete('/plant/assets/:assetId/image', async (req) => svc.removeAssetImage(p(req).assetId!));
  app.get('/plant/assets/:assetId/image', async (req, reply) => {
    const img = svc.assetImage(p(req).assetId!);
    if (!img) throw new HttpError(404, 'The asset has no image', 'PLANT_IMAGE_NONE');
    reply.header('etag', `"${img.sha256.slice(0, 32)}"`);
    reply.header('cache-control', 'private, no-cache');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-disposition', `inline; filename="asset.${img.mime.split('/')[1]}"`);
    // an image needs nothing else; this keeps the response inert when opened directly
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    return reply.type(img.mime).send(img.data);
  });

  // ---------- an asset's assignment: profile, interfaces, overrides, publications, KPI instances (#219) ----------
  app.get('/plant/assets/:assetId/assignment', async (req) => getAssignment(p(req).assetId!));
  app.put('/plant/assets/:assetId/assignment', async (req) => putAssignment(p(req).assetId!, assignmentInput.parse(req.body)));
  app.delete('/plant/assets/:assetId/assignment', async (req) => deleteAssignment(p(req).assetId!));

  // ---------- device profiles and KPI definitions: catalogues of the installation (#219) ----------
  app.get('/plant/profiles', async () => cat.listProfiles());
  app.post('/plant/profiles', async (req) => cat.createProfile(cat.profileInput.parse(req.body)));
  app.get('/plant/profiles/:profileId', async (req) => cat.getProfile(p(req).profileId!));
  app.put('/plant/profiles/:profileId', async (req) => cat.updateProfile(p(req).profileId!, cat.profileUpdate.parse(req.body)));
  app.delete('/plant/profiles/:profileId', async (req) => {
    cat.deleteProfile(p(req).profileId!);
    return { ok: true };
  });
  app.get('/plant/profiles/:profileId/points/:pointId', async (req) => cat.getDataPoint(p(req).profileId!, p(req).pointId!));
  app.get('/plant/kpis', async () => cat.listKpis());
  app.post('/plant/kpis', async (req) => cat.createKpi(cat.kpiInput.parse(req.body)));
  app.get('/plant/kpis/:kpiId', async (req) => cat.getKpi(p(req).kpiId!));
  app.put('/plant/kpis/:kpiId', async (req) => cat.updateKpi(p(req).kpiId!, cat.kpiUpdate.parse(req.body)));
  app.delete('/plant/kpis/:kpiId', async (req) => {
    cat.deleteKpi(p(req).kpiId!);
    return { ok: true };
  });
  // which assets deliver a data point (by text across the profiles); every check of what the caller may see
  app.get('/plant/explore/points', async (req) => cat.explorePoints(z.object({ q: z.string().max(200).default('') }).parse(req.query).q));
  app.get('/plant/checks', async () => cat.listChecks());

  // ---------- import and export ----------
  app.post('/plant/import/preview', imports, async (req) => previewImport(importInput.parse(req.body)));
  app.post('/plant/import', imports, async (req) => applyImport(importInput.parse(req.body)));
  app.get('/plant/imports', async () => listImports());
  app.get('/plant/export', async (req, reply) => {
    const q = z
      .object({
        site: z.string().max(100).optional(),
        profile: z.string().max(100).optional(),
        kpi: z.string().max(100).optional(),
        part: z.enum(['all', 'catalogue']).optional(),
      })
      .parse(req.query);
    const x = exportYaml(q);
    reply.header('content-disposition', `attachment; filename="${x.filename}"`);
    reply.header('cache-control', 'no-store');
    return reply.type('application/yaml; charset=utf-8').send(x.content);
  });
}
