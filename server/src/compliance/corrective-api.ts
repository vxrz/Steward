import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import {
  CA_EFFECTIVENESS_RESULTS,
  CA_SEVERITIES,
  CA_SOURCES,
  CA_STATUSES,
  QUERY_LIST_MAX,
  type CaFinding,
  type CaFindingSummary,
  type CaSeverity,
  type CaSource,
  type CaStatus,
} from '@sm/shared';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import { ProblemError } from '../api/v1/problem.js';
import type { Op } from '../api/v1/routes.js';
import { cursorArg, defineTool, idArg, limitArg, ToolError } from '../mcp/tooling.js';
import { moduleEnabled } from '../modules/registry.js';
import { HttpError } from '../util.js';
import { CaContext, getFinding, listFindingSummaries } from './corrective.js';

/**
 * The register of corrective actions read through the public API (/api/v1/corrective-actions) and MCP
 * (list_corrective_actions), with the token owner's rights – read only: findings are recorded, changed, checked and
 * suggestions decided by people in the app (ADR 0029 decision 9).
 */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const day = () => z.string().describe('Calendar date YYYY-MM-DD in the instance time zone');

const ControlRef = z.object({ id: z.string(), ref: z.string(), catalogueKey: z.string(), title: z.string() });

export const CorrectiveFinding = z.object({
  id: z.string(),
  number: z.string().describe('e.g. CA-2026-0001'),
  title: z.string(),
  source: z.enum(CA_SOURCES),
  severity: z.enum(CA_SEVERITIES).describe('major and minor: nonconformities; observation: an opportunity for improvement'),
  status: z.enum(CA_STATUSES).describe('open → inProgress → implemented → closed (the fix was checked and worked), or cancelled'),
  serviceId: z.string().nullable(),
  serviceName: z.string().nullable().describe('null when the token owner may not see the service'),
  supplierId: z.string().nullable().describe('The supplier the finding is about; null when there is none or the token owner may not see it'),
  supplierName: z.string().nullable(),
  owner: z.string().nullable().describe('User name of the finding’s owner'),
  dueDate: day().nullable(),
  overdue: z.boolean().describe('Open or in progress, and past its due date or with an action past its due date'),
  actionsOpen: z.number().int(),
  actionsTotal: z.number().int().describe('Its actions – for a finding of an incident review the review’s measures'),
  controls: z.array(ControlRef).describe('Affected controls'),
  createdAt: ts(),
  updatedAt: ts(),
  closedAt: ts().nullable(),
});

const Action = z.object({
  id: z.string(),
  title: z.string(),
  owners: z.array(z.string()).describe('user:<name>, team:<name>'),
  dueDate: day(),
  note: z.string(),
  doneAt: ts().nullable(),
  doneBy: z.string().nullable(),
  overdue: z.boolean(),
  measure: z.boolean().describe('A measure of the finding’s incident review (also in /api/v1/measures)'),
});

export const CorrectiveFindingDetail = CorrectiveFinding.extend({
  description: z.string(),
  cause: z.string(),
  sourceRef: z
    .object({ kind: z.string(), id: z.string().nullable(), label: z.string(), visible: z.boolean() })
    .nullable()
    .describe('What it came from: a duty, a record, a person review, an access check or a link (id null when the token owner may not see it)'),
  recordId: z.string().nullable().describe('The incident review whose measures are its actions'),
  grcRef: z.string().describe('Reference in the GRC tool, e.g. a risk id'),
  grcUrl: z.string(),
  effectiveness: z
    .object({ method: z.string(), result: z.enum(CA_EFFECTIVENESS_RESULTS), note: z.string(), checkedBy: z.string(), checkedAt: ts() })
    .nullable()
    .describe('The latest effectiveness check (by a second person)'),
  cancelReason: z.string(),
  actions: z.array(Action),
  createdBy: z.string(),
  updatedBy: z.string(),
  closedBy: z.string().nullable(),
});

export const CORRECTIVE_COMPONENTS: Record<string, ZodTypeAny> = { CorrectiveFinding, CorrectiveFindingDetail };

export const CorrectiveListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  status: z.array(z.enum(CA_STATUSES)).max(QUERY_LIST_MAX).optional().describe('Only these statuses (repeat the parameter)'),
  source: z.array(z.enum(CA_SOURCES)).max(QUERY_LIST_MAX).optional().describe('Only these sources (repeat the parameter)'),
  severity: z.array(z.enum(CA_SEVERITIES)).max(QUERY_LIST_MAX).optional().describe('Only these severities (repeat the parameter)'),
  serviceId: z.string().max(100).optional(),
  supplierId: z.string().max(100).optional().describe('Only the findings about this supplier'),
  overdue: z.boolean().optional().describe('true: only overdue findings, false: only those that are not'),
});

const summary = (f: CaFindingSummary) => ({
  id: f.id,
  number: f.number,
  title: f.title,
  source: f.source,
  severity: f.severity,
  status: f.status,
  serviceId: f.serviceName === null ? null : f.serviceId,
  serviceName: f.serviceName,
  supplierId: f.supplierName === null ? null : f.supplierId,
  supplierName: f.supplierName,
  owner: f.owner,
  dueDate: f.dueDate,
  overdue: f.overdue,
  actionsOpen: f.actionsOpen,
  actionsTotal: f.actionsTotal,
  controls: f.controls,
  createdAt: f.createdAt,
  updatedAt: f.updatedAt,
  closedAt: f.closedAt,
});

export const findingDetail = (f: CaFinding) => ({
  ...summary(f),
  description: f.description,
  cause: f.cause,
  sourceRef: f.sourceRef && { kind: f.sourceRef.kind, id: f.sourceRef.id, label: f.sourceRef.label, visible: f.sourceRef.visible },
  recordId: f.record?.visible ? f.record.id : null,
  grcRef: f.grcRef,
  grcUrl: f.grcUrl,
  effectiveness: f.effectiveness,
  cancelReason: f.cancelReason,
  actions: f.actions.map((a) => ({
    id: a.id,
    title: a.title,
    owners: a.owners,
    dueDate: a.dueDate,
    note: a.note,
    doneAt: a.doneAt,
    doneBy: a.doneBy,
    overdue: a.overdue,
    measure: a.measure,
  })),
  createdBy: f.createdBy,
  updatedBy: f.updatedBy,
  closedBy: f.closedBy,
});

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

export function correctiveApiRoutes(get: Get): void {
  get(
    '/corrective-actions',
    {
      operationId: 'listCorrectiveActions',
      tag: 'Compliance',
      summary: 'List corrective action findings',
      description:
        'The register of corrective actions (ISO/IEC 27001 clause 10.2, Compliance module, preview): nonconformities and observations from audits and from events Steward noticed, with their source, severity, status, service, owner, due date, actions and affected controls – newest first. Only findings the token owner may read: administrators, auditors, designers and approvers all, others those they or their actions own and those of services they may edit.',
      query: CorrectiveListQuery,
      paginated: true,
      response: {
        type: 'object',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'CorrectiveFinding#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof CorrectiveListQuery>;
      const list = listFindingSummaries({
        status: q.status,
        source: q.source,
        severity: q.severity,
        serviceId: q.serviceId,
        supplierId: q.supplierId,
        overdue: q.overdue,
      }).map(summary);
      const page = pageArray(list, (f) => [-Date.parse(f.createdAt), f.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/corrective-actions/:findingId',
    {
      operationId: 'getCorrectiveAction',
      tag: 'Compliance',
      summary: 'Get a corrective action finding with its actions and effectiveness check',
      params: { findingId: 'Finding id (caf_…) or number (CA-2026-0001)' },
      response: { $ref: 'CorrectiveFindingDetail#' },
    },
    async (req) => {
      try {
        return findingDetail(getFinding((req.params as { findingId: string }).findingId));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: 'Finding not found' });
        throw e;
      }
    },
  );
}

/** MCP: the register, read with the token owner's rights (Compliance module). */
export const correctiveTools = [
  defineTool({
    name: 'list_corrective_actions',
    title: 'List corrective actions',
    description:
      'The register of corrective actions (ISO/IEC 27001 clause 10.2): findings from audits and from events Steward noticed (missed duties, incident reviews, access reviews, reconciliation, supplier reviews), with source, severity (major, minor, observation), status (open, inProgress, implemented, closed, cancelled), service, supplier, owner, due date, open and total actions, affected controls. With findingId: that one finding with its description, cause, actions and effectiveness check. Read only: people record, change and check findings in Steward. Default: findings that are not closed or cancelled.',
    input: z
      .object({
        findingId: idArg('One finding (id or number, e.g. CA-2026-0001): its details').optional(),
        state: z.enum(['open', 'closed', 'all']).default('open').describe('open: open, inProgress, implemented; closed: closed, cancelled'),
        status: z.array(z.enum(CA_STATUSES)).max(5).optional().describe('Only these statuses (overrides state)'),
        source: z.array(z.enum(CA_SOURCES)).max(8).optional(),
        severity: z.array(z.enum(CA_SEVERITIES)).max(3).optional(),
        serviceId: z.string().max(100).optional(),
        supplierId: z.string().max(100).optional().describe('Only the findings about this supplier'),
        overdue: z.boolean().optional(),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    visible: () => moduleEnabled('compliance'),
    handler: (a) => {
      if (!moduleEnabled('compliance')) throw new ToolError('The Compliance module is switched off');
      if (a.findingId) {
        try {
          const f = findingDetail(getFinding(a.findingId));
          return { ...f, description: short(f.description, 4000), cause: short(f.cause, 2000) };
        } catch (e) {
          if (e instanceof HttpError && e.statusCode === 404) throw new ToolError(`Finding ${a.findingId} not found`);
          throw e;
        }
      }
      const list = listFindingSummaries(
        {
          state: a.state,
          status: a.status as CaStatus[] | undefined,
          source: a.source as CaSource[] | undefined,
          severity: a.severity as CaSeverity[] | undefined,
          serviceId: a.serviceId,
          supplierId: a.supplierId,
          overdue: a.overdue,
        },
        new CaContext(),
      ).map(summary);
      return pageArray(list, (f) => [-Date.parse(f.createdAt), f.id], a, {
        state: a.state,
        status: a.status,
        source: a.source,
        severity: a.severity,
        serviceId: a.serviceId,
        supplierId: a.supplierId,
        overdue: a.overdue,
      });
    },
  }),
];
