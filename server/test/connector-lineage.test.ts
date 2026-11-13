import { beforeAll, describe, expect, it } from 'vitest';
import { CONNECT_CONFIG_KEYS, CONNECT_TRANSFORM_KEYS, allowedConnectorConfig } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Connectors and data products (0.25.0, ADR 0037 part 1, docs/KAFKA.md, docs/DATA-PRODUCTS.md#lineage-from-connectors):
 * the configuration allow-list of the Kafka Connect and Confluent readouts (a configuration full of secrets keeps only
 * the named keys); the lineage of Debezium sources (table → topic, prefix, routing transforms), Snowflake sinks (map,
 * naming rule) and S3 sinks (bucket, directory, format → a files.path) as proposals in the lineage inbox, never applied
 * on their own; Create step from connector; the connector's state as the step's health through the Kafka Connect check.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let connect = '';
let confluent = '';
let orders = '';
let mock: typeof import('../src/mock/mockKafkaConnect.js');
let dbm: typeof import('../src/db.js');

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  const platforms = (await s.api('GET', '/platforms')) as { id: string; name: string }[];
  connect = platforms.find((p) => p.name === 'Kafka Connect (demo)')!.id;
  confluent = platforms.find((p) => p.name === 'Confluent Cloud (demo)')!.id;
  orders = ((await s.api('GET', '/data-products?q=Orders')).items as { id: string; key: string }[]).find((p) => p.key === 'orders')!.id;
  mock = await import('../src/mock/mockKafkaConnect.js');
  dbm = await import('../src/db.js');
}, 180_000);

describe('the configuration allow-list', () => {
  const SECRET_CONFIG: Record<string, unknown> = {
    'connector.class': 'io.debezium.connector.postgresql.PostgresConnector',
    name: 'invented-cdc',
    'database.hostname': 'db.invented.example',
    'database.user': 'cdc_user',
    'database.password': 'invented-db-password',
    'topic.prefix': 'shop',
    'table.include.list': 'public.orders,public.customers',
    'snowflake.private.key': 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCinventedKey',
    'snowflake.private.key.passphrase': 'invented-passphrase',
    'snowflake.user.name': 'INVENTED_USER',
    'snowflake.url.name': 'https://invented:secret@account.snowflakecomputing.invalid',
    'snowflake.database.name': 'SHOP',
    'aws.access.key.id': 'AKIAINVENTEDINVENTED',
    'aws.secret.access.key': 'invented/secret/access/key/1234567890abcdefgh',
    's3.bucket.name': 'invented-bucket',
    'sasl.jaas.config': 'org.apache.kafka.common.security.plain.PlainLoginModule required username="u" password="invented-jaas";',
    'connection.url': 'jdbc:postgresql://archiver:invented-url-password@warehouse.invented.example/db',
    'value.converter.basic.auth.user.info': 'registry:invented-registry-secret',
    transforms: 'route,__proto__,unwrap',
    'transforms.route.type': 'org.apache.kafka.connect.transforms.RegexRouter',
    'transforms.route.regex': 'shop\\.public\\.(.*)',
    'transforms.route.replacement': 'cdc.$1',
    'transforms.route.password': 'invented-transform-password',
    'transforms.__proto__.regex': 'x',
    'transforms.unwrap.type': 'io.debezium.transforms.ExtractNewRecordState',
    // an allowed key whose value looks like a credential all the same: left out
    'topics.dir': 'https://user:invented-dir-password@files.invented.example/topics',
    'flush.size': 1000,
  };

  it('keeps exactly the named keys – nothing of a configuration full of secrets', () => {
    const kept = allowedConnectorConfig(SECRET_CONFIG);
    expect(kept).toEqual({
      'connector.class': 'io.debezium.connector.postgresql.PostgresConnector',
      'topic.prefix': 'shop',
      'table.include.list': 'public.orders,public.customers',
      'snowflake.database.name': 'SHOP',
      's3.bucket.name': 'invented-bucket',
      transforms: 'route,unwrap',
      'transforms.route.regex': 'shop\\.public\\.(.*)',
      'transforms.route.replacement': 'cdc.$1',
    });
    const allowed = new Set<string>(CONNECT_CONFIG_KEYS);
    for (const k of Object.keys(kept)) {
      const transform = /^transforms\.[^.]+\.(.+)$/.exec(k);
      expect(allowed.has(k) || (!!transform && (CONNECT_TRANSFORM_KEYS as readonly string[]).includes(transform[1]!)), k).toBe(true);
    }
    const text = JSON.stringify(kept);
    for (const secret of [
      'invented-db-password',
      'inventedKey',
      'invented-passphrase',
      'INVENTED_USER',
      'secret@',
      'AKIA',
      'invented/secret',
      'invented-jaas',
      'invented-url-password',
      'invented-registry-secret',
      'invented-transform-password',
      'invented-dir-password',
      'cdc_user',
    ])
      expect(text).not.toContain(secret);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
    expect(allowedConnectorConfig(null)).toEqual({});
  });

  it('stores only the allowed keys in the Kafka Connect and Confluent readouts', () => {
    const row = dbm.db().get<{ readout: string }>('SELECT readout FROM kafka_connect_readouts WHERE platform_id = ?', connect)!;
    for (const secret of mock.DEMO_CONNECT_SECRETS) expect(row.readout).not.toContain(secret);
    const readout = JSON.parse(row.readout) as { connectors: { name: string; config?: Record<string, string> }[] };
    const sink = readout.connectors.find((c) => c.name === 'orders-snowflake-sink')!;
    expect(sink.config).toEqual({
      'connector.class': 'com.snowflake.kafka.connector.SnowflakeSinkConnector',
      topics: 'orders.v1,shop.public.orders',
      'snowflake.database.name': 'SHOP',
      'snowflake.schema.name': 'RAW',
      'snowflake.topic2table.map': 'orders.v1:ORDERS_RAW,shop.public.orders:ORDERS_RAW',
    });
    expect(readout.connectors.find((c) => c.name === 'shop-cdc')!.config).toEqual({
      'connector.class': 'io.debezium.connector.postgresql.PostgresConnector',
      'topic.prefix': 'shop',
      'table.include.list': 'public.orders,public.customers',
    });
    for (const c of readout.connectors) for (const k of Object.keys(c.config ?? {})) expect(CONNECT_CONFIG_KEYS as readonly string[]).toContain(k);
    const cc = JSON.parse(dbm.db().get<{ readout: string }>('SELECT readout FROM confluent_readouts WHERE platform_id = ?', confluent)!.readout) as {
      connectors: { name: string; config?: Record<string, string> }[];
    };
    expect(cc.connectors.find((c) => c.name === 'orders-s3-sink')!.config).toEqual({
      'connector.class': 'S3_SINK',
      topics: 'orders',
      's3.bucket.name': 'demo-orders-archive',
    });
    expect(JSON.stringify(cc.connectors)).not.toMatch(/aws\.|kafka\.api|http\.api/);
  });
});

describe('lineage from connectors', () => {
  it('reads Debezium, Snowflake and S3 connectors: prefix, routing, topic-to-table map, naming rule, bucket and format', async () => {
    const m = await import('../src/dataproducts/connector-lineage.js');
    expect(m.snowflakeTableName('orders_v1')).toBe('orders_v1');
    expect(m.snowflakeTableName('shop.public.orders')).toBe('shop_public_orders_200135406');
    expect(m.snowflakeTableName('1-events')).toBe(
      '_1_events_' + String(Math.abs(Array.from('1-events').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0))),
    );
    expect(m.plainTableName('public\\.orders')).toBe('public.orders');
    expect(m.plainTableName('public.order_.*')).toBeNull();
    const skipped = { n: 0 };
    expect(m.routeTopic('shop.public.orders', [{ regex: 'shop\\.public\\.(.*)', replacement: 'cdc.$1' }], skipped)).toBe('cdc.orders');
    // a pattern matches the whole topic (Java's matches()), or nothing changes
    expect(m.routeTopic('shop.public.orders', [{ regex: 'public', replacement: 'x' }], skipped)).toBe('shop.public.orders');
    expect(m.routeTopic('a'.repeat(40) + '!', [{ regex: '(a+)+$', replacement: 'x' }], skipped)).toBe('a'.repeat(40) + '!');
    expect(skipped.n).toBe(1);
    const base = { platformId: 'p', platformKind: 'kafka-connect', key: 'c', name: 'c', state: 'RUNNING', topics: [] as string[], kafkaPlatformId: 'k' };
    const cdc = m.connectorDraft(
      {
        ...base,
        type: 'source',
        class: 'io.debezium.connector.sqlserver.SqlServerConnector',
        config: {
          'database.server.name': 'erp',
          'table.include.list': 'dbo.orders,dbo.order_.*',
          transforms: 'route',
          'transforms.route.topic.regex': 'erp\\.(.*)\\.dbo\\.(.*)',
          'transforms.route.topic.replacement': 'erp.$2',
        },
        debezium: { dbms: 'sqlserver', host: 'erp.invented.example', port: 1433, databases: ['sales'] },
      },
      ['dbp'],
    );
    expect(cdc).toMatchObject({ family: 'debezium', technology: 'debezium', tool: 'Debezium', skipped: 1 });
    expect(cdc.inputs).toEqual([{ kind: 'table', databasePlatformIds: ['dbp'], name: 'dbo.orders', text: 'dbo.orders' }]);
    expect(cdc.outputs.map((o) => o.text)).toEqual(['erp.orders']);
    const sf = m.connectorDraft({
      ...base,
      type: 'sink',
      class: 'com.snowflake.kafka.connector.SnowflakeSinkConnector',
      topics: ['orders.v1', 'returns-v1'],
      config: { 'snowflake.database.name': 'SHOP', 'snowflake.schema.name': 'RAW', 'snowflake.topic2table.map': 'orders.v1:ORDERS_RAW' },
      debezium: null,
    });
    expect(sf.outputs.map((o) => o.text)).toEqual(['SHOP.RAW.ORDERS_RAW', `SHOP.RAW.${m.snowflakeTableName('returns-v1')}`]);
    const s3 = m.connectorDraft({
      ...base,
      platformKind: 'confluent-cloud',
      type: 'sink',
      class: 'io.confluent.connect.s3.S3SinkConnector',
      topics: ['orders'],
      config: { 's3.bucket.name': 'invented-lake', 'topics.dir': 'raw/', 'format.class': 'io.confluent.connect.s3.format.parquet.ParquetFormat' },
      debezium: null,
    });
    expect(s3).toMatchObject({ family: 's3Sink', technology: 'confluent' });
    expect(s3.outputs).toEqual([{ kind: 's3', bucket: 'invented-lake', path: 'raw/orders', text: 's3://invented-lake/raw/orders/ (parquet)' }]);
  });

  it('proposes table → topic → table and topic → files as proposals, never applied on their own', async () => {
    const page = (await dana('GET', '/data-products/lineage-proposals?origin=connector&status=open')).items as {
      id: string;
      name: string;
      kind: string;
      tool: string;
      sourceName: string;
      inputs: { qualifiedName: string }[];
      outputs: { qualifiedName: string }[];
      unmatchedInputs: string[];
      unmatchedOutputs: string[];
      cannotAccept: string | null;
    }[];
    const cdc = page.find((p) => p.name === 'shop-cdc')!;
    expect(cdc).toMatchObject({ kind: 'bridge', tool: 'Debezium', sourceName: 'Kafka Connect (demo)' });
    expect(cdc.inputs.map((e) => e.qualifiedName).sort()).toEqual(['public.customers', 'public.orders']);
    expect(cdc.outputs.map((e) => e.qualifiedName).sort()).toEqual(['shop.public.customers', 'shop.public.orders']);
    // the S3 sink names its prefix – no files.path element there yet (the object storage discovery adds it)
    const s3 = page.find((p) => p.name === 'orders-s3-sink')!;
    expect(s3).toMatchObject({ sourceName: 'Confluent Cloud (demo)', tool: 'Confluent', cannotAccept: 'noOutputs' });
    expect(s3.unmatchedOutputs).toEqual(['s3://demo-orders-archive/topics/orders/']);
    // the Snowflake sink's ways are documented by the Orders pipeline already
    const documented = (await dana('GET', '/data-products/lineage-proposals?origin=connector&status=documented')).items as { name: string }[];
    expect(documented.map((p) => p.name)).toContain('orders-snowflake-sink');
    // nothing changed a product
    const steps = (await dana('GET', `/data-products/${orders}/steps`)) as { name: string }[];
    expect(steps.map((x) => x.name)).not.toContain('shop-cdc');
    // accepting makes a bridge step with the connector as its runner
    const accepted = await dana('POST', `/data-products/lineage-proposals/${cdc.id}/accept`, {});
    expect(accepted.status).toBe('accepted');
    const step = ((await dana('GET', `/data-products/${orders}/steps`)) as { id: string; name: string; kind: string; runner: unknown }[]).find(
      (x) => x.name === 'shop-cdc',
    )!;
    expect(step).toMatchObject({ kind: 'bridge', runner: { kind: 'connector', platformId: connect, name: 'shop-cdc', technology: 'debezium' } });
    await dana('DELETE', `/data-products/${orders}/steps/${step.id}`);
  });

  it('proposes again after a readout, only while the module is on', async () => {
    const m = await import('../src/dataproducts/connector-lineage.js');
    dbm.db().run("DELETE FROM dp_lineage_proposals WHERE origin = 'connector' AND source_id = ?", connect);
    await s.api('PUT', '/settings/modules/dataProducts', { enabled: false });
    expect(m.proposeFromConnectors(connect)).toBe(0);
    await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
    await s.api('POST', `/platforms/${connect}/kafka-connect/read`);
    const n = Number(dbm.db().get<{ n: number }>("SELECT COUNT(*) AS n FROM dp_lineage_proposals WHERE origin = 'connector' AND source_id = ?", connect)!.n);
    expect(n).toBe(2);
  });

  it('shows connector proposals only to who sees the platform', async () => {
    const seen = async () =>
      ((await dana('GET', '/data-products/lineage-proposals?origin=connector&status=open')).items as { sourceId: string }[]).some(
        (p) => p.sourceId === connect,
      );
    expect(await seen()).toBe(true);
    await s.api('PUT', `/platforms/${connect}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });
    expect(await seen()).toBe(false);
    expect(await dana('GET', '/data-products/connectors')).not.toContainEqual(expect.objectContaining({ platformId: connect }));
    await s.api('PUT', `/platforms/${connect}/access`, { acl: [] });
    expect(await seen()).toBe(true);
  });
});

describe('Create step from connector', () => {
  it('lists the connectors, drafts the step and writes it as a bridge with the connector as its runner', async () => {
    const list = (await dana('GET', '/data-products/connectors')) as { platformId: string; connectors: { name: string; family: string }[] }[];
    const kc = list.find((p) => p.platformId === connect)!;
    expect(kc.connectors.map((c) => [c.name, c.family])).toEqual([
      ['orders-archive', 'other'],
      ['orders-snowflake-sink', 'snowflakeSink'],
      ['shop-cdc', 'debezium'],
    ]);
    const draft = await dana('GET', `/data-products/${orders}/steps/from-connector?platformId=${connect}&connector=orders-snowflake-sink`);
    expect(draft).toMatchObject({
      kind: 'bridge',
      family: 'snowflakeSink',
      runner: { kind: 'connector', name: 'orders-snowflake-sink', technology: 'kafka-connect' },
    });
    expect(draft.inputs.map((e: { qualifiedName: string }) => e.qualifiedName).sort()).toEqual(['orders.v1', 'shop.public.orders']);
    expect(draft.outputs.map((e: { qualifiedName: string }) => e.qualifiedName)).toEqual(['SHOP.RAW.ORDERS_RAW']);
    expect(
      (await fail(vera('POST', `/data-products/${orders}/steps/from-connector`, { platformId: connect, connector: 'orders-snowflake-sink' }))).status,
    ).toBe(403);
    expect((await fail(dana('GET', `/data-products/${orders}/steps/from-connector?platformId=${connect}&connector=nope`))).code).toBe(
      'KAFKA_CONNECTOR_NOT_FOUND',
    );
    // a sink whose target is not known writes nothing a step could name
    expect((await fail(dana('POST', `/data-products/${orders}/steps/from-connector`, { platformId: connect, connector: 'orders-archive' }))).code).toBe(
      'DATA_STEP_INVALID',
    );
    const step = await dana('POST', `/data-products/${orders}/steps/from-connector`, {
      platformId: connect,
      connector: 'orders-snowflake-sink',
      name: 'Snowflake sink (from connector)',
    });
    expect(step).toMatchObject({
      name: 'Snowflake sink (from connector)',
      kind: 'bridge',
      runner: { kind: 'connector', platformId: connect, technology: 'kafka-connect' },
    });
    const audit = JSON.stringify(await s.api('GET', '/audit?action=dataproduct.step_added'));
    expect(audit).toContain('Snowflake sink (from connector)');
  });

  it('takes the connector state as the step health through the Kafka Connect check', async () => {
    const eng = await import('../src/monitors/engine.js');
    // the demo's monitor of every connector of the cluster counts too (not run yet: unknown)
    const before = ((await dana('GET', `/data-products/${orders}/steps`)) as { name: string; health: { checks: { visible: number } } | null }[]).find(
      (x) => x.name === 'Load captured orders',
    )!;
    const others = before.health?.checks.visible ?? 0;
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Snowflake sink',
        failuresBeforeDown: 1,
        checks: [{ id: 'sink', name: 'sink', type: 'kafka-connect', platform: 'Kafka Connect (demo)', connector: 'orders-snowflake-sink' }],
      },
    });
    mock.setConnectState('orders-snowflake-sink', -1, 'FAILED');
    await eng.evaluateMonitorNow(monitor.id);
    const steps = (await dana('GET', `/data-products/${orders}/steps`)) as { name: string; health: unknown }[];
    expect(steps.find((x) => x.name === 'Load captured orders')!.health).toEqual({ status: 'down', checks: { visible: others + 1, hidden: 0 } });
    // a step whose runner is no connector has none
    expect(steps.find((x) => x.name === 'Stage orders')!.health).toBeNull();
    mock.setConnectState('orders-snowflake-sink', -1, 'RUNNING');
    await eng.evaluateMonitorNow(monitor.id);
    const after = ((await dana('GET', `/data-products/${orders}/steps`)) as { name: string; health: { status: string } }[]).find(
      (x) => x.name === 'Load captured orders',
    )!;
    expect(after.health.status).not.toBe('down');
    // who may not see the connector's platform sees neither the runner nor its health
    const asVera = ((await vera('GET', `/data-products/${orders}/steps`)) as { name: string; runnerHidden: boolean; health: unknown }[]).find(
      (x) => x.name === 'Load captured orders',
    )!;
    expect(asVera).toMatchObject({ runnerHidden: true, health: null });
  });
});
