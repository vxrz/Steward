import { z, type ZodTypeAny } from 'zod';
import { ACCESS_CHANGE_KINDS, ACCESS_FINDING_STATUSES, CONTROL_TAG_KINDS, EVIDENCE_KINDS, QUERY_LIST_MAX } from '@sm/shared';

/** Response and query schemas of the compliance endpoints of the public API (/api/v1/access-changes, /access-findings, /controls …). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const rights = (d: string) => z.array(z.string()).describe(d);

export const AccessChange = z.object({
  recordId: z.string().describe('Id of the record that holds the entry'),
  number: z.string().describe('Record number, e.g. AC-2026-0001'),
  title: z.string(),
  status: z.string().describe('draft, documented (frozen), verified (checked by a second person) or cancelled'),
  platformId: z.string(),
  platformName: z.string().nullable().describe('null when the token owner may not see the platform'),
  subjectId: z.string().describe('User name, user id or technical user id on the platform'),
  subjectName: z.string(),
  subjectType: z.string().describe('user, technical or empty'),
  kind: z.string().describe(`Change: ${ACCESS_CHANGE_KINDS.join(', ')}`),
  rightsBefore: rights('Roles, groups or scopes before the change'),
  rightsAfter: rights('Roles, groups or scopes after the change'),
  granted: rights('rightsAfter − rightsBefore'),
  revoked: rights('rightsBefore − rightsAfter'),
  reason: z.string(),
  requestedBy: z.string(),
  requestRef: z.string().describe('Ticket number or link'),
  approvedBy: z.string(),
  performedBy: z.string(),
  performedAt: z.string().describe('When the change was made (ISO 8601)'),
  origin: z.string().describe('manual, run (created automatically by a run) or reconciliation (documented after the fact)'),
  afterTheFact: z.boolean().describe('Documented after the access reconciliation found the change'),
  runId: z.string().nullable(),
  findingId: z.string().nullable(),
  frozenHash: z.string().nullable().describe('Content hash recorded when the entry was documented'),
  tampered: z
    .boolean()
    .describe('The documented content no longer matches the authentic audit entry that froze it (changed outside Steward); it does not count'),
  documentedBy: z.string().nullable().describe('Who documented the current revision ("system" for entries of runs); null for drafts'),
  lastEditedBy: z.string().describe('Author of the newest version of the content'),
  createdAt: ts(),
  createdBy: z.string(),
  updatedAt: ts(),
});

export const AccessFinding = z.object({
  id: z.string(),
  checkId: z.string(),
  checkName: z.string(),
  platformId: z.string(),
  platformName: z.string().nullable(),
  snapshotId: z.string(),
  previousSnapshotId: z.string(),
  detectedAt: ts(),
  windowFrom: ts().describe('The change happened after this snapshot …'),
  windowTo: ts().describe('… and before this one'),
  subjectId: z.string(),
  subjectName: z.string(),
  kind: z.enum(ACCESS_CHANGE_KINDS),
  granted: rights('Rights granted without a matching access change entry'),
  revoked: rights('Rights removed without a matching access change entry'),
  rightsBefore: rights('All rights of the subject in the previous snapshot'),
  rightsAfter: rights('All rights of the subject in this snapshot'),
  status: z.enum(ACCESS_FINDING_STATUSES),
  recordId: z.string().nullable().describe('Access change entry that documents the change'),
  recordNumber: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: ts().nullable(),
  comment: z.string().describe('Why a dismissed finding needs no entry'),
  dismissRequestedBy: z.string().nullable().describe('Four-eyes dismissals: who asked to dismiss the open finding (a second person confirms)'),
  dismissRequestedAt: ts().nullable(),
});

export const ControlTag = z.object({
  kind: z.enum(CONTROL_TAG_KINDS),
  targetId: z.string().nullable().describe('Id of the item – null when the token owner may not see it'),
  label: z.string().describe('Name of the item – empty when the token owner may not see it'),
  visible: z.boolean(),
});

export const Control = z.object({
  id: z.string(),
  catalogueId: z.string(),
  catalogueKey: z.string().describe('e.g. ISO27001, IEC62443-2-1, NIS2'),
  ref: z.string().describe('Control identifier, e.g. 5.18'),
  title: z.string().describe('Short topic name (the standards’ own text is not shipped)'),
  description: z.string(),
  tags: z.array(ControlTag).describe('Steward items mapped to the control'),
});

export const ControlCatalogue = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  builtin: z.boolean(),
  controlCount: z.number().int(),
  createdAt: ts(),
  updatedAt: ts(),
});

export const ControlCoverage = z.object({
  controlId: z.string(),
  catalogueKey: z.string(),
  ref: z.string(),
  title: z.string(),
  status: z
    .enum(['covered', 'gap', 'unmapped', 'notVisible'])
    .describe(
      'covered: evidence in the period; gap: mapped, but no evidence; unmapped: no Steward item mapped; notVisible: there is evidence, but none the caller may see (since 0.3.0)',
    ),
  counts: z.record(z.string(), z.number().int()).describe(`Evidence items per kind (${EVIDENCE_KINDS.join(', ')}) the caller may see`),
  hidden: z.number().int().describe('Evidence items in the period the caller may not see (counted, not named; since 0.3.0)'),
});

export const COMPLIANCE_COMPONENTS: Record<string, ZodTypeAny> = { AccessChange, AccessFinding, Control, ControlTag, ControlCatalogue, ControlCoverage };

const limit = z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)');
const cursor = z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)');

export const AccessChangeListQuery = z.object({
  limit,
  cursor,
  platformId: z.string().max(100).optional(),
  subject: z.string().max(200).optional().describe('Part of the subject id or name (case-insensitive)'),
  status: z.array(z.string().max(40)).max(QUERY_LIST_MAX).optional().describe('Only these statuses (repeat the parameter)'),
  kind: z.enum(ACCESS_CHANGE_KINDS).optional(),
  from: z.string().datetime({ offset: true }).optional().describe('Performed at or after (ISO 8601)'),
  to: z.string().datetime({ offset: true }).optional().describe('Performed at or before (ISO 8601)'),
});

export const AccessFindingListQuery = z.object({
  limit,
  cursor,
  checkId: z.string().max(100).optional(),
  platformId: z.string().max(100).optional(),
  status: z.enum(ACCESS_FINDING_STATUSES).optional(),
  from: z.string().datetime({ offset: true }).optional().describe('Detected at or after'),
  to: z.string().datetime({ offset: true }).optional().describe('Detected at or before'),
});

export const ControlListQuery = z.object({
  limit,
  cursor,
  catalogue: z.string().max(60).optional().describe('Catalogue key or id'),
});

export const CoverageQuery = z.object({
  limit,
  cursor,
  catalogue: z.string().max(60).optional().describe('Catalogue key or id'),
  from: z.string().datetime({ offset: true }).describe('Start of the period'),
  to: z.string().datetime({ offset: true }).describe('End of the period'),
});
