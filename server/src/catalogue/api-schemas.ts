import { z, type ZodTypeAny } from 'zod';
import { APPLICATION_ROLES, CIA_COLORS, CIA_SCALE_MODES, REVIEW_STATUSES, SERVICE_CONTACT_ROLES, SERVICE_CRITICALITIES } from '@sm/shared';
import { RecordLink } from '../records/api-schemas.js';

/** Response and query schemas of the service catalogue endpoints of the public API (/api/v1/services…). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');

// ---------- CIA rating and protection need ----------

const CiaRatingEntry = z
  .object({
    level: z.string().describe('Key of a level of the dimension’s scale (default: normal, high, very_high)'),
    levelLabel: z.string().describe('Label of the level (English for the built-in levels)'),
    justification: z.string(),
    ratedAt: ts(),
    ratedBy: z.string(),
    needsRerating: z.boolean().describe('The scale changed and the level is no longer on it: the rating does not count until it is rated again'),
    previousLabel: z.string().nullable().describe('Set by a scale change: the label the level had before (mapped or flagged)'),
  })
  .nullable();

const CiaRating = z
  .object({ confidentiality: CiaRatingEntry, integrity: CiaRatingEntry, availability: CiaRatingEntry })
  .describe('CIA rating (protection need) per dimension; null: not rated');

const ProtectionNeedEntry = z.object({
  derived: z.string().nullable().describe('Highest level across the service’s applications that are not archived (maximum principle); null: none rated'),
  derivedLabel: z.string().nullable(),
  derivedFrom: z.array(z.string()).describe('Ids of the applications whose rating gave the derived level'),
  rated: z.number().int().describe('Applications (not archived) with a valid rating of this dimension'),
  total: z.number().int().describe('Applications of the service that are not archived'),
  needsRerating: z.number().int().describe('Applications whose rating needs re-rating after a scale change (not counted)'),
  override: z
    .object({
      level: z.string(),
      levelLabel: z.string(),
      reason: z.string().describe('Why the derived level does not apply, e.g. a cumulation or distribution effect'),
      setAt: ts(),
      setBy: z.string(),
      needsRerating: z.boolean(),
      previousLabel: z.string().nullable(),
    })
    .nullable(),
  effective: z.string().nullable().describe('The override when set (and valid), else the derived level'),
  effectiveLabel: z.string().nullable(),
});

const ProtectionNeed = z
  .object({ confidentiality: ProtectionNeedEntry, integrity: ProtectionNeedEntry, availability: ProtectionNeedEntry })
  .describe('Protection need per dimension: derived from the applications (maximum principle), override and effective level');

const ServiceApplicationRef = z.object({
  id: z.string(),
  name: z.string(),
  archived: z.boolean(),
  role: z.enum(APPLICATION_ROLES).nullable().describe('primary, dependency, or other (roleText says what)'),
  roleText: z.string(),
});

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
  applications: z.array(ServiceApplicationRef).describe('The applications the service consists of, with their role'),
  protectionNeed: ProtectionNeed,
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

const cmdb = z
  .object({ system: z.string(), id: z.string(), url: z.string().describe('http(s) link to the entry, or empty') })
  .nullable()
  .describe('The entry in the CMDB (e.g. ServiceNow); null when none is set');

export const ApplicationEntry = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().describe('Description (Markdown)'),
  vendor: z.string(),
  version: z.string(),
  url: z.string().describe('http(s) link to the application, or empty'),
  criticality: z.enum(SERVICE_CRITICALITIES).nullable(),
  owners: z.array(z.string()).describe('Steward users and teams responsible for the application: user:<name>, team:<name>'),
  tags: z.array(z.string()),
  cmdb,
  archived: z.boolean(),
  services: z
    .array(ServiceApplicationRef)
    .describe('Services that consist of the application, with the application’s role in each (id and name of the service here)'),
  integrationCount: z.number().int().describe('Steward platforms mapped to the application (also those the token owner may not see)'),
  rating: CiaRating,
  documentCount: z.number().int().describe('Living documents that apply to the application and that the token owner may read'),
  overdueDocuments: z.number().int(),
  createdAt: ts(),
  createdBy: z.string(),
  updatedAt: ts(),
  updatedBy: z.string(),
});

export const ApplicationEntryDetail = ApplicationEntry.extend({
  integrations: z
    .array(
      z.object({
        visible: z.boolean().describe('false: a platform the token owner may not see (no id or name)'),
        platformId: z.string().nullable(),
        name: z.string(),
        kind: z.string().nullable(),
        environment: z.string().nullable(),
        mappedAt: ts(),
        mappedBy: z.string(),
      }),
    )
    .describe('Steward platforms mapped to the application; a platform belongs to at most one application'),
  links: z
    .array(RecordLink)
    .describe(
      'Links of the application: internal items and external URLs. Items the token owner may not see are listed with visible false, without id or name.',
    ),
});

export const ApplicationDocument = z.object({
  id: z.string(),
  number: z.string().describe('Record number, e.g. DOC-2026-0001'),
  title: z.string(),
  typeKey: z.string(),
  typeName: z.string(),
  status: z.string(),
  edition: z.string().nullable().describe('The edition valid now; null while there is no approved edition'),
  reviewStatus: z.enum(REVIEW_STATUSES),
  nextReviewAt: ts().nullable(),
  daysLeft: z.number().int().nullable(),
});

const CiaLevelEntry = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  color: z.enum(CIA_COLORS),
});

export const CiaScaleEntry = z.object({
  mode: z
    .enum(CIA_SCALE_MODES)
    .describe('default: the BSI protection needs (normal, high, very high); shared: one custom scale; perDimension: one per dimension'),
  levels: z
    .object({ confidentiality: z.array(CiaLevelEntry), integrity: z.array(CiaLevelEntry), availability: z.array(CiaLevelEntry) })
    .describe('Ordered levels of each dimension, lowest first (the maximum principle uses this order)'),
  updatedAt: ts().nullable(),
  updatedBy: z.string().nullable(),
});

export const SERVICE_COMPONENTS: Record<string, ZodTypeAny> = {
  ServiceEntry,
  ServiceEntryDetail,
  ApplicationEntry,
  ApplicationEntryDetail,
  ApplicationDocument,
  CiaScaleEntry,
};

export const ApplicationListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude').describe('Archived applications: left out (default), included, or only these'),
});

export const ApplicationDocumentsQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
});

export const ServiceListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude').describe('Archived services: left out (default), included, or only these'),
});
