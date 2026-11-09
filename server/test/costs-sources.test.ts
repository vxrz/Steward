import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Platform costs from the connectors (#226, docs/COSTS.md#sources) against the demo mocks: AWS Cost Explorer (one
 * request series by tag and service, linked by the cloud-account components; late changes of a closed month audited as
 * corrections), Snowflake (USAGE_IN_CURRENCY_DAILY, or credits × a price per credit), Confluent Cloud's Costs API
 * (the cluster linked to its Kafka platform) and the AI gateways' usage log.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const byKind: Record<string, string> = {};
const apps: Record<string, string> = {};
const month = new Date().toISOString().slice(0, 7);
const prev = (() => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  for (const p of await s.api('GET', '/platforms')) if (p.name.endsWith('(demo)')) byKind[p.kind] = p.id;
  for (const a of await s.api('GET', '/applications')) apps[a.name] = a.id;
}, 240_000);

const sum = (c: { months: { month: string; amount: string | null }[] }, m: string) => c.months.find((x) => x.month === m)?.amount;

describe('AWS', () => {
  it('reads the costs by tag and service into the model and links them by the cloud-account components', async () => {
    const shop = await s.api('GET', `/costs/application/${apps['Webshop (demo)']}`);
    const usd = shop.currencies.find((c: { currency: string }) => c.currency === 'USD');
    // 12 complete months and this one; the shop's costs come from its AWS account and its Kafka cluster (Confluent)
    expect(usd.months).toHaveLength(13);
    expect(shop.parts.filter((p: { kind: string }) => p.kind === 'platform').map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(['AWS (demo)', 'Kafka (demo)']),
    );
    expect(usd.trend).toMatchObject({ months: 12 });
    expect(usd.trend.changePctPerMonth).toBeGreaterThan(1);
    const aws = await s.api('GET', `/costs/platform/${byKind.aws}`);
    const a = aws.currencies.find((c: { currency: string }) => c.currency === 'USD');
    expect(sum(a, a.months[0].month)).toBe('2345.00');
    // untagged costs stay unassigned on the platform
    expect(aws.unassigned[0]).toMatchObject({ currency: 'USD' });
    expect(
      aws.byService.some((x: { service: string; category: string }) => x.service === 'Amazon Relational Database Service' && x.category === 'Databases'),
    ).toBe(true);
    const src = await s.api('GET', `/costs/platform/${byKind.aws}/source`);
    expect(src).toMatchObject({ source: 'aws', enabled: true, tagKey: 'application', lastReadError: null });
    // the component readout still shows six months
    const app = await s.api('GET', `/applications/${apps['Webshop (demo)']}`);
    const comp = app.components.find((c: { type: string }) => c.type === 'cloud-account');
    expect(comp.aws.costs.months).toHaveLength(6);
  });

  it('audits a changed closed month as a correction', async () => {
    const mock = await import('../src/mock/mockAws.js');
    const { db } = await import('../src/db.js');
    mock.setAwsCostFactor(prev, 1.1);
    // the cache of the account says "read today": a forced read
    db().run("DELETE FROM aws_account_cache WHERE part = 'costs'");
    db().run("UPDATE cost_records SET read_at = '2099-01-01T00:00:00.000Z' WHERE source = 'aws' AND month = ?", prev);
    const r = await s.api('POST', `/costs/platform/${byKind.aws}/read`, {});
    expect(r.error).toBeNull();
    mock.setAwsCostFactor(prev, null);
    const [entry] = await s.api('GET', `/audit?action=cost.corrected&entityId=${byKind.aws}`);
    expect(entry.details.source).toBe('aws');
    expect(entry.details.corrections[0]).toMatchObject({ month: prev, currency: 'USD' });
    expect(Number(entry.details.corrections[0].after)).toBeGreaterThan(Number(entry.details.corrections[0].before));
    expect(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM cost_records WHERE source = 'aws' AND corrected_at IS NOT NULL")!.n).toBeGreaterThan(0);
  });
});

describe('Snowflake', () => {
  it('reads USAGE_IN_CURRENCY_DAILY, else credits × the price per credit, else says what is missing', async () => {
    const id = byKind.snowflake!;
    const first = await s.api('GET', `/costs/platform/${id}/source`);
    expect(first.lastReadNote).toBe('ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY');
    const d = await s.api('GET', `/costs/platform/${id}`);
    expect(d.byService.map((x: { service: string }) => x.service)).toEqual(expect.arrayContaining(['WAREHOUSE_METERING', 'STORAGE']));

    const mock = await import('../src/mock/mockSnowflake.js');
    mock.setSnowflakeOrgUsage(false);
    try {
      const failed = await s.api('POST', `/costs/platform/${id}/read`, {});
      expect(failed.error).toMatch(/no price per credit is set/);
      await s.api('PUT', `/costs/platform/${id}/source`, { enabled: true, tagKey: 'application', creditPrice: '3.00', creditCurrency: 'USD' });
      const ok = await s.api('POST', `/costs/platform/${id}/read`, {});
      expect(ok.error).toBeNull();
      expect(ok.note).toBe('ACCOUNT_USAGE.METERING_DAILY_HISTORY × 3.00 USD per credit');
      const [audit] = await s.api('GET', `/audit?action=cost.source_changed&entityId=${id}`);
      expect(audit.details.after).toMatchObject({ creditPrice: '3.00', creditCurrency: 'USD' });
    } finally {
      mock.setSnowflakeOrgUsage(true);
    }
  });
});

describe('Confluent Cloud', () => {
  it('reads the Costs API month by month and links the cluster to its Kafka platform and topic application', async () => {
    const id = byKind['confluent-cloud']!;
    const src = await s.api('GET', `/costs/platform/${id}/source`);
    expect(src).toMatchObject({ source: 'confluent', lastReadError: null });
    // the cluster lkc-demo1 is "Kafka (demo)", whose topics belong to the web shop
    const kafka = await s.api('GET', `/costs/platform/${byKind.kafka}`);
    expect(kafka.currencies[0].currency).toBe('USD');
    expect(kafka.byService.map((x: { service: string }) => x.service)).toEqual(['KAFKA']);
    expect(kafka.parts[0]).toMatchObject({ kind: 'application', name: 'Webshop (demo)' });
    // the connectors, the cluster no Kafka platform names (lkc-demo2) and the environment's governance stay on the
    // Confluent platform, unassigned
    const conf = await s.api('GET', `/costs/platform/${id}`);
    expect(conf.byService.map((x: { service: string }) => x.service).sort()).toEqual(['CONNECT', 'KAFKA', 'STREAM_GOVERNANCE']);
    const { confluentRanges } = await import('../src/costs/readers.js');
    const r = confluentRanges('2026-01-15', Date.parse('2026-03-10T12:00:00Z'));
    expect(r).toEqual([
      { start: '2026-01-15', end: '2026-02-01' },
      { start: '2026-02-01', end: '2026-03-01' },
      { start: '2026-03-01', end: '2026-03-07' },
    ]);
  });
});

describe('AI gateways', () => {
  it('reads the usage log costs per day, model and process in the gateway currency', async () => {
    const { db } = await import('../src/db.js');
    const id = byKind['llm-gateway']!;
    const today = new Date().toISOString();
    db().run(
      `INSERT INTO ai_usage (id, ts, day, month, process_id, process_name, platform_id, platform_name, model, format, input_tokens, output_tokens, result, cost)
       VALUES ('aiu_t1', ?, ?, ?, 'p1', 'Summary', ?, 'LLM gateway (demo)', 'demo-chat-small', 'chat-completions', 1000, 500, 'ok', 0.00125),
              ('aiu_t2', ?, ?, ?, 'p1', 'Summary', ?, 'LLM gateway (demo)', 'demo-chat-small', 'chat-completions', 1000, 500, 'ok', 0.1)`,
      today,
      today.slice(0, 10),
      today.slice(0, 7),
      id,
      today,
      today.slice(0, 10),
      today.slice(0, 7),
      id,
    );
    const r = await s.api('POST', `/costs/platform/${id}/read`, {});
    expect(r.error).toBeNull();
    const line = db().get<{ effective_cost: number; billing_currency: string; service_category: string }>(
      "SELECT effective_cost, billing_currency, service_category FROM cost_records WHERE source = 'ai' AND service_name = 'demo-chat-small' AND month = ?",
      month,
    )!;
    expect(line).toMatchObject({ effective_cost: 101_250, billing_currency: 'USD', service_category: 'AI and Machine Learning' });
  });
});

describe('the job', () => {
  it('reads only what is due and links lines again when the catalogue changes', async () => {
    const { runCostsJob } = await import('../src/costs/jobs.js');
    // the CRM's cloud account no longer names the AWS platform: its tagged costs are no longer the CRM's
    const { db } = await import('../src/db.js');
    const before = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_records WHERE application_id = ?', apps['CRM (demo)'])!.n;
    expect(before).toBeGreaterThan(0);
    db().run("UPDATE application_components SET platform_id = NULL WHERE name = 'crm' AND type = 'cloud-account'");
    const out = await runCostsJob();
    expect(out.read).toBe(0);
    expect(out.remapped).toBe(before);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_records WHERE application_id = ?', apps['CRM (demo)'])!.n).toBe(0);
  });
});
