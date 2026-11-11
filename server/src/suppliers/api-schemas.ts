import { z, type ZodTypeAny } from 'zod';
import {
  SUPPLIER_CERTIFICATE_KINDS,
  SUPPLIER_CONTACT_ROLES,
  SUPPLIER_CONTRACT_SERVICE_STATUSES,
  SUPPLIER_DPA_STATUSES,
  SUPPLIER_LINK_KINDS,
  SUPPLIER_RENEWALS,
  SUPPLIER_STATUSES,
  SUPPLIER_TYPES,
} from '@sm/shared';

/**
 * Suppliers in the public, read-only API (/api/v1/suppliers, ADR 0029). Contacts are listed without e-mail and phone:
 * they are personal data of people outside Steward and stay in the app (decided 8). The schema drives the
 * serialisation, so a field not declared here never leaves the server.
 */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const date = () => z.string().describe('Calendar date YYYY-MM-DD (the instance time zone)');
const dateState = z.enum(['ok', 'dueSoon', 'past', 'none']).describe('ok; dueSoon: within 90 days; past: the date has passed; none: no date');
const level = z.object({ level: z.string(), label: z.string() }).nullable();

const SupplierSummaryEntry = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(SUPPLIER_TYPES),
  status: z.enum(SUPPLIER_STATUSES).describe('unconfirmed: made from a free-text vendor on upgrade, waiting for confirmation; active; archived'),
  description: z.string(),
  website: z.string(),
  owners: z.array(z.string()).describe('Steward users and teams responsible: user:<name>, team:<name>'),
  aliases: z.array(z.string()).describe('Other spellings (free-text vendors it was made from or merged with, former names)'),
  personalData: z.boolean().describe('Whether the supplier processes personal data for the service'),
  dpaStatus: z.enum(SUPPLIER_DPA_STATUSES).nullable().describe('The data processing agreement: inPlace or missing (null: no personal data)'),
  dpaSince: date().nullable(),
  dpaLink: z.string().describe('The agreement: an http(s) URL or a record (id or number)'),
  criticality: z
    .object({ confidentiality: level, integrity: level, availability: level })
    .describe('Derived: the highest protection need of the linked applications per dimension'),
  contractCount: z.number().int(),
  certificateCount: z.number().int(),
  nextNoticeBy: date().nullable().describe('The earliest notice-by date ahead of its contracts (else the latest passed one)'),
  noticeState: dateState,
  nextCertificateExpiry: date().nullable(),
  certificateState: dateState,
  usage: z
    .object(Object.fromEntries(SUPPLIER_LINK_KINDS.map((k) => [k, z.number().int()])) as Record<string, z.ZodNumber>)
    .describe('Linked items the token owner may see, per kind'),
  updatedAt: ts(),
});

const SupplierContactEntry = z.object({ id: z.string(), name: z.string(), role: z.enum(SUPPLIER_CONTACT_ROLES), note: z.string() });

const SupplierContractEntry = z.object({
  id: z.string(),
  title: z.string(),
  reference: z.string().describe('The contract number'),
  startsOn: date().nullable(),
  endsOn: date().nullable(),
  noticeDays: z.number().int().nullable(),
  renewal: z.enum(SUPPLIER_RENEWALS),
  renewalMonths: z.number().int().nullable(),
  termEnd: date().nullable().describe('The end of the current term (an automatic renewal rolls on)'),
  noticeBy: date().nullable().describe('The last day to give notice: the term end minus the notice period'),
  noticeState: dateState,
  link: z.string(),
  slaAvailability: z.number().nullable().describe('Availability target in %'),
  slaSupportHours: z.string(),
  slaResponse: z.string(),
  rtoHours: z.number().nullable().describe('Contractual recovery time objective (hours)'),
  rpoHours: z.number().nullable().describe('Contractual recovery point objective (hours)'),
  note: z.string(),
  costPlanLines: z.array(z.object({ id: z.string(), serviceId: z.string(), serviceName: z.string(), fiscalYear: z.number().int(), title: z.string() })),
  owners: z.array(z.string()).describe('Who manages the contract (0.18.0, ADR 0031): user:<name>, team:<name>'),
  teamOwned: z.boolean().describe('A team is among its owners: seen only by its owners, the readers of the services it covers, administrators and auditors'),
  services: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        purpose: z.string(),
        status: z.enum(SUPPLIER_CONTRACT_SERVICE_STATUSES).describe('proposed: by the 0.18 upgrade, waiting for a person'),
      }),
    )
    .describe('The services it covers that the token owner may see (no count of others)'),
  paymentSchedules: z
    .array(z.object({}).passthrough())
    .optional()
    .describe('Costs module (0.18.0): the payment schedules of services the token owner may see, as GET /api/v1/cost-commitments rows'),
});

const SupplierCertificateEntry = z.object({
  id: z.string(),
  kind: z.enum(SUPPLIER_CERTIFICATE_KINDS),
  name: z.string(),
  scope: z.string(),
  issuer: z.string(),
  issuedOn: date().nullable().describe('Issued on; a SOC 2 report: the end of its period'),
  validUntil: date().nullable(),
  state: dateState,
  link: z.string(),
  checkedBy: z.string().nullable(),
  checkedAt: ts().nullable(),
});

const SupplierEntry = SupplierSummaryEntry.extend({
  contacts: z.array(SupplierContactEntry).describe('People at the supplier: name, role and note only (no e-mail or phone)'),
  contracts: z.array(SupplierContractEntry),
  certificates: z.array(SupplierCertificateEntry),
  usedBy: z.array(
    z.object({
      kind: z.enum(SUPPLIER_LINK_KINDS),
      id: z.string(),
      name: z.string(),
      path: z.string(),
      detail: z.string(),
      contract: z.object({ id: z.string(), title: z.string() }).nullable().optional().describe('The contract the item names (0.18.0)'),
      contractHidden: z.boolean().optional().describe('It names a contract the token owner may not see (0.18.0)'),
    }),
  ),
  duties: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      serviceId: z.string(),
      serviceName: z.string(),
      periods: z.array(z.object({ periodKey: z.string(), status: z.string(), dueAt: z.string() })),
    }),
  ),
  migratedFrom: z.array(z.object({ table: z.string(), spellings: z.array(z.string()) })),
  createdAt: ts(),
  createdBy: z.string(),
  updatedBy: z.string(),
});

/** The contracts covering a service (0.18.0, ADR 0031): GET /api/v1/services/{serviceId}/contracts. */
const ServiceContractEntry = z.object({
  supplier: z.object({ id: z.string(), name: z.string(), status: z.enum(SUPPLIER_STATUSES) }),
  contract: SupplierContractEntry.omit({ costPlanLines: true, paymentSchedules: true }),
  purpose: z.string().describe('What the contract covers for this service'),
  status: z.enum(SUPPLIER_CONTRACT_SERVICE_STATUSES),
});

const ServiceContractsEntry = z.object({
  serviceId: z.string(),
  contracts: z.array(ServiceContractEntry).describe('The contracts covering the service that the token owner may see'),
  uncovered: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.enum(SUPPLIER_STATUSES),
        via: z.array(z.object({ kind: z.enum(['application', 'system']), id: z.string(), name: z.string() })),
      }),
    )
    .describe('Suppliers its applications and systems link without a contract covering the service'),
});

export const SUPPLIER_COMPONENTS: Record<string, ZodTypeAny> = { SupplierSummaryEntry, SupplierEntry, ServiceContractsEntry };

export const SupplierListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  status: z.enum(SUPPLIER_STATUSES).optional().describe('Only suppliers with this status (default: unconfirmed and active)'),
});
