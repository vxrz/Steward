import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { ItemLink, PlantAssetSummary } from '@sm/shared';
import { HttpError } from '../util.js';
import { linkTypeByKey } from '../records/link-types.js';
import { notFound } from '../api/v1/helpers.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { refsOf } from './model.js';
import { currentParams, currentQuery } from './ids.js';
import * as svc from './service.js';
import * as cat from './catalogue.js';
import { getAssignment } from './assignments.js';
import { assetNetwork, siteNetwork } from './network.js';
import { assetCollections } from './collections.js';
import { ihMapping } from './ih.js';
import { exportYaml } from './import.js';
import { assetDocumentation } from './doc-review.js';
import { visibleAsset } from './service.js';
import type { ApiPrincipal } from '../api/v1/auth.js';
import { PlantAssetListQuery, PlantCatalogueListQuery, PlantCheckListQuery, PlantExportQuery, PlantSiteListQuery } from './api-schemas.js';

/**
 * The plant registry in the public, read-only API (#218): sites with their hierarchy and buildings, assets with their
 * locations, the catalogues and assignments (#219), what Steward checks and the export in the import format. The token
 * owner sees the sites (and their assets) they may see in the web app. While the module is off every endpoint answers
 * 404.
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

function found<T>(f: () => T, what: string): T {
  try {
    return f();
  } catch (e) {
    // while the module is off every endpoint says so (the problem's type stays not-found)
    if (e instanceof HttpError && e.code === 'PLANT_MODULE_OFF')
      throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: 'The plant registry module is off (Settings → Modules)' });
    if (e instanceof HttpError && e.statusCode === 404) throw notFound(what);
    throw e;
  }
}

const mapLink = (l: ItemLink) => ({
  kind: l.kind,
  targetId: l.targetId,
  url: l.url,
  linkType: l.linkType,
  linkTypeName: l.linkType ? (linkTypeByKey(l.linkType)?.name ?? null) : null,
  label: l.label,
  note: l.note,
  visible: l.visible,
});

const page = { type: 'object', required: ['items', 'nextCursor'], additionalProperties: false } as const;
const MODULE = 'Only while the plant registry module is on (Settings → Modules); otherwise 404.';

export function plantApiRoutes(getRoute: Get): void {
  // old ids (aliases, 0.11.0) are read as the entries they lead to: in the path and in the filters that name an entry
  const get: Get = (url, op, handler) =>
    getRoute(url, op, (req, reply) => {
      found(() => {
        req.params = currentParams(req.params as Record<string, string>);
        if (req.query && typeof req.query === 'object') req.query = currentQuery(req.query as Record<string, unknown>);
      }, 'Plant registry');
      return handler(req, reply);
    });
  get(
    '/plant/sites',
    {
      operationId: 'listPlantSites',
      tag: 'Plant',
      summary: 'List the sites of the plant registry',
      description: `The sites (factories) of the enterprise the token owner may see, ordered by name, with counts of areas, buildings and assets. ${MODULE}`,
      query: PlantSiteListQuery,
      paginated: true,
      response: {
        ...page,
        description: 'A page of sites',
        properties: { items: { type: 'array', items: { $ref: 'PlantSiteEntry#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof PlantSiteListQuery>;
      const list = found(() => svc.listSites(), 'Plant registry').map(({ canManage: _c, ...s }) => s);
      const p = pageArray(list, (x) => [x.name.toLowerCase(), x.id], q, {});
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );

  get(
    '/plant/sites/:siteId',
    {
      operationId: 'getPlantSite',
      tag: 'Plant',
      summary: 'Get a site with its ISA-95 hierarchy and buildings',
      description: `Areas with their work centers and work units (each with the building that applies: the innermost one), the buildings, contacts, external references, own fields and links. ${MODULE}`,
      params: { siteId: 'Site id' },
      response: { $ref: 'PlantSiteDetailEntry#' },
    },
    async (req) => {
      const {
        canManage: _c,
        acl: _a,
        permissions: _p,
        backlinks: _b,
        refs,
        links,
        ...s
      } = found(() => svc.getSite((req.params as { siteId: string }).siteId), 'Site');
      return { ...s, externalRefs: refs, links: links.map(mapLink) };
    },
  );

  const asset = (a: PlantAssetSummary, refs: Map<string, { system: string; id: string; url: string; label: string }[]>) => {
    const { hasImage: _h, ...x } = a;
    return { ...x, externalRefs: refs.get(a.id) ?? [] };
  };

  get(
    '/plant/assets',
    {
      operationId: 'listPlantAssets',
      tag: 'Plant',
      summary: 'List assets',
      description: `Assets of the sites the token owner may see, ordered by name, with their location (site, area, work center, work unit and the building that applies) and external references. Filter by site, node, domain, status, tag or an external reference (\`ref=erp:10004711\`). ${MODULE}`,
      query: PlantAssetListQuery,
      paginated: true,
      response: {
        ...page,
        description: 'A page of assets',
        properties: { items: { type: 'array', items: { $ref: 'PlantAssetEntry#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof PlantAssetListQuery>;
      const { limit: _l, cursor: _c, ...filter } = q;
      const list = found(() => svc.listAssets(filter), 'Plant registry');
      const p = pageArray(list, (x) => [x.name.toLowerCase(), x.id], q, filter);
      const refs = refsOf(
        'asset',
        p.items.map((a) => a.id),
      );
      linkNext(req, reply, p.nextCursor);
      return { items: p.items.map((a) => asset(a, refs)), nextCursor: p.nextCursor };
    },
  );

  get(
    '/plant/assets/:assetId',
    {
      operationId: 'getPlantAsset',
      tag: 'Plant',
      summary: 'Get an asset',
      description: `An asset with its location, equipment (parent and children), taxonomy, lifecycle, capabilities, external references, own fields and links. ${MODULE}`,
      params: { assetId: 'Asset id' },
      response: { $ref: 'PlantAssetDetailEntry#' },
    },
    async (req) => {
      const { canManage: _c, backlinks: _b, image: _i, refs, links, ...a } = found(() => svc.getAsset((req.params as { assetId: string }).assetId), 'Asset');
      return { ...a, externalRefs: refs, links: links.map(mapLink) };
    },
  );

  // ---------- part 2 (#219): device profiles, KPI definitions, an asset's assignment ----------
  get(
    '/plant/assets/:assetId/assignment',
    {
      operationId: 'getPlantAssetAssignment',
      tag: 'Plant',
      summary: 'Get what an asset delivers: its device profile, interfaces, KPI instances and checks',
      description: `The asset's device profile and controller firmware, per interface whether it is set up and where (endpoint), data points that differ on this asset, where its data points are published, its KPI instances (job, parameters, dashboard or dataset), what Steward checks and the KPI definitions it can have. ${MODULE}`,
      params: { assetId: 'Asset id' },
      response: { $ref: 'PlantAssignmentEntry#' },
    },
    async (req) => {
      const { canManage: _c, profile, kpis, ...a } = found(() => getAssignment((req.params as { assetId: string }).assetId), 'Asset');
      return {
        ...a,
        profile: profile
          ? {
              id: profile.id,
              name: profile.name,
              manufacturer: profile.manufacturer,
              model: profile.model,
              version: profile.version,
              category: profile.category,
              interfaces: profile.interfaces,
            }
          : null,
        kpis: kpis.map(({ results: _r, ...k }) => k),
      };
    },
  );

  get(
    '/plant/profiles',
    {
      operationId: 'listPlantProfiles',
      tag: 'Plant',
      summary: 'List device profiles',
      description: `The device profiles of the installation (a catalogue: controllers and devices with their interfaces and data points), ordered by name. ${MODULE}`,
      query: PlantCatalogueListQuery,
      paginated: true,
      response: {
        ...page,
        description: 'A page of device profiles',
        properties: { items: { type: 'array', items: { $ref: 'PlantProfileEntry#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof PlantCatalogueListQuery>;
      const p = pageArray(
        found(() => cat.listProfiles(), 'Plant registry'),
        (x) => [x.name.toLowerCase(), x.id],
        q,
        {},
      );
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );

  get(
    '/plant/profiles/:profileId',
    {
      operationId: 'getPlantProfile',
      tag: 'Plant',
      summary: 'Get a device profile with its interfaces and data points',
      description: `Interfaces (protocol, direction, port, authentication, the client they need) with their data point groups and data points (data type, UCUM unit, address, access, update rate), file sets, the assets with this profile and the KPI definitions that read it. ${MODULE}`,
      params: { profileId: 'Device profile id' },
      response: { $ref: 'PlantProfileDetailEntry#' },
    },
    async (req) => {
      const { canManage: _c, ...p } = found(() => cat.getProfile((req.params as { profileId: string }).profileId), 'Device profile');
      return p;
    },
  );

  get(
    '/plant/kpis',
    {
      operationId: 'listPlantKpis',
      tag: 'Plant',
      summary: 'List KPI definitions',
      description: `The KPI definitions of the installation (a catalogue), ordered by name, with their category, unit, ISO 22400-2 trend and counts. ${MODULE}`,
      query: PlantCatalogueListQuery,
      paginated: true,
      response: {
        ...page,
        description: 'A page of KPI definitions',
        properties: { items: { type: 'array', items: { $ref: 'PlantKpiEntry#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof PlantCatalogueListQuery>;
      const p = pageArray(
        found(() => cat.listKpis(), 'Plant registry'),
        (x) => [x.name.toLowerCase(), x.id],
        q,
        {},
      );
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );

  get(
    '/plant/kpis/:kpiId',
    {
      operationId: 'getPlantKpi',
      tag: 'Plant',
      summary: 'Get a KPI definition',
      description: `Inputs, parameters (type, default, aliases, range), result columns (sum, ratio, ignore), the computation and its limits, the ISO 22400-2 attributes, its problems, the assets with an instance and those that could have one. ${MODULE}`,
      params: { kpiId: 'KPI definition id' },
      response: { $ref: 'PlantKpiDetailEntry#' },
    },
    async (req) => {
      const { canManage: _c, ...k } = found(() => cat.getKpi((req.params as { kpiId: string }).kpiId), 'KPI definition');
      return k;
    },
  );

  // ---------- part 3 (#220): the OT network ----------
  get(
    '/plant/sites/:siteId/network',
    {
      operationId: 'getPlantSiteNetwork',
      tag: 'Plant',
      summary: 'Get the OT network of a site',
      description: `The IEEE 802.1Q VLANs of a site (subnets, ranges, the linked Steward network segment and a hint when they differ), its IEC 62443-3-2 zones (criticality, VLANs, SL-T) and conduits (two zones, direction, protocols, controls, the records that link to them), the devices and data paths of its assets (collector, transfers, destinations, the next and previous link of a chain), every asset's live status (online, offline, unknown – only from linked checks) and the systems the data paths name. ${MODULE}`,
      params: { siteId: 'Site id' },
      response: { $ref: 'PlantSiteNetworkEntry#' },
    },
    async (req) => {
      const { canManage: _c, ...n } = found(() => siteNetwork((req.params as { siteId: string }).siteId), 'Site');
      return n;
    },
  );

  get(
    '/plant/assets/:assetId/network',
    {
      operationId: 'getPlantAssetNetwork',
      tag: 'Plant',
      summary: 'Get the devices, data paths and live status of an asset',
      description: `The asset's devices (host name, MAC as EUI-48, VLAN, address, switch port, state, flags, linked checks and live status), its data paths and the checks linked to the asset itself. The live status is online, offline or unknown, only from the linked checks (monitors, dataset freshness); a monitor or dataset the token owner may not see is not named. ${MODULE}`,
      params: { assetId: 'Asset id' },
      response: { $ref: 'PlantAssetNetworkEntry#' },
    },
    async (req) => {
      const { canManage: _c, vlans: _v, checksSource: _s, ...n } = found(() => assetNetwork((req.params as { assetId: string }).assetId), 'Asset');
      return n;
    },
  );

  get(
    '/plant/assets/:assetId/collections',
    {
      operationId: 'getPlantAssetCollections',
      tag: 'Plant',
      summary: 'Get the data collections of an asset',
      description: `What collectors (gateways, ETL jobs) read from the asset: per collection its collector, mode, interval, triggers, destination, access patterns and items – the address read, the collector's name for it and the data point it is mapped to (or none) – with the coverage (mapped, raw, data points no collection reads). ${MODULE}`,
      params: { assetId: 'Asset id' },
      response: { $ref: 'PlantAssetCollectionsEntry#' },
    },
    async (req) => {
      const {
        canManage: _c,
        canManageCatalogue: _m,
        interfaces: _i,
        dataPaths: _d,
        ...x
      } = found(() => assetCollections((req.params as { assetId: string }).assetId), 'Asset');
      return x;
    },
  );

  get(
    '/plant/assets/:assetId/documentation',
    {
      operationId: 'getPlantAssetDocumentation',
      tag: 'Plant',
      summary: 'Get whether an asset’s documentation is confirmed as still current',
      description: `0.14: the last “Still current” of the asset’s documentation as a whole and of each of its documents (records linked to the asset, and those it inherits from its profile, collections and sinks), who confirmed it when, and whether a confirmation is due by the review interval of the document type or the site – a hint, never an error. Read-only. ${MODULE}`,
      params: { assetId: 'Asset id' },
      response: { $ref: 'PlantAssetDocumentationEntry#' },
    },
    async (req) => {
      const id = (req.params as { assetId: string }).assetId;
      found(() => visibleAsset(id), 'Asset');
      return assetDocumentation(id);
    },
  );

  get(
    '/plant/assets/:assetId/collections/:collectionId/sinks/:sinkId/insights-hub',
    {
      operationId: 'getPlantSinkInsightsHub',
      tag: 'Plant',
      summary: 'Get the Insights Hub mapping of a sink and its last check',
      description: `0.14: per item of the collection the Insights Hub asset, aspect and variable it goes to (its own, or the sink's default), the result of the last check of the mapping against the tenant (the asset, aspect and variable exist; a unit or type that differs from the data point's is a hint), the monitor checks that watch it (a monitor the token owner may not see is counted, not named), and the counts: mapped, verified, watched. The asset hierarchy in Insights Hub is not compared with the plant's. ${MODULE}`,
      params: { assetId: 'Asset id', collectionId: 'Data collection id', sinkId: 'Sink id' },
      response: { $ref: 'PlantSinkInsightsHubEntry#' },
    },
    async (req) => {
      const x = req.params as { assetId: string; collectionId: string; sinkId: string };
      const { canManage: _m, canCheck: _c, checkProblem: _p, canCreateMonitor: _n, ...m } = found(() => ihMapping(x.assetId, x.collectionId, x.sinkId), 'Sink');
      return m;
    },
  );

  // ---------- what Steward checks, and the export in the import format ----------
  get(
    '/plant/checks',
    {
      operationId: 'listPlantChecks',
      tag: 'Plant',
      summary: 'List the problems Steward finds in the plant data',
      description: `What Plant → Checks shows: KPI instances whose inputs the asset does not deliver, parameters outside their definition, references to profiles, interfaces or data points that do not exist, ratios without their denominator … First the problems of the assets the token owner may see (by asset name), then those of the KPI definitions (by name). Filter by site, asset, KPI definition (its own problems and those of its instances) or kind. ${MODULE}`,
      query: PlantCheckListQuery,
      paginated: true,
      response: {
        ...page,
        description: 'A page of problems',
        properties: { items: { type: 'array', items: { $ref: 'PlantCheckEntry#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof PlantCheckListQuery>;
      const { limit: _l, cursor: _c, ...filter } = q;
      const seq = new Map<string, number>();
      const list = found(() => cat.allChecks(), 'Plant registry')
        .filter(
          (c) =>
            (!filter.kind || c.code === filter.kind) &&
            (!filter.kpi || c.kpiId === filter.kpi) &&
            (!filter.asset || (c.subject.kind === 'asset' && c.subject.id === filter.asset)) &&
            (!filter.site || (c.subject.kind === 'asset' && c.subject.siteId === filter.site)),
        )
        .map((c) => {
          // the position among the problems of its record keeps the order stable across pages
          const key = `${c.subject.kind}:${c.subject.id}`;
          const n = (seq.get(key) ?? 0) + 1;
          seq.set(key, n);
          return { c, key: [c.subject.kind === 'asset' ? 0 : 1, c.subject.name.toLowerCase(), c.subject.id, n] as (string | number)[] };
        });
      const p = pageArray(list, (x) => x.key, q, filter);
      linkNext(req, reply, p.nextCursor);
      return {
        items: p.items.map(({ c }) => ({
          kind: c.code,
          message: c.message,
          on: c.subject.kind,
          asset: c.subject.kind === 'asset' ? { id: c.subject.id, name: c.subject.name } : null,
          siteId: c.subject.kind === 'asset' ? c.subject.siteId : null,
          kpiId: c.kpiId,
          job: c.job ?? null,
          details: c.params,
        })),
        nextCursor: p.nextCursor,
      };
    },
  );

  get(
    '/plant/export',
    {
      operationId: 'exportPlantRegistry',
      tag: 'Plant',
      summary: 'Export the plant registry in the import format',
      description: `The registry as a document of format 1 (docs/PLANT.md, JSON Schema docs/plant/plant-registry-1.schema.json), the same as Plant → Import → Export: every site the token owner may see with the device profiles, KPI definitions, the assignments of their assets and the OT network (\`ot_networks\`, \`asset_networks\`); one site (\`site\`, with the assignments and OT network of its assets); the catalogues only (\`part=catalogue\`); one device profile (\`profile\`) or one KPI definition (\`kpi\`). Sites the token owner may not see and their assets are never in it; the catalogues belong to the installation. YAML by default, JSON with \`format=json\`; both import back unchanged. Recorded in the audit log with the token. ${MODULE}`,
      query: PlantExportQuery,
      response: {
        content: {
          'application/yaml': { schema: { type: 'string', description: 'The document as YAML (format 1)' } },
          'application/json': { schema: { type: 'object', additionalProperties: true, description: 'The same document as JSON' } },
        },
      },
    },
    async (req, reply) => {
      const { format, ...q } = req.query as z.infer<typeof PlantExportQuery>;
      const { tokenId } = (req as unknown as { smApi: ApiPrincipal }).smApi;
      const what = q.profile ? 'Device profile' : q.kpi ? 'KPI definition' : q.site ? 'Site' : 'Plant registry';
      const x = found(() => exportYaml(q, { format, tokenId }), what);
      reply.header('content-disposition', `attachment; filename="${x.filename}"`);
      return reply.type(x.contentType).send(x.content);
    },
  );
}
