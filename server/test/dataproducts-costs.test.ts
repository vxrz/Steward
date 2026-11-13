import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer, storeAcl } from './helpers.js';

/**
 * Costs of data products (ADR 0036 part 11, WP4): matches by resource, sub-account, service, tag and application,
 * inherited from elements; direct lines and shares split equally or by weight – never above 100 % of a line, the rest
 * not attributed; hidden platform amounts make a month incomplete and are never part of a total; weights only for who
 * sees the platform's amounts; allocations only by the platform's managers, in a session, audited; the Costs tab with a
 * fixed number of statements whatever the number of products and lines; value beside cost.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let audrey: Client;
let olivia: Client;
let kafka = '';
let p1 = '';
let p2 = '';
let month = '';
const counted = new Map<string, number>();
const M = 1_000_000;

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};

let seq = 0;
/** One cost line a day for `days` days of `month`, `amount` (whole currency units) each. */
async function lines(
  platformId: string,
  m: string,
  days: number,
  amount: number,
  f: { resource?: string; subAccount?: string; service?: string; application?: string | null; tags?: Record<string, string>; currency?: string } = {},
): Promise<void> {
  const { db } = await import('../src/db.js');
  db().tx(() => {
    for (let i = 0; i < days; i++) {
      const d = `${m}-${String(i + 1).padStart(2, '0')}`;
      const n = seq++;
      db().run(
        `INSERT INTO cost_records (id, source_platform_id, source, line_key, granularity, billing_period_start, billing_period_end, charge_period_start, charge_period_end,
           month, billed_cost, effective_cost, billing_currency, resource_id, sub_account_id, service_name, tags, platform_id, application_id, read_at)
         VALUES (?, ?, 'focus', ?, 'day', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `crec_dp_${n}`,
        platformId,
        `dp-${n}`,
        `${m}-01T00:00:00Z`,
        `${m}-28T00:00:00Z`,
        `${d}T00:00:00Z`,
        `${d}T23:59:59Z`,
        m,
        Math.round(amount * M),
        Math.round(amount * M),
        f.currency ?? 'USD',
        f.resource ?? '',
        f.subAccount ?? '',
        f.service ?? '',
        JSON.stringify(f.tags ?? {}),
        platformId,
        f.application ?? null,
        new Date().toISOString(),
      );
    }
  });
}

interface CostsView {
  environment: string | null;
  months: { month: string; totals: { currency: string; amountMicros: number }[]; lines: any[]; incomplete: boolean; amountsHidden: boolean }[];
  matches: any[];
  value: { statement: string; tier: string | null; amount: number | null; currency: string | null };
  incomplete: boolean;
  amountsHidden: boolean;
}
const monthOf = (v: CostsView) => v.months.find((x) => x.month === month)!;
const total = (v: CostsView, currency = 'USD') => monthOf(v).totals.find((t) => t.currency === currency)?.amountMicros ?? 0;

const product = async (key: string, extra: Record<string, unknown> = {}) => {
  const p = await dana('POST', '/data-products', { key, name: `Product ${key}`, ...extra });
  await dana('PUT', `/data-products/${p.id}/environments/prod`, { state: 'available' });
  return p.id as string;
};
const match = (id: string, b: Record<string, unknown>, who: Client = dana) => who('POST', `/data-products/${id}/costs/matches`, { environment: 'prod', ...b });
const costs = (id: string, who: Client = dana, q = '') => who('GET', `/data-products/${id}/costs?months=3${q}`) as Promise<CostsView>;

beforeAll(async () => {
  s = await startTestServer({
    routes: (app) =>
      app.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(req.url, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  audrey = await s.as('audrey', PW);
  olivia = await s.as('olivia', PW);
  kafka = ((await s.api('GET', '/platforms')) as { id: string; kind: string }[]).find((p) => p.kind === 'kafka')!.id;
  p1 = (await s.api('POST', '/platforms', { name: 'Invented streaming cloud', kind: 'rest', baseUrl: 'https://stream.example.com' })).id;
  p2 = (await s.api('POST', '/platforms', { name: 'Invented warehouse cloud', kind: 'rest', baseUrl: 'https://warehouse.example.com' })).id;
  const { lastMonths } = await import('../src/dataproducts/costs.js');
  month = lastMonths(2)[0]!;
  // the cluster lkc-1 in the environment env-7: 100 USD a day; a connector lcc-9: 30 a day; tagged lines; a warehouse
  await lines(p1, month, 10, 100, { resource: 'lkc-1', subAccount: 'env-7', service: 'KAFKA' });
  await lines(p1, month, 10, 30, { resource: 'lcc-9', subAccount: 'env-7', service: 'CONNECT' });
  await lines(p1, month, 5, 10, { resource: 'lsrc-2', service: 'GOVERNANCE', tags: { product: 'orders' } });
  await lines(p2, month, 4, 25, { subAccount: 'ACME-WH', service: 'WAREHOUSE_METERING', currency: 'EUR' });
}, 180_000);

describe('the arithmetic', () => {
  it('splits a line in whole micros, never above it, the rounded share in total', async () => {
    const { splitMicros } = await import('../src/dataproducts/costs.js');
    expect(splitMicros(2, [1, 1, 1], 3)).toEqual([1, 1, 0]);
    // a whole line between three: the last micro goes to one of them
    expect(splitMicros(1, [1, 1, 1], 3)).toEqual([1, 0, 0]);
    expect(splitMicros(1, [1], 3)).toEqual([0]);
    expect(splitMicros(100, [1, 1, 1], 3).reduce((a, b) => a + b, 0)).toBe(100);
    expect(splitMicros(-100, [1, 1, 1], 3)).toEqual([-34, -33, -33]);
    // weights: 60 % and 30 % of 1,000,001 – 10 % not attributed
    const w = splitMicros(1_000_001, [6000, 3000], 10_000);
    expect(w).toEqual([600_001, 300_000]);
    expect(w[0]! + w[1]!).toBeLessThanOrEqual(1_000_001);
    expect(() => splitMicros(10, [6000, 5000], 10_000)).toThrow();
    // many products, odd amounts: the parts add up exactly
    for (const amount of [7, 999_999, 123_456_789]) {
      const parts = splitMicros(
        amount,
        Array.from({ length: 7 }, () => 1),
        7,
      );
      expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    }
  });
});

describe('matches, direct lines and shares', () => {
  let a = '';
  let b = '';
  let c = '';
  it('takes a line one product matches as its direct cost, and shows the value beside it', async () => {
    a = await product('cost-a', { valueStatement: 'Orders feed the shop and finance', valueTier: 'high', valueAmount: 120_000 * M, valueCurrency: 'USD' });
    b = await product('cost-b');
    const m = await match(a, { platformId: p1, kind: 'resource', value: 'lcc-9' });
    expect(m).toMatchObject({
      kind: 'resource',
      value: 'lcc-9',
      environment: 'prod',
      platformName: 'Invented streaming cloud',
      sharedWith: 0,
      canDelete: true,
    });
    const v = await costs(a);
    expect(v.environment).toBe('prod');
    expect(v.months.map((x) => x.month)).toHaveLength(3);
    expect(total(v)).toBe(300 * M);
    expect(monthOf(v).lines).toEqual([
      expect.objectContaining({
        platformId: p1,
        kind: 'direct',
        rule: null,
        share: 1,
        amountMicros: 300 * M,
        match: { kind: 'resource', value: 'lcc-9', tagKey: '' },
      }),
    ]);
    // value beside cost – never netted, no ratio
    expect(v.value).toEqual({ statement: 'Orders feed the shop and finance', tier: 'high', amount: 120_000 * M, currency: 'USD' });
    expect(JSON.stringify(v)).not.toMatch(/ratio|net/i);
    expect(v.incomplete).toBe(false);
  });

  it('refuses incomplete or repeated matches and keeps the instance limit', async () => {
    expect(await fail(match(a, { platformId: p1, kind: 'tag', value: 'orders' }))).toMatchObject({
      status: 400,
      code: 'DATA_COST_MATCH',
      params: { context: 'tagKey' },
    });
    expect(await fail(match(a, { platformId: p1, kind: 'resource', value: 'lcc-9' }))).toMatchObject({ status: 409, code: 'DATA_COST_MATCH' });
    expect(await fail(match(a, { platformId: 'plat_missing', kind: 'resource', value: 'x' }))).toMatchObject({
      code: 'DATA_COST_MATCH',
      params: { context: 'platform' },
    });
    // who may only read the product changes no match
    expect((await fail(match(a, { platformId: p1, kind: 'resource', value: 'other' }, olivia))).status).toBe(403);
    expect((await fail(match(a, { platformId: p1, kind: 'resource', value: 'other' }, vera))).status).toBe(403);
  });

  it('splits a line two products match equally, with the rule shown', async () => {
    await match(a, { platformId: p1, kind: 'resource', value: 'lkc-1' });
    await match(b, { platformId: p1, kind: 'resource', value: 'lkc-1' });
    const va = await costs(a);
    const share = monthOf(va).lines.find((l: any) => l.match.value === 'lkc-1');
    expect(share).toMatchObject({ kind: 'share', rule: 'equal', share: 0.5, amountMicros: 500 * M, products: 2 });
    expect(total(va)).toBe(800 * M);
    expect(total(await costs(b))).toBe(500 * M);
    expect(va.matches.find((m: any) => m.value === 'lkc-1').sharedWith).toBe(1);
  });

  it('matches by sub-account, service, tag and application', async () => {
    const t = await product('cost-tags');
    await match(t, { platformId: p1, kind: 'tag', tagKey: 'product', value: 'orders' });
    expect(total(await costs(t))).toBe(50 * M);
    const w = await product('cost-wh');
    await match(w, { platformId: p2, kind: 'subAccount', value: 'ACME-WH' });
    const vw = await costs(w);
    expect(total(vw, 'EUR')).toBe(100 * M);
    expect(total(vw, 'USD')).toBe(0);
    const sv = await product('cost-service');
    await match(sv, { platformId: p1, kind: 'service', value: 'GOVERNANCE' });
    // the governance lines are claimed by the tag (cost-tags) and the service (cost-service): shared equally
    expect(total(await costs(sv))).toBe(25 * M);
    expect(total(await costs(t))).toBe(25 * M);
    const app = ((await s.api('GET', '/applications')) as { id: string }[])[0]!.id;
    await lines(p2, month, 2, 5, { application: app, service: 'APP' });
    const ap = await product('cost-app');
    await match(ap, { platformId: p2, kind: 'application', value: app });
    expect(total(await costs(ap), 'USD')).toBe(10 * M);
  });

  it('inherits the matches of its elements in their environment', async () => {
    c = await product('cost-c');
    const topic = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'costs.connector.v1', environment: 'prod' }))
      .id;
    const dev = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'costs.connector.v1', environment: 'dev' })).id;
    await dana('POST', `/data-products/${c}/members`, { elementIds: [topic, dev], role: 'internal' });
    const em = await dana('POST', `/data-elements/${topic}/cost-matches`, { platformId: p1, kind: 'resource', value: 'lcc-9' });
    expect(em).toMatchObject({ elementId: topic, environment: 'prod', kind: 'resource' });
    expect((await dana('GET', `/data-elements/${topic}/cost-matches`)).map((m: any) => m.id)).toEqual([em.id]);
    const vc = await costs(c);
    expect(vc.matches).toEqual([
      expect.objectContaining({ id: em.id, productId: null, elementId: topic, element: expect.objectContaining({ visible: true }) }),
    ]);
    // lcc-9 is now claimed by a (own match) and c (through its element): equal halves
    expect(total(vc)).toBe(150 * M);
    expect(monthOf(await costs(a)).lines.find((l: any) => l.match.value === 'lcc-9')).toMatchObject({ kind: 'share', rule: 'equal', amountMicros: 150 * M });
    // the dev element's match counts in dev only
    await dana('POST', `/data-elements/${dev}/cost-matches`, { platformId: p2, kind: 'subAccount', value: 'ACME-WH' });
    const devView = await costs(c, dana, '&environment=dev');
    expect(devView.environment).toBe('dev');
    expect(total(devView, 'EUR')).toBe(50 * M);
    expect(total(await costs(c), 'EUR')).toBe(0);
    // a viewer reads the product's costs but changes no element's match
    expect((await fail(vera('POST', `/data-elements/${topic}/cost-matches`, { platformId: p1, kind: 'resource', value: 'x' }))).status).toBe(403);
  });

  it('splits by weight when the platform team says so – never above 100 %, the rest not attributed', async () => {
    const body = { platformId: p1, kind: 'resource', value: 'lkc-1', rule: 'weight' };
    // designers use the platform but do not manage it
    expect((await fail(dana('PUT', '/data-products/cost-allocations', { ...body, weights: [{ productId: a, pct: 60 }] }))).status).toBe(403);
    expect(
      await fail(
        s.api('PUT', '/data-products/cost-allocations', {
          ...body,
          weights: [
            { productId: a, pct: 70 },
            { productId: b, pct: 40 },
          ],
        }),
      ),
    ).toMatchObject({ status: 400, code: 'DATA_COST_ALLOCATION', params: { context: 'over100' } });
    expect(await fail(s.api('PUT', '/data-products/cost-allocations', { ...body, weights: [{ productId: c, pct: 10 }] }))).toMatchObject({
      code: 'DATA_COST_ALLOCATION',
      params: { context: 'product' },
    });
    expect(await fail(s.api('PUT', '/data-products/cost-allocations', { ...body, rule: 'measured', weights: [] }))).toMatchObject({ status: 400 });
    const al = await s.api('PUT', '/data-products/cost-allocations', {
      ...body,
      weights: [
        { productId: a, pct: 60 },
        { productId: b, pct: 30 },
      ],
    });
    expect(al).toMatchObject({ rule: 'weight', notAttributedPct: 10, hiddenProducts: 0, weightsShown: true, canEdit: true });
    expect(al.products.map((p: any) => [p.product.key, p.weightPct])).toEqual([
      ['cost-a', 60],
      ['cost-b', 30],
    ]);
    const la = monthOf(await costs(a)).lines.find((l: any) => l.match.value === 'lkc-1');
    expect(la).toMatchObject({ kind: 'share', rule: 'weight', share: 0.6, amountMicros: 600 * M });
    expect(monthOf(await costs(b)).lines.find((l: any) => l.match.value === 'lkc-1')).toMatchObject({ rule: 'weight', amountMicros: 300 * M });
    // audited on the platform
    const { db } = await import('../src/db.js');
    const entry = db().get<{ summary: string; details: string }>(
      "SELECT summary, details FROM audit_log WHERE action = 'dataproduct.cost_allocation_changed' AND entity_id = ? ORDER BY ts DESC LIMIT 1",
      p1,
    );
    expect(entry?.summary).toContain('equal → weight');
    expect(JSON.parse(entry!.details).after.weights).toEqual({ [a]: 60, [b]: 30 });
    // allocations need a session: an API token is refused
    const token = (await s.api('POST', '/me/tokens', { name: 'alloc', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/data-products/cost-allocations`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, rule: 'equal', weights: [] }),
    });
    expect(res.status).toBe(403);
  });

  it('never attributes more than the lines together, whatever the split', async () => {
    const { productCostsOf } = await import('../src/dataproducts/costs.js');
    const { db } = await import('../src/db.js');
    const ids = db()
      .all<{ id: string }>("SELECT id FROM dp_products WHERE key LIKE 'cost-%'")
      .map((r) => r.id);
    const all = productCostsOf(null, ids, [month]);
    let attributed = 0;
    for (const byEnv of all.values())
      for (const byMonth of byEnv.values()) for (const c of byMonth.values()) for (const l of c.lines) if (l.platformId === p1) attributed += l.amountMicros;
    const read = Number(db().get<{ n: number }>('SELECT SUM(effective_cost) AS n FROM cost_records WHERE platform_id = ? AND month = ?', p1, month)!.n);
    expect(attributed).toBeLessThanOrEqual(read);
    // 10 % of lkc-1 is not attributed: 100 USD
    expect(read - attributed).toBe(100 * M);
  });

  it('lists the shared lines with hidden products counted, weights only for who sees the amounts', async () => {
    const team = (await s.api('POST', '/teams', { name: 'Invented hidden data team', members: ['olivia'] })).id;
    const h = (await s.api('POST', '/data-products', { key: 'cost-hidden', name: 'Hidden product' })).id;
    const { db } = await import('../src/db.js');
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)", h, team, new Date().toISOString());
    await s.api('POST', `/data-products/${h}/costs/matches`, { environment: 'prod', platformId: p1, kind: 'resource', value: 'lkc-1' });
    // dana manages the platform now
    await storeAcl('platform', p1, [{ subject: 'user:dana', permissions: ['manage'] }]);
    const list = (await dana('GET', `/data-products/cost-allocations?platformId=${p1}`)) as any[];
    const lkc = list.find((x) => x.value === 'lkc-1');
    expect(lkc.products.map((p: any) => p.product.key)).toEqual(['cost-a', 'cost-b']);
    expect(lkc).toMatchObject({ hiddenProducts: 1, hiddenWeightPct: 0, notAttributedPct: 10, canEdit: true, weightsShown: true });
    expect(JSON.stringify(lkc)).not.toContain('Hidden product');
    // the manager changes the weights of what they see; the hidden product's weight stays
    const changed = await dana('PUT', '/data-products/cost-allocations', {
      platformId: p1,
      kind: 'resource',
      value: 'lkc-1',
      rule: 'weight',
      weights: [
        { productId: a, pct: 50 },
        { productId: b, pct: 25 },
      ],
    });
    expect(changed.notAttributedPct).toBe(25);
    // the hidden product cannot be named by who may not see it
    expect(
      await fail(
        dana('PUT', '/data-products/cost-allocations', {
          platformId: p1,
          kind: 'resource',
          value: 'lkc-1',
          rule: 'weight',
          weights: [{ productId: h, pct: 5 }],
        }),
      ),
    ).toMatchObject({ params: { context: 'product' } });
    // the admin gives the hidden product 25 %: together exactly 100 %
    const full = await s.api('PUT', '/data-products/cost-allocations', {
      platformId: p1,
      kind: 'resource',
      value: 'lkc-1',
      rule: 'weight',
      weights: [
        { productId: a, pct: 50 },
        { productId: b, pct: 25 },
        { productId: h, pct: 25 },
      ],
    });
    expect(full.notAttributedPct).toBe(0);
    const forDana = ((await dana('GET', `/data-products/cost-allocations?platformId=${p1}`)) as any[]).find((x) => x.value === 'lkc-1');
    expect(forDana).toMatchObject({ hiddenProducts: 1, hiddenWeightPct: 25, notAttributedPct: 0 });
    // viewers see no platforms: no allocations
    expect(await vera('GET', '/data-products/cost-allocations')).toEqual([]);
    await storeAcl('platform', p1, []);
  });

  it('makes a month incomplete where the reader may not see the amounts – never a figure to subtract from', async () => {
    const full = await costs(a, s.api);
    expect(full.incomplete).toBe(false);
    const all = total(full);
    expect(all).toBeGreaterThan(0);
    // auditors see every platform's costs
    expect(total(await costs(a, audrey))).toBe(all);
    // viewers see no platforms: the product's costs are there, but hidden – no line, no total, no match value
    const v = await costs(a, vera);
    expect(monthOf(v)).toMatchObject({ incomplete: true, amountsHidden: true, lines: [], totals: [] });
    expect(v.incomplete).toBe(true);
    expect(v.matches.every((m: any) => m.platformHidden && m.value === null && m.platformName === null)).toBe(true);
    expect(JSON.stringify(v)).not.toContain('lkc-1');
    // Hide amounts from viewers: who uses the platform but neither manages nor owns it sees no amounts
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: true, defaultCurrency: 'USD', fiscalYearStartMonth: 1 });
    try {
      const d = await costs(a);
      expect(monthOf(d)).toMatchObject({ incomplete: true, amountsHidden: true, totals: [] });
      // a product on two platforms: the visible one's part is shown, the total marked incomplete
      await storeAcl('platform', p2, [{ subject: 'user:dana', permissions: ['manage'] }]);
      await match(a, { platformId: p2, kind: 'subAccount', value: 'ACME-WH' });
      const mixed = await costs(a);
      expect(monthOf(mixed).incomplete).toBe(true);
      expect(monthOf(mixed).lines.every((l: any) => l.platformId === p2)).toBe(true);
      expect(monthOf(mixed).totals.map((t) => t.currency)).toEqual(['EUR']);
      // the allocation's weights are not shown to who does not see the amounts
      const al = ((await dana('GET', `/data-products/cost-allocations?platformId=${p1}`)) as any[]).find((x) => x.value === 'lkc-1');
      expect(al).toMatchObject({ weightsShown: false, hiddenWeightPct: null, notAttributedPct: null });
      expect(al.products.every((p: any) => p.weightPct === null)).toBe(true);
      await storeAcl('platform', p2, []);
    } finally {
      await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD', fiscalYearStartMonth: 1 });
    }
  });

  it('removes a match with the product right and its element with its matches', async () => {
    const v = await costs(b);
    const m = v.matches[0];
    expect((await fail(olivia('DELETE', `/data-products/${b}/costs/matches/${m.id}`))).status).toBe(403);
    await dana('DELETE', `/data-products/${b}/costs/matches/${m.id}`);
    expect((await costs(b)).matches).toEqual([]);
    expect(await fail(dana('DELETE', `/data-products/${b}/costs/matches/${m.id}`))).toMatchObject({ status: 404, code: 'DATA_COST_MATCH' });
    const vc = await costs(c);
    const elementId = vc.matches[0].elementId;
    await dana('DELETE', `/data-elements/${elementId}`).catch(() => undefined);
    const { db } = await import('../src/db.js');
    const { deleteElementRows } = await import('../src/dataproducts/store.js');
    deleteElementRows([elementId]);
    expect(db().get('SELECT 1 FROM dp_cost_matches WHERE element_id = ?', elementId)).toBeUndefined();
  });
});

describe('performance', () => {
  it('reads the Costs tab with a fixed number of statements whatever the number of products and lines', async () => {
    const x = await product('cost-perf');
    await match(x, { platformId: p1, kind: 'subAccount', value: 'env-7' });
    const url = `/api/data-products/${x}/costs?months=3`;
    await costs(x);
    await costs(x);
    const few = counted.get(url)!;
    expect(few).toBeGreaterThan(0);
    // 60 more products sharing the account, 3,000 more lines
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    db().tx(() => {
      for (let i = 0; i < 60; i++) {
        const id = `dpr_perf_${i}`;
        db().run(
          `INSERT INTO dp_products (id, key, name, name_norm, owners, lifecycle, lifecycle_dates, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, '[]', 'draft', '{}', ?, 'admin', ?, 'admin')`,
          id,
          `perf-${i}`,
          `Perf ${i}`,
          `perf ${i}`,
          now,
          now,
        );
        db().run(
          `INSERT INTO dp_cost_matches (id, product_id, element_id, environment, platform_id, match_kind, match_value, tag_key, created_at, created_by)
           VALUES (?, ?, NULL, 'prod', ?, 'subAccount', 'env-7', '', ?, 'admin')`,
          `dpm_perf_${i}`,
          id,
          p1,
          now,
        );
      }
    });
    for (let i = 0; i < 30; i++) await lines(p1, month, 28, 1, { resource: `lkc-perf-${i}`, subAccount: 'env-7', service: 'KAFKA' });
    await lines(p1, lastMonthsNow(1), 3, 2, { resource: 'lkc-perf-now', subAccount: 'env-7', service: 'KAFKA' });
    const v = await costs(x);
    expect(monthOf(v).lines.length).toBeGreaterThan(1);
    expect(monthOf(v).lines.find((l: any) => l.match.value === 'env-7')).toMatchObject({ kind: 'share', products: 61 });
    expect(counted.get(url)).toBe(few);
    // (0.23.0: deciding a platform reads its shares and the Restricted ones once per request – fixed, not per line)
    expect(few).toBeLessThanOrEqual(27);
  });
});

function lastMonthsNow(n: number): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (n - 1), 1)).toISOString().slice(0, 7);
}
