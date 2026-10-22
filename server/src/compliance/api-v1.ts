import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AccessChange, AccessFinding, Control } from '@sm/shared';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { listAccessChanges } from './access-changes.js';
import { listFindings } from './reconciliation.js';
import { coverage, listCatalogues, listControls } from './controls.js';
import * as A from './api-schemas.js';

/** Compliance in the public, read-only API: access change entries, reconciliation findings, controls and their coverage. */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const ref = (name: keyof typeof A.COMPLIANCE_COMPONENTS & string) => ({ $ref: `${name}#` });
const pageOf = (name: keyof typeof A.COMPLIANCE_COMPONENTS & string, description: string) => ({
  type: 'object',
  description,
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', items: ref(name) },
    nextCursor: { type: ['string', 'null'], description: 'Opaque cursor for the next page; null on the last page.' },
  },
  additionalProperties: false,
});

const mapChange = (a: AccessChange) => a;
const mapFinding = ({ canDocument: _d, canDismiss: _x, ...f }: AccessFinding) => f;
const mapControl = (c: Control) => ({ ...c, tags: c.tags.map(({ path: _p, ...t }) => t) });

export function complianceApiRoutes(get: Get): void {
  get(
    '/access-changes',
    {
      operationId: 'listAccessChanges',
      tag: 'Compliance',
      summary: 'List access change entries',
      description:
        'Documented grants, revocations and changes of access rights (records of the type "Access change"), newest first. Includes entries created automatically by runs and entries documented after the fact.',
      query: A.AccessChangeListQuery,
      paginated: true,
      response: pageOf('AccessChange', 'A page of access change entries'),
    },
    async (req, reply) => {
      const q = req.query as {
        platformId?: string;
        subject?: string;
        status?: string[];
        kind?: string;
        from?: string;
        to?: string;
        cursor?: string;
        limit: number;
      };
      const list = listAccessChanges({
        platformId: q.platformId,
        subject: q.subject,
        status: q.status,
        kind: q.kind,
        from: q.from,
        to: q.to,
        limit: 10000,
      }).map(mapChange);
      const page = pageArray(list, (a) => [a.number, a.recordId], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/access-findings',
    {
      operationId: 'listAccessFindings',
      tag: 'Compliance',
      summary: 'List access reconciliation findings',
      description:
        'Access changes the reconciliation found without a matching access change entry (open), documented after the fact (documented) or dismissed with a reason. Only findings of checks the token owner may read.',
      query: A.AccessFindingListQuery,
      paginated: true,
      response: pageOf('AccessFinding', 'A page of findings'),
    },
    async (req, reply) => {
      const q = req.query as {
        checkId?: string;
        platformId?: string;
        status?: AccessFinding['status'];
        from?: string;
        to?: string;
        cursor?: string;
        limit: number;
      };
      const list = listFindings({ checkId: q.checkId, platformId: q.platformId, status: q.status, from: q.from, to: q.to }).map(mapFinding);
      const page = pageArray(list, (f) => [f.detectedAt, f.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/control-catalogues',
    {
      operationId: 'listControlCatalogues',
      tag: 'Compliance',
      summary: 'List control catalogues',
      description: 'Built-in (ISO/IEC 27001:2022 Annex A, IEC 62443-2-1, NIS2 Art. 21(2) – identifiers and short topic names) and imported catalogues.',
      response: { type: 'array', items: ref('ControlCatalogue') },
    },
    async () => listCatalogues(),
  );

  get(
    '/controls',
    {
      operationId: 'listControls',
      tag: 'Compliance',
      summary: 'List controls and the Steward items mapped to them',
      query: A.ControlListQuery,
      paginated: true,
      response: pageOf('Control', 'A page of controls'),
    },
    async (req, reply) => {
      const q = req.query as { catalogue?: string; cursor?: string; limit: number };
      const list = listControls(q.catalogue).map(mapControl);
      const page = pageArray(list, (c) => [c.catalogueKey, c.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/control-coverage',
    {
      operationId: 'listControlCoverage',
      tag: 'Compliance',
      summary: 'Evidence coverage of controls in a period',
      description:
        'Per control: covered (evidence in the period), gap (mapped items, but no evidence) or unmapped, with the number of evidence items per kind.',
      query: A.CoverageQuery,
      paginated: true,
      response: pageOf('ControlCoverage', 'A page of coverage entries'),
    },
    async (req, reply) => {
      const q = req.query as { catalogue?: string; from: string; to: string; cursor?: string; limit: number };
      const list = coverage({ from: q.from, to: q.to }, { catalogue: q.catalogue }).map((c) => ({
        controlId: c.control.id,
        catalogueKey: c.control.catalogueKey,
        ref: c.control.ref,
        title: c.control.title,
        status: c.status,
        counts: c.counts as Record<string, number>,
      }));
      const page = pageArray(list, (c) => [c.catalogueKey, c.controlId], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );
}
