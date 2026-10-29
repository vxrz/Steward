import { z, type ZodTypeAny } from 'zod';
import { EDITION_KINDS, RECORD_STATUSES, RECORD_WORKFLOW_KEYS, REVIEW_OUTCOMES, REVIEW_STATUSES, QUERY_LIST_MAX } from '@sm/shared';

/** Response and query schemas of the record endpoints of the public API (/api/v1/records…). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const hash = (d: string) =>
  z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe(d);
const status = () => z.string().describe(`Status in the record type's workflow: ${RECORD_STATUSES.join(', ')}`);

export const Record_ = z.object({
  id: z.string(),
  number: z.string().describe('Human-readable number PREFIX-YEAR-NNNN, e.g. CR-2026-0001'),
  typeKey: z.string().describe('Key (number prefix) of the record type, e.g. CR or ADR'),
  typeName: z.string(),
  workflow: z.enum(RECORD_WORKFLOW_KEYS),
  title: z.string(),
  status: status(),
  tags: z.array(z.string()),
  owner: z.string().describe('User name of the owner'),
  revision: z.number().int().describe('Increases with every "new revision" (back to draft for rework)'),
  version: z.number().int().describe('Increases with every saved change of title, text or fields'),
  createdAt: ts(),
  createdBy: z.string(),
  updatedAt: ts(),
  updatedBy: z.string(),
  edition: z
    .string()
    .nullable()
    .describe('Living documents (workflow "document"): the edition valid now, e.g. 1.1; null before the first approval and for other records'),
  reviewStatus: z
    .enum(REVIEW_STATUSES)
    .nullable()
    .describe('Living documents: periodic review status (current, dueSoon, overdue; none: no review planned); null for other records'),
  nextReviewAt: ts().nullable().describe('Living documents: when the next periodic review is due'),
});

export const RecordAttachment = z.object({
  id: z.string(),
  kind: z
    .enum(['file', 'generated', 'signed', 'retired'])
    .describe(
      'file: part of the content; generated: a PDF Steward made; signed: a signed copy of a generated PDF; retired: a file of an earlier edition of a living document',
    ),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int(),
  sha256: hash('SHA-256 of the file'),
  revision: z.number().int(),
  createdAt: ts(),
  createdBy: z.string(),
});

export const RecordLink = z.object({
  kind: z
    .string()
    .nullable()
    .describe('Internal item kind (process, run, monitor, platform, dashboard, record, service, credential, application); null for an external URL'),
  targetId: z.string().nullable().describe('Id of the internal item – null for an external URL and when the token owner may not see the item'),
  url: z.string().nullable().describe('External http(s) URL'),
  linkType: z
    .string()
    .nullable()
    .describe(
      'External links: key of the link type – built-in runbook, repository, monitoring, vendor-portal, documentation, ticket-system, other, or one an administrator added; null for internal links and external links without a type',
    ),
  linkTypeName: z.string().nullable().describe('Name of the link type (built-in types in English); null when the link has no type'),
  label: z.string().describe('Name of the target – empty when the token owner may not see it'),
  note: z.string(),
  visible: z.boolean(),
});

export const RecordEvent = z.object({
  kind: z.enum(['created', 'transition', 'comment', 'revision', 'imported']),
  action: z.string().nullable().describe('Workflow action of a transition, e.g. submit, approve, reject'),
  fromStatus: z.string().nullable(),
  toStatus: z.string().nullable(),
  actor: z.string(),
  comment: z.string(),
  contentHash: z.string().nullable().describe('Content hash at the time of the event'),
  version: z.number().int().nullable(),
  revision: z.number().int(),
  createdAt: ts(),
});

export const RecordEditionSummary = z.object({
  edition: z.string().describe('major.minor, e.g. 1.0, 1.1, 2.0'),
  kind: z.enum(EDITION_KINDS).describe('minor: editorial change; major: substantive change'),
  revision: z.number().int(),
  version: z.number().int().describe('The record version frozen as this edition (see /versions)'),
  title: z.string(),
  contentHash: hash('SHA-256 of the frozen content of this edition (title, text, fields, attached files)'),
  changeSummary: z.string().describe('What changed in this edition'),
  authors: z.array(z.string()).describe('Who wrote content of this edition'),
  submittedBy: z.string().nullable(),
  submittedAt: ts().nullable(),
  approvedBy: z.string(),
  approvedAt: ts(),
  current: z.boolean().describe('The edition valid now'),
  intact: z
    .boolean()
    .describe(
      'The stored content still has its hash, and the hash and the metadata (change summary, authors, submitter, approver, dates) are those in the authentic audit entry of the approval',
    ),
});

export const RecordEdition = RecordEditionSummary.extend({
  body: z.string().describe('Markdown text of the edition'),
  fields: z.record(z.string(), z.string()),
  attachments: z.array(z.object({ id: z.string(), filename: z.string(), size: z.number().int(), sha256: hash('SHA-256 of the file') })),
});

export const RecordReview = z.object({
  id: z.string(),
  outcome: z.enum(REVIEW_OUTCOMES).describe('no_change: the edition stays valid; needs_update: a new edition was started'),
  edition: z.string().nullable().describe('The edition that was reviewed'),
  reviewer: z.string(),
  comment: z.string(),
  createdAt: ts(),
  nextReviewAt: ts().nullable().describe('Next review planned after this one'),
  intact: z.boolean().describe('The stored review matches the authentic audit entry that recorded it (false: changed outside Steward)'),
});

export const DocumentReview = z.object({
  status: z.enum(REVIEW_STATUSES),
  intervalMonths: z.number().int().describe("Months between reviews (0: none): the document's own interval, else its type's"),
  owner: z.string().describe('Who reviews the document and is reminded (default: the owner)'),
  lastReviewedAt: ts().nullable(),
  lastReviewedBy: z.string().nullable(),
  nextReviewAt: ts().nullable(),
  daysLeft: z.number().int().nullable().describe('Whole days until the next review (negative when overdue)'),
  updateRequestedAt: ts().nullable().describe('A review found that the document needs an update; cleared when the next edition is approved'),
});

export const RecordDocument = z.object({
  currentEdition: z.string().nullable(),
  pending: z
    .object({ kind: z.enum(EDITION_KINDS), changeSummary: z.string(), edition: z.string() })
    .nullable()
    .describe('The edition in review: its kind, change summary and the number it will get'),
  review: DocumentReview,
});

export const RecordDetail = Record_.extend({
  body: z.string().describe('Markdown text'),
  fields: z.record(z.string(), z.string()).describe('Structured fields of the record type'),
  contentHash: hash('SHA-256 of the current content (title, text, fields, attached files)'),
  frozenHash: hash('Content hash recorded when the record left the draft status').nullable(),
  frozen: z.boolean().describe('The content can no longer change (outside the draft status)'),
  submittedBy: z.string().nullable(),
  submittedAt: ts().nullable(),
  supersededBy: z
    .object({
      visible: z.boolean().describe('false: the reader may not read the superseding record (id, number and title are null)'),
      id: z.string().nullable(),
      number: z.string().nullable(),
      title: z.string().nullable(),
    })
    .nullable()
    .describe('The record that superseded (decisions) or replaced (documents) this one'),
  attachments: z.array(RecordAttachment),
  links: z.array(RecordLink),
  events: z.array(RecordEvent).describe('Transitions, approvals, revisions and comments, oldest first'),
  document: RecordDocument.nullable().describe(
    'Living documents: current edition and review status (editions: /editions, reviews: /reviews); null for other records',
  ),
});

export const RecordVersion = z.object({
  version: z.number().int(),
  revision: z.number().int(),
  title: z.string(),
  body: z.string(),
  fields: z.record(z.string(), z.string()),
  hash: hash('SHA-256 of title, text and fields of this version'),
  author: z.string(),
  comment: z.string(),
  createdAt: ts(),
});

export const ServiceDocument = z.object({
  id: z.string(),
  number: z.string().describe('Record number, e.g. DOC-2026-0001'),
  title: z.string(),
  typeKey: z.string().describe('Key of the record type (a type with the workflow "document"), e.g. DOC'),
  typeName: z.string(),
  status: status(),
  edition: z.string().nullable().describe('The edition valid now, e.g. 1.1; null while there is no approved edition (a draft)'),
  reviewStatus: z.enum(REVIEW_STATUSES).describe('Periodic review status (current, dueSoon, overdue; none: no review planned)'),
  nextReviewAt: ts().nullable().describe('When the next periodic review is due'),
  daysLeft: z.number().int().nullable().describe('Whole days until the next review (negative when overdue)'),
  linkedFrom: z
    .array(z.enum(['record', 'service']))
    .describe('How the document and the service are linked: record – the document links to the service; service – the service links to the document'),
  applications: z
    .array(z.object({ id: z.string(), name: z.string(), archived: z.boolean() }))
    .describe('The applications the document applies to (its scope); empty: the whole service'),
});

export const RECORD_COMPONENTS: Record<string, ZodTypeAny> = {
  ServiceDocument,
  Record: Record_,
  RecordDetail,
  RecordAttachment,
  RecordLink,
  RecordEvent,
  RecordVersion,
  RecordEditionSummary,
  RecordEdition,
  RecordReview,
  RecordDocument,
};

const limit = z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)');
const cursor = z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)');

export const RecordListQuery = z.object({
  limit,
  cursor,
  type: z.string().max(64).optional().describe('Record type key, e.g. CR or ADR'),
  status: z.array(z.string().max(40)).max(QUERY_LIST_MAX).optional().describe('Only records with these statuses (repeat the parameter)'),
  tag: z.string().max(161).optional(),
  q: z.string().max(200).optional().describe('Case-insensitive search in number, title and text'),
  workflow: z.enum(RECORD_WORKFLOW_KEYS).optional().describe('Only records of types with this workflow, e.g. document'),
  reviewStatus: z.array(z.enum(REVIEW_STATUSES)).max(QUERY_LIST_MAX).optional().describe('Living documents: only these review statuses (repeat the parameter)'),
});

export const RecordVersionsQuery = z.object({ limit, cursor });
export const RecordEditionsQuery = z.object({ limit, cursor });
export const RecordReviewsQuery = z.object({ limit, cursor });
export const ServiceDocumentsQuery = z.object({ limit, cursor });
