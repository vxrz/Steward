import { z, type ZodTypeAny } from 'zod';
import { TICKET_STATUSES, QUERY_LIST_MAX } from '@sm/shared';

/** Response and query schemas of the ticket reference endpoints of the public API (/api/v1/ticket-references…). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');

export const TicketReferenceEntry = z.object({
  id: z.string(),
  source: z.string().describe('Key of the ticket source, e.g. servicenow-incident or vendor'),
  sourceLabel: z.string(),
  vendorSource: z.boolean().describe('The source is a vendor source (tickets with the vendor of a platform or service)'),
  externalNumber: z.string().describe('Number of the ticket in the other system, e.g. INC0012345'),
  externalUrl: z.string().nullable().describe('http(s) link to the ticket in the other system'),
  title: z.string(),
  note: z.string().describe('Short note (Markdown)'),
  vendor: z.string(),
  responsible: z.array(z.string()).describe('Responsible people on our side: user:<name>, team:<name>'),
  status: z.enum(TICKET_STATUSES),
  openedAt: ts(),
  resolvedAt: ts().nullable(),
  lastCheckedAt: ts().nullable().describe('When somebody last checked the ticket in the other system (or changed its status)'),
  ageDays: z.number().int().describe('Whole days since it was opened (until it was resolved)'),
  affected: z
    .array(
      z.object({
        kind: z.string().describe('service, platform, credential, record, monitor or process'),
        targetId: z.string().nullable().describe('Id of the item – null when the token owner may not see it'),
        label: z.string(),
        visible: z.boolean(),
      }),
    )
    .describe('Affected Steward items'),
  createdAt: ts(),
  createdBy: z.string(),
  updatedAt: ts(),
  updatedBy: z.string(),
});

export const TicketReferenceDetail = TicketReferenceEntry.extend({
  history: z.array(
    z.object({
      ts: ts(),
      actor: z.string(),
      kind: z.enum(['created', 'updated', 'status', 'checked', 'reminded']),
      fromStatus: z.enum(TICKET_STATUSES).nullable(),
      toStatus: z.enum(TICKET_STATUSES).nullable(),
      comment: z.string(),
    }),
  ),
});

export const TICKET_COMPONENTS: Record<string, ZodTypeAny> = { TicketReferenceEntry, TicketReferenceDetail };

export const TicketListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  status: z.array(z.enum(TICKET_STATUSES)).max(QUERY_LIST_MAX).optional().describe('Only entries with these statuses (repeat the parameter)'),
  state: z.enum(['open', 'closed', 'all']).default('all').describe('open: open, waitingVendor, waitingUs; closed: resolved, closed'),
  source: z.array(z.string().max(40)).max(QUERY_LIST_MAX).optional().describe('Only these sources (repeat the parameter)'),
  vendor: z.string().max(120).optional().describe('Vendor (case-insensitive, exact)'),
  affected: z.string().max(240).optional().describe('Only entries that name this item as affected: kind:id, e.g. service:svc_123'),
  q: z.string().max(200).optional().describe('Case-insensitive search in number, title, vendor and note'),
});
