import { z } from 'zod';
import { COST_LIMITS, isoCurrencyCode } from './costs.js';
import { isCalendarDate } from './costPlans.js';

/**
 * Price books, cost drivers and units (0.21.0, ADR 0035 parts 1 and 2, docs/PRICE-BOOKS.md): items priced per unit of a
 * freely chosen driver, units after UCUM, conversion within one dimension (730 hours per month), prices in credits of
 * another item (at most two steps), tiers, an included quantity and a minimum – and the arithmetic that prices a
 * quantity exactly. Pure functions on whole numbers (`BigInt`), the same in the browser and on the server.
 *
 * - A quantity is whole millionths of its unit (rounded half away from zero), a unit price whole 10⁻¹² of its currency
 *   (or of credits) per block of 1, 1,000 or 1,000,000 units; an amount whole millionths of its currency, rounded half
 *   away from zero once, at the end – the method of the Snowflake fallback.
 * - Nothing here reads text with a regular expression: decimals are read character by character.
 */

// ---------- limits ----------

export const COST_PRICE_LIMITS = {
  books: 500,
  entriesPerVersion: 20_000,
  versionsKept: 50,
  /** Decimals of a unit price */
  priceDecimals: 12,
  tiers: 20,
  attributes: 20,
  textChars: 200,
  skuChars: 100,
  /** The CSV import */
  csvBytes: 5 * 1024 * 1024,
  csvColumns: 60,
  /** Items listed in a version's stored difference per kind of change (the counts are always complete) */
  diffListed: 2000,
  /** Review interval of a book written by hand, in days */
  reviewDaysMax: 3650,
  /** Manual exchange rates kept */
  fxRates: 2000,
} as const;

/** Hours per month of the cloud price lists (not UCUM's mean month of 730.5 hours) – stated on every estimate. */
export const HOURS_PER_MONTH = 730;
export const DAYS_PER_MONTH = 30.4167;

// ---------- decimals ----------

const TEN = 10n;
export const PRICE_SCALE = 10n ** 12n;
export const QTY_SCALE = 1_000_000n;

/** Division of whole numbers, rounded half away from zero. */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a + d / 2n) / d;
  return neg ? -q : q;
}

/**
 * A decimal as text (or a finite number) → whole units of 10^-scale, rounded half away from zero; null when it is not a
 * number, has more than `maxInt` digits before the point, or (with `exact`) more than `scale` decimals. "1.2E-5",
 * " -3 " and "+4.50" are read. Character by character, no regular expression.
 */
export function parseScaled(text: string | number | null | undefined, scale: number, o: { maxInt?: number; exact?: boolean } = {}): bigint | null {
  if (text === null || text === undefined) return null;
  let s: string;
  if (typeof text === 'number') {
    if (!Number.isFinite(text)) return null;
    // 17 significant digits keep every double as it is
    s = text.toPrecision(17);
  } else s = String(text).trim();
  if (!s || s.length > 80) return null;
  let neg = false;
  if (s[0] === '-' || s[0] === '+') {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  let exp = 0;
  let e = -1;
  for (let i = 0; i < s.length; i++) if (s[i] === 'e' || s[i] === 'E') e = i;
  if (e >= 0) {
    const ex = s.slice(e + 1);
    s = s.slice(0, e);
    let i = 0;
    let eneg = false;
    if (ex[0] === '-' || ex[0] === '+') {
      eneg = ex[0] === '-';
      i = 1;
    }
    if (i >= ex.length || ex.length - i > 3) return null;
    for (let k = i; k < ex.length; k++) if (ex[k]! < '0' || ex[k]! > '9') return null;
    exp = Number(ex.slice(i)) * (eneg ? -1 : 1);
  }
  let int = '';
  let frac = '';
  let dot = false;
  for (const ch of s) {
    if (ch === '.') {
      if (dot) return null;
      dot = true;
    } else if (ch >= '0' && ch <= '9') {
      if (dot) frac += ch;
      else int += ch;
    } else return null;
  }
  if (!int && !frac) return null;
  let digits = int + frac;
  let point = int.length + exp;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const whole = (digits.slice(0, point) || '0').replace(/^0+(?=\d)/, '');
  let rest = digits.slice(point);
  // a number given as a double: its last digits are noise beyond the scale
  if (typeof text !== 'number') {
    let r = rest.length;
    while (r > 0 && rest[r - 1] === '0') r--;
    rest = rest.slice(0, r);
    if (o.exact && rest.length > scale) return null;
  }
  if (whole.length > (o.maxInt ?? 15)) return null;
  let v = BigInt(whole) * TEN ** BigInt(scale) + BigInt((rest + '0'.repeat(scale)).slice(0, scale) || '0');
  if (rest.length > scale && rest[scale]! >= '5') v += 1n;
  return neg ? -v : v;
}

/** Whole units of 10^-scale → a decimal string with at least `min` and at most `scale` decimals. */
export function formatScaled(v: bigint, scale: number, min = 0): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const f = TEN ** BigInt(scale);
  const whole = (a / f).toString();
  let frac = (a % f).toString().padStart(scale, '0');
  while (frac.length > min && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${neg && a !== 0n ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** A unit price ("0.000001234567") → whole 10^-12; null when not a price (more than 12 decimals, too large). */
export const parsePrice = (text: string | number | null | undefined): bigint | null =>
  parseScaled(text, COST_PRICE_LIMITS.priceDecimals, { maxInt: 12, exact: typeof text !== 'number' });
export const formatPrice = (v: bigint): string => formatScaled(v, 12, 2);
/** A quantity → whole millionths of its unit, rounded half away from zero. */
export const parseQuantity = (text: string | number | null | undefined): bigint | null => parseScaled(text, 6, { maxInt: 18 });
export const formatQuantity = (v: bigint): string => formatScaled(v, 6, 0);
/** Whole millionths of a currency → "12.345678" (all decimals; display rounds to the currency's minor units). */
export const formatMicros = (v: bigint): string => formatScaled(v, 6, 2);

// ---------- units (UCUM) ----------

/**
 * Units are UCUM codes where possible (ADR 0035 decision 2): `By` with SI and binary prefixes (`GBy` and `GiBy` differ),
 * `bit`, time (`s`, `min`, `h`, `d`, `wk`, `mo` with 730 hours, `a` with 12 months), `1` for a plain count; counted
 * things are annotations in braces (`{request}`, `{msg}`, `{credit}`, `{eCKU}`) that never convert into each other. A
 * unit is a product of terms joined by `.`, optionally divided by one more product after a single `/`: `GBy.mo`,
 * `MBy/s`, `{msg}/s`, `{eCKU}.h`, `{seat}.mo`.
 */
interface Atom {
  dim: string;
  /** Size in the base unit of its dimension, as a fraction */
  num: bigint;
  den: bigint;
  prefixes: boolean;
}

const MONTH_S = BigInt(HOURS_PER_MONTH * 3600);
const ATOMS: ReadonlyMap<string, Atom> = new Map([
  ['By', { dim: 'By', num: 1n, den: 1n, prefixes: true }],
  ['bit', { dim: 'By', num: 1n, den: 8n, prefixes: true }],
  ['s', { dim: 's', num: 1n, den: 1n, prefixes: false }],
  ['min', { dim: 's', num: 60n, den: 1n, prefixes: false }],
  ['h', { dim: 's', num: 3600n, den: 1n, prefixes: false }],
  ['d', { dim: 's', num: 86_400n, den: 1n, prefixes: false }],
  ['wk', { dim: 's', num: 604_800n, den: 1n, prefixes: false }],
  ['mo', { dim: 's', num: MONTH_S, den: 1n, prefixes: false }],
  ['a', { dim: 's', num: MONTH_S * 12n, den: 1n, prefixes: false }],
  ['1', { dim: '', num: 1n, den: 1n, prefixes: false }],
]);
const PREFIXES: ReadonlyMap<string, bigint> = new Map([
  ['k', 10n ** 3n],
  ['M', 10n ** 6n],
  ['G', 10n ** 9n],
  ['T', 10n ** 12n],
  ['P', 10n ** 15n],
  ['E', 10n ** 18n],
  ['Ki', 1024n],
  ['Mi', 1024n ** 2n],
  ['Gi', 1024n ** 3n],
  ['Ti', 1024n ** 4n],
  ['Pi', 1024n ** 5n],
]);

export interface ParsedUnit {
  /** The unit as written */
  code: string;
  /** Dimension → exponent (annotations are their own dimension, `{msg}`) */
  dims: ReadonlyMap<string, number>;
  /** Size in the base units, as a fraction */
  num: bigint;
  den: bigint;
}

const isAnnotationChar = (c: string) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_' || c === ' ' || c === '#';

function termOf(t: string): { dim: string; num: bigint; den: bigint } | null {
  if (!t) return null;
  if (t[0] === '{') {
    if (t[t.length - 1] !== '}' || t.length < 3 || t.length > 42) return null;
    const inner = t.slice(1, -1);
    for (const c of inner) if (!isAnnotationChar(c)) return null;
    return { dim: `{${inner}}`, num: 1n, den: 1n };
  }
  const plain = ATOMS.get(t);
  if (plain) return { dim: plain.dim, num: plain.num, den: plain.den };
  for (const len of [2, 1]) {
    const p = PREFIXES.get(t.slice(0, len));
    const a = ATOMS.get(t.slice(len));
    if (p && a?.prefixes) return { dim: a.dim, num: a.num * p, den: a.den };
  }
  return null;
}

const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};

/** Reads a unit; null when it is not one Steward knows (an unknown atom, a second `/`, a stray character). */
export function parseUnit(code: string): ParsedUnit | null {
  const s = code.trim();
  if (!s || s.length > 60) return null;
  // the slash outside braces
  let slash = -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '/' && depth === 0) {
      if (slash >= 0) return null;
      slash = i;
    }
    if (depth < 0 || depth > 1) return null;
  }
  if (depth !== 0) return null;
  const split = (part: string): string[] | null => {
    const out: string[] = [];
    let cur = '';
    let inBrace = false;
    for (const c of part) {
      if (c === '{') inBrace = true;
      if (c === '}') inBrace = false;
      if (c === '.' && !inBrace) {
        out.push(cur);
        cur = '';
      } else cur += c;
    }
    out.push(cur);
    return out.some((x) => !x) ? null : out;
  };
  const top = split(slash >= 0 ? s.slice(0, slash) : s);
  const bottom = slash >= 0 ? split(s.slice(slash + 1)) : [];
  if (!top || !bottom) return null;
  const dims = new Map<string, number>();
  let num = 1n;
  let den = 1n;
  for (const [terms, sign] of [
    [top, 1],
    [bottom, -1],
  ] as const) {
    for (const t of terms) {
      const x = termOf(t);
      if (!x) return null;
      if (x.dim) dims.set(x.dim, (dims.get(x.dim) ?? 0) + sign);
      if (sign > 0) {
        num *= x.num;
        den *= x.den;
      } else {
        num *= x.den;
        den *= x.num;
      }
    }
  }
  for (const [k, v] of [...dims]) if (v === 0) dims.delete(k);
  const g = gcd(num, den);
  return { code: s, dims, num: num / g, den: den / g };
}

const sameDims = (a: ParsedUnit, b: ParsedUnit) => a.dims.size === b.dims.size && [...a.dims].every(([k, v]) => b.dims.get(k) === v);

/** Whether a quantity in `from` can be expressed in `to` (the same dimension; annotations only as themselves). */
export function unitsConvert(from: string, to: string): boolean {
  const a = parseUnit(from);
  const b = parseUnit(to);
  return !!a && !!b && sameDims(a, b);
}

/** A quantity (millionths) in `from` → millionths in `to`, rounded half away from zero; null when they do not convert. */
export function convertQuantity(micros: bigint, from: string, to: string): bigint | null {
  if (from.trim() === to.trim()) return micros;
  const a = parseUnit(from);
  const b = parseUnit(to);
  if (!a || !b || !sameDims(a, b)) return null;
  return roundDiv(micros * a.num * b.den, a.den * b.num);
}

/** A unit for people: annotations without their braces (`{msg}/s` → msg/s). */
export const unitLabel = (code: string): string => code.replace(/[{}]/g, '');

/** The suggested drivers of the forms (ADR 0035 part 1): a name (translated in the web app) and a unit. Any other may be added. */
export const COST_DRIVER_SUGGESTIONS = [
  { key: 'gbWritten', unit: 'GBy' },
  { key: 'gbRead', unit: 'GBy' },
  { key: 'storage', unit: 'GBy.mo' },
  { key: 'throughput', unit: 'MBy/s' },
  { key: 'messages', unit: '{msg}/s' },
  { key: 'requests', unit: '{request}' },
  { key: 'runtime', unit: 'h' },
  { key: 'eckuHours', unit: '{eCKU}.h' },
  { key: 'partitions', unit: '{partition}.h' },
  { key: 'connectorTasks', unit: '{task}.h' },
  { key: 'seats', unit: '{seat}.mo' },
  { key: 'credits', unit: '{credit}' },
  { key: 'tokens', unit: '{token}' },
  { key: 'subscription', unit: '{subscription}.mo' },
] as const;

/** The units of the suggestions and how they convert (list_cost_units, the forms' hints). */
export const COST_UNIT_SUGGESTIONS = [
  'By',
  'kBy',
  'MBy',
  'GBy',
  'TBy',
  'KiBy',
  'MiBy',
  'GiBy',
  'TiBy',
  's',
  'min',
  'h',
  'd',
  'mo',
  'GBy.mo',
  'TBy.mo',
  'GiBy.mo',
  'MBy/s',
  'GBy/h',
  '{msg}/s',
  '{request}',
  '{credit}',
  '{eCKU}.h',
  '{seat}.mo',
  '{token}',
] as const;

// ---------- price book entries ----------

export const COST_PRICE_BOOK_KINDS = ['list', 'contracted'] as const;
export type CostPriceBookKind = (typeof COST_PRICE_BOOK_KINDS)[number];
/** How a version came to be: by hand, a CSV import, the migration of the Snowflake fallback's price, a source read (phase 2) */
export const COST_PRICE_VERSION_SOURCES = ['manual', 'csv', 'migration', 'source'] as const;
export type CostPriceVersionSource = (typeof COST_PRICE_VERSION_SOURCES)[number];
export const COST_PRICE_CHARGES = ['usage', 'recurring', 'oneOff'] as const;
export type CostPriceCharge = (typeof COST_PRICE_CHARGES)[number];
export const COST_PRICE_BLOCKS = [1, 1000, 1_000_000] as const;
export type CostPriceBlock = (typeof COST_PRICE_BLOCKS)[number];
export const COST_TIER_MODES = ['graduated', 'volume'] as const;
export type CostTierMode = (typeof COST_TIER_MODES)[number];

export interface CostPriceTier {
  /** The quantity per month (after the included quantity) from which this band's price applies; the first band from 0 */
  from: string;
  price: string;
}

export interface CostPriceAttribute {
  key: string;
  value: string;
}

/** An item with its price (a row of a version). */
export interface CostPriceEntry {
  sku: string;
  /** '' when the SKU has one price */
  priceId: string;
  name: string;
  service: string;
  category: string;
  driver: string;
  unit: string;
  charge: CostPriceCharge;
  /** Per block, with up to 12 decimals, in `currency` – or in credits of `creditSku` */
  price: string;
  block: CostPriceBlock;
  currency: string | null;
  creditSku: string | null;
  tiers: CostPriceTier[] | null;
  tierMode: CostTierMode;
  included: string | null;
  minimum: string | null;
  validFrom: string | null;
  validTo: string | null;
  attributes: CostPriceAttribute[];
  sourceNote: string;
}

/** The key of an entry within a version: SKU, price id and the first day it applies. */
export const entryKey = (e: Pick<CostPriceEntry, 'sku' | 'priceId' | 'validFrom'>): string => `${e.sku}\u0000${e.priceId}\u0000${e.validFrom ?? ''}`;

const text = (max: number = COST_PRICE_LIMITS.textChars) => z.string().trim().max(max);
const decimalText = (what: string, check: (s: string) => boolean) =>
  z
    .union([z.string().trim().max(40), z.number()])
    .transform((v) => String(v).trim())
    .refine((s) => s !== '' && check(s), what);
const priceText = decimalText('a price with at most 12 decimals', (s) => parsePrice(s) !== null);
const quantityText = decimalText('a quantity of at least 0', (s) => {
  const q = parseQuantity(s);
  return q !== null && q >= 0n;
});
const dateText = z
  .string()
  .trim()
  .refine((s) => isCalendarDate(s), 'a date YYYY-MM-DD');
const unitText = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((s) => parseUnit(s) !== null, 'a unit such as GBy, h, GBy.mo, MBy/s or {request}');

export const costPriceEntryInput = z
  .object({
    sku: text(COST_PRICE_LIMITS.skuChars).min(1),
    priceId: text(COST_PRICE_LIMITS.skuChars).default(''),
    name: text().min(1),
    service: text().default(''),
    category: text().default(''),
    driver: text().default(''),
    unit: unitText,
    charge: z.enum(COST_PRICE_CHARGES).default('usage'),
    price: priceText,
    block: z.union([z.literal(1), z.literal(1000), z.literal(1_000_000)]).default(1),
    currency: isoCurrencyCode.nullable().default(null),
    creditSku: text(COST_PRICE_LIMITS.skuChars).min(1).nullable().default(null),
    tiers: z
      .array(z.object({ from: quantityText, price: priceText }).strict())
      .max(COST_PRICE_LIMITS.tiers)
      .nullable()
      .default(null),
    tierMode: z.enum(COST_TIER_MODES).default('graduated'),
    included: quantityText.nullable().default(null),
    minimum: priceText.nullable().default(null),
    validFrom: dateText.nullable().default(null),
    validTo: dateText.nullable().default(null),
    attributes: z
      .array(z.object({ key: text(60).min(1), value: text() }).strict())
      .max(COST_PRICE_LIMITS.attributes)
      .default([]),
    sourceNote: text(500).default(''),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (!e.currency === !e.creditSku)
      ctx.addIssue({ code: 'custom', path: ['currency'], message: 'a currency, or a credit item of the same book – one of the two' });
    if (e.creditSku && e.creditSku === e.sku) ctx.addIssue({ code: 'custom', path: ['creditSku'], message: 'an item cannot be priced in itself' });
    if (e.tiers?.length) {
      const from = e.tiers.map((t) => parseQuantity(t.from)!);
      if (from[0] !== 0n) ctx.addIssue({ code: 'custom', path: ['tiers', 0, 'from'], message: 'the first band starts at 0' });
      for (let i = 1; i < from.length; i++) if (from[i]! <= from[i - 1]!) ctx.addIssue({ code: 'custom', path: ['tiers', i, 'from'], message: 'bands rise' });
    }
    if (e.validFrom && e.validTo && e.validTo < e.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'on or after the first day' });
    const keys = new Set<string>();
    for (const [i, a] of e.attributes.entries()) {
      if (keys.has(a.key)) ctx.addIssue({ code: 'custom', path: ['attributes', i, 'key'], message: 'once per item' });
      keys.add(a.key);
    }
  });
export type CostPriceEntryInput = z.input<typeof costPriceEntryInput>;

/** An entry as parsed (numbers normalised): what a version stores. */
export function normaliseEntry(e: z.output<typeof costPriceEntryInput>): CostPriceEntry {
  return {
    sku: e.sku,
    priceId: e.priceId,
    name: e.name,
    service: e.service,
    category: e.category,
    driver: e.driver,
    unit: e.unit,
    charge: e.charge,
    price: formatPrice(parsePrice(e.price)!),
    block: e.block,
    currency: e.currency,
    creditSku: e.creditSku,
    tiers: e.tiers?.length ? e.tiers.map((t) => ({ from: formatQuantity(parseQuantity(t.from)!), price: formatPrice(parsePrice(t.price)!) })) : null,
    tierMode: e.tierMode,
    included: e.included === null ? null : formatQuantity(parseQuantity(e.included)!),
    minimum: e.minimum === null ? null : formatPrice(parsePrice(e.minimum)!),
    validFrom: e.validFrom,
    validTo: e.validTo,
    attributes: e.attributes,
    sourceNote: e.sourceNote,
  };
}

/**
 * The problems of a whole version (ADR 0035 part 1): two entries with the same key, overlapping validity of one SKU and
 * price id, a credit item that is not in the book or is priced in credits more than two steps deep, a loop, a credit
 * item whose unit is not the unit the price is in. Empty: fine.
 */
export function versionProblems(entries: readonly CostPriceEntry[]): { code: 'duplicate' | 'overlap' | 'chain'; sku: string; message: string }[] {
  const out: { code: 'duplicate' | 'overlap' | 'chain'; sku: string; message: string }[] = [];
  const seen = new Set<string>();
  const bySku = new Map<string, CostPriceEntry[]>();
  for (const e of entries) {
    const k = entryKey(e);
    if (seen.has(k)) out.push({ code: 'duplicate', sku: e.sku, message: `${e.sku}${e.priceId ? ` (${e.priceId})` : ''} is in the book twice` });
    seen.add(k);
    const list = bySku.get(e.sku) ?? [];
    list.push(e);
    bySku.set(e.sku, list);
  }
  for (const [sku, list] of bySku) {
    const byPrice = new Map<string, CostPriceEntry[]>();
    for (const e of list) byPrice.set(e.priceId, [...(byPrice.get(e.priceId) ?? []), e]);
    for (const same of byPrice.values()) {
      const sorted = [...same].sort((a, b) => (a.validFrom ?? '').localeCompare(b.validFrom ?? ''));
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        if (!prev.validTo || prev.validTo >= (sorted[i]!.validFrom ?? '')) {
          out.push({ code: 'overlap', sku, message: `the prices of ${sku} overlap in time – end one before the next starts` });
          break;
        }
      }
    }
  }
  // credit chains: at most two steps, no loop, the credit item exists
  const depthOf = (sku: string, path: string[]): number | 'loop' | 'missing' => {
    const e = bySku.get(sku)?.[0];
    if (!e) return 'missing';
    if (!e.creditSku) return 0;
    if (path.includes(e.creditSku)) return 'loop';
    const d = depthOf(e.creditSku, [...path, e.creditSku]);
    return typeof d === 'number' ? d + 1 : d;
  };
  for (const [sku, list] of bySku) {
    const e = list[0]!;
    if (!e.creditSku) continue;
    const d = depthOf(sku, [sku]);
    if (d === 'missing' || d === 'loop' || d > 2)
      out.push({
        code: 'chain',
        sku,
        message:
          d === 'missing'
            ? `${sku} is priced in ${e.creditSku}, which is not in the book`
            : d === 'loop'
              ? `${sku} is priced in credits that end up priced in ${sku} again`
              : `${sku} is priced in credits more than two steps deep`,
      });
  }
  return out;
}

// ---------- pricing ----------

export interface PriceSpec {
  /** Per block, 10^-12 (currency or credits) */
  price: bigint;
  block: bigint;
  tiers: { from: bigint; price: bigint }[] | null;
  tierMode: CostTierMode;
  /** Millionths of the unit free per month */
  included: bigint;
  /** 10^-12 of the currency (or credits) at least per month, when anything is used */
  minimum: bigint | null;
}

export const specOf = (e: Pick<CostPriceEntry, 'price' | 'block' | 'tiers' | 'tierMode' | 'included' | 'minimum'>): PriceSpec => ({
  price: parsePrice(e.price) ?? 0n,
  block: BigInt(e.block),
  tiers: e.tiers?.length ? e.tiers.map((t) => ({ from: parseQuantity(t.from) ?? 0n, price: parsePrice(t.price) ?? 0n })) : null,
  tierMode: e.tierMode,
  included: e.included ? (parseQuantity(e.included) ?? 0n) : 0n,
  minimum: e.minimum ? parsePrice(e.minimum) : null,
});

/**
 * What `quantity` (millionths of the item's unit, per month) costs, in millionths of the price's unit (a currency or
 * credits), rounded half away from zero once: the included quantity first, then the tiers (graduated: each band at its
 * price; volume: the whole quantity at the price of the band reached), then the block, then the minimum (only when
 * anything is used). `plain`: without included quantity and minimum – a step of a credit chain, where they belong to
 * the account's whole use.
 */
export function priceQuantity(quantity: bigint, s: PriceSpec, plain = false): bigint {
  const q0 = quantity < 0n ? 0n : quantity;
  let q = plain ? q0 : q0 - s.included;
  if (q < 0n) q = 0n;
  let n = 0n;
  if (s.tiers?.length) {
    if (s.tierMode === 'volume') {
      let price = s.tiers[0]!.price;
      for (const t of s.tiers) if (q >= t.from) price = t.price;
      n = q * price;
    } else {
      for (let i = 0; i < s.tiers.length; i++) {
        const lo = s.tiers[i]!.from;
        const hi = i + 1 < s.tiers.length ? s.tiers[i + 1]!.from : null;
        if (q <= lo) break;
        const top = hi === null || q < hi ? q : hi;
        n += (top - lo) * s.tiers[i]!.price;
      }
    }
  } else n = q * s.price;
  // millionths × 10^-12 per block → millionths of the price's unit
  let micros = roundDiv(n, PRICE_SCALE * s.block);
  if (!plain && s.minimum !== null && q0 > 0n) {
    const min = roundDiv(s.minimum, QTY_SCALE);
    if (micros < min) micros = min;
  }
  return micros;
}

/** An amount (millionths) at a rate (10^-12): converted, rounded half away from zero. */
export const convertAmount = (micros: bigint, rate: bigint): bigint => roundDiv(micros * rate, PRICE_SCALE);
/** An amount (millionths) changed by a percentage given in hundredths of a percent (−15 % = −1500). */
export const adjustByPercent = (micros: bigint, hundredths: bigint): bigint => roundDiv(micros * (10_000n + hundredths), 10_000n);
/** A percentage as text ("-15", "7.5") → hundredths of a percent; null when not one (more than two decimals). */
export const parsePercent = (text: string | number): bigint | null => parseScaled(text, 2, { maxInt: 4, exact: typeof text !== 'number' });

/** The change of a price in percent (one decimal), null when the old one was 0. */
export function changePct(before: string, after: string): number | null {
  const a = parsePrice(before);
  const b = parsePrice(after);
  if (a === null || b === null || a === 0n) return null;
  return Number(roundDiv((b - a) * 1000n, a)) / 10;
}

// ---------- books and versions (API) ----------

export const costPriceBookInput = z
  .object({
    name: text(120).min(1),
    kind: z.enum(COST_PRICE_BOOK_KINDS),
    provider: text(120).min(1),
    currency: isoCurrencyCode,
    description: text(2000).default(''),
    /** A contracted book of a platform's contract with its provider (who manages the platform maintains it) */
    platformId: z.string().trim().min(1).max(100).nullable().default(null),
    supplierId: z.string().trim().min(1).max(100).nullable().default(null),
    supplierContractId: z.string().trim().min(1).max(100).nullable().default(null),
    reviewDays: z.number().int().min(1).max(COST_PRICE_LIMITS.reviewDaysMax).default(90),
  })
  .strict();
export type CostPriceBookInput = z.input<typeof costPriceBookInput>;

/** A new version by hand: entries added or replaced (by their key), removed – or the whole book replaced. */
export const costPriceEntriesInput = z
  .object({
    mode: z.enum(['merge', 'replace']).default('merge'),
    entries: z.array(costPriceEntryInput).max(COST_PRICE_LIMITS.entriesPerVersion).default([]),
    remove: z
      .array(
        z
          .object({
            sku: text(COST_PRICE_LIMITS.skuChars).min(1),
            priceId: text(COST_PRICE_LIMITS.skuChars).default(''),
            validFrom: dateText.nullable().default(null),
          })
          .strict(),
      )
      .max(COST_PRICE_LIMITS.entriesPerVersion)
      .default([]),
    note: text(500).default(''),
  })
  .strict();
export type CostPriceEntriesInput = z.input<typeof costPriceEntriesInput>;

/** The columns of the CSV import (by header text); a currency column or one currency for the file. */
export const COST_PRICE_CSV_FIELDS = [
  'sku',
  'priceId',
  'name',
  'service',
  'category',
  'driver',
  'unit',
  'charge',
  'price',
  'block',
  'currency',
  'creditSku',
  'tiers',
  'included',
  'minimum',
  'validFrom',
  'validTo',
  'sourceNote',
] as const;
export type CostPriceCsvField = (typeof COST_PRICE_CSV_FIELDS)[number];

const header = z.string().trim().min(1).max(200).nullable().default(null);
export const costPriceCsvMapping = z
  .object({
    sku: z.string().trim().min(1).max(200),
    priceId: header,
    name: header,
    service: header,
    category: header,
    driver: header,
    unit: z.string().trim().min(1).max(200),
    charge: header,
    price: z.string().trim().min(1).max(200),
    block: header,
    currency: header,
    creditSku: header,
    tiers: header,
    included: header,
    minimum: header,
    validFrom: header,
    validTo: header,
    sourceNote: header,
    fixedCurrency: isoCurrencyCode.nullable().default(null),
    /** The decimal separator; the other one is read as a thousands separator */
    decimal: z.enum(['.', ',']).default('.'),
  })
  .strict();
export type CostPriceCsvMapping = z.infer<typeof costPriceCsvMapping>;

export const costPriceImportInput = z
  .object({
    csv: z.string().min(1).max(COST_PRICE_LIMITS.csvBytes),
    fileName: z.string().trim().max(200).default(''),
    mapping: costPriceCsvMapping,
    /** replace: the file is the whole book; add: its rows are added or replace those with the same key */
    mode: z.enum(['replace', 'add']).default('replace'),
  })
  .strict();
export type CostPriceImportInput = z.input<typeof costPriceImportInput>;

export interface CostPriceDiffItem {
  sku: string;
  priceId: string;
  validFrom: string | null;
  name: string;
  unit: string;
  currency: string | null;
  creditSku: string | null;
  block: number;
  before: string | null;
  after: string | null;
  /** The change of the price in percent; null for added and removed items or a price of 0 before */
  pct: number | null;
  /** Other fields that changed (unit, tiers, validity …) */
  fields: string[];
}

export interface CostPriceDiff {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** At most COST_PRICE_LIMITS.diffListed of each */
  items: { added: CostPriceDiffItem[]; removed: CostPriceDiffItem[]; changed: CostPriceDiffItem[] };
}

export interface CostPriceVersion {
  number: number;
  source: CostPriceVersionSource;
  sha256: string;
  entries: number;
  note: string;
  diff: CostPriceDiff | null;
  createdAt: string;
  createdBy: string;
  /** Used by an estimate (kept beyond the fifty versions per book) */
  inUse: boolean;
}

export interface CostPriceBook {
  id: string;
  name: string;
  kind: CostPriceBookKind;
  provider: string;
  currency: string;
  description: string;
  platform: { id: string; name: string } | null;
  supplier: { id: string; name: string } | null;
  supplierContract: { id: string; title: string } | null;
  source: 'manual' | 'csv';
  reviewDays: number;
  checkedAt: string | null;
  checkedBy: string | null;
  /** The review is due (last checked – or made – more than reviewDays ago) */
  reviewDue: boolean;
  version: number;
  entries: number;
  owningTeams: { id: string; name: string }[];
  canEdit: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CostPriceBookDetail extends CostPriceBook {
  items: CostPriceEntry[];
  /** More items than listed (the page asks for the next ones) */
  more: boolean;
  versions: CostPriceVersion[];
}

export interface CostPriceImportProblem {
  row: number;
  line: number;
  message: string;
}

export interface CostPriceImportPreview {
  fileName: string;
  sha256: string;
  rows: number;
  columns: string[];
  entries: number;
  problems: CostPriceImportProblem[];
  /** What the import would change against the current version */
  diff: CostPriceDiff;
  /** The first rows as read */
  sample: CostPriceEntry[];
}

// ---------- exchange rates (manual) ----------

export const costFxRateInput = z
  .object({
    date: dateText,
    base: isoCurrencyCode,
    quote: isoCurrencyCode,
    rate: decimalText('a rate above 0 with at most 12 decimals', (s) => {
      const r = parsePrice(s);
      return r !== null && r > 0n;
    }),
  })
  .strict()
  .refine((x) => x.base !== x.quote, { path: ['quote'], message: 'another currency' });
export type CostFxRateInput = z.input<typeof costFxRateInput>;

export interface CostFxRate {
  date: string;
  base: string;
  quote: string;
  rate: string;
  source: 'manual';
  setAt: string;
  setBy: string;
}

/** The largest amount a line or total may reach (millionths), as everywhere in the cost model. */
export const MAX_AMOUNT_MICROS = BigInt(COST_LIMITS.maxAmount) * QTY_SCALE;
