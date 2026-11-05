import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { ItemLink, PlantAssetSummary } from '@sm/shared';
import { HttpError } from '../util.js';
import { linkTypeByKey } from '../records/link-types.js';
import { notFound } from '../api/v1/helpers.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { refsOf } from './model.js';
import * as svc from './service.js';
import { PlantAssetListQuery, PlantSiteListQuery } from './api-schemas.js';

/**
 * The plant registry in the public, read-only API (#218): sites with their hierarchy and buildings, assets with their
 * locations. The token owner sees the sites (and their assets) they may see in the web app. While the module is off
 * every endpoint answers 404.
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

function found<T>(f: () => T, what: string): T {
  try {
    return f();
  } catch (e) {
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

export function plantApiRoutes(get: Get): void {
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
}
