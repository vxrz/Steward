import { beforeAll, describe, expect, it } from 'vitest';
import type { CostContractConditions, CostDryRunResult, CostEstimate, CostPriceBookDetail, Role } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Contract conditions and derived price books (0.23.0, ADR 0035 phase 2, parts 3, 4 and 8): which price applies – a
 * negotiated unit price, a contracted book, the most specific percentage off the list price, a commitment's band –
 * with the explanation per line; order forms inherit their master's conditions; derived books follow their base and
 * their terms, show base, discount, markup and fee only to who sees the terms, the customer price to everyone else.
 *
 * Confidentiality is the core: a reader who may not see a contract's conditions never learns them – not on an estimate
 * line, in totals, the list of estimates, the dry run, /api/v1, MCP or the contract's page – nothing is computable by
 * subtraction.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
const PROVIDER = 'Invented Cloud AG';
let s: TestServer;
let vic: Client; // viewer, sees the shop, not the contracts
let fin: Client; // designer in team Finance, owns the contract
let pia: Client; // viewer in team Consumers (a rate card is shared with them)
let shop = '';
let finance = '';
let consumers = '';
let list = '';
let supplier = '';
let master = ''; // team-owned by Finance, covers nothing
let orderForm = ''; // of the master, no conditions of its own
const counted = new Map<string, number>();

const LIST = [
  { sku: 'vm-small', name: 'Small VM', service: 'Compute', category: 'Infrastructure', driver: 'runtime', unit: 'h', price: '0.10', currency: 'USD' },
  { sku: 'storage', name: 'Storage', service: 'Storage', category: 'Infrastructure', driver: 'storage', unit: 'GBy.mo', price: '0.02', currency: 'USD' },
  { sku: 'egress', name: 'Egress', service: 'Network', category: 'Network', driver: 'data transfer', unit: 'GBy', price: '0.09', currency: 'USD' },
];
const LINES = [
  { key: 'vm', provider: PROVIDER, sku: 'vm-small', quantity: '1000', unit: 'h' },
  { key: 'store', provider: PROVIDER, sku: 'storage', quantity: '1000', unit: 'GBy.mo' },
  { key: 'out', provider: PROVIDER, sku: 'egress', quantity: '1000', unit: 'GBy' },
];
const CONDITIONS = [
  { kind: 'percentOff', provider: PROVIDER, on: 'provider', percent: '10' },
  { kind: 'percentOff', provider: PROVIDER, on: 'service', target: 'Compute', percent: '12' },
  { kind: 'negotiatedPrice', provider: PROVIDER, on: 'item', target: 'egress', price: '0.05', currency: 'USD' },
];

/** Every figure a reader without the conditions must never see (discounted amounts, the negotiated price, the percentages). */
const SECRET = ['88.00', '18.00', '"50.00', '0.05', '"12"', '"10"', 'percentOff', 'negotiated', 'Invented master agreement'];

beforeAll(async () => {
  s = await startTestServer({
    routes: (a) =>
      a.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(`${req.method} ${req.url}`, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  const users = await import('../src/auth/users.js');
  for (const [username, roles] of [
    ['vic', ['viewer']],
    ['fin', ['designer']],
    ['pia', ['viewer']],
  ] as [string, Role[]][])
    users.createUser({ username, roles, password: PW, mustChangePassword: false });
  finance = (await s.api('POST', '/teams', { name: 'Finance', members: ['fin'] })).id;
  consumers = (await s.api('POST', '/teams', { name: 'Consumers', members: ['pia'] })).id;
  [vic, fin, pia] = await Promise.all(['vic', 'fin', 'pia'].map((u) => s.as(u, PW)));
  const { db } = await import('../src/db.js');
  shop = db().get<{ id: string }>("SELECT id FROM services WHERE name = 'Online shop (demo)'")!.id;
  list = (await s.api('POST', '/costs/price-books', { name: 'Invented Cloud list', kind: 'list', provider: PROVIDER, currency: 'USD' })).id;
  await s.api('PUT', `/costs/price-books/${list}/entries`, { mode: 'replace', entries: LIST });
  supplier = (await s.api('POST', '/suppliers', { name: 'Invented Cloud AG', type: 'saas' })).id;
  const c1 = await s.api('POST', `/suppliers/${supplier}/contracts`, {
    title: 'Invented master agreement',
    reference: 'ICA-2026-001',
    startsOn: '2026-01-01',
    renewal: 'automatic',
    renewalMonths: 12,
    owners: ['team:finance'],
  });
  master = c1.contracts.find((c: { title: string }) => c.title === 'Invented master agreement').id;
  const c2 = await s.api('POST', `/suppliers/${supplier}/contracts`, {
    title: 'Invented order form 1',
    parentId: master,
    owners: ['team:finance'],
  });
  orderForm = c2.contracts.find((c: { title: string }) => c.title === 'Invented order form 1').id;
}, 240_000);

const dry = (who: Client, extra: Record<string, unknown> = {}) =>
  who('POST', '/costs/calculate', { variants: [{ currency: 'USD', lines: LINES, ...extra }] }).then((r: CostDryRunResult) => r.variants[0]!.result);

describe('conditions on a contract', () => {
  it('are kept per contract, refused when two of one kind overlap on the same scope, audited before and after', async () => {
    const r = (await fin('PUT', `/costs/contracts/${master}/conditions`, { conditions: CONDITIONS })) as CostContractConditions;
    expect(r.conditions).toHaveLength(3);
    expect(r.canEdit).toBe(true);
    expect(r.conditions[1]).toMatchObject({ kind: 'percentOff', on: 'service', target: 'Compute', percent: '12', updatedBy: 'fin' });
    // the same scope twice, overlapping in time
    await expect(
      fin('PUT', `/costs/contracts/${master}/conditions`, {
        conditions: [...CONDITIONS, { kind: 'percentOff', provider: PROVIDER, on: 'service', target: 'compute', percent: '15', validFrom: '2027-01-01' }],
      }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'COST_CONDITION_OVERLAP', params: { first: 2, second: 4 } } });
    // one after the other is fine
    const later = (await fin('PUT', `/costs/contracts/${master}/conditions`, {
      conditions: [
        ...CONDITIONS.slice(0, 1),
        { ...CONDITIONS[1], validTo: '2099-12-31' },
        CONDITIONS[2],
        { kind: 'percentOff', provider: PROVIDER, on: 'service', target: 'Compute', percent: '15', validFrom: '2100-01-01' },
      ],
    })) as CostContractConditions;
    expect(later.conditions).toHaveLength(4);
    await fin('PUT', `/costs/contracts/${master}/conditions`, { conditions: CONDITIONS });
    // a commitment reads a volume schedule of the same contract
    await expect(
      fin('PUT', `/costs/contracts/${master}/conditions`, {
        conditions: [{ kind: 'commitment', provider: PROVIDER, scheduleId: 'csch_none', bands: [{ from: '0', percent: '5' }] }],
      }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'COST_CONDITION_SCHEDULE' } });
    const audit = (await s.api('GET', `/audit?action=supplier.contract_conditions_changed&entityId=${supplier}`)) as { details: Record<string, any> }[];
    expect(audit[0]!.details.after.map((c: { percent?: string }) => c.percent ?? null)).toEqual(['10', '12', null]);
  });

  it('are only for who sees the contract with its amounts; changed by who may change it', async () => {
    // vic sees neither the team-owned contract nor its conditions
    await expect(vic('GET', `/costs/contracts/${master}/conditions`)).rejects.toMatchObject({ status: 404 });
    await expect(vic('PUT', `/costs/contracts/${master}/conditions`, { conditions: [] })).rejects.toMatchObject({ status: 404 });
    // an API token never writes
    const token = (await fin('POST', '/me/tokens', { name: 'cond', scope: 'read' })).token as string;
    const res = await fetch(`${s.base}/api/costs/contracts/${master}/conditions`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ conditions: [] }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    // an open contract read by a viewer: with "Hide amounts from viewers" the viewer sees the contract but not its prices
    const open = (await s.api('POST', `/suppliers/${supplier}/contracts`, { title: 'Invented open contract', owners: [] })).contracts.find(
      (c: { title: string }) => c.title === 'Invented open contract',
    ).id as string;
    await s.api('PUT', `/costs/contracts/${open}/conditions`, { conditions: [CONDITIONS[0]] });
    expect((await vic('GET', `/costs/contracts/${open}/conditions`)).conditions).toHaveLength(1);
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: true, defaultCurrency: 'USD' });
    try {
      await expect(vic('GET', `/costs/contracts/${open}/conditions`)).rejects.toMatchObject({ status: 403 });
      // and an estimate priced with them shows the list price to the viewer
      const e = (await s.api('POST', '/costs/estimates', {
        title: 'Open contract estimate',
        ownerKind: 'service',
        ownerId: shop,
        currency: 'USD',
        lines: LINES.slice(0, 1),
        contracts: [{ provider: PROVIDER, contractId: open }],
      })) as CostEstimate;
      expect(e.result!.lines[0]).toMatchObject({ amount: { expected: '90.00' }, foundBy: { kind: 'percentOff', percent: '10' } });
      // vic sees no amounts at all now (viewer of the shop): nothing to give away
      expect(((await vic('GET', `/costs/estimates/${e.id}`)) as CostEstimate).result).toBeNull();
    } finally {
      await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD' });
      await s.api('PUT', `/costs/contracts/${open}/conditions`, { conditions: [] });
    }
  });
});

describe('which price applies', () => {
  let est: CostEstimate;
  it('negotiated price, then the most specific percentage off the list price, each line saying how', async () => {
    const r = await dry(s.api, { contracts: [{ provider: PROVIDER, contractId: master }] });
    const by = (k: string) => r.lines.find((l) => l.key === k)!;
    // 1000 h × 0.10 = 100 less 12 % (service Compute is more specific than the provider's 10 %)
    expect(by('vm')).toMatchObject({
      amount: { expected: '88.00' },
      unitPrice: '0.10',
      foundBy: { kind: 'percentOff', percent: '12', contract: { id: master, reference: 'ICA-2026-001', inherited: false } },
    });
    expect(by('store')).toMatchObject({ amount: { expected: '18.00' }, foundBy: { kind: 'percentOff', percent: '10' } });
    // a negotiated unit price replaces the list price
    expect(by('out')).toMatchObject({ amount: { expected: '50.00' }, unitPrice: '0.05', foundBy: { kind: 'negotiated' } });
    expect(r.totals.monthly.expected).toBe('156.00');
    expect(r.contracts).toEqual([{ id: master, title: 'Invented master agreement', reference: 'ICA-2026-001', provider: PROVIDER }]);
  });

  it('an order form without conditions of its own applies its master’s; a contracted book of the contract includes the discount', async () => {
    const r = await dry(s.api, { contracts: [{ provider: PROVIDER, contractId: orderForm }] });
    expect(r.totals.monthly.expected).toBe('156.00');
    expect(r.lines[0]!.foundBy).toMatchObject({ contract: { id: orderForm, inherited: true } });
    const view = (await fin('GET', `/costs/contracts/${orderForm}/conditions`)) as CostContractConditions;
    expect(view.conditions).toEqual([]);
    expect(view.inherited).toMatchObject({ id: master, conditions: [{ kind: 'percentOff' }, { kind: 'percentOff' }, { kind: 'negotiatedPrice' }] });
    // a contracted book linked to the master: its price, the percentages left out and flagged
    const cb = (await s.api('POST', '/costs/price-books', {
      name: 'Invented Cloud contracted',
      kind: 'contracted',
      provider: PROVIDER,
      currency: 'USD',
      supplierId: supplier,
      supplierContractId: master,
    })) as CostPriceBookDetail;
    await s.api('PUT', `/costs/price-books/${cb.id}/entries`, { entries: [{ ...LIST[0], price: '0.07' }] });
    const c = await dry(s.api, { books: [{ provider: PROVIDER, bookId: cb.id }], contracts: [{ provider: PROVIDER, contractId: master }] });
    expect(c.lines.find((l) => l.key === 'vm')).toMatchObject({ amount: { expected: '70.00' }, foundBy: { kind: 'contracted', conditionIgnored: true } });
    // the negotiated price still wins over the contracted book
    expect(c.lines.find((l) => l.key === 'out')).toMatchObject({ foundBy: { kind: 'negotiated' } });
    const flags = ((await fin('GET', `/costs/contracts/${master}/conditions`)) as CostContractConditions).conditions.map((x) => x.flag);
    expect(flags).toEqual(['contractedBook', 'contractedBook', null]);
    await s.api('DELETE', `/costs/price-books/${cb.id}`);
  });

  it('a commitment takes the band its volume schedule commits to', async () => {
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    db().run(
      `INSERT INTO cost_schedules (id, contract_id, service_id, title, category, amount, currency, billing, starts_on, created_at, created_by, updated_at, updated_by, volume_per, volume_billing, volume_committed)
       VALUES ('csch_commit', ?, ?, 'Invented volume', 'cloud', ?, 'USD', 'volume', '2026-01-01', ?, 'admin', ?, 'admin', 'year', 'byUse', 'full')`,
      master,
      shop,
      120_000 * 1_000_000,
      now,
      now,
    );
    await fin('PUT', `/costs/contracts/${master}/conditions`, {
      conditions: [
        {
          kind: 'commitment',
          provider: PROVIDER,
          on: 'item',
          target: 'storage',
          scheduleId: 'csch_commit',
          bands: [
            { from: '0', percent: '0' },
            { from: '100000', percent: '15' },
            { from: '500000', percent: '25' },
          ],
        },
      ],
    });
    const r = await dry(s.api, { contracts: [{ provider: PROVIDER, contractId: master }] });
    // 120,000 USD a year committed: the 15 % band
    expect(r.lines.find((l) => l.key === 'store')).toMatchObject({ amount: { expected: '17.00' }, foundBy: { kind: 'commitment', percent: '15' } });
    await fin('PUT', `/costs/contracts/${master}/conditions`, { conditions: CONDITIONS });
  });

  it('a reader without the conditions sees list prices on every surface – nothing to subtract', async () => {
    est = (await s.api('POST', '/costs/estimates', {
      title: 'Invented cloud for the shop',
      ownerKind: 'service',
      ownerId: shop,
      currency: 'USD',
      lines: LINES,
      contracts: [{ provider: PROVIDER, contractId: master }],
    })) as CostEstimate;
    expect(est.result!.totals.monthly.expected).toBe('156.00');
    expect(est.contracts).toEqual([{ provider: PROVIDER, contractId: master }]);
    // the editor of the plan who may not see the contract: list prices, marked
    const seen = (await vic('GET', `/costs/estimates/${est.id}`)) as CostEstimate;
    expect(seen.result!.lines.every((l) => l.priceHidden && l.foundBy?.kind === 'list' && l.book?.id === list)).toBe(true);
    expect(seen.result!.lines.map((l) => l.amount!.expected)).toEqual(['100.00', '20.00', '90.00']);
    expect(seen.result!.totals.monthly.expected).toBe('210.00');
    expect(seen.result!.atListPrice).toBe(true);
    expect(seen.result!.contracts).toEqual([]);
    expect(seen.contracts).toEqual([]);
    const text = JSON.stringify(seen);
    for (const x of SECRET) expect(text, x).not.toContain(x);
    // the list of the service
    const listed = JSON.stringify(await vic('GET', `/costs/estimates?ownerKind=service&ownerId=${shop}`));
    expect(listed).toContain('210.00');
    expect(listed).not.toContain('156.00');
    // the dry run: no default contract they cannot see, and naming one is like a missing one
    const mine = await dry(vic);
    expect(mine.totals.monthly.expected).toBe('210.00');
    await expect(dry(vic, { contracts: [{ provider: PROVIDER, contractId: master }] })).rejects.toMatchObject({ status: 404 });
    // the plan proposals carry the list amounts and say so
    const p = await vic('GET', `/costs/estimates/${est.id}/proposals`);
    expect(JSON.stringify(p)).not.toContain('156');
    // plan lines from it ask first: its readers may not all see the contract's prices
    expect((await s.api('GET', `/costs/estimates/${est.id}/proposals`)).hiddenRates).toBe(true);
    // /api/v1 and MCP
    const token = (await vic('POST', '/me/tokens', { name: 'v1', scope: 'read' })).token as string;
    const v1 = await fetch(`${s.base}/api/v1/cost-estimates/${est.id}`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.text());
    expect(v1).toContain('210.00');
    for (const x of SECRET) expect(v1, x).not.toContain(x);
    const v1list = await fetch(`${s.base}/api/v1/cost-estimates?serviceId=${shop}`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.text());
    expect(v1list).not.toContain('156.00');
    await s.api('PUT', '/mcp-server', { enabled: true });
    const mcpToken = (await vic('POST', '/me/tokens', { name: 'mcp', scope: 'mcp' })).token as string;
    const mcp = await callTool(mcpToken, 'get_cost_estimate', { estimateId: est.id });
    expect(mcp).toContain('210.00');
    for (const x of SECRET) expect(mcp, x).not.toContain(x);
    const mcpDry = await callTool(mcpToken, 'calculate_cost_estimate', { variants: [{ currency: 'USD', lines: LINES }] });
    expect(mcpDry).toContain('210.00');
    expect(mcpDry).not.toContain('156.00');
    // the owner of the contract sees the contract's figures where they may read the estimate
    const own = (await fin('GET', `/costs/estimates/${est.id}`)) as CostEstimate;
    expect(own.result!.totals.monthly.expected).toBe('156.00');
  });

  it('prices a page of many lines with a fixed number of statements', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...LINES[i % 3]!, key: `l${i}`, quantity: String(i + 1) }));
    await s.api('POST', '/costs/calculate', {
      variants: [{ currency: 'USD', lines: LINES.slice(0, 1), contracts: [{ provider: PROVIDER, contractId: master }] }],
    });
    const one = counted.get('POST /api/costs/calculate')!;
    await s.api('POST', '/costs/calculate', { variants: [{ currency: 'USD', lines: many, contracts: [{ provider: PROVIDER, contractId: master }] }] });
    const lots = counted.get('POST /api/costs/calculate')!;
    expect(one).toBeGreaterThan(0);
    expect(lots).toBe(one);
    const e = (await s.api('POST', '/costs/estimates', {
      title: 'Many lines',
      ownerKind: 'service',
      ownerId: shop,
      currency: 'USD',
      lines: many,
      contracts: [{ provider: PROVIDER, contractId: master }],
    })) as CostEstimate;
    await vic('GET', `/costs/estimates/${est.id}`);
    const a = counted.get(`GET /api/costs/estimates/${est.id}`)!;
    await vic('GET', `/costs/estimates/${e.id}`);
    expect(counted.get(`GET /api/costs/estimates/${e.id}`)).toBe(a);
  });
});

describe('derived books', () => {
  let derived = '';
  let provider = ''; // Invented Data Services: a provider with a fee on top
  let customers = ''; // the customers' contract with it, team-owned by Finance
  it('are the base × the provider’s terms on its contract, with the fixed fee as an item; versions follow the base', async () => {
    provider = (await s.api('POST', '/suppliers', { name: 'Invented Data Services', type: 'serviceProvider' })).id;
    customers = (
      await s.api('POST', `/suppliers/${provider}/contracts`, { title: 'Invented data services agreement', reference: 'IDS-7', owners: ['team:finance'] })
    ).contracts[0].id;
    await fin('PUT', `/costs/contracts/${customers}/conditions`, {
      conditions: [
        { kind: 'baseDiscount', provider: PROVIDER, on: 'provider', percent: '10' },
        { kind: 'markup', provider: PROVIDER, on: 'provider', percent: '8' },
        { kind: 'feePerUnit', provider: PROVIDER, on: 'item', target: 'storage', price: '0.005', currency: 'USD', unit: 'GBy.mo' },
        { kind: 'fixedFee', provider: PROVIDER, price: '100', currency: 'USD' },
      ],
    });
    const d = (await s.api('POST', '/costs/price-books', {
      name: 'Invented Data Services prices',
      kind: 'derived',
      provider: PROVIDER,
      currency: 'USD',
      supplierId: provider,
      supplierContractId: customers,
      baseBookId: list,
    })) as CostPriceBookDetail;
    derived = d.id;
    expect(d).toMatchObject({ kind: 'derived', source: 'derived', version: 1, termsOn: 'contract', termsVisible: true, base: { id: list } });
    const price = (sku: string) => d.items.find((i) => i.sku === sku)?.price;
    // 0.10 × 0.9 × 1.08; 0.02 × 0.9 × 1.08 + 0.005
    expect(price('vm-small')).toBe('0.0972');
    expect(price('storage')).toBe('0.02444');
    expect(d.items.find((i) => i.sku === 'service-fee')).toMatchObject({
      price: '100.00',
      unit: '{subscription}.mo',
      charge: 'recurring',
      name: 'Service fee – Invented Data Services',
    });
    // its prices are not written by hand
    await expect(s.api('PUT', `/costs/price-books/${derived}/entries`, { entries: [LIST[0]] })).rejects.toMatchObject({
      body: { code: 'COST_PRICE_DERIVATION' },
    });
    // a new version of the base writes the derived book's in the same step, naming the cause
    await s.api('PUT', `/costs/price-books/${list}/entries`, { entries: [{ ...LIST[0], price: '0.12' }] });
    const after = (await s.api('GET', `/costs/price-books/${derived}`)) as CostPriceBookDetail;
    expect(after.version).toBe(2);
    expect(after.versions[0]!.derivation).toMatchObject({
      cause: 'Invented Cloud list v2',
      causeCode: 'base',
      causeBook: 'Invented Cloud list',
      causeVersion: 2,
    });
    expect(after.items.find((i) => i.sku === 'vm-small')!.price).toBe('0.11664');
    // a changed term does too
    await fin('PUT', `/costs/contracts/${customers}/conditions`, {
      conditions: [
        { kind: 'baseDiscount', provider: PROVIDER, on: 'provider', percent: '10' },
        { kind: 'markup', provider: PROVIDER, on: 'provider', percent: '9' },
        { kind: 'feePerUnit', provider: PROVIDER, on: 'item', target: 'storage', price: '0.005', currency: 'USD', unit: 'GBy.mo' },
        { kind: 'fixedFee', provider: PROVIDER, price: '100', currency: 'USD' },
      ],
    });
    const v3 = (await s.api('GET', `/costs/price-books/${derived}`)) as CostPriceBookDetail;
    expect(v3.version).toBe(3);
    expect(v3.versions[0]!.derivation).toMatchObject({ cause: 'terms of the contract changed', causeCode: 'contractTerms', causeBook: null });
    const audit = (await s.api('GET', `/audit?action=cost.price_book_derived&entityId=${derived}`)) as unknown[];
    expect(audit.length).toBe(3);
  });

  it('shows base, discount, markup and fee to who sees the terms; the customer price only to a reader it is shared with', async () => {
    const e = (await s.api('POST', '/costs/estimates', {
      title: 'Through the data services',
      ownerKind: 'service',
      ownerId: shop,
      currency: 'USD',
      lines: LINES.slice(0, 2),
      books: [{ provider: PROVIDER, bookId: derived }],
    })) as CostEstimate;
    const vm = e.result!.lines.find((l) => l.key === 'vm')!;
    // 1000 h × 0.12 = 120 → −12 → +9.72 (9 % of 108) = 117.72
    expect(vm).toMatchObject({ foundBy: { kind: 'derived' }, amount: { expected: '117.72' } });
    expect(vm.breakdown).toMatchObject({
      base: { id: list },
      baseAmount: { expected: '120.00' },
      discount: { expected: '-12.00' },
      markup: { expected: '9.72' },
      fee: { expected: '0.00' },
      discountPct: '10',
      markupPct: '9',
    });
    const store = e.result!.lines.find((l) => l.key === 'store')!.breakdown!;
    expect(store.fee.expected).toBe('5.00');
    // pia (team Consumers) does not see the derived book: list price
    const before = (await pia('GET', `/costs/estimates/${e.id}`)) as CostEstimate;
    expect(before.result!.lines.every((l) => l.priceHidden)).toBe(true);
    // a share of the derived book with the team: the customer price, never the base, discount, markup or fee
    await s.api('PUT', `/access/cost_price_book/${derived}/shares`, { shares: [{ subject: 'team:consumers', level: 'view' }] });
    const shared = (await pia('GET', `/costs/estimates/${e.id}`)) as CostEstimate;
    const line = shared.result!.lines.find((l) => l.key === 'vm')!;
    expect(line).toMatchObject({ priceHidden: false, breakdown: null, amount: { expected: '117.72' }, foundBy: { kind: 'derived', contract: null } });
    const text = JSON.stringify(shared);
    for (const x of ['120.00', '-12.00', '9.72', '"10"', '"9"', 'Invented data services agreement', '0.005']) expect(text, x).not.toContain(x);
    const book = (await pia('GET', `/costs/price-books/${derived}`)) as CostPriceBookDetail;
    expect(book).toMatchObject({ termsVisible: false, base: null, terms: null });
    expect(book.versions.every((v) => v.derivation === null && v.note === '')).toBe(true);
    expect(JSON.stringify(book)).not.toContain('0.12"');
    // the dry run of a reader of the shared book: customer prices by default, no breakdown
    const r = await dry(pia, { lines: LINES.slice(0, 1) });
    expect(r.lines[0]).toMatchObject({ book: { id: derived }, breakdown: null, amount: { expected: '117.72' } });
    // MCP and /api/v1: customer prices only
    const token = (await pia('POST', '/me/tokens', { name: 'v1', scope: 'read' })).token as string;
    const v1 = await fetch(`${s.base}/api/v1/price-books/${derived}/items`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.text());
    expect(v1).toContain('0.11772');
    expect(v1).not.toContain('"0.12"');
    await s.api('PUT', '/mcp-server', { enabled: true });
    const mcpToken = (await pia('POST', '/me/tokens', { name: 'mcp', scope: 'mcp' })).token as string;
    const est = await callTool(mcpToken, 'get_cost_estimate', { estimateId: e.id });
    expect(est).toContain('117.72');
    for (const x of ['120.00', '-12.00', 'breakdown":{']) expect(est, x).not.toContain(x);
  });

  it('a rate card keeps its own terms; derivations stay two levels deep and never loop', async () => {
    const card = (await s.api('POST', '/costs/price-books', {
      name: 'Invented platform rate card',
      kind: 'derived',
      provider: PROVIDER,
      currency: 'USD',
      baseBookId: list,
    })) as CostPriceBookDetail;
    expect(card.termsOn).toBe('book');
    const set = (await s.api('PUT', `/costs/price-books/${card.id}/terms`, {
      conditions: [{ kind: 'markup', provider: PROVIDER, on: 'provider', percent: '5' }],
    })) as CostPriceBookDetail;
    expect(set.items.find((i) => i.sku === 'vm-small')!.price).toBe('0.126');
    expect(set.terms).toHaveLength(1);
    await expect(
      s.api('PUT', `/costs/price-books/${card.id}/terms`, { conditions: [{ kind: 'percentOff', provider: PROVIDER, percent: '5' }] }),
    ).rejects.toMatchObject({ body: { code: 'COST_PRICE_DERIVATION' } });
    const second = (await s.api('POST', '/costs/price-books', { name: 'Level 2', kind: 'derived', provider: PROVIDER, currency: 'USD', baseBookId: card.id }))
      .id;
    await expect(
      s.api('POST', '/costs/price-books', { name: 'Level 3', kind: 'derived', provider: PROVIDER, currency: 'USD', baseBookId: second }),
    ).rejects.toMatchObject({ body: { code: 'COST_PRICE_DERIVATION' } });
    await expect(
      s.api('POST', '/costs/price-books', { name: 'Other provider', kind: 'derived', provider: 'Somebody else', currency: 'USD', baseBookId: list }),
    ).rejects.toMatchObject({ body: { code: 'COST_PRICE_DERIVATION' } });
    // the maintainers must see the base: a book they may not see answers like a missing one
    const hidden = (await s.api('POST', '/costs/price-books', { name: 'Finance only', kind: 'contracted', provider: PROVIDER, currency: 'USD' })).id;
    await s.api('PUT', `/owning-teams/cost_price_book/${hidden}`, { teamIds: [finance] });
    const dana = await s.as('dana', 'Demo-password-1');
    await expect(
      dana('POST', '/costs/price-books', { name: 'Peek', kind: 'derived', provider: PROVIDER, currency: 'USD', baseBookId: hidden }),
    ).rejects.toMatchObject({ status: 404, body: { code: 'COST_PRICE_BOOK_NOT_FOUND' } });
    expect(consumers).toBeTruthy();
  });
});

async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const MODERN = '2026-07-28';
  const res = await fetch(`${s.base}/api/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN,
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        },
      },
    }),
  });
  const text = await res.text();
  if (!JSON.parse(text).result) throw new Error(text);
  return text;
}
