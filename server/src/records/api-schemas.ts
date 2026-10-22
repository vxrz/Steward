import { z, type ZodTypeAny } from 'zod';
import { RECORD_STATUSES, RECORD_WORKFLOW_KEYS } from '@sm/shared';

/** Response and query schemas of the record endpoints of the public API (/api/v1/records…). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const hash = (d: string) => z.string().regex(/^[0-9a-f]{64}$/).describe(d);
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
});

export const RecordAttachment = z.object({
  id: z.string(),
  kind: z.enum(['file', 'generated', 'signed']).describe('file: part of the content; generated: a PDF Steward made; signed: a signed copy of a generated PDF'),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int(),
  sha256: hash('SHA-256 of the file'),
  revision: z.number().int(),
  createdAt: ts(),
  createdBy: z.string(),
});

export const RecordLink = z.object({
  kind: z.string().nullable().describe('Internal item kind (process, run, monitor, platform, dashboard, record, service); null for an external URL'),
  targetId: z.string().nullable(),
  url: z.string().nullable().describe('External http(s) URL'),
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

export const RecordDetail = Record_.extend({
  body: z.string().describe('Markdown text'),
  fields: z.record(z.string()).describe('Structured fields of the record type'),
  contentHash: hash('SHA-256 of the current content (title, text, fields, attached files)'),
  frozenHash: hash('Content hash recorded when the record left the draft status').nullable(),
  frozen: z.boolean().describe('The content can no longer change (outside the draft status)'),
  submittedBy: z.string().nullable(),
  submittedAt: ts().nullable(),
  supersededBy: z.object({ id: z.string(), number: z.string(), title: z.string() }).nullable(),
  attachments: z.array(RecordAttachment),
  links: z.array(RecordLink),
  events: z.array(RecordEvent).describe('Transitions, approvals, revisions and comments, oldest first'),
});

export const RecordVersion = z.object({
  version: z.number().int(),
  revision: z.number().int(),
  title: z.string(),
  body: z.string(),
  fields: z.record(z.string()),
  hash: hash('SHA-256 of title, text and fields of this version'),
  author: z.string(),
  comment: z.string(),
  createdAt: ts(),
});

export const RECORD_COMPONENTS: Record<string, ZodTypeAny> = { Record: Record_, RecordDetail, RecordAttachment, RecordLink, RecordEvent, RecordVersion };

const limit = z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)');
const cursor = z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)');

export const RecordListQuery = z.object({
  limit,
  cursor,
  type: z.string().max(64).optional().describe('Record type key, e.g. CR or ADR'),
  status: z.array(z.string().max(40)).optional().describe('Only records with these statuses (repeat the parameter)'),
  tag: z.string().max(60).optional(),
  q: z.string().max(200).optional().describe('Case-insensitive search in number, title and text'),
});

export const RecordVersionsQuery = z.object({ limit, cursor });
