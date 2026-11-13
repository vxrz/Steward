import {
  COST_ESTIMATE_LIMITS,
  HOURS_PER_MONTH,
  MAX_AMOUNT_MICROS,
  adjustByPercent,
  convertAmount,
  convertQuantity,
  costCalculationInput,
  costDryRunInput,
  formatMicros,
  formatPrice,
  formatQuantity,
  lastDayOf,
  parsePercent,
  parsePrice,
  parseQuantity,
  priceQuantity,
  shiftMonth,
  specOf,
  type CostAdjustment,
  type CostCalculatorDefinition,
  type CostDryRunResult,
  type CostEstimateLine,
  type CostEstimateResult,
  type CostPriceBookKind,
  type CostPriceCharge,
  type CostPriceEntry,
  type CostRange,
} from '@sm/shared';
import type { z } from 'zod';
import { currentActor, currentUser } from '../auth/context.js';
import { HttpError, nowIso } from '../util.js';
import { thisMonth, today } from './plans.js';
import { currentVersionIds, entriesForSkus, visibleBooks, type BookRow } from './price-books.js';
import { calculatorVersion, evaluate, mayAddCalculators, parseCalculator, resolveInputs, type CalculatedLine } from './calculators.js';
import { FxTable } from './fx.js';

/**
 * Pricing of estimates (0.21.0, ADR 0035 parts 1, 3 and 6): a calculator's quantities (three scenarios when inputs are
 * ranges) and lines by hand, priced exactly with the books the calculating person may see – per provider their
 * contracted book, else the list book, or the book the estimate chose – converted into the estimate's currency with a
 * manual rate, and ad-hoc adjustments applied last. Over the next 36 months when a price changes within them.
 *
 * The stored result keeps, per line, the amounts of the three scenarios in whole millionths and – for a line priced from
 * a contracted book – what the line costs at the list price, so a reader who may not see that book is shown the list
 * price without anything being recalculated on read (viewResult). Totals are sums of the stored amounts.
 */

export type Triple = [number, number, number];

export interface StoredLine extends Omit<CostEstimateLine, 'quantity' | 'credits' | 'found' | 'amount' | 'priceHidden'> {
  /** Quantity per scenario (low, expected, high inputs), in the item's unit */
  q: [string, string, string];
  cr: [string, string, string] | null;
  /** The price found, per scenario, in millionths of the estimate's currency */
  f: Triple | null;
  /** After the adjustment */
  a: Triple | null;
  /** At the list price (a line priced from a contracted book), after the adjustment */
  l: { a: Triple; unitPrice: string; bookId: string; bookName: string; version: number } | null;
}

export interface StoredResult extends Omit<CostEstimateResult, 'lines' | 'totals' | 'months' | 'atListPrice' | 'incomplete'> {
  lines: StoredLine[];
  /**
   * Usage and recurring per month and scenario, when a price changes within the 36 months; `g`: the expected amount per
   * group (plan lines are proposed per group)
   */
  months: { month: string; s: Triple; g: [string, number][] }[] | null;
  /** The book versions it used (kept beyond the fifty versions per book while an estimate uses them) */
  versionIds: string[];
}

type CalcInput = z.output<typeof costCalculationInput>;

const norm = (s: string) => s.trim().toLowerCase();
const triple = (f: (k: number) => number): Triple => [f(0), f(1), f(2)];

/** low = the smallest, high = the largest of the three scenarios, expected = the expected scenario's. */
export const rangeOf = (s: readonly number[]): CostRange => ({
  low: formatMicros(BigInt(Math.min(...s))),
  expected: formatMicros(BigInt(s[1]!)),
  high: formatMicros(BigInt(Math.max(...s))),
});
const qRange = (q: readonly string[]): CostRange => {
  const n = q.map((x) => parseQuantity(x) ?? 0n);
  const lo = n.reduce((a, b) => (b < a ? b : a));
  const hi = n.reduce((a, b) => (b > a ? b : a));
  return { low: formatQuantity(lo), expected: formatQuantity(n[1]!), high: formatQuantity(hi) };
};

const tooLarge = (key: string) =>
  new HttpError(400, `lines.${key}: the amount is too large`, 'COST_CALCULATOR_OUTPUT', { line: key, message: 'the amount is too large' });
const checked = (key: string, v: bigint): number => {
  if (v > MAX_AMOUNT_MICROS || v < -MAX_AMOUNT_MICROS) throw tooLarge(key);
  return Number(v);
};

interface LineQ {
  key: string;
  label: string;
  group: string;
  provider: string;
  sku: string;
  priceId: string;
  unit: string;
  q: [bigint, bigint, bigint];
}

/** Picks the entry of a SKU valid in a month (the latest that started); 'ambiguous' when several price ids fit. */
function pick(list: readonly CostPriceEntry[] | undefined, priceId: string, month: string): CostPriceEntry | 'ambiguous' | null {
  if (!list?.length) return null;
  const first = `${month}-01`;
  const last = lastDayOf(month);
  let c = list.filter((e) => (!priceId || e.priceId === priceId) && (!e.validFrom || e.validFrom <= last) && (!e.validTo || e.validTo >= first));
  if (!priceId) {
    const ids = new Set(c.map((e) => e.priceId));
    if (ids.size > 1) {
      if (!ids.has('')) return 'ambiguous';
      c = c.filter((e) => e.priceId === '');
    }
  }
  c.sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''));
  return c[0] ?? null;
}

/** The entries of chosen versions, read by SKU – one statement per version and round. */
class Entries {
  private loaded = new Map<string, Map<string, CostPriceEntry[]>>();
  get(versionId: string, sku: string): CostPriceEntry[] | undefined {
    return this.loaded.get(versionId)?.get(sku);
  }
  load(versionId: string, skus: Iterable<string>): void {
    const have = this.loaded.get(versionId) ?? new Map<string, CostPriceEntry[]>();
    const want = [...new Set(skus)].filter((s) => !have.has(s));
    if (!want.length) return;
    for (const s of want) have.set(s, []);
    for (const e of entriesForSkus(versionId, want)) have.get(e.sku)!.push(e);
    this.loaded.set(versionId, have);
  }
  /** Loads the credit items the loaded entries are priced in (two more rounds at most: chains are two steps). */
  chains(versionId: string): void {
    for (let round = 0; round < 2; round++) {
      const have = this.loaded.get(versionId);
      if (!have) return;
      const need = new Set<string>();
      for (const list of have.values()) for (const e of list) if (e.creditSku && !have.has(e.creditSku)) need.add(e.creditSku);
      if (!need.size) return;
      this.load(versionId, need);
    }
  }
}

interface Priced {
  entry: CostPriceEntry;
  /** Per scenario, in the price's currency */
  micros: [bigint, bigint, bigint];
  currency: string;
  credits: [bigint, bigint, bigint] | null;
  /** The entries that priced it (the month's signature) */
  sig: string;
}

/** Prices one line in one month with one version; a reason when it cannot. */
function priceIn(entries: Entries, versionId: string, l: LineQ, month: string): Priced | 'noItem' | 'ambiguous' | 'unit' {
  const e = pick(entries.get(versionId, l.sku), l.priceId, month);
  if (e === null) return 'noItem';
  if (e === 'ambiguous') return 'ambiguous';
  const q = l.q.map((x) => convertQuantity(x, l.unit, e.unit));
  if (q.some((x) => x === null)) return 'unit';
  const qs = q as bigint[];
  let micros = qs.map((x) => priceQuantity(x, specOf(e))) as [bigint, bigint, bigint];
  let currency = e.currency;
  let credits: [bigint, bigint, bigint] | null = null;
  let sig = `${e.sku}|${e.priceId}|${e.validFrom ?? ''}`;
  let cur: CostPriceEntry = e;
  // a credit chain: at most two steps (checked when the version was written)
  for (let depth = 0; !currency && depth < 3; depth++) {
    const c = pick(entries.get(versionId, cur.creditSku ?? ''), '', month);
    if (!c || c === 'ambiguous') return 'noItem';
    if (!credits) credits = micros;
    micros = micros.map((x) => priceQuantity(x, specOf(c), true)) as [bigint, bigint, bigint];
    currency = c.currency;
    sig += `>${c.sku}|${c.validFrom ?? ''}`;
    cur = c;
  }
  if (!currency) return 'noItem';
  return { entry: e, micros, currency, credits, sig };
}

export interface CalcOptions {
  /** The estimate's owner or target platform: its contracted book is preferred */
  platformId?: string | null;
  /** Fixed prices of adjustments as they were when set: { line key → price found then } */
  fixedFound?: ReadonlyMap<string, string>;
}

export interface Calculated {
  result: StoredResult;
  /** The book versions the result used (kept beyond fifty) */
  versionIds: string[];
  /** The unit price found per line (for fixed prices set now) */
  found: Map<string, string>;
}

/** Runs one calculation (the dry run's variant, an estimate's save or recalculation). Stores nothing. */
export async function calculateOne(input: unknown, o: CalcOptions = {}): Promise<Calculated> {
  const x: CalcInput = costCalculationInput.parse(input);
  const u = currentUser();
  const deadline = performance.now() + 500;
  // the calculator
  let def: CostCalculatorDefinition | null = null;
  let calculator: StoredResult['calculator'] = null;
  if (x.definition !== undefined) {
    const p = parseCalculator(x.definition);
    if (!p.ok || !p.definition) {
      const first = p.errors[0] ?? 'Not a calculator';
      const at = first.indexOf(': ');
      if (p.definition && at > 0 && /^(let|lines)\./.test(first))
        throw new HttpError(400, first, 'COST_CALCULATOR_FORMULA', { line: first.slice(0, at), message: first.slice(at + 2) });
      throw new HttpError(400, first, 'COST_CALCULATOR_DEFINITION', { message: first });
    }
    def = p.definition;
    calculator = { id: '', name: def.name, version: 0 };
  } else if (x.calculatorId) {
    const v = calculatorVersion(x.calculatorId, x.calculatorVersion);
    def = v.definition;
    calculator = { id: v.row.id, name: v.definition.name, version: v.number };
  }
  if (!def && !x.lines.length)
    throw new HttpError(400, 'Choose a calculator or add lines by hand', 'COST_CALCULATOR_INPUT', { key: 'lines', message: 'a calculator or lines by hand' });

  // the books: per provider the chosen one, else the contracted book (the platform's first), else the list book
  const books = visibleBooks(u);
  const byId = new Map(books.map((b) => [b.row.id, b.row]));
  const byProvider = new Map<string, BookRow[]>();
  for (const b of books) byProvider.set(norm(b.row.provider), [...(byProvider.get(norm(b.row.provider)) ?? []), b.row]);
  const chosen = new Map<string, BookRow | null>();
  for (const c of x.books) {
    const b = byId.get(c.bookId);
    if (!b) throw new HttpError(404, `Price book ${c.bookId} not found`, 'COST_PRICE_BOOK_NOT_FOUND', { id: c.bookId });
    chosen.set(norm(c.provider), b);
  }
  const listOf = (provider: string): BookRow | null => (byProvider.get(norm(provider)) ?? []).find((b) => b.kind === 'list' && b.current_version > 0) ?? null;
  const bookFor = (provider: string): BookRow | null => {
    const k = norm(provider);
    if (chosen.has(k)) return chosen.get(k)!;
    const list = (byProvider.get(k) ?? []).filter((b) => Number(b.current_version) > 0);
    const contracted = list.filter((b) => b.kind === 'contracted');
    const pickBook = contracted.find((b) => o.platformId && b.platform_id === o.platformId) ?? contracted[0] ?? list.find((b) => b.kind === 'list') ?? null;
    chosen.set(k, pickBook);
    return pickBook;
  };
  const entries = new Entries();
  let versions = new Map<string, string>();
  const versionOf = (b: BookRow): string | null => {
    if (!versions.has(b.id)) versions = new Map([...versions, ...currentVersionIds([b])]);
    return versions.get(b.id) ?? null;
  };

  // the attributes of items, for $attr() in formulas
  const attr = async (provider: string, sku: string, key: string): Promise<string | null> => {
    const b = bookFor(provider);
    const vid = b && versionOf(b);
    if (!vid) return null;
    entries.load(vid, [sku]);
    const e = pick(entries.get(vid, sku), '', `${x.appliesFrom ?? thisMonth(Date.now())}`);
    if (!e || e === 'ambiguous') return null;
    return e.attributes.find((a) => a.key === key)?.value ?? null;
  };

  // quantities: the calculator (three scenarios when inputs are ranges) and the lines by hand
  let ranged = false;
  const lines = new Map<string, LineQ>();
  const add = (k: number, c: CalculatedLine | LineQ) => {
    const have = lines.get(c.key);
    const q = 'quantity' in c ? c.quantity : c.q[k]!;
    if (have) {
      have.q[k] = q;
      return;
    }
    const z: [bigint, bigint, bigint] = [0n, 0n, 0n];
    z[k] = q;
    lines.set(c.key, { key: c.key, label: c.label, group: c.group, provider: c.provider, sku: c.sku, priceId: c.priceId, unit: c.unit, q: z });
  };
  if (def) {
    const ins = resolveInputs(def, x.inputs);
    ranged = ins.ranged;
    if (ranged) {
      const runs = [] as CalculatedLine[][];
      for (const k of [1, 0, 2]) runs[k] = await evaluate(def, ins.scenarios[k]!, deadline, attr);
      for (const k of [1, 0, 2]) for (const c of runs[k]!) add(k, c);
    } else {
      const one = await evaluate(def, ins.scenarios[1], deadline, attr);
      for (const c of one) for (const k of [0, 1, 2]) add(k, c);
    }
  }
  for (const [i, h] of x.lines.entries()) {
    const key = h.key ?? `h${i + 1}`;
    if (lines.has(key)) throw new HttpError(400, `Two lines are called ${key}`, 'COST_CALCULATOR_INPUT', { key, message: 'a line key once' });
    const q =
      typeof h.quantity === 'string'
        ? [parseQuantity(h.quantity)!, parseQuantity(h.quantity)!, parseQuantity(h.quantity)!]
        : [parseQuantity(h.quantity.low)!, parseQuantity(h.quantity.expected)!, parseQuantity(h.quantity.high)!];
    if (!(q[0]! <= q[1]! && q[1]! <= q[2]!))
      throw new HttpError(400, `Line ${key}: low ≤ expected ≤ high`, 'COST_RANGE_ORDER', {
        key,
        low: formatQuantity(q[0]!),
        expected: formatQuantity(q[1]!),
        high: formatQuantity(q[2]!),
      });
    if (q[0] !== q[2]) ranged = true;
    lines.set(key, {
      key,
      label: h.label ?? '',
      group: h.group ?? '',
      provider: h.provider,
      sku: h.sku,
      priceId: h.priceId ?? '',
      unit: h.unit,
      q: q as [bigint, bigint, bigint],
    });
  }
  if (lines.size > COST_ESTIMATE_LIMITS.lines)
    throw new HttpError(400, `An estimate has at most ${COST_ESTIMATE_LIMITS.lines} lines`, 'COST_ESTIMATE_LIMIT', {
      max: COST_ESTIMATE_LIMITS.lines,
      what: 'lines',
    });

  // the entries: one statement per book (and round of credit items)
  const skusByVersion = new Map<string, Set<string>>();
  const want = (b: BookRow | null, sku: string) => {
    const vid = b && versionOf(b);
    if (!vid) return;
    skusByVersion.set(vid, (skusByVersion.get(vid) ?? new Set()).add(sku));
  };
  for (const l of lines.values()) {
    const b = bookFor(l.provider);
    want(b, l.sku);
    if (b && b.kind !== 'list') want(listOf(l.provider), l.sku);
  }
  for (const [vid, skus] of skusByVersion) {
    entries.load(vid, skus);
    entries.chains(vid);
  }

  // adjustments: a line's own, else the estimate's
  const adj = x.adjustments as CostAdjustment[];
  const whole = adj.filter((a) => !a.line);
  if (whole.length > 1)
    throw new HttpError(400, 'One adjustment for the whole estimate', 'COST_CALCULATOR_INPUT', { key: 'adjustments', message: 'one for the whole estimate' });
  const perLine = new Map<string, CostAdjustment>();
  for (const a of adj.filter((y) => !!y.line)) {
    if (perLine.has(a.line!))
      throw new HttpError(400, `One adjustment per line (${a.line})`, 'COST_CALCULATOR_INPUT', { key: 'adjustments', message: `one per line (${a.line})` });
    perLine.set(a.line!, a);
  }

  const appliesFrom = x.appliesFrom ?? thisMonth(Date.now());
  const fx = new FxTable(today(Date.now()));
  const ratesUsed = new Map<string, { from: string; to: string; rate: string; date: string }>();
  const toCurrency = (key: string, micros: [bigint, bigint, bigint], currency: string) => {
    if (currency === x.currency) return { micros, fx: null };
    const r = fx.rate(currency, x.currency);
    if (!r)
      throw new HttpError(400, `No exchange rate from ${currency} to ${x.currency}`, 'COST_FX_RATE_MISSING', { from: currency, to: x.currency, line: key });
    const use = { from: currency, to: x.currency, rate: formatPrice(r.rate), date: r.date };
    ratesUsed.set(`${currency}>${x.currency}`, use);
    return { micros: micros.map((m) => convertAmount(m, r.rate)) as [bigint, bigint, bigint], fx: { from: currency, rate: use.rate, date: r.date } };
  };
  const adjust = (
    l: LineQ,
    entryUnit: string,
    micros: [bigint, bigint, bigint],
  ): { micros: [bigint, bigint, bigint]; a: CostAdjustment | null; scope: 'line' | 'estimate' | null } => {
    const a = perLine.get(l.key) ?? whole[0] ?? null;
    if (!a) return { micros, a: null, scope: null };
    const scope = perLine.has(l.key) ? 'line' : 'estimate';
    if (a.kind === 'percent') return { micros: micros.map((m) => adjustByPercent(m, parsePercent(a.percent!)!)) as [bigint, bigint, bigint], a, scope };
    const spec = { price: parsePrice(a.price!)!, block: BigInt(a.block), tiers: null, tierMode: 'graduated' as const, included: 0n, minimum: null };
    const q = l.q.map((v) => convertQuantity(v, l.unit, entryUnit) ?? v);
    const fixed = q.map((v) => priceQuantity(v, spec, true)) as [bigint, bigint, bigint];
    return { micros: toCurrency(l.key, fixed, a.currency!).micros, a, scope };
  };

  const found = new Map<string, string>();
  const versionIds = new Set<string>();
  const out: StoredLine[] = [];
  const monthsOf = Array.from({ length: COST_ESTIMATE_LIMITS.horizonMonths }, (_, i) => shiftMonth(appliesFrom, i));
  // per month: the signature of what priced each line (a projection only when it changes)
  const sigs: string[][] = monthsOf.map(() => []);
  const monthTotals = new Map<string, { s: Triple; g: [string, number][] }>();
  const usedBooks = new Map<string, StoredResult['books'][number]>();
  for (const l of lines.values()) {
    const b = bookFor(l.provider);
    const vid = b && versionOf(b);
    const base: Omit<StoredLine, 'q' | 'cr' | 'f' | 'a' | 'l'> = {
      key: l.key,
      label: l.label,
      group: l.group,
      provider: l.provider,
      sku: l.sku,
      priceId: l.priceId,
      name: '',
      charge: null,
      unit: l.unit,
      creditSku: null,
      book: null,
      unitPrice: null,
      block: 1,
      priceCurrency: null,
      tiered: false,
      fx: null,
      adjustment: null,
      fixedMoved: null,
      missing: null,
    };
    const qText = l.q.map(formatQuantity) as [string, string, string];
    if (!b || !vid) {
      out.push({ ...base, missing: 'noBook', q: qText, cr: null, f: null, a: null, l: null });
      for (const s of sigs) s.push('-');
      continue;
    }
    const p = priceIn(entries, vid, l, appliesFrom);
    if (p === 'unit') {
      const e = pick(entries.get(vid, l.sku), l.priceId, appliesFrom) as CostPriceEntry;
      throw new HttpError(400, `Line ${l.key}: ${l.unit} cannot become ${e.unit}`, 'COST_PRICE_UNIT_MISMATCH', {
        line: l.key,
        from: l.unit,
        to: e.unit,
        sku: l.sku,
      });
    }
    if (typeof p === 'string') {
      out.push({
        ...base,
        missing: p,
        book: { id: b.id, name: b.name, kind: b.kind, version: Number(b.current_version) },
        q: qText,
        cr: null,
        f: null,
        a: null,
        l: null,
      });
      for (const s of sigs) s.push('-');
      continue;
    }
    versionIds.add(vid);
    usedBooks.set(b.id, { id: b.id, name: b.name, kind: b.kind as CostPriceBookKind, version: Number(b.current_version), provider: b.provider, hidden: false });
    const conv = toCurrency(l.key, p.micros, p.currency);
    const adjusted = adjust(l, p.entry.unit, conv.micros);
    const qItem = l.q.map((v) => convertQuantity(v, l.unit, p.entry.unit) ?? v);
    found.set(l.key, p.entry.price);
    const fixedWas = adjusted.a?.kind === 'price' ? o.fixedFound?.get(l.key) : undefined;
    // the list price, for readers who may not see this book (priceHidden)
    let listAlt: StoredLine['l'] = null;
    const lb = b.kind !== 'list' ? listOf(l.provider) : null;
    const lvid = lb && versionOf(lb);
    if (lb && lvid) {
      const lp = priceIn(entries, lvid, l, appliesFrom);
      if (typeof lp !== 'string') {
        const lc = fx.rate(lp.currency, x.currency);
        if (lp.currency === x.currency || lc) {
          const lconv = lp.currency === x.currency ? lp.micros : (lp.micros.map((m) => convertAmount(m, lc!.rate)) as [bigint, bigint, bigint]);
          const ladj = adjust(l, lp.entry.unit, lconv);
          versionIds.add(lvid);
          listAlt = {
            a: triple((k) => checked(l.key, ladj.micros[k]!)),
            unitPrice: lp.entry.price,
            bookId: lb.id,
            bookName: lb.name,
            version: Number(lb.current_version),
          };
        }
      }
    }
    out.push({
      ...base,
      name: p.entry.name,
      charge: p.entry.charge as CostPriceCharge,
      unit: p.entry.unit,
      creditSku: p.credits ? p.entry.creditSku : null,
      book: { id: b.id, name: b.name, kind: b.kind as CostPriceBookKind, version: Number(b.current_version) },
      unitPrice: p.entry.price,
      block: p.entry.block,
      priceCurrency: p.entry.currency ?? (p.entry.creditSku ? `{${p.entry.creditSku}}` : null),
      tiered: !!p.entry.tiers?.length,
      fx: conv.fx,
      adjustment: adjusted.a
        ? {
            scope: adjusted.scope!,
            kind: adjusted.a.kind,
            value: adjusted.a.kind === 'percent' ? adjusted.a.percent! : formatPrice(parsePrice(adjusted.a.price!)!),
            currency: adjusted.a.kind === 'price' ? (adjusted.a.currency ?? null) : null,
            block: adjusted.a.block,
            reason: adjusted.a.reason,
          }
        : null,
      fixedMoved: fixedWas && fixedWas !== p.entry.price ? { was: fixedWas, now: p.entry.price } : null,
      q: qItem.map(formatQuantity) as [string, string, string],
      cr: p.credits ? (p.credits.map(formatQuantity) as [string, string, string]) : null,
      f: triple((k) => checked(l.key, conv.micros[k]!)),
      a: triple((k) => checked(l.key, adjusted.micros[k]!)),
      l: listAlt,
    });
    // the months ahead: what prices the line in each (a new entry valid from a month changes its signature)
    monthsOf.forEach((m, i) => {
      if (i === 0) return void sigs[0]!.push(p.sig);
      const pm = priceIn(entries, vid, l, m);
      sigs[i]!.push(typeof pm === 'string' ? '-' : pm.sig);
    });
  }
  // the projection, only when a price changes within the 36 months
  const lineByKey = new Map(out.map((s) => [s.key, s]));
  const changes = sigs.some((s) => s.join('\n') !== sigs[0]!.join('\n'));
  let months: StoredResult['months'] = null;
  if (changes) {
    months = [];
    for (const [i, m] of monthsOf.entries()) {
      const sig = sigs[i]!.join('\n');
      let t = monthTotals.get(sig);
      if (!t) {
        const sum: [bigint, bigint, bigint] = [0n, 0n, 0n];
        const groups = new Map<string, bigint>();
        for (const l of lines.values()) {
          const st = lineByKey.get(l.key)!;
          if (!st.a || st.charge === 'oneOff') continue;
          const b = bookFor(l.provider)!;
          const p = priceIn(entries, versionOf(b)!, l, m);
          if (typeof p === 'string') continue;
          const conv = toCurrency(l.key, p.micros, p.currency);
          const adjusted = adjust(l, p.entry.unit, conv.micros);
          for (let k = 0; k < 3; k++) sum[k]! += adjusted.micros[k]!;
          groups.set(l.group, (groups.get(l.group) ?? 0n) + adjusted.micros[1]);
        }
        t = { s: triple((k) => checked('months', sum[k]!)), g: [...groups].map(([g, v]) => [g, checked('months', v)] as [string, number]) };
        monthTotals.set(sig, t);
      }
      months.push({ month: m, s: t.s, g: t.g });
    }
  }
  const result: StoredResult = {
    calculatedAt: nowIso(),
    calculatedBy: currentActor(),
    currency: x.currency,
    appliesFrom,
    hoursPerMonth: HOURS_PER_MONTH,
    calculator,
    ranged,
    adjusted: out.some((l) => !!l.adjustment),
    lines: out,
    months,
    books: [...usedBooks.values()],
    rates: [...ratesUsed.values()],
    missing: out.filter((l) => l.missing).length,
    versionIds: [...versionIds],
  };
  return { result, versionIds: [...versionIds], found };
}

// ---------- what a reader sees ----------

const sumLines = (lines: readonly { charge: CostPriceCharge | null; s: Triple | null }[], charges: readonly CostPriceCharge[]): Triple => {
  const t: Triple = [0, 0, 0];
  for (const l of lines) if (l.s && l.charge && charges.includes(l.charge)) for (let k = 0; k < 3; k++) t[k]! += l.s[k]!;
  return t;
};

/**
 * The stored result as `canSee` lets a reader see it: a line priced from a book they may not read is shown at the list
 * price (priceHidden) – or left out when there is none (incomplete) – and the totals are the sums of what is shown;
 * the 36-month projection is left out then (it follows the hidden prices).
 */
export function viewResult(r: StoredResult, canSee: (bookId: string) => boolean): CostEstimateResult {
  let atList = false;
  let incomplete = false;
  const shown: { line: CostEstimateLine; charge: CostPriceCharge | null; s: Triple | null }[] = r.lines.map((l) => {
    const hidden = !!l.book && !l.missing && !canSee(l.book.id);
    let s = l.a;
    let line: CostEstimateLine = {
      key: l.key,
      label: l.label,
      group: l.group,
      provider: l.provider,
      sku: l.sku,
      priceId: l.priceId,
      name: l.name,
      charge: l.charge,
      quantity: qRange(l.q),
      unit: l.unit,
      credits: l.cr ? qRange(l.cr) : null,
      creditSku: l.creditSku,
      book: l.book,
      unitPrice: l.unitPrice,
      block: l.block,
      priceCurrency: l.priceCurrency,
      tiered: l.tiered,
      fx: l.fx,
      found: l.f ? rangeOf(l.f) : null,
      adjustment: l.adjustment,
      fixedMoved: l.fixedMoved,
      amount: l.a ? rangeOf(l.a) : null,
      priceHidden: false,
      missing: l.missing,
    };
    if (hidden) {
      if (l.l) {
        atList = true;
        s = l.l.a;
        line = {
          ...line,
          book: { id: l.l.bookId, name: l.l.bookName, kind: 'list', version: l.l.version },
          unitPrice: l.l.unitPrice,
          credits: null,
          creditSku: null,
          found: null,
          fixedMoved: null,
          amount: rangeOf(l.l.a),
          priceHidden: true,
        };
      } else {
        incomplete = true;
        s = null;
        line = { ...line, book: null, unitPrice: null, credits: null, creditSku: null, found: null, fixedMoved: null, amount: null, priceHidden: true };
      }
    }
    return { line, charge: l.charge, s };
  });
  const usage = sumLines(shown, ['usage']);
  const recurring = sumLines(shown, ['recurring']);
  const oneOff = sumLines(shown, ['oneOff']);
  const monthly = triple((k) => usage[k]! + recurring[k]!);
  const hiddenAny = atList || incomplete;
  return {
    calculatedAt: r.calculatedAt,
    calculatedBy: r.calculatedBy,
    currency: r.currency,
    appliesFrom: r.appliesFrom,
    hoursPerMonth: r.hoursPerMonth,
    calculator: r.calculator,
    ranged: r.ranged,
    adjusted: r.adjusted,
    lines: shown.map((x) => x.line),
    totals: { monthly: rangeOf(monthly), usage: rangeOf(usage), recurring: rangeOf(recurring), oneOff: rangeOf(oneOff) },
    months: hiddenAny || !r.months ? null : r.months.map((m) => ({ month: m.month, monthly: rangeOf(m.s) })),
    // a book the reader may not see is not named (its lines say "priced with rates you may not see")
    books: r.books.map((b) => ({ ...b, hidden: !canSee(b.id) })).filter((b) => !b.hidden),
    rates: r.rates,
    missing: r.missing,
    atListPrice: atList,
    incomplete,
  };
}

/** The scenario totals of a stored result for one reader (comparisons, summaries). */
export function totalsOf(r: StoredResult, canSee: (bookId: string) => boolean): { monthly: Triple; oneOff: Triple } {
  const v = viewResult(r, canSee);
  const back = (c: CostRange): Triple => {
    const n = (s: string) => Number(parseQuantity(s) ?? 0n);
    return [n(c.low), n(c.expected), n(c.high)];
  };
  return { monthly: back(v.totals.monthly), oneOff: back(v.totals.oneOff) };
}

// ---------- the dry run (POST /api/costs/calculate, MCP calculate_cost_estimate) ----------

/** Up to five variants with the caller's books and rights, compared with the first; nothing is stored. */
export async function dryRun(body: unknown): Promise<CostDryRunResult> {
  const x = costDryRunInput.parse(body);
  // a definition being edited runs its formulas: who may write calculators
  if (x.variants.some((v) => v.definition !== undefined) && !mayAddCalculators())
    throw new HttpError(403, 'You are not allowed to try calculator definitions', 'FORBIDDEN', { context: 'calculator' });
  const all = () => true;
  const runs: { name: string; stored: StoredResult }[] = [];
  for (const [i, v] of x.variants.entries()) {
    const { name, ...rest } = v;
    const r = await calculateOne(rest);
    runs.push({ name: name || `Variant ${i + 1}`, stored: r.result });
  }
  // per scenario, the monthly and one-off sums of each variant (the scenario sums, not the sorted ranges)
  const sums = runs.map((r) => {
    const lines = r.stored.lines.map((l) => ({ charge: l.charge, s: l.a }));
    const usage = sumLines(lines, ['usage', 'recurring']);
    return { monthly: usage, oneOff: sumLines(lines, ['oneOff']) };
  });
  const base = sums[0]!;
  const lineKey = (l: StoredLine) => `${norm(l.provider)}|${l.sku}|${l.group}`;
  const expectedBy = (r: StoredResult) => {
    const m = new Map<string, { provider: string; sku: string; group: string; v: number }>();
    for (const l of r.lines) {
      if (!l.a) continue;
      const k = lineKey(l);
      const have = m.get(k) ?? { provider: l.provider, sku: l.sku, group: l.group, v: 0 };
      have.v += l.a[1];
      m.set(k, have);
    }
    return m;
  };
  const baseLines = expectedBy(runs[0]!.stored);
  const comparison = runs.map((r, i) => {
    const s = sums[i]!;
    const lines = expectedBy(r.stored);
    const keys = new Set([...baseLines.keys(), ...lines.keys()]);
    const diffs = [...keys]
      .map((k) => {
        const a = lines.get(k);
        const b = baseLines.get(k);
        const ref = a ?? b!;
        return { provider: ref.provider, sku: ref.sku, group: ref.group, d: (a?.v ?? 0) - (b?.v ?? 0) };
      })
      .filter((d) => d.d !== 0)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
      .slice(0, 10)
      .map((d) => ({ provider: d.provider, sku: d.sku, group: d.group, difference: formatMicros(BigInt(d.d)) }));
    return {
      variant: i,
      name: r.name,
      monthly: rangeOf(triple((k) => s.monthly[k]! - base.monthly[k]!)),
      oneOff: rangeOf(triple((k) => s.oneOff[k]! - base.oneOff[k]!)),
      lines: diffs,
    };
  });
  const cheapestAt = (k: number) => sums.reduce((best, s, i) => (s.monthly[k]! < sums[best]!.monthly[k]! ? i : best), 0);
  return {
    variants: runs.map((r) => ({ name: r.name, result: viewResult(r.stored, all) })),
    comparison,
    cheapest: { low: cheapestAt(0), expected: cheapestAt(1), high: cheapestAt(2) },
  };
}
