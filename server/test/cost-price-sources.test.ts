import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CostEstimate, CostPriceBookDetail, Role } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Price books read from a source and estimates recalculated in the background (0.23.0, ADR 0035 parts 2 and 6):
 * Snowflake's rate sheet (discount included, CONTRACT_NUMBER linking the book to a contract) and Confluent's observed
 * rates from the Costs API's lines, through the platform's client; limits and a failed read that keeps the last version.
 * A new version or a changed condition recalculates the estimates that used them in the job "costs", beside their
 * result, and "Estimate changed" tells their owners once per price version – each only what their own view shows.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
const PROVIDER = 'Invented Recalc AG';
let s: TestServer;
let fin: Client; // designer in Finance: owns the contract and the service
let pia: Client; // viewer, named owner of the service, outside Finance
const byKind: Record<string, string> = {};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const users = await import('../src/auth/users.js');
  for (const [username, roles] of [
    ['fin', ['designer']],
    ['pia', ['viewer']],
  ] as [string, Role[]][])
    users.createUser({ username, roles, password: PW, mustChangePassword: false });
  await s.api('POST', '/teams', { name: 'Finance', members: ['fin'] });
  [fin, pia] = await Promise.all(['fin', 'pia'].map((u) => s.as(u, PW)));
  for (const p of await s.api('GET', '/platforms')) if (p.name.endsWith('(demo)')) byKind[p.kind] = p.id;
}, 240_000);

afterAll(async () => {
  const mock = await import('../src/mock/mockSnowflake.js');
  mock.setSnowflakeOrgUsage(true);
});

describe('the parsers', () => {
  it('reads the rate sheet: compute per credit, storage per TB-month, transfer per TB, other service types per credit', async () => {
    const { rateSheetEntries } = await import('../src/costs/price-sources.js');
    const r = rateSheetEntries([
      { DATE: '2026-11-10', CONTRACT_NUMBER: 'SDC-1', SERVICE_TYPE: 'WAREHOUSE_METERING', USAGE_TYPE: 'compute', CURRENCY: 'usd', EFFECTIVE_RATE: '2.6000' },
      { DATE: '2026-11-11', CONTRACT_NUMBER: 'SDC-1', SERVICE_TYPE: 'STORAGE', USAGE_TYPE: 'storage', CURRENCY: 'USD', EFFECTIVE_RATE: '21.5' },
      { DATE: '2026-11-11', CONTRACT_NUMBER: null, SERVICE_TYPE: 'DATA_TRANSFER', USAGE_TYPE: 'data transfer', CURRENCY: 'USD', EFFECTIVE_RATE: '18' },
      { DATE: '2026-11-11', CONTRACT_NUMBER: null, SERVICE_TYPE: 'SERVERLESS_TASK', USAGE_TYPE: 'serverless tasks', CURRENCY: 'USD', EFFECTIVE_RATE: '3.4' },
      { DATE: '2026-11-11', CONTRACT_NUMBER: null, SERVICE_TYPE: 'X', USAGE_TYPE: 'y', CURRENCY: 'USD', EFFECTIVE_RATE: 'not a number' },
    ]);
    expect(r.contractNumber).toBe('SDC-1');
    expect(r.day).toBe('2026-11-11');
    expect(r.entries.map((e) => [e.sku, e.unit, e.price, e.currency])).toEqual([
      ['compute-credit', '{credit}', '2.60', 'USD'],
      ['storage', 'TBy.mo', '21.50', 'USD'],
      ['data-transfer', 'TBy', '18.00', 'USD'],
      ['serverless-task-serverless-tasks', '{credit}', '3.40', 'USD'],
    ]);
  });

  it('observes Confluent rates exactly: Σ amount ÷ Σ quantity of the month, with the list price and the discount', async () => {
    const { confluentObservedEntries, confluentUnit } = await import('../src/costs/price-sources.js');
    expect(confluentUnit('CKU-hour')).toBe('{cku}.h');
    expect(confluentUnit('GB')).toBe('GBy');
    expect(confluentUnit('Hour')).toBe('h');
    const line = (day: string, amount: number, quantity: number) => ({
      start_date: day,
      product: 'KAFKA',
      line_type: 'KAFKA_NUM_CKUS',
      network_access_type: 'INTERNET',
      unit: 'CKU-hour',
      price: 0.833333,
      quantity,
      original_amount: amount / 0.9,
      discount_amount: amount / 0.9 - amount,
      amount,
    });
    const e = confluentObservedEntries([line('2026-10-01', 36, 48), line('2026-10-02', 18, 24), line('2026-11-01', 999, 1)], '2026-10');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ sku: 'KAFKA_NUM_CKUS', unit: '{cku}.h', price: '0.75', currency: 'USD', service: 'KAFKA' });
    expect(e[0]!.attributes).toEqual([
      { key: 'listPrice', value: '0.833333' },
      { key: 'discountPercent', value: '10' },
      { key: 'networkAccess', value: 'INTERNET' },
    ]);
    expect(e[0]!.sourceNote).toContain('Observed');
  });
});

describe('sources', () => {
  let snowBook = '';
  it('the Snowflake rate sheet replaces what it read before, keeps entries by hand and links the contract it names', async () => {
    const books = (await s.api('GET', '/costs/price-books')) as { id: string; platform: { id: string } | null; kind: string }[];
    snowBook =
      books.find((b) => b.platform?.id === byKind.snowflake && b.kind === 'contracted')?.id ??
      (
        await s.api('POST', '/costs/price-books', {
          name: 'Snowflake contracted',
          kind: 'contracted',
          provider: 'Snowflake',
          currency: 'USD',
          platformId: byKind.snowflake,
        })
      ).id;
    // a contract with the rate sheet's number (the mock's invented SDC-2026-014)
    const sup = (await s.api('POST', '/suppliers', { name: 'Invented Snowflake reseller', type: 'saas' })).id;
    await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'Invented capacity', reference: 'SDC-2026-014' });
    // only a contracted book of a Snowflake platform reads it
    const list = (await s.api('POST', '/costs/price-books', { name: 'Not a platform book', kind: 'list', provider: 'X', currency: 'USD' })).id;
    await expect(s.api('PUT', `/costs/price-books/${list}/source`, { source: 'snowflakeRateSheet' })).rejects.toMatchObject({
      body: { code: 'COST_PRICE_BOOK_KIND' },
    });
    await s.api('PUT', `/costs/price-books/${snowBook}/entries`, {
      entries: [
        { sku: 'compute-credit', name: 'Compute credit', unit: '{credit}', price: '3', currency: 'USD' },
        { sku: 'warehouse-M', name: 'Warehouse M', unit: 'h', price: '4', creditSku: 'compute-credit' },
      ],
    });
    const before = (await s.api('GET', `/costs/price-books/${snowBook}`)) as CostPriceBookDetail;
    const set = (await s.api('PUT', `/costs/price-books/${snowBook}/source`, { source: 'snowflakeRateSheet' })) as CostPriceBookDetail;
    expect(set.source).toBe('snowflakeRateSheet');
    const r = (await s.api('POST', `/costs/price-books/${snowBook}/read`, {})) as CostPriceBookDetail & { read: { written: boolean } };
    expect(r.read.written).toBe(true);
    expect(r.version).toBe(before.version + 1);
    expect(r.versions[0]!.source).toBe('source');
    expect(r.items.find((i) => i.sku === 'compute-credit')).toMatchObject({ price: '2.60', currency: 'USD' });
    expect(r.items.find((i) => i.sku === 'storage')).toMatchObject({ unit: 'TBy.mo', price: '21.50' });
    // the warehouse size written by hand stays
    expect(r.items.find((i) => i.sku === 'warehouse-M')).toBeTruthy();
    expect(r.supplierContract?.title).toBe('Invented capacity');
    expect(r.sourceState).toMatchObject({ error: null });
    // an unchanged read writes nothing
    const again = (await s.api('POST', `/costs/price-books/${snowBook}/read`, {})) as CostPriceBookDetail & { read: { written: boolean } };
    expect(again.read.written).toBe(false);
    expect(again.version).toBe(r.version);
    // the cost source's fallback reads its price per credit from there
    const { snowflakeCreditPrice } = await import('../src/costs/price-books.js');
    expect(snowflakeCreditPrice(byKind.snowflake!)).toMatchObject({ price: '2.60' });
  });

  it('a failed read keeps the last version and says why; more than a book takes is refused', async () => {
    const mock = await import('../src/mock/mockSnowflake.js');
    mock.setSnowflakeOrgUsage(false);
    const v = ((await s.api('GET', `/costs/price-books/${snowBook}`)) as CostPriceBookDetail).version;
    const r = (await s.api('POST', `/costs/price-books/${snowBook}/read`, {})) as CostPriceBookDetail & { read: { error: string | null } };
    expect(r.read.error).toContain('reseller');
    expect(r.version).toBe(v);
    expect(r.sourceState!.error).toContain('RATE_SHEET_DAILY');
    mock.setSnowflakeOrgUsage(true);
    const { SnowflakeClient } = await import('../src/snowflake/client.js');
    const spy = vi.spyOn(SnowflakeClient.prototype, 'query').mockResolvedValue(
      Array.from({ length: 20_001 }, (_, i) => ({
        SERVICE_TYPE: `S${i}`,
        USAGE_TYPE: 'compute',
        CURRENCY: 'USD',
        EFFECTIVE_RATE: '1',
        DATE: '2026-11-01',
        CONTRACT_NUMBER: null,
      })),
    );
    try {
      await expect(s.api('POST', `/costs/price-books/${snowBook}/read`, {})).rejects.toMatchObject({
        status: 400,
        body: { code: 'COST_PRICE_SOURCE_TOO_LARGE' },
      });
    } finally {
      spy.mockRestore();
    }
    expect(((await s.api('GET', `/costs/price-books/${snowBook}`)) as CostPriceBookDetail).version).toBe(v);
  });

  it('links a contract the rate sheet names only when its author sees exactly one with that number', async () => {
    const sup = (await s.api('POST', '/suppliers', { name: 'Invented data cloud', type: 'saas' })).id;
    // the read itself: the mock's SDC-2026-014 named twice – the book stays without a contract
    await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'Invented capacity twin', reference: 'SDC-2026-014' });
    const { db } = await import('../src/db.js');
    db().run('UPDATE cost_price_books SET supplier_contract_id = NULL, supplier_id = NULL WHERE id = ?', snowBook);
    const r = (await s.api('POST', `/costs/price-books/${snowBook}/read`, {})) as CostPriceBookDetail;
    expect(r.supplierContract).toBeNull();
    const { contractNamed } = await import('../src/costs/price-sources.js');
    const made = async (title: string, reference: string, owners: string[]) =>
      (await s.api('POST', `/suppliers/${sup}/contracts`, { title, reference, owners })).contracts.find((c: { title: string }) => c.title === title)
        .id as string;
    const finance = await made('Invented finance capacity', 'INV-RS-1', ['team:finance']);
    // a team's contract: its member links it, a viewer outside the team does not learn of it
    expect(contractNamed('INV-RS-1', 'fin')).toMatchObject({ id: finance, supplierId: sup });
    expect(contractNamed('INV-RS-1', 'pia')).toBeNull();
    // two contracts with the number: none
    await made('Invented second capacity', 'INV-RS-1', []);
    expect(contractNamed('INV-RS-1', 'admin')).toBeNull();
    expect(contractNamed('INV-RS-1', 'pia')).not.toBeNull();
  });

  it('Confluent’s observed rates of the last complete month, through the platform’s client', async () => {
    const book = (await s.api('POST', '/costs/price-books', {
      name: 'Confluent observed',
      kind: 'contracted',
      provider: 'Confluent',
      currency: 'USD',
      platformId: byKind['confluent-cloud'],
    })) as CostPriceBookDetail;
    await s.api('PUT', `/costs/price-books/${book.id}/source`, { source: 'confluentObserved' });
    const r = (await s.api('POST', `/costs/price-books/${book.id}/read`, {})) as CostPriceBookDetail;
    const cku = r.items.find((i) => i.sku === 'KAFKA_NUM_CKUS')!;
    // the mock bills 36 USD for 48 CKU-hours a day at 10 % off 0.75 → 0.833333 list
    expect(cku).toMatchObject({ price: '0.75', unit: '{cku}.h' });
    expect(cku.attributes.find((a) => a.key === 'discountPercent')?.value).toBe('10');
    expect(r.items.find((i) => i.sku === 'KAFKA_NETWORK_WRITE')).toMatchObject({ unit: 'GBy', price: '0.05' });
    // the job reads it once a month only
    const { runPriceSources } = await import('../src/costs/price-sources.js');
    const d = new Date();
    const fourth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 5);
    const { db } = await import('../src/db.js');
    const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_price_book_versions WHERE book_id = ?', book.id)!.n);
    await runPriceSources(fourth);
    expect(Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_price_book_versions WHERE book_id = ?', book.id)!.n)).toBe(n);
  });
});

describe('recalculation in the background', () => {
  let svc = '';
  let contract = '';
  let list = '';
  let est: CostEstimate;
  const CONDITION = (percent: string) => ({ kind: 'percentOff', provider: PROVIDER, on: 'provider', percent });
  it('a new version of a book recalculates the estimates that use it beside their result; Accept makes it current', async () => {
    list = (await s.api('POST', '/costs/price-books', { name: 'Recalc list', kind: 'list', provider: PROVIDER, currency: 'EUR' })).id;
    await s.api('PUT', `/costs/price-books/${list}/entries`, {
      entries: [
        { sku: 'node', name: 'Node', unit: 'h', price: '1', currency: 'EUR' },
        { sku: 'disk', name: 'Disk', unit: 'GBy.mo', price: '0.1', currency: 'EUR' },
      ],
    });
    svc = (await s.api('POST', '/services', { name: 'Invented recalculated service', owners: ['user:fin', 'user:pia'] })).id;
    const sup = (await s.api('POST', '/suppliers', { name: PROVIDER, type: 'saas' })).id;
    contract = (await s.api('POST', `/suppliers/${sup}/contracts`, { title: 'Invented recalc terms', owners: ['team:finance'] })).contracts[0].id;
    await fin('PUT', `/costs/contracts/${contract}/conditions`, { conditions: [{ ...CONDITION('10'), on: 'item', target: 'node' }] });
    est = (await fin('POST', '/costs/estimates', {
      title: 'Invented recalculated estimate',
      ownerKind: 'service',
      ownerId: svc,
      currency: 'EUR',
      lines: [
        { key: 'n', provider: PROVIDER, sku: 'node', quantity: '730', unit: 'h' },
        { key: 'd', provider: PROVIDER, sku: 'disk', quantity: '100', unit: 'GBy.mo' },
      ],
      contracts: [{ provider: PROVIDER, contractId: contract }],
    })) as CostEstimate;
    expect(est.result!.totals.monthly.expected).toBe('667.00');
    const { recalculateDue } = await import('../src/costs/estimate-notices.js');
    expect((await recalculateDue()).recalculated).toBe(0);
    // the disk gets dearer: pia sees that change too (a list price everyone sees)
    await s.api('PUT', `/costs/price-books/${list}/entries`, { entries: [{ sku: 'disk', name: 'Disk', unit: 'GBy.mo', price: '1', currency: 'EUR' }] });
    const r = await recalculateDue();
    expect(r.recalculated).toBe(1);
    expect(r.notified).toBe(1);
    const e = (await fin('GET', `/costs/estimates/${est.id}`)) as CostEstimate;
    expect(e.result!.totals.monthly.expected).toBe('667.00');
    expect(e.pending!.totals.monthly.expected).toBe('757.00');
    // the job kept the editor's contract: still 10 % off the node
    expect(e.pending!.lines.find((l) => l.key === 'n')).toMatchObject({ foundBy: { kind: 'percentOff', percent: '10' } });
    const notes = async (c: Client) =>
      ((await c('GET', '/notifications?limit=200')) as { items: { event: string; body?: string; link?: string }[] }).items.filter(
        (x) => x.event === 'cost.estimate_changed' && x.link?.endsWith(est.id),
      );
    const finNote = await notes(fin);
    expect(finNote).toHaveLength(1);
    expect(finNote[0]!.body).toContain('757.00');
    expect(finNote[0]!.body).toContain('Recalc list v');
    // pia sees list prices: 730 + 100 → 830, a change of 12 % on her view
    const piaNote = await notes(pia);
    expect(piaNote).toHaveLength(1);
    expect(piaNote[0]!.body).toContain('830.00');
    expect(piaNote[0]!.body).not.toContain('757');
    // once per price version
    expect((await recalculateDue()).notified).toBe(0);
    const accepted = (await fin('POST', `/costs/estimates/${est.id}/accept`)) as CostEstimate;
    expect(accepted.result!.totals.monthly.expected).toBe('757.00');
  });

  it('a changed condition recalculates too – and tells only who sees it changed', async () => {
    const { recalculateDue } = await import('../src/costs/estimate-notices.js');
    await fin('PUT', `/costs/contracts/${contract}/conditions`, { conditions: [{ ...CONDITION('50'), on: 'item', target: 'node' }] });
    const r = await recalculateDue();
    expect(r).toMatchObject({ recalculated: 1, notified: 1 });
    const e = (await fin('GET', `/costs/estimates/${est.id}`)) as CostEstimate;
    expect(e.pending!.totals.monthly.expected).toBe('465.00');
    const piaNotes = ((await pia('GET', '/notifications?limit=200')) as { items: { event: string; link?: string; body?: string }[] }).items.filter(
      (x) => x.event === 'cost.estimate_changed' && x.link?.endsWith(est.id),
    );
    // her view did not move (list prices): no second notice, nothing about the contract
    expect(piaNotes).toHaveLength(1);
    expect(JSON.stringify(piaNotes)).not.toContain('Invented recalc terms');
    // and her view of the pending result is at list price
    const seen = (await pia('GET', `/costs/estimates/${est.id}`)) as CostEstimate;
    expect(seen.pending!.totals.monthly.expected).toBe('830.00');
    expect(JSON.stringify(seen)).not.toContain('465.00');
  });

  it('the threshold is a setting; below it nothing is notified', async () => {
    const { recalculateDue } = await import('../src/costs/estimate-notices.js');
    await fin('POST', `/costs/estimates/${est.id}/accept`);
    const settings = await s.api('GET', '/costs/settings');
    await s.api('PUT', '/costs/settings', { ...settings, estimateChangePct: 50 });
    try {
      await s.api('PUT', `/costs/price-books/${list}/entries`, { entries: [{ sku: 'disk', name: 'Disk', unit: 'GBy.mo', price: '1.5', currency: 'EUR' }] });
      expect(await recalculateDue()).toEqual({ recalculated: 1, notified: 0 });
      expect(((await fin('GET', `/costs/estimates/${est.id}`)) as CostEstimate).pending).not.toBeNull();
    } finally {
      await s.api('PUT', '/costs/settings', { ...settings, estimateChangePct: 5 });
    }
  });
});
