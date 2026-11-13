import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Estimates for data products (ADR 0035 part 6, ADR 0036 part 11, phase 2): an estimate of a service or a platform may
 * be _for_ a data product its editor may see; the product's Costs tab sets estimated against attributed per month; the
 * MCP tool get_data_product_costs returns both, and the dry run calculate_cost_estimate can name a product to compare
 * with – nothing stored, team scope everywhere, a data product never the target of a plan line.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
const M = 1_000_000;
let s: TestServer;
let dana: Client;
let olivia: Client;
let shop = '';
let platform = '';
let product = '';
let month = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
  const { db } = await import('../src/db.js');
  shop = db().get<{ id: string }>("SELECT id FROM services WHERE name = 'Online shop (demo)'")!.id;
  platform = (await s.api('POST', '/platforms', { name: 'Invented estimate cloud', kind: 'rest', baseUrl: 'https://estimate.example.com' })).id;
  const { lastMonths } = await import('../src/dataproducts/costs.js');
  month = lastMonths(2)[0]!;
  const p = await dana('POST', '/data-products', { key: 'estimated', name: 'Estimated product' });
  product = p.id;
  await dana('PUT', `/data-products/${product}/environments/prod`, { state: 'available' });
  await dana('POST', `/data-products/${product}/costs/matches`, { environment: 'prod', platformId: platform, kind: 'resource', value: 'est-1' });
  db().tx(() => {
    for (let i = 0; i < 10; i++)
      db().run(
        `INSERT INTO cost_records (id, source_platform_id, source, line_key, granularity, billing_period_start, billing_period_end, charge_period_start, charge_period_end,
           month, billed_cost, effective_cost, billing_currency, resource_id, sub_account_id, service_name, tags, platform_id, application_id, read_at)
         VALUES (?, ?, 'focus', ?, 'day', ?, ?, ?, ?, ?, ?, ?, 'USD', 'est-1', '', 'X', '{}', ?, NULL, ?)`,
        `crec_est_${i}`,
        platform,
        `est-${i}`,
        `${month}-01T00:00:00Z`,
        `${month}-28T00:00:00Z`,
        `${month}-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        `${month}-${String(i + 1).padStart(2, '0')}T23:59:59Z`,
        month,
        100 * M,
        100 * M,
        platform,
        new Date().toISOString(),
      );
  });
}, 240_000);

describe('estimates for a data product', () => {
  let est = '';
  it('an estimate of a service may be for a data product its editor may see', async () => {
    const e = await s.api('POST', '/costs/estimates', {
      title: 'Orders pipeline',
      ownerKind: 'service',
      ownerId: shop,
      currency: 'USD',
      appliesFrom: month,
      for: { kind: 'dataProduct', id: product },
      lines: [{ key: 'st', provider: 'Snowflake', sku: 'storage', quantity: '10', unit: 'TBy.mo' }],
    });
    est = e.id;
    expect(e.for).toMatchObject({ kind: 'dataProduct', id: product, name: 'Estimated product', visible: true });
    // a product the editor may not see is refused like an unknown one
    await expect(
      s.api('POST', '/costs/estimates', {
        title: 'Nowhere',
        ownerKind: 'service',
        ownerId: shop,
        currency: 'USD',
        for: { kind: 'dataProduct', id: 'dpr_missing' },
      }),
    ).rejects.toMatchObject({ status: 400, body: { code: 'COST_PLAN_TARGET' } });
  });

  it('the product shows estimated against attributed, per month and currency', async () => {
    const v = await dana('GET', `/data-products/${product}/estimates?months=3`);
    expect(v.available).toBe(true);
    expect(v.estimates.map((x: any) => x.title)).toEqual(['Orders pipeline']);
    expect(v.estimates[0].for).toMatchObject({ kind: 'dataProduct', id: product });
    const row = v.comparison.find((x: any) => x.month === month && x.currency === 'USD');
    expect(row.attributedMicros).toBe(1000 * M);
    expect(row.estimated.expected).toBeGreaterThan(0);
    expect(row.estimated.low).toBeLessThanOrEqual(row.estimated.expected);
    // the months before the estimate applies have no estimate
    const earlier = v.comparison.filter((x: any) => x.month < month);
    expect(earlier.every((x: any) => x.estimated === null)).toBe(true);
  });

  it('plan lines from it are not for the data product (showback, never a plan target)', async () => {
    const p = await s.api('GET', `/costs/estimates/${est}/proposals`);
    if (!p.lines.length) return;
    await s.api('POST', `/costs/estimates/${est}/proposals`, { fiscalYear: p.fiscalYear, keys: [p.lines[0].key], confirmHidden: true });
    const { db } = await import('../src/db.js');
    const line = db().get<{ target_kind: string | null }>('SELECT target_kind FROM cost_plan_lines WHERE estimate_id = ?', est)!;
    expect(line.target_kind).toBeNull();
  });

  it('team scope: who may not see the product gets nothing; an estimate they may not read is neither listed nor counted', async () => {
    const { db } = await import('../src/db.js');
    const team = (await s.api('POST', '/teams', { name: 'Estimate product team' })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)", product, team, new Date().toISOString());
    await expect(olivia('GET', `/data-products/${product}/estimates`)).rejects.toMatchObject({ status: 404 });
    // the estimate itself still belongs to the service: its readers see it, the product unnamed
    const e = await olivia('GET', `/costs/estimates/${est}`);
    expect(e.for).toMatchObject({ kind: 'dataProduct', visible: false, name: '' });
    expect(JSON.stringify(e)).not.toContain('Estimated product');
    db().run("DELETE FROM resource_teams WHERE kind = 'data_product' AND resource_id = ?", product);
    // an estimate of a service the reader may not see: not listed on the product
    const secret = (await s.api('POST', '/services', { name: 'Secret estimating service' })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('service', ?, ?, ?)", secret, team, new Date().toISOString());
    await s.api('POST', '/costs/estimates', {
      title: 'Secret estimate for the product',
      ownerKind: 'service',
      ownerId: secret,
      currency: 'USD',
      for: { kind: 'dataProduct', id: product },
      lines: [{ provider: 'Snowflake', sku: 'storage', quantity: '1', unit: 'TBy.mo' }],
    });
    const v = await olivia('GET', `/data-products/${product}/estimates?months=3`);
    expect(v.estimates.map((x: any) => x.title)).not.toContain('Secret estimate for the product');
    expect(JSON.stringify(v)).not.toContain('Secret');
    const all = await s.api('GET', `/data-products/${product}/estimates?months=3`);
    expect(all.estimates.map((x: any) => x.title)).toContain('Secret estimate for the product');
  });

  it('without the Costs module: no estimates, the attributed costs stay', async () => {
    await s.api('PUT', '/settings/modules/costs', { enabled: false });
    try {
      const v = await dana('GET', `/data-products/${product}/estimates?months=3`);
      expect(v).toMatchObject({ available: false, estimates: [] });
      expect(v.comparison.find((x: any) => x.month === month).attributedMicros).toBe(1000 * M);
    } finally {
      await s.api('PUT', '/settings/modules/costs', { enabled: true });
    }
  });
});

describe('MCP', () => {
  let token = '';
  let id = 1;
  const call = async (name: string, args: Record<string, unknown>) => {
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
    const body = JSON.parse(await res.text());
    if (!body.result) throw new Error(JSON.stringify(body));
    return body.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
  };

  it('get_data_product_costs returns the estimates and estimated against attributed', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    token = (await s.api('POST', '/me/tokens', { name: 'mcp-dp-est', scope: 'mcp' })).token as string;
    const r = await call('get_data_product_costs', { productId: 'estimated', months: 3 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.estimates.map((e: any) => e.title)).toContain('Orders pipeline');
    const row = r.structuredContent.estimatedAgainstAttributed.find((x: any) => x.month === month);
    expect(row).toMatchObject({ currency: 'USD', attributed: '1000.00' });
    expect(Number(row.estimated.expected)).toBeGreaterThan(0);
  });

  it('calculate_cost_estimate compares the variants with a named product and stores nothing', async () => {
    const { db } = await import('../src/db.js');
    const count = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_estimates')!.n);
    const r = await call('calculate_cost_estimate', {
      variants: [{ name: 'Ten TB', currency: 'USD', lines: [{ provider: 'Snowflake', sku: 'storage', quantity: '10', unit: 'TBy.mo' }] }],
      compareWith: { dataProductId: 'estimated', months: 2 },
    });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent.dataProduct;
    expect(d.product).toMatchObject({ key: 'estimated' });
    expect(d.months.map((m: any) => m.month)).toContain(month);
    expect(d.variants[0]).toMatchObject({ name: 'Ten TB', currency: 'USD', productMonthly: '500.00' });
    expect(Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_estimates')!.n)).toBe(count);
    const missing = await call('calculate_cost_estimate', {
      variants: [{ currency: 'USD', lines: [] }],
      compareWith: { dataProductId: 'no-such-product' },
    });
    expect(missing.isError).toBe(true);
  });
});
