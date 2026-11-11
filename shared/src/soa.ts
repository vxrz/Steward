import { z } from 'zod';
import type { CoverageStatus, ControlTagKind } from './compliance.js';
import type { SupplierCertificateKind, SupplierRef } from './suppliers.js';

/**
 * The statement of applicability with a responsibility matrix per service (ISO/IEC 27001 clause 6.1.3 d, ADR 0029
 * part 2, docs/COMPLIANCE.md#statement-of-applicability). Part of the Compliance module, preview.
 *
 * - The responsibility matrix: per service, six fixed areas and who does each – our team, a supplier (with one of its
 *   contracts), central IT or group, shared, or not applicable. A supplier's SLA, RTO/RPO and certificates are read
 *   from the supplier record, never copied.
 * - The statement of applicability: one per control catalogue, with an optional scope name and services in scope. Per
 *   control: applicable with a justification, the implementation status, how it is met, the responsible party (with
 *   the derived suggestion from the matrix, which never overwrites), the owner, the last review, a GRC reference,
 *   external evidence links and the evidence Steward already holds.
 * - Versions: submitted (frozen content and its SHA-256), approved or returned by a second person (control point
 *   `soa.approve`), exported as a signed file in the evidence-pack format.
 */

/** The six fixed areas of the responsibility matrix (ADR 0029 decision 11). */
export const RESPONSIBILITY_AREAS = ['backup', 'recovery', 'patching', 'access', 'logging', 'incidents'] as const;
export type ResponsibilityArea = (typeof RESPONSIBILITY_AREAS)[number];

/** Who does an area of a service. */
export const RESPONSIBILITY_PARTIES = ['team', 'supplier', 'central', 'shared', 'notApplicable'] as const;
export type ResponsibilityParty = (typeof RESPONSIBILITY_PARTIES)[number];

/** The areas whose recovery the team tests itself when it does them (our team or shared): a recovery-test duty. */
export const RECOVERY_TEST_AREAS: readonly ResponsibilityArea[] = ['backup', 'recovery'];
export const RECOVERY_TEST_PARTIES: readonly ResponsibilityParty[] = ['team', 'shared'];

/**
 * The default ISO/IEC 27001:2022 Annex A identifiers per area (catalogue ISO27001). For other catalogues an
 * administrator names the controls per area in the SoA settings.
 */
export const SOA_DEFAULT_CATALOGUE = 'ISO27001';
export const AREA_DEFAULT_REFS: Record<ResponsibilityArea, readonly string[]> = {
  backup: ['8.13'],
  recovery: ['5.29', '5.30', '8.14'],
  patching: ['8.8'],
  access: ['5.15', '5.16', '5.17', '5.18', '8.2', '8.5'],
  logging: ['8.15', '8.16'],
  incidents: ['5.24', '5.25', '5.26', '5.27'],
};

/** The responsible party of an SoA row. */
export const SOA_PARTIES = ['team', 'supplier', 'central', 'shared'] as const;
export type SoaParty = (typeof SOA_PARTIES)[number];

export const SOA_STATUSES = ['implemented', 'partly', 'planned', 'notStarted'] as const;
export type SoaStatus = (typeof SOA_STATUSES)[number];

export const SOA_VERSION_STATUSES = ['submitted', 'approved', 'returned', 'superseded'] as const;
export type SoaVersionStatus = (typeof SOA_VERSION_STATUSES)[number];

export const SOA_EXPORT_FORMATS = ['zip', 'pdf', 'csv'] as const;
export type SoaExportFormat = (typeof SOA_EXPORT_FORMATS)[number];

export const SOA_LIMITS = {
  /** One SoA per catalogue, up to the catalogue's controls (compliance/controls.ts LIMITS.controls) */
  controls: 2000,
  justification: 2000,
  howMet: 1000,
  evidenceLinks: 10,
  linkTitle: 200,
  url: 2000,
  grcRef: 200,
  scopeName: 200,
  scopeServices: 500,
  centralName: 200,
  note: 1000,
  comment: 2000,
  /** Controls per area in the SoA settings */
  areaControls: 50,
  /** Versions of one SoA (submitted, approved, returned, superseded) */
  versions: 500,
  /** A row not reviewed for this many months counts as "not reviewed" */
  reviewMonths: 12,
  /** The coverage of the last months, by the rule of the Controls page */
  coverageMonths: 12,
} as const;

/** The built-in dataset of the SoA rows (administrators and auditors, like costs.plans). */
export const SOA_DATASET = 'compliance.soa';

/** Signature domain of a signed SoA export (the evidence-pack key, its own prefix: one verifier, one key to trust). */
export const SOA_MANIFEST_KIND = 'soa';

// ---------- inputs ----------

const httpUrl = z
  .string()
  .trim()
  .max(SOA_LIMITS.url)
  .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'an http(s) address');
const subject = z
  .string()
  .trim()
  .regex(/^(user|team):[^\s:].{0,119}$/i, 'user:<name> or team:<name>')
  .transform((s) => s.toLowerCase());
const id = z.string().trim().min(1).max(100);

export const soaEvidenceLink = z
  .object({
    title: z.string().trim().min(1).max(SOA_LIMITS.linkTitle),
    url: httpUrl.refine((v) => v !== '', 'an http(s) address'),
  })
  .strict();

/** The controls per area of an SoA (settings, administrators): control ids of the SoA's catalogue. */
export const soaAreaControls = z
  .object(
    Object.fromEntries(RESPONSIBILITY_AREAS.map((a) => [a, z.array(id).max(SOA_LIMITS.areaControls)])) as Record<ResponsibilityArea, z.ZodArray<typeof id>>,
  )
  .partial()
  .strict();
export type SoaAreaControls = z.infer<typeof soaAreaControls>;

/** POST /api/compliance/soa: one SoA per catalogue, pre-filled with one undecided row per control. */
export const soaCreateInput = z
  .object({
    catalogueId: id,
    scopeName: z.string().trim().max(SOA_LIMITS.scopeName).default(''),
    scopeServiceIds: z.array(id).max(SOA_LIMITS.scopeServices).default([]),
    /** A second person approves (on by default; off only by administrators, and never while the policy requires it) */
    fourEyes: z.boolean().default(true),
  })
  .strict();
export type SoaCreateInput = z.input<typeof soaCreateInput>;

/** PUT /api/compliance/soa/:catalogueId/settings */
export const soaSettingsInput = z
  .object({
    scopeName: z.string().trim().max(SOA_LIMITS.scopeName),
    scopeServiceIds: z.array(id).max(SOA_LIMITS.scopeServices),
    fourEyes: z.boolean(),
    /** Administrators only */
    areaControls: soaAreaControls,
  })
  .partial()
  .strict();
export type SoaSettingsInput = z.input<typeof soaSettingsInput>;

/**
 * PUT /api/compliance/soa/:catalogueId/entries/:controlId: the fields to change. Designers and administrators change
 * every field; the row's owner changes `status`, `howMet` and `reviewed` only.
 */
export const soaEntryInput = z
  .object({
    applicable: z.boolean().nullable(),
    justification: z.string().max(SOA_LIMITS.justification),
    status: z.enum(SOA_STATUSES).nullable(),
    howMet: z.string().max(SOA_LIMITS.howMet),
    party: z.enum(SOA_PARTIES).nullable(),
    supplierId: id.nullable(),
    centralName: z.string().trim().max(SOA_LIMITS.centralName),
    owner: subject.nullable(),
    /** true: reviewed now, by the person saving */
    reviewed: z.literal(true),
    grcRef: z.string().trim().max(SOA_LIMITS.grcRef),
    grcUrl: httpUrl,
    evidenceLinks: z.array(soaEvidenceLink).max(SOA_LIMITS.evidenceLinks),
  })
  .partial()
  .strict();
export type SoaEntryInput = z.input<typeof soaEntryInput>;

/** The fields a row's owner may change (ADR 0029, _Permissions and audit_). */
export const SOA_OWNER_FIELDS = ['status', 'howMet', 'reviewed'] as const;

/** POST /api/compliance/soa/:catalogueId/versions/:n/decision: approve or return (with a comment). */
export const soaDecisionInput = z
  .object({
    approve: z.boolean(),
    comment: z.string().trim().max(SOA_LIMITS.comment).default(''),
  })
  .strict();

/** PUT /api/services/:id/responsibilities: the areas to set; party null makes an area undecided again. */
export const responsibilityInput = z
  .object({
    area: z.enum(RESPONSIBILITY_AREAS),
    party: z.enum(RESPONSIBILITY_PARTIES).nullable(),
    supplierId: id.nullable().optional(),
    contractId: id.nullable().optional(),
    centralName: z.string().trim().max(SOA_LIMITS.centralName).default(''),
    note: z.string().trim().max(SOA_LIMITS.note).default(''),
    dutyId: id.nullable().default(null),
  })
  .strict();
export const responsibilitiesInput = z
  .object({ areas: z.array(responsibilityInput).min(1).max(RESPONSIBILITY_AREAS.length) })
  .strict()
  .refine((v) => new Set(v.areas.map((a) => a.area)).size === v.areas.length, 'each area once');
export type ResponsibilitiesInput = z.input<typeof responsibilitiesInput>;

// ---------- what the API returns ----------

export interface SoaControlRef {
  catalogueKey: string;
  controlId: string;
  ref: string;
  title: string;
  /** The catalogue has an SoA (the link goes to its row) */
  soa: boolean;
}

export interface ResponsibilityContract {
  id: string;
  title: string;
  reference: string;
  termEnd: string | null;
  noticeBy: string | null;
  slaAvailability: number | null;
  slaSupportHours: string;
  slaResponse: string;
  rtoHours: number | null;
  rpoHours: number | null;
}

export interface ResponsibilityRow {
  area: ResponsibilityArea;
  /** null: undecided */
  party: ResponsibilityParty | null;
  /** The supplier (read from the supplier record); null when none is linked or the reader may not see it */
  supplier: SupplierRef | null;
  /** A supplier is linked that the reader may not see */
  supplierHidden: boolean;
  contract: ResponsibilityContract | null;
  /** A contract is named that the reader may not see (ADR 0031): "a contract you may not see" – kept on save */
  contractHidden: boolean;
  /** The contract no longer covers the service (ADR 0031) */
  contractUncovered: boolean;
  /** The supplier's certificates valid today */
  certificates: { kind: SupplierCertificateKind; name: string; validUntil: string | null }[];
  centralName: string;
  note: string;
  duty: { id: string; name: string } | null;
  /** Where the team does recovery itself: a recovery-test duty of the service is asked for */
  recoveryTest: 'notNeeded' | 'linked' | 'missing';
  /** The default controls of the area (and the area controls of other catalogues' SoAs) */
  controls: SoaControlRef[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ServiceResponsibilities {
  serviceId: string;
  serviceName: string;
  rows: ResponsibilityRow[];
  /** The service's duties (for the recovery-test duty) */
  duties: { id: string; name: string }[];
  /** Whoever may edit the service */
  canEdit: boolean;
  /** Areas not decided yet */
  undecided: number;
}

/** The derived suggestion of an SoA row from the matrix of the services in scope; never stored. */
export interface SoaSuggestion {
  /** Services per party */
  counts: Record<ResponsibilityParty, number>;
  /** Services in scope without a decision for the row's areas */
  undecided: number;
  /** The most frequent party (ties: shared); null when no service decided */
  party: SoaParty | null;
  /** When every supplier row names the same supplier (visible to the reader) */
  supplier: SupplierRef | null;
  centralName: string;
}

export interface SoaEvidence {
  status: CoverageStatus;
  /** Items mapped to the control (visible or not) */
  mapped: number;
  /** Evidence items of the last twelve months the reader may see */
  items: number;
  /** Evidence items the reader may not see (counted, never named) */
  hidden: number;
  /** The mapped items (the first ones) */
  tags: { kind: ControlTagKind; label: string; path: string | null; visible: boolean }[];
}

export interface SoaEntry {
  controlId: string;
  ref: string;
  title: string;
  description: string;
  applicable: boolean | null;
  justification: string;
  status: SoaStatus | null;
  howMet: string;
  party: SoaParty | null;
  supplier: SupplierRef | null;
  supplierHidden: boolean;
  centralName: string;
  owner: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  /** Not reviewed for twelve months (or never) */
  reviewDue: boolean;
  grcRef: string;
  grcUrl: string;
  evidenceLinks: { title: string; url: string }[];
  /** The matrix areas whose controls include this one */
  areas: ResponsibilityArea[];
  suggestion: SoaSuggestion | null;
  evidence: SoaEvidence;
  /** Applicable and implemented, with no mapped item and no evidence link */
  noEvidence: boolean;
  /** Corrective action findings naming the control that the reader may see */
  findings: { open: number; total: number };
  /** Decided: applicable set with a justification, and a status where applicable */
  decided: boolean;
  /** Differs from the latest approved version */
  changed: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Change every field (designers, administrators) */
  canEdit: boolean;
  /** Change status, how it is met and the last review (the row's owner) */
  canEditOwn: boolean;
}

/** Counts of an SoA (also what the ISMS summary reads, ADR 0029 part 4). */
export interface SoaCounts {
  controls: number;
  applicable: number;
  notApplicable: number;
  undecided: number;
  implemented: number;
  partly: number;
  planned: number;
  notStarted: number;
  /** Applicable rows without a status */
  noStatus: number;
  /** Rows not reviewed for twelve months (or never) */
  reviewDue: number;
  /** Applicable, implemented rows with no mapped item and no link */
  noEvidence: number;
}

export interface SoaVersionSummary {
  number: number;
  status: SoaVersionStatus;
  contentSha256: string;
  submittedAt: string;
  submittedBy: string;
  decidedAt: string | null;
  decidedBy: string | null;
  comment: string;
  /** SHA-256 of the archived PDF (approved versions) */
  pdfSha256: string | null;
  /** A second person approves this version: fixed when it was submitted (or required by the policy now) */
  fourEyes: boolean;
  counts: SoaCounts;
  canExport: boolean;
}

export interface SoaSummary {
  id: string;
  catalogueId: string;
  catalogueKey: string;
  catalogueName: string;
  scopeName: string;
  scopeServiceIds: string[];
  fourEyes: boolean;
  counts: SoaCounts;
  latestApproved: { number: number; decidedAt: string; decidedBy: string } | null;
  /** A version waiting for approval */
  waiting: { number: number; submittedAt: string; submittedBy: string } | null;
  /** Rows that differ from the latest approved version */
  changedSinceApproved: number;
  createdAt: string;
  updatedAt: string;
}

export interface Soa extends SoaSummary {
  catalogueVersion: string;
  /** The services in scope the reader may see (none: all services) */
  scopeServices: { id: string; name: string }[];
  /** Services the suggestions count */
  servicesInScope: number;
  areaControls: Record<ResponsibilityArea, string[]>;
  /** The area controls are the built-in defaults (ISO/IEC 27001:2022 Annex A) */
  areaControlsDefault: boolean;
  entries: SoaEntry[];
  versions: SoaVersionSummary[];
  permissions: {
    /** Change rows and settings, submit: designers, administrators */
    edit: boolean;
    /** The area controls: administrators */
    areaControls: boolean;
    submit: boolean;
    /** Why submitting is not possible now */
    submitBlocked: 'undecided' | 'waiting' | null;
    /** Approve or return the waiting version now */
    decide: boolean;
    /** Why not, for an approver: their own submission while a second person is required */
    decideBlocked: 'ownSubmission' | null;
    /** A second person approves (the SoA's switch or the policy) */
    fourEyes: boolean;
    /** The policy requires a second person for every SoA */
    fourEyesRequiredByPolicy: boolean;
    /** Switch the second person off: administrators (with a confirmation), unless the policy requires it */
    fourEyesOff: boolean;
    export: boolean;
  };
}

export interface SoaList {
  items: SoaSummary[];
  /** Catalogues without an SoA yet */
  catalogues: { id: string; key: string; name: string; controls: number }[];
  canCreate: boolean;
  /** Create a statement without a second person: administrators, unless the policy requires one */
  fourEyesOff: boolean;
}

/** One version with its frozen content (soa.json of the signed export). */
export interface SoaVersionContent {
  format: 'steward-soa';
  version: 1;
  catalogue: { key: string; name: string; version: string };
  /** `servicesHidden`: only in what GET …/versions/:n shows – services in scope the reader may not see (left out) */
  scope: { name: string; services: string[]; servicesHidden?: number };
  number: number;
  submittedAt: string;
  submittedBy: string;
  counts: SoaCounts;
  entries: {
    ref: string;
    title: string;
    description: string;
    applicable: boolean | null;
    justification: string;
    status: SoaStatus | null;
    howMet: string;
    party: SoaParty | null;
    supplier: string | null;
    /** Only in what GET …/versions/:n shows: a supplier is named that the reader may not see (supplier is then null) */
    supplierHidden?: boolean;
    centralName: string;
    owner: string | null;
    reviewedAt: string | null;
    reviewedBy: string | null;
    grcRef: string;
    grcUrl: string;
    evidenceLinks: { title: string; url: string }[];
    coverage: { status: CoverageStatus; mapped: number; items: number };
    suggestion: { party: SoaParty | null; counts: Record<ResponsibilityParty, number> } | null;
  }[];
}

export interface SoaVersionDetail extends SoaVersionSummary {
  content: SoaVersionContent;
}
