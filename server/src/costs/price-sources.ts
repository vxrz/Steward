import {
  CONFLUENT_KIND,
  COST_PRICE_SOURCE_KINDS,
  COST_PRICE_SOURCE_LIMITS,
  SNOWFLAKE_KIND,
  costPriceEntryInput,
  entryKey,
  formatPrice,
  normaliseEntry,
  parseQuantity,
  roundDiv,
  PRICE_SCALE,
  type CostPriceBookDetail,
  type CostPriceEntry,
  type CostPriceSourceKind,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { currentActor } from '../auth/context.js';
import { platformFor } from '../monitors/platforms.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { bookRow, getBook, requireBook, writeVersion, type BookRow, entriesOfBook } from './price-books.js';
import { snowflakeAccountNames, type ConfluentCost } from './readers.js';

/**
 * Price books read from a source (0.23.0, ADR 0035 part 2, docs/PRICE-BOOKS.md#sources): a contracted book of a
 * platform kept by what the platform reports, with the discount included.
 *
 * - **Snowflake rate sheet**: `SNOWFLAKE.ORGANIZATION_USAGE.RATE_SHEET_DAILY` of the platform's account through the SQL
 *   API (a read-only statement) – the latest effective rate per service type, usage type and currency (compute per
 *   credit, storage per TB-month, data transfer per TB). Its `CONTRACT_NUMBER` names a Steward contract with that
 *   reference: the book is linked to it. Once a day. Not for reseller contracts (no organisation usage views).
 * - **Confluent, observed**: the Costs API's lines of the **last complete month** (from the 4th of the next month): per
 *   product, line type, unit and network access type the effective price Σ amount ÷ Σ quantity, with the list price and
 *   the discount (Σ discount ÷ Σ original) as attributes. Labelled observed: only what was used has a price. Monthly.
 *
 * A read goes through the platform's own client – and so through the outbound policy – with the rights of who set the
 * source (they must still be allowed to use the platform); at most 25 MB and 20,000 entries
 * (`COST_PRICE_SOURCE_TOO_LARGE`). A failed read keeps the last version and says why on the book. A read replaces the
 * entries it brought before and keeps those written by hand (the credits per hour of the warehouse sizes, say); an
 * unchanged read writes no version and only records that it read.
 */

export interface SourceSettings {
  kind?: CostPriceSourceKind;
  savedBy?: string;
  lastReadAt?: string | null;
  lastError?: string | null;
  lastNote?: string | null;
  /** Confluent: the month last read (YYYY-MM) */
  lastMonth?: string | null;
}

const LABEL: Record<CostPriceSourceKind, string> = {
  snowflakeRateSheet: 'Snowflake rate sheet',
  confluentObserved: 'Observed: Confluent Costs API',
};
const SOURCE_PLATFORM_KIND: Record<CostPriceSourceKind, string> = { snowflakeRateSheet: SNOWFLAKE_KIND, confluentObserved: CONFLUENT_KIND };
const DAY = 86_400_000;

export const settingsOf = (r: Pick<BookRow, 'source_settings'>): SourceSettings => parseJson<SourceSettings>(r.source_settings ?? '{}', {});

const tooLarge = (what: string) =>
  new HttpError(400, `${what} is larger than a price book takes (25 MB, 20,000 entries) – the last version stays`, 'COST_PRICE_SOURCE_TOO_LARGE', {
    maxEntries: COST_PRICE_SOURCE_LIMITS.entries,
    maxMb: COST_PRICE_SOURCE_LIMITS.bytes / 1024 / 1024,
  });

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .split('')
    .map((c) => ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ? c : '-'))
    .join('')
    .split('-')
    .filter(Boolean)
    .join('-')
    .slice(0, 100);

/** A row read into an entry (checked like one typed by hand); null when it is not a price. */
function entryOf(input: Record<string, unknown>): CostPriceEntry | null {
  const r = costPriceEntryInput.safeParse(input);
  return r.success ? normaliseEntry(r.data) : null;
}

// ---------- Snowflake: the rate sheet ----------

/** The rate sheet's rows as entries: compute per credit, storage per TB-month, data transfer per TB, other service types per credit. */
export function rateSheetEntries(rows: readonly Record<string, string | null>[]): {
  entries: CostPriceEntry[];
  contractNumber: string | null;
  day: string | null;
} {
  const out: CostPriceEntry[] = [];
  const seen = new Set<string>();
  let contractNumber: string | null = null;
  let day: string | null = null;
  for (const r of rows) {
    const service = String(r.SERVICE_TYPE ?? '').trim();
    const usage = String(r.USAGE_TYPE ?? '').trim();
    const currency = String(r.CURRENCY ?? '')
      .trim()
      .toUpperCase();
    const rate = String(r.EFFECTIVE_RATE ?? '').trim();
    if (!service || !usage || currency.length !== 3 || !rate) continue;
    const u = usage.toLowerCase();
    const s = service.toUpperCase();
    const compute = s === 'WAREHOUSE_METERING' && u.includes('compute');
    const storage = u.includes('storage');
    const transfer = u.includes('transfer');
    const sku = compute
      ? 'compute-credit'
      : storage && s === 'STORAGE'
        ? 'storage'
        : transfer && s === 'DATA_TRANSFER'
          ? 'data-transfer'
          : slug(`${service}-${usage}`);
    if (!sku) continue;
    const priceId = seen.has(sku) ? currency.toLowerCase() : '';
    seen.add(sku);
    const date = String(r.DATE ?? '').slice(0, 10);
    if (date && (!day || date > day)) day = date;
    if (r.CONTRACT_NUMBER && !contractNumber) contractNumber = String(r.CONTRACT_NUMBER).trim().slice(0, 100);
    const e = entryOf({
      sku,
      priceId,
      name: compute ? 'Compute credit' : `${usage} (${service})`.slice(0, 200),
      service: compute ? 'Compute' : storage ? 'Storage' : transfer ? 'Transfer' : service.slice(0, 200),
      category: 'Analytics',
      driver: storage ? 'storage' : transfer ? 'data transfer' : 'credits',
      unit: storage ? 'TBy.mo' : transfer ? 'TBy' : '{credit}',
      charge: 'usage',
      price: rate,
      currency,
      sourceNote: `${LABEL.snowflakeRateSheet} (RATE_SHEET_DAILY${date ? `, ${date}` : ''}) – the discount included`,
    });
    if (e) out.push(e);
  }
  return { entries: out, contractNumber, day };
}

async function readRateSheet(b: BookRow, actor: string): Promise<{ entries: CostPriceEntry[]; note: string; contractNumber: string | null }> {
  const { platform, secrets } = platformFor(actor, b.platform_id!);
  const { snowflakeClient } = await import('../snowflake/service.js');
  const acct = snowflakeAccountNames(platform);
  let rows: Record<string, string | null>[];
  try {
    rows = await snowflakeClient(platform, secrets).query(
      `/* steward:price-rate-sheet */ SELECT TO_VARCHAR(DATE, 'YYYY-MM-DD') AS DATE, CONTRACT_NUMBER, SERVICE_TYPE, USAGE_TYPE, CURRENCY, TO_VARCHAR(EFFECTIVE_RATE) AS EFFECTIVE_RATE
       FROM SNOWFLAKE.ORGANIZATION_USAGE.RATE_SHEET_DAILY
       WHERE DATE >= DATEADD(day, -45, CURRENT_DATE()) AND (UPPER(ACCOUNT_LOCATOR) = ? OR UPPER(ACCOUNT_NAME) = ?)
       QUALIFY ROW_NUMBER() OVER (PARTITION BY SERVICE_TYPE, USAGE_TYPE, CURRENCY ORDER BY DATE DESC) = 1
       ORDER BY SERVICE_TYPE, USAGE_TYPE, CURRENCY`,
      [acct.locator, acct.name],
    );
  } catch (e) {
    throw new Error(`The rate sheet cannot be read (ORGANIZATION_USAGE – not for reseller contracts): ${(e as Error).message.slice(0, 300)}`);
  }
  if (rows.length > COST_PRICE_SOURCE_LIMITS.entries || JSON.stringify(rows).length > COST_PRICE_SOURCE_LIMITS.bytes) throw tooLarge('The rate sheet');
  const r = rateSheetEntries(rows);
  return {
    entries: r.entries,
    contractNumber: r.contractNumber,
    note: `${LABEL.snowflakeRateSheet}: ${r.entries.length} rate(s)${r.day ? ` of ${r.day}` : ''}${r.contractNumber ? `, contract ${r.contractNumber}` : ''}`,
  };
}

// ---------- Confluent: observed rates ----------

const CONFLUENT_UNITS: ReadonlyMap<string, string> = new Map([
  ['gb', 'GBy'],
  ['gigabyte', 'GBy'],
  ['hour', 'h'],
  ['gb-hour', 'GBy.h'],
  ['gb-month', 'GBy.mo'],
]);
/** A Confluent unit ("CKU-hour", "GB", "Partition-hour") as UCUM: hours and gigabytes convert, other things are counted. */
export function confluentUnit(u: string): string {
  const k = u.trim().toLowerCase();
  const known = CONFLUENT_UNITS.get(k);
  if (known) return known;
  if (k.endsWith('-hour')) return `{${slug(u.slice(0, -5)) || 'unit'}}.h`;
  return `{${slug(u) || 'unit'}}`;
}

const sumText = (v: unknown): bigint | null => (v === undefined || v === null || v === '' ? 0n : parseQuantity(typeof v === 'number' ? v : String(v)));

export interface ConfluentPriced extends ConfluentCost {
  price?: number | string;
  quantity?: number | string;
  unit?: string;
}

/**
 * The observed rates of a month: per product, line type, unit and network access type Σ amount ÷ Σ quantity (exact, to
 * twelve decimals), with the list price and the discount (Σ discount ÷ Σ original) as attributes.
 */
export function confluentObservedEntries(items: readonly ConfluentPriced[], month: string): CostPriceEntry[] {
  const groups = new Map<
    string,
    { product: string; lineType: string; unit: string; network: string; amount: bigint; quantity: bigint; original: bigint; discount: bigint; price: string }
  >();
  for (const x of items) {
    const day = String(x.start_date ?? '').slice(0, 7);
    if (day !== month) continue;
    const product = String(x.product ?? '').slice(0, 100);
    const lineType = String(x.line_type ?? '').slice(0, 100);
    const unit = String(x.unit ?? '').slice(0, 60);
    const network = String(x.network_access_type ?? '').slice(0, 50);
    if (!lineType || !unit) continue;
    const amount = sumText(x.amount);
    const quantity = sumText(x.quantity);
    const original = sumText(x.original_amount);
    const discount = sumText(x.discount_amount);
    if (amount === null || quantity === null || original === null || discount === null) continue;
    const k = `${product}|${lineType}|${unit}|${network}`;
    const g = groups.get(k) ?? { product, lineType, unit, network, amount: 0n, quantity: 0n, original: 0n, discount: 0n, price: '' };
    g.amount += amount;
    g.quantity += quantity;
    g.original += original;
    g.discount += discount;
    if (x.price !== undefined && x.price !== null) g.price = String(x.price);
    groups.set(k, g);
  }
  const out: CostPriceEntry[] = [];
  const seen = new Set<string>();
  for (const g of groups.values()) {
    if (g.quantity <= 0n) continue;
    // millionths ÷ millionths → 10^-12 per unit
    const price = roundDiv(g.amount * PRICE_SCALE, g.quantity);
    if (price < 0n) continue;
    const sku = `${g.lineType}${g.network && g.network !== 'INTERNET' ? `-${g.network}` : ''}`.slice(0, 100);
    const priceId = seen.has(sku) ? slug(g.unit) : '';
    seen.add(sku);
    const pct = g.original > 0n ? Number(roundDiv(g.discount * 10_000n, g.original)) / 100 : null;
    const e = entryOf({
      sku,
      priceId,
      name: g.lineType.slice(0, 200),
      service: g.product,
      category: 'Integration',
      driver: g.unit.slice(0, 200),
      unit: confluentUnit(g.unit),
      charge: 'usage',
      price: formatPrice(price),
      currency: 'USD',
      attributes: [
        ...(g.price ? [{ key: 'listPrice', value: g.price.slice(0, 40) }] : []),
        ...(pct !== null ? [{ key: 'discountPercent', value: String(pct) }] : []),
        ...(g.network ? [{ key: 'networkAccess', value: g.network }] : []),
      ],
      sourceNote: `${LABEL.confluentObserved}, ${month} – only what was used has a price`,
    });
    if (e) out.push(e);
  }
  return out;
}

const previousMonth = (now: number) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

async function readObserved(b: BookRow, actor: string, now: number): Promise<{ entries: CostPriceEntry[]; note: string; month: string }> {
  const { platform, secrets } = platformFor(actor, b.platform_id!);
  const { confluentPages } = await import('../kafka/confluent.js');
  const month = previousMonth(now);
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const items = await confluentPages<ConfluentPriced>(
    platform,
    secrets,
    '/billing/v1/costs',
    { start_date: `${month}-01`, end_date: d.toISOString().slice(0, 10) },
    'The Costs API',
    'the Cloud API key needs the OrganizationAdmin or BillingAdmin role',
  );
  if (items.length > COST_PRICE_SOURCE_LIMITS.entries * 40 || JSON.stringify(items).length > COST_PRICE_SOURCE_LIMITS.bytes)
    throw tooLarge('The Costs API answer');
  const entries = confluentObservedEntries(items, month);
  if (entries.length > COST_PRICE_SOURCE_LIMITS.entries) throw tooLarge('The observed rates');
  return { entries, month, note: `${LABEL.confluentObserved}: ${entries.length} rate(s) observed in ${month}` };
}

// ---------- reading ----------

function saveState(id: string, s: SourceSettings): void {
  db().run('UPDATE cost_price_books SET source_settings = ? WHERE id = ?', JSON.stringify(s), id);
}

/**
 * Reads a book's source and writes a version when the prices differ. A failed read keeps the last version and records
 * why. Runs with the rights of who set the source (the job) or of who pressed "Read now".
 */
export async function readBookSource(
  bookId: string,
  actor: string,
  now = Date.now(),
): Promise<{ written: boolean; error: string | null; note: string | null }> {
  const b = bookRow(bookId);
  const s = b ? settingsOf(b) : {};
  if (!b || !s.kind) return { written: false, error: null, note: null };
  const at = new Date(now).toISOString();
  try {
    const read = s.kind === 'snowflakeRateSheet' ? await readRateSheet(b, actor) : await readObserved(b, actor, now);
    const label = LABEL[s.kind];
    // what the source brought before goes; entries written by hand stay
    const fresh = new Set(read.entries.map(entryKey));
    const kept = entriesOfBook(b).filter((e) => !e.sourceNote.startsWith(label) && !fresh.has(entryKey(e)));
    let written = false;
    db().tx(() => {
      const w = writeVersion(bookRow(bookId)!, [...kept, ...read.entries], 'source', read.note, { source: s.kind, readBy: actor });
      written = w.created;
      // the rate sheet's contract number names a Steward contract with that reference: the book is that contract's
      if ('contractNumber' in read && read.contractNumber && !b.supplier_contract_id) {
        const c = db().get<{ id: string; supplier_id: string }>(
          'SELECT id, supplier_id FROM supplier_contracts WHERE reference = ? ORDER BY id LIMIT 1',
          read.contractNumber,
        );
        if (c) {
          db().run('UPDATE cost_price_books SET supplier_contract_id = ?, supplier_id = ? WHERE id = ?', c.id, c.supplier_id, bookId);
          audit({
            action: 'cost.price_book_changed',
            entityType: 'cost_price_book',
            entityId: bookId,
            summary: `Price book "${b.name}" linked to the contract ${read.contractNumber} named by the rate sheet`,
            details: { supplierContractId: c.id, contractNumber: read.contractNumber },
          });
        }
      }
      saveState(bookId, { ...s, lastReadAt: at, lastError: null, lastNote: read.note, lastMonth: 'month' in read ? read.month : (s.lastMonth ?? null) });
    });
    return { written, error: null, note: read.note };
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    saveState(bookId, { ...s, lastReadAt: at, lastError: error });
    // a refusal with a code (too large, a platform no longer usable) reaches who pressed "Read now"; the job notes it
    if (e instanceof HttpError) throw e;
    return { written: false, error, note: null };
  }
}

export const costPriceSourceInput = z.object({ source: z.enum(COST_PRICE_SOURCE_KINDS).nullable() }).strict();

/** Sets (or clears) the source of a platform's contracted book: who maintains it; it is read with their rights. */
export function setBookSource(id: string, body: unknown): CostPriceBookDetail {
  const { row } = requireBook(id, 'edit');
  const x = costPriceSourceInput.parse(body);
  if (x.source) {
    const kind = row.platform_id ? db().get<{ kind: string }>('SELECT kind FROM platforms WHERE id = ?', row.platform_id)?.kind : undefined;
    if (row.kind !== 'contracted' || kind !== SOURCE_PLATFORM_KIND[x.source])
      throw new HttpError(400, `${LABEL[x.source]} is read into a contracted book of a ${SOURCE_PLATFORM_KIND[x.source]} platform`, 'COST_PRICE_BOOK_KIND');
  }
  const before = settingsOf(row);
  const next: SourceSettings = x.source ? { kind: x.source, savedBy: currentActor(), lastReadAt: null, lastError: null, lastNote: null, lastMonth: null } : {};
  db().tx(() => {
    db().run(
      'UPDATE cost_price_books SET source = ?, source_settings = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      x.source ?? 'manual',
      JSON.stringify(next),
      nowIso(),
      currentActor(),
      id,
    );
    audit({
      action: 'cost.price_book_changed',
      entityType: 'cost_price_book',
      entityId: id,
      summary: `Price book "${row.name}": ${x.source ? `read from ${LABEL[x.source]}` : 'no source'}`,
      details: { before: { source: before.kind ?? null }, after: { source: x.source } },
    });
  });
  return getBook(id);
}

/** "Read now": who maintains the book, with their own rights on the platform. */
export async function readBookNow(id: string): Promise<CostPriceBookDetail & { read: { written: boolean; error: string | null; note: string | null } }> {
  const { row } = requireBook(id, 'edit');
  if (!settingsOf(row).kind) throw new HttpError(400, 'This book is not read from a source', 'COST_PRICE_BOOK_KIND');
  let read: { written: boolean; error: string | null; note: string | null };
  try {
    read = await readBookSource(id, currentActor());
  } catch (e) {
    read = { written: false, error: (e as Error).message.slice(0, 500), note: null };
    audit({
      action: 'cost.price_book_read',
      entityType: 'cost_price_book',
      entityId: id,
      summary: `Price book "${row.name}" read now: failed – ${read.error!.slice(0, 200)}`,
      details: read,
    });
    throw e;
  }
  audit({
    action: 'cost.price_book_read',
    entityType: 'cost_price_book',
    entityId: id,
    summary: `Price book "${row.name}" read now: ${read.error ? `failed – ${read.error.slice(0, 200)}` : read.written ? 'a new version' : 'no change'}`,
    details: read,
  });
  return { ...getBook(id), read };
}

/** The job: Snowflake rate sheets once a day, Confluent's observed rates once a month (from the 4th, when the month is complete). */
export async function runPriceSources(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  let n = 0;
  for (const b of db().all<BookRow>("SELECT * FROM cost_price_books WHERE source IN ('snowflakeRateSheet', 'confluentObserved') ORDER BY id")) {
    const s = settingsOf(b);
    if (!s.kind || !s.savedBy) continue;
    if (s.kind === 'snowflakeRateSheet' && s.lastReadAt && now - Date.parse(s.lastReadAt) < DAY) continue;
    if (s.kind === 'confluentObserved' && (new Date(now).getUTCDate() < 4 || s.lastMonth === previousMonth(now))) continue;
    // a failed read is tried again the next day, not every run
    if (s.lastError && s.lastReadAt && now - Date.parse(s.lastReadAt) < DAY) continue;
    try {
      const r = await readBookSource(b.id, s.savedBy, now);
      if (!r.error) n++;
    } catch (err) {
      saveState(b.id, { ...s, lastReadAt: new Date(now).toISOString(), lastError: (err as Error).message.slice(0, 500) });
      logger.warn({ err, book: b.id }, 'reading a price source failed');
    }
  }
  return n;
}
