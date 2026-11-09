import { z } from 'zod';
import { ADVISORY_SEVERITIES, ADVISORY_SEVERITY_RANK, ADVISORY_STATUSES } from '@sm/shared';
import { pageArray } from '../../api/v1/pagination.js';
import { ToolError, cursorArg, defineTool, limitArg, type ToolDef } from '../../mcp/tooling.js';
import { HttpError } from '../../util.js';
import { plantEnabled } from '../settings.js';
import { currentId } from '../ids.js';
import { getAdvisory, listAdvisories } from './store.js';

/**
 * Security advisories for assistants (0.14, docs/MCP.md "Plant registry"): which advisories affect a site, and one
 * advisory with the assets it affects – read as the token owner, so only sites they may see are named. Not listed
 * while the plant registry is off.
 */

const OFF = 'The plant registry is not enabled on this Steward (Settings → Modules)';
const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

function read<T>(f: () => T): T {
  if (!plantEnabled()) throw new ToolError(OFF);
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500)
      throw new ToolError(e.statusCode === 404 || e.statusCode === 403 ? `${e.message} (or you may not see it)` : e.message);
    throw e;
  }
}

export const advisoryTools: ToolDef[] = [
  defineTool({
    name: 'list_plant_advisories',
    title: 'List security advisories affecting plant sites',
    description:
      'Security advisories (CSAF 2.0, from vendor PSIRTs and CISA, or uploaded) that match assets of the plant registry by manufacturer, model and firmware – the most severe first. Give `site` for the advisories affecting one site. Each has its severity and CVSS, CVEs, status for your sites (open, mitigated, not_applicable, unaffected), the number of affected assets (exact or confirmed matches only), still open ones, possible matches waiting for a person, and the sites and zones. Use get_plant_advisory for the affected assets and the fixed firmware.',
    input: z
      .object({
        site: z.string().max(120).optional().describe('A site id: only advisories that affect it'),
        status: z.enum(ADVISORY_STATUSES).optional().describe('Only advisories with this status for your sites'),
        severity: z.enum(ADVISORY_SEVERITIES).optional(),
        all: z.boolean().default(false).describe('Also advisories that match no asset of your sites'),
        query: z.string().max(200).optional().describe('Text in the title, tracking id, publisher or a CVE'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    visible: () => plantEnabled(),
    handler: (a) =>
      read(() => {
        const site = a.site ? currentId('site', '', a.site) : undefined;
        const list = listAdvisories({ site, status: a.status, severity: a.severity, q: a.query, affecting: !a.all || !!site }).items.map((x) => ({
          id: x.id,
          trackingId: x.trackingId,
          title: short(x.title),
          publisher: x.publisher,
          severity: x.severity,
          cvss: x.cvss,
          cves: x.cves.slice(0, 20),
          status: x.status,
          affectedAssets: x.affectedAssets,
          openAssets: x.openAssets,
          possibleMatches: x.possibleMatches,
          sites: x.sites.map((s) => s.id),
          zones: x.zones.map((z) => ({ site: z.siteId, zone: z.id, slTarget: z.slTarget })),
          updated: x.updated,
        }));
        return pageArray(list, (x) => [-ADVISORY_SEVERITY_RANK[x.severity], -(Date.parse(x.updated) || 0), x.id], a, {
          site: site ?? null,
          status: a.status ?? null,
          severity: a.severity ?? null,
          all: a.all,
          query: a.query ?? null,
        });
      }),
  }),
  defineTool({
    name: 'get_plant_advisory',
    title: 'Get a security advisory with its affected assets',
    description:
      'One security advisory: summary, vulnerabilities (CVE, CVSS, remediations), and the assets of your sites it matches – exact matches with the reason (vendor, model, firmware against the affected range), possible matches separately, the remediation status per asset and the fixed firmware the advisory names.',
    input: z.object({ id: z.string().min(1).max(100).describe('The advisory id (adv_…) from list_plant_advisories') }).strict(),
    visible: () => plantEnabled(),
    handler: (a) =>
      read(() => {
        const d = getAdvisory(a.id);
        return {
          id: d.id,
          trackingId: d.trackingId,
          title: d.title,
          publisher: d.publisher,
          severity: d.severity,
          cvss: d.cvss,
          status: d.status,
          published: d.published,
          updated: d.updated,
          version: d.version,
          summary: short(d.summary, 2000),
          vulnerabilities: d.vulnerabilities.slice(0, 50).map((v) => ({
            cve: v.cve,
            title: short(v.title),
            cvss: v.cvss,
            severity: v.severity,
            remediations: v.remediations.slice(0, 10).map((r) => ({ category: r.category, details: short(r.details, 500), url: r.url })),
          })),
          affected: d.matches
            .filter((m) => m.counted)
            .map((m) => ({
              asset: m.assetId,
              name: m.assetName,
              site: m.siteId,
              zones: m.zones.map((z) => ({ zone: z.id, slTarget: z.slTarget })),
              firmware: m.firmware,
              why: m.reasons[0]?.text ?? '',
              fixedFirmware: m.fixes.map((f) => f.version),
              remediation: m.remediation.status,
              siteNotApplicable: m.siteNotApplicable,
            })),
          possible: d.matches
            .filter((m) => !m.counted && m.decision === null)
            .map((m) => ({ asset: m.assetId, name: m.assetName, site: m.siteId, why: m.reasons[0]?.text ?? '' })),
          dismissed: d.matches.filter((m) => m.decision === 'dismissed').length,
          references: d.references.slice(0, 10).map((r) => r.url),
        };
      }),
  }),
];
