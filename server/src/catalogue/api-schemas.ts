import { z, type ZodTypeAny } from 'zod';
import { SERVICE_CONTACT_ROLES, SERVICE_CRITICALITIES } from '@sm/shared';
import { RecordLink } from '../records/api-schemas.js';

/** Response and query schemas of the service catalogue endpoints of the public API (/api/v1/services…). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');

export const ServiceEntry = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().describe('Description (Markdown)'),
  criticality: z.enum(SERVICE_CRITICALITIES).nullable(),
  contacts: z
    .array(
      z.object({
        role: z.enum(SERVICE_CONTACT_ROLES).describe('business: business owner; it: IT operations'),
        email: z.string(),
        name: z.string().nullable(),
      }),
    )
    .describe('People to contact (outside Steward)'),
  owners: z.array(z.string()).describe('Steward users and teams responsible for the service: user:<name>, team:<name>'),
  tags: z.array(z.string()),
  cmdb: z
    .object({ system: z.string(), id: z.string(), url: z.string().describe('http(s) link to the entry, or empty') })
    .nullable()
    .describe('The entry in the CMDB (e.g. ServiceNow); null when none is set'),
  archived: z.boolean(),
  linkCount: z.number().int().describe('Links the token owner may see: external links and links to items they may see'),
  documentCount: z.number().int().describe('Living documents linked to the service (either way) that the token owner may read'),
  overdueDocuments: z.number().int().describe('Of these, the documents whose periodic review is overdue'),
  createdAt: ts(),
  createdBy: z.string(),
  updatedAt: ts(),
  updatedBy: z.string(),
});

export const ServiceEntryDetail = ServiceEntry.extend({
  links: z
    .array(RecordLink)
    .describe('Links of the service: internal items and external URLs. Items the token owner may not see are listed with visible false, without id or name.'),
});

export const SERVICE_COMPONENTS: Record<string, ZodTypeAny> = { ServiceEntry, ServiceEntryDetail };

export const ServiceListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude').describe('Archived services: left out (default), included, or only these'),
});
