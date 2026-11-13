import { z } from 'zod';
import {
  COST_CALCULATOR_LIMITS,
  COST_DRIVER_SUGGESTIONS,
  COST_ESTIMATE_LIMITS,
  COST_PRICE_BOOK_KINDS,
  COST_UNIT_SUGGESTIONS,
  DAYS_PER_MONTH,
  HOURS_PER_MONTH,
  costDryRunInput,
  parseUnit,
  unitsConvert,
} from '@sm/shared';
import { TokenBucketLimiter } from '../api/v1/rateLimit.js';
import { pageArray } from '../api/v1/pagination.js';
import { moduleEnabled } from '../modules/registry.js';
import { ToolError, cursorArg, defineTool, idArg, limitArg, type ToolDef } from '../mcp/tooling.js';
import { HttpError } from '../util.js';
import { entriesPage, getBook, listBooks, requireBook } from './price-books.js';
import { getCalculator, listCalculators } from './calculators.js';
import { allEstimates, getEstimate } from './estimates.js';
import { dryRun } from './pricing.js';
import { publicEstimate } from './price-api.js';

/**
 * Price books, calculators and estimates for AI assistants (0.21.0, ADR 0035 part 10, decisions 20 and 24): read tools
 * with the token owner's rights – contracted books only for who may read them, conditions never – and the dry run
 * `calculate_cost_estimate`, which prices up to five variants with the caller's books and stores nothing. Assistants
 * never save, accept or plan an estimate. The dry run is rate-limited per token (30 calculations a minute, each variant
 * counting as one) and logged like every MCP call.
 */

const off = () => {
  if (!moduleEnabled('costs')) throw new ToolError('The Costs module is switched off');
};
const visible = () => moduleEnabled('costs');
const asTool = <T>(what: string, fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 404) throw new ToolError(`${what} not found`);
    if (e instanceof HttpError && e.statusCode < 500) throw new ToolError(e.message);
    throw e;
  }
};

export const dryRunLimiter = new TokenBucketLimiter();

export const costPriceTools: ToolDef[] = [
  defineTool({
    name: 'list_price_books',
    title: 'List price books',
    description:
      'Price books you may see (Costs module, ADR 0035): versioned lists of items priced per unit of a driver – list books (published prices) and contracted books (the prices of a contract or platform, only for who may read them). Per book: provider, currency, kind, current version, item count, when it was last checked and whether its review is due.',
    input: z
      .object({
        provider: z.string().max(120).optional().describe('Only books of this provider (case-insensitive)'),
        kind: z.enum(COST_PRICE_BOOK_KINDS).optional(),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    visible,
    handler: (a) => {
      off();
      const p = a.provider?.trim().toLowerCase();
      const list = listBooks()
        .filter((b) => (!p || b.provider.toLowerCase() === p) && (!a.kind || b.kind === a.kind))
        .map((b) => ({
          id: b.id,
          name: b.name,
          kind: b.kind,
          provider: b.provider,
          currency: b.currency,
          platform: b.platform,
          version: b.version,
          entries: b.entries,
          checkedAt: b.checkedAt,
          reviewDue: b.reviewDue,
        }));
      return pageArray(list, (b) => [b.name.toLowerCase(), b.id], a, { provider: a.provider, kind: a.kind });
    },
  }),
  defineTool({
    name: 'get_price_book',
    title: 'Get a price book',
    description:
      'One price book you may see: its versions with what changed, and a page of the items of its current version – SKU, name, driver, unit (UCUM: GBy, h, GBy.mo, MBy/s, {request}; annotations in braces are counted things), charge (usage, recurring, one-off), price per block (1, 1000 or 1000000 units, up to 12 decimals) in a currency or in credits of another item, tiers, included quantity, minimum and validity.',
    input: z
      .object({
        bookId: idArg('Price book id (cpb_…, from list_price_books)'),
        query: z.string().max(200).optional().describe('Only items whose SKU, name, service or driver contains this text'),
        cursor: cursorArg,
        limit: limitArg(200, 50),
      })
      .strict(),
    visible,
    handler: (a) => {
      off();
      return asTool(`Price book ${a.bookId}`, () => {
        const b = getBook(a.bookId);
        const { row } = requireBook(a.bookId);
        const page = entriesPage(row, { cursor: a.cursor, limit: a.limit, q: a.query });
        return {
          id: b.id,
          name: b.name,
          kind: b.kind,
          provider: b.provider,
          currency: b.currency,
          version: b.version,
          checkedAt: b.checkedAt,
          reviewDue: b.reviewDue,
          versions: b.versions.slice(0, 20).map((v) => ({
            number: v.number,
            source: v.source,
            entries: v.entries,
            createdAt: v.createdAt,
            changes: v.diff ? { added: v.diff.added, removed: v.diff.removed, changed: v.diff.changed } : null,
          })),
          items: page.items,
          nextCursor: page.nextCursor,
        };
      });
    },
  }),
  defineTool({
    name: 'list_cost_calculators',
    title: 'List cost calculators',
    description:
      'Cost calculators (ADR 0035 part 5): templates of typed inputs whose formulas produce quantities of items (provider and SKU) – never money; Steward prices them with the books that apply. Per calculator: name, version, number of inputs and lines, the providers it names.',
    input: z.object({ cursor: cursorArg, limit: limitArg() }).strict(),
    visible,
    handler: (a) => {
      off();
      const list = listCalculators().map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        version: c.version,
        inputs: c.inputs,
        lines: c.lines,
        providers: c.providers,
        source: c.source,
      }));
      return pageArray(list, (c) => [c.name.toLowerCase(), c.id], a, {});
    },
  }),
  defineTool({
    name: 'get_cost_calculator',
    title: 'Get a cost calculator',
    description:
      'One cost calculator: its inputs (key, label, type number/integer/select/boolean/table, unit, default, bounds, options; numbers may be given as a range low/expected/high unless range is false), named values and lines (item provider and SKU, the quantity formula, unit, group), and its versions. Use the input keys with calculate_cost_estimate.',
    input: z.object({ calculatorId: idArg('Calculator id or its key (from list_cost_calculators)') }).strict(),
    visible,
    handler: (a) => {
      off();
      return asTool(`Calculator ${a.calculatorId}`, () => {
        const c = getCalculator(a.calculatorId);
        return {
          id: c.id,
          name: c.name,
          description: c.description,
          version: c.version,
          checked: c.checked,
          inputs: c.parsed?.inputs ?? [],
          let: c.parsed?.let ?? [],
          lines: (c.parsed?.lines ?? []).map((l, i) => ({ key: l.key ?? `l${i + 1}`, ...l })),
          versions: c.versions.slice(0, 20),
        };
      });
    },
  }),
  defineTool({
    name: 'list_cost_units',
    title: 'List cost drivers and units',
    description:
      'The suggested drivers (what is counted) with their units and which units convert into each other (UCUM codes; only within one dimension – bytes with SI and binary prefixes kept apart, time with 730 hours per month; annotations such as {msg} and {request} never convert). Any other driver and unit may be used.',
    input: z.object({}).strict(),
    visible,
    handler: () => {
      off();
      const units = [...COST_UNIT_SUGGESTIONS];
      return {
        hoursPerMonth: HOURS_PER_MONTH,
        daysPerMonth: DAYS_PER_MONTH,
        drivers: COST_DRIVER_SUGGESTIONS.map((d) => ({ driver: d.key, unit: d.unit })),
        units: units.map((u) => ({
          unit: u,
          dimensions: Object.fromEntries([...(parseUnit(u)?.dims ?? new Map())]),
          convertsTo: units.filter((v) => v !== u && unitsConvert(u, v)),
        })),
      };
    },
  }),
  defineTool({
    name: 'list_cost_estimates',
    title: 'List cost estimates',
    description:
      'Estimates of services and platforms you may see (ADR 0035 part 6): per month (usage and recurring) and one-off, low/expected/high where inputs are ranges, in the estimate’s currency – null where you may not see amounts; whether it carries ad-hoc adjustments, whether some lines are at list price (rates you may not see) and whether new prices wait to be accepted. Estimates, not quotes.',
    input: z
      .object({
        serviceId: z.string().max(100).optional().describe('Only this service'),
        platformId: z.string().max(100).optional().describe('Only this platform'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    visible,
    handler: (a) => {
      off();
      const list = asTool(a.serviceId ? `Service ${a.serviceId}` : `Platform ${a.platformId}`, () =>
        allEstimates({ serviceId: a.serviceId, platformId: a.platformId }),
      );
      return pageArray(list, (e) => [e.title.toLowerCase(), e.id], a, { serviceId: a.serviceId, platformId: a.platformId });
    },
  }),
  defineTool({
    name: 'get_cost_estimate',
    title: 'Get a cost estimate',
    description:
      'One estimate: inputs, calculator version, and per line the quantity and unit, the book and version that priced it, the unit price, the exchange rate where converted, an ad-hoc adjustment with its reason and the amount (low, expected, high); totals; the 36 months ahead when a price changes. A line priced with rates you may not see is at list price (priceHidden).',
    input: z.object({ estimateId: idArg('Estimate id (cest_…, from list_cost_estimates)') }).strict(),
    visible,
    handler: (a) => {
      off();
      return asTool(`Estimate ${a.estimateId}`, () => publicEstimate(getEstimate(a.estimateId)));
    },
  }),
  defineTool({
    name: 'calculate_cost_estimate',
    title: 'Calculate a cost estimate (dry run)',
    description: `A dry run with your books and rights that stores nothing: up to ${COST_ESTIMATE_LIMITS.variants} variants (two architectures, one warehouse size against another, a list book against a contracted one), each a calculator with inputs (values, or ranges {low, expected, high} for numbers) and/or lines by hand (provider, SKU, quantity, unit), an optional currency, book per provider and ad-hoc adjustments (a percentage −90…+500 or a fixed unit price for a line, each with a reason). Answers per variant the lines and totals (low, expected, high – a span of the inputs, not a probability) and how each price was found, and a comparison: each variant against the first per month and one-off, the cheapest per scenario, the lines that make the difference. ${COST_ESTIMATE_LIMITS.dryRunsPerMinute} calculations a minute per token (each variant counts); at most ${COST_CALCULATOR_LIMITS.timeoutMs} ms per calculation.`,
    input: costDryRunInput.extend({
      compareWith: z
        .object({
          dataProductId: z.string().trim().min(1).max(200).describe('A data product (id or key) whose attributed costs to set beside the variants'),
          environment: z.string().trim().max(60).optional().describe('Its environment (default: production first)'),
          months: z.number().int().min(1).max(12).default(3).describe('Complete months to average'),
        })
        .strict()
        .optional()
        .describe('Data products module: compare the variants with what a similar product costs (its attributed costs and estimates)'),
    }),
    visible,
    handler: async ({ compareWith, ...a }, ctx) => {
      off();
      if (a.variants.some((v) => v.definition !== undefined))
        throw new ToolError('A calculator definition is tried in the editor of the app; name a calculator (calculatorId) or give lines by hand');
      const n = a.variants.length;
      for (let i = 0; i < n; i++) {
        const r = dryRunLimiter.take(`dry:${ctx.principal.tokenId}`, COST_ESTIMATE_LIMITS.dryRunsPerMinute);
        if (!r.allowed) throw new ToolError(`Rate limit of ${r.limit} calculations a minute reached – retry after ${r.retryAfterSeconds} s`);
      }
      try {
        const result = await dryRun(a);
        if (!compareWith) return result;
        if (!moduleEnabled('dataProducts')) throw new ToolError('The data products module is switched off – compareWith needs it');
        const { productComparison } = await import('../dataproducts/estimates.js');
        const dataProduct = asTool(`Data product ${compareWith.dataProductId}`, () =>
          productComparison(
            compareWith.dataProductId,
            { environment: compareWith.environment, months: compareWith.months },
            result.variants.map((v) => ({ name: v.name, currency: v.result.currency, monthly: v.result.totals.monthly })),
          ),
        );
        return { ...result, dataProduct };
      } catch (e) {
        if (e instanceof ToolError) throw e;
        if (e instanceof HttpError && e.statusCode < 500) throw new ToolError(`${e.code ? `${e.code}: ` : ''}${e.message}`);
        throw e;
      }
    },
  }),
];
