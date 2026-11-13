import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { HttpError } from '../util.js';
import { notFound } from '../api/v1/helpers.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import { CostEstimatesQuery, PriceBookItemsQuery, PriceBooksQuery } from './api-schemas.js';
import { allEstimates, getEstimate } from './estimates.js';
import { getBook, listBooks, requireBook, entriesPage } from './price-books.js';
import type { CostEstimate, CostPriceBook, CostPriceBookDetail } from '@sm/shared';

/**
 * Price books and estimates in the public, read-only API (0.21.0, ADR 0035 part 10): the books the token owner may see
 * (a contracted book only for the readers of its contract or platform amounts; conditions never), and the estimates of
 * the services and platforms they may see, amounts by the module's rule – a line priced with rates they may not see at
 * list price (priceHidden). Writes stay in the app.
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const publicBook = (b: CostPriceBook) => ({
  id: b.id,
  name: b.name,
  kind: b.kind,
  provider: b.provider,
  currency: b.currency,
  description: b.description,
  platform: b.platform,
  supplier: b.supplier,
  supplierContract: b.supplierContract,
  source: b.source,
  reviewDays: b.reviewDays,
  checkedAt: b.checkedAt,
  checkedBy: b.checkedBy,
  reviewDue: b.reviewDue,
  version: b.version,
  entries: b.entries,
  updatedAt: b.updatedAt,
  updatedBy: b.updatedBy,
});

const publicBookDetail = (b: CostPriceBookDetail) => ({
  ...publicBook(b),
  versions: b.versions.map((v) => ({
    number: v.number,
    source: v.source,
    entries: v.entries,
    note: v.note,
    sha256: v.sha256,
    changes: v.diff ? { added: v.diff.added, removed: v.diff.removed, changed: v.diff.changed, unchanged: v.diff.unchanged } : null,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
  })),
});

/** An estimate without the editing state of the app (book choices, lines and adjustments as typed – they are in the result). */
export const publicEstimate = (e: CostEstimate) => ({
  id: e.id,
  title: e.title,
  description: e.description,
  owner: e.owner,
  for: e.for,
  calculator: e.calculator,
  inputs: e.inputs,
  currency: e.currency,
  appliesFrom: e.appliesFrom,
  amountsVisible: e.amountsVisible,
  result: e.result,
  pending: e.pending,
  planLines: e.planLines,
  createdAt: e.createdAt,
  createdBy: e.createdBy,
  updatedAt: e.updatedAt,
  updatedBy: e.updatedBy,
});

const asNotFound = <T>(what: string, fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) throw notFound(what);
    throw e;
  }
};

export function priceApiRoutes(get: Get): void {
  get(
    '/price-books',
    {
      operationId: 'listPriceBooks',
      tag: 'Costs',
      summary: 'List price books',
      description:
        'Price books (ADR 0035, docs/PRICE-BOOKS.md): versioned lists of items priced per unit of a driver – list books (published prices, every reader of the Costs module) and contracted books (the prices of a contract or a platform: only for who sees that contract or the platform’s amounts). Contract conditions are never part of this API.',
      query: PriceBooksQuery,
      paginated: true,
      response: {
        type: 'object',
        required: ['items', 'nextCursor'],
        additionalProperties: false,
        properties: { items: { type: 'array', items: { $ref: 'PriceBook#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof PriceBooksQuery>;
      const provider = q.provider?.trim().toLowerCase();
      const rows = listBooks()
        .filter((b) => (!provider || b.provider.toLowerCase() === provider) && (!q.kind || b.kind === q.kind))
        .map(publicBook);
      const p = pageArray(rows, (b) => [b.name.toLowerCase(), b.id], q, { provider: q.provider, kind: q.kind });
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );
  get(
    '/price-books/:bookId',
    {
      operationId: 'getPriceBook',
      tag: 'Costs',
      summary: 'Get a price book',
      description:
        'One price book with its versions – each with how it came to be (by hand, CSV, the migration of the Snowflake fallback’s price) and what changed against the one before. The items of the current version: GET /price-books/{bookId}/items.',
      params: { bookId: 'The id of the price book' },
      response: { $ref: 'PriceBookDetail#' },
    },
    async (req) => {
      const p = req.params as { bookId: string };
      return asNotFound(`Price book ${p.bookId}`, () => publicBookDetail(getBook(p.bookId)));
    },
  );
  get(
    '/price-books/:bookId/items',
    {
      operationId: 'listPriceBookItems',
      tag: 'Costs',
      summary: 'List the items of a price book',
      description:
        'The items of the current version, by SKU: unit (UCUM), charge, price per block (up to 12 decimals) in a currency or in credits of another item, tiers, included quantity, minimum, validity and attributes.',
      params: { bookId: 'The id of the price book' },
      query: PriceBookItemsQuery,
      paginated: true,
      response: {
        type: 'object',
        required: ['items', 'nextCursor'],
        additionalProperties: false,
        properties: { items: { type: 'array', items: { $ref: 'PriceBookItem#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const p = req.params as { bookId: string };
      const q = req.query as z.infer<typeof PriceBookItemsQuery>;
      const { row } = asNotFound(`Price book ${p.bookId}`, () => requireBook(p.bookId));
      const page = entriesPage(row, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );
  get(
    '/cost-estimates',
    {
      operationId: 'listCostEstimates',
      tag: 'Costs',
      summary: 'List cost estimates',
      description:
        'Estimates of services and platforms the token owner may see (ADR 0035, docs/COSTS.md#estimates): per month (usage and recurring) and one-off, low, expected and high where inputs are ranges, in the estimate’s currency; null where the token owner may not see amounts. Labelled estimates – not quotes.',
      query: CostEstimatesQuery,
      paginated: true,
      response: {
        type: 'object',
        required: ['items', 'nextCursor'],
        additionalProperties: false,
        properties: { items: { type: 'array', items: { $ref: 'CostEstimateSummary#' } }, nextCursor: { type: ['string', 'null'] } },
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof CostEstimatesQuery>;
      const rows = asNotFound(q.serviceId ? `Service ${q.serviceId}` : `Platform ${q.platformId}`, () =>
        allEstimates({ serviceId: q.serviceId, platformId: q.platformId }),
      );
      const p = pageArray(rows, (e) => [e.title.toLowerCase(), e.id], q, { serviceId: q.serviceId, platformId: q.platformId });
      linkNext(req, reply, p.nextCursor);
      return p;
    },
  );
  get(
    '/cost-estimates/:estimateId',
    {
      operationId: 'getCostEstimate',
      tag: 'Costs',
      summary: 'Get a cost estimate',
      description:
        'One estimate: its inputs, the calculator version, and the result Steward priced exactly – per line the quantity and unit, the book and version that priced it, the unit price, a manual exchange rate where converted, an ad-hoc adjustment with its reason, the amount (low, expected, high); totals; the 36 months ahead when a price changes within them; the plan lines made from it. A line priced with rates the token owner may not see is shown at list price (priceHidden).',
      params: { estimateId: 'The id of the estimate' },
      response: { $ref: 'CostEstimateDetail#' },
    },
    async (req) => {
      const p = req.params as { estimateId: string };
      return asNotFound(`Estimate ${p.estimateId}`, () => publicEstimate(getEstimate(p.estimateId)));
    },
  );
}
