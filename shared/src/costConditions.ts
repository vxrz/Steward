import { z } from 'zod';
import { isoCurrencyCode } from './costs.js';
import { isCalendarDate, lastDayOf } from './costPlans.js';
import {
  COST_PRICE_LIMITS,
  COST_TIER_MODES,
  convertQuantity,
  formatPrice,
  formatQuantity,
  parsePercent,
  parsePrice,
  parseQuantity,
  parseUnit,
  roundDiv,
  QTY_SCALE,
  type CostPriceEntry,
  type CostPriceTier,
  type CostTierMode,
} from './costPrices.js';

/**
 * Conditions of supplier contracts and derived price books (0.23.0, ADR 0035 parts 3 and 4, docs/PRICE-BOOKS.md):
 * what a contract grants on a provider's list prices – a percentage off per scope, a negotiated unit price, a
 * percentage by a committed volume – and the terms a provider with a fee on top applies to a base book: a discount
 * passed on, a markup, a fee per unit and a fixed fee per month. Pure functions on whole numbers, the same in the
 * browser and on the server.
 *
 * - **Scope**: a condition names a provider and what it is for – the whole provider, one book, a service, a category,
 *   a driver (fees) or one item. The most specific wins: item, then service, then category or driver, then book, then
 *   provider. Two conditions of one group (percentages; negotiated prices; discounts; markups; fees; fixed fees) with
 *   the same scope whose validity overlaps are refused (`COST_CONDITION_OVERLAP`).
 * - **Customer price** of a derived book, per entry: base × (1 − discount) × (1 + markup) + fee per unit, each tier
 *   alike, the minimum without the fee, exact to 12 decimals. Entries priced in credits keep their credits: the
 *   discount, markup and fee apply to the credit item's money price.
 */

export const COST_CONDITION_LIMITS = {
  /** Conditions per contract (and terms per rate card) */
  perContract: 100,
  /** Bands of a commitment */
  bands: 10,
  noteChars: 500,
} as const;

/** What a contract can grant on list prices (part 3) and the terms of a derived book (part 4). */
export const COST_CONDITION_KINDS = ['percentOff', 'negotiatedPrice', 'commitment', 'baseDiscount', 'markup', 'feePerUnit', 'fixedFee'] as const;
export type CostConditionKind = (typeof COST_CONDITION_KINDS)[number];
/** The kinds that change list prices for the contract's readers. */
export const COST_LIST_CONDITION_KINDS: readonly CostConditionKind[] = ['percentOff', 'negotiatedPrice', 'commitment'];
/** The kinds that make a derived book's customer prices out of its base book. */
export const COST_DERIVATION_KINDS: readonly CostConditionKind[] = ['baseDiscount', 'markup', 'feePerUnit', 'fixedFee'];

export const COST_CONDITION_SCOPES = ['provider', 'book', 'category', 'service', 'driver', 'item'] as const;
export type CostConditionScope = (typeof COST_CONDITION_SCOPES)[number];

/** The scopes each kind may take. */
export const COST_CONDITION_SCOPES_OF: Record<CostConditionKind, readonly CostConditionScope[]> = {
  percentOff: ['provider', 'book', 'category', 'service', 'item'],
  negotiatedPrice: ['item'],
  commitment: ['provider', 'book', 'category', 'service', 'item'],
  baseDiscount: ['provider', 'category', 'service', 'item'],
  markup: ['provider', 'category', 'service', 'item'],
  feePerUnit: ['provider', 'driver', 'item'],
  fixedFee: ['provider'],
};

/** How specific a scope is: the highest matching wins. */
export const scopeRank = (s: CostConditionScope): number =>
  s === 'item' ? 5 : s === 'service' ? 4 : s === 'category' || s === 'driver' ? 3 : s === 'book' ? 2 : 1;

/** Conditions of one group exclude each other on the same scope (COST_CONDITION_OVERLAP). */
export const conditionGroup = (k: CostConditionKind): string => (k === 'percentOff' || k === 'commitment' ? 'percent' : k);

export interface CostCommitmentBand {
  /** The committed amount per year (in the volume's currency) from which the percentage applies */
  from: string;
  percent: string;
}

/** One condition as stored and read. */
export interface CostCondition {
  id: string;
  kind: CostConditionKind;
  /** The provider of the books it applies to (as the books name it) */
  provider: string;
  on: CostConditionScope;
  /** The book id, service, category, driver or SKU; '' for the whole provider */
  target: string;
  /** A negotiated price of one price id of the SKU ('' for all) */
  priceId: string;
  /** percentOff, baseDiscount: 0 to 100; markup: 0 to 500 (two decimals) */
  percent: string | null;
  /** negotiatedPrice: per block; feePerUnit: per `unit`, per block; fixedFee: per month */
  price: string | null;
  block: 1 | 1000 | 1000000;
  currency: string | null;
  tiers: CostPriceTier[] | null;
  tierMode: CostTierMode;
  /** feePerUnit: the unit it is per (UCUM) */
  unit: string | null;
  /** commitment: the bands by committed amount and the volume schedule of the same contract it reads */
  bands: CostCommitmentBand[] | null;
  scheduleId: string | null;
  validFrom: string | null;
  validTo: string | null;
  note: string;
}

const dec = (max = 40) => z.union([z.string().trim().max(max), z.number()]).transform((v) => String(v).trim());
const dateText = z
  .string()
  .trim()
  .refine((s) => isCalendarDate(s), 'a date YYYY-MM-DD');

export const costConditionInput = z
  .object({
    /** Kept when the condition is saved again (a new one gets an id) */
    id: z.string().trim().max(64).optional(),
    kind: z.enum(COST_CONDITION_KINDS),
    provider: z.string().trim().min(1).max(120),
    on: z.enum(COST_CONDITION_SCOPES).default('provider'),
    target: z.string().trim().max(COST_PRICE_LIMITS.skuChars).default(''),
    priceId: z.string().trim().max(COST_PRICE_LIMITS.skuChars).default(''),
    percent: dec(20).nullable().default(null),
    price: dec().nullable().default(null),
    block: z.union([z.literal(1), z.literal(1000), z.literal(1_000_000)]).default(1),
    currency: isoCurrencyCode.nullable().default(null),
    tiers: z
      .array(z.object({ from: dec(), price: dec() }).strict())
      .max(COST_PRICE_LIMITS.tiers)
      .nullable()
      .default(null),
    tierMode: z.enum(COST_TIER_MODES).default('graduated'),
    unit: z.string().trim().max(60).nullable().default(null),
    bands: z
      .array(z.object({ from: dec(), percent: dec(20) }).strict())
      .max(COST_CONDITION_LIMITS.bands)
      .nullable()
      .default(null),
    scheduleId: z.string().trim().max(64).nullable().default(null),
    validFrom: dateText.nullable().default(null),
    validTo: dateText.nullable().default(null),
    note: z.string().trim().max(COST_CONDITION_LIMITS.noteChars).default(''),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (!COST_CONDITION_SCOPES_OF[c.kind].includes(c.on)) issue('on', `a ${c.kind} is for ${COST_CONDITION_SCOPES_OF[c.kind].join(', ')}`);
    if (c.on !== 'provider' && !c.target) issue('target', 'what it is for');
    const pct = (lo: bigint, hi: bigint, what: string) => {
      const p = c.percent === null ? null : parsePercent(c.percent);
      if (p === null || p < lo || p > hi) issue('percent', what);
    };
    const price = (what: string) => {
      const p = c.price === null ? null : parsePrice(c.price);
      if (p === null || p < 0n) issue('price', what);
    };
    if (c.kind === 'percentOff' || c.kind === 'baseDiscount') pct(0n, 10_000n, 'a percentage from 0 to 100');
    if (c.kind === 'markup') pct(0n, 50_000n, 'a percentage from 0 to 500');
    if (c.kind === 'negotiatedPrice' || c.kind === 'feePerUnit' || c.kind === 'fixedFee') {
      price('a price of at least 0 with at most 12 decimals');
      if (!c.currency) issue('currency', 'the currency of the price');
    }
    if (c.kind === 'feePerUnit' && (!c.unit || !parseUnit(c.unit))) issue('unit', 'the unit the fee is per (GBy, h, {credit} …)');
    if (c.kind === 'commitment') {
      if (!c.scheduleId) issue('scheduleId', 'a volume schedule of this contract');
      if (!c.bands?.length) issue('bands', 'at least one band');
      let last = -1n;
      for (const [i, b] of (c.bands ?? []).entries()) {
        const from = parsePrice(b.from);
        const p = parsePercent(b.percent);
        if (from === null || from < 0n || from <= last) ctx.addIssue({ code: 'custom', path: ['bands', i, 'from'], message: 'amounts that rise' });
        if (p === null || p < 0n || p > 10_000n) ctx.addIssue({ code: 'custom', path: ['bands', i, 'percent'], message: 'a percentage from 0 to 100' });
        last = from ?? last;
      }
    }
    if (c.tiers?.length) {
      if (c.kind !== 'negotiatedPrice') issue('tiers', 'tiers are for negotiated prices');
      const from = c.tiers.map((t) => parseQuantity(t.from));
      if (from[0] !== 0n) ctx.addIssue({ code: 'custom', path: ['tiers', 0, 'from'], message: 'the first band starts at 0' });
      for (let i = 1; i < from.length; i++)
        if (from[i] === null || from[i]! <= from[i - 1]!) ctx.addIssue({ code: 'custom', path: ['tiers', i, 'from'], message: 'bands rise' });
      for (const [i, t] of c.tiers.entries())
        if (parsePrice(t.price) === null) ctx.addIssue({ code: 'custom', path: ['tiers', i, 'price'], message: 'a price with at most 12 decimals' });
    }
    if (c.validFrom && c.validTo && c.validTo < c.validFrom) issue('validTo', 'on or after the first day');
  });
export type CostConditionInput = z.input<typeof costConditionInput>;

/** PUT …/conditions: the whole list of a contract (or a rate card's terms). */
export const costConditionsInput = z
  .object({
    conditions: z.array(costConditionInput).max(COST_CONDITION_LIMITS.perContract),
    /** The person confirmed that the readers of the contract see the new terms (an informative step, not a widening) */
    note: z.string().trim().max(500).default(''),
  })
  .strict();
export type CostConditionsInput = z.input<typeof costConditionsInput>;

/** An input as stored (numbers normalised), with its id. */
export function normaliseCondition(c: z.output<typeof costConditionInput>, id: string): CostCondition {
  const p = (s: string | null) => (s === null ? null : formatPrice(parsePrice(s)!));
  const pct = (s: string | null) => (s === null ? null : pctText(parsePercent(s)!));
  return {
    id,
    kind: c.kind,
    provider: c.provider,
    on: c.on,
    target: c.on === 'provider' ? '' : c.target,
    priceId: c.kind === 'negotiatedPrice' ? c.priceId : '',
    percent: c.kind === 'percentOff' || c.kind === 'baseDiscount' || c.kind === 'markup' ? pct(c.percent) : null,
    price: c.kind === 'negotiatedPrice' || c.kind === 'feePerUnit' || c.kind === 'fixedFee' ? p(c.price) : null,
    block: c.kind === 'negotiatedPrice' || c.kind === 'feePerUnit' ? c.block : 1,
    currency: c.kind === 'negotiatedPrice' || c.kind === 'feePerUnit' || c.kind === 'fixedFee' ? c.currency : null,
    tiers:
      c.kind === 'negotiatedPrice' && c.tiers?.length
        ? c.tiers.map((t) => ({ from: formatQuantity(parseQuantity(t.from)!), price: formatPrice(parsePrice(t.price)!) }))
        : null,
    tierMode: c.tierMode,
    unit: c.kind === 'feePerUnit' ? c.unit : null,
    bands:
      c.kind === 'commitment' ? (c.bands ?? []).map((b) => ({ from: formatPrice(parsePrice(b.from)!), percent: pctText(parsePercent(b.percent)!) })) : null,
    scheduleId: c.kind === 'commitment' ? c.scheduleId : null,
    validFrom: c.validFrom,
    validTo: c.validTo,
    note: c.note,
  };
}

/** Hundredths of a percent → "12.5". */
export const pctText = (h: bigint): string => {
  const neg = h < 0n;
  const a = neg ? -h : h;
  const whole = a / 100n;
  const frac = (a % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};

const norm = (s: string) => s.trim().toLowerCase();

/** Whether a condition's validity covers any day of `month` (YYYY-MM); `term`: the contract's (start, end) when the condition has none. */
export function conditionValidIn(
  c: Pick<CostCondition, 'validFrom' | 'validTo'>,
  month: string,
  term: { from: string | null; to: string | null } = { from: null, to: null },
): boolean {
  const from = c.validFrom ?? term.from;
  const to = c.validTo ?? term.to;
  return (!from || from <= lastDayOf(month)) && (!to || to >= `${month}-01`);
}

/** What a priced item offers to the scopes. */
export interface ConditionSubject {
  provider: string;
  bookId: string;
  service: string;
  category: string;
  driver: string;
  sku: string;
  priceId: string;
}

/** Whether a condition is for this item. */
export function conditionMatches(c: Pick<CostCondition, 'provider' | 'on' | 'target' | 'priceId'>, s: ConditionSubject): boolean {
  if (norm(c.provider) !== norm(s.provider)) return false;
  switch (c.on) {
    case 'provider':
      return true;
    case 'book':
      return c.target === s.bookId;
    case 'category':
      return !!s.category && norm(c.target) === norm(s.category);
    case 'service':
      return !!s.service && norm(c.target) === norm(s.service);
    case 'driver':
      return !!s.driver && norm(c.target) === norm(s.driver);
    case 'item':
      return c.target === s.sku && (!c.priceId || c.priceId === s.priceId);
  }
}

/** The most specific condition of these kinds for the item, valid in the month (null: none). */
export function pickCondition<C extends CostCondition>(
  list: readonly C[],
  kinds: readonly CostConditionKind[],
  s: ConditionSubject,
  month: string,
  term?: { from: string | null; to: string | null },
): C | null {
  let best: C | null = null;
  for (const c of list) {
    if (!kinds.includes(c.kind) || !conditionMatches(c, s) || !conditionValidIn(c, month, term)) continue;
    if (!best || scopeRank(c.on) > scopeRank(best.on)) best = c;
  }
  return best;
}

const overlapIn = (a: Pick<CostCondition, 'validFrom' | 'validTo'>, b: Pick<CostCondition, 'validFrom' | 'validTo'>) =>
  (!a.validFrom || !b.validTo || a.validFrom <= b.validTo) && (!b.validFrom || !a.validTo || b.validFrom <= a.validTo);

/** Two conditions of one group on the same scope with validities that overlap: the first such pair (null: none). */
export function conditionOverlap(list: readonly CostCondition[]): { a: number; b: number } | null {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (conditionGroup(a.kind) !== conditionGroup(b.kind) || norm(a.provider) !== norm(b.provider) || a.on !== b.on) continue;
      if (a.on === 'item' ? a.target !== b.target || a.priceId !== b.priceId : norm(a.target) !== norm(b.target)) continue;
      if (a.kind === 'feePerUnit' && a.unit !== b.unit) continue;
      if (overlapIn(a, b)) return { a: i, b: j };
    }
  return null;
}

/** The percentage of a commitment for a committed amount (10^-12 of its currency): the highest band reached. */
export function commitmentPercent(bands: readonly CostCommitmentBand[], committed: bigint): bigint {
  let p = 0n;
  for (const b of bands) if (committed >= (parsePrice(b.from) ?? 0n)) p = parsePercent(b.percent) ?? 0n;
  return p;
}

// ---------- derived books (part 4) ----------

/** The terms that apply to one base entry: discount and markup in hundredths of a percent, the fee per block (10^-12). */
export interface EntryTerms {
  discount: bigint;
  markup: bigint;
  fee: bigint;
  /** Why a fee that matched was not applied */
  feeSkipped: 'currency' | 'unit' | 'credits' | null;
  /** The conditions used (ids), for the version's record */
  used: string[];
}

/** The terms of a derived book for one base entry (most specific scope per kind). */
export function termsFor(e: CostPriceEntry, terms: readonly CostCondition[], bookId = '', month: string | null = null): EntryTerms {
  const s: ConditionSubject = { provider: '', bookId, service: e.service, category: e.category, driver: e.driver, sku: e.sku, priceId: e.priceId };
  const pick = (kind: CostConditionKind) => {
    let best: CostCondition | null = null;
    for (const c of terms) {
      if (c.kind !== kind || !conditionMatches(c, { ...s, provider: c.provider }) || (month && !conditionValidIn(c, month))) continue;
      if (!best || scopeRank(c.on) > scopeRank(best.on)) best = c;
    }
    return best;
  };
  const d = pick('baseDiscount');
  const m = pick('markup');
  const f = pick('feePerUnit');
  const used = [d, m, f].filter((x): x is CostCondition => !!x).map((x) => x.id);
  let fee = 0n;
  let feeSkipped: EntryTerms['feeSkipped'] = null;
  if (f) {
    if (!e.currency) feeSkipped = 'credits';
    else if (f.currency !== e.currency) feeSkipped = 'currency';
    else {
      // the fee per one of its blocks of its unit → per one block of the entry's unit
      const units = convertQuantity(BigInt(e.block) * QTY_SCALE, e.unit, f.unit ?? '');
      if (units === null) feeSkipped = 'unit';
      else fee = roundDiv((parsePrice(f.price) ?? 0n) * units, BigInt(f.block) * QTY_SCALE);
    }
  }
  return {
    discount: d ? (parsePercent(d.percent ?? '0') ?? 0n) : 0n,
    markup: m ? (parsePercent(m.percent ?? '0') ?? 0n) : 0n,
    fee: feeSkipped ? 0n : fee,
    feeSkipped,
    used,
  };
}

/**
 * A base price (10^-12) through the stages of a derived book: 0 the base, 1 after the discount, 2 after the markup,
 * 3 with the fee per unit – the customer price.
 */
export function stagePrice(p: bigint, t: Pick<EntryTerms, 'discount' | 'markup' | 'fee'>, stage: 0 | 1 | 2 | 3, withFee = true): bigint {
  if (stage === 0) return p;
  if (stage === 1) return roundDiv(p * (10_000n - t.discount), 10_000n);
  const marked = roundDiv(p * (10_000n - t.discount) * (10_000n + t.markup), 100_000_000n);
  return stage === 2 || !withFee ? marked : marked + t.fee;
}

/** A base entry at a stage of the derivation (money-priced entries only; credit-priced ones stay as they are). */
export function stageEntry(e: CostPriceEntry, t: EntryTerms, stage: 0 | 1 | 2 | 3): CostPriceEntry {
  if (!e.currency || stage === 0) return e;
  const p = (s: string) => formatPrice(stagePrice(parsePrice(s) ?? 0n, t, stage));
  return {
    ...e,
    price: p(e.price),
    tiers: e.tiers ? e.tiers.map((x) => ({ from: x.from, price: p(x.price) })) : null,
    minimum: e.minimum === null ? null : formatPrice(stagePrice(parsePrice(e.minimum) ?? 0n, t, stage, false)),
  };
}

export interface DerivedEntries {
  entries: CostPriceEntry[];
  /** Fees that matched an entry but could not apply to it */
  skipped: { sku: string; reason: 'currency' | 'unit' | 'credits' }[];
}

/**
 * The customer prices of a derived book: every base entry through its terms (stage 3), and the fixed fees as recurring
 * items of their own ("Service fee – Invented Data Services", `{subscription}.mo`).
 */
export function deriveEntries(base: readonly CostPriceEntry[], terms: readonly CostCondition[], o: { feeName: string; bookId?: string }): DerivedEntries {
  const skipped: DerivedEntries['skipped'] = [];
  const entries = base.map((e) => {
    const t = termsFor(e, terms, o.bookId ?? '');
    if (t.feeSkipped) skipped.push({ sku: e.sku, reason: t.feeSkipped });
    return stageEntry(e, t, 3);
  });
  const fixed = terms.filter((c) => c.kind === 'fixedFee');
  for (const [i, c] of fixed.entries()) {
    const sku = fixed.length > 1 ? `service-fee-${i + 1}` : 'service-fee';
    if (entries.some((e) => e.sku === sku)) continue;
    entries.push({
      sku,
      priceId: '',
      name: `Service fee – ${o.feeName}`.slice(0, COST_PRICE_LIMITS.textChars),
      service: 'Service fee',
      category: 'Fees',
      driver: 'subscription',
      unit: '{subscription}.mo',
      charge: 'recurring',
      price: c.price ?? '0',
      block: 1,
      currency: c.currency,
      creditSku: null,
      tiers: null,
      tierMode: 'graduated',
      included: null,
      minimum: null,
      validFrom: c.validFrom,
      validTo: c.validTo,
      attributes: [],
      sourceNote: 'Fixed fee of the provider – once per subscription, not per estimate',
    });
  }
  return { entries, skipped };
}

/** How the price of an estimate line was found (part 3: "list price of Snowflake list (v7) – 12 % off by contract SDC-2026-014"). */
export interface CostPriceFound {
  /** list: the list price; contracted: a contracted book; derived: a derived book's customer price; negotiated: a negotiated
   * unit price of a contract; percentOff: the list price less a contract's percentage; commitment: less a commitment's */
  kind: 'list' | 'contracted' | 'derived' | 'negotiated' | 'percentOff' | 'commitment';
  /** The percentage off (percentOff, commitment) */
  percent: string | null;
  /** The contract whose conditions applied (only for who may see them) */
  contract: { id: string; title: string; reference: string; inherited: boolean } | null;
  /** A percentage that would apply on top of a contracted book was left out (the book includes the discount) */
  conditionIgnored: boolean;
}

/** The breakdown of a line priced from a derived book – only for who sees the provider's terms and the base book. */
export interface CostDerivedBreakdown {
  base: { id: string; name: string; version: number };
  /** Amounts in the estimate's currency: what the base price comes to, the discount (negative), the markup and the fee */
  baseAmount: { low: string; expected: string; high: string };
  discount: { low: string; expected: string; high: string };
  markup: { low: string; expected: string; high: string };
  fee: { low: string; expected: string; high: string };
  discountPct: string;
  markupPct: string;
  /** The fee per block of the item, in its currency */
  feePerBlock: string;
}

/** A condition as the contract's "Prices" section shows it. */
export interface CostConditionView extends CostCondition {
  /** A percentage that does not apply because a contracted book of this contract already includes the discount */
  flag: 'contractedBook' | null;
  updatedAt: string;
  updatedBy: string;
}

/** GET /api/costs/contracts/:contractId/conditions – only for who sees the contract with its amounts. */
export interface CostContractConditions {
  contract: { id: string; title: string; reference: string; supplierId: string };
  conditions: CostConditionView[];
  /** An order form without conditions of its own applies its master agreement's (shown read-only) */
  inherited: { id: string; title: string; conditions: CostConditionView[] } | null;
  canEdit: boolean;
  /** Contracted and derived books that name this contract (visible to the reader) */
  books: { id: string; name: string; kind: string; provider: string }[];
  /** Volume schedules of this contract a commitment can read */
  schedules: { id: string; title: string; currency: string }[];
}
