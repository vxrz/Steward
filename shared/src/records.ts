/**
 * Records (change requests, decision records) and the minimal service
 * catalogue. Shared by server and web: workflows, default record types,
 * link kinds and the API shapes.
 */

import type { ErrorParams } from './errors.js';

// ---------- workflows ----------

export const RECORD_WORKFLOW_KEYS = ['change', 'decision', 'access', 'document'] as const;
export type RecordWorkflowKey = (typeof RECORD_WORKFLOW_KEYS)[number];

export interface RecordTransitionDef {
  action: string;
  from: string[];
  to: string;
  /** Approve/reject: approver or admin, never the author or submitter (four-eyes) */
  approval?: boolean;
  /** A comment is required (rejections) */
  commentRequired?: boolean;
  /** The superseding record must be named (decision records) */
  needsRecord?: boolean;
  /** A replacing record may be named (withdrawing a document) */
  optionalRecord?: boolean;
  /** Living documents: the target when the document already has an approved edition (reject → revising instead of draft) */
  toWithEdition?: string;
}

export interface RecordWorkflow {
  key: RecordWorkflowKey;
  /** The editable status; content is frozen in every other status */
  initial: string;
  statuses: string[];
  /** No further transitions, links or attachments */
  terminal: string[];
  /** "New revision": back to the initial status for rework (audited) */
  revisable: string[];
  /** Statuses in which the content can change (default: only the initial status) */
  editable?: string[];
  /** Status a new revision starts in (default: the initial status) */
  reviseTo?: string;
  transitions: RecordTransitionDef[];
}

export const RECORD_WORKFLOWS: Record<RecordWorkflowKey, RecordWorkflow> = {
  change: {
    key: 'change',
    initial: 'draft',
    statuses: ['draft', 'submitted', 'approved', 'rejected', 'implemented', 'closed', 'cancelled'],
    terminal: ['closed', 'cancelled'],
    revisable: ['submitted', 'rejected'],
    transitions: [
      { action: 'submit', from: ['draft'], to: 'submitted' },
      { action: 'approve', from: ['submitted'], to: 'approved', approval: true },
      { action: 'reject', from: ['submitted'], to: 'rejected', approval: true, commentRequired: true },
      { action: 'implement', from: ['approved'], to: 'implemented' },
      { action: 'close', from: ['implemented'], to: 'closed' },
      { action: 'cancel', from: ['draft', 'submitted'], to: 'cancelled' },
    ],
  },
  decision: {
    key: 'decision',
    initial: 'draft',
    statuses: ['draft', 'proposed', 'accepted', 'rejected', 'superseded', 'deprecated'],
    terminal: ['superseded', 'deprecated'],
    revisable: ['proposed', 'rejected'],
    transitions: [
      { action: 'propose', from: ['draft'], to: 'proposed' },
      { action: 'accept', from: ['proposed'], to: 'accepted', approval: true },
      { action: 'reject', from: ['proposed'], to: 'rejected', approval: true, commentRequired: true },
      { action: 'supersede', from: ['accepted'], to: 'superseded', needsRecord: true },
      { action: 'deprecate', from: ['accepted'], to: 'deprecated' },
    ],
  },
  // Access change entries (compliance): documenting freezes the entry; verifying is a second person's check (four-eyes).
  access: {
    key: 'access',
    initial: 'draft',
    statuses: ['draft', 'documented', 'verified', 'cancelled'],
    terminal: ['verified', 'cancelled'],
    revisable: ['documented'],
    transitions: [
      { action: 'document', from: ['draft'], to: 'documented' },
      { action: 'verify', from: ['documented'], to: 'verified', approval: true },
      { action: 'cancel', from: ['draft'], to: 'cancelled' },
    ],
  },
  // Living documents (service documentation, concepts, manuals): approving freezes the content as an edition
  // (1.0, 1.1, 2.0); "new edition" drafts the next one while the current edition stays valid.
  document: {
    key: 'document',
    initial: 'draft',
    statuses: ['draft', 'in_review', 'published', 'revising', 'withdrawn'],
    terminal: ['withdrawn'],
    revisable: ['published'],
    editable: ['draft', 'revising'],
    reviseTo: 'revising',
    transitions: [
      { action: 'submit', from: ['draft', 'revising'], to: 'in_review' },
      { action: 'approve', from: ['in_review'], to: 'published', approval: true },
      { action: 'reject', from: ['in_review'], to: 'draft', toWithEdition: 'revising', approval: true, commentRequired: true },
      { action: 'withdraw', from: ['draft', 'published', 'revising'], to: 'withdrawn', commentRequired: true, optionalRecord: true },
    ],
  },
};

/** Statuses in which a record's content can change. */
export const editableStatuses = (wf: RecordWorkflow): string[] => wf.editable ?? [wf.initial];
export const isEditableStatus = (wf: RecordWorkflow, status: string): boolean => editableStatuses(wf).includes(status);

/** Every status of every workflow (for filters and the API schema). */
export const RECORD_STATUSES = [...new Set(Object.values(RECORD_WORKFLOWS).flatMap((w) => w.statuses))];
export const RECORD_ACTIONS = [...new Set(Object.values(RECORD_WORKFLOWS).flatMap((w) => w.transitions.map((t) => t.action)))];

/** Status colours (Mantine colour names). */
export const RECORD_STATUS_COLORS: Record<string, string> = {
  draft: 'gray',
  submitted: 'blue',
  proposed: 'blue',
  approved: 'green',
  accepted: 'green',
  rejected: 'red',
  implemented: 'teal',
  closed: 'dark',
  cancelled: 'gray',
  superseded: 'orange',
  deprecated: 'yellow',
  documented: 'blue',
  verified: 'green',
  in_review: 'blue',
  published: 'green',
  revising: 'cyan',
  withdrawn: 'dark',
};

// ---------- record types ----------

export const RECORD_FIELD_KINDS = ['text', 'textarea', 'date', 'datetime', 'select'] as const;
export type RecordFieldKind = (typeof RECORD_FIELD_KINDS)[number];

export interface RecordFieldDef {
  /** camelCase key in `fields` */
  key: string;
  label: string;
  kind: RecordFieldKind;
  required?: boolean;
  /** For kind "select" */
  options?: string[];
  help?: string;
}

export interface RecordType {
  id: string;
  /** Number prefix, e.g. CR → CR-2026-0001 */
  key: string;
  name: string;
  description: string;
  workflow: RecordWorkflowKey;
  /** Markdown body of a new record (section headings) */
  template: string;
  fields: RecordFieldDef[];
  /** Living documents: months between periodic reviews (0 = no reviews); null for other workflows */
  reviewIntervalMonths: number | null;
  builtin: boolean;
  archived: boolean;
  recordCount: number;
  createdAt: string;
  updatedAt: string;
}

export const RECORD_TYPE_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
export const RECORD_FIELD_KEY_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
export const RECORD_NUMBER_RE = /^[A-Z][A-Z0-9]{1,9}-\d{4}-\d{4,}$/;

const DECISION_FIELDS: RecordFieldDef[] = [
  { key: 'decisionDate', label: 'Decision date', kind: 'date' },
  { key: 'deciders', label: 'Deciders', kind: 'text', help: 'People who made the decision' },
  { key: 'consulted', label: 'Consulted', kind: 'text' },
  { key: 'informed', label: 'Informed', kind: 'text' },
];

const decisionTemplate = (extra = '') =>
  `## Context and problem statement\n\n\n## Decision drivers\n\n- \n\n## Considered options\n\n1. \n\n## Decision\n\n\n## Consequences\n\n- Good: \n- Bad: \n${extra}`;

/** The record types created on first start (admins can edit or archive them, and add more). */
/** A record type as defined in code (the built-in ones). */
export type RecordTypeDefinition = Omit<RecordType, 'id' | 'builtin' | 'archived' | 'recordCount' | 'createdAt' | 'updatedAt' | 'reviewIntervalMonths'> & {
  reviewIntervalMonths?: number;
};

export const DEFAULT_RECORD_TYPES: RecordTypeDefinition[] = [
  {
    key: 'CR',
    name: 'Change request',
    description: 'A planned change to a service or platform: why, risk, rollback and the implementation window. Approved by someone other than the requester.',
    workflow: 'change',
    template: '## Description\n\n\n## Implementation plan\n\n1. \n\n## Test and verification\n\n\n## Communication\n\n',
    fields: [
      { key: 'reason', label: 'Reason', kind: 'textarea', required: true },
      { key: 'risk', label: 'Risk', kind: 'select', options: ['low', 'medium', 'high'], required: true },
      { key: 'impact', label: 'Impact', kind: 'textarea' },
      { key: 'rollbackPlan', label: 'Rollback plan', kind: 'textarea', required: true },
      { key: 'plannedStart', label: 'Planned start', kind: 'datetime' },
      { key: 'plannedEnd', label: 'Planned end', kind: 'datetime' },
    ],
  },
  {
    key: 'ADR',
    name: 'Architecture decision record',
    description: 'An architecturally significant decision with its context and consequences (MADR or Nygard style).',
    workflow: 'decision',
    template: decisionTemplate(),
    fields: DECISION_FIELDS,
  },
  {
    key: 'DR',
    name: 'Decision record',
    description: 'A decision of the service team that is not about architecture, e.g. an operating rule or a supplier choice.',
    workflow: 'decision',
    template: decisionTemplate(),
    fields: DECISION_FIELDS,
  },
  {
    key: 'SDR',
    name: 'Security decision record',
    description:
      'A security decision, e.g. an accepted risk, an exception or a hardening measure. If your team uses SDR for something else, change the name and description (the key cannot change once records exist) or archive the type.',
    workflow: 'decision',
    template: decisionTemplate('\n## Risk assessment\n\n\n## Review date\n\n'),
    fields: DECISION_FIELDS,
  },
];

/** Fixed id of the built-in type for living documents (created in every installation, also existing ones). */
export const DOCUMENT_TYPE_ID = 'rty_doc';
export const DOCUMENT_TYPE_KEY = 'DOC';
/** Months between reviews of a document type that names none. */
export const DEFAULT_REVIEW_INTERVAL_MONTHS = 12;

/** The built-in type for living documents: service documentation, concepts, manuals. */
export const DOCUMENT_RECORD_TYPE: RecordTypeDefinition = {
  key: DOCUMENT_TYPE_KEY,
  name: 'Service documentation',
  description:
    'A living document, e.g. an operations manual, an identity and access management concept or an authorization concept. Each approved edition (1.0, 1.1, 2.0) is frozen; the document is reviewed at planned intervals.',
  workflow: 'document',
  template: '## Purpose and scope\n\n\n## Responsibilities\n\n- \n\n## Content\n\n\n## Related documents\n\n- \n',
  fields: [],
  reviewIntervalMonths: DEFAULT_REVIEW_INTERVAL_MONTHS,
};

// ---------- living documents: editions and reviews ----------

export const EDITION_KINDS = ['minor', 'major'] as const;
/** minor: editorial (1.0 → 1.1); major: substantive (1.x → 2.0) */
export type EditionKind = (typeof EDITION_KINDS)[number];
export const EDITION_RE = /^\d{1,4}\.\d{1,4}$/;

/** "current" → "dueSoon" → "overdue"; "none": no review planned (no edition yet, no interval, withdrawn). */
export const REVIEW_STATUSES = ['current', 'dueSoon', 'overdue', 'none'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_OUTCOMES = ['no_change', 'needs_update'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** An approved, frozen state of a living document (without its text: see RecordEdition). */
export interface RecordEditionSummary {
  /** "1.0", "1.1", "2.0" */
  edition: string;
  major: number;
  minor: number;
  kind: EditionKind;
  revision: number;
  version: number;
  title: string;
  /** Content hash of the frozen edition (as approved) */
  contentHash: string;
  changeSummary: string;
  /** Who wrote content of this edition */
  authors: string[];
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string;
  approvedAt: string;
  /** The edition valid now */
  current: boolean;
  /** The stored content still matches its hash and the authentic audit entry of its approval */
  intact: boolean;
}

/** A frozen edition with its content. */
export interface RecordEdition extends RecordEditionSummary {
  body: string;
  fields: Record<string, string>;
  fieldDefs: RecordFieldDef[];
  attachments: { id: string; filename: string; size: number; sha256: string }[];
}

export interface RecordReview {
  id: string;
  outcome: ReviewOutcome;
  /** The edition that was reviewed */
  edition: string | null;
  reviewer: string;
  comment: string;
  createdAt: string;
  /** Next review planned after this one (null: none) */
  nextReviewAt: string | null;
}

export interface DocumentReviewState {
  status: ReviewStatus;
  /** Effective interval in months (document override, else the type's) */
  intervalMonths: number;
  /** The document's own interval (null: the type's) */
  intervalOverride: number | null;
  typeIntervalMonths: number;
  /** Who is reminded and reviews (default: the owner) */
  owner: string;
  ownerOverride: string | null;
  lastReviewedAt: string | null;
  lastReviewedBy: string | null;
  nextReviewAt: string | null;
  /** An earlier date set for the next review (cleared by the next review or edition) */
  nextReviewOverride: string | null;
  /** Whole days until the next review (negative when overdue) */
  daysLeft: number | null;
  /** A review found that the document needs an update ("Needs update"); cleared when the next edition is approved */
  updateRequestedAt: string | null;
}

export interface DocumentInfo {
  /** The edition valid now (null before the first approval) */
  currentEdition: string | null;
  /** Chosen when submitting: what the next edition will be */
  pending: { kind: EditionKind; changeSummary: string; edition: string } | null;
  /** The number the next edition gets as minor and as major */
  nextEdition: { minor: string; major: string };
  editions: RecordEditionSummary[];
  reviews: RecordReview[];
  review: DocumentReviewState;
  permissions: {
    review: boolean;
    /** May open the review settings: an earlier next review (editors, the owner), or more (below) */
    settings: boolean;
    /** May choose the review owner and the document's own interval (approvers, administrators) */
    reviewOwner: boolean;
    reviewInterval: boolean;
    /** May set no reviews (0) or an interval longer than the type's (administrators) */
    anyInterval: boolean;
  };
}

/** One row of a document's changelog: an approved edition or a review. */
export interface DocumentChangelogRow {
  kind: 'edition' | 'review';
  at: string;
  edition: string | null;
  /** edition: its authors; review: the reviewer */
  people: string[];
  /** edition: the approver */
  approvedBy: string | null;
  /** edition: change summary; review: comment */
  text: string;
  outcome: ReviewOutcome | null;
  editionKind: EditionKind | null;
  contentHash: string | null;
}

// ---------- links ----------

/**
 * Kinds of internal items a record or service can link to. Links are stored
 * generically as { kind, id }: a new kind needs a resolver on the server and
 * an entry here.
 */
export const LINK_KINDS = ['process', 'run', 'monitor', 'platform', 'dashboard', 'record', 'service', 'credential'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface ItemLink {
  id: string;
  /** Internal target, or null for an external URL */
  kind: LinkKind | null;
  targetId: string | null;
  url: string | null;
  /** Label: the target's name (when visible) or the given text for external links */
  label: string;
  /** Free text such as "affected", "implements", "ServiceNow ticket" */
  note: string;
  /** False when the target does not exist (any more) or the user may not see it */
  visible: boolean;
  /** Web UI path of the target */
  path: string | null;
  /** A living document: its current edition */
  edition?: string | null;
  createdAt: string;
  createdBy: string;
}

/**
 * A link from another item to this one: a record or service link, or a
 * credentials register entry that names the item under "used by" (linkId is
 * then "credential:<id>").
 */
export interface Backlink {
  linkId: string;
  kind: 'record' | 'service' | 'credential';
  id: string;
  label: string;
  note: string;
  path: string;
}

// ---------- records ----------

export interface RecordAttachment {
  id: string;
  /** file: part of the content; generated: a PDF Steward made; signed: a signed copy uploaded back; retired: a file of an earlier edition of a living document, no longer part of the content */
  kind: 'file' | 'generated' | 'signed' | 'retired';
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  /** generated: signers, language, record version; signed: derivedFrom + signatures found */
  details: RecordPdfDetails | SignedPdfDetails | null;
}

export interface RecordSigner {
  name: string;
  role: string;
  email?: string;
}

export interface RecordPdfDetails {
  lang: string;
  version: number;
  revision: number;
  status: string;
  contentHash: string;
  signers: RecordSigner[];
  /** Living documents: the PDF of this frozen edition */
  edition?: string;
}

export interface SignatureInfo {
  /** Signer name from the signature dictionary (/Name), when the signing tool wrote one */
  name: string | null;
  /** Signing time from /M (ISO 8601 when it could be parsed) */
  signedAt: string | null;
  reason: string | null;
  location: string | null;
  subFilter: string | null;
  /** Signature field name (/T of the field), when found */
  field: string | null;
  /** The byte range covers the whole file up to this signature's revision except the /Contents placeholder */
  byteRangeOk: boolean;
}

export interface SignedPdfDetails {
  derivedFrom: string;
  derivedFromFilename: string;
  originalSha256: string;
  originalSize: number;
  signatures: SignatureInfo[];
  /** Always "structure": signatures are not cryptographically validated */
  validation: 'structure' | 'none';
  plain?: boolean;
}

export interface RecordEvent {
  id: string;
  kind: 'created' | 'transition' | 'comment' | 'revision' | 'imported';
  action: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  comment: string;
  contentHash: string | null;
  version: number | null;
  revision: number;
  createdAt: string;
}

export interface RecordVersion {
  version: number;
  revision: number;
  title: string;
  body: string;
  fields: Record<string, string>;
  hash: string;
  author: string;
  comment: string;
  createdAt: string;
  /** Field definitions as they were when this version was frozen (null: not frozen, or frozen before snapshots existed) */
  fieldDefs: RecordFieldDef[] | null;
}

export interface RecordSummary {
  id: string;
  number: string;
  typeId: string;
  typeKey: string;
  typeName: string;
  workflow: RecordWorkflowKey;
  title: string;
  status: string;
  tags: string[];
  owner: string;
  revision: number;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** Living documents: the current edition, the review status and the next review */
  edition?: string | null;
  reviewStatus?: ReviewStatus | null;
  nextReviewAt?: string | null;
}

export interface RecordActionInfo {
  action: string;
  to: string;
  allowed: boolean;
  /** Why it is not allowed (English) … */
  reason?: string;
  /** … and as a code the web UI translates (errors:codes.<code>, e.g. FOUR_EYES_AUTHOR) */
  reasonCode?: string;
  approval: boolean;
  commentRequired: boolean;
  needsRecord: boolean;
  /** A replacing record may be named */
  optionalRecord: boolean;
  /** Submitting a living document: say whether the edition is minor or major and summarise the change */
  needsEdition: boolean;
}

export interface RecordPermissions {
  edit: boolean;
  comment: boolean;
  revise: boolean;
  attach: boolean;
  link: boolean;
  generatePdf: boolean;
  uploadSigned: boolean;
  /** Admins may attach a PDF that is not derived from a generated one as a plain attachment */
  attachPlainPdf: boolean;
}

export interface RecordDetail extends RecordSummary {
  body: string;
  fields: Record<string, string>;
  /** Definitions to show `fields` with: frozen content uses those of the moment it was frozen */
  fieldDefs: RecordFieldDef[];
  /** SHA-256 of the current content (title, body, fields, attachment hashes) */
  contentHash: string;
  /** Hash recorded when the content was frozen (left the draft status); null while editable */
  frozenHash: string | null;
  frozen: boolean;
  /** Frozen content that does not match the hash of the authentic audit entry that froze it (changed outside Steward) */
  tampered: boolean;
  submittedBy: string | null;
  submittedAt: string | null;
  /**
   * The record that superseded (decisions) or replaced (documents) this one; like links to hidden items, a
   * record the reader may not read is named only as not visible (no id, number or title).
   */
  supersededBy: { visible: boolean; id: string | null; number: string | null; title: string | null } | null;
  importMeta: Record<string, unknown> | null;
  type: RecordType;
  actions: RecordActionInfo[];
  permissions: RecordPermissions;
  attachments: RecordAttachment[];
  links: ItemLink[];
  backlinks: Backlink[];
  events: RecordEvent[];
  /** Living documents (workflow "document"): editions, reviews and the review status; null for other records */
  document: DocumentInfo | null;
}

export interface RecordsMeta {
  canCreate: boolean;
  canManageTypes: boolean;
  canApprove: boolean;
  maxAttachmentBytes: number;
  maxImportFiles: number;
  maxImportBytes: number;
  attachmentExtensions: string[];
}

export interface RecordImportItem {
  filename: string;
  ok: boolean;
  /** Why the file cannot be imported (English) … */
  error?: string;
  /** … as a code and parameters the web UI translates (errors:codes.<code>) */
  errorCode?: string;
  errorParams?: ErrorParams;
  title?: string;
  typeKey?: string;
  status?: string;
  /** Status in the file that could not be used (kept in the import metadata and as a tag) */
  originalStatus?: string | null;
  format?: 'madr' | 'nygard' | 'frontmatter' | 'markdown' | 'steward';
  fields?: Record<string, string>;
  tags?: string[];
  /** Notes about the import (English) … */
  warnings?: string[];
  /** … the same notes as codes and parameters (errors:codes.<code>), in the same order */
  warningCodes?: { code: string; params?: ErrorParams }[];
  /** Set when the record was created */
  record?: { id: string; number: string };
}

// ---------- service catalogue ----------

export const SERVICE_CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ServiceCriticality = (typeof SERVICE_CRITICALITIES)[number];

export const SERVICE_CONTACT_ROLES = ['business', 'it'] as const;
export type ServiceContactRole = (typeof SERVICE_CONTACT_ROLES)[number];

export interface ServiceContact {
  role: ServiceContactRole;
  email: string;
  name?: string;
}

export interface ServiceSummary {
  id: string;
  name: string;
  criticality: ServiceCriticality | null;
  contacts: ServiceContact[];
  /** Steward users and teams responsible (user:<name>, team:<name>) */
  owners: string[];
  tags: string[];
  cmdb: { system: string; id: string; url: string } | null;
  archived: boolean;
  linkCount: number;
  updatedAt: string;
}

export interface ServiceDetail extends ServiceSummary {
  description: string;
  createdAt: string;
  createdBy: string;
  updatedBy: string;
  links: ItemLink[];
  backlinks: Backlink[];
  canEdit: boolean;
}

export interface LinkTarget {
  kind: LinkKind;
  id: string;
  label: string;
  detail?: string;
}
