import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AdvisoryAssetMatch, AdvisorySummary } from '@sm/shared';
import { HttpError } from '../../util.js';
import { notFound } from '../../api/v1/helpers.js';
import { ProblemError } from '../../api/v1/problem.js';
import { decodeCursor, encodeCursor, linkNext } from '../../api/v1/pagination.js';
import type { Op } from '../../api/v1/routes.js';
import { currentId, currentParams } from '../ids.js';
import { assetAdvisories, getAdvisory, listAdvisories } from './store.js';
import { PlantAdvisoryListQuery } from './api-schemas.js';

/**
 * Security advisories in the public, read-only API (0.14, docs/ADVISORIES.md): the advisories affecting the token
 * owner's sites, one advisory with its matches, and the advisories of an asset. What the token owner may not see is
 * left out (matches at hidden sites are counted, never named). While the plant registry is off every endpoint answers 404.
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

function found<T>(f: () => T, what: string): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && e.code === 'PLANT_MODULE_OFF')
      throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: 'The plant registry module is off (Settings → Modules)' });
    if (e instanceof HttpError && e.statusCode === 404) throw notFound(what);
    throw e;
  }
}

const MODULE = 'Only while the plant registry module is on (Settings → Modules); otherwise 404.';
const page = { type: 'object', required: ['items', 'nextCursor'], additionalProperties: false } as const;

const summaryOut = (s: AdvisorySummary) => ({
  id: s.id,
  trackingId: s.trackingId,
  title: s.title,
  publisher: s.publisher,
  severity: s.severity,
  cvss: s.cvss,
  cves: s.cves,
  published: s.published,
  updated: s.updated,
  version: s.version,
  status: s.status,
  affectedAssets: s.affectedAssets,
  openAssets: s.openAssets,
  possibleMatches: s.possibleMatches,
  sites: s.sites,
  zones: s.zones,
  origin: s.origin,
});
const matchOut = (m: AdvisoryAssetMatch) => ({
  assetId: m.assetId,
  assetName: m.assetName,
  siteId: m.siteId,
  zones: m.zones,
  firmware: m.firmware,
  kind: m.kind,
  counted: m.counted,
  decision: m.decision,
  decisionReason: m.decisionReason,
  reasons: m.reasons.map((r) => r.text),
  fixedFirmware: m.fixes.map((f) => f.version),
  siteNotApplicable: m.siteNotApplicable,
  remediation: {
    status: m.remediation.status,
    reason: m.remediation.reason,
    until: m.remediation.until,
    expired: m.remediation.expired,
    windowId: m.remediation.windowId,
    changeSetId: m.remediation.changeSetId,
    by: m.remediation.by,
    at: m.remediation.at,
  },
});

export function advisoryApiRoutes(get: Get): void {
  get(
    '/plant/advisories',
    {
      operationId: 'listPlantAdvisories',
      tag: 'Plant',
      summary: 'List the security advisories affecting the plant’s sites',
      description: `CSAF 2.0 advisories matched to assets by manufacturer, model and firmware – by default only those with a match at a site the token owner may see (\`all=true\`: every advisory), filtered, sorted (\`sort\`: severity – the default –, updated, published, affected, title; \`order\`) and paged by the server. Counts and status are for those sites (with \`site\`: for that site). ${MODULE}`,
      query: PlantAdvisoryListQuery,
      paginated: true,
      response: {
        ...page,
        description: 'A page of advisories',
        properties: { items: { type: 'array', items: { $ref: 'PlantAdvisoryEntry#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof PlantAdvisoryListQuery>;
      const site = q.site ? currentId('site', '', q.site) : undefined;
      const filters = {
        site: site ?? null,
        status: q.status ?? null,
        severity: q.severity ?? null,
        vendor: q.vendor ?? null,
        all: q.all,
        sort: q.sort ?? null,
        order: q.order ?? null,
      };
      const k = decodeCursor(q.cursor, filters);
      const offset = k && typeof k[0] === 'number' ? k[0] : 0;
      const page = found(
        () =>
          listAdvisories({
            site,
            status: q.status,
            severity: q.severity,
            vendor: q.vendor,
            affecting: !q.all || !!site,
            sort: q.sort,
            order: q.order,
            offset,
            limit: q.limit,
          }),
        'Plant registry',
      );
      const p = { items: page.items.map(summaryOut), nextCursor: page.nextOffset === null ? null : encodeCursor([page.nextOffset], filters) };
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );

  get(
    '/plant/advisories/:advisoryId',
    {
      operationId: 'getPlantAdvisory',
      tag: 'Plant',
      summary: 'Get a security advisory with the assets it affects',
      description: `Its vulnerabilities and remediations, and its matches at the token owner's sites: exact and possible, with the reasons, the decisions, the fixed firmware and the remediation per asset. ${MODULE}`,
      params: { advisoryId: 'Advisory id (adv_…)' },
      response: { $ref: 'PlantAdvisoryDetailEntry#' },
    },
    async (req) => {
      const d = found(() => getAdvisory((req.params as { advisoryId: string }).advisoryId), 'Advisory');
      return {
        ...summaryOut(d),
        category: d.category,
        tlp: d.tlp,
        summary: d.summary,
        references: d.references,
        vulnerabilities: d.vulnerabilities.map((v) => ({
          cve: v.cve,
          title: v.title,
          cwe: v.cwe,
          cvss: v.cvss,
          severity: v.severity,
          vector: v.vector,
          remediations: v.remediations.map((r) => ({ category: r.category, details: r.details, url: r.url })),
        })),
        integrity: d.integrity,
        sha256: d.sha256,
        matches: d.matches.map(matchOut),
        hiddenMatches: d.hiddenMatches,
        sitesNotApplicable: d.siteStates.filter((s) => s.notApplicable).map((s) => ({ siteId: s.siteId, reason: s.reason })),
      };
    },
  );

  get(
    '/plant/assets/:assetId/advisories',
    {
      operationId: 'getPlantAssetAdvisories',
      tag: 'Plant',
      summary: 'Get the security advisories of an asset',
      description: `Every advisory that matches the asset – exact, possible and dismissed – with the match and its remediation. ${MODULE}`,
      params: { assetId: 'Asset id' },
      response: { $ref: 'PlantAssetAdvisoriesEntry#' },
    },
    async (req) => {
      const params = currentParams(req.params as Record<string, string>);
      const r = found(() => assetAdvisories(params.assetId!), 'Asset');
      return { items: r.items.map((i) => ({ advisory: summaryOut(i.advisory), match: matchOut(i.match) })) };
    },
  );
}
