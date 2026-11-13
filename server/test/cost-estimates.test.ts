import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fiscalYearOf, shiftMonth, type CostDryRunResult, type CostEstimate, type CostPlanYear } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Calculators and estimates (0.21.0, ADR 0035 parts 5, 6, 8 and 10): definitions with typed inputs, formulas that
 * produce quantities only and run within limits, the dry run with ranges, adjustments and variants, estimates of a
 * service or platform priced exactly with the books the editor may see (list prices for readers who may not), plan lines
 * proposed and confirmed with Estimate changed and Update lines, manual exchange rates, Git sync, /api/v1 and MCP.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let olivia: Client;
let shop: string;
let snowList: string;
let saasBook: string;
let pipeline: string;

const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const CALC = `kind: costCalculator
id: test-throughput
name: Test throughput
inputs:
  - { key: rate, label: Requests per second, type: number, unit: '{request}/s', default: 10, min: 0 }
  - { key: seats, label: Seats, type: integer, default: 3, range: false }
let:
  perMonth: inputs.rate * 3600 * const.hoursPerMonth
lines:
  - { key: requests, item: { provider: Invented Messaging AG, sku: api-request }, quantity: let.perMonth, unit: '{request}', group: API }
  - { key: seats, item: { provider: Invented Messaging AG, sku: seat }, quantity: inputs.seats, unit: '{seat}.mo', group: Console }
  - { key: setup, item: { provider: Invented Messaging AG, sku: setup }, quantity: 1, unit: '1' }
`;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  olivia = await s.as('olivia', PW);
  const { db } = await import('../src/db.js');
  shop = db().get<{ id: string }>("SELECT id FROM services WHERE name = 'Online shop (demo)'")!.id;
  const books = (await s.api('GET', '/costs/price-books')) as { id: string; name: string }[];
  snowList = books.find((b) => b.name === 'Snowflake list prices (demo)')!.id;
  saasBook = books.find((b) => b.name === 'Invented Messaging AG price list (demo)')!.id;
  pipeline = ((await s.api('GET', '/costs/calculators')) as { id: string; name: string }[]).find((c) => c.name === 'Snowflake pipeline')!.id;
}, 240_000);

describe('calculators', () => {
  it('the three example calculators are in the demo and every example file is a valid calculator', async () => {
    const list = (await s.api('GET', '/costs/calculators')) as { name: string; version: number; providers: string[] }[];
    expect(list.map((c) => c.name)).toEqual(expect.arrayContaining(['Snowflake pipeline', 'Confluent topic and cluster', 'Throughput × price']));
    expect(list.every((c) => c.version === 1)).toBe(true);
    const { parseCalculator } = await import('../src/costs/calculators.js');
    const dir = path.resolve(import.meta.dirname, '../../examples/costs/calculators');
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(parseCalculator(text).errors, f).toEqual([]);
      // technical factors only: no money in a calculator
      expect(text).not.toMatch(/\b(USD|EUR|CHF|GBP)\b/);
    }
  });

  it('keeps a draft, publishes immutable versions, refuses broken formulas with their line', async () => {
    const c = await dana('POST', '/costs/calculators', { definition: CALC });
    expect(c).toMatchObject({ version: 0, hasDraft: true, canEdit: true });
    const v1 = await dana('PUT', `/costs/calculators/${c.id}`, { definition: CALC, publish: true });
    expect(v1).toMatchObject({ version: 1, hasDraft: false });
    // the same definition again: no new version
    expect((await dana('PUT', `/costs/calculators/${c.id}`, { definition: CALC, publish: true })).version).toBe(1);
    await expect(
      dana('PUT', `/costs/calculators/${c.id}`, { definition: CALC.replace('inputs.rate * 3600', 'inputs.rate * (3600'), publish: true }),
    ).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_CALCULATOR_FORMULA', params: { line: 'let.perMonth' } },
    });
    await expect(
      dana('PUT', `/costs/calculators/${c.id}`, { definition: CALC.replace('id: test-throughput', 'id: other'), publish: true }),
    ).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_CALCULATOR_DEFINITION' },
    });
    // viewers read calculators (they hold no prices) but do not write them
    expect((await vera('GET', `/costs/calculators/${c.id}`)).parsed.inputs).toHaveLength(2);
    await expect(vera('PUT', `/costs/calculators/${c.id}`, { definition: CALC })).rejects.toMatchObject({ status: 403 });
    const yaml = await dana('GET', `/costs/calculators/${c.id}/export`);
    expect(yaml).toContain('kind: costCalculator');
  });

  it('runs formulas within limits: no clock, no endless sequences, quantities only and never below zero', async () => {
    const run = (def: string) => dana('POST', '/costs/calculate', { variants: [{ definition: def, currency: 'EUR' }] });
    const line = (q: string) =>
      `kind: costCalculator\nid: x\nname: X\nlines:\n  - { item: { provider: Invented Messaging AG, sku: seat }, quantity: "${q}", unit: '{seat}.mo' }\n`;
    await expect(run(line('$now()'))).rejects.toMatchObject({ body: { code: 'COST_CALCULATOR_FORMULA' } });
    await expect(run(line('$millis()'))).rejects.toMatchObject({ body: { code: 'COST_CALCULATOR_FORMULA' } });
    await expect(run(line('$count([1..100000000])'))).rejects.toMatchObject({ body: { code: 'COST_CALCULATOR_FORMULA' } });
    await expect(run(line('-1'))).rejects.toMatchObject({ body: { code: 'COST_CALCULATOR_OUTPUT' } });
    await expect(run(line("'ten'"))).rejects.toMatchObject({ body: { code: 'COST_CALCULATOR_OUTPUT' } });
    const t0 = Date.now();
    await expect(run(line('($f := function($n) { $n <= 1 ? 1 : $f($n - 1) + $f($n - 2) }; $f(40))'))).rejects.toMatchObject({
      body: { code: 'COST_CALCULATOR_FORMULA' },
    });
    expect(Date.now() - t0).toBeLessThan(5000);
    // viewers may not run definitions (formulas) of their own, only stored calculators
    await expect(vera('POST', '/costs/calculate', { variants: [{ definition: line('1'), currency: 'EUR' }] })).rejects.toMatchObject({ status: 403 });
  });
});

describe('Git sync', () => {
  it('brings calculators in as kind costCalculator, published when accepted', async () => {
    const { parseFile, applyItem, findLocal, localHash } = await import('../src/sync/items.js');
    const text = CALC.replace('id: test-throughput', 'id: git-calc').replace('name: Test throughput', 'name: Git calculator');
    const r = await parseFile('costs/git-calc.yaml', text, ['costCalculator']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item).toMatchObject({ kind: 'costCalculator', identity: 'git-calc', name: 'Git calculator' });
    expect((await parseFile('x.yaml', text, ['process'])).ok).toBe(false);
    const broken = await parseFile('x.yaml', text.replace('let.perMonth, unit', 'let.perMonth +, unit'), ['costCalculator']);
    expect(broken.ok).toBe(false);
    const applied = await applyItem('costCalculator', r.item.content, null, { identity: r.item.identity, comment: 'from Git' });
    expect(applied.version).toBe(1);
    expect(findLocal('costCalculator', 'git-calc')?.id).toBe(applied.entityId);
    expect(localHash('costCalculator', applied.entityId)).toBe(r.item.hash);
    expect(await dana('GET', `/costs/calculators/${applied.entityId}`)).toMatchObject({ source: 'git', version: 1 });
  });
});

describe('the dry run', () => {
  it('prices quantities exactly with tiers, blocks and credit chains, in ranges low–expected–high, compared across variants', async () => {
    const r = (await dana('POST', '/costs/calculate', {
      variants: [
        {
          name: 'M',
          calculatorId: pipeline,
          currency: 'USD',
          books: [{ provider: 'Snowflake', bookId: snowList }],
          inputs: [
            { key: 'size', value: 'M' },
            { key: 'minutes', value: { low: 6, expected: 12, high: 24 } },
            { key: 'runs', value: 24 },
            { key: 'stored', value: 1000 },
          ],
        },
        {
          name: 'L',
          calculatorId: pipeline,
          currency: 'USD',
          books: [{ provider: 'Snowflake', bookId: snowList }],
          inputs: [
            { key: 'size', value: 'L' },
            { key: 'minutes', value: { low: 3, expected: 6, high: 12 } },
            { key: 'runs', value: 24 },
            { key: 'stored', value: 1000 },
          ],
        },
      ],
    })) as CostDryRunResult;
    const m = r.variants[0]!.result;
    // M: 4 credits/h × (12/60 × 24 × 730/24 = 146 h) = 584 credits × 3.10 = 1,810.40 USD; storage 1 TB-month × 23
    const compute = m.lines.find((l) => l.key === 'compute')!;
    expect(compute).toMatchObject({ unit: 'h', creditSku: 'compute-credit', book: { name: 'Snowflake list prices (demo)', kind: 'list' } });
    expect(compute.quantity).toEqual({ low: '73', expected: '146', high: '292' });
    expect(compute.credits).toEqual({ low: '292', expected: '584', high: '1168' });
    expect(num(compute.amount!.expected)).toBe(1810.4);
    expect(m.lines.find((l) => l.key === 'storage')).toMatchObject({ unit: 'TBy.mo', quantity: { expected: '1' }, amount: { expected: '23.00' } });
    expect(m.totals.monthly).toEqual({ low: '928.20', expected: '1833.40', high: '3643.80' });
    expect(m).toMatchObject({ ranged: true, hoursPerMonth: 730, missing: 0 });
    // L at half the runtime costs the same compute: the difference is zero
    expect(r.comparison[1]).toMatchObject({ name: 'L', monthly: { expected: '0.00' } });
    expect(r.cheapest.expected).toBe(0);
  });

  it('applies ad-hoc adjustments last, shown with their reason, and converts with a manual rate shown on the line', async () => {
    const { db } = await import('../src/db.js');
    db().run("DELETE FROM cost_fx_rates WHERE base = 'USD' AND quote = 'CHF'");
    const body = (adjustments: unknown[], currency = 'USD') => ({
      variants: [
        {
          currency,
          books: [{ provider: 'Snowflake', bookId: snowList }],
          lines: [
            { key: 'credits', provider: 'Snowflake', sku: 'compute-credit', quantity: '100', unit: '{credit}' },
            { key: 'store', provider: 'Snowflake', sku: 'storage', quantity: '2000', unit: 'GBy.mo' },
          ],
          adjustments,
        },
      ],
    });
    const plain = ((await dana('POST', '/costs/calculate', body([]))) as CostDryRunResult).variants[0]!.result;
    expect(plain.totals.monthly.expected).toBe('356.00');
    const adj = (
      (await dana(
        'POST',
        '/costs/calculate',
        body([
          { kind: 'percent', percent: '-15', reason: 'Negotiation target' },
          { line: 'store', kind: 'price', price: '20', currency: 'USD', reason: 'Offer not signed yet' },
        ]),
      )) as CostDryRunResult
    ).variants[0]!.result;
    const credits = adj.lines.find((l) => l.key === 'credits')!;
    expect(credits).toMatchObject({
      adjustment: { scope: 'estimate', kind: 'percent', value: '-15', reason: 'Negotiation target' },
      found: { expected: '310.00' },
    });
    expect(credits.amount!.expected).toBe('263.50');
    expect(adj.lines.find((l) => l.key === 'store')).toMatchObject({
      adjustment: { scope: 'line', kind: 'price', reason: 'Offer not signed yet' },
      amount: { expected: '40.00' },
    });
    expect(adj.adjusted).toBe(true);
    await expect(dana('POST', '/costs/calculate', body([{ kind: 'percent', percent: '-95', reason: 'x' }]))).rejects.toMatchObject({ status: 400 });
    await expect(dana('POST', '/costs/calculate', body([{ kind: 'percent', percent: '10', reason: '' }]))).rejects.toMatchObject({ status: 400 });
    // another currency needs a rate
    await expect(dana('POST', '/costs/calculate', body([], 'CHF'))).rejects.toMatchObject({
      status: 400,
      body: { code: 'COST_FX_RATE_MISSING', params: { from: 'USD', to: 'CHF' } },
    });
    await expect(vera('PUT', '/costs/fx-rates', { date: '2026-01-01', base: 'USD', quote: 'CHF', rate: '0.8' })).rejects.toMatchObject({ status: 403 });
    await dana('PUT', '/costs/fx-rates', { date: '2026-01-01', base: 'CHF', quote: 'USD', rate: '1.25' });
    const chf = ((await dana('POST', '/costs/calculate', body([], 'CHF'))) as CostDryRunResult).variants[0]!.result;
    // the inverse of 1.25 is 0.8: 356 USD → 284.80 CHF
    expect(chf.totals.monthly.expected).toBe('284.80');
    expect(chf.lines[0]!.fx).toEqual({ from: 'USD', rate: '0.80', date: '2026-01-01' });
    expect(chf.rates).toEqual([{ from: 'USD', to: 'CHF', rate: '0.80', date: '2026-01-01' }]);
  });

  it('refuses a unit that cannot become the item’s, ranges out of order, and marks items without a price', async () => {
    const line = (l: Record<string, unknown>) => ({
      variants: [{ currency: 'USD', lines: [{ provider: 'Snowflake', sku: 'storage', quantity: '1', unit: 'GBy.mo', ...l }] }],
    });
    await expect(dana('POST', '/costs/calculate', line({ unit: '{request}' }))).rejects.toMatchObject({ body: { code: 'COST_PRICE_UNIT_MISMATCH' } });
    await expect(dana('POST', '/costs/calculate', line({ quantity: { low: '3', expected: '2', high: '4' } }))).rejects.toMatchObject({
      body: { code: 'COST_RANGE_ORDER' },
    });
    await expect(
      dana('POST', '/costs/calculate', {
        variants: [{ calculatorId: pipeline, currency: 'USD', inputs: [{ key: 'minutes', value: { low: 5, expected: 4, high: 6 } }] }],
      }),
    ).rejects.toMatchObject({ body: { code: 'COST_RANGE_ORDER' } });
    const r = ((await dana('POST', '/costs/calculate', line({ sku: 'no-such-item' }))) as CostDryRunResult).variants[0]!.result;
    expect(r.lines[0]).toMatchObject({ missing: 'noItem', amount: null });
    expect(r.missing).toBe(1);
    const nobook = ((await dana('POST', '/costs/calculate', line({ provider: 'Nobody AG' }))) as CostDryRunResult).variants[0]!.result;
    expect(nobook.lines[0]).toMatchObject({ missing: 'noBook', book: null });
    await expect(dana('POST', '/costs/calculate', { variants: Array.from({ length: 6 }, () => ({ currency: 'USD', lines: [] })) })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('projects 36 months when a price changes within them (the contracted credit price rises)', async () => {
    const r = (
      (await dana('POST', '/costs/calculate', {
        variants: [{ currency: 'USD', lines: [{ provider: 'Snowflake', sku: 'compute-credit', quantity: '100', unit: '{credit}' }] }],
      })) as CostDryRunResult
    ).variants[0]!.result;
    // the admin's (and dana's) default for Snowflake: the platform's contracted book
    expect(r.lines[0]!.book?.kind).toBe('contracted');
    expect(r.months).toHaveLength(36);
    expect(r.months![0]!.monthly.expected).toBe('265.00');
    expect(r.months![35]!.monthly.expected).toBe('285.00');
  });
});

describe('estimates', () => {
  let est: CostEstimate;
  it('belongs to a service, keeps its inputs and the result, and is changed by who may change the plan', async () => {
    est = await dana('POST', '/costs/estimates', {
      title: 'Messaging for order mails',
      ownerKind: 'service',
      ownerId: shop,
      currency: 'EUR',
      calculatorId: (await s.api('GET', '/costs/calculators')).find((c: { name: string }) => c.name === 'Test throughput').id,
      inputs: [{ key: 'rate', value: { low: 20, expected: 50, high: 100 } }],
    });
    // 50/s × 3600 × 730 = 131,400,000 requests: 100M × 0.40 + 31.4M × 0.25 per 1M = 47.85; 3 seats × 12 = 36
    const requests = est.result!.lines.find((l) => l.key === 'requests')!;
    expect(requests.quantity.expected).toBe('131400000');
    expect(requests.amount!.expected).toBe('47.85');
    expect(requests.tiered).toBe(true);
    expect(est.result!.totals).toMatchObject({ monthly: { expected: '83.85' }, oneOff: { expected: '1500.00' }, recurring: { expected: '36.00' } });
    expect(est).toMatchObject({ canEdit: true, amountsVisible: true, owner: { kind: 'service', id: shop } });
    await expect(vera('PUT', `/costs/estimates/${est.id}`, { title: 'x', currency: 'EUR' })).rejects.toMatchObject({ status: 403 });
    // the list of the service and the audit trail
    const list = await vera('GET', `/costs/estimates?ownerKind=service&ownerId=${shop}`);
    expect(list.map((e: { title: string }) => e.title)).toContain('Messaging for order mails');
    const audit = (await s.api('GET', `/audit?action=cost.estimate_added&entityId=${shop}`)) as { details: Record<string, any> }[];
    expect(audit[0]!.details.totals.monthly.expected).toBe('83.85');
  });

  it('a change keeps the result before as history and records adjustments with their reason', async () => {
    const calcId = est.calculator!.id;
    const changed = (await dana('PUT', `/costs/estimates/${est.id}`, {
      title: est.title,
      currency: 'EUR',
      calculatorId: calcId,
      inputs: [{ key: 'rate', value: 50 }],
      adjustments: [{ line: 'seats', kind: 'percent', percent: '-50', reason: 'Two seats are shared' }],
    })) as CostEstimate;
    expect(changed.result!.lines.find((l) => l.key === 'seats')!.amount!.expected).toBe('18.00');
    expect(changed.adjustments[0]).toMatchObject({ reason: 'Two seats are shared', by: 'dana' });
    expect(changed.history).toHaveLength(1);
    const audit = (await s.api('GET', `/audit?action=cost.estimate_changed&entityId=${shop}`)) as { details: Record<string, any> }[];
    expect(audit[0]!.details.after.adjustments[0]).toMatchObject({ reason: 'Two seats are shared', value: '-50' });
  });

  it('proposes plan lines per group and fiscal year, confirmed by a person; Estimate changed and Update lines', async () => {
    const proposals = await dana('GET', `/costs/estimates/${est.id}/proposals`);
    const keys = proposals.lines.map((l: { key: string }) => l.key);
    expect(proposals.lines.map((l: { cadence: string }) => l.cadence)).toEqual(expect.arrayContaining(['monthly', 'once']));
    expect(proposals.hiddenRates).toBe(false);
    const added = await dana('POST', `/costs/estimates/${est.id}/proposals`, { fiscalYear: proposals.fiscalYear, keys });
    expect(added.added).toBe(keys.length);
    const year = (await dana('GET', `/costs/plans/${shop}?fiscalYear=${proposals.fiscalYear}`)) as CostPlanYear;
    const mine = year.lines.filter((l) => l.estimate?.id === est.id);
    expect(mine).toHaveLength(keys.length);
    expect(mine.every((l) => !l.estimate!.changed)).toBe(true);
    expect(mine[0]!.note).toContain('with ad-hoc adjustments');
    // the estimate changes: its lines say so, Update lines brings them up to date (a line changed by hand keeps its amount)
    await dana('PUT', `/costs/estimates/${est.id}`, {
      title: est.title,
      currency: 'EUR',
      calculatorId: est.calculator!.id,
      inputs: [{ key: 'seats', value: 5 }],
    });
    const after = (await dana('GET', `/costs/plans/${shop}?fiscalYear=${proposals.fiscalYear}`)) as CostPlanYear;
    expect(after.lines.filter((l) => l.estimate?.id === est.id).some((l) => l.estimate!.changed)).toBe(true);
    const upd = await dana('POST', `/costs/estimates/${est.id}/update-lines`, { fiscalYear: proposals.fiscalYear });
    expect(upd.updated).toBeGreaterThan(0);
    const fixed = (await dana('GET', `/costs/plans/${shop}?fiscalYear=${proposals.fiscalYear}`)) as CostPlanYear;
    expect(fixed.lines.filter((l) => l.estimate?.id === est.id).every((l) => !l.estimate!.changed)).toBe(true);
  });

  it('recalculates with new prices beside the current result until “Accept new prices”', async () => {
    const before = (await dana('GET', `/costs/estimates/${est.id}`)) as CostEstimate;
    const same = (await dana('POST', `/costs/estimates/${est.id}/recalculate`)) as CostEstimate;
    expect(same.pending).toBeNull();
    await s.api('PUT', `/costs/price-books/${saasBook}/entries`, {
      entries: [
        { sku: 'seat', name: 'Console seat', service: 'Console', driver: 'seats', unit: '{seat}.mo', charge: 'recurring', price: '15', currency: 'EUR' },
      ],
    });
    const r = (await dana('POST', `/costs/estimates/${est.id}/recalculate`)) as CostEstimate;
    expect(r.pending).not.toBeNull();
    expect(r.result!.totals.monthly.expected).toBe(before.result!.totals.monthly.expected);
    expect(r.pending!.changePct).toBeGreaterThan(0);
    const accepted = (await dana('POST', `/costs/estimates/${est.id}/accept`)) as CostEstimate;
    expect(accepted.pending).toBeNull();
    expect(Number(accepted.result!.totals.monthly.expected)).toBeGreaterThan(Number(before.result!.totals.monthly.expected));
    await expect(dana('POST', `/costs/estimates/${est.id}/accept`)).rejects.toMatchObject({ status: 409 });
  });

  it('a reader who may not see the contracted book sees the list price, marked; nobody learns the contracted figure', async () => {
    const e = (await s.api('POST', '/costs/estimates', {
      title: 'Credits at contract',
      ownerKind: 'service',
      ownerId: shop,
      currency: 'USD',
      lines: [{ key: 'c', provider: 'Snowflake', sku: 'compute-credit', quantity: '100', unit: '{credit}' }],
    })) as CostEstimate;
    expect(e.result!.lines[0]).toMatchObject({ priceHidden: false, book: { kind: 'contracted' }, amount: { expected: '265.00' } });
    const seen = (await vera('GET', `/costs/estimates/${e.id}`)) as CostEstimate;
    expect(seen.result!.lines[0]).toMatchObject({ priceHidden: true, book: { kind: 'list' }, unitPrice: '3.10', amount: { expected: '310.00' } });
    expect(seen.result!.atListPrice).toBe(true);
    expect(seen.result!.months).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('2.65');
    expect(seen.result!.books.every((b) => b.kind === 'list')).toBe(true);
    // the list of the service says it too
    const list = (await vera('GET', `/costs/estimates?ownerKind=service&ownerId=${shop}`)) as {
      id: string;
      atListPrice: boolean;
      monthly: { expected: string };
    }[];
    expect(list.find((x) => x.id === e.id)).toMatchObject({ atListPrice: true, monthly: { expected: '310.00' } });
    // plan lines from it ask first
    const p = await s.api('GET', `/costs/estimates/${e.id}/proposals`);
    expect(p.hiddenRates).toBe(true);
    await expect(s.api('POST', `/costs/estimates/${e.id}/proposals`, { fiscalYear: p.fiscalYear, keys: [p.lines[0].key] })).rejects.toMatchObject({
      status: 409,
      body: { code: 'COST_ESTIMATE_HIDDEN_RATES' },
    });
  });

  it('team scope: an estimate of a service the reader may not see is neither listed nor found', async () => {
    const { db } = await import('../src/db.js');
    const team = (await s.api('POST', '/teams', { name: 'Estimate secret team' })).id;
    const secret = (await s.api('POST', '/services', { name: 'Secret estimated service' })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('service', ?, ?, ?)", secret, team, new Date().toISOString());
    const e = await s.api('POST', '/costs/estimates', {
      title: 'Secret estimate',
      ownerKind: 'service',
      ownerId: secret,
      currency: 'USD',
      lines: [{ provider: 'Snowflake', sku: 'storage', quantity: '1', unit: 'TBy.mo' }],
    });
    await expect(olivia('GET', `/costs/estimates/${e.id}`)).rejects.toMatchObject({ status: 404 });
    await expect(olivia('GET', `/costs/estimates?ownerKind=service&ownerId=${secret}`)).rejects.toMatchObject({ status: 404 });
    const token = (await olivia('POST', '/me/tokens', { name: 'est', scope: 'read' })).token as string;
    const v1 = await fetch(`${s.base}/api/v1/cost-estimates?limit=200`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    expect(v1.items.map((x: { title: string }) => x.title)).not.toContain('Secret estimate');
    expect((await fetch(`${s.base}/api/v1/cost-estimates/${e.id}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    const admin = (await s.api('POST', '/me/tokens', { name: 'est-admin', scope: 'read' })).token as string;
    const all = await fetch(`${s.base}/api/v1/cost-estimates?limit=200`, { headers: { authorization: `Bearer ${admin}` } }).then((r) => r.json());
    expect(all.items.map((x: { title: string }) => x.title)).toContain('Secret estimate');
  });

  it('reads an estimate page with a fixed number of statements, whatever its number of lines', async () => {
    const { requestDbStats } = await import('../src/database/timing.js');
    const { runAs } = await import('../src/auth/context.js');
    const { getEstimate } = await import('../src/costs/estimates.js');
    const statements = (fn: () => void) => {
      const st = { statements: 0, ms: 0 };
      runAs(null, () => requestDbStats.run(st, fn));
      return st.statements;
    };
    const mk = async (n: number) =>
      (
        await s.api('POST', '/costs/estimates', {
          title: `Lines ${n}`,
          ownerKind: 'service',
          ownerId: shop,
          currency: 'USD',
          lines: Array.from({ length: n }, (_, i) => ({
            key: `x${i}`,
            provider: 'Snowflake',
            sku: 'storage',
            quantity: String(i + 1),
            unit: 'GBy.mo',
            group: `G${i % 7}`,
          })),
        })
      ).id as string;
    const one = await mk(1);
    const many = await mk(200);
    const a = statements(() => getEstimate(one));
    const b = statements(() => getEstimate(many));
    expect(b).toBe(a);
    expect(b).toBeLessThan(25);
    await expect(
      s.api('POST', '/costs/estimates', {
        title: 'Too many',
        ownerKind: 'service',
        ownerId: shop,
        currency: 'USD',
        lines: Array.from({ length: 201 }, (_, i) => ({ provider: 'Snowflake', sku: 'storage', quantity: '1', unit: 'GBy.mo', key: `y${i}` })),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('the public API and the MCP tools read what the token owner may see; the dry run stores nothing and is rate-limited', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    const token = (await s.api('POST', '/me/tokens', { name: 'mcp-costs', scope: 'mcp' })).token as string;
    const MODERN = '2026-07-28';
    let id = 1;
    const call = async (name: string, args: Record<string, unknown>) => {
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
          id: id++,
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
      const body = JSON.parse(text);
      if (!body.result) throw new Error(text);
      return body.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
    };
    const books = await call('list_price_books', {});
    expect(books.structuredContent.items.length).toBeGreaterThan(2);
    const units = await call('list_cost_units', {});
    expect(units.structuredContent.hoursPerMonth).toBe(730);
    expect(units.structuredContent.units.find((u: { unit: string }) => u.unit === 'GBy').convertsTo).toContain('TBy');
    const calc = await call('get_cost_calculator', { calculatorId: 'snowflake-pipeline' });
    expect(calc.structuredContent.inputs.map((i: { key: string }) => i.key)).toContain('size');
    const count = Number((await import('../src/db.js')).db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_estimates')!.n);
    const dry = await call('calculate_cost_estimate', {
      variants: [
        { name: 'S', calculatorId: 'snowflake-pipeline', currency: 'USD', inputs: [{ key: 'size', value: 'S' }] },
        { name: 'XL', calculatorId: 'snowflake-pipeline', currency: 'USD', inputs: [{ key: 'size', value: 'XL' }] },
      ],
    });
    expect(dry.isError).toBeFalsy();
    expect(dry.structuredContent.cheapest.expected).toBe(0);
    expect(Number((await import('../src/db.js')).db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_estimates')!.n)).toBe(count);
    const def = await call('calculate_cost_estimate', { variants: [{ definition: CALC, currency: 'USD' }] });
    expect(def.isError).toBe(true);
    // 30 calculations a minute per token: 2 used, 28 more variants pass, the next one is refused
    let refused = false;
    for (let i = 0; i < 6 && !refused; i++) {
      const r = await call('calculate_cost_estimate', { variants: Array.from({ length: 5 }, () => ({ currency: 'USD', lines: [] })) });
      refused = !!r.isError && r.content[0]!.text.includes('Rate limit');
    }
    expect(refused).toBe(true);
    const est = await call('list_cost_estimates', { serviceId: shop });
    expect(est.structuredContent.items.length).toBeGreaterThan(0);
  });

  it('removes an estimate; its plan lines stay as the team’s statements', async () => {
    const fy = fiscalYearOf(shiftMonth(new Date().toISOString().slice(0, 7), 0), 10);
    expect(fy).toBeGreaterThan(2000);
    await dana('DELETE', `/costs/estimates/${est.id}`);
    await expect(dana('GET', `/costs/estimates/${est.id}`)).rejects.toMatchObject({ status: 404 });
    const lines = Number(
      (await import('../src/db.js')).db().get<{ n: number }>("SELECT COUNT(*) AS n FROM cost_plan_lines WHERE note LIKE 'From the estimate “Messaging%'")!.n,
    );
    expect(lines).toBeGreaterThan(0);
  });
});
