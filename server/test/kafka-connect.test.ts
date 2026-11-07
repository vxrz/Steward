import crypto from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { debeziumMatches, debeziumSource, isConnectSecretKey, redactConnectAnswer, redactConnectValue, trimTrace } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Kafka Connect (0.9.0, #223): the platform kind kafka-connect, read-only – the readout of connectors, tasks and plugins
 * from the demo REST API, links to Kafka topic components and the database platform a Debezium connector reads,
 * secrets removed from every answer and never stored, changing requests refused, the monitor check kafka-connect and
 * sign-in with a client certificate (mutual TLS).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let connectId: string;
let kafkaId: string;
let dbId: string;
let olivia: Client;
let mock: typeof import('../src/mock/mockKafkaConnect.js');
let kafka: typeof import('../src/mock/mockKafka.js');
let eng: typeof import('../src/monitors/engine.js');

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const platforms = await s.api('GET', '/platforms');
  connectId = platforms.find((p: any) => p.name === 'Kafka Connect (demo)').id;
  kafkaId = platforms.find((p: any) => p.name === 'Kafka (demo)').id;
  dbId = platforms.find((p: any) => p.name === 'Shop database (demo)').id;
  olivia = await s.as('olivia', PW);
  mock = await import('../src/mock/mockKafkaConnect.js');
  kafka = await import('../src/mock/mockKafka.js');
  eng = await import('../src/monitors/engine.js');
});
afterAll(async () => {
  vi.useRealTimers();
  await s?.app.close();
});

/** None of the demo configuration's secrets in a value (as JSON). */
const noSecrets = (v: unknown) => {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  for (const secret of mock.DEMO_CONNECT_SECRETS) expect(text).not.toContain(secret);
};

describe('secret-looking values (shared/src/kafkaConnect.ts)', () => {
  it('knows secret keys by their words', () => {
    for (const k of [
      'database.password',
      'connection.password',
      'ssl.key.password',
      'ssl.keystore.password',
      'sasl.jaas.config',
      'aws.secret.access.key',
      'basic.auth.user.info',
      'value.converter.basic.auth.user.info',
      'api.key',
      'apiKey',
      'ssl.key',
      'gcs.credentials.json',
      'oauth.token',
      'private.key.passphrase',
    ])
      expect(isConnectSecretKey(k), k).toBe(true);
    for (const k of [
      'key.converter',
      'key.converter.schemas.enable',
      'primary.key.mode',
      'database.hostname',
      'topics',
      'tasks.max',
      'message.key.columns',
      'aws.access.key.id',
    ])
      expect(isConnectSecretKey(k), k).toBe(false);
  });

  it('removes values by key and by heuristics, keeps references and structure', () => {
    expect(redactConnectValue('database.password', 'hunter22')).toBe('***');
    expect(redactConnectValue('database.password', '${file:/opt/connect/secrets.properties:db.password}')).toBe(
      '${file:/opt/connect/secrets.properties:db.password}',
    );
    expect(redactConnectValue('connection.url', 'jdbc:postgresql://archiver:s3cret@warehouse.example.invalid:5432/archive')).toBe(
      'jdbc:postgresql://archiver:***@warehouse.example.invalid:5432/archive',
    );
    expect(redactConnectValue('connection.url', 'jdbc:sqlserver://db.example.invalid:1433;user=sa;password=s3cret;encrypt=true')).toBe(
      'jdbc:sqlserver://db.example.invalid:1433;user=sa;password=***;encrypt=true',
    );
    expect(redactConnectValue('some.setting', '-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----')).toBe('***');
    expect(redactConnectValue('some.setting', 'Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRg')).toBe('***');
    expect(redactConnectValue('some.setting', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl')).toBe('***');
    // names with digits are no tokens; structural keys stay as they are
    expect(redactConnectValue('transforms.route.replacement', 'orders-archive-sink-2024-v2-production')).toBe('orders-archive-sink-2024-v2-production');
    expect(redactConnectValue('connector.class', 'io.debezium.connector.postgresql.PostgresConnector')).toBe(
      'io.debezium.connector.postgresql.PostgresConnector',
    );
    expect(redactConnectValue('database.hostname', 'db.example.invalid')).toBe('db.example.invalid');
    expect(redactConnectValue('tasks.max', 3)).toBe(3);
  });

  it('trims traces and removes the secrets of the same answer from them', () => {
    const trace = [
      'boom: password=hunter22 for jdbc:postgresql://u:hunter22@h.example.invalid/x',
      ...Array.from({ length: 30 }, (_, i) => `\tat frame${i}`),
    ].join('\n');
    const t = trimTrace(trace, ['hunter22']);
    expect(t.split('\n')).toHaveLength(13);
    expect(t.endsWith('…')).toBe(true);
    expect(t).not.toContain('hunter22');
    const body = redactConnectAnswer({
      a: {
        info: { config: { 'database.password': 'swordfish-42', 'connector.class': 'x.Y' } },
        status: { tasks: [{ id: 0, trace: 'login swordfish-42 refused' }] },
      },
    });
    expect(JSON.stringify(body)).not.toContain('swordfish-42');
    expect(body.a.status.tasks[0].trace).toBe('login *** refused');
    // keys taken from the answer never reach a prototype
    expect(Object.getPrototypeOf(redactConnectAnswer(JSON.parse('{"__proto__": {"polluted": 1}}')))).toBe(Object.prototype);
  });

  it('reads what a Debezium connector reads and matches database platforms', () => {
    const pg = debeziumSource('io.debezium.connector.postgresql.PostgresConnector', { 'database.hostname': 'DB.example.invalid', 'database.dbname': 'shop' });
    expect(pg).toEqual({ dbms: 'postgresql', host: 'DB.example.invalid', port: 5432, databases: ['shop'] });
    expect(debeziumMatches(pg!, { dialect: 'postgresql', host: 'db.example.invalid.', port: 5432, database: 'shop' })).toBe(true);
    expect(debeziumMatches(pg!, { dialect: 'postgresql', host: 'db.example.invalid', port: 5433, database: 'shop' })).toBe(false);
    expect(debeziumMatches(pg!, { dialect: 'postgresql', host: 'db.example.invalid', port: 5432, database: 'crm' })).toBe(false);
    expect(debeziumMatches(pg!, { dialect: 'mysql', host: 'db.example.invalid', port: 5432, database: 'shop' })).toBe(false);
    const my = debeziumSource('io.debezium.connector.mysql.MySqlConnector', { 'database.hostname': 'my.example.invalid', 'database.port': '3307' });
    expect(my).toEqual({ dbms: 'mysql', host: 'my.example.invalid', port: 3307, databases: [] });
    expect(debeziumMatches(my!, { dialect: 'mysql', host: 'my.example.invalid', port: 3307, database: 'anything' })).toBe(true);
    expect(debeziumSource('io.debezium.connector.jdbc.JdbcSinkConnector', {})).toBeNull();
    expect(debeziumSource('org.apache.kafka.connect.file.FileStreamSourceConnector', { 'database.hostname': 'x' })).toBeNull();
  });
});

describe('Kafka Connect platforms', () => {
  it('tests the connection and reads connectors, tasks, plugins and their links', async () => {
    const t = await s.api('POST', `/platforms/${connectId}/test`, {});
    expect(t).toMatchObject({ ok: true, status: 200 });
    // a Kafka topic component of an application: the sink's topic links to it, and it lists the sink
    const app = await s.api('POST', '/applications', { name: 'Shop on Kafka Connect', owners: [] });
    await s.api('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name: 'orders', environment: 'prod', platformId: kafkaId });
    const v = await s.api('POST', `/platforms/${connectId}/kafka-connect/read`, {});
    expect(v).toMatchObject({ platformId: connectId, kafkaPlatform: { id: kafkaId, name: 'Kafka (demo)' }, kafkaPlatformMissing: false, canRead: true });
    expect(v.readout).toMatchObject({ error: null, worker: { version: '3.9.0', commit: 'a1b2c3d4e5f60718', kafkaClusterId: 'demo-cluster-0001' } });
    expect(v.readout.plugins).toHaveLength(5);
    const [archive, cdc] = v.connectors;
    expect(cdc).toMatchObject({
      name: 'shop-cdc',
      type: 'source',
      class: 'io.debezium.connector.postgresql.PostgresConnector',
      version: '2.7.3.Final',
      state: 'RUNNING',
      workerId: 'connect-1.demo.invalid:8083',
      topics: ['shop.public.customers', 'shop.public.orders'],
      groupId: null,
      debezium: { dbms: 'postgresql', host: 'postgres.demo.invalid', port: 5432, databases: ['shop'] },
      database: { platform: { id: dbId, name: 'Shop database (demo)' } },
      topicComponents: [],
    });
    expect(archive).toMatchObject({
      name: 'orders-archive',
      type: 'sink',
      class: 'io.debezium.connector.jdbc.JdbcSinkConnector',
      state: 'RUNNING',
      topics: ['orders'],
      groupId: 'connect-orders-archive',
      debezium: null,
      database: null,
      // the demo's Webshop has the topic too
      topicComponents: expect.arrayContaining([expect.objectContaining({ topic: 'orders', applicationId: app.id, applicationName: 'Shop on Kafka Connect' })]),
    });
    expect(archive.tasks.map((x: any) => [x.id, x.state, x.workerId])).toEqual([
      [0, 'RUNNING', 'connect-2.demo.invalid:8083'],
      [1, 'FAILED', 'connect-1.demo.invalid:8083'],
    ]);
    const failed = archive.tasks[1];
    expect(failed.failedSince).toBeTruthy();
    expect(failed.trace).toContain('JDBCConnectionException');
    expect(failed.trace.split('\n').length).toBeLessThanOrEqual(13);
    expect(failed.trace).toContain('jdbc:postgresql://***@warehouse.demo.invalid');
    noSecrets(v);
    // the application page names the connectors of its topic
    const a = await s.api('GET', `/applications/${app.id}`);
    expect(a.components.find((c: any) => c.name === 'orders').connectors).toEqual([
      { platformId: connectId, platformName: 'Kafka Connect (demo)', connector: 'orders-archive', type: 'sink', state: 'RUNNING' },
    ]);
    // a second read keeps the time the task failed
    const again = await s.api('POST', `/platforms/${connectId}/kafka-connect/read`, {});
    expect(again.connectors[0].tasks[1].failedSince).toBe(failed.failedSince);
  });

  it('shows a configuration with its secrets removed, never stores one and audits the read', async () => {
    const { config } = await s.api('GET', `/platforms/${connectId}/kafka-connect/connectors/shop-cdc/config`);
    expect(config).toMatchObject({
      'database.hostname': 'postgres.demo.invalid',
      'database.dbname': 'shop',
      'database.user': 'debezium',
      'database.password': '***',
      'value.converter.basic.auth.user.info': '***',
      'notification.sink.signing': '***',
      'key.converter': 'org.apache.kafka.connect.json.JsonConverter',
    });
    noSecrets(config);
    await expect(s.api('GET', `/platforms/${connectId}/kafka-connect/connectors/nope/config`)).rejects.toMatchObject({
      status: 404,
      body: { code: 'KAFKA_CONNECTOR_NOT_FOUND' },
    });
    const audit = await s.api('GET', `/audit?entityType=platform&entityId=${connectId}&limit=50`);
    expect(audit.find((e: any) => e.action === 'kafka_connect.config_read')).toMatchObject({
      summary: 'Configuration of the connector "shop-cdc" read on "Kafka Connect (demo)" (secret-looking values removed)',
    });
    // every other way to read the REST API: the explorer (ad-hoc requests), process steps and the MCP gateway use the same layer
    for (const path of [
      '/connectors?expand=info&expand=status',
      '/connectors/shop-cdc',
      '/connectors/orders-archive/tasks',
      '/connectors/orders-archive/status',
    ])
      noSecrets(await s.api('POST', `/platforms/${connectId}/request`, { method: 'GET', path }));
    noSecrets(audit);
    const { db } = await import('../src/db.js');
    const rows = db().all('SELECT * FROM kafka_connect_readouts');
    expect(rows).toHaveLength(1);
    noSecrets(rows);
    expect(JSON.stringify(rows)).not.toContain('database.user');
  });

  it('refuses every changing request, whoever asks', async () => {
    for (const [method, path] of [
      ['POST', '/connectors/orders-archive/restart'],
      ['PUT', '/connectors/shop-cdc/pause'],
      ['PUT', '/connectors/shop-cdc/resume'],
      ['DELETE', '/connectors/shop-cdc'],
      ['POST', '/connectors'],
    ])
      await expect(s.api('POST', `/platforms/${connectId}/request`, { method, path })).rejects.toMatchObject({
        status: 403,
        body: { code: 'PLATFORM_METHOD_DENIED' },
      });
  });

  it('names only what the reader may see', async () => {
    // the database platform hidden from olivia: the Debezium connector reads like one without a match
    await s.api('PUT', `/platforms/${dbId}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });
    const v = await olivia('GET', `/platforms/${connectId}/kafka-connect`);
    expect(v.connectors.find((c: any) => c.name === 'shop-cdc').database).toEqual({ platform: null, system: null });
    expect(JSON.stringify(v)).not.toContain('Shop database (demo)');
    await s.api('PUT', `/platforms/${dbId}/access`, { acl: [] });
    // the Kafka platform hidden: no topic links, no name
    await s.api('PUT', `/platforms/${kafkaId}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });
    const w = await olivia('GET', `/platforms/${connectId}/kafka-connect`);
    expect(w).toMatchObject({ kafkaPlatform: null, kafkaPlatformMissing: true });
    expect(JSON.stringify(w)).not.toContain('Kafka (demo)');
    await s.api('PUT', `/platforms/${kafkaId}/access`, { acl: [] });
    // the Kafka Connect platform hidden: like a missing one; its connectors leave the topic component too
    await s.api('PUT', `/platforms/${connectId}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });
    await expect(olivia('GET', `/platforms/${connectId}/kafka-connect`)).rejects.toMatchObject({ status: 400, body: { code: 'PLATFORM_NOT_FOUND' } });
    await expect(olivia('GET', `/platforms/${connectId}/kafka-connect/connectors/shop-cdc/config`)).rejects.toMatchObject({ status: 403 });
    const app = (await olivia('GET', '/applications')).find((a: any) => a.name === 'Shop on Kafka Connect');
    expect((await olivia('GET', `/applications/${app.id}`)).components[0].connectors).toEqual([]);
    await s.api('PUT', `/platforms/${connectId}/access`, { acl: [] });
    // another kind of platform
    await expect(s.api('GET', `/platforms/${kafkaId}/kafka-connect`)).rejects.toMatchObject({ status: 400, body: { code: 'KAFKA_CONNECT_PLATFORM' } });
  });

  it('keeps the last connectors when a read fails and records connectors that come and go', async () => {
    const p = await s.api('GET', `/platforms/${connectId}`);
    await s.api('PUT', `/platforms/${connectId}/secrets`, { password: 'wrong-password' });
    const bad = await s.api('POST', `/platforms/${connectId}/kafka-connect/read`, {});
    expect(bad.readout.error).toMatch(/HTTP 401.*check the sign-in/);
    expect(bad.connectors).toHaveLength(2);
    await s.api('PUT', `/platforms/${connectId}/secrets`, { password: mock.DEMO_KAFKA_CONNECT.password });
    mock.removeConnector('shop-cdc');
    const fewer = await s.api('POST', `/platforms/${connectId}/kafka-connect/read`, {});
    expect(fewer.connectors.map((c: any) => c.name)).toEqual(['orders-archive']);
    mock.resetKafkaConnect();
    await s.api('POST', `/platforms/${connectId}/kafka-connect/read`, {});
    const audit = await s.api('GET', `/audit?entityType=platform&entityId=${connectId}&limit=50`);
    expect(audit.filter((e: any) => e.action === 'platform.connectors_changed').map((e: any) => e.summary)).toEqual([
      'Connectors of "Kafka Connect (demo)" changed: +shop-cdc',
      'Connectors of "Kafka Connect (demo)" changed: -shop-cdc',
    ]);
    expect(p.secretKeys).toEqual(expect.arrayContaining(['username', 'password']));
  });
});

describe('monitor check kafka-connect', () => {
  it('connectors and tasks running, a task failed for N minutes, a sink lag, a quiet Debezium connector', async () => {
    mock.resetKafkaConnect();
    kafka.resetKafka();
    const k = (id: string, extra: Record<string, unknown>) => ({ id, name: id, type: 'kafka-connect', platform: 'Kafka Connect (demo)', ...extra });
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Shop connectors',
        failuresBeforeDown: 1,
        checks: [
          k('all', {}),
          k('archive', { connector: 'orders-archive', failedMinutes: 10 }),
          k('lag', { connector: 'orders-archive', failedMinutes: 10000, maxLag: 100 }),
          k('cdc', { connector: 'shop-cdc', quietMinutes: 10 }),
          k('nope', { connector: 'nope' }),
          { id: 'wrong', name: 'wrong', type: 'kafka-connect', platform: 'Kafka (demo)' },
        ],
      },
    });
    const statuses = async () => {
      await eng.evaluateMonitorNow(monitor.id);
      const m = await s.api('GET', `/monitors/${monitor.id}`);
      return Object.fromEntries(m.checks.map((c: any) => [c.checkId, [c.status, c.last?.message]]));
    };
    let st = await statuses();
    expect(st.all[0]).toBe('down');
    expect(st.all[1]).toMatch(/^Kafka Connect: 2\/2 connectors running – orders-archive task 1 FAILED/);
    expect(st.archive[0]).toBe('degraded');
    expect(st.archive[1]).toMatch(/^Kafka Connect: orders-archive RUNNING \(1\/2 tasks\) – orders-archive task 1 FAILED for \d+ minutes \(alarm after 10\)$/);
    expect(st.lag).toEqual(['degraded', expect.stringContaining('orders-archive lag 135 (at most 100)')]);
    expect(st.cdc).toEqual(['up', 'Kafka Connect: shop-cdc RUNNING (1/1 tasks) – shop-cdc: newest message 2 minutes ago']);
    expect(st.nope).toEqual(['unknown', 'Kafka Connect: no connector "nope"']);
    expect(st.wrong[0]).toBe('unknown');
    noSecrets(st);
    // 20 minutes later: the task still failed – an alarm now; the CDC topics got nothing since; the source paused
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 20 * 60_000 });
    mock.setConnectState('shop-cdc', -1, 'PAUSED');
    st = await statuses();
    vi.useRealTimers();
    expect(st.archive[0]).toBe('down');
    expect(st.archive[1]).toMatch(/task 1 FAILED for 2\d minutes$/);
    expect(st.cdc[0]).toBe('degraded');
    expect(st.cdc[1]).toContain('shop-cdc PAUSED');
    expect(st.cdc[1]).toContain('shop-cdc: no message on its 2 topics for 22 minutes (expected within 10)');
    mock.resetKafkaConnect();
  });
});

// ---------- mutual TLS: a self-signed certificate, DER by hand (no openssl) ----------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const time = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z', 'ascii'));
function selfSigned(cn: string): { cert: string; key: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sha256WithRsa = seq(Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00]));
  const name = seq(tlv(0x31, seq(Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]), tlv(0x0c, Buffer.from(cn)))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([0x42])),
    sha256WithRsa,
    name,
    seq(time(new Date(Date.now() - 86400000)), time(new Date(Date.now() + 365 * 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const der = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.concat([Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)])));
  const b64 = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim();
  return { cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

describe('sign-in with a client certificate (mutual TLS)', () => {
  it('presents the certificate in tlsCertificate / tlsKey to the platform', async () => {
    const server = selfSigned('localhost');
    const client = selfSigned('steward-connect-reader');
    const fingerprint = new crypto.X509Certificate(client.cert).fingerprint256;
    const seen: string[] = [];
    const api = https.createServer({ key: server.key, cert: server.cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
      const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
      seen.push(peer?.fingerprint256 ?? 'none');
      if (peer?.fingerprint256 !== fingerprint) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error_code":401,"message":"client certificate required"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.startsWith('/connectors') ? '[]' : '{"version":"3.9.0"}');
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    try {
      const port = (api.address() as AddressInfo).port;
      const p = await s.api('POST', '/platforms', {
        name: 'Kafka Connect (mTLS)',
        kind: 'kafka-connect',
        baseUrl: `https://127.0.0.1:${port}`,
        config: { auth: { type: 'none' }, variables: {}, http: { insecureTls: true, proxy: 'none' }, testPath: '/connectors' },
        secrets: {},
      });
      expect(await s.api('POST', `/platforms/${p.id}/test`, {})).toMatchObject({ ok: false, status: 401 });
      await s.api('PUT', `/platforms/${p.id}/secrets`, { tlsCertificate: client.cert, tlsKey: client.key });
      expect(await s.api('POST', `/platforms/${p.id}/test`, {})).toMatchObject({ ok: true, status: 200 });
      expect(seen).toContain(fingerprint);
      // the key never leaves Steward
      expect(JSON.stringify(await s.api('GET', `/platforms/${p.id}`))).not.toContain('PRIVATE KEY');
    } finally {
      await new Promise((r) => api.close(r));
    }
  });
});
