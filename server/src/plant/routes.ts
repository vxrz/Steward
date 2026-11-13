import { hiddenCatalogue } from './catalogue-access.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ASSET_STATUSES, PLANT_LIMITS } from '@sm/shared';
import { ACCESS, forbid } from '../auth/access.js';
import { accessGrantRule } from '../auth/access-change.js';
import { aliasWidens, markDeprecated } from '../auth/acl-shares.js';
import { config } from '../config.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { logger } from '../log.js';
import { addLink, linkInput, linkUpdate, removeLink, updateLink } from '../records/links.js';
import { HttpError } from '../util.js';
import {
  plantManagerSettings,
  plantManagerSettingsInput,
  plantSettings,
  plantSettingsInput,
  requirePlant,
  updatePlantManagerSettings,
  updatePlantSettings,
} from './settings.js';
import { mayChangeModuleSetting } from '../modules/access.js';
import * as svc from './service.js';
import { applyImport, exportYaml, importInput, importStepUpPoints, listImports, previewImport } from './import.js';
import {
  plantBulkInput,
  plantDuplicateDeviceInput,
  plantMoveInput,
  plantRenameInput,
  PLANT_DOC_KINDS,
  PLANT_ID_KINDS,
  type PlantMovePreview,
} from '@sm/shared';
import { contentDisposition } from '../records/attachments.js';
import { diffSources, listSources, sourceFile } from './collections-sources.js';
import { plantDocuments } from './documents.js';
import { currentParams, currentQuery, listAliases, removeAlias } from './ids.js';
import * as docReview from './doc-review.js';
import { previewRename, renameId } from './rename.js';
import { applyBulk, bulkNeedsStepUp, previewBulk } from './bulk.js';
import { applyMove, duplicateDeviceBody, moveNeedsStepUp, moveRegion, previewMove } from './move.js';
import { plantJsonSchema } from './format.js';
import { seedPlantDemo } from './demo.js';
import * as cat from './catalogue.js';
import { assignmentInput, deleteAssignment, getAssignment, putAssignment } from './assignments.js';
import * as net from './network.js';
import * as coll from './collections.js';
import { applyCollectionImport, collectionImportInput, previewCollectionImport } from './collections-import.js';
import * as ih from './ih.js';
import { checkIhMapping } from './ih-check.js';
import { createIhMonitor, ihMonitorInput } from './ih-draft.js';
import { collectionRowOf, collectionValuesOf } from './collections-model.js';
import { refsOf } from './model.js';
import type { PlantCollectionSink } from '@sm/shared';
import { assetFlow, coverage, hostPlacement, overview, pointLineage, siteStructure } from './views.js';
import { candidatesInput, extractBase, extractCandidates, extractInput, previewExtract } from './extract.js';
import {
  changesMapSource,
  checkBody,
  checkMapSource,
  checkNeedsStepUp,
  forReader,
  mapBody,
  mapGlyphs,
  mapSettingsInput,
  mapSettingsView,
  mapSites,
  mapSprite,
  mapStatus,
  mapStyle,
  mapTile,
  updateMapSettings,
} from './map.js';
import type { Fetched } from './mapTiles.js';
import { plantHistorySettingsInput, plantSiteReviewInput, type PlantChangeSetSource, type PlantHistorySettingsView } from '@sm/shared';
import { entryWrite, revisedNetwork, splitRevision, type WriteTarget } from './changesets/write.js';
import {
  applyDirect,
  bulkRegion,
  collectionsRegion,
  collectionsTouchProfile,
  entryDiffs,
  quietDryRun,
  importRegion,
  touched,
  changeSetLevel,
  insertChangeSet,
  insertOp,
  previewFingerprint,
  reviewNeeded,
  rowOf,
  setSiteReview,
  summaryOf,
} from './changesets/core.js';
import { changeSetConfig, changeSetRoutes } from './changesets/api.js';
import { checkOpenLimits, documentOperation } from './changesets/drafts.js';
import { withSteward } from './changesets/steward.js';
import { notifyProposed } from './changesets/notify.js';
import { revisionOf } from './changesets/entries.js';
import type { EntryChange, Region } from './changesets/track.js';
import { me } from '../auth/access.js';
import { asProposer, canManageCatalogue, plantManagesSome, plantProposesSome } from './access.js';
import { advisoryRoutes } from './advisories/routes.js';
import { historyRetention, historyUsage, setHistoryRetention } from './changesets/retention.js';
import { audit, withAuditDetails } from '../audit.js';

/**
 * The plant registry's internal API (#218), mounted under /api. Every route answers 404 PLANT_MODULE_OFF while the
 * module is off (except its switch in the settings); rights are checked per site in the services (plant/access.ts).
 *
 *   GET|PUT /api/settings/plant                          the switch and the settings (administrators)
 *   GET|PUT /api/settings/plant/history                  the retention of the history, what it takes (administrators, 0.15.0)
 *   GET     /api/plant/config | /schema | /hierarchy     what the pages need; the JSON Schema of the import format
 *   …       /api/plant/sites[/:siteId[/nodes|/buildings|/links|/access]]
 *   …       /api/plant/assets[/:assetId[/image|/links|/assignment]]
 *   …       /api/plant/profiles[/:profileId[/points/:pointId]], /api/plant/kpis[/:kpiId]   the catalogues of part 2 (#219)
 *   POST    /api/plant/profiles/extract-base[/candidates|/preview]   a base profile from the shared data points (0.12.0)
 *   GET     /api/plant/explore/points, /api/plant/checks
 *   …       /api/plant/sites/:siteId/network, …/vlans[/:vlanId[/segment]], …/zones[/:zoneId], …/conduits[/:conduitId]   the OT network (#220)
 *   …       /api/plant/assets/:assetId/network, …/devices[/:deviceId], …/paths[/:pathId], …/checks
 *   …       /api/plant/assets/:assetId/collections[/:collectionId[/mapping|/flow]], …/collections/import[/preview]   data collections (0.11.0; flow 0.12)
 *   GET     /api/plant/assets/:assetId/collection-sources[/diff | /:sourceId/file]   the kept files of collection imports (0.12)
 *   …       …/collections/:collectionId/sinks/:sinkId/insights-hub[/mapping|/mapping.csv|/bulk|/csv|/check|/monitor]   the Insights Hub mapping of a sink (0.14)
 *   GET     /api/plant/sites/:siteId/insights-hub, /api/plant/monitors/:monitorId/insights-hub   its coverage per site and per monitor (0.14)
 *   GET     /api/plant/documents?kind=&id=                the Documents panel of plant pages (0.12)
 *   POST    /api/plant/documents/confirm, PUT …/sites/:siteId/doc-review, GET …/sites/:siteId/documentation   still current (0.14)
 *   GET     /api/plant/collections?collectorKind=&collectorRef=, …/profiles/:profileId/points/:pointId/collections
 *   GET     /api/plant/views/overview | /views/coverage, …/structure, …/flow, …/lineage   the visualizations (#230)
 *   POST    /api/plant/move/preview | /api/plant/move   devices (with their data paths) or data collections to another asset (0.16)
 *   POST    /api/plant/assets/:assetId/devices/:deviceId/duplicate   a copy of a device on this or another asset (0.16)
 *   POST    /api/plant/import/preview | /api/plant/import, GET /api/plant/imports, GET /api/plant/export
 *   GET|PUT /api/settings/plant/map, POST …/map/check     the map's source (administrators, session; a new source asks for a step-up)
 *   GET     /api/plant/map/sites | /map/status | /map/style.json   the map of sites (#234), what the reader may see
 *   GET     /api/plant/map/tiles/:layer/:z/:x/:y, …/glyphs/:fontstack/:range, …/sprites/:sprite   served through Steward
 */

/** The route's parameters; a read takes old ids (aliases, 0.11.0) as the entries they lead to. */
const p = (req: FastifyRequest) => (req.method === 'GET' ? currentParams(req.params as Record<string, string>) : req.params) as Record<string, string>;
const q = <Q extends Record<string, unknown>>(v: Q): Q => currentQuery(v);

/** The step-up points of an import, read once per request (`when` and `points` both ask). */
const importPoints = new WeakMap<FastifyRequest, string[]>();
const importPointsOf = (req: FastifyRequest): string[] => {
  let x = importPoints.get(req);
  if (!x) importPoints.set(req, (x = importStepUpPoints(req.body)));
  return x;
};
const imports = { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.plantImport.bytes };
const collectionImports = { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.plantCollectionImport.bytes };

/** A tile, glyph range or sprite file: inert (nosniff, no scripts), cached by this browser only. */
const sendMapFile = (reply: FastifyReply, f: Fetched) =>
  reply
    .header('cache-control', 'private, max-age=3600')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .type(f.type)
    .send(f.body);
/** Tiles need a signed-in browser session (no API tokens) and are limited per user. */
const mapFiles = { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.mapTiles } };

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

/**
 * A write route of an entry through a change set (0.13.0, changesets/write.ts): the body's `revision` (what the form
 * loaded) is taken off before the route's strict schema; DELETE takes it as `?revision=`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the routes' bodies, typed by their schemas
type Body = any;
function write<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  target: (b: Body) => WriteTarget,
  schema: { parse: (v: unknown) => Body } | null,
  run: (b: Body) => T,
  reread: (r: T, changes: EntryChange[]) => T,
  removeValue?: Record<string, unknown>,
) {
  const { body, revision } = splitRevision(req.body);
  const parsed = schema ? schema.parse(body) : (removeValue ?? {});
  const q = req.query as { revision?: unknown } | undefined;
  const fromQuery = req.method === 'DELETE' && typeof q?.revision === 'string' && /^\d{1,9}$/.test(q.revision) ? Number(q.revision) : undefined;
  return entryWrite(req, reply, target(parsed), parsed, revision ?? fromQuery, () => run(parsed), reread);
}

/** Device profiles and KPI definitions with their revision (0.13.0: what the edit form sends back). */
const withRevision =
  (kind: 'profile' | 'kpi') =>
  <T extends { id: string }>(x: T): T & { revision: number } => ({ ...x, revision: revisionOf(kind, '', x.id) ?? 1 });
const profileWithRevision = (id: string) => {
  const x = cat.getProfile(id);
  return { ...x, revision: revisionOf('profile', '', x.id) ?? 1 };
};
const kpiWithRevision = (id: string) => {
  const x = cat.getKpi(id);
  return { ...x, revision: revisionOf('kpi', '', x.id) ?? 1 };
};

/** A change of one request that is no entry's form (an extraction, a collection import): a change set applied at once. */
const directly = <T>(source: PlantChangeSetSource, title: string, region: Region, fn: () => T): T => applyDirect({ source, title, region, ops: [], fn }).result;

/**
 * Where review is required (plant.changeSet), an import, bulk change or rename asked for through its route becomes a
 * proposed change set (202) – also for API tokens: a nightly sync into a reviewed site becomes a proposal.
 */
function proposed(kind: 'import' | 'bulk' | 'rename' | 'move', title: string, op: Parameters<typeof insertOp>[1], sites: string[], catalogue: boolean) {
  const u = me();
  checkOpenLimits(u);
  const id = insertChangeSet({ state: 'proposed', source: kind, title, by: u.username, sites, catalogue });
  insertOp(id, op, u.username);
  const r = rowOf(id)!;
  audit({
    action: 'plant.change_set_proposed',
    entityType: 'plant_change_set',
    entityId: id,
    summary: `Plant change set "${title}" (${kind}) proposed by ${u.username} – changes here need a second person`,
    details: { source: kind, createdBy: u.username, sites: sites.slice(0, 50) },
  });
  notifyProposed(id);
  return summaryOf(r, u);
}

/** Whether the reader may only propose (no manage right where it applies, the propose right on some site): previews show
 * what applying would do for their draft. */
const proposesOnly = (catalogue: boolean): boolean => {
  const u = me();
  return !(catalogue ? canManageCatalogue(u) : plantManagesSome(u)) && plantProposesSome(u);
};

/** The sites and the catalogue an import's preview touches. */
const touchedBy = (changes: { kind: string; siteId: string }[]) => ({
  sites: [...new Set(changes.map((c) => c.siteId).filter(Boolean))],
  catalogue: changes.some((c) => c.kind === 'profile' || c.kind === 'kpi'),
});

/** The demo shows the module with its invented enterprise once it is turned on. */
export function plantDemo(): void {
  if (config.demo)
    try {
      seedPlantDemo();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'plant registry demo data not loaded');
    }
}

export async function plantRoutes(app: FastifyInstance): Promise<void> {
  // 0.13.0: change sets – drafts, review, apply, history (docs/PLANT.md "Change sets")
  await changeSetRoutes(app);
  // 0.14: security advisories (CSAF 2.0) matched to assets (docs/ADVISORIES.md)
  await advisoryRoutes(app);
  // ---------- settings (the module switch works while the module is off) ----------
  app.get('/settings/plant', { config: { access: ACCESS.admin } }, async () => plantSettings());
  // turning the module on or off is a module switch (0.11.0, ADR 0016): the same step-up as Settings → Modules
  app.put(
    '/settings/plant',
    {
      config: {
        access: ACCESS.admin,
        stepUp: {
          action: 'changeModules',
          when: (req: FastifyRequest) => {
            const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
            return typeof enabled === 'boolean' && enabled !== plantSettings().enabled;
          },
        },
      },
    },
    async (req) => updatePlantSettings(plantSettingsInput.parse(req.body), plantDemo),
  );

  // 0.23.0 (ADR 0034 decision 11): the content of the settings – enterprise, labels, own fields, review intervals – for
  // administrators and the managers an administrator granted the plant registry's manager role (a signed-in session)
  app.get('/plant/settings', async () => {
    requirePlant();
    if (!mayChangeModuleSetting('plant', 'labels')) forbid('change the settings of the plant registry', 'moduleSettings');
    return plantManagerSettings();
  });
  app.put('/plant/settings', { config: { access: ACCESS.session } }, async (req) => {
    requirePlant();
    if (!mayChangeModuleSetting('plant', 'labels')) forbid('change the settings of the plant registry', 'moduleSettings');
    return updatePlantManagerSettings(plantManagerSettingsInput.parse(req.body), (key) => mayChangeModuleSetting('plant', key));
  });

  // 0.15.0: how long the history and its bookkeeping are kept, and what they take (ADR 0020)
  const historyView = (): PlantHistorySettingsView => ({ settings: historyRetention(), usage: historyUsage() });
  app.get('/settings/plant/history', { config: { access: ACCESS.admin } }, async () => {
    requirePlant();
    return historyView();
  });
  app.put('/settings/plant/history', { config: { access: ACCESS.admin } }, async (req) => {
    requirePlant();
    setHistoryRetention(plantHistorySettingsInput.parse(req.body));
    return historyView();
  });

  // ---------- the map of sites (#234): its source is the administrators'; changing it asks for a step-up ----------
  app.get('/settings/plant/map', { config: { access: ACCESS.adminSession } }, async () => {
    requirePlant();
    return mapSettingsView();
  });
  app.put(
    '/settings/plant/map',
    { config: { access: ACCESS.adminSession, stepUp: { action: 'changeMapSource', when: (req: FastifyRequest) => changesMapSource(mapBody(req.body)) } } },
    async (req) => updateMapSettings(mapSettingsInput.parse(req.body)),
  );
  // reading a new address is the first step of a new source: the same step-up (the stored source checks freely)
  app.post(
    '/settings/plant/map/check',
    {
      config: {
        access: ACCESS.adminSession,
        rateLimit: ROUTE_LIMITS.action,
        stepUp: { action: 'changeMapSource', when: (req: FastifyRequest) => checkNeedsStepUp(checkBody(req.body)) },
      },
    },
    async (req) => {
      requirePlant();
      const own = mapSettingsInput.shape.own.unwrap().parse(req.body);
      return checkMapSource(own);
    },
  );
  app.get('/plant/map/sites', async () => mapSites());
  app.get('/plant/map/status', { config: { access: ACCESS.session } }, async () => mapStatus());
  app.get('/plant/map/style.json', { config: { access: ACCESS.session } }, async (req, reply) => {
    const q = z
      .object({ theme: z.enum(['light', 'dark']).default('light'), lang: z.enum(['en', 'de']).default('en'), v: z.string().max(40).optional() })
      .parse(req.query);
    reply.header('cache-control', 'private, max-age=600');
    return mapStyle(q.theme, q.lang);
  });
  app.get('/plant/map/tiles/:layer/:z/:x/:y', mapFiles, async (req, reply) =>
    sendMapFile(reply, await forReader(() => mapTile(p(req).layer!, p(req).z!, p(req).x!, p(req).y!))),
  );
  app.get('/plant/map/glyphs/:fontstack/:range', mapFiles, async (req, reply) =>
    sendMapFile(reply, await forReader(() => mapGlyphs(p(req).fontstack!, p(req).range!))),
  );
  app.get('/plant/map/sprites/:sprite', mapFiles, async (req, reply) => sendMapFile(reply, await forReader(() => mapSprite(p(req).sprite!))));

  // ---------- module ----------
  app.get('/plant/config', async () => ({ ...svc.plantConfig(), changeSets: changeSetConfig() }));
  app.get('/plant/schema', async () => {
    requirePlant();
    return plantJsonSchema();
  });
  app.get('/plant/hierarchy', async (req) => svc.hierarchy(q(z.object({ site: z.string().max(100).optional() }).parse(req.query)).site));

  // ---------- sites ----------
  app.get('/plant/sites', async () => svc.listSites());
  app.post('/plant/sites', async (req, reply) =>
    write(
      req,
      reply,
      (b) => ({ kind: 'site', op: 'add', scope: '', id: b.id }),
      svc.siteInput,
      (b) => svc.createSite(b),
      (r) => svc.getSite(r.id),
    ),
  );
  app.get('/plant/sites/:siteId', async (req) => svc.getSite(p(req).siteId!));
  app.put('/plant/sites/:siteId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'site', op: 'set', scope: '', id: p(req).siteId! }),
      svc.siteUpdate,
      (b) => svc.updateSite(p(req).siteId!, b),
      () => svc.getSite(p(req).siteId!),
    ),
  );
  app.delete('/plant/sites/:siteId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'site', op: 'remove', scope: '', id: p(req).siteId! }),
      null,
      () => {
        svc.deleteSite(p(req).siteId!);
        return { ok: true };
      },
      (r) => r,
    ),
  );
  // 0.13.0: the site's switch "Changes need a second person" (plant.changeSet optional) – a step-up as for access grants
  app.put('/plant/sites/:siteId/review', { config: { stepUp: { action: 'grantAccess' } } }, async (req) =>
    setSiteReview(p(req).siteId!, plantSiteReviewInput.parse(req.body).review),
  );
  // deprecated since 0.23.0 (ADR 0033 phase 2): the access list is written as shares (PUT /api/access/site/:id/shares);
  // a widening is confirmed like every other grant (step-up, access.grant) – narrowing no longer asks. Session only
  app.put(
    '/plant/sites/:siteId/access',
    { config: { access: ACCESS.session, stepUp: accessGrantRule((req) => aliasWidens('site', p(req).siteId!, (req.body as { acl?: unknown } | null)?.acl)) } },
    async (req, reply) => {
      const out = svc.setSiteAccess(p(req).siteId!, z.object({ acl: z.array(z.unknown()).max(500) }).parse(req.body).acl);
      markDeprecated(reply, 'site', out.id);
      return out;
    },
  );
  const siteAgain = (req: FastifyRequest) => () => svc.getSite(p(req).siteId!);
  app.post('/plant/sites/:siteId/nodes', async (req, reply) =>
    write(
      req,
      reply,
      (b) => ({ kind: 'node', op: 'add', scope: p(req).siteId!, id: b.id }),
      svc.nodeInput,
      (b) => svc.createNode(p(req).siteId!, b),
      siteAgain(req),
    ),
  );
  app.put('/plant/sites/:siteId/nodes/:nodeId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'node', op: 'set', scope: p(req).siteId!, id: p(req).nodeId! }),
      svc.nodeUpdate,
      (b) => svc.updateNode(p(req).siteId!, p(req).nodeId!, b),
      siteAgain(req),
    ),
  );
  app.delete('/plant/sites/:siteId/nodes/:nodeId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'node', op: 'remove', scope: p(req).siteId!, id: p(req).nodeId! }),
      null,
      () => svc.deleteNode(p(req).siteId!, p(req).nodeId!),
      siteAgain(req),
    ),
  );
  app.post('/plant/sites/:siteId/buildings', async (req, reply) =>
    write(
      req,
      reply,
      (b) => ({ kind: 'building', op: 'add', scope: p(req).siteId!, id: b.id }),
      svc.buildingInput,
      (b) => svc.createBuilding(p(req).siteId!, b),
      siteAgain(req),
    ),
  );
  app.put('/plant/sites/:siteId/buildings/:buildingId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'building', op: 'set', scope: p(req).siteId!, id: p(req).buildingId! }),
      svc.buildingUpdate,
      (b) => svc.updateBuilding(p(req).siteId!, p(req).buildingId!, b),
      siteAgain(req),
    ),
  );
  app.delete('/plant/sites/:siteId/buildings/:buildingId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'building', op: 'remove', scope: p(req).siteId!, id: p(req).buildingId! }),
      null,
      () => svc.deleteBuilding(p(req).siteId!, p(req).buildingId!),
      siteAgain(req),
    ),
  );

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
  app.get('/plant/assets', async (req) => svc.listAssets(q(assetQuery.parse(req.query))));
  app.post('/plant/assets', async (req, reply) =>
    write(
      req,
      reply,
      (b) => ({ kind: 'asset', op: 'add', scope: '', id: b.id }),
      svc.assetInput,
      (b) => svc.createAsset(b),
      (r) => svc.getAsset(r.id),
    ),
  );
  app.get('/plant/assets/:assetId', async (req) => svc.getAsset(p(req).assetId!));
  app.put('/plant/assets/:assetId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'asset', op: 'set', scope: '', id: p(req).assetId! }),
      svc.assetUpdate,
      (b) => svc.updateAsset(p(req).assetId!, b),
      () => svc.getAsset(p(req).assetId!),
    ),
  );
  app.delete('/plant/assets/:assetId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'asset', op: 'remove', scope: '', id: p(req).assetId! }),
      null,
      () => {
        svc.deleteAsset(p(req).assetId!);
        return { ok: true };
      },
      (r) => r,
    ),
  );
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
  app.put('/plant/assets/:assetId/assignment', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'assignment', op: 'set', scope: '', id: p(req).assetId! }),
      assignmentInput,
      (b) => putAssignment(p(req).assetId!, b),
      () => getAssignment(p(req).assetId!),
    ),
  );
  app.delete('/plant/assets/:assetId/assignment', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'assignment', op: 'remove', scope: '', id: p(req).assetId! }),
      null,
      () => deleteAssignment(p(req).assetId!),
      () => getAssignment(p(req).assetId!),
    ),
  );

  // ---------- device profiles and KPI definitions: catalogues of the installation (#219) ----------
  app.get('/plant/profiles', async () => cat.listProfiles());
  // 0.21.0 (#293): how many device profiles and KPI definitions the caller may not see (the lists count them)
  app.get('/plant/catalogue/hidden', async (req) => {
    requirePlant();
    const q = z.object({ q: z.string().max(200).optional() }).parse(req.query).q;
    return { ...hiddenCatalogue(), ...(q?.trim() ? { points: cat.hiddenPointMatches(q) } : {}) };
  });
  app.post('/plant/profiles', async (req, reply) =>
    write(
      req,
      reply,
      (b) => ({ kind: 'profile', op: 'add', scope: '', id: b.id }),
      cat.profileInput,
      (b) => cat.createProfile(b),
      // the service's answer is read after its write: only the revision is new
      withRevision('profile'),
    ),
  );
  // 0.12.0: extract a base profile from two or more profiles (the shared data points; docs/PLANT.md)
  app.post('/plant/profiles/extract-base/candidates', async (req) => extractCandidates(candidatesInput.parse(req.body)));
  app.post('/plant/profiles/extract-base/preview', async (req) => previewExtract(extractInput.parse(req.body)));
  app.post('/plant/profiles/extract-base', async (req) => {
    const input = extractInput.parse(req.body);
    return directly('edit', 'Base profile extracted', { catalogue: true, assignments: true }, () => extractBase(input));
  });
  app.get('/plant/profiles/:profileId', async (req) => profileWithRevision(p(req).profileId!));
  app.put('/plant/profiles/:profileId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'profile', op: 'set', scope: '', id: p(req).profileId! }),
      cat.profileUpdate,
      (b) => cat.updateProfile(p(req).profileId!, b),
      withRevision('profile'),
    ),
  );
  app.delete('/plant/profiles/:profileId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'profile', op: 'remove', scope: '', id: p(req).profileId! }),
      null,
      () => {
        cat.deleteProfile(p(req).profileId!);
        return { ok: true };
      },
      (r) => r,
    ),
  );
  app.get('/plant/profiles/:profileId/points/:pointId', async (req) => cat.getDataPoint(p(req).profileId!, p(req).pointId!));
  app.get('/plant/kpis', async () => cat.listKpis());
  app.post('/plant/kpis', async (req, reply) =>
    write(
      req,
      reply,
      (b) => ({ kind: 'kpi', op: 'add', scope: '', id: b.id }),
      cat.kpiInput,
      (b) => cat.createKpi(b),
      withRevision('kpi'),
    ),
  );
  app.get('/plant/kpis/:kpiId', async (req) => kpiWithRevision(p(req).kpiId!));
  app.put('/plant/kpis/:kpiId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'kpi', op: 'set', scope: '', id: p(req).kpiId! }),
      cat.kpiUpdate,
      (b) => cat.updateKpi(p(req).kpiId!, b),
      withRevision('kpi'),
    ),
  );
  app.delete('/plant/kpis/:kpiId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'kpi', op: 'remove', scope: '', id: p(req).kpiId! }),
      null,
      () => {
        cat.deleteKpi(p(req).kpiId!);
        return { ok: true };
      },
      (r) => r,
    ),
  );
  // which assets deliver a data point (by text across the profiles); every check of what the caller may see
  app.get('/plant/explore/points', async (req) => cat.explorePoints(z.object({ q: z.string().max(200).default('') }).parse(req.query).q));
  app.get('/plant/checks', async () => cat.listChecks());

  // ---------- the OT network (#220): VLANs, IEC 62443-3-2 zones and conduits of a site; devices, data paths, checks ----------
  app.get('/plant/sites/:siteId/network', async (req) => net.siteNetwork(p(req).siteId!));
  const netAgain =
    (req: FastifyRequest) =>
    <T>(r: T, changes: EntryChange[]): T =>
      revisedNetwork(r, changes) ?? (net.siteNetwork(p(req).siteId!) as T);
  // the service's answer with the new revisions (read again only when it cannot be placed)
  const assetNetAgain =
    (req: FastifyRequest) =>
    <T>(r: T, changes: EntryChange[]): T =>
      revisedNetwork(r, changes) ?? (net.assetNetwork(p(req).assetId!) as T);
  for (const [kind, path, param, input, update, create, change, remove] of [
    ['vlan', 'vlans', 'vlanId', net.vlanInput, net.vlanUpdate, net.createVlan, net.updateVlan, net.deleteVlan],
    ['zone', 'zones', 'zoneId', net.zoneInput, net.zoneUpdate, net.createZone, net.updateZone, net.deleteZone],
    ['conduit', 'conduits', 'conduitId', net.conduitInput, net.conduitUpdate, net.createConduit, net.updateConduit, net.deleteConduit],
  ] as const) {
    app.post(`/plant/sites/:siteId/${path}`, async (req, reply) =>
      write(
        req,
        reply,
        (b) => ({ kind, op: 'add', scope: p(req).siteId!, id: b.id }),
        input,
        (b) => (create as (s: string, b: unknown) => unknown)(p(req).siteId!, b),
        netAgain(req),
      ),
    );
    app.put(`/plant/sites/:siteId/${path}/:${param}`, async (req, reply) =>
      write(
        req,
        reply,
        () => ({ kind, op: 'set', scope: p(req).siteId!, id: p(req)[param]! }),
        update,
        (b) => (change as (s: string, i: string, b: unknown) => unknown)(p(req).siteId!, p(req)[param]!, b),
        netAgain(req),
      ),
    );
    app.delete(`/plant/sites/:siteId/${path}/:${param}`, async (req, reply) =>
      write(
        req,
        reply,
        () => ({ kind, op: 'remove', scope: p(req).siteId!, id: p(req)[param]! }),
        null,
        () => remove(p(req).siteId!, p(req)[param]!),
        netAgain(req),
      ),
    );
  }
  // "Create segment from this VLAN": a Steward network segment (the catalogue's rights apply), linked to the VLAN
  app.post('/plant/sites/:siteId/vlans/:vlanId/segment', async (req) => {
    const name = z
      .object({ name: z.string().trim().min(1).max(120).optional() })
      .strict()
      .parse(req.body ?? {}).name;
    return directly('edit', `VLAN "${p(req).vlanId!}" linked to a segment`, { sites: [p(req).siteId!] }, () =>
      net.createSegmentFromVlan(p(req).siteId!, p(req).vlanId!, name),
    );
  });
  app.get('/plant/assets/:assetId/network', async (req) => net.assetNetwork(p(req).assetId!));
  app.put('/plant/assets/:assetId/checks', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'asset_checks', op: 'set', scope: '', id: p(req).assetId! }),
      net.assetChecksInput,
      (b) => net.putAssetChecks(p(req).assetId!, b),
      assetNetAgain(req),
    ),
  );
  for (const [kind, path, param, input, update, create, change, remove] of [
    ['device', 'devices', 'deviceId', net.deviceInput, net.deviceUpdate, net.createDevice, net.updateDevice, net.deleteDevice],
    ['data_path', 'paths', 'pathId', net.dataPathInput, net.dataPathUpdate, net.createDataPath, net.updateDataPath, net.deleteDataPath],
  ] as const) {
    app.post(`/plant/assets/:assetId/${path}`, async (req, reply) =>
      write(
        req,
        reply,
        (b) => ({ kind, op: 'add', scope: p(req).assetId!, id: b.id }),
        input,
        (b) => (create as (s: string, b: unknown) => unknown)(p(req).assetId!, b),
        assetNetAgain(req),
      ),
    );
    app.put(`/plant/assets/:assetId/${path}/:${param}`, async (req, reply) =>
      write(
        req,
        reply,
        () => ({ kind, op: 'set', scope: p(req).assetId!, id: p(req)[param]! }),
        update,
        (b) => (change as (s: string, i: string, b: unknown) => unknown)(p(req).assetId!, p(req)[param]!, b),
        assetNetAgain(req),
      ),
    );
    app.delete(`/plant/assets/:assetId/${path}/:${param}`, async (req, reply) =>
      write(
        req,
        reply,
        () => ({ kind, op: 'remove', scope: p(req).assetId!, id: p(req)[param]! }),
        null,
        () => remove(p(req).assetId!, p(req)[param]!),
        assetNetAgain(req),
      ),
    );
  }
  // 0.16: a duplicate of a device, on this asset or another – its fields, not what identifies the original or watches it
  app.post('/plant/assets/:assetId/devices/:deviceId/duplicate', async (req, reply) => {
    const { body: raw, revision } = splitRevision(req.body);
    const input = plantDuplicateDeviceInput.parse(raw);
    const from = `${p(req).assetId!}/${p(req).deviceId!}`;
    const body = duplicateDeviceBody(p(req).assetId!, p(req).deviceId!, input.toAsset, input.id);
    return entryWrite(
      req,
      reply,
      { kind: 'device', op: 'add', scope: input.toAsset, id: body.id },
      body,
      revision,
      () => withAuditDetails({ copiedFrom: from }, () => net.createDevice(input.toAsset, body)),
      (r, changes) => revisedNetwork(r, changes) ?? net.assetNetwork(input.toAsset),
    );
  });
  // ---------- data collections (0.11.0, ADR 0019): what a collector reads from an asset, mapped to its data points ----------
  app.get('/plant/assets/:assetId/collections', async (req) => coll.assetCollections(p(req).assetId!));
  app.post('/plant/assets/:assetId/collections', async (req, reply) =>
    write(
      req,
      reply,
      (b) => ({ kind: 'collection', op: 'add', scope: p(req).assetId!, id: b.id }),
      coll.collectionInput,
      (b) => coll.createCollection(p(req).assetId!, b),
      (r) => coll.getCollection(p(req).assetId!, r.id),
    ),
  );
  app.get('/plant/assets/:assetId/collections/:collectionId', async (req) => coll.getCollection(p(req).assetId!, p(req).collectionId!));
  app.put('/plant/assets/:assetId/collections/:collectionId', async (req, reply) =>
    write(
      req,
      reply,
      () => ({ kind: 'collection', op: 'set', scope: p(req).assetId!, id: p(req).collectionId! }),
      coll.collectionUpdate,
      (b) => coll.updateCollection(p(req).assetId!, p(req).collectionId!, b),
      () => coll.getCollection(p(req).assetId!, p(req).collectionId!),
    ),
  );
  app.delete('/plant/assets/:assetId/collections/:collectionId', async (req, reply) => {
    // records that link to it refuse it unless "also remove what belongs to it" (0.12)
    const q = z.object({ cascade: z.enum(['0', '1', 'true', 'false']).default('0') }).parse(req.query);
    const cascade = q.cascade === '1' || q.cascade === 'true';
    return write(
      req,
      reply,
      () => ({ kind: 'collection', op: 'remove', scope: p(req).assetId!, id: p(req).collectionId! }),
      null,
      () => coll.deleteCollection(p(req).assetId!, p(req).collectionId!, cascade),
      () => coll.assetCollections(p(req).assetId!),
      { cascade },
    );
  });
  // 0.12: where the data goes – items → transformations → sinks → downstream
  app.get('/plant/assets/:assetId/collections/:collectionId/flow', async (req) => coll.collectionFlow(p(req).assetId!, p(req).collectionId!));
  // 0.12: the kept files of collection imports (secrets removed): the versions, one file, two versions compared
  app.get('/plant/assets/:assetId/collection-sources', async (req) => {
    const q = z.object({ collection: z.string().min(1).max(100).optional() }).parse(req.query);
    return { assetId: p(req).assetId!, sources: listSources(p(req).assetId!, q.collection) };
  });
  app.get('/plant/assets/:assetId/collection-sources/diff', async (req) => {
    const q = z.object({ from: z.string().min(1).max(100), to: z.string().min(1).max(100) }).parse(req.query);
    return diffSources(p(req).assetId!, q.from, q.to);
  });
  app.get('/plant/assets/:assetId/collection-sources/:sourceId/file', async (req, reply) => {
    const x = sourceFile(p(req).assetId!, p(req).sourceId!);
    reply.header('content-disposition', contentDisposition(x.filename));
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.type(x.contentType).send(x.content);
  });
  app.get('/plant/assets/:assetId/collections/:collectionId/mapping', async (req, reply) => {
    const q = z.object({ format: z.enum(['csv', 'yaml']).default('csv') }).parse(req.query);
    const x = coll.mappingFile(p(req).assetId!, p(req).collectionId!, q.format);
    reply.header('content-disposition', `attachment; filename="${x.filename}"`);
    reply.header('cache-control', 'no-store');
    return reply.type(x.contentType).send(x.content);
  });
  // who may only propose sees what the files would do with their propose right counted as manage – to add them to their
  // draft (0.19.0; a dry run that is rolled back and audits nothing)
  app.post('/plant/assets/:assetId/collections/import/preview', collectionImports, async (req) => {
    const input = collectionImportInput.parse(req.body);
    const assetId = p(req).assetId!;
    if (!proposesOnly(false)) return previewCollectionImport(assetId, input);
    return quietDryRun(() => asProposer(() => previewCollectionImport(assetId, input)));
  });
  // 0.19.0: an operation of a change set of its own (ADR 0020) – applied at once, or proposed where review is required
  app.post('/plant/assets/:assetId/collections/import', collectionImports, async (req, reply) => {
    const input = collectionImportInput.parse(req.body);
    const assetId = p(req).assetId!;
    const title = `Collection import into asset "${assetId}"`;
    const op = documentOperation('collections', { assetId, ...input }, me());
    const region = collectionsRegion(assetId, collectionsTouchProfile(input));
    if (changeSetLevel() !== 'off') {
      // what it would do now (refused as the import refuses it), and whether that needs a second person
      const f = previewFingerprint(region, () => applyCollectionImport(assetId, input));
      const where = touchedBy(f.changes);
      if (f.changes.length && reviewNeeded(where.sites, where.catalogue)) {
        const changeSet = proposed('import', title, op, where.sites, where.catalogue);
        reply.code(202);
        return { preview: f.result.preview, changeSet };
      }
    }
    const done = applyDirect({
      source: 'import',
      title,
      region,
      // the files are kept as the collector's sources (collection-sources); a proposed import keeps them whole
      ops: [{ ...op, source: undefined }],
      fn: () => applyCollectionImport(assetId, input),
    });
    return { ...done.result, changeSetId: done.changeSetId };
  });
  // ---------- 0.14: Insights Hub as a mapped sink (docs/PLANT.md "Insights Hub mapping") ----------
  const sinkBase = '/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub';
  const ids = (req: FastifyRequest) => [p(req).assetId!, p(req).collectionId!, p(req).sinkId!] as const;
  /**
   * A change of the mapping is a change of the collection: saved as its edit form saves it (its revision, a draft where
   * the site needs a second person), audited as plant.collection_updated with what the change was.
   */
  const ihWrite = (
    req: FastifyRequest,
    reply: FastifyReply,
    via: 'edit' | 'bulk' | 'csv',
    revision: number | undefined,
    change: (v: ReturnType<typeof collectionValuesOf>, refs: ReturnType<typeof refsOf>) => { sinks: PlantCollectionSink[]; changed: number },
  ) => {
    const [assetId, collectionId, sinkId] = ids(req);
    ih.sinkOf(assetId, collectionId, sinkId);
    const v = collectionValuesOf(collectionRowOf(assetId, collectionId)!);
    const { sinks, changed } = change(v, refsOf('asset', [assetId]));
    const { id: _id, ...rest } = v;
    const body = coll.collectionUpdate.parse({ ...rest, destination: null, sinks });
    return entryWrite(
      req,
      reply,
      { kind: 'collection', op: 'set', scope: assetId, id: collectionId },
      body,
      revision,
      () =>
        withAuditDetails({ insightsHub: { sink: sinkId, via, items: changed } }, () => {
          coll.updateCollection(assetId, collectionId, body);
          return { ...ih.ihMapping(assetId, collectionId, sinkId), changed };
        }),
      () => ({ ...ih.ihMapping(assetId, collectionId, sinkId), changed }),
    );
  };
  app.get(sinkBase, async (req) => ih.ihMapping(...ids(req)));
  app.put(`${sinkBase}/mapping`, { bodyLimit: LARGE_BODIES.plantIhMapping.bytes }, async (req, reply) => {
    const b = ih.ihMappingInput.parse(req.body);
    return ihWrite(req, reply, 'edit', b.revision, (v) => ({ sinks: ih.mappingSinks(v, p(req).sinkId!, b), changed: b.items.length }));
  });
  app.post(`${sinkBase}/bulk`, async (req, reply) => {
    const b = ih.ihBulkInput.parse(req.body);
    return ihWrite(req, reply, 'bulk', b.revision, (v, refs) => ih.bulkSinks(v, p(req).sinkId!, b, refs.get(p(req).assetId!) ?? []));
  });
  app.post(`${sinkBase}/csv`, { bodyLimit: LARGE_BODIES.plantIhMapping.bytes }, async (req, reply) => {
    const b = ih.ihCsvInput.parse(req.body);
    return ihWrite(req, reply, 'csv', b.revision, (v) => ih.csvSinks(v, p(req).sinkId!, b));
  });
  app.get(`${sinkBase}/mapping.csv`, async (req, reply) => {
    const x = ih.mappingCsv(...ids(req));
    reply.header('content-disposition', contentDisposition(x.filename));
    reply.header('cache-control', 'no-store');
    return reply.type('text/csv; charset=utf-8').send(x.content);
  });
  // reads the tenant (read-only, bounded) with the platform's identity: the right to use it is needed besides
  app.post(`${sinkBase}/check`, { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => checkIhMapping(...ids(req)));
  // a disabled monitor for the variables no check watches – a draft for review, never enabled here
  app.post(`${sinkBase}/monitor`, { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req, reply) => {
    const r = await createIhMonitor(...ids(req), ihMonitorInput.parse(req.body ?? {}));
    return reply.code(201).send(r);
  });
  app.get('/plant/sites/:siteId/insights-hub', async (req) => {
    requirePlant();
    return ih.siteIhCoverage(p(req).siteId!);
  });
  app.get('/plant/monitors/:monitorId/insights-hub', async (req) => {
    requirePlant();
    return ih.monitorIhCoverage(p(req).monitorId!);
  });
  app.get('/plant/collections', async (req) => {
    const q = z.object({ collectorKind: z.enum(['application', 'platform', 'process', 'job']), collectorRef: z.string().min(1).max(200) }).parse(req.query);
    return coll.collectorCollections(q.collectorKind, q.collectorRef);
  });
  app.get('/plant/profiles/:profileId/points/:pointId/collections', async (req) => coll.pointCollections(p(req).profileId!, p(req).pointId!));

  // ---------- 0.12: the records linked to a plant entry and those it inherits (the Documents panel) ----------
  app.get('/plant/documents', async (req) => {
    const q = z.object({ kind: z.enum(PLANT_DOC_KINDS), id: z.string().min(1).max(300) }).parse(req.query);
    // a read takes old ids (aliases) of sites, assets and profiles as the entries they lead to
    const id =
      q.kind === 'site'
        ? currentParams({ siteId: q.id }).siteId!
        : q.kind === 'asset'
          ? currentParams({ assetId: q.id }).assetId!
          : q.kind === 'device-profile'
            ? currentParams({ profileId: q.id }).profileId!
            : q.id;
    return plantDocuments(q.kind, id);
  });
  // 0.14: documentation still current – "Still current" on a document or an asset's documentation as a whole (a light
  // action, not a change set: it changes no entry), the site's review interval (a setting of the site), the health view
  app.post('/plant/documents/confirm', async (req) => docReview.confirmCurrent(docReview.confirmInput.parse(req.body)));
  app.put('/plant/sites/:siteId/doc-review', async (req) => docReview.setSiteDocReview(p(req).siteId!, docReview.siteDocReviewInput.parse(req.body).months));
  app.get('/plant/sites/:siteId/documentation', async (req) => docReview.documentationHealth(p(req).siteId!));

  // ---------- visualizations (#230): read-only aggregates, the same rights as the pages they picture ----------
  app.get('/plant/views/overview', async () => overview());
  app.get('/plant/views/coverage', async (req) =>
    coverage(
      z
        .object({
          site: z.string().max(100).optional(),
          area: z.string().max(100).optional(),
          profile: z.string().max(100).optional(),
          kpi: z.string().max(100).optional(),
        })
        .parse(req.query),
    ),
  );
  app.get('/plant/sites/:siteId/structure', async (req) => siteStructure(p(req).siteId!));
  app.get('/plant/sites/:siteId/network/placement', async (req) => hostPlacement(p(req).siteId!));
  app.get('/plant/assets/:assetId/flow', async (req) => assetFlow(p(req).assetId!));
  app.get('/plant/profiles/:profileId/points/:pointId/lineage', async (req) => pointLineage(p(req).profileId!, p(req).pointId!));

  // ---------- ids (0.11.0): renaming an entry, the old ids that keep leading to it, many entries at once ----------
  // 0.13.0: previews carry the fingerprint of what applying writes; applying with it refuses a different result
  app.post('/plant/ids/rename/preview', async (req) => {
    const { fingerprint: _f, ...input } = plantRenameInput.parse(req.body);
    const pre = previewRename(input);
    return pre.problem ? pre : { ...pre, fingerprint: previewFingerprint({ all: true }, () => renameId(input)).fingerprint };
  });
  app.post('/plant/ids/rename', { config: { stepUp: { action: 'renamePlantId', optional: true } } }, async (req, reply) => {
    const { fingerprint, ...input } = plantRenameInput.parse(req.body);
    const pre = changeSetLevel() !== 'off' ? previewRename(input) : null;
    if (pre && !pre.problem) {
      const site = input.kind === 'site' ? input.id : ['building', 'node', 'vlan', 'zone', 'conduit'].includes(input.kind) ? input.scope : null;
      const catalogue = ['profile', 'kpi', 'interface', 'data_point'].includes(input.kind);
      const sites = site
        ? [site]
        : previewFingerprint({ all: true }, () => renameId(input))
            .changes.map((c) => c.siteId)
            .filter(Boolean);
      if (reviewNeeded(sites, catalogue)) {
        const changeSet = proposed(
          'rename',
          `Change id: ${input.kind} ${input.id} → ${input.newId}`,
          {
            op: 'rename',
            kind: input.kind as never,
            scope: input.scope,
            id: input.id,
            name: pre.name,
            origin: 'authored',
            baseRevision: null,
            base: null,
            value: { newId: input.newId },
          },
          sites,
          catalogue,
        );
        reply.code(202);
        return { ...pre, changeSet };
      }
    }
    return applyDirect({
      source: 'rename',
      title: `Change id: ${input.kind} ${input.id} → ${input.newId}`,
      region: { all: true },
      ops: [
        {
          op: 'rename',
          kind: input.kind as never,
          scope: input.scope,
          id: input.id,
          name: input.id,
          origin: 'authored',
          baseRevision: null,
          base: null,
          value: { newId: input.newId },
        },
      ],
      fn: () => renameId(input),
      fingerprint,
      changedCode: 'PLANT_RENAME_CHANGED',
    }).result;
  });
  app.get('/plant/aliases', { config: { access: ACCESS.admin } }, async () => listAliases());
  app.delete('/plant/aliases/:kind/:oldId', { config: { access: ACCESS.admin } }, async (req) => {
    const kind = z.enum(PLANT_ID_KINDS).parse(p(req).kind);
    removeAlias(kind, z.object({ scope: z.string().max(120).default('') }).parse(req.query).scope, p(req).oldId!);
    return { ok: true };
  });
  app.post('/plant/bulk/preview', async (req) => {
    const { fingerprint: _f, ...input } = plantBulkInput.parse(req.body);
    // one dry run: what applying writes (its fingerprint) and the preview (computed before anything is written); who
    // may only propose sees it with their propose right counted as manage – to add it to their draft (0.13.0)
    const catalogue = input.kind === 'profile' || input.kind === 'kpi';
    const draft = proposesOnly(catalogue);
    const f = previewFingerprint(bulkRegion(input), () => (draft ? asProposer(() => applyBulk(input)) : applyBulk(input)));
    return { ...f.result, applied: false, fingerprint: f.fingerprint };
  });
  app.post(
    '/plant/bulk',
    {
      config: {
        stepUp: {
          action: 'changePlantInBulk',
          when: (req: FastifyRequest) => {
            const b = plantBulkInput.safeParse(req.body);
            return b.success && bulkNeedsStepUp(b.data);
          },
        },
      },
    },
    async (req, reply) => {
      const { fingerprint, ...input } = plantBulkInput.parse(req.body);
      if (changeSetLevel() !== 'off') {
        const f = previewFingerprint(bulkRegion(input), () => applyBulk(input));
        const where = touchedBy(f.changes);
        if (f.changes.length && reviewNeeded(where.sites, where.catalogue)) {
          const op = documentOperation('bulk', input, me());
          const changeSet = proposed(
            'bulk',
            `${input.action === 'remove' ? 'Remove' : 'Change'} ${input.items.length} ${input.kind} entries`,
            op,
            where.sites,
            where.catalogue,
          );
          reply.code(202);
          return { ...previewBulk(input), changeSet };
        }
      }
      return applyDirect({
        source: 'bulk',
        title: `${input.action === 'remove' ? 'Remove' : 'Change'} ${input.items.length} ${input.kind} entries`,
        region: bulkRegion(input),
        ops: [documentOperation('bulk', input, me())],
        fn: () => applyBulk(input),
        fingerprint,
        changedCode: 'PLANT_BULK_CHANGED',
      }).result;
    },
  );

  // ---------- 0.16: moving devices and data collections to another asset ----------
  app.post('/plant/move/preview', async (req) => {
    const { fingerprint: _f, ...input } = plantMoveInput.parse(req.body);
    // who may only propose sees what it would do with their propose right counted as manage – to add it to their draft
    const draft = proposesOnly(false);
    const pre = quietDryRun(() => (draft ? asProposer(() => previewMove(input)) : previewMove(input)));
    if (!pre.ok) return { ...pre, applied: false, references: [], changes: [], fingerprint: '' } satisfies PlantMovePreview;
    const f = previewFingerprint(moveRegion(input), () => (draft ? asProposer(() => applyMove(input)) : applyMove(input)));
    return {
      ...pre,
      applied: false,
      references: f.result.references,
      changes: entryDiffs(f.changes, me(), new Set()).entries,
      fingerprint: f.fingerprint,
    } satisfies PlantMovePreview;
  });
  app.post(
    '/plant/move',
    {
      config: {
        stepUp: {
          action: 'changePlantInBulk',
          when: (req: FastifyRequest) => {
            const b = plantMoveInput.safeParse(req.body);
            if (!b.success) return false;
            try {
              return moveNeedsStepUp(b.data);
            } catch {
              // a move that cannot be planned is refused by the handler with the same error: nothing to confirm
              return false;
            }
          },
        },
      },
    },
    async (req, reply) => {
      const { fingerprint, ...input } = plantMoveInput.parse(req.body);
      const title = `Move ${input.items.length} ${input.kind === 'device' ? 'devices' : 'data collections'} to ${input.toAsset}`;
      const op = documentOperation('move', input, me());
      if (changeSetLevel() !== 'off') {
        const f = previewFingerprint(moveRegion(input), () => applyMove(input));
        const where = touched(f.changes, [{ op: 'move', kind: null, scope: '', entry_id: '', value: JSON.stringify(input) }]);
        if (f.changes.length && reviewNeeded(where.sites, where.catalogue)) {
          const changeSet = proposed('move', title, op, where.sites, where.catalogue);
          reply.code(202);
          return { ...f.result, applied: false, changeSet };
        }
      }
      const done = applyDirect({
        source: 'move',
        title,
        region: moveRegion(input),
        ops: [op],
        fn: () => applyMove(input),
        fingerprint,
        changedCode: 'PLANT_MOVE_CHANGED',
      });
      return { ...done.result, changeSetId: done.changeSetId };
    },
  );

  // ---------- import and export ----------
  app.post('/plant/import/preview', imports, async (req) => {
    const { fingerprint: _f, ...input } = importInput.parse(req.body);
    // who may only propose sees what the files would do with their propose right counted as manage – to add them to
    // their draft (0.13.0; a dry run that is rolled back and audits nothing)
    const draft = proposesOnly(false);
    // 0.19.0: with the fields changed in Steward since the last import (kept unless taken from the file)
    const f = previewFingerprint(importRegion(input), () => {
      const st = withSteward(input, () => (draft ? asProposer(() => previewImport(input)) : previewImport(input)));
      return st.flags ? { ...st.result, changedInSteward: st.flags } : st.result;
    });
    return { ...f.result, fingerprint: f.fingerprint };
  });
  // renaming or removing more than one entry asks for a step-up (plant.bulkChange), one rename as the policy says (plant.renameId)
  app.post(
    '/plant/import',
    {
      ...imports,
      config: {
        ...imports.config,
        stepUp: { action: 'changePlantInBulk', when: (req: FastifyRequest) => importPointsOf(req).length > 0, points: importPointsOf },
      },
    },
    async (req, reply) => {
      const { fingerprint, ...input } = importInput.parse(req.body);
      if (changeSetLevel() !== 'off') {
        const pre = previewImport(input);
        const where = touchedBy(pre.changes.filter((c) => c.action !== 'unchanged' && c.action !== 'skip'));
        if (pre.ok && reviewNeeded(where.sites, where.catalogue)) {
          const op = documentOperation('import', input, me());
          const changeSet = proposed('import', `Import ${input.files.map((x) => x.name).join(', ')}`.slice(0, 200), op, where.sites, where.catalogue);
          reply.code(202);
          return { ...pre, changeSet };
        }
      }
      let kept: ((importId: string) => void) | null = null;
      return applyDirect({
        source: 'import',
        title: `Import ${input.files.map((x) => x.name).join(', ')}`.slice(0, 200),
        region: importRegion(input),
        // the files are kept by their names and hashes (plant_imports); a proposed import keeps them whole
        ops: [{ ...documentOperation('import', input, me()), source: undefined }],
        // 0.19.0: fields changed in Steward since the last import keep Steward's value unless taken from the file
        fn: () => {
          const st = withSteward(input, () => applyImport(input));
          kept = st.recordKept;
          return st.flags ? { ...st.result, changedInSteward: st.flags } : st.result;
        },
        fingerprint,
        changedCode: 'PLANT_IMPORT_CHANGED',
        importIdOf: (r) => r.import.id,
        afterBaselines: (r) => kept?.(r.import.id),
      }).result;
    },
  );
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
    const x = exportYaml(currentQuery(q));
    reply.header('content-disposition', `attachment; filename="${x.filename}"`);
    reply.header('cache-control', 'no-store');
    return reply.type(x.contentType).send(x.content);
  });
}
