import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Cost splitting by measured use (ADR 0036 part 11, phase 2; docs/DATA-PRODUCTS.md#measured-use): Snowflake credits per
 * warehouse and per query tag, Confluent bytes per topic – read by the job through the platforms' clients (metadata
 * views and the Metrics API, the tags bound, never in a statement's text), priced with the platform's contracted book
 * (the price per credit) or, without a price, as the share of the measured total; never more than 100 % of a line, the
 * rest not attributed; hidden amounts keep the total incomplete; only the platform's managers set it; the Costs tab
 * keeps a fixed number of statements.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
const M = 1_000_000;
let s: TestServer;
let dana: Client;
let vera: Client;
let snowflake = '';
let kafka = '';
let confluent = '';
let month = '';
const counted = new Map<string, number>();

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
async function lines(
  platformId: string,
  sourcePlatformId: string,
  days: number,
  amount: number,
  f: { resource?: string; subAccount?: string; service?: string },
) {
  const { db } = await import('../src/db.js');
  db().tx(() => {
    for (let i = 0; i < days; i++) {
      const d = `${month}-${String(i + 1).padStart(2, '0')}`;
      const n = seq++;
      db().run(
        `INSERT INTO cost_records (id, source_platform_id, source, line_key, granularity, billing_period_start, billing_period_end, charge_period_start, charge_period_end,
           month, billed_cost, effective_cost, billing_currency, resource_id, sub_account_id, service_name, tags, platform_id, application_id, read_at)
         VALUES (?, ?, 'focus', ?, 'day', ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, '{}', ?, NULL, ?)`,
        `crec_ms_${n}`,
        sourcePlatformId,
        `ms-${n}`,
        `${month}-01T00:00:00Z`,
        `${month}-28T00:00:00Z`,
        `${d}T00:00:00Z`,
        `${d}T23:59:59Z`,
        month,
        Math.round(amount * M),
        Math.round(amount * M),
        f.resource ?? '',
        f.subAccount ?? '',
        f.service ?? '',
        platformId,
        new Date().toISOString(),
      );
    }
  });
}

interface CostsView {
  months: { month: string; totals: { currency: string; amountMicros: number }[]; lines: any[]; incomplete: boolean; amountsHidden: boolean }[];
  incomplete: boolean;
}
const product = async (key: string) => {
  const p = await dana('POST', '/data-products', { key, name: `Measured ${key}` });
  await dana('PUT', `/data-products/${p.id}/environments/prod`, { state: 'available' });
  return p.id as string;
};
const match = (id: string, b: Record<string, unknown>) => dana('POST', `/data-products/${id}/costs/matches`, { environment: 'prod', ...b });
const costs = (id: string, who: Client = dana) => who('GET', `/data-products/${id}/costs?months=3`) as Promise<CostsView>;
const lineOf = (v: CostsView, value: string) => v.months.find((x) => x.month === month)!.lines.find((l: any) => l.match.value === value);
const allocation = (b: Record<string, unknown>) => s.api('PUT', '/data-products/cost-allocations', b);
const read = async () => {
  const { readMeasuredUse } = await import('../src/dataproducts/measured.js');
  return readMeasuredUse(Date.now(), { force: true });
};

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
  const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string; name: string }[];
  snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  kafka = platforms.find((p) => p.name === 'Kafka (demo)')!.id;
  confluent = platforms.find((p) => p.kind === 'confluent-cloud')!.id;
  const { lastMonths } = await import('../src/dataproducts/costs.js');
  month = lastMonths(2)[0]!;
  // a Snowflake account's warehouse metering: 100 USD a day; a smaller service line; the Confluent cluster's lines
  await lines(snowflake, snowflake, 10, 100, { subAccount: 'MEAS-ACCT', service: 'WAREHOUSE_METERING' });
  await lines(snowflake, snowflake, 4, 50, { subAccount: 'MEAS-SMALL', service: 'WAREHOUSE_METERING' });
  await lines(snowflake, snowflake, 10, 20, { subAccount: 'MEAS-TAGS', service: 'WAREHOUSE_METERING' });
  await lines(kafka, confluent, 10, 50, { resource: 'lkc-demo1', service: 'KAFKA' });
}, 180_000);

describe('Snowflake warehouses', () => {
  let a = '';
  let b = '';
  it('only the platform’s managers set it, for the measures of its kind', async () => {
    a = await product('meas-a');
    b = await product('meas-b');
    for (const p of [a, b]) {
      await match(p, { platformId: snowflake, kind: 'subAccount', value: 'MEAS-ACCT' });
      await match(p, { platformId: snowflake, kind: 'subAccount', value: 'MEAS-SMALL' });
    }
    const body = { platformId: snowflake, kind: 'subAccount', value: 'MEAS-ACCT', rule: 'measured', measure: 'snowflakeWarehouse' };
    // a designer who may not manage the platform
    expect((await fail(dana('PUT', '/data-products/cost-allocations', body))).status).toBe(403);
    expect(await fail(allocation({ ...body, measure: undefined }))).toMatchObject({ code: 'DATA_COST_ALLOCATION', params: { context: 'measure' } });
    expect(await fail(allocation({ ...body, measure: 'confluentTopic' }))).toMatchObject({
      code: 'DATA_COST_ALLOCATION',
      params: { context: 'measurePlatform' },
    });
    const al = await allocation({
      ...body,
      subjects: [
        { productId: a, subjects: ['transform_wh'] },
        { productId: b, subjects: ['BI_WH'] },
      ],
    });
    expect(al).toMatchObject({ rule: 'measured', measured: { measure: 'snowflakeWarehouse', readAt: null, error: null, pricing: 'share' } });
    expect(al.products.map((x: any) => [x.product.key, x.subjects])).toEqual([
      ['meas-a', ['TRANSFORM_WH']],
      ['meas-b', ['BI_WH']],
    ]);
    await allocation({
      ...body,
      value: 'MEAS-SMALL',
      subjects: [
        { productId: a, subjects: ['TRANSFORM_WH'] },
        { productId: b, subjects: ['BI_WH'] },
      ],
    });
    // audited on the platform, with the measure and the subjects
    const { db } = await import('../src/db.js');
    const e = db().get<{ details: string }>(
      "SELECT details FROM audit_log WHERE action = 'dataproduct.cost_allocation_changed' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
      snowflake,
    )!;
    expect(JSON.parse(e.details).after).toMatchObject({ rule: 'measured', measure: 'snowflakeWarehouse' });
  });

  it('reads the credits per warehouse with metadata statements only, as who set it', async () => {
    const { snowflakeStatements } = await import('../src/mock/mockSnowflake.js');
    const before = snowflakeStatements().length;
    const r = await read();
    expect(r.failed).toBe(0);
    const sent = snowflakeStatements().slice(before);
    expect(sent.length).toBeGreaterThan(0);
    for (const x of sent) {
      expect(x.sql).toMatch(/^\/\* steward:costs-measure-(warehouses|tags) \*\/ SELECT /);
      expect(x.sql).toMatch(/FROM SNOWFLAKE\.ACCOUNT_USAGE\.(WAREHOUSE_METERING_HISTORY|QUERY_ATTRIBUTION_HISTORY) /);
      expect(x.sql).not.toMatch(/TRANSFORM_WH|BI_WH/);
    }
    const al = ((await s.api('GET', `/data-products/cost-allocations?platformId=${snowflake}`)) as any[]).find((x) => x.value === 'MEAS-ACCT');
    expect(al.measured.readAt).toBeTruthy();
    expect(al.measured.error).toBeNull();
  });

  it('reads as the person who set an allocation of the measure last – not the first by name', async () => {
    const { db } = await import('../src/db.js');
    const row = db().get<{ id: string; updated_at: string; updated_by: string }>(
      "SELECT id, updated_at, updated_by FROM dp_cost_allocations WHERE platform_id = ? AND match_value = 'MEAS-ACCT'",
      snowflake,
    )!;
    // an earlier setter who is gone (first by name); the later one may still read
    db().run('UPDATE dp_cost_allocations SET updated_by = ?, updated_at = ? WHERE id = ?', 'aaa-former-manager', '2020-01-01T00:00:00.000Z', row.id);
    try {
      expect((await read()).failed).toBe(0);
    } finally {
      db().run('UPDATE dp_cost_allocations SET updated_by = ?, updated_at = ? WHERE id = ?', row.updated_by, row.updated_at, row.id);
    }
  });

  it('without a price: each product’s share of the measured credits – never above the line, the rest not attributed', async () => {
    const { DEMO_WAREHOUSE_CREDITS } = await import('../src/mock/mockSnowflake.js');
    const total = Object.values(DEMO_WAREHOUSE_CREDITS).reduce((x, y) => x + y, 0);
    const la = lineOf(await costs(a), 'MEAS-ACCT');
    const lb = lineOf(await costs(b), 'MEAS-ACCT');
    expect(la).toMatchObject({ kind: 'share', rule: 'measured', measured: { measure: 'snowflakeWarehouse', priced: false } });
    expect(Math.abs(la.amountMicros - (1000 * M * DEMO_WAREHOUSE_CREDITS.TRANSFORM_WH!) / total)).toBeLessThanOrEqual(1);
    expect(Math.abs(lb.amountMicros - (1000 * M * 40) / total)).toBeLessThanOrEqual(1);
    expect(la.amountMicros + lb.amountMicros).toBeLessThan(1000 * M);
  });

  it('with the platform’s price per credit: credits × price, scaled down to the line when more', async () => {
    const { db } = await import('../src/db.js');
    const { setCreditPrice } = await import('../src/costs/price-books.js');
    db().tx(() => setCreditPrice(snowflake, 'Snowflake (demo)', '2.00', 'USD'));
    const al = ((await s.api('GET', `/data-products/cost-allocations?platformId=${snowflake}`)) as any[]).find((x) => x.value === 'MEAS-ACCT');
    expect(al.measured.pricing).toBe('book');
    // 120.5 and 40 credits × 2 USD: 241 and 80 of 1,000 USD – 679 USD not attributed
    expect(lineOf(await costs(a), 'MEAS-ACCT')).toMatchObject({ amountMicros: 241 * M, measured: { priced: true } });
    expect(lineOf(await costs(b), 'MEAS-ACCT')).toMatchObject({ amountMicros: 80 * M });
    // the small line (200 USD) is less than the priced use: split in the same proportion, never above it
    const sa = lineOf(await costs(a), 'MEAS-SMALL').amountMicros;
    const sb = lineOf(await costs(b), 'MEAS-SMALL').amountMicros;
    expect(sa + sb).toBeLessThanOrEqual(200 * M);
    expect(sa + sb).toBeGreaterThanOrEqual(200 * M - 1);
    expect(Math.abs(sa - (200 * M * 241) / 321)).toBeLessThanOrEqual(1);
    // the background attribution of all products together never exceeds a line
    const { productCostsOf } = await import('../src/dataproducts/costs.js');
    const all = productCostsOf(null, [a, b], [month]);
    let sum = 0;
    for (const byEnv of all.values())
      for (const byMonth of byEnv.values())
        for (const c of byMonth.values()) for (const l of c.lines) if (l.match.value === 'MEAS-SMALL') sum += l.amountMicros;
    expect(sum).toBeLessThanOrEqual(200 * M);
  });

  it('keeps the total incomplete where the reader may not see the amounts – no measured figure either', async () => {
    const v = await costs(a, vera);
    const m = v.months.find((x) => x.month === month)!;
    expect(m).toMatchObject({ incomplete: true, amountsHidden: true, lines: [], totals: [] });
    expect(JSON.stringify(v)).not.toMatch(/TRANSFORM_WH|MEAS-ACCT/);
    expect(await vera('GET', `/data-products/cost-allocations?platformId=${snowflake}`)).toEqual([]);
  });

  it('stops reading when who set it may no longer use the platform', async () => {
    const { db } = await import('../src/db.js');
    db().run("UPDATE dp_cost_allocations SET updated_by = 'vera' WHERE platform_id = ? AND measure = 'snowflakeWarehouse'", snowflake);
    const r = await read();
    expect(r.failed).toBeGreaterThan(0);
    const row = db().get<{ read_error: string | null }>(
      "SELECT read_error FROM dp_cost_allocations WHERE platform_id = ? AND match_value = 'MEAS-ACCT'",
      snowflake,
    )!;
    expect(row.read_error).toContain('vera');
    // the quantities read before stay – the shares do not drop to nothing because one read failed
    expect(lineOf(await costs(a), 'MEAS-ACCT')).toMatchObject({ amountMicros: 241 * M });
    db().run("UPDATE dp_cost_allocations SET updated_by = 'admin' WHERE platform_id = ? AND measure = 'snowflakeWarehouse'", snowflake);
    await read();
  });
});

describe('Snowflake query tags', () => {
  it('prices the credits of a product’s query tags (the tags bound, never in the statement)', async () => {
    const c = await product('meas-c');
    const d = await product('meas-d');
    for (const p of [c, d]) await match(p, { platformId: snowflake, kind: 'subAccount', value: 'MEAS-TAGS' });
    await allocation({
      platformId: snowflake,
      kind: 'subAccount',
      value: 'MEAS-TAGS',
      rule: 'measured',
      measure: 'snowflakeQueryTag',
      subjects: [
        { productId: c, subjects: ['orders'] },
        { productId: d, subjects: ['customer360', 'unknown-tag'] },
      ],
    });
    const { snowflakeStatements } = await import('../src/mock/mockSnowflake.js');
    const before = snowflakeStatements().length;
    await read();
    const tags = snowflakeStatements()
      .slice(before)
      .filter((x) => x.sql.includes('costs-measure-tags'));
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0]!.sql).not.toContain('orders');
    expect(tags[0]!.bindings).toEqual(expect.arrayContaining(['orders', 'customer360', 'unknown-tag']));
    // 30.5 and 12.25 credits × 2 USD of a 200 USD line
    expect(lineOf(await costs(c), 'MEAS-TAGS')).toMatchObject({
      rule: 'measured',
      amountMicros: 61 * M,
      measured: { measure: 'snowflakeQueryTag', priced: true },
    });
    expect(lineOf(await costs(d), 'MEAS-TAGS')).toMatchObject({ amountMicros: 24.5 * M });
  });
});

describe('Confluent topics', () => {
  it('splits the cluster by the bytes of each product’s topics – declared, or its member topics', async () => {
    const e = await product('meas-e');
    const f = await product('meas-f');
    for (const p of [e, f]) await match(p, { platformId: kafka, kind: 'resource', value: 'lkc-demo1' });
    // f's topic is a member element; e names its topic
    const el = await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'payments', environment: 'prod' });
    await dana('POST', `/data-products/${f}/members`, { elementIds: [el.id], role: 'output' });
    expect(await fail(allocation({ platformId: kafka, kind: 'resource', value: 'lkc-demo1', rule: 'measured', measure: 'snowflakeWarehouse' }))).toMatchObject({
      params: { context: 'measurePlatform' },
    });
    const al = await allocation({
      platformId: kafka,
      kind: 'resource',
      value: 'lkc-demo1',
      rule: 'measured',
      measure: 'confluentTopic',
      subjects: [{ productId: e, subjects: ['orders'] }],
    });
    expect(al.products.find((x: any) => x.product.key === 'meas-f').subjects).toEqual(['payments']);
    const r = await read();
    expect(r.failed).toBe(0);
    // the Metrics API: orders 6, payments 3, clicks 1 GB a day – e 60 %, f 30 % of the cluster's lines (the demo's and
    // ours), a tenth not attributed
    const { db } = await import('../src/db.js');
    const line = Number(
      db().get<{ n: number }>(
        "SELECT SUM(effective_cost) AS n FROM cost_records WHERE platform_id = ? AND resource_id = 'lkc-demo1' AND month = ?",
        kafka,
        month,
      )!.n,
    );
    const le = lineOf(await costs(e), 'lkc-demo1');
    const lf = lineOf(await costs(f), 'lkc-demo1');
    expect(le).toMatchObject({ rule: 'measured', share: 0.6, measured: { measure: 'confluentTopic', priced: false } });
    expect(lf).toMatchObject({ share: 0.3 });
    expect(Math.abs(le.amountMicros - line * 0.6)).toBeLessThanOrEqual(1);
    expect(Math.abs(lf.amountMicros - line * 0.3)).toBeLessThanOrEqual(1);
    expect(le.amountMicros + lf.amountMicros).toBeLessThan(line);
    expect(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM dp_cost_usage WHERE measure = 'confluentTopic' AND subject = 'shop-events.clicks'")!.n).toBe(0);
  });
});

describe('performance', () => {
  it('reads the Costs tab with measured use in a fixed number of statements whatever the number of products', async () => {
    const x = await product('meas-perf');
    await match(x, { platformId: snowflake, kind: 'subAccount', value: 'MEAS-ACCT' });
    const url = `/api/data-products/${x}/costs?months=3`;
    await costs(x);
    await costs(x);
    const few = counted.get(url)!;
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    const ids: string[] = [];
    db().tx(() => {
      for (let i = 0; i < 40; i++) {
        const id = `dpr_measperf_${i}`;
        ids.push(id);
        db().run(
          `INSERT INTO dp_products (id, key, name, name_norm, owners, lifecycle, lifecycle_dates, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, '[]', 'draft', '{}', ?, 'admin', ?, 'admin')`,
          id,
          `meas-perf-${i}`,
          `Meas perf ${i}`,
          `meas perf ${i}`,
          now,
          now,
        );
        db().run(
          `INSERT INTO dp_cost_matches (id, product_id, element_id, environment, platform_id, match_kind, match_value, tag_key, created_at, created_by)
           VALUES (?, ?, NULL, 'prod', ?, 'subAccount', 'MEAS-ACCT', '', ?, 'admin')`,
          `dpm_measperf_${i}`,
          id,
          snowflake,
          now,
        );
      }
      const subjects = Object.fromEntries(ids.map((id, i) => [id, [`WH_${i}`]]));
      db().run("UPDATE dp_cost_allocations SET subjects = ? WHERE platform_id = ? AND match_value = 'MEAS-ACCT'", JSON.stringify(subjects), snowflake);
    });
    const v = await costs(x);
    expect(lineOf(v, 'MEAS-ACCT')).toMatchObject({ rule: 'measured', products: 43 });
    expect(counted.get(url)).toBe(few);
    // the Costs tab's statements (at most 25) and measured use's: the quantities, the price book (three), once each
    expect(few).toBeLessThanOrEqual(32);
  });
});
