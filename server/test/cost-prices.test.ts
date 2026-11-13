import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  convertAmount,
  convertQuantity,
  costPriceEntryInput,
  formatPrice,
  normaliseEntry,
  parsePrice,
  parseQuantity,
  parseUnit,
  priceQuantity,
  specOf,
  unitsConvert,
  versionProblems,
  type CostPriceEntry,
  type CostPriceEntryInput,
} from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Price books (0.21.0, ADR 0035 parts 1 and 2, docs/PRICE-BOOKS.md): units and their conversion, the exact pricing
 * arithmetic (blocks, tiers, included quantities, minimums, credit chains), books by hand and from CSV with versions and
 * their differences, the review reminder, who reads and maintains which book, and the Snowflake fallback's price per
 * credit moved into the platform's contracted book (the migration and the cost source reading it from there).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';
// the demo (startTestServer sets it too – the migration test below reads the configuration first)
process.env.SM_DEMO = '1';

const PG_TEST_URL = process.env.SM_TEST_DATABASE_URL;
const PW = 'Demo-password-1';
const entry = (e: CostPriceEntryInput): CostPriceEntry => normaliseEntry(costPriceEntryInput.parse(e));
const q = (s: string) => parseQuantity(s)!;

describe('units', () => {
  it('reads UCUM codes with prefixes, annotations and one division', () => {
    expect(parseUnit('GBy')).toMatchObject({ num: 1_000_000_000n, den: 1n });
    expect(parseUnit('GiBy')).toMatchObject({ num: 1024n ** 3n, den: 1n });
    expect(Object.fromEntries(parseUnit('GBy.mo')!.dims)).toEqual({ By: 1, s: 1 });
    expect(Object.fromEntries(parseUnit('MBy/s')!.dims)).toEqual({ By: 1, s: -1 });
    expect(Object.fromEntries(parseUnit('{msg}/s')!.dims)).toEqual({ '{msg}': 1, s: -1 });
    expect(Object.fromEntries(parseUnit('{eCKU}.h')!.dims)).toEqual({ '{eCKU}': 1, s: 1 });
    for (const bad of ['', 'GB', 'Gh', 'By/s/s', '{a{b}}', '{}', 'kh', 'xyz', '{msg']) expect(parseUnit(bad), bad).toBeNull();
  });

  it('converts within one dimension only – 730 hours a month, decimal and binary apart, annotations never', () => {
    expect(convertQuantity(q('1500'), 'MBy', 'GBy')).toBe(q('1.5'));
    expect(convertQuantity(q('1'), 'GiBy', 'GBy')).toBe(q('1.073742'));
    expect(convertQuantity(q('730'), 'h', 'mo')).toBe(q('1'));
    expect(convertQuantity(q('1'), 'mo', 'd')).toBe(q('30.416667'));
    expect(convertQuantity(q('1000'), 'GBy.mo', 'TBy.mo')).toBe(q('1'));
    expect(convertQuantity(q('1'), 'MBy/s', 'GBy/h')).toBe(q('3.6'));
    expect(convertQuantity(q('8'), 'bit', 'By')).toBe(q('1'));
    expect(convertQuantity(q('1'), '{msg}', '{request}')).toBeNull();
    expect(convertQuantity(q('1'), 'GBy', 'GBy.mo')).toBeNull();
    expect(unitsConvert('{credit}', '{credit}')).toBe(true);
    expect(unitsConvert('h', '{eCKU}.h')).toBe(false);
  });
});

describe('the pricing arithmetic', () => {
  it('reads prices with up to 12 decimals exactly and refuses more', () => {
    expect(parsePrice('0.000000123456')).toBe(123_456n);
    expect(parsePrice('0.0000001234567')).toBeNull();
    expect(parsePrice('1e-3')).toBe(1_000_000_000n);
    expect(parsePrice('-2.5')).toBe(-2_500_000_000_000n);
    expect(parsePrice('12,5')).toBeNull();
    expect(formatPrice(123_456n)).toBe('0.000000123456');
    expect(formatPrice(2_000_000_000_000n)).toBe('2.00');
  });

  it('prices per block, rounding half away from zero once at the end', () => {
    // 0.40 per 1,000,000 requests: 2,500,001 requests → 1.0000004 → 1.000000
    const s = specOf(entry({ sku: 'r', name: 'R', unit: '{request}', price: '0.40', block: 1_000_000, currency: 'EUR' }));
    expect(priceQuantity(q('2500001'), s)).toBe(1_000_000n);
    // 1.25 per 1,000 → 3 units cost 0.00375 → 3,750 millionths
    expect(priceQuantity(q('3'), specOf(entry({ sku: 'x', name: 'X', unit: '1', price: '1.25', block: 1000, currency: 'EUR' })))).toBe(3_750n);
    // half a millionth rounds away from zero, also below zero (a credit line)
    const tiny = specOf(entry({ sku: 't', name: 'T', unit: '1', price: '0.0000005', currency: 'EUR' }));
    expect(priceQuantity(q('1'), tiny)).toBe(1n);
    const credit = specOf(entry({ sku: 'c', name: 'C', unit: '1', price: '-0.0000005', currency: 'EUR' }));
    expect(priceQuantity(q('1'), credit)).toBe(-1n);
  });

  it('applies the included quantity first, then graduated or volume tiers, then the minimum', () => {
    const tiers = [
      { from: '0', price: '0.10' },
      { from: '1000', price: '0.08' },
      { from: '5000', price: '0.05' },
    ];
    const grad = specOf(entry({ sku: 'g', name: 'G', unit: 'GBy', price: '0.10', currency: 'USD', tiers, included: '100' }));
    // 6,100 GB − 100 included = 6,000: 1,000 × 0.10 + 4,000 × 0.08 + 1,000 × 0.05 = 470
    expect(priceQuantity(q('6100'), grad)).toBe(470_000_000n);
    const vol = specOf(entry({ sku: 'v', name: 'V', unit: 'GBy', price: '0.10', currency: 'USD', tiers, tierMode: 'volume' }));
    // the whole quantity at the band reached
    expect(priceQuantity(q('6000'), vol)).toBe(300_000_000n);
    expect(priceQuantity(q('999'), vol)).toBe(99_900_000n);
    const min = specOf(entry({ sku: 'm', name: 'M', unit: 'GBy', price: '0.10', currency: 'USD', minimum: '25' }));
    expect(priceQuantity(q('10'), min)).toBe(25_000_000n);
    // nothing used: no minimum
    expect(priceQuantity(0n, min)).toBe(0n);
    // a credit chain step: neither included nor minimum
    expect(priceQuantity(q('10'), min, true)).toBe(1_000_000n);
  });

  it('converts amounts at a rate of 12 decimals', () => {
    expect(convertAmount(1_000_000n, parsePrice('0.92')!)).toBe(920_000n);
    expect(convertAmount(333n, parsePrice('1.5')!)).toBe(500n);
  });

  it('checks a version: duplicates, overlapping validity and credit chains of at most two steps', () => {
    const base = { name: 'X', unit: 'h', price: '1' };
    expect(versionProblems([entry({ ...base, sku: 'a', currency: 'USD' }), entry({ ...base, sku: 'a', currency: 'USD' })])[0]?.code).toBe('duplicate');
    expect(
      versionProblems([
        entry({ ...base, sku: 'a', currency: 'USD', validTo: '2027-03-01' }),
        entry({ ...base, sku: 'a', currency: 'USD', validFrom: '2027-02-01' }),
      ])[0]?.code,
    ).toBe('overlap');
    expect(
      versionProblems([
        entry({ ...base, sku: 'a', currency: 'USD', validTo: '2027-01-31' }),
        entry({ ...base, sku: 'a', currency: 'USD', validFrom: '2027-02-01' }),
      ]),
    ).toEqual([]);
    const chain = (n: number) =>
      Array.from({ length: n + 1 }, (_, i) =>
        entry({ ...base, unit: '{credit}', sku: `c${i}`, ...(i < n ? { creditSku: `c${i + 1}` } : { currency: 'USD' }) }),
      );
    expect(versionProblems(chain(2))).toEqual([]);
    expect(versionProblems(chain(3)).map((p) => p.code)).toContain('chain');
    expect(versionProblems([entry({ ...base, sku: 'a', creditSku: 'b' }), entry({ ...base, sku: 'b', creditSku: 'a' })])[0]?.code).toBe('chain');
    expect(versionProblems([entry({ ...base, sku: 'a', creditSku: 'missing' })])[0]?.message).toContain('not in the book');
  });

  it('refuses entries that are not prices', () => {
    for (const bad of [
      { sku: 'a', name: 'A', unit: 'h', price: '1' },
      { sku: 'a', name: 'A', unit: 'h', price: '1', currency: 'USD', creditSku: 'b' },
      { sku: 'a', name: 'A', unit: 'nope', price: '1', currency: 'USD' },
      { sku: 'a', name: 'A', unit: 'h', price: '0.0000000000001', currency: 'USD' },
      { sku: 'a', name: 'A', unit: 'h', price: '1', currency: 'USD', tiers: [{ from: '10', price: '1' }] },
      { sku: 'a', name: 'A', unit: 'h', price: '1', currency: 'XXX' },
      { sku: 'a', name: 'A', unit: 'h', price: '1', currency: 'USD', block: 10 },
    ])
      expect(costPriceEntryInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe('price books', () => {
  let s: TestServer;
  let dana: Client;
  let olivia: Client;
  let vera: Client;
  let audrey: Client;
  let snowflake: string;
  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
    await s.api('POST', '/demo/setup', { services: true });
    dana = await s.as('dana', PW);
    olivia = await s.as('olivia', PW);
    vera = await s.as('vera', PW);
    audrey = await s.as('audrey', PW);
    snowflake = (await s.api('GET', '/platforms')).find((p: { name: string; kind: string }) => p.kind === 'snowflake' && p.name.endsWith('(demo)')).id;
  }, 240_000);

  it('the demo has list books of invented prices and the Snowflake platform’s contracted book', async () => {
    const books = (await s.api('GET', '/costs/price-books')) as { name: string; kind: string; description: string; platform: { id: string } | null }[];
    expect(books.map((b) => b.name)).toEqual(expect.arrayContaining(['Snowflake list prices (demo)', 'Confluent list prices (demo)']));
    for (const b of books) expect(b.description).toMatch(/Invented/);
    expect(books.find((b) => b.kind === 'contracted')?.platform?.id).toBe(snowflake);
  });

  it('writes a version per change with its difference, and nothing for an unchanged save', async () => {
    const b = await dana('POST', '/costs/price-books', { name: 'Invented Storage AG list', kind: 'list', provider: 'Invented Storage AG', currency: 'EUR' });
    expect(b).toMatchObject({ version: 0, entries: 0, canEdit: true });
    const v1 = await dana('PUT', `/costs/price-books/${b.id}/entries`, {
      entries: [
        { sku: 'hot', name: 'Hot storage', unit: 'GBy.mo', price: '0.020', currency: 'EUR' },
        { sku: 'cold', name: 'Cold storage', unit: 'GBy.mo', price: '0.004', currency: 'EUR' },
      ],
    });
    expect(v1).toMatchObject({ version: 1, entries: 2, written: { created: true, diff: { added: 2, changed: 0, removed: 0 } } });
    const same = await dana('PUT', `/costs/price-books/${b.id}/entries`, {
      entries: [{ sku: 'hot', name: 'Hot storage', unit: 'GBy.mo', price: '0.02', currency: 'EUR' }],
    });
    expect(same.written).toMatchObject({ created: false });
    const v2 = await dana('PUT', `/costs/price-books/${b.id}/entries`, {
      entries: [{ sku: 'hot', name: 'Hot storage', unit: 'GBy.mo', price: '0.023', currency: 'EUR' }],
      remove: [{ sku: 'cold' }],
    });
    expect(v2.written.diff).toMatchObject({ added: 0, changed: 1, removed: 1 });
    const version = await dana('GET', `/costs/price-books/${b.id}/versions/2`);
    expect(version.diff.items.changed[0]).toMatchObject({ sku: 'hot', before: '0.02', after: '0.023', pct: 15 });
    expect(version.diff.items.removed[0]).toMatchObject({ sku: 'cold', before: '0.004' });
    const audit = (await s.api('GET', `/audit?action=cost.price_book_version_added&entityId=${b.id}&limit=5`)) as { details: Record<string, any> }[];
    expect(audit[0]!.details).toMatchObject({ version: 2, changed: 1, removed: 1, prices: [{ sku: 'hot', before: '0.02', after: '0.023' }] });
    // a credit chain deeper than two steps is refused
    await expect(
      dana('PUT', `/costs/price-books/${b.id}/entries`, {
        entries: [
          { sku: 'a', name: 'A', unit: '{x}', price: '1', creditSku: 'b' },
          { sku: 'b', name: 'B', unit: '{x}', price: '1', creditSku: 'c' },
          { sku: 'c', name: 'C', unit: '{x}', price: '1', creditSku: 'd' },
          { sku: 'd', name: 'D', unit: '{x}', price: '1', currency: 'EUR' },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'COST_PRICE_CHAIN' } });
  });

  it('imports a CSV file with a mapping: preview first, problems refuse the whole file', async () => {
    const b = await dana('POST', '/costs/price-books', { name: 'Invented Queue AG list', kind: 'list', provider: 'Invented Queue AG', currency: 'EUR' });
    const csv = 'Item;Name;Unit;Price;Per;Tiers;Included\nmsg;Messages;{msg};0,40;1000000;"0:0,40;1000000:0,30";1000\nseat;Seats;{seat}.mo;12,00;1;;\n';
    const mapping = { sku: 'Item', name: 'Name', unit: 'Unit', price: 'Price', block: 'Per', tiers: 'Tiers', included: 'Included', decimal: ',' };
    const preview = await dana('POST', `/costs/price-books/${b.id}/import/preview`, { csv, fileName: 'queue.csv', mapping });
    expect(preview).toMatchObject({ rows: 2, entries: 2, problems: [], diff: { added: 2 } });
    expect(preview.sample[0]).toMatchObject({
      sku: 'msg',
      price: '0.40',
      block: 1_000_000,
      tiers: [
        { from: '0', price: '0.40' },
        { from: '1000000', price: '0.30' },
      ],
      included: '1000',
    });
    // nothing stored by the preview
    expect((await dana('GET', `/costs/price-books/${b.id}`)).version).toBe(0);
    const done = await dana('POST', `/costs/price-books/${b.id}/import`, { csv, fileName: 'queue.csv', mapping });
    expect(done).toMatchObject({ version: 1, entries: 2, source: 'csv' });
    const bad = 'Item;Name;Unit;Price\nx;X;nope;1\ny;Y;h;abc\n';
    const p2 = await dana('POST', `/costs/price-books/${b.id}/import/preview`, {
      csv: bad,
      mapping: { sku: 'Item', name: 'Name', unit: 'Unit', price: 'Price' },
    });
    expect(p2.problems.map((p: { line: number }) => p.line)).toEqual([2, 3]);
    await expect(
      dana('POST', `/costs/price-books/${b.id}/import`, { csv: bad, mapping: { sku: 'Item', name: 'Name', unit: 'Unit', price: 'Price' } }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'COST_PRICE_IMPORT', params: { line: 2 } } });
    await expect(
      dana('POST', `/costs/price-books/${b.id}/import/preview`, { csv: bad, mapping: { sku: 'Nope', unit: 'Unit', price: 'Price' } }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'COST_PRICE_IMPORT' } });
    // the example file of technical factors reads as it is
    const tech = fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/costs/price-books/snowflake-technical-factors.csv'), 'utf8');
    const ex = await dana('POST', `/costs/price-books/${b.id}/import/preview`, {
      csv: tech,
      mapping: {
        sku: 'sku',
        name: 'name',
        service: 'service',
        driver: 'driver',
        unit: 'unit',
        charge: 'charge',
        price: 'price',
        block: 'block',
        currency: 'currency',
        creditSku: 'credit_item',
        sourceNote: 'source_note',
      },
    });
    expect(ex.problems).toEqual([]);
    expect(ex.entries).toBe(12);
  });

  it('who reads and who maintains a book: list books for everyone, a platform’s contracted book for who sees its amounts', async () => {
    const books = async (c: Client) => ((await c('GET', '/costs/price-books')) as { id: string; kind: string; canEdit: boolean }[]).map((b) => b.kind);
    expect(await books(vera)).not.toContain('contracted');
    expect(await books(audrey)).toContain('contracted');
    const contracted = ((await s.api('GET', '/costs/price-books')) as { id: string; kind: string }[]).find((b) => b.kind === 'contracted')!.id;
    await expect(vera('GET', `/costs/price-books/${contracted}`)).rejects.toMatchObject({ status: 404 });
    // viewers and operators do not maintain instance books
    const list = ((await s.api('GET', '/costs/price-books')) as { id: string; kind: string; name: string }[]).find(
      (b) => b.name === 'Snowflake list prices (demo)',
    )!.id;
    await expect(olivia('POST', `/costs/price-books/${list}/check`)).rejects.toMatchObject({ status: 403 });
    await expect(vera('POST', '/costs/price-books', { name: 'X', kind: 'list', provider: 'X', currency: 'EUR' })).rejects.toMatchObject({ status: 403 });
    // a team book: its owning team's designers maintain it, the others read a list book but not a contracted one
    const team = (await s.api('POST', '/teams', { name: 'Price team', members: ['olivia'] })).id;
    const tb = await s.api('POST', '/costs/price-books', { name: 'Team contract', kind: 'contracted', provider: 'Invented Team AG', currency: 'EUR' });
    await s.api('PUT', `/owning-teams/cost_price_book/${tb.id}`, { teamIds: [team] });
    expect((await olivia('GET', `/costs/price-books/${tb.id}`)).canEdit).toBe(false);
    await expect(vera('GET', `/costs/price-books/${tb.id}`)).rejects.toMatchObject({ status: 404 });
    await expect(dana('GET', `/costs/price-books/${tb.id}`)).rejects.toMatchObject({ status: 404 });
    // API tokens read only: a write needs a session
    const token = (await s.api('POST', '/me/tokens', { name: 'books', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/costs/price-books/${list}/check`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it('“Mark as checked” and the reminder “Prices to review” once per book and due date', async () => {
    const { db } = await import('../src/db.js');
    const { checkPriceReviews } = await import('../src/costs/price-reviews.js');
    const b = await dana('POST', '/costs/price-books', { name: 'Old prices', kind: 'list', provider: 'Invented Old AG', currency: 'EUR', reviewDays: 30 });
    await dana('PUT', `/costs/price-books/${b.id}/entries`, { entries: [{ sku: 'x', name: 'X', unit: 'h', price: '1', currency: 'EUR' }] });
    db().run('UPDATE cost_price_books SET created_at = ? WHERE id = ?', new Date(Date.now() - 40 * 86_400_000).toISOString(), b.id);
    expect((await dana('GET', `/costs/price-books/${b.id}`)).reviewDue).toBe(true);
    const sent = checkPriceReviews(Date.now(), true);
    expect(sent).toBeGreaterThan(0);
    expect(checkPriceReviews(Date.now(), true)).toBe(0);
    const n = ((await dana('GET', '/notifications?limit=200')) as { items: { event: string; link?: string }[] }).items;
    expect(n.some((x) => x.event === 'cost.price_review_due' && x.link?.endsWith(b.id))).toBe(true);
    const checked = await dana('POST', `/costs/price-books/${b.id}/check`);
    expect(checked).toMatchObject({ reviewDue: false, checkedBy: 'dana', version: 1 });
    const audit = (await s.api('GET', `/audit?action=cost.price_book_checked&entityId=${b.id}`)) as unknown[];
    expect(audit).toHaveLength(1);
  });

  it("the cost source's price per credit is an entry of the platform's contracted book", async () => {
    const { snowflakeCreditPrice } = await import('../src/costs/price-books.js');
    const src = await s.api('PUT', `/costs/platform/${snowflake}/source`, { enabled: true, tagKey: 'application', creditPrice: '2.75', creditCurrency: 'USD' });
    expect(src).toMatchObject({ creditPrice: '2.75', creditCurrency: 'USD' });
    expect(snowflakeCreditPrice(snowflake)).toEqual({ price: '2.75', currency: 'USD' });
    // a price changed in the book is what the source shows and the fallback reads
    const book = ((await s.api('GET', '/costs/price-books')) as { id: string; platform: { id: string } | null }[]).find((b) => b.platform?.id === snowflake)!;
    await s.api('PUT', `/costs/price-books/${book.id}/entries`, {
      mode: 'replace',
      entries: [{ sku: 'compute-credit', name: 'Compute credit', unit: '{credit}', price: '2.9', currency: 'USD' }],
    });
    expect((await s.api('GET', `/costs/platform/${snowflake}/source`)).creditPrice).toBe('2.90');
    expect(snowflakeCreditPrice(snowflake)?.price).toBe('2.90');
  });

  it('reads a book page with a fixed number of statements, whatever its size', async () => {
    const { db } = await import('../src/db.js');
    const { getBook, listBooks } = await import('../src/costs/price-books.js');
    const { requestDbStats } = await import('../src/database/timing.js');
    const { runAs } = await import('../src/auth/context.js');
    // as in a request: the owning teams are read once
    const statements = (fn: () => void) => {
      const st = { statements: 0, ms: 0 };
      runAs(null, () => requestDbStats.run(st, fn));
      return st.statements;
    };
    const small = await s.api('POST', '/costs/price-books', { name: 'Small', kind: 'list', provider: 'Invented Size AG', currency: 'EUR' });
    await s.api('PUT', `/costs/price-books/${small.id}/entries`, { entries: [{ sku: 'a', name: 'A', unit: 'h', price: '1', currency: 'EUR' }] });
    const big = await s.api('POST', '/costs/price-books', { name: 'Big', kind: 'list', provider: 'Invented Size AG', currency: 'EUR' });
    const many = Array.from({ length: 3000 }, (_, i) => ({
      sku: `sku-${String(i).padStart(5, '0')}`,
      name: `Item ${i}`,
      unit: 'h',
      price: '0.5',
      currency: 'EUR',
    }));
    const t0 = Date.now();
    await s.api('PUT', `/costs/price-books/${big.id}/entries`, { entries: many });
    expect(Date.now() - t0).toBeLessThan(20_000);
    for (let i = 0; i < 12; i++) await s.api('PUT', `/costs/price-books/${big.id}/entries`, { entries: [{ ...many[0], price: `0.${i + 1}` }] });
    const few = statements(() => getBook(small.id));
    const lots = statements(() => getBook(big.id));
    expect(lots).toBe(few);
    expect(lots).toBeLessThan(15);
    const page = runAs(null, () => getBook(big.id));
    expect(page.items).toHaveLength(500);
    expect(page.more).toBe(true);
    expect(page.versions).toHaveLength(13);
    const l1 = statements(() => listBooks());
    db().run('UPDATE cost_price_books SET updated_at = updated_at');
    expect(l1).toBeLessThan(12);
  });
});

// after the server's tests: the configuration (data folder) is the test server's
describe('migration costs-006-price-books', () => {
  const targets = (): { name: string; target: any }[] => [
    { name: 'SQLite', target: { kind: 'sqlite', file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cpb-')), 'db.sqlite') } },
    ...(PG_TEST_URL
      ? [
          {
            name: 'PostgreSQL',
            target: { kind: 'postgres', url: PG_TEST_URL, schema: `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_cpb${process.pid}` },
          },
        ]
      : []),
  ];
  it("moves the Snowflake fallback's price per credit into the platform's contracted book as version 1", async () => {
    const { Db, coreMigrations, namedMigrations } = await import('../src/db.js');
    for (const { name, target } of targets()) {
      const dialect = target.kind === 'sqlite' ? 'sqlite' : 'postgres';
      const before = namedMigrations(dialect)
        .map((m) => m.name)
        .filter((n) => n !== 'costs-006-price-books' && n !== 'costs-007-calculators-estimates');
      const old = new Db(target, { upTo: { core: coreMigrations(dialect).length, named: before }, quiet: true });
      const at = '2026-10-01T00:00:00.000Z';
      old.run(
        "INSERT INTO platforms (id, name, kind, base_url, config, created_at, updated_at) VALUES ('p_sf', 'Snowflake prod', 'snowflake', 'https://sf.example', '{}', ?, ?)",
        at,
        at,
      );
      old.run(
        "INSERT INTO platforms (id, name, kind, base_url, config, created_at, updated_at) VALUES ('p_sf2', 'Snowflake test', 'snowflake', 'https://sf.example', '{}', ?, ?)",
        at,
        at,
      );
      old.run(
        "INSERT INTO cost_sources (platform_id, enabled, tag_key, credit_price, credit_currency, updated_at, updated_by) VALUES ('p_sf', 1, 'application', '3.125', 'EUR', ?, 'dana')",
        at,
      );
      old.run("INSERT INTO cost_sources (platform_id, enabled, tag_key, updated_at, updated_by) VALUES ('p_sf2', 1, 'application', ?, 'dana')", at);
      old.close();
      const now = new Db(target, { quiet: true });
      try {
        expect(now.all('SELECT id, kind, provider, platform_id, currency, current_version, created_by FROM cost_price_books'), name).toEqual([
          { id: 'cpb_p_sf', kind: 'contracted', provider: 'Snowflake', platform_id: 'p_sf', currency: 'EUR', current_version: 1, created_by: 'dana' },
        ]);
        expect(now.all('SELECT book_id, number, source, entry_count FROM cost_price_book_versions'), name).toEqual([
          { book_id: 'cpb_p_sf', number: 1, source: 'migration', entry_count: 1 },
        ]);
        expect(now.all('SELECT version_id, sku_id, unit, charge, price, block, currency FROM cost_price_items'), name).toEqual([
          { version_id: 'cpv_p_sf_1', sku_id: 'compute-credit', unit: '{credit}', charge: 'usage', price: '3.125', block: 1, currency: 'EUR' },
        ]);
        // the source keeps its columns
        expect(now.get<{ credit_price: string }>("SELECT credit_price FROM cost_sources WHERE platform_id = 'p_sf'")?.credit_price).toBe('3.125');
      } finally {
        now.close();
      }
    }
  });
});
