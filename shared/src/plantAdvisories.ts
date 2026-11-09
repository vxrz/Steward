import { z } from 'zod';

/**
 * Security advisories for OT devices (0.14, docs/ADVISORIES.md): CSAF 2.0 documents (OASIS) from the providers an
 * administrator configures or uploaded by hand, matched to the plant registry's assets by manufacturer, model and
 * firmware – conservatively: an exact (normalised) vendor and model with a version in the affected range counts, a
 * similar one is only a possible match that a person confirms or dismisses.
 */

export const ADVISORY_LIMITS = {
  /** One CSAF document (JSON), uploaded or fetched */
  documentBytes: 4 * 1024 * 1024,
  /** Products of a document: leaves of the product tree, full product names and relationships together */
  products: 5000,
  /** Nodes of the product tree (branches) and how deep it may nest */
  branchNodes: 20_000,
  branchDepth: 30,
  vulnerabilities: 500,
  /** Product ids in one list of a vulnerability (known_affected …) and in a remediation or score */
  productIds: 10_000,
  remediations: 200,
  notes: 200,
  references: 500,
  /** Text kept per note, remediation or summary (longer text is cut) */
  textChars: 20_000,
  /** A reason or note people write */
  reasonChars: 2000,
  /** Configured sources */
  sources: 50,
  /** Documents one fetch of a source reads at most (the rest follows on the next run) */
  documentsPerRun: 200,
  /** Providers an aggregator source reads at most */
  providersPerAggregator: 20,
  /** Publisher names an aggregator source may be narrowed to */
  publishers: 20,
  /** Answers of providers other than documents: provider-metadata.json, aggregator.json, ROLIE feeds, changes.csv */
  indexBytes: 8 * 1024 * 1024,
  /** Hash files */
  hashBytes: 4096,
  /** An accepted risk lasts at most this many days */
  acceptMaxDays: 3 * 366,
} as const;

/** From the CVSS scores of the document (v3 base severity, else the score), else its aggregate severity. */
export const ADVISORY_SEVERITIES = ['critical', 'high', 'medium', 'low', 'none', 'unknown'] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];
export const ADVISORY_SEVERITY_RANK: Record<AdvisorySeverity, number> = { critical: 5, high: 4, medium: 3, low: 2, none: 1, unknown: 0 };

/**
 * What an advisory means for the reader's sites: open (an affected asset is not dealt with), mitigated (every affected
 * asset is mitigated, accepted or not affected), not applicable (the sites with matches marked it so) or unaffected
 * (no asset matches – possible matches still wait for a person then).
 */
export const ADVISORY_STATUSES = ['open', 'mitigated', 'not_applicable', 'unaffected'] as const;
export type AdvisoryStatus = (typeof ADVISORY_STATUSES)[number];

/** exact: the normalised vendor and model are the asset's and the firmware is in range; possible: similar – a person decides. */
export const ADVISORY_MATCH_KINDS = ['exact', 'possible'] as const;
export type AdvisoryMatchKind = (typeof ADVISORY_MATCH_KINDS)[number];
export const ADVISORY_MATCH_DECISIONS = ['confirmed', 'dismissed'] as const;
export type AdvisoryMatchDecision = (typeof ADVISORY_MATCH_DECISIONS)[number];

/** Per affected asset: open, planned (a maintenance window or change set), mitigated, accepted risk (reason, until), not affected. */
export const ADVISORY_REMEDIATIONS = ['open', 'planned', 'mitigated', 'accepted', 'not_affected'] as const;
export type AdvisoryRemediationStatus = (typeof ADVISORY_REMEDIATIONS)[number];

/** A provider's provider-metadata.json, an aggregator's aggregator.json, or one ROLIE feed. */
export const ADVISORY_SOURCE_KINDS = ['provider', 'aggregator', 'rolie'] as const;
export type AdvisorySourceKind = (typeof ADVISORY_SOURCE_KINDS)[number];

/** How a document's integrity was checked: a published hash file (SHA-512 or SHA-256) matched, none was published, or it was uploaded. */
export const ADVISORY_INTEGRITY = ['sha512', 'sha256', 'none', 'uploaded', 'uploaded_sha256'] as const;
export type AdvisoryIntegrity = (typeof ADVISORY_INTEGRITY)[number];

export const ADVISORY_REMEDIATION_CATEGORIES = ['mitigation', 'no_fix_planned', 'none_available', 'vendor_fix', 'workaround'] as const;
export type AdvisoryRemediationCategory = (typeof ADVISORY_REMEDIATION_CATEGORIES)[number];

// ---------- the document as Steward keeps it ----------

export interface AdvisoryProduct {
  /** The product_id of the document */
  id: string;
  vendor: string;
  family: string;
  /** The product name (in OT usually the model) */
  name: string;
  /** product_version: one version */
  version: string;
  /** product_version_range: vers (vers:generic/>=1.0|<2.4) or a vers-like constraint (<V3.0.29) */
  range: string;
  /** product_identification_helper.model_numbers (`*` may stand for any characters) */
  models: string[];
  /** The full product name */
  fullName: string;
  cpe: string;
  purl: string;
  /** A relationship (firmware installed on a device): the product it is part of */
  partOf: string;
}

export interface AdvisoryRemediation {
  category: AdvisoryRemediationCategory;
  details: string;
  url: string;
  productIds: string[];
}

export interface AdvisoryVulnerability {
  cve: string;
  title: string;
  cwe: string;
  summary: string;
  cvss: number | null;
  severity: AdvisorySeverity;
  vector: string;
  /** known_affected, first_affected, last_affected */
  affected: string[];
  underInvestigation: string[];
  /** fixed, first_fixed */
  fixed: string[];
  recommended: string[];
  notAffected: string[];
  remediations: AdvisoryRemediation[];
  /** A threat of category exploit_status says it is exploited */
  exploitation: string;
}

export interface AdvisoryReference {
  url: string;
  summary: string;
  category: string;
}

// ---------- matching ----------

/** How the vendor, model and firmware of an asset compared with a product of the advisory. */
export interface AdvisoryMatchReason {
  /** The asset's own manufacturer and model, or those of its device profile (the controller) */
  via: 'asset' | 'profile';
  profileId: string | null;
  productId: string;
  product: string;
  vendor: { advisory: string; asset: string; how: 'same' | 'normalised' | 'similar' };
  model: { advisory: string; asset: string; how: 'same' | 'normalised' | 'model_number' | 'similar' };
  version: {
    advisory: string;
    asset: string;
    /** in range, the version itself, all versions; or (possible) firmware not recorded, a range Steward does not read */
    how: 'in_range' | 'equal' | 'all' | 'unknown' | 'unparsed';
  };
  /** known affected, or under investigation (never more than a possible match) */
  status: 'affected' | 'under_investigation';
  /** The reason in one English sentence (API, assistants, audit) */
  text: string;
}

/** A firmware version that fixes it: of a fixed product of the same model, or the upper end of the affected range. */
export interface AdvisoryFix {
  version: string;
  from: 'fixed_product' | 'range';
  product: string;
}

export interface AdvisoryRemediationState {
  status: AdvisoryRemediationStatus;
  reason: string;
  /** accepted: until this day (YYYY-MM-DD) */
  until: string | null;
  /** An accepted risk past its day counts as open again */
  expired: boolean;
  windowId: string | null;
  windowTitle: string | null;
  changeSetId: string | null;
  changeSetTitle: string | null;
  note: string;
  by: string | null;
  at: string | null;
}

export interface AdvisoryZoneRef {
  siteId: string;
  id: string;
  name: string;
  /** IEC 62443-3-2 target security level of the zone, null while open */
  slTarget: number | null;
}

export interface AdvisoryAssetMatch {
  assetId: string;
  assetName: string;
  siteId: string;
  siteName: string;
  /** The zones of the asset (through the VLANs of its devices) */
  zones: AdvisoryZoneRef[];
  manufacturer: string;
  model: string;
  firmware: string;
  kind: AdvisoryMatchKind;
  /** Counts as affected: exact and not dismissed, or possible and confirmed – never a possible match alone */
  counted: boolean;
  decision: AdvisoryMatchDecision | null;
  decisionReason: string;
  decidedBy: string | null;
  decidedAt: string | null;
  cves: string[];
  cvss: number | null;
  severity: AdvisorySeverity;
  reasons: AdvisoryMatchReason[];
  fixes: AdvisoryFix[];
  remediation: AdvisoryRemediationState;
  /** The site marked the advisory as not applicable */
  siteNotApplicable: boolean;
  firstMatchedAt: string;
  canManage: boolean;
}

export interface AdvisorySummary {
  id: string;
  trackingId: string;
  title: string;
  publisher: string;
  severity: AdvisorySeverity;
  cvss: number | null;
  cves: string[];
  published: string;
  updated: string;
  version: string;
  status: AdvisoryStatus;
  /** Counted affected assets of sites the reader may see (not marked not applicable) */
  affectedAssets: number;
  /** Of them, still open (open, planned, an accepted risk past its day) */
  openAssets: number;
  /** Possible matches nobody confirmed or dismissed yet */
  possibleMatches: number;
  sites: { id: string; name: string }[];
  zones: AdvisoryZoneRef[];
  origin: 'feed' | 'upload';
  sourceName: string | null;
}

export interface AdvisoryProfileMatch {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  version: string;
  kind: AdvisoryMatchKind;
  text: string;
}

export interface AdvisorySiteState {
  siteId: string;
  siteName: string;
  notApplicable: boolean;
  reason: string;
  by: string | null;
  at: string | null;
  canManage: boolean;
}

export interface AdvisoryDetail extends AdvisorySummary {
  category: string;
  docStatus: string;
  tlp: string;
  language: string;
  summary: string;
  aggregateSeverity: string;
  references: AdvisoryReference[];
  vulnerabilities: AdvisoryVulnerability[];
  products: AdvisoryProduct[];
  /** More products than shown */
  moreProducts: number;
  integrity: AdvisoryIntegrity;
  signatureUrl: string;
  url: string;
  fileName: string;
  sha256: string;
  createdAt: string;
  createdBy: string;
  matches: AdvisoryAssetMatch[];
  /** Matching assets of sites the reader may not see (counted, never named) */
  hiddenMatches: number;
  siteStates: AdvisorySiteState[];
  profiles: AdvisoryProfileMatch[];
  canDelete: boolean;
}

export interface AdvisoryList {
  items: AdvisorySummary[];
  /** More advisories than the list holds */
  more: number;
  canUpload: boolean;
  canManageSources: boolean;
}

export interface AssetAdvisory {
  advisory: AdvisorySummary;
  match: AdvisoryAssetMatch;
}

export interface AssetAdvisories {
  items: AssetAdvisory[];
  /** Counted matches still open */
  open: number;
}

/** The start page's tile: advisories that affect the reader's sites. */
export interface AdvisoryTile {
  openAdvisories: number;
  openAssets: number;
  critical: number;
  high: number;
  possibleMatches: number;
  sites: { id: string; name: string; advisories: number; assets: number }[];
}

export interface AdvisorySource {
  id: string;
  name: string;
  url: string;
  kind: AdvisorySourceKind;
  enabled: boolean;
  intervalHours: number;
  publishers: string[];
  /** Only documents released on or after this day */
  since: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** Documents read (new or changed) in the last run */
  lastCount: number;
  advisories: number;
}

export interface AdvisoryUploadResult {
  advisory: AdvisorySummary;
  result: 'created' | 'updated' | 'unchanged' | 'older';
  matches: number;
  possible: number;
}

export interface AdvisoryFetchResult {
  source: AdvisorySource;
  read: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: { url: string; error: string }[];
}

// ---------- input ----------

const reason = z.string().trim().max(ADVISORY_LIMITS.reasonChars);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A day as YYYY-MM-DD');
const sha256Hex = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, 'A SHA-256 hash: 64 hexadecimal characters');

export const advisoryUploadInput = z
  .object({
    /** The CSAF document as JSON text */
    content: z.string().min(2).max(ADVISORY_LIMITS.documentBytes),
    fileName: z.string().trim().max(200).default(''),
    /** The published SHA-256 of the file, when the person has it: the upload is refused when it differs */
    sha256: z.union([sha256Hex, z.literal('')]).default(''),
  })
  .strict();
export type AdvisoryUploadInput = z.infer<typeof advisoryUploadInput>;

export const advisoryDecisionInput = z
  .object({
    /** null takes the decision back */
    decision: z.enum(ADVISORY_MATCH_DECISIONS).nullable(),
    reason: reason.default(''),
  })
  .strict()
  .refine((x) => x.decision !== 'dismissed' || x.reason.length > 0, { message: 'Say why the match does not apply', path: ['reason'] });
export type AdvisoryDecisionInput = z.infer<typeof advisoryDecisionInput>;

export const advisoryRemediationInput = z
  .object({
    status: z.enum(ADVISORY_REMEDIATIONS),
    reason: reason.default(''),
    until: day.nullable().default(null),
    windowId: z.string().trim().max(100).nullable().default(null),
    changeSetId: z.string().trim().max(100).nullable().default(null),
    note: reason.default(''),
  })
  .strict()
  .refine((x) => !['accepted', 'not_affected'].includes(x.status) || x.reason.length > 0, { message: 'Give the reason', path: ['reason'] })
  .refine((x) => x.status !== 'accepted' || !!x.until, { message: 'An accepted risk needs the day it ends', path: ['until'] });
export type AdvisoryRemediationInput = z.infer<typeof advisoryRemediationInput>;

export const advisorySiteInput = z
  .object({ notApplicable: z.boolean(), reason: reason.default('') })
  .strict()
  .refine((x) => !x.notApplicable || x.reason.length > 0, { message: 'Say why the advisory does not apply to the site', path: ['reason'] });
export type AdvisorySiteInput = z.infer<typeof advisorySiteInput>;

export const advisorySourceInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: z.string().trim().url().max(2000),
    enabled: z.boolean().default(false),
    intervalHours: z.number().int().min(1).max(168).default(24),
    publishers: z.array(z.string().trim().min(1).max(200)).max(ADVISORY_LIMITS.publishers).default([]),
    since: day.nullable().default(null),
  })
  .strict();
export type AdvisorySourceInput = z.infer<typeof advisorySourceInput>;

/** The kind of a source from its address: …/provider-metadata.json, …/aggregator.json, else a ROLIE feed (JSON). */
export function advisorySourceKind(url: string): AdvisorySourceKind {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* the address as written */
  }
  if (path.endsWith('/provider-metadata.json') || path === 'provider-metadata.json') return 'provider';
  if (path.endsWith('/aggregator.json')) return 'aggregator';
  return 'rolie';
}

/** The severity of a CVSS score (CVSS v3.x qualitative ratings). */
export function severityOfScore(score: number | null | undefined): AdvisorySeverity {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'unknown';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}
