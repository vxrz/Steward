import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The scorecard of data products (ADR 0036 part 13, WP4): the parts documented, rated, ports, contracted, observed,
 * healthy, objectives met, dependencies, costs known and the ISO/IEC 25012 dimensions with their evidence (or none
 * yet); the computed maturity 1–4 step by step; per environment; read by who may see the product, with a fixed number
 * of statements whatever the number of ports.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let kafka = '';
let product = '';
let port = '';
let topic = '';
let contract = '';
const counted = new Map<string, number>();
const HOUR = 3600_000;

interface Card {
  environment: string | null;
  environments: string[];
  maturity: number;
  parts: { id: string; group: string; state: string; evidence: { key: string; values?: Record<string, unknown> }[] }[];
}
const card = (id = product, who: Client = dana, q = '') => who('GET', `/data-products/${id}/scorecard${q}`) as Promise<Card>;
const state = (c: Card, id: string) => c.parts.find((p) => p.id === id)?.state;

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
  kafka = ((await s.api('GET', '/platforms')) as { id: string; kind: string }[]).find((p) => p.kind === 'kafka')!.id;
  contract = ((await s.api('GET', '/data-contracts')) as { id: string; key: string }[]).find((c) => c.key === 'shop-orders')!.id;
}, 180_000);

describe('the scorecard', () => {
  it('starts at maturity 0 with every part and dimension listed', async () => {
    product = (await dana('POST', '/data-products', { key: 'score', name: 'Score' })).id;
    const c = await card();
    expect(c).toMatchObject({ environment: null, environments: [], maturity: 0 });
    expect(c.parts.filter((p) => p.group === 'part').map((p) => p.id)).toEqual([
      'documented',
      'rated',
      'ports',
      'contracted',
      'observed',
      'healthy',
      'objectivesMet',
      'dependencies',
      'costsKnown',
    ]);
    expect(c.parts.filter((p) => p.group === 'iso25012')).toHaveLength(15);
    expect(state(c, 'documented')).toBe('notMet');
    expect(c.parts.find((p) => p.id === 'documented')!.evidence.map((e) => e.key)).toContain('evidence.documented.missing.owner');
    expect(state(c, 'rated')).toBe('notMet');
    expect(state(c, 'ports')).toBe('notMet');
    expect(state(c, 'healthy')).toBe('noEvidence');
    expect(state(c, 'dependencies')).toBe('met');
    // dimensions without evidence say so
    const accuracy = c.parts.find((p) => p.id === 'accuracy')!;
    expect(accuracy).toEqual({ id: 'accuracy', group: 'iso25012', state: 'noEvidence', evidence: [{ key: 'evidence.noEvidenceYet' }] });
  });

  it('reaches level 1 when documented and rated at least to the floor', async () => {
    const domain = (await dana('POST', '/data-domains', { key: 'score-domain', name: 'Score domain' })).id;
    const object = (
      await dana('POST', '/data-objects', { key: 'score-order', name: 'Order', definition: 'An order of a customer.', classification: 'internal' })
    ).id;
    await dana('PUT', `/data-objects/${object}/rating`, { confidentiality: { level: 'high', justification: 'Order data' } });
    topic = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'score.orders.v1', environment: 'prod' })).id;
    await dana('POST', `/data-objects/${object}/elements`, { elementId: topic });
    port = (
      await dana('POST', `/data-products/${product}/ports`, {
        direction: 'output',
        name: 'orders',
        type: 'topic',
        version: 'v1',
        objectives: { freshnessMinutes: 60 },
      })
    ).id;
    await dana('PUT', `/data-products/${product}/ports/${port}/bindings/prod`, { elementIds: [topic] });
    await dana('PUT', `/data-products/${product}`, {
      key: 'score',
      name: 'Score',
      description: 'Orders as they happen.',
      type: 'sourceAligned',
      domainId: domain,
      owners: ['user:dana'],
    });
    let c = await card();
    expect(c.environment).toBe('prod');
    expect(state(c, 'documented')).toBe('met');
    expect(state(c, 'ports')).toBe('met');
    expect(state(c, 'rated')).toBe('notMet');
    expect(c.maturity).toBe(0);
    // rated, but below the data object's confidentiality without a reason: partial
    await dana('PUT', `/data-products/${product}/rating`, {
      confidentiality: { level: 'normal', justification: 'x' },
      integrity: { level: 'normal', justification: 'x' },
      availability: { level: 'normal', justification: 'x' },
      classification: 'internal',
    });
    c = await card();
    expect(state(c, 'rated')).toBe('partial');
    expect(c.parts.find((p) => p.id === 'rated')!.evidence).toContainEqual({ key: 'evidence.rated.belowFloor', values: { dimensions: 'confidentiality' } });
    expect(state(c, 'confidentiality')).toBe('partial');
    await dana('PUT', `/data-products/${product}/rating`, { confidentiality: { level: 'high', justification: 'Orders' } });
    c = await card();
    expect(state(c, 'rated')).toBe('met');
    expect(state(c, 'confidentiality')).toBe('met');
    expect(state(c, 'understandability')).toBe('met');
    expect(c.maturity).toBe(1);
  });

  it('reaches level 2 when every output element has a freshness check', async () => {
    const { addCheckLink } = await import('../src/dataproducts/store.js');
    addCheckLink({ element_id: topic, step_id: null, monitor_id: 'mon_score', check_id: 'fresh', purpose: 'freshness', origin: 'linked', created_by: 'dana' });
    const c = await card();
    expect(state(c, 'observed')).toBe('met');
    expect(c.maturity).toBe(2);
    // health comes through the seam to the module's health: no data yet, never OK
    expect(state(c, 'currentness')).toBe('noEvidence');
  });

  it('reaches level 3 when every output binding has a lint-clean contract whose last test passed', async () => {
    await dana('PUT', `/data-products/${product}/ports/${port}/bindings/prod`, { elementIds: [topic], contractId: contract });
    const { db } = await import('../src/db.js');
    // the demo's contract was tested already: drop its runs to start untested
    db().run('DELETE FROM data_contract_runs WHERE contract_id = ?', contract);
    let c = await card();
    expect(state(c, 'contracted')).toBe('partial');
    expect(c.parts.find((p) => p.id === 'contracted')!.evidence).toContainEqual({ key: 'evidence.contracted.notTested', values: { count: 1 } });
    expect(state(c, 'compliance')).toBe('noEvidence');
    const run = (id: string, result: string, at: string) =>
      db().run(
        `INSERT INTO data_contract_runs (id, contract_id, version, result, via, report, report_sha256, started_at, actor) VALUES (?, ?, 1, ?, 'push', '{}', 'x', ?, 'dana')`,
        id,
        contract,
        result,
        at,
      );
    run('dcr_score_1', 'failed', new Date(Date.now() - 2 * HOUR).toISOString());
    c = await card();
    expect(state(c, 'contracted')).toBe('partial');
    expect(state(c, 'compliance')).toBe('notMet');
    run('dcr_score_2', 'passed', new Date(Date.now() - HOUR).toISOString());
    c = await card();
    expect(state(c, 'contracted')).toBe('met');
    expect(state(c, 'compliance')).toBe('met');
    expect(c.maturity).toBe(3);
  });

  it('reaches level 4 when the objectives were met for 30 days – and falls back when they are not', async () => {
    const { db } = await import('../src/db.js');
    const now = Date.now();
    let c = await card();
    expect(state(c, 'objectivesMet')).toBe('noEvidence');
    expect(c.parts.find((p) => p.id === 'objectivesMet')!.evidence[0]!.key).toBe('evidence.objectives.freshnessShort');
    // the freshness check was green every day of 31
    db().tx(() => {
      for (let d = 31; d >= 0; d--)
        db().run(
          'INSERT INTO monitor_samples (monitor_id, check_id, bucket, ok, down, other) VALUES (?, ?, ?, 24, 0, 0)',
          'mon_score',
          'fresh',
          new Date(Math.floor((now - d * 24 * HOUR) / HOUR) * HOUR).toISOString(),
        );
    });
    c = await card();
    expect(state(c, 'objectivesMet')).toBe('met');
    expect(c.maturity).toBe(4);
    // a bad day: 100 hours stale – below 99 %
    db().run(
      "UPDATE monitor_samples SET down = 100 WHERE monitor_id = 'mon_score' AND check_id = 'fresh' AND bucket = ?",
      new Date(Math.floor((now - 2 * 24 * HOUR) / HOUR) * HOUR).toISOString(),
    );
    c = await card();
    expect(state(c, 'objectivesMet')).toBe('notMet');
    expect(c.maturity).toBe(3);
    db().run("UPDATE monitor_samples SET down = 0 WHERE monitor_id = 'mon_score'");
    expect((await card()).maturity).toBe(4);
  });

  it('takes health and availability from the product monitor of the environment', async () => {
    const { db } = await import('../src/db.js');
    const { setProductMonitor } = await import('../src/dataproducts/store.js');
    const now = Date.now();
    const iso = new Date(now - 40 * 24 * HOUR).toISOString();
    db().run(
      `INSERT INTO monitors (id, key, name, owner, definition, created_at, updated_at, updated_by) VALUES ('mon_score_p', 'score-product', 'Score product', 'dana', '{}', ?, ?, 'dana')`,
      iso,
      iso,
    );
    db().run("INSERT INTO monitor_state (monitor_id, status, since) VALUES ('mon_score_p', 'degraded', ?)", iso);
    db().run("INSERT INTO monitor_history (monitor_id, check_id, ts, status) VALUES ('mon_score_p', '', ?, 'up')", iso);
    setProductMonitor(product, 'prod', 'mon_score_p', 'dana');
    let c = await card();
    expect(state(c, 'healthy')).toBe('partial');
    expect(c.parts.find((p) => p.id === 'healthy')!.evidence[0]).toEqual({ key: 'evidence.healthy.status', values: { status: 'degraded', source: 'monitor' } });
    expect(state(c, 'availability')).toBe('met');
    // an availability objective of 99.9 % against 2 days down in 30
    const body = { direction: 'output', name: 'orders', type: 'topic', version: 'v1', objectives: { freshnessMinutes: 60, availabilityPct: 99.9 } };
    await dana('PUT', `/data-products/${product}/ports/${port}`, body);
    db().run(
      "INSERT INTO monitor_history (monitor_id, check_id, ts, status) VALUES ('mon_score_p', '', ?, 'down')",
      new Date(now - 3 * 24 * HOUR).toISOString(),
    );
    db().run("INSERT INTO monitor_history (monitor_id, check_id, ts, status) VALUES ('mon_score_p', '', ?, 'up')", new Date(now - 1 * 24 * HOUR).toISOString());
    c = await card();
    expect(state(c, 'availability')).toBe('notMet');
    expect(state(c, 'objectivesMet')).toBe('notMet');
    expect(c.maturity).toBe(3);
    db().run("DELETE FROM monitor_history WHERE monitor_id = 'mon_score_p' AND status = 'down'");
    await dana('PUT', `/data-products/${product}/ports/${port}`, { ...body, objectives: { freshnessMinutes: 60, availabilityPct: 99 } });
    expect((await card()).maturity).toBe(4);
  });

  it('knows its costs, its dependencies and its lineage', async () => {
    let c = await card();
    expect(state(c, 'costsKnown')).toBe('notMet');
    const platform = (await s.api('POST', '/platforms', { name: 'Invented score cloud', kind: 'rest', baseUrl: 'https://score.example.com' })).id;
    await dana('POST', `/data-products/${product}/costs/matches`, { environment: 'prod', platformId: platform, kind: 'resource', value: 'lkc-score' });
    c = await card();
    expect(state(c, 'costsKnown')).toBe('met');
    // traceability: a step from an input element to the output element
    expect(state(c, 'traceability')).toBe('notMet');
    const raw = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'score.raw.v1', environment: 'prod' })).id;
    await dana('POST', `/data-products/${product}/members`, { elementIds: [raw], role: 'input' });
    await dana('POST', `/data-products/${product}/steps`, { name: 'Clean', kind: 'transform', inputs: [raw], outputs: [topic] });
    c = await card();
    expect(state(c, 'traceability')).toBe('met');
    // a consumer on a deprecated port: dependencies not met
    const mart = (await dana('POST', '/data-products', { key: 'score-mart', name: 'Score mart' })).id;
    await dana('POST', `/data-products/${mart}/ports`, { direction: 'input', name: 'orders', source: { kind: 'port', portId: port } });
    expect(state(await card(mart), 'dependencies')).toBe('met');
    await dana('PUT', `/data-products/${product}/ports/${port}`, {
      direction: 'output',
      name: 'orders',
      type: 'topic',
      version: 'v1',
      lifecycle: 'deprecated',
      sunsetDate: '2027-06-30',
      objectives: { freshnessMinutes: 60, availabilityPct: 99 },
    });
    const m = await card(mart);
    expect(state(m, 'dependencies')).toBe('notMet');
    expect(m.parts.find((p) => p.id === 'dependencies')!.evidence).toEqual([{ key: 'evidence.dependencies.deprecated', values: { count: 1, of: 1 } }]);
  });

  it('is per environment, read by who may see the product, with a fixed number of statements', async () => {
    const dev = await card(product, dana, '?environment=dev');
    expect(dev.environment).toBe('dev');
    expect(state(dev, 'ports')).toBe('notMet');
    expect(dev.maturity).toBe(1);
    expect((await card(product, vera)).maturity).toBe(4);
    const url = `/api/data-products/${product}/scorecard`;
    await card();
    const few = counted.get(url)!;
    for (let i = 0; i < 6; i++) {
      const el = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: `score.more.${i}`, environment: 'prod' })).id;
      const pid = (await dana('POST', `/data-products/${product}/ports`, { direction: 'output', name: `more-${i}`, type: 'topic' })).id;
      await dana('PUT', `/data-products/${product}/ports/${pid}/bindings/prod`, { elementIds: [el], contractId: contract });
    }
    const c = await card();
    expect(c.parts.find((p) => p.id === 'ports')!.evidence[0]).toEqual({ key: 'evidence.ports.bound', values: { bound: 7, of: 7 } });
    expect(counted.get(url)).toBe(few);
    expect(few).toBeLessThanOrEqual(40);
    // a product the reader may not see answers like a missing one
    const team = (await s.api('POST', '/teams', { name: 'Invented score team', members: ['olivia'] })).id;
    const { db } = await import('../src/db.js');
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('data_product', ?, ?, ?)", product, team, new Date().toISOString());
    let status = 0;
    try {
      await vera('GET', `/data-products/${product}/scorecard`);
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(404);
  });
});
