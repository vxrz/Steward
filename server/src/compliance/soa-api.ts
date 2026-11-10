import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import {
  RESPONSIBILITY_AREAS,
  RESPONSIBILITY_PARTIES,
  SOA_PARTIES,
  SOA_STATUSES,
  SOA_VERSION_STATUSES,
  SUPPLIER_CERTIFICATE_KINDS,
  SUPPLIER_STATUSES,
  type ServiceResponsibilities,
  type Soa,
  type SoaEntry,
  type SoaSummary,
  type SoaVersionSummary,
} from '@sm/shared';
import { notFound } from '../api/v1/helpers.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { cursorArg, defineTool, idArg, limitArg, ToolError } from '../mcp/tooling.js';
import { moduleEnabled } from '../modules/registry.js';
import { HttpError } from '../util.js';
import { getSoa, listSoas } from './soa.js';
import { getResponsibilities } from './responsibilities.js';

/**
 * The statement of applicability and the responsibility matrix read through the public API
 * (/api/v1/statements-of-applicability, /api/v1/services/{serviceId}/responsibilities) and MCP
 * (get_statement_of_applicability, get_service_responsibilities), with the token owner's rights – read only: rows,
 * versions and approvals are decisions of people in the app (ADR 0029 decision 9).
 */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const SupplierRef = z.object({ id: z.string(), name: z.string(), status: z.enum(SUPPLIER_STATUSES) });
const PartyCounts = z.object(Object.fromEntries(RESPONSIBILITY_PARTIES.map((p) => [p, z.number().int()])) as Record<string, z.ZodNumber>);

const Counts = z
  .object({
    controls: z.number().int(),
    applicable: z.number().int(),
    notApplicable: z.number().int(),
    undecided: z.number().int(),
    implemented: z.number().int(),
    partly: z.number().int(),
    planned: z.number().int(),
    notStarted: z.number().int(),
    noStatus: z.number().int().describe('Applicable rows without an implementation status'),
    reviewDue: z.number().int().describe('Rows not reviewed for twelve months (or never)'),
    noEvidence: z.number().int().describe('Applicable, implemented rows with no mapped item and no evidence link'),
  })
  .describe('Counts of the rows');

export const SoaSummaryEntry = z.object({
  catalogueKey: z.string(),
  catalogueName: z.string(),
  scopeName: z.string(),
  scopeServiceIds: z.array(z.string()).describe('Services in scope; empty: every service'),
  fourEyes: z.boolean().describe('A second person approves a version (the statement’s switch)'),
  counts: Counts,
  latestApproved: z.object({ number: z.number().int(), decidedAt: ts(), decidedBy: z.string() }).nullable(),
  waiting: z.object({ number: z.number().int(), submittedAt: ts(), submittedBy: z.string() }).nullable().describe('A version waiting for approval'),
  changedSinceApproved: z.number().int().describe('Rows that differ from the latest approved version'),
  createdAt: ts(),
  updatedAt: ts(),
});

const Entry = z.object({
  controlId: z.string(),
  ref: z.string(),
  title: z.string(),
  applicable: z.boolean().nullable().describe('null: undecided'),
  justification: z.string(),
  status: z.enum(SOA_STATUSES).nullable(),
  howMet: z.string(),
  party: z.enum(SOA_PARTIES).nullable().describe('The responsible party a person chose'),
  supplier: SupplierRef.nullable(),
  centralName: z.string(),
  owner: z.string().nullable().describe('user:<name> or team:<name>'),
  reviewedAt: ts().nullable(),
  reviewedBy: z.string().nullable(),
  reviewDue: z.boolean(),
  grcRef: z.string(),
  grcUrl: z.string(),
  evidenceLinks: z.array(z.object({ title: z.string(), url: z.string() })),
  areas: z.array(z.enum(RESPONSIBILITY_AREAS)).describe('Responsibility areas whose controls include this one'),
  suggestion: z
    .object({
      counts: PartyCounts.describe('Services in scope per party'),
      undecided: z.number().int(),
      party: z.enum(SOA_PARTIES).nullable(),
      supplier: SupplierRef.nullable(),
      centralName: z.string(),
    })
    .nullable()
    .describe('Derived from the responsibility matrix of the services in scope; never stored in the row'),
  evidence: z.object({
    status: z.enum(['covered', 'gap', 'unmapped', 'notVisible']).describe('Coverage of the last twelve months, as on the Controls page'),
    mapped: z.number().int(),
    items: z.number().int(),
    hidden: z.number().int(),
  }),
  noEvidence: z.boolean(),
  findings: z.object({ open: z.number().int(), total: z.number().int() }).describe('Corrective action findings naming the control'),
  decided: z.boolean(),
  changed: z.boolean().describe('Differs from the latest approved version'),
  updatedAt: ts().nullable(),
  updatedBy: z.string().nullable(),
});

const Version = z.object({
  number: z.number().int(),
  status: z.enum(SOA_VERSION_STATUSES),
  contentSha256: z.string().describe('SHA-256 of the frozen content (soa.json of the signed export)'),
  submittedAt: ts(),
  submittedBy: z.string(),
  decidedAt: ts().nullable(),
  decidedBy: z.string().nullable(),
  comment: z.string(),
  pdfSha256: z.string().nullable(),
  counts: Counts,
});

export const SoaDetailEntry = SoaSummaryEntry.extend({
  catalogueVersion: z.string(),
  servicesInScope: z.number().int(),
  entries: z.array(Entry),
  versions: z.array(Version),
});

const Contract = z.object({
  id: z.string(),
  title: z.string(),
  reference: z.string(),
  termEnd: z.string().nullable(),
  noticeBy: z.string().nullable(),
  slaAvailability: z.number().nullable(),
  slaSupportHours: z.string(),
  slaResponse: z.string(),
  rtoHours: z.number().nullable(),
  rpoHours: z.number().nullable(),
});

export const ServiceResponsibilitiesEntry = z.object({
  serviceId: z.string(),
  serviceName: z.string(),
  undecided: z.number().int(),
  rows: z.array(
    z.object({
      area: z.enum(RESPONSIBILITY_AREAS),
      party: z.enum(RESPONSIBILITY_PARTIES).nullable().describe('null: undecided'),
      supplier: SupplierRef.nullable(),
      contract: Contract.nullable().describe('The contract’s SLA and contractual RTO/RPO, read from the supplier record'),
      certificates: z.array(z.object({ kind: z.enum(SUPPLIER_CERTIFICATE_KINDS), name: z.string(), validUntil: z.string().nullable() })),
      centralName: z.string(),
      note: z.string(),
      duty: z.object({ id: z.string(), name: z.string() }).nullable().describe('The recovery-test duty'),
      recoveryTest: z.enum(['notNeeded', 'linked', 'missing']),
      controls: z.array(z.object({ catalogueKey: z.string(), controlId: z.string(), ref: z.string(), title: z.string() })),
      updatedAt: ts().nullable(),
      updatedBy: z.string().nullable(),
    }),
  ),
});

export const SOA_COMPONENTS: Record<string, ZodTypeAny> = { SoaSummaryEntry, SoaDetailEntry, ServiceResponsibilitiesEntry };

export const SoaListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
});

const summary = (s: SoaSummary) => ({
  catalogueKey: s.catalogueKey,
  catalogueName: s.catalogueName,
  scopeName: s.scopeName,
  scopeServiceIds: s.scopeServiceIds,
  fourEyes: s.fourEyes,
  counts: s.counts,
  latestApproved: s.latestApproved,
  waiting: s.waiting,
  changedSinceApproved: s.changedSinceApproved,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const entry = (e: SoaEntry) => {
  const { description: _d, canEdit: _e, canEditOwn: _o, supplierHidden: _h, evidence, ...rest } = e;
  return { ...rest, evidence: { status: evidence.status, mapped: evidence.mapped, items: evidence.items, hidden: evidence.hidden } };
};
const version = ({ canExport: _x, ...v }: SoaVersionSummary) => v;

export const soaDetail = (s: Soa) => ({
  ...summary(s),
  catalogueVersion: s.catalogueVersion,
  servicesInScope: s.servicesInScope,
  entries: s.entries.map(entry),
  versions: s.versions.map(version),
});

export const responsibilitiesOut = (r: ServiceResponsibilities) => ({
  serviceId: r.serviceId,
  serviceName: r.serviceName,
  undecided: r.undecided,
  rows: r.rows.map(({ supplierHidden: _h, controls, ...x }) => ({ ...x, controls: controls.map(({ soa: _s, ...c }) => c) })),
});

type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

export function soaApiRoutes(get: Get): void {
  get(
    '/statements-of-applicability',
    {
      operationId: 'listStatementsOfApplicability',
      tag: 'Compliance',
      summary: 'List statements of applicability',
      description:
        'One statement of applicability (ISO/IEC 27001 clause 6.1.3 d, Compliance module, preview) per control catalogue: scope, counts of applicable, not applicable and undecided rows and of their implementation status, the latest approved version, a version waiting for approval and the rows changed since.',
      query: SoaListQuery,
      paginated: true,
      response: {
        type: 'object',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'SoaSummaryEntry#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof SoaListQuery>;
      const page = pageArray(listSoas().items.map(summary), (s) => [s.catalogueKey.toLowerCase()], q, {});
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/statements-of-applicability/:catalogueKey',
    {
      operationId: 'getStatementOfApplicability',
      tag: 'Compliance',
      summary: 'Get a statement of applicability with its rows and versions',
      description:
        'The current rows – applicable and why, implementation status, how it is met, the responsible party with the suggestion derived from the responsibility matrix of the services in scope, owner, last review, GRC reference, evidence links, the coverage of the last twelve months (as the token owner may see it) and open corrective action findings – and the versions with their SHA-256 and approval.',
      params: { catalogueKey: 'Catalogue key (e.g. ISO27001) or id' },
      response: { $ref: 'SoaDetailEntry#' },
    },
    async (req) => {
      const key = (req.params as { catalogueKey: string }).catalogueKey;
      try {
        return soaDetail(getSoa(key));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Statement of applicability ${key}`);
        throw e;
      }
    },
  );

  get(
    '/services/:serviceId/responsibilities',
    {
      operationId: 'getServiceResponsibilities',
      tag: 'Compliance',
      summary: 'Get the responsibility matrix of a service',
      description:
        'Who does backup, recovery and continuity, patching and vulnerabilities, access management, logging and monitoring, and security incidents for the service: our team, a supplier (with its contract’s SLA and contractual RTO/RPO and its valid certificates, read from the supplier record), central IT or group, shared or not applicable – the recovery-test duty where the team does recovery itself, and the default controls of each area.',
      params: { serviceId: 'Service id' },
      response: { $ref: 'ServiceResponsibilitiesEntry#' },
    },
    async (req) => {
      const id = (req.params as { serviceId: string }).serviceId;
      try {
        return responsibilitiesOut(getResponsibilities(id));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Service ${id}`);
        throw e;
      }
    },
  );
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** MCP: the SoA and the matrix, read with the token owner's rights (Compliance module). */
export const soaTools = [
  defineTool({
    name: 'get_statement_of_applicability',
    title: 'Get the statement of applicability',
    description:
      'The statement of applicability (ISO/IEC 27001 clause 6.1.3 d) of a control catalogue: per control whether it applies and why, the implementation status (implemented, partly, planned, notStarted), how it is met, the responsible party (team, supplier, central, shared) with the suggestion derived from the responsibility matrix, owner, last review, GRC reference, evidence coverage of the last twelve months and open corrective action findings, plus the versions with their approval. Without catalogueKey: the list of statements with their counts. Read only: people decide rows and approve versions in Steward.',
    input: z
      .object({
        catalogueKey: idArg('Catalogue key, e.g. ISO27001').optional(),
        onlyOpen: z.boolean().default(false).describe('Only rows that are undecided, without a status, not reviewed for a year or without evidence'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    visible: () => moduleEnabled('compliance'),
    handler: (a) => {
      if (!moduleEnabled('compliance')) throw new ToolError('The Compliance module is switched off');
      if (!a.catalogueKey) return { items: listSoas().items.map(summary) };
      let s: Soa;
      try {
        s = getSoa(a.catalogueKey);
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw new ToolError(`No statement of applicability for ${a.catalogueKey}`);
        throw e;
      }
      const rows = s.entries.map((e, i) => ({ i, e })).filter(({ e }) => !a.onlyOpen || !e.decided || e.reviewDue || e.noEvidence);
      const page = pageArray(rows, (x) => [x.i], a, { catalogueKey: a.catalogueKey, onlyOpen: a.onlyOpen });
      return {
        ...summary(s),
        servicesInScope: s.servicesInScope,
        versions: s.versions.map(version),
        entries: page.items.map(({ e }) => ({ ...entry(e), justification: short(e.justification, 1000), howMet: short(e.howMet, 1000) })),
        nextCursor: page.nextCursor,
      };
    },
  }),
  defineTool({
    name: 'get_service_responsibilities',
    title: 'Get the responsibility matrix of a service',
    description:
      'Who does each of six areas for a service – backup, recovery (and continuity), patching (and vulnerabilities), access (management), logging (and monitoring), incidents: team, supplier (with the contract’s SLA, contractual RTO/RPO in hours and the supplier’s valid certificates), central (IT or group, with its name), shared (with a note) or notApplicable; null is undecided. recoveryTest says whether a recovery-test duty is linked where the team does recovery itself.',
    input: z.object({ serviceId: idArg('Service id') }).strict(),
    visible: () => moduleEnabled('compliance'),
    handler: (a) => {
      if (!moduleEnabled('compliance')) throw new ToolError('The Compliance module is switched off');
      try {
        return responsibilitiesOut(getResponsibilities(a.serviceId));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw new ToolError(`Service ${a.serviceId} not found`);
        throw e;
      }
    },
  }),
];
