import { z, type ZodTypeAny } from 'zod';
import { CREDENTIAL_BELONGS_KINDS, CREDENTIAL_DUE_KINDS, CREDENTIAL_STATUSES, CREDENTIAL_TYPES, QUERY_LIST_MAX } from '@sm/shared';

/** Response and query schemas of the credentials endpoints of the public API (/api/v1/credentials…). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');

const CertificateSummary = z.object({
  subject: z.string(),
  issuer: z.string(),
  serialNumber: z.string(),
  fingerprint256: z.string(),
  notBefore: ts(),
  notAfter: ts(),
});

export const CredentialEntry = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(CREDENTIAL_TYPES),
  belongsTo: z
    .object({
      kind: z.enum(CREDENTIAL_BELONGS_KINDS),
      id: z.string(),
      name: z.string().nullable().describe('null: it no longer exists'),
      applicationId: z.string().nullable().describe('A component: its application'),
      applicationName: z.string().nullable(),
    })
    .nullable()
    .describe('The application, component or system of the catalogue the entry belongs to'),
  platformId: z.string().nullable().describe('A Steward platform (null: see platformText)'),
  platformName: z.string().nullable(),
  platformText: z.string(),
  environment: z.string(),
  description: z.string(),
  usedBy: z.object({
    text: z.string(),
    links: z.array(
      z.object({ kind: z.string().describe('process, monitor, platform, service, application, …'), id: z.string(), label: z.string().nullable() }),
    ),
    urls: z
      .array(z.object({ label: z.string(), url: z.string().describe('http(s) address') }))
      .describe('External pages: Swagger page, vault entry, wiki page'),
  }),
  roles: z
    .array(
      z.object({
        role: z.string().describe('Role or permission, e.g. mdsp:core:TenantAdmin'),
        scope: z.string().describe('Where it applies, e.g. tenant modev; empty when not set'),
        grantedAt: ts().nullable(),
        note: z.string(),
      }),
    )
    .describe('Roles and permissions the credential holds (their changes: history event rolesChanged)'),
  owners: z.array(z.object({ email: z.string(), role: z.string() })).describe('Owner e-mail addresses with their role, e.g. Business owner'),
  ownerSubjects: z.array(z.string()).describe('Steward users and teams that own the entry (user:<name>, team:<name>)'),
  location: z
    .object({ text: z.string(), url: z.string().nullable() })
    .describe('Where the secret is kept (e.g. KeePass database and entry) – never the secret'),
  issuedAt: ts().nullable(),
  expiresAt: ts().nullable(),
  rotationIntervalDays: z.number().int().nullable(),
  lastRotatedAt: ts().nullable(),
  reviewIntervalDays: z.number().int().nullable(),
  lastReviewedAt: ts().nullable(),
  nextRotationAt: ts().nullable(),
  nextReviewAt: ts().nullable(),
  nextDueAt: ts().nullable().describe('Earliest of expiry, next rotation and next review'),
  status: z.enum(CREDENTIAL_STATUSES),
  dues: z.array(z.object({ kind: z.enum(CREDENTIAL_DUE_KINDS), dueAt: ts(), daysLeft: z.number().int(), status: z.enum(CREDENTIAL_STATUSES) })),
  certificate: CertificateSummary.extend({
    subjectAltNames: z.array(z.string()),
    isCA: z.boolean(),
    selfSigned: z.boolean(),
    chain: z.array(CertificateSummary),
    chainNotAfter: ts(),
  })
    .nullable()
    .describe('Metadata of the documented public certificate'),
  tags: z.array(z.string()),
  archived: z.boolean(),
  createdAt: ts(),
  createdBy: z.string(),
  updatedAt: ts(),
  updatedBy: z.string(),
});

export const CREDENTIAL_COMPONENTS: Record<string, ZodTypeAny> = { CredentialEntry };

export const CredentialListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  status: z.array(z.enum(CREDENTIAL_STATUSES)).max(QUERY_LIST_MAX).optional().describe('Only entries with these statuses (repeat the parameter)'),
  type: z.array(z.enum(CREDENTIAL_TYPES)).max(QUERY_LIST_MAX).optional(),
  platform: z.string().max(200).optional().describe('Platform id or name'),
  dueWithinDays: z.number().int().min(0).max(3650).optional().describe('Only entries with a due date within this many days (overdue ones included)'),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
  q: z.string().max(200).optional().describe('Case-insensitive search'),
  role: z.string().max(200).optional().describe('Only entries holding this role or permission (exact, case-insensitive)'),
  belongs: z
    .string()
    .max(120)
    .regex(/^(application|component|system):\S+$/)
    .optional()
    .describe('Only entries that belong to this item: application:<id>, component:<id> or system:<id>'),
});
