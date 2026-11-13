import { z } from 'zod';
import { isoCurrencyCode } from './costs.js';
import type { CostDerivedBreakdown, CostPriceFound } from './costConditions.js';
import { boundedRecord } from './zodLimits.js';
import { isMonth } from './costPlans.js';
import { COST_PRICE_LIMITS, parsePercent, parsePrice, parseQuantity, parseUnit, type CostPriceBookKind, type CostPriceCharge } from './costPrices.js';

/**
 * Calculators and estimates (0.21.0, ADR 0035 parts 5 and 6, docs/PRICE-BOOKS.md#estimates): a calculator is a template of
 * typed inputs, named intermediate values and lines that each name an item (provider and SKU) and a JSONata expression
 * for its quantity – never money. An estimate keeps its inputs (values or ranges low–expected–high), the calculator
 * version, lines by hand, ad-hoc adjustments and the result Steward priced exactly.
 */

export const COST_CALCULATOR_LIMITS = {
  calculators: 200,
  inputs: 50,
  lines: 100,
  lets: 50,
  expressionChars: 4000,
  definitionBytes: 64 * 1024,
  options: 50,
  tableColumns: 20,
  tableRows: 200,
  /** Per calculation */
  timeoutMs: 500,
  maxSequence: 10_000,
  resultLines: 200,
} as const;

export const COST_ESTIMATE_LIMITS = {
  perOwner: 200,
  lines: 200,
  adjustments: 50,
  variants: 5,
  resultsKept: 20,
  /** Months of the projection when prices change within them */
  horizonMonths: 36,
  /** Dry runs per minute and token (MCP) */
  dryRunsPerMinute: 30,
  reasonChars: 200,
} as const;

export const COST_CALCULATOR_INPUT_TYPES = ['number', 'integer', 'select', 'boolean', 'table'] as const;
export type CostCalculatorInputType = (typeof COST_CALCULATOR_INPUT_TYPES)[number];

/** Keys of inputs, values and lines: a letter, then letters, digits and _ (never __proto__ and friends). */
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
export const calculatorKey = z
  .string()
  .trim()
  .max(40)
  .refine((s) => KEY_RE.test(s) && !RESERVED.has(s), 'a key: a letter, then letters, digits and _');
const expression = z.string().trim().min(1).max(COST_CALCULATOR_LIMITS.expressionChars);
const label = z.string().trim().min(1).max(120);
const unitCode = z
  .string()
  .trim()
  .max(60)
  .refine((s) => parseUnit(s) !== null, 'a unit such as GBy, h, GBy.mo, MBy/s or {request}');

const tableColumn = z
  .object({
    key: calculatorKey,
    label,
    type: z.enum(['number', 'text']).default('number'),
    unit: unitCode.optional(),
    default: z.union([z.number(), z.string().max(200)]).optional(),
  })
  .strict();

export const costCalculatorInput = z
  .object({
    key: calculatorKey,
    label,
    type: z.enum(COST_CALCULATOR_INPUT_TYPES),
    unit: unitCode.optional(),
    help: z.string().trim().max(500).optional(),
    default: z.union([z.number(), z.boolean(), z.string().max(200)]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    options: z
      .array(z.union([z.string().trim().min(1).max(100), z.number()]))
      .max(COST_CALCULATOR_LIMITS.options)
      .optional(),
    /** number and integer: may be given as low, expected and high unless false (a count of clusters, say) */
    range: z.boolean().optional(),
    columns: z.array(tableColumn).max(COST_CALCULATOR_LIMITS.tableColumns).optional(),
    maxRows: z.number().int().min(1).max(COST_CALCULATOR_LIMITS.tableRows).optional(),
  })
  .strict()
  .superRefine((x, ctx) => {
    if (x.type === 'select' && !x.options?.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'a select input lists its options' });
    if (x.type === 'table' && !x.columns?.length) ctx.addIssue({ code: 'custom', path: ['columns'], message: 'a table input lists its columns' });
    if (x.min !== undefined && x.max !== undefined && x.max < x.min) ctx.addIssue({ code: 'custom', path: ['max'], message: 'not below min' });
  });
export type CostCalculatorInputDef = z.output<typeof costCalculatorInput>;

export const costCalculatorLine = z
  .object({
    /** Stable within the calculator (ad-hoc adjustments name it); default l1, l2, … by position */
    key: calculatorKey.optional(),
    label: z.string().trim().max(120).optional(),
    item: z
      .object({
        /** The provider, or a template with {{ expression }} (the generic calculator takes it from a table row) */
        provider: z.string().trim().min(1).max(COST_CALCULATOR_LIMITS.expressionChars),
        /** The SKU, or a template with {{ expression }} */
        sku: z.string().trim().min(1).max(COST_CALCULATOR_LIMITS.expressionChars),
        priceId: z.string().trim().max(COST_PRICE_LIMITS.skuChars).optional(),
      })
      .strict(),
    quantity: z.union([expression, z.number()]).transform((v) => String(v)),
    /** A unit, or a template with {{ expression }} checked when the line is calculated */
    unit: z
      .string()
      .trim()
      .min(1)
      .max(COST_CALCULATOR_LIMITS.expressionChars)
      .refine((s) => s.includes('{{') || parseUnit(s) !== null, 'a unit such as GBy, h, GBy.mo, MBy/s or {request}'),
    group: z.string().trim().max(80).optional(),
    /** One line per row of this table input (`row` holds the row) */
    each: calculatorKey.optional(),
    /** Only when this expression is true */
    when: expression.optional(),
  })
  .strict();
export type CostCalculatorLineDef = z.output<typeof costCalculatorLine>;

/** A calculator file (`kind: costCalculator`, YAML or JSON) – the format of Git sync and of the editor. */
export const costCalculatorDefinition = z
  .object({
    kind: z.literal('costCalculator'),
    id: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((s) => /^[a-z0-9][a-z0-9-]*$/.test(s), 'lower-case letters, digits and -'),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    /** Informational (Steward counts its own versions) */
    version: z.union([z.number(), z.string().max(40)]).optional(),
    /** When the technical factors of the file were last checked (YYYY-MM-DD) */
    checked: z.string().trim().max(40).optional(),
    inputs: z.array(costCalculatorInput).max(COST_CALCULATOR_LIMITS.inputs).default([]),
    /** Named intermediate values, evaluated in order (`let.name` in later expressions) */
    let: z
      .array(z.object({ key: calculatorKey, value: expression }).strict())
      .max(COST_CALCULATOR_LIMITS.lets)
      .default([]),
    lines: z.array(costCalculatorLine).min(1).max(COST_CALCULATOR_LIMITS.lines),
  })
  .strict()
  .superRefine((d, ctx) => {
    const once = (keys: string[], path: string) => {
      const seen = new Set<string>();
      keys.forEach((k, i) => {
        if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [path, i, 'key'], message: `${k} twice` });
        seen.add(k);
      });
    };
    once(
      d.inputs.map((i) => i.key),
      'inputs',
    );
    once(
      d.let.map((i) => i.key),
      'let',
    );
    once(
      d.lines.map((l, i) => l.key ?? `l${i + 1}`),
      'lines',
    );
    const tables = new Set(d.inputs.filter((i) => i.type === 'table').map((i) => i.key));
    d.lines.forEach((l, i) => {
      if (l.each && !tables.has(l.each)) ctx.addIssue({ code: 'custom', path: ['lines', i, 'each'], message: `${l.each} is not a table input` });
    });
  });
export type CostCalculatorDefinition = z.output<typeof costCalculatorDefinition>;

/**
 * The `let` of a file may be written as a map (`hours: inputs.minutes / 60`) – read into the list form in its order,
 * with every key checked (no prototype keys).
 */
export function normaliseCalculatorFile(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  const lets = o.let;
  if (lets && typeof lets === 'object' && !Array.isArray(lets))
    return {
      ...o,
      let: Object.entries(lets as Record<string, unknown>).map(([key, value]) => ({ key, value: typeof value === 'number' ? String(value) : value })),
    };
  return raw;
}

// ---------- estimates ----------

export const COST_ESTIMATE_OWNER_KINDS = ['service', 'platform'] as const;
export type CostEstimateOwnerKind = (typeof COST_ESTIMATE_OWNER_KINDS)[number];

/** A number or a range: low ≤ expected ≤ high (COST_RANGE_ORDER). */
export const costRangeValue = z.union([
  z.number(),
  // the order (low ≤ expected ≤ high) is checked with the calculation: COST_RANGE_ORDER
  z.object({ low: z.number(), expected: z.number(), high: z.number() }).strict(),
]);
export type CostRangeValue = z.infer<typeof costRangeValue>;

const inputValue = z.union([
  costRangeValue,
  z.boolean(),
  z.string().max(200),
  z.array(boundedRecord(z.union([z.number(), z.string().max(200)]), COST_CALCULATOR_LIMITS.tableColumns)).max(COST_CALCULATOR_LIMITS.tableRows),
]);
export type CostInputValue = z.infer<typeof inputValue>;

export const costEstimateInputValue = z.object({ key: calculatorKey, value: inputValue }).strict();

const quantityRange = z.union([
  z.union([z.string().trim().max(40), z.number()]).transform((v) => String(v)),
  z
    .object({
      low: z.union([z.string().trim().max(40), z.number()]).transform((v) => String(v)),
      expected: z.union([z.string().trim().max(40), z.number()]).transform((v) => String(v)),
      high: z.union([z.string().trim().max(40), z.number()]).transform((v) => String(v)),
    })
    .strict(),
]);

export const costEstimateHandLine = z
  .object({
    key: calculatorKey.optional(),
    label: z.string().trim().max(120).optional(),
    provider: z.string().trim().min(1).max(120),
    sku: z.string().trim().min(1).max(COST_PRICE_LIMITS.skuChars),
    priceId: z.string().trim().max(COST_PRICE_LIMITS.skuChars).optional(),
    quantity: quantityRange.refine((q) => {
      const ok = (s: string) => {
        const v = parseQuantity(s);
        return v !== null && v >= 0n;
      };
      return typeof q === 'string' ? ok(q) : ok(q.low) && ok(q.expected) && ok(q.high);
    }, 'a quantity of at least 0'),
    unit: unitCode,
    group: z.string().trim().max(80).optional(),
  })
  .strict();
export type CostEstimateHandLine = z.output<typeof costEstimateHandLine>;

export const COST_ADJUSTMENT_KINDS = ['percent', 'price'] as const;
export type CostAdjustmentKind = (typeof COST_ADJUSTMENT_KINDS)[number];

export const costAdjustmentInput = z
  .object({
    /** A line's key; none: the whole estimate */
    line: calculatorKey.nullable().default(null),
    kind: z.enum(COST_ADJUSTMENT_KINDS),
    /** percent: −90 to +500 (two decimals) */
    percent: z
      .union([z.string().trim().max(20), z.number()])
      .transform((v) => String(v))
      .optional(),
    /** price: a fixed unit price per block, in `currency` */
    price: z.string().trim().max(40).optional(),
    block: z.union([z.literal(1), z.literal(1000), z.literal(1_000_000)]).default(1),
    currency: isoCurrencyCode.optional(),
    reason: z.string().trim().min(1).max(COST_ESTIMATE_LIMITS.reasonChars),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.kind === 'percent') {
      const p = a.percent === undefined ? null : parsePercent(a.percent);
      if (p === null || p < -9000n || p > 50000n) ctx.addIssue({ code: 'custom', path: ['percent'], message: 'a percentage from −90 to +500' });
    } else {
      if (!a.price || parsePrice(a.price) === null || parsePrice(a.price)! < 0n)
        ctx.addIssue({ code: 'custom', path: ['price'], message: 'a unit price of at least 0' });
      if (!a.line) ctx.addIssue({ code: 'custom', path: ['line'], message: 'a fixed unit price is for one line' });
      if (!a.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'the currency of the price' });
    }
  });
export type CostAdjustmentInput = z.input<typeof costAdjustmentInput>;
export type CostAdjustment = z.output<typeof costAdjustmentInput>;

/** The book to price a provider's items with (default: the contracted book the editor may see, else the list book). */
export const costBookChoice = z.object({ provider: z.string().trim().min(1).max(120), bookId: z.string().trim().min(1).max(100) }).strict();

/**
 * The contract whose conditions apply to a provider's prices (0.23.0, ADR 0035 part 3); contractId null: none (list or
 * the book's prices as they are). Default: a contract the editor sees the conditions of – one covering the estimate's
 * service or platform first.
 */
export const costContractChoice = z.object({ provider: z.string().trim().min(1).max(120), contractId: z.string().trim().min(1).max(100).nullable() }).strict();

/** What a calculation needs: a calculator (or a definition being edited) with inputs, and/or lines by hand. */
export const costCalculationInput = z
  .object({
    calculatorId: z.string().trim().min(1).max(100).nullable().default(null),
    /** A version of the calculator; default: its current one */
    calculatorVersion: z.number().int().min(1).max(100_000).nullable().default(null),
    /** A definition being edited (the editor's dry run) instead of a stored calculator */
    definition: z.string().max(COST_CALCULATOR_LIMITS.definitionBytes).optional(),
    inputs: z.array(costEstimateInputValue).max(COST_CALCULATOR_LIMITS.inputs).default([]),
    lines: z.array(costEstimateHandLine).max(COST_ESTIMATE_LIMITS.lines).default([]),
    adjustments: z.array(costAdjustmentInput).max(COST_ESTIMATE_LIMITS.adjustments).default([]),
    books: z.array(costBookChoice).max(50).default([]),
    contracts: z.array(costContractChoice).max(50).default([]),
    currency: isoCurrencyCode,
    /** The first month the estimate applies from (YYYY-MM); default: the current month */
    appliesFrom: z
      .string()
      .trim()
      .refine((s) => isMonth(s), 'a month YYYY-MM')
      .nullable()
      .default(null),
  })
  .strict();
export type CostCalculationInput = z.input<typeof costCalculationInput>;

/**
 * What an estimate is for: an application or system of the service, a platform, or – with the data products module
 * (ADR 0035 part 6, ADR 0036 part 11) – a data product the estimate's editor may see.
 */
export const COST_ESTIMATE_TARGET_KINDS = ['application', 'system', 'platform', 'dataProduct'] as const;
export type CostEstimateTargetKind = (typeof COST_ESTIMATE_TARGET_KINDS)[number];

export const costEstimateTarget = z
  .object({ kind: z.enum(COST_ESTIMATE_TARGET_KINDS), id: z.string().trim().min(1).max(100) })
  .strict()
  .nullable()
  .default(null);

export const costEstimateInput = costCalculationInput
  .extend({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).default(''),
    ownerKind: z.enum(COST_ESTIMATE_OWNER_KINDS),
    ownerId: z.string().trim().min(1).max(100),
    for: costEstimateTarget,
  })
  .strict();
export type CostEstimateInput = z.input<typeof costEstimateInput>;

export const costEstimateUpdate = costEstimateInput.omit({ ownerKind: true, ownerId: true }).strict();
export type CostEstimateUpdate = z.input<typeof costEstimateUpdate>;

/** The dry run: up to five variants, compared with the first. */
export const costDryRunInput = z
  .object({
    variants: z
      .array(costCalculationInput.extend({ name: z.string().trim().max(120).optional() }).strict())
      .min(1)
      .max(COST_ESTIMATE_LIMITS.variants),
  })
  .strict();
export type CostDryRunInput = z.input<typeof costDryRunInput>;

/** Low, expected and high – decimals in the estimate's currency (or the unit's, for quantities). */
export interface CostRange {
  low: string;
  expected: string;
  high: string;
}

export interface CostEstimateLine {
  key: string;
  label: string;
  group: string;
  provider: string;
  sku: string;
  priceId: string;
  /** The item's name in the book ('' when there is no price) */
  name: string;
  charge: CostPriceCharge | null;
  /** In the item's unit (the calculator's unit converted) */
  quantity: CostRange;
  unit: string;
  /** Priced in credits: how many, and of which item */
  credits: CostRange | null;
  creditSku: string | null;
  /** The book and version that priced it; null: no price (COST_PRICE_MISSING) */
  book: { id: string; name: string; kind: CostPriceBookKind; version: number } | null;
  /** The unit price found (per block, in the book's currency or in credits) */
  unitPrice: string | null;
  block: number;
  priceCurrency: string | null;
  tiered: boolean;
  /** The conversion into the estimate's currency, shown on the line */
  fx: { from: string; rate: string; date: string } | null;
  /** What the price found comes to, before an adjustment (estimate currency) */
  found: CostRange | null;
  adjustment: { scope: 'line' | 'estimate'; kind: CostAdjustmentKind; value: string; currency: string | null; block: number; reason: string } | null;
  /** A fixed price whose price found moved since it was set */
  fixedMoved: { was: string; now: string } | null;
  /** What the line costs (per month for usage and recurring, once for one-off); null: no price */
  amount: CostRange | null;
  /** The reader may not see the book: the line is shown at the list price (or left out without one) */
  priceHidden: boolean;
  /** How the price was found (0.23.0): list, contracted, derived, negotiated, percent off … – as far as the reader may see it */
  foundBy: CostPriceFound | null;
  /** Priced from a derived book: base, discount, markup and fee – only for who sees the provider's terms and the base */
  breakdown: CostDerivedBreakdown | null;
  /** Why there is no price */
  missing: 'noBook' | 'noItem' | 'unit' | 'ambiguous' | null;
}

export interface CostEstimateTotals {
  /** Usage and recurring, per month */
  monthly: CostRange;
  usage: CostRange;
  recurring: CostRange;
  oneOff: CostRange;
}

export interface CostEstimateResult {
  calculatedAt: string;
  calculatedBy: string;
  currency: string;
  appliesFrom: string;
  hoursPerMonth: number;
  calculator: { id: string; name: string; version: number } | null;
  ranged: boolean;
  adjusted: boolean;
  lines: CostEstimateLine[];
  totals: CostEstimateTotals;
  /** Per month over the next 36 months – only when a price changes within them */
  months: { month: string; monthly: CostRange }[] | null;
  books: { id: string; name: string; kind: CostPriceBookKind; version: number; provider: string; hidden: boolean }[];
  /** The contracts whose conditions it used (0.23.0) – only those the reader sees the conditions of */
  contracts: { id: string; title: string; reference: string; provider: string }[];
  rates: { from: string; to: string; rate: string; date: string }[];
  /** Lines without a price (their amounts are left out of the totals) */
  missing: number;
  /** Some lines are shown at list price (the reader may not see the rates used) */
  atListPrice: boolean;
  /** A line without a list price was left out for this reader */
  incomplete: boolean;
}

export interface CostEstimate {
  id: string;
  title: string;
  description: string;
  owner: { kind: CostEstimateOwnerKind; id: string; name: string };
  for: { kind: CostEstimateTargetKind; id: string; name: string; visible: boolean } | null;
  calculator: { id: string; name: string; version: number; latest: number } | null;
  inputs: { key: string; value: CostInputValue }[];
  lines: CostEstimateHandLine[];
  adjustments: (CostAdjustment & { by: string; at: string })[];
  books: { provider: string; bookId: string }[];
  /** The contracts chosen per provider (0.23.0) – those the reader may see */
  contracts: { provider: string; contractId: string | null }[];
  currency: string;
  appliesFrom: string;
  amountsVisible: boolean;
  canEdit: boolean;
  result: CostEstimateResult | null;
  /** A recalculation with new prices, waiting for "Accept new prices" */
  pending: (CostEstimateResult & { changePct: number | null }) | null;
  /** Plan lines made from it */
  planLines: { id: string; fiscalYear: number; title: string; changed: boolean }[];
  history: { at: string; by: string; monthly: string | null; oneOff: string | null }[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CostEstimateSummary {
  id: string;
  title: string;
  owner: { kind: CostEstimateOwnerKind; id: string; name: string };
  for: { kind: CostEstimateTargetKind; id: string; name: string } | null;
  calculator: { id: string; name: string } | null;
  currency: string;
  appliesFrom: string;
  monthly: CostRange | null;
  oneOff: CostRange | null;
  ranged: boolean;
  adjusted: boolean;
  atListPrice: boolean;
  pending: boolean;
  planLines: number;
  updatedAt: string;
}

export interface CostDryRunVariant {
  name: string;
  result: CostEstimateResult;
}

export interface CostDryRunResult {
  variants: CostDryRunVariant[];
  /** Each variant against the first: per month and one-off, per scenario; the lines that make the difference */
  comparison: {
    variant: number;
    name: string;
    monthly: CostRange;
    oneOff: CostRange;
    lines: { provider: string; sku: string; group: string; difference: string }[];
  }[];
  /** The cheapest variant per scenario (monthly), by index */
  cheapest: { low: number; expected: number; high: number };
}

export interface CostPlanProposalLine {
  key: string;
  title: string;
  cadence: 'monthly' | 'once';
  /** Per month (monthly) or once, in the estimate's currency, rounded to its minor units */
  amount: string;
  fromMonth: string;
  toMonth: string;
  group: string;
}

export interface CostEstimateProposals {
  fiscalYear: number;
  label: string;
  currency: string;
  lines: CostPlanProposalLine[];
  /** Readers of the plan may see amounts priced with rates they may not see */
  hiddenRates: boolean;
  adjusted: boolean;
  existing: number;
}

export const costEstimateProposalInput = z
  .object({
    fiscalYear: z.number().int().min(2000).max(2100),
    keys: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
    category: z.enum(['licence', 'cloud', 'support', 'hardware', 'other']).default('cloud'),
    /** The confirmation that readers of the plan will see amounts priced with rates they may not see */
    confirmHidden: z.boolean().default(false),
  })
  .strict();
export type CostEstimateProposalInput = z.input<typeof costEstimateProposalInput>;

export interface CostCalculatorSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  hasDraft: boolean;
  source: 'manual' | 'git';
  inputs: number;
  lines: number;
  providers: string[];
  canEdit: boolean;
  updatedAt: string;
}

export interface CostCalculatorDetail extends CostCalculatorSummary {
  /** The current version's definition (YAML) */
  definition: string;
  parsed: CostCalculatorDefinition | null;
  draft: string | null;
  versions: { number: number; sha256: string; publishedAt: string; publishedBy: string }[];
  owningTeams: { id: string; name: string }[];
  checked: string | null;
}
