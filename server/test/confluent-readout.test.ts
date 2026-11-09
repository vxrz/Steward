import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONFLUENT_READ_LIMITS, checkPlatformKinds, checkTypesOfKind, confluentKeyHint, platformKind } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Confluent Cloud as a platform (0.14.0, #123, docs/CONFLUENT.md): the descriptor, the readout of environments,
 * clusters, Schema Registry, service accounts, API keys and managed connectors from the simulated Cloud API (paged,
 * part by part), the links to the Kafka platform and its topic components, never a secret, read-only, who sees what,
 * the outbound policy, the monitor check "confluent" with its kind guard, and the Costs API in platform costs.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let ccId: string;
let kafkaId: string;
let vera: Client;
let olivia: Client;
let mock: typeof import('../src/mock/mockConfluent.js');
let kafka: typeof import('../src/mock/mockKafka.js');
let eng: typeof import('../src/monitors/engine.js');

/** Values that must never leave Steward: the demo's secrets and the token in a connector's error. */
const SECRETS = () => [mock.DEMO_CONFLUENT.cloudSecret, mock.DEMO_CONFLUENT.clusterSecret, kafka.DEMO_KAFKA.registrySecret, 'demo-http-source-token'];
const noSecrets = (v: unknown) => {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  for (const secret of SECRETS()) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/"secret"\s*:/);
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const platforms = await s.api('GET', '/platforms');
  ccId = platforms.find((p: any) => p.name === 'Confluent Cloud (demo)').id;
  kafkaId = platforms.find((p: any) => p.name === 'Kafka (demo)').id;
  vera = await s.as('vera', PW);
  olivia = await s.as('olivia', PW);
  mock = await import('../src/mock/mockConfluent.js');
  kafka = await import('../src/mock/mockKafka.js');
  eng = await import('../src/monitors/engine.js');
});
afterAll(async () => {
  vi.useRealTimers();
  mock?.resetConfluent();
  await s?.app.close();
});

describe('the descriptor', () => {
  it('reads the confluent check type, the Confluent access source and costs', () => {
    expect(platformKind('confluent-cloud')).toMatchObject({ checkTypes: ['confluent'], accessSource: 'confluent', costSource: 'confluent', http: true });
    expect(checkTypesOfKind('confluent-cloud')).toEqual(['confluent', 'platform']);
    expect(checkPlatformKinds({ type: 'confluent' })).toEqual(['confluent-cloud']);
  });

  it('has a read-only preset with the Schema Registry key', async () => {
    const preset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === 'confluent-cloud');
    expect(preset.label).toBe('Confluent Cloud API (read-only)');
    expect(Object.keys(preset.config.variables)).toEqual(['schemaRegistryUrl', 'kafkaRestUrl', 'clusterId']);
    expect(preset.secretFields.map((f: any) => f.key)).toEqual(['username', 'password', 'registryKey', 'registrySecret', 'clusterApiKey', 'clusterApiSecret']);
  });

  it('hints at keys that expired, expire soon or are old', () => {
    const now = Date.parse('2026-06-01T12:00:00Z');
    expect(confluentKeyHint({ createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-05-31' }, now)).toBe('expired');
    // valid through the end of its expiry date
    expect(confluentKeyHint({ createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-06-01' }, now)).toBe('expiring');
    expect(confluentKeyHint({ createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-06-25' }, now)).toBe('expiring');
    expect(confluentKeyHint({ createdAt: '2025-01-01T00:00:00Z', expiresAt: null }, now)).toBe('rotate');
    expect(confluentKeyHint({ createdAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01' }, now)).toBe('ok');
    expect(confluentKeyHint({ createdAt: null, expiresAt: null }, now)).toBe('ok');
  });
});

describe('the readout', () => {
  it('reads every part page by page and links clusters and connectors', async () => {
    const v = await s.api('POST', `/platforms/${ccId}/confluent/read`, {});
    expect(v).toMatchObject({ error: null, partErrors: [], canRead: true });
    // three environments on two pages of two
    expect(v.environments.map((e: any) => [e.id, e.name, e.governance])).toEqual([
      ['env-demo2', 'development', null],
      ['env-demo1', 'production', 'ESSENTIALS'],
      ['env-demo3', 'staging', null],
    ]);
    expect(v.clusters).toEqual([
      expect.objectContaining({
        id: 'lkc-demo1',
        name: 'orders-cluster',
        environmentName: 'production',
        type: 'Standard',
        cloud: 'AWS',
        region: 'eu-central-1',
        availability: 'MULTI_ZONE',
        phase: 'PROVISIONED',
        bootstrap: 'pkc-demo1.eu-central-1.aws.confluent.invalid:9092',
        kafkaPlatform: { id: kafkaId, name: 'Kafka (demo)' },
      }),
      expect.objectContaining({ id: 'lkc-demo2', name: 'sandbox', type: 'Basic', cloud: 'GCP', kafkaPlatform: null }),
    ]);
    expect(v.schemaRegistries).toEqual([expect.objectContaining({ id: 'lsrc-demo1', environmentId: 'env-demo1', package: 'ESSENTIALS' })]);
    // four service accounts and five keys, two per page
    expect(v.serviceAccounts.map((x: any) => x.id)).toEqual(['sa-billing', 'sa-connect', 'sa-orders', 'sa-steward']);
    expect(v.apiKeys.map((k: any) => [k.id, k.ownerName, k.resourceKind, k.hint])).toEqual([
      ['BOBSANDBOX', 'Bob Builder', 'Cluster', 'ok'],
      ['CONNECTKEY', 'managed-connectors', 'Cluster', 'ok'],
      ['DEMOKEY', 'orders-service', 'Cluster', 'rotate'],
      ['SRKEY', 'orders-service', 'SchemaRegistry', 'expiring'],
      ['CLOUDKEY', 'steward-readonly', null, 'ok'],
    ]);
    // connectors of both clusters: state, tasks, topics and the topic components of "Kafka (demo)"
    const byName = Object.fromEntries(v.connectors.map((c: any) => [c.name, c]));
    expect(Object.keys(byName)).toEqual(['orders-s3-sink', 'shop-events-http-source', 'clickstream-datagen']);
    expect(byName['orders-s3-sink']).toMatchObject({
      id: 'lcc-demo1',
      type: 'sink',
      class: 'S3_SINK',
      state: 'RUNNING',
      topics: ['orders'],
      clusterId: 'lkc-demo1',
    });
    expect(byName['orders-s3-sink'].topicComponents).toEqual([expect.objectContaining({ topic: 'orders', applicationName: 'Webshop (demo)' })]);
    const failed = byName['shop-events-http-source'];
    expect(failed).toMatchObject({ type: 'source', class: 'HttpSource', state: 'RUNNING', topics: ['shop-events'] });
    expect(failed.tasks[0]).toMatchObject({ id: 0, state: 'FAILED', failedSince: expect.any(String) });
    expect(failed.tasks[0].trace).toContain('answered 401 Unauthorized');
    expect(byName['clickstream-datagen']).toMatchObject({ state: 'PAUSED', clusterId: 'lkc-demo2', topicComponents: [] });
    // the Schema Registry: the subjects' versions and compatibility (own or the registry's)
    expect(v.registry).toMatchObject({ compatibility: 'BACKWARD', truncated: false });
    expect(v.registry.subjects).toEqual([
      { name: 'orders-value', versions: 2, latest: 2, compatibility: 'BACKWARD', ownCompatibility: true },
      { name: 'payments-value', versions: 1, latest: 1, compatibility: 'FULL', ownCompatibility: true },
    ]);
    noSecrets(v);
    // nothing of a configuration is kept
    const stored = JSON.stringify(await (await import('../src/confluent/service.js')).storedConfluent(ccId));
    expect(stored).not.toContain('s3.bucket.name');
    expect(stored).not.toContain('****');
    noSecrets(stored);
  });

  it('a subject without a level of its own has the registry’s', async () => {
    kafka.registerSchema('clickstream-value', '{"type":"string"}');
    const v = await s.api('POST', `/platforms/${ccId}/confluent/read`, {});
    expect(v.registry.subjects.find((x: any) => x.name === 'clickstream-value')).toEqual({
      name: 'clickstream-value',
      versions: 1,
      latest: 1,
      compatibility: 'BACKWARD',
      ownCompatibility: false,
    });
    kafka.resetKafka();
  });

  it('shows managed connectors on the Kafka topic components', async () => {
    const app = (await s.api('GET', '/applications')).find((a: any) => a.name === 'Webshop (demo)');
    const comps = (await s.api('GET', `/applications/${app.id}`)).components;
    const orders = comps.find((c: any) => c.type === 'kafka-topic' && c.name === 'orders');
    expect(orders.connectors).toEqual(
      expect.arrayContaining([{ platformId: ccId, platformName: 'Confluent Cloud (demo)', connector: 'orders-s3-sink', type: 'sink', state: 'RUNNING' }]),
    );
    const events = comps.find((c: any) => c.type === 'kafka-topic' && c.name === 'shop-events');
    expect(events.connectors).toEqual(expect.arrayContaining([expect.objectContaining({ connector: 'shop-events-http-source', type: 'source' })]));
  });

  it('keeps a part that fails with its error, and the last values of a read that fails', async () => {
    mock.setConfluentForbidden('/iam/v2/api-keys');
    const v = await s.api('POST', `/platforms/${ccId}/confluent/read`, {});
    expect(v.error).toBeNull();
    expect(v.partErrors).toEqual([{ part: 'apiKeys', message: expect.stringMatching(/HTTP 403 – the API key may not list API keys/) }]);
    // the keys of the read before stay
    expect(v.apiKeys).toHaveLength(5);
    expect(v.clusters).toHaveLength(2);
    mock.setConfluentForbidden(null);
    await s.api('PUT', `/platforms/${ccId}/secrets`, { password: 'wrong-secret' });
    const bad = await s.api('POST', `/platforms/${ccId}/confluent/read`, {});
    expect(bad.partErrors.find((x: any) => x.part === 'environments').message).toMatch(/HTTP 401 – check the API key and secret/);
    expect(bad.clusters).toHaveLength(2);
    noSecrets(bad);
    await s.api('PUT', `/platforms/${ccId}/secrets`, { password: mock.DEMO_CONFLUENT.cloudSecret });
  });

  it('records clusters and connectors that come and go', async () => {
    mock.removeConfluentConnector('clickstream-datagen');
    await s.api('POST', `/platforms/${ccId}/confluent/read`, {});
    mock.resetConfluent();
    await s.api('POST', `/platforms/${ccId}/confluent/read`, {});
    const audit = await s.api('GET', `/audit?entityType=platform&entityId=${ccId}&limit=50`);
    expect(audit.filter((e: any) => e.action === 'platform.connectors_changed').map((e: any) => e.summary)).toEqual([
      'Connectors of "Confluent Cloud (demo)" changed: +lkc-demo2/clickstream-datagen',
      'Connectors of "Confluent Cloud (demo)" changed: -lkc-demo2/clickstream-datagen',
    ]);
    noSecrets(audit);
  });
});

describe('rights, read-only and the outbound policy', () => {
  it('names only what the reader may see; who may not use the platform sees nothing of it', async () => {
    // a platform is seen by who may use it (an operator by default), with its service accounts and keys
    const v = await olivia('GET', `/platforms/${ccId}/confluent`);
    expect(v).toMatchObject({ canRead: true });
    expect(v.apiKeys).toHaveLength(5);
    expect(v.clusters[0].kafkaPlatform).toMatchObject({ name: 'Kafka (demo)' });
    noSecrets(v);
    // a viewer may not use it: neither the readout nor Read now nor its costs
    await expect(vera('GET', `/platforms/${ccId}/confluent`)).rejects.toMatchObject({ status: 400, body: { code: 'PLATFORM_NOT_FOUND' } });
    await expect(vera('POST', `/platforms/${ccId}/confluent/read`, {})).rejects.toMatchObject({ status: 403 });
    await expect(vera('GET', `/costs/platform/${ccId}`)).rejects.toMatchObject({ status: 404 });
    await expect(vera('POST', `/costs/platform/${ccId}/read`, {})).rejects.toMatchObject({ status: 404 });
    // the Kafka platform hidden: no link, no name
    await s.api('PUT', `/platforms/${kafkaId}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });
    const w = await olivia('GET', `/platforms/${ccId}/confluent`);
    expect(w.clusters[0].kafkaPlatform).toBeNull();
    expect(w.connectors.find((c: any) => c.name === 'orders-s3-sink').topicComponents).toEqual([]);
    expect(JSON.stringify(w)).not.toContain('Kafka (demo)');
    await s.api('PUT', `/platforms/${kafkaId}/access`, { acl: [] });
    // the platform hidden: like a missing one, and its connectors leave the topic components
    await s.api('PUT', `/platforms/${ccId}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });
    await expect(olivia('GET', `/platforms/${ccId}/confluent`)).rejects.toMatchObject({ status: 400, body: { code: 'PLATFORM_NOT_FOUND' } });
    await expect(olivia('POST', `/platforms/${ccId}/confluent/read`, {})).rejects.toMatchObject({ status: 403 });
    const app = (await olivia('GET', '/applications')).find((a: any) => a.name === 'Webshop (demo)');
    const orders = (await olivia('GET', `/applications/${app.id}`)).components.find((c: any) => c.name === 'orders');
    expect(JSON.stringify(orders.connectors ?? [])).not.toContain('orders-s3-sink');
    await s.api('PUT', `/platforms/${ccId}/access`, { acl: [] });
    // another kind of platform
    await expect(s.api('GET', `/platforms/${kafkaId}/confluent`)).rejects.toMatchObject({ status: 400, body: { code: 'CONFLUENT_PLATFORM' } });
  });

  it('refuses every changing request, whoever asks', async () => {
    for (const [method, path] of [
      ['POST', '/iam/v2/api-keys'],
      ['DELETE', '/iam/v2/api-keys/DEMOKEY'],
      ['PUT', '/connect/v1/environments/env-demo1/clusters/lkc-demo1/connectors/orders-s3-sink/pause'],
      ['PATCH', '/cmk/v2/clusters/lkc-demo1'],
      ['POST', '/iam/v2/role-bindings'],
    ])
      await expect(s.api('POST', `/platforms/${ccId}/request`, { method, path })).rejects.toMatchObject({
        status: 403,
        body: { code: 'PLATFORM_METHOD_DENIED' },
      });
    // a read through the explorer: no "secret" key passed on, a connector configuration redacted
    const r = await s.api('POST', `/platforms/${ccId}/request`, {
      method: 'GET',
      path: '/connect/v1/environments/env-demo1/clusters/lkc-demo1/connectors?expand=info,status,id',
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('orders-s3-sink');
    noSecrets(r.body);
  });

  it('checks the base URL and the Schema Registry URL against the outbound policy', async () => {
    const settings = await s.api('GET', '/settings');
    const origin = new URL(s.base).origin;
    try {
      await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [] });
      const blocked = await s.api('POST', `/platforms/${ccId}/confluent/read`, {});
      expect(blocked.error).toMatch(/Blocked by the outbound policy/);
      // allowed: the base URL's origin (the Schema Registry of the demo is on the same one)
      await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [origin] });
      expect(await s.api('POST', `/platforms/${ccId}/confluent/read`, {})).toMatchObject({ error: null, partErrors: [] });
      // a Schema Registry on another host: only when the policy allows it
      await s.api('PUT', '/settings', { outboundPolicy: 'platforms', outboundAllowList: [] });
      const p = await s.api('GET', `/platforms/${ccId}`);
      const other = `http://localhost:${new URL(s.base).port}/mock/schema-registry`;
      await s.api('PUT', `/platforms/${ccId}`, { ...p, config: { ...p.config, variables: { ...p.config.variables, schemaRegistryUrl: other } } });
      const v = await s.api('POST', `/platforms/${ccId}/confluent/read`, {});
      expect(v.partErrors).toEqual([{ part: 'subjects', message: expect.stringMatching(/Blocked by the outbound policy: http:\/\/localhost/) }]);
      await s.api('PUT', `/platforms/${ccId}`, p);
    } finally {
      await s.api('PUT', '/settings', { outboundPolicy: settings.outboundPolicy, outboundAllowList: settings.outboundAllowList });
    }
  });
});

describe('monitor check confluent', () => {
  it('clusters provisioned, connectors and tasks running, a task failed for N minutes', async () => {
    mock.resetConfluent();
    await s.api('POST', `/platforms/${ccId}/confluent/read`, {});
    const k = (id: string, extra: Record<string, unknown>) => ({ id, name: id, type: 'confluent', platform: 'Confluent Cloud (demo)', ...extra });
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Confluent',
        failuresBeforeDown: 1,
        checks: [
          k('clusters', { target: 'clusters' }),
          k('orders', { target: 'clusters', resource: 'orders-cluster' }),
          k('all', { target: 'connectors', pausedAs: 'up' }),
          k('events', { target: 'connectors', resource: 'shop-events-http-source', failedMinutes: 10 }),
          k('sink', { target: 'connectors', resource: 'lcc-demo1' }),
          k('nope', { target: 'connectors', resource: 'nope' }),
        ],
      },
    });
    // the kind guard: a platform of another kind is refused when saving
    const wrong = await s
      .api('POST', '/monitors', {
        definition: { name: 'Wrong kind', checks: [{ id: 'wrong', name: 'wrong', type: 'confluent', platform: 'Kafka Connect (demo)' }] },
      })
      .catch((e) => e);
    expect(wrong.body).toMatchObject({ code: 'CHECK_PLATFORM_KIND', params: { check: 'wrong', kind: 'kafka-connect', kinds: ['confluent-cloud'] } });
    const statuses = async () => {
      await eng.evaluateMonitorNow(monitor.id);
      const m = await s.api('GET', `/monitors/${monitor.id}`);
      return Object.fromEntries(m.checks.map((c: any) => [c.checkId, [c.status, c.last?.message]]));
    };
    let st = await statuses();
    expect(st.clusters).toEqual(['up', 'Confluent Cloud: 2/2 clusters provisioned']);
    expect(st.orders).toEqual(['up', 'Confluent Cloud: orders-cluster PROVISIONED']);
    expect(st.all[0]).toBe('down');
    expect(st.all[1]).toMatch(/^Confluent Cloud: 2\/3 connectors running – shop-events-http-source task 0 FAILED/);
    expect(st.events[0]).toBe('degraded');
    expect(st.events[1]).toMatch(
      /^Confluent Cloud: shop-events-http-source RUNNING \(0\/1 tasks\) – shop-events-http-source task 0 FAILED for \d+ minutes \(alarm after 10\)$/,
    );
    expect(st.sink).toEqual(['up', 'Confluent Cloud: orders-s3-sink RUNNING (2/2 tasks)']);
    expect(st.nope).toEqual(['unknown', 'Confluent Cloud: no connector "nope"']);
    noSecrets(st);
    // 20 minutes later the task still failed: an alarm; a cluster is being provisioned, the sink failed
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 20 * 60_000 });
    mock.setConfluentClusterPhase('lkc-demo2', 'PROVISIONING');
    mock.setConfluentConnector('orders-s3-sink', 'FAILED');
    st = await statuses();
    vi.useRealTimers();
    expect(st.events[0]).toBe('down');
    expect(st.events[1]).toMatch(/task 0 FAILED for 2\d minutes$/);
    expect(st.clusters).toEqual(['degraded', 'Confluent Cloud: 1/2 clusters provisioned – sandbox (lkc-demo2) PROVISIONING']);
    expect(st.sink[0]).toBe('down');
    expect(st.sink[1]).toContain('orders-s3-sink FAILED');
    mock.setConfluentClusterPhase('lkc-demo1', 'FAILED');
    st = await statuses();
    expect(st.orders).toEqual(['down', 'Confluent Cloud: orders-cluster FAILED']);
    mock.resetConfluent();
  });
});

describe('costs', () => {
  it('reads the Costs API: the linked cluster on its Kafka platform, the rest on the Confluent platform', async () => {
    const src = await s.api('GET', `/costs/platform/${ccId}/source`);
    expect(src).toMatchObject({ source: 'confluent', lastReadError: null });
    const r = await s.api('POST', `/costs/platform/${ccId}/read`, {});
    expect(r.error ?? null).toBeNull();
    const conf = await s.api('GET', `/costs/platform/${ccId}`);
    expect(conf.byService.map((x: { service: string }) => x.service).sort()).toEqual(['CONNECT', 'KAFKA', 'STREAM_GOVERNANCE']);
    const k = await s.api('GET', `/costs/platform/${kafkaId}`);
    expect(k.byService.map((x: { service: string }) => x.service)).toEqual(['KAFKA']);
  });

  it('keeps its limits', () => {
    expect(CONFLUENT_READ_LIMITS.subjectDetails).toBeLessThanOrEqual(CONFLUENT_READ_LIMITS.subjects);
  });
});
