import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { COST_ESTIMATE_OWNER_KINDS, FISCAL_YEAR_MAX, FISCAL_YEAR_MIN } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { checkBook, createBook, getBook, getVersion, importBook, listBooks, previewImport, removeBook, saveEntries, updateBook } from './price-books.js';
import { createCalculator, exportCalculator, getCalculator, listCalculators, removeCalculator, saveCalculator, calculatorVersion } from './calculators.js';
import {
  acceptEstimate,
  confirmEstimateProposals,
  createEstimate,
  estimateProposals,
  getEstimate,
  listEstimates,
  recalculateEstimate,
  removeEstimate,
  updateEstimate,
  updateEstimateLines,
} from './estimates.js';
import { dryRun } from './pricing.js';
import { listRates, removeRate, setRate } from './fx.js';

/**
 * Price books, calculators and estimates (0.21.0, ADR 0035, docs/PRICE-BOOKS.md, docs/PRICE-BOOKS.md#estimates) in the
 * internal API. Rights are checked in the services; every write needs a signed-in session (ADR 0035 part 8: API tokens
 * and MCP read).
 *
 *   GET  /api/costs/price-books                              the books the caller may see
 *   POST /api/costs/price-books, GET|PUT|DELETE …/:bookId    a book (GET: a page of its items, `offset`, `q`)
 *   PUT  /api/costs/price-books/:bookId/entries              a new version by hand (merge or replace)
 *   GET  /api/costs/price-books/:bookId/versions/:n          a version with its difference to the one before
 *   POST /api/costs/price-books/:bookId/import/preview | …/import    a CSV file (nothing stored by the preview)
 *   POST /api/costs/price-books/:bookId/check                "Mark as checked"
 *   GET|POST /api/costs/calculators, GET|PUT|DELETE …/:calculatorId, GET …/export, GET …/versions/:n
 *   POST /api/costs/calculate                                the dry run: up to five variants, nothing stored
 *   GET  /api/costs/estimates?ownerKind=&ownerId=, POST /api/costs/estimates, GET|PUT|DELETE …/:estimateId
 *   POST /api/costs/estimates/:estimateId/recalculate | …/accept      new prices, "Accept new prices"
 *   GET|POST /api/costs/estimates/:estimateId/proposals      plan lines from the estimate (proposed, confirmed)
 *   POST /api/costs/estimates/:estimateId/update-lines        "Update lines"
 *   GET|PUT|DELETE /api/costs/fx-rates                        manual exchange rates (the costs managers)
 */

const session = { config: { access: ACCESS.session } };
const bookId = (req: FastifyRequest) => z.object({ bookId: z.string().min(1).max(100) }).parse(req.params).bookId;
const calculatorId = (req: FastifyRequest) => z.object({ calculatorId: z.string().min(1).max(100) }).parse(req.params).calculatorId;
const estimateId = (req: FastifyRequest) => z.object({ estimateId: z.string().min(1).max(100) }).parse(req.params).estimateId;
const versionN = (req: FastifyRequest) => z.object({ n: z.coerce.number().int().min(1).max(1_000_000) }).parse(req.params).n;
const bookQuery = z.object({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0), q: z.string().max(200).optional() });
const yearQuery = z.object({ fiscalYear: z.coerce.number().int().min(FISCAL_YEAR_MIN).max(FISCAL_YEAR_MAX).optional() });
const priceImport = { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.priceBookImport.bytes };

export async function priceRoutes(app: FastifyInstance): Promise<void> {
  // ---------- price books ----------
  app.get('/costs/price-books', async () => listBooks());
  app.post('/costs/price-books', session, async (req) => createBook(req.body));
  app.get('/costs/price-books/:bookId', async (req) => getBook(bookId(req), bookQuery.parse(req.query ?? {})));
  app.put('/costs/price-books/:bookId', session, async (req) => updateBook(bookId(req), req.body));
  app.delete('/costs/price-books/:bookId', session, async (req, reply) => {
    removeBook(bookId(req));
    return reply.code(204).send();
  });
  app.put('/costs/price-books/:bookId/entries', priceImport, async (req) => saveEntries(bookId(req), req.body));
  app.get('/costs/price-books/:bookId/versions/:n', async (req) => getVersion(bookId(req), versionN(req)));
  app.post('/costs/price-books/:bookId/import/preview', priceImport, async (req) => previewImport(bookId(req), req.body));
  app.post('/costs/price-books/:bookId/import', priceImport, async (req) => importBook(bookId(req), req.body));
  app.post('/costs/price-books/:bookId/check', session, async (req) => checkBook(bookId(req)));

  // ---------- calculators ----------
  app.get('/costs/calculators', async () => listCalculators());
  app.post('/costs/calculators', session, async (req) => createCalculator(req.body));
  app.get('/costs/calculators/:calculatorId', async (req) => getCalculator(calculatorId(req)));
  app.put('/costs/calculators/:calculatorId', session, async (req) => saveCalculator(calculatorId(req), req.body));
  app.delete('/costs/calculators/:calculatorId', session, async (req, reply) => {
    removeCalculator(calculatorId(req));
    return reply.code(204).send();
  });
  app.get('/costs/calculators/:calculatorId/export', async (req, reply) => {
    const out = exportCalculator(calculatorId(req));
    reply.header('content-disposition', `attachment; filename="${out.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    reply.header('cache-control', 'no-store');
    return reply.type('application/yaml; charset=utf-8').send(out.yaml);
  });
  app.get('/costs/calculators/:calculatorId/versions/:n', async (req) => {
    const v = calculatorVersion(calculatorId(req), versionN(req));
    return { number: v.number, definition: v.text, parsed: v.definition };
  });
  // the dry run: reads only, but a calculation costs – its own limit
  app.post('/costs/calculate', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => dryRun(req.body));

  // ---------- estimates ----------
  app.get('/costs/estimates', async (req) => {
    const q = z.object({ ownerKind: z.enum(COST_ESTIMATE_OWNER_KINDS), ownerId: z.string().min(1).max(100) }).parse(req.query ?? {});
    return listEstimates({ kind: q.ownerKind, id: q.ownerId });
  });
  const calc = { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.action } };
  app.post('/costs/estimates', calc, async (req) => createEstimate(req.body));
  app.get('/costs/estimates/:estimateId', async (req) => getEstimate(estimateId(req)));
  app.put('/costs/estimates/:estimateId', calc, async (req) => updateEstimate(estimateId(req), req.body));
  app.delete('/costs/estimates/:estimateId', session, async (req, reply) => {
    removeEstimate(estimateId(req));
    return reply.code(204).send();
  });
  app.post('/costs/estimates/:estimateId/recalculate', calc, async (req) => recalculateEstimate(estimateId(req)));
  app.post('/costs/estimates/:estimateId/accept', session, async (req) => acceptEstimate(estimateId(req)));
  app.get('/costs/estimates/:estimateId/proposals', async (req) => estimateProposals(estimateId(req), yearQuery.parse(req.query ?? {}).fiscalYear));
  app.post('/costs/estimates/:estimateId/proposals', session, async (req) => confirmEstimateProposals(estimateId(req), req.body));
  app.post('/costs/estimates/:estimateId/update-lines', session, async (req) => updateEstimateLines(estimateId(req), req.body));

  // ---------- exchange rates (estimates only) ----------
  app.get('/costs/fx-rates', async () => listRates());
  app.put('/costs/fx-rates', session, async (req) => setRate(req.body));
  app.delete('/costs/fx-rates', session, async (req, reply) => {
    removeRate(req.query ?? {});
    return reply.code(204).send();
  });
}
