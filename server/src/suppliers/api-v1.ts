import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { HttpError } from '../util.js';
import { notFound } from '../api/v1/helpers.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { SupplierListQuery } from './api-schemas.js';
import { getSupplier, listSuppliers, toPublic } from './service.js';

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
        'Contracts with term, notice-by date, renewal, SLA and contractual RTO/RPO; certificates with their validity; contacts with name and role only (no e-mail or phone); the items that link the supplier and its supplier review duties.',
      params: { supplierId: 'Supplier id (sup_…)' },
      response: { $ref: 'SupplierEntry#' },
    },
    async (req) => {
      const id = (req.params as { supplierId: string }).supplierId;
      try {
        return toPublic(getSupplier(id));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Supplier ${id}`);
        throw e;
      }
    },
  );
}
