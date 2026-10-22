/**
 * Access governance evidence (ISO/IEC 27001, IEC 62443-2-1): access change
 * entries, the access reconciliation (actual vs. documented), control
 * catalogues with evidence coverage, and evidence packs. Shared by server
 * and web: field definitions, API shapes and the access snapshot format.
 */
import type { RecordFieldDef, RecordType } from './records.js';

// ---------- access change entries (a built-in record type) ----------

export const ACCESS_CHANGE_KINDS = ['grant', 'revoke', 'modify', 'onboarding', 'offboarding'] as const;
export type AccessChangeKind = (typeof ACCESS_CHANGE_KINDS)[number];

/** manual: written by a person; run: created by a run of a process that changes access; reconciliation: documented after the fact */
export const ACCESS_CHANGE_ORIGINS = ['manual', 'run', 'reconciliation'] as const;
export type AccessChangeOrigin = (typeof ACCESS_CHANGE_ORIGINS)[number];

export const ACCESS_SUBJECT_TYPES = ['user', 'technical'] as const;

/** The id of the built-in record type for access change entries (its key is AC unless that key was taken). */
export const ACCESS_TYPE_ID = 'rty_ac';
export const ACCESS_TYPE_KEY = 'AC';

/**
 * Fields of an access change entry. The keys are read by the reconciliation and the evidence
 * packs: administrators may change labels and help texts, but not remove these keys.
 */
export const ACCESS_CHANGE_FIELDS: RecordFieldDef[] = [
  { key: 'platform', label: 'Platform', kind: 'text', required: true, help: 'Id of the Steward platform whose access changed' },
  { key: 'subjectId', label: 'Subject id', kind: 'text', required: true, help: 'User name, user id or technical user id on the platform' },
  { key: 'subjectName', label: 'Subject name', kind: 'text', help: 'Display name' },
  { key: 'subjectType', label: 'Subject type', kind: 'select', options: [...ACCESS_SUBJECT_TYPES] },
  { key: 'changeKind', label: 'Change', kind: 'select', options: [...ACCESS_CHANGE_KINDS], required: true },
  { key: 'rightsBefore', label: 'Rights before', kind: 'textarea', help: 'Roles, groups or scopes before the change, one per line' },
  { key: 'rightsAfter', label: 'Rights after', kind: 'textarea', help: 'Roles, groups or scopes after the change, one per line' },
  { key: 'reason', label: 'Reason', kind: 'textarea', required: true },
  { key: 'requestedBy', label: 'Requested by', kind: 'text' },
  { key: 'requestRef', label: 'Request reference', kind: 'text', help: 'Ticket number or link, e.g. a ServiceNow request' },
  { key: 'approvedBy', label: 'Approved by', kind: 'text' },
  { key: 'performedBy', label: 'Performed by', kind: 'text', required: true },
  { key: 'performedAt', label: 'Performed at', kind: 'datetime', required: true },
  { key: 'origin', label: 'Origin', kind: 'select', options: [...ACCESS_CHANGE_ORIGINS] },
  { key: 'runId', label: 'Run', kind: 'text', help: 'Run that made the change (automatic entries)' },
  { key: 'findingId', label: 'Reconciliation finding', kind: 'text', help: 'Undocumented change this entry documents after the fact' },
];
/** Field keys the compliance features depend on. */
export const ACCESS_CHANGE_FIELD_KEYS = ACCESS_CHANGE_FIELDS.map((f) => f.key);

export const ACCESS_RECORD_TYPE: Omit<RecordType, 'id' | 'builtin' | 'archived' | 'recordCount' | 'createdAt' | 'updatedAt'> = {
  key: ACCESS_TYPE_KEY,
  name: 'Access change',
  description:
    'Documentation of a grant, revocation or change of access rights on a platform, including changes made outside Steward. Documenting freezes the entry; another person can verify it.',
  workflow: 'access',
  template: '## Details\n\n\n## Evidence\n\n- \n',
  fields: ACCESS_CHANGE_FIELDS,
};

export interface AccessChange {
  recordId: string;
  number: string;
  title: string;
  /** draft, documented, verified, cancelled */
  status: string;
  platformId: string;
  /** null when the platform does not exist (any more) or the reader may not see it */
  platformName: string | null;
  subjectId: string;
  subjectName: string;
  subjectType: string;
  kind: AccessChangeKind | string;
  rightsBefore: string[];
  rightsAfter: string[];
  /** rightsAfter − rightsBefore */
  granted: string[];
  /** rightsBefore − rightsAfter */
  revoked: string[];
  reason: string;
  requestedBy: string;
  requestRef: string;
  approvedBy: string;
  performedBy: string;
  performedAt: string;
  origin: AccessChangeOrigin | string;
  /** Documented after an undocumented change was found by the reconciliation */
  afterTheFact: boolean;
  runId: string | null;
  findingId: string | null;
  frozenHash: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

// ---------- access snapshots and reconciliation ----------

/**
 * The access snapshot shape a process publishes as a dataset (source "dataset"): either one row per
 * assignment `{ subjectId, subjectName?, subjectType?, right }` (recommended) or one row per subject
 * `{ subjectId, subjectName?, subjectType?, rights }` with `rights` a list or comma-separated text.
 */
export const ACCESS_SNAPSHOT_COLUMNS = { subjectId: 'subjectId', subjectName: 'subjectName', subjectType: 'subjectType', right: 'right', rights: 'rights' };

export const ACCESS_CHECK_SOURCES = ['insights-hub', 'dataset'] as const;
export type AccessCheckSource = (typeof ACCESS_CHECK_SOURCES)[number];

export interface AccessSubject {
  id: string;
  name: string;
  type?: string;
  /** Sorted, unique */
  rights: string[];
}

export interface AccessCheck {
  id: string;
  name: string;
  description: string;
  platformId: string;
  platformName: string | null;
  platformKind: string | null;
  source: AccessCheckSource;
  /** Dataset key (source "dataset") */
  datasetKey: string | null;
  cron: string;
  timezone: string;
  enabled: boolean;
  owner: string;
  /** Who is notified about undocumented changes besides the owner and administrators (user:<name>, team:<name>) */
  notify: string[];
  /** Rights left out of the snapshots, e.g. a review marker group (exact names, case-insensitive) */
  ignoreRights: string[];
  lastRunAt: string | null;
  lastStatus: 'ok' | 'findings' | 'failed' | null;
  lastError: string | null;
  lastSnapshotId: string | null;
  snapshotCount: number;
  openFindings: number;
  canEdit: boolean;
  canRun: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccessSnapshotSummary {
  id: string;
  checkId: string;
  takenAt: string;
  subjects: number;
  assignments: number;
  /** SHA-256 of the canonical snapshot data */
  hash: string;
  /** SHA-256 chained over the previous snapshot of the check (prevChainHash | check | takenAt | hash) */
  chainHash: string;
  prevChainHash: string | null;
  /** The data equals an earlier snapshot (stored once): its id */
  sameAs: string | null;
  sourceRunId: string | null;
  trigger: string;
  takenBy: string;
  /** Findings this snapshot produced */
  findings: number;
}

export interface AccessSnapshot extends AccessSnapshotSummary {
  data: AccessSubject[];
}

export const ACCESS_FINDING_STATUSES = ['open', 'documented', 'dismissed'] as const;
export type AccessFindingStatus = (typeof ACCESS_FINDING_STATUSES)[number];

export interface AccessFinding {
  id: string;
  checkId: string;
  checkName: string;
  platformId: string;
  platformName: string | null;
  snapshotId: string;
  previousSnapshotId: string;
  detectedAt: string;
  /** Changes performed in this window need an access change entry */
  windowFrom: string;
  windowTo: string;
  subjectId: string;
  subjectName: string;
  kind: AccessChangeKind;
  /** Rights granted without a matching entry */
  granted: string[];
  /** Rights removed without a matching entry */
  revoked: string[];
  rightsBefore: string[];
  rightsAfter: string[];
  status: AccessFindingStatus;
  recordId: string | null;
  recordNumber: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  comment: string;
  canDocument: boolean;
  canDismiss: boolean;
}

export interface AccessReconciliationMeta {
  canCreate: boolean;
  demo: boolean;
  sources: AccessCheckSource[];
}

// ---------- control catalogues ----------

export const CONTROL_TAG_KINDS = ['process', 'recordType', 'record', 'monitor', 'reportSchedule', 'accessCheck'] as const;
export type ControlTagKind = (typeof CONTROL_TAG_KINDS)[number];

export interface ControlCatalogue {
  id: string;
  key: string;
  name: string;
  version: string;
  description: string;
  builtin: boolean;
  controlCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ControlTag {
  kind: ControlTagKind;
  targetId: string;
  /** Name of the item; empty when the reader may not see it */
  label: string;
  path: string | null;
  visible: boolean;
}

export interface Control {
  id: string;
  catalogueId: string;
  catalogueKey: string;
  ref: string;
  title: string;
  description: string;
  tags: ControlTag[];
}

export const EVIDENCE_KINDS = ['run', 'record', 'accessChange', 'snapshot', 'finding', 'report', 'monitor'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceItem {
  kind: EvidenceKind;
  id: string;
  label: string;
  at: string;
  path: string | null;
  /** e.g. run status, record status, finding status */
  status: string;
  detail: string;
  /** Item the evidence comes from (the tagged process, record type …) */
  via: { kind: ControlTagKind; id: string; label: string };
}

export type CoverageStatus = 'covered' | 'gap' | 'unmapped';

export interface ControlCoverage {
  control: Control;
  status: CoverageStatus;
  counts: Partial<Record<EvidenceKind, number>>;
  evidence: EvidenceItem[];
  /** Evidence items left out (list limit) */
  truncated: number;
}

export interface ControlsMeta {
  canManageCatalogues: boolean;
  canTag: boolean;
  tagKinds: readonly ControlTagKind[];
}

// ---------- evidence packs ----------

export interface EvidencePackScope {
  controlIds?: string[];
  platformId?: string;
  serviceId?: string;
}

export const EVIDENCE_PACK_STATUSES = ['building', 'ready', 'failed', 'expired'] as const;
export type EvidencePackStatus = (typeof EVIDENCE_PACK_STATUSES)[number];

export interface EvidencePack {
  id: string;
  title: string;
  scope: EvidencePackScope;
  /** Readable scope, e.g. "ISO27001 5.18, 8.2" */
  scopeLabel: string;
  from: string;
  to: string;
  status: EvidencePackStatus;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
  size: number | null;
  sha256: string | null;
  fileCount: number | null;
  error: string | null;
  canDownload: boolean;
  canDelete: boolean;
}

export interface EvidencePacksMeta {
  canCreate: boolean;
  maxBytes: number;
  maxFiles: number;
  retentionDays: number;
  maxPeriodDays: number;
}

/** Format of manifest.json in an evidence pack (verified by `npm run evidence:verify`). */
export const EVIDENCE_PACK_FORMAT = 'steward-evidence-pack';
