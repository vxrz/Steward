import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { HttpError } from '../util.js';
import { notFound } from '../api/v1/helpers.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { SupplierListQuery } from './api-schemas.js';
import { getSupplier, listSuppliers, serviceContracts, toPublic, toPublicContract } from './service.js';
import { moduleEnabled } from '../modules/registry.js';
import { commitments } from '../costs/commitments.js';

/**
 * Suppliers in the public, read-only API (0.17.0, ADR 0029): what the web app shows, with the rights of the token
 * owner – without the e-mail and phone of contacts. Writes stay in the app.
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

export function supplierApiRoutes(get: Get): void {
  get(
    '/suppliers',
    {
      operationId: 'listSuppliers',
      tag: 'Suppliers',
      summary: 'List suppliers',
      description:
        'The suppliers of SaaS, managed platforms, software and services (docs/SUPPLIERS.md), ordered by name, with their next notice-by date and certificate expiry, the derived criticality and how many items link them. Default: unconfirmed and active suppliers.',
      query: SupplierListQuery,
      paginated: true,
      response: {
        type: 'object',
        description: 'A page of suppliers',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'SupplierSummaryEntry#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof SupplierListQuery>;
      const list = listSuppliers({ status: q.status ?? ['unconfirmed', 'active'] });
      const page = pageArray(list, (x) => [x.name.toLowerCase(), x.id], q, { status: q.status });
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/suppliers/:supplierId',
    {
      operationId: 'getSupplier',
      tag: 'Suppliers',
      summary: 'Get a supplier with its contracts, certificates and links',
      description:
        'Contracts with term, notice-by date, renewal, SLA and contractual RTO/RPO, and (Costs module) their payment schedules with what they still owe – services the token owner may see; certificates with their validity; contacts with name and role only (no e-mail or phone); the items that link the supplier and its supplier review duties.',
      params: { supplierId: 'Supplier id (sup_…)' },
      response: { $ref: 'SupplierEntry#' },
    },
    async (req) => {
      const id = (req.params as { supplierId: string }).supplierId;
      try {
        const d = toPublic(getSupplier(id));
        if (!moduleEnabled('costs')) return d;
        // the payment schedules of each contract (ADR 0030): services the token owner may see, amounts by the module's rule
        const rows = commitments({ supplierId: id }).rows;
        return { ...d, contracts: d.contracts.map((c) => ({ ...c, paymentSchedules: rows.filter((r) => r.contract?.id === c.id) })) };
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Supplier ${id}`);
        throw e;
      }
    },
  );

  get(
    '/services/:serviceId/contracts',
    {
      operationId: 'listServiceContracts',
      tag: 'Suppliers',
      summary: 'List the supplier contracts covering a service',
      description:
        'The contracts covering the service that the token owner may see (0.18.0, docs/SUPPLIERS.md#contracts-and-the-services-they-cover): supplier, contract with term, notice-by date, SLA and contractual RTO/RPO, owners, the purpose for this service and whether it is confirmed or proposed; and the suppliers the service’s applications and systems link without a contract covering it.',
      params: { serviceId: 'Service id' },
      response: { $ref: 'ServiceContractsEntry#' },
    },
    async (req) => {
      const id = (req.params as { serviceId: string }).serviceId;
      try {
        const r = serviceContracts(id);
        return {
          serviceId: r.serviceId,
          contracts: r.contracts.map((x) => ({ supplier: x.supplier, contract: toPublicContract(x.contract), purpose: x.purpose, status: x.status })),
          uncovered: r.uncovered,
        };
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Service ${id}`);
        throw e;
      }
    },
  );
}
