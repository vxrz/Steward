import { z, type ZodTypeAny } from 'zod';
import {
  ADVISORY_INTEGRITY,
  ADVISORY_MATCH_DECISIONS,
  ADVISORY_MATCH_KINDS,
  ADVISORY_REMEDIATION_CATEGORIES,
  ADVISORY_REMEDIATIONS,
  ADVISORY_SEVERITIES,
  ADVISORY_STATUSES,
} from '@sm/shared';

/** Response and query schemas of security advisories in the public API (/api/v1/plant/advisories…, 0.14). */

const Zone = z.object({
  siteId: z.string(),
  id: z.string(),
  name: z.string(),
  slTarget: z.number().int().nullable().describe('IEC 62443-3-2 target security level of the zone (null: open)'),
});

export const PlantAdvisoryEntry = z.object({
  id: z.string().describe('Steward’s id of the advisory (from the publisher’s namespace and tracking id)'),
  trackingId: z.string().describe('/document/tracking/id of the CSAF document'),
  title: z.string(),
  publisher: z.string(),
  severity: z.enum(ADVISORY_SEVERITIES).describe('The highest severity of its vulnerabilities (CVSS), else its aggregate severity'),
  cvss: z.number().nullable().describe('The highest CVSS base score'),
  cves: z.array(z.string()),
  published: z.string().describe('initial_release_date'),
  updated: z.string().describe('current_release_date'),
  version: z.string(),
  status: z.enum(ADVISORY_STATUSES).describe('For the token owner’s sites: open, mitigated, not_applicable or unaffected'),
  affectedAssets: z.number().int().describe('Exact or confirmed matches at sites the token owner may see (not marked not applicable)'),
  openAssets: z.number().int().describe('Of them, not yet mitigated, accepted or not affected'),
  possibleMatches: z.number().int().describe('Possible matches nobody confirmed or dismissed – never counted as affected'),
  sites: z.array(z.object({ id: z.string(), name: z.string() })),
  zones: z.array(Zone),
  origin: z.enum(['feed', 'upload']),
});

export const PlantAdvisoryMatchEntry = z.object({
  assetId: z.string(),
  assetName: z.string(),
  siteId: z.string(),
  zones: z.array(Zone),
  firmware: z.string(),
  kind: z.enum(ADVISORY_MATCH_KINDS).describe('exact: vendor, model and firmware match; possible: similar – a person confirms or dismisses'),
  counted: z.boolean().describe('Counted as affected: exact and not dismissed, or possible and confirmed'),
  decision: z.enum(ADVISORY_MATCH_DECISIONS).nullable(),
  decisionReason: z.string(),
  reasons: z.array(z.string()).describe('Why it matches, one sentence per product'),
  fixedFirmware: z.array(z.string()).describe('Firmware versions that fix it, as the advisory names them'),
  siteNotApplicable: z.boolean(),
  remediation: z.object({
    status: z.enum(ADVISORY_REMEDIATIONS),
    reason: z.string(),
    until: z.string().nullable().describe('An accepted risk: until this day'),
    expired: z.boolean().describe('An accepted risk past its day (counts as open again)'),
    windowId: z.string().nullable().describe('Planned: the maintenance window'),
    changeSetId: z.string().nullable().describe('Planned: the plant change set'),
    by: z.string().nullable(),
    at: z.string().nullable(),
  }),
});

export const PlantAdvisoryDetailEntry = PlantAdvisoryEntry.extend({
  category: z.string(),
  tlp: z.string(),
  summary: z.string(),
  references: z.array(z.object({ url: z.string(), summary: z.string(), category: z.string() })),
  vulnerabilities: z.array(
    z.object({
      cve: z.string(),
      title: z.string(),
      cwe: z.string(),
      cvss: z.number().nullable(),
      severity: z.enum(ADVISORY_SEVERITIES),
      vector: z.string(),
      remediations: z.array(z.object({ category: z.enum(ADVISORY_REMEDIATION_CATEGORIES), details: z.string(), url: z.string() })),
    }),
  ),
  integrity: z
    .enum(ADVISORY_INTEGRITY)
    .describe('How the document was checked: its published SHA-512 or SHA-256 matched, none was published, or it was uploaded'),
  sha256: z.string(),
  matches: z.array(PlantAdvisoryMatchEntry),
  hiddenMatches: z.number().int().describe('Matches at sites the token owner may not see (counted, never named)'),
  sitesNotApplicable: z.array(z.object({ siteId: z.string(), reason: z.string() })),
});

export const PlantAssetAdvisoriesEntry = z.object({
  items: z.array(z.object({ advisory: PlantAdvisoryEntry, match: PlantAdvisoryMatchEntry })),
});

export const PlantAdvisoryListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  site: z.string().max(100).optional().describe('Only advisories affecting this site (id)'),
  status: z.enum(ADVISORY_STATUSES).optional(),
  severity: z.enum(ADVISORY_SEVERITIES).optional(),
  all: z.boolean().default(false).describe('Also advisories that match no asset of the token owner’s sites'),
});

export const ADVISORY_COMPONENTS: Record<string, ZodTypeAny> = {
  PlantAdvisoryEntry,
  PlantAdvisoryMatchEntry,
  PlantAdvisoryDetailEntry,
  PlantAssetAdvisoriesEntry,
};
