import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapList } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Kafka (#112): topic components read from the simulated cluster and Schema Registry (settings, offsets, consumer
 * groups and lag, schema version), the monitor check type `kafka` (new messages, lag, stuck groups, schema), and
 * "peek" (off unless the platform allows it, platform managers only, sensitive fields hidden, audited).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let kafkaId: string;
let olivia: Client;
let mock: typeof import('../src/mock/mockKafka.js');
let eng: typeof import('../src/monitors/engine.js');

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  kafkaId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'Kafka (demo)').id;
  olivia = await s.as('olivia', PW);
  mock = await import('../src/mock/mockKafka.js');
  eng = await import('../src/monitors/engine.js');
});
afterAll(async () => {
  vi.useRealTimers();
  await s?.app.close();
});

describe('Kafka platforms', () => {
  it('reads bootstrap lists and tests the connection', async () => {
    expect(bootstrapList('a.example.com:9092, b.example.com:9093 [::1]:9094 nope bad:0')).toEqual([
      { host: 'a.example.com', port: 9092 },
      { host: 'b.example.com', port: 9093 },
      { host: '::1', port: 9094 },
    ]);
    const t = await s.api('POST', `/platforms/${kafkaId}/test`, {});
    expect(t).toMatchObject({ ok: true, message: 'Connection works – 3 topics, Schema Registry with 2 subjects' });
  });
});

describe('Kafka topics of an application', () => {
  it('reads settings, offsets, consumer groups with lag and the schema; records a schema change', async () => {
    mock.resetKafka();
    const app = await s.api('POST', '/applications', { name: 'Shop on Kafka', owners: [] });
    const gitlab = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'gitlab').id;
    await expect(s.api('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name: 'orders', platformId: gitlab })).rejects.toThrow(
      /Kafka platform/,
    );
    await expect(s.api('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name: 'orders/x', platformId: kafkaId })).rejects.toThrow(
      /topic name/,
    );
    const a = await s.api('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name: 'orders', environment: 'prod', platformId: kafkaId });
    const cmp = a.components.find((c: any) => c.name === 'orders');
    expect(cmp).toMatchObject({ platformId: kafkaId, topic: null });
    const read = async () => (await s.api('POST', `/applications/${app.id}/components/${cmp.id}/topic`, {})).components.find((c: any) => c.id === cmp.id).topic;
    const t = await read();
    expect(t).toMatchObject({
      error: null,
      partitions: 3,
      replicationFactor: 3,
      configs: { 'cleanup.policy': 'delete', 'retention.ms': '604800000', 'min.insync.replicas': '2' },
      endOffset: 4200 + 4180 + 4215,
      schema: { subject: 'orders-value', version: 2, id: 102, type: 'AVRO', versions: 2 },
    });
    expect(Date.now() - Date.parse(t.lastMessageAt)).toBeLessThan(5 * 60_000);
    // the group with the most lag first; partitions without a commit count fully
    expect(t.groups).toEqual([
      { group: 'billing', state: 'Stable', lag: 1100 + 1130 + 1093, partitions: 3 },
      { group: 'order-service', state: 'Stable', lag: 1 + 0 + 5, partitions: 3 },
    ]);
    mock.registerSchema(
      'orders-value',
      '{"type":"record","name":"Order","fields":[{"name":"orderId","type":"string"},{"name":"currency","type":"string","default":"EUR"}]}',
    );
    expect((await read()).schema.version).toBe(3);
    const audit = await s.api('GET', `/audit?entityType=application&entityId=${app.id}&limit=50`);
    expect(audit.some((e: any) => e.action === 'application.topic_schema_changed' && /version 2 → 3/.test(e.summary))).toBe(true);
    // the readout reaches processes through the application input
    const missing = await s.api('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name: 'nope', platformId: kafkaId });
    const gone = (
      await s.api('POST', `/applications/${app.id}/components/${missing.components.find((c: any) => c.name === 'nope').id}/topic`, {})
    ).components.find((c: any) => c.name === 'nope');
    expect(gone.topic.error).toMatch(/no topic "nope"/);
  });

  it('the job reads topics not read for 6 hours', async () => {
    const { runKafkaJob } = await import('../src/kafka/service.js');
    expect(await runKafkaJob(Date.now())).toBe(0);
    expect(await runKafkaJob(Date.now() + 7 * 3_600_000)).toBeGreaterThanOrEqual(2);
  });
});

describe('monitor check kafka', () => {
  it('new messages, lag, stuck groups and the schema version', async () => {
    mock.resetKafka();
    const k = (id: string, extra: Record<string, unknown>) => ({ id, name: id, type: 'kafka', platform: 'Kafka (demo)', ...extra });
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Shop topics',
        failuresBeforeDown: 1,
        checks: [
          k('orders', { topic: 'orders', messagesWithinMinutes: 10 }),
          k('payments', { topic: 'payments', messagesWithinMinutes: 60 }),
          k('paymentsSoft', { topic: 'payments', messagesWithinMinutes: 60, quietAs: 'degraded' }),
          k('orderService', { topic: 'orders', group: 'order-service', maxLag: 100 }),
          k('billing', { topic: 'orders', group: 'billing', maxLag: 1000 }),
          k('schema', { topic: 'orders', schemaVersion: 2 }),
          k('nogroup', { topic: 'orders', group: 'nobody' }),
          k('notopic', { topic: 'nope', messagesWithinMinutes: 5 }),
        ],
      },
    });
    const statuses = async () => {
      await eng.evaluateMonitorNow(monitor.id);
      const m = await s.api('GET', `/monitors/${monitor.id}`);
      return Object.fromEntries(m.checks.map((c: any) => [c.checkId, [c.status, c.last?.message]]));
    };
    let st = await statuses();
    expect(st.orders).toEqual(['up', 'Kafka: orders – newest message 1 minutes ago']);
    expect(st.payments).toEqual(['down', 'Kafka: payments – no new message for 180 minutes (expected within 60)']);
    expect(st.paymentsSoft[0]).toBe('degraded');
    expect(st.orderService).toEqual(['up', 'Kafka: orders – group order-service lag 6']);
    expect(st.billing).toEqual(['degraded', 'Kafka: orders – group billing lag 3323 (at most 1000)']);
    expect(st.schema).toEqual(['up', 'Kafka: orders – schema version 2']);
    expect(st.nogroup).toEqual(['unknown', 'Kafka: consumer group "nobody" has no offsets on orders']);
    expect(st.notopic).toEqual(['unknown', 'Kafka: no topic "nope"']);
    // 20 minutes later: order-service committed, billing did not – it is stuck; a new schema version
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 20 * 60_000 });
    mock.commitKafka('order-service', 'orders', [4200, 4180, 4215]);
    mock.produceKafka('orders', 3);
    mock.registerSchema('orders-value', '{"type":"record","name":"Order","fields":[{"name":"orderId","type":"string"}]}');
    st = await statuses();
    vi.useRealTimers();
    expect(st.orderService[0]).toBe('up');
    expect(st.billing).toEqual(['down', 'Kafka: orders – group billing stuck: lag 3326, no commit for 20 minutes']);
    expect(st.schema).toEqual(['degraded', 'Kafka: orders – schema version 3 (expected 2)']);
  });
});

describe('peek', () => {
  it('is off unless the platform allows it, for platform managers only, hides sensitive fields and is audited', async () => {
    const { messages } = await s.api('POST', `/platforms/${kafkaId}/kafka/peek`, { topic: 'orders', count: 2 });
    expect(messages).toHaveLength(2);
    const v = JSON.parse(messages[0].value);
    expect(v).toMatchObject({ orderId: 'o-1005', customer: { name: '***', email: '***' }, cardNumber: '***', total: 47.5 });
    expect(messages[0]).toMatchObject({ partition: 2, offset: '4175', key: 'o-1005', headers: ['traceparent'], truncated: false });
    const pay = (await s.api('POST', `/platforms/${kafkaId}/kafka/peek`, { topic: 'payments', count: 5 })).messages;
    expect(JSON.parse(pay[0].value).iban).toBe('***');
    const text = (await s.api('POST', `/platforms/${kafkaId}/kafka/peek`, { topic: 'shop-events', count: 1 })).messages;
    expect(text[0].value).toBe('not json: cart 9 checked out');
    const { hideSensitive } = await import('../src/kafka/service.js');
    expect(hideSensitive('mail erika@example.com, IBAN DE02 1203 0000 0000 2020 51, card 4111 1111 1111 1111')).toBe(
      'mail ***@***, IBAN ***IBAN***, card ***number***',
    );
    await expect(s.api('POST', `/platforms/${kafkaId}/kafka/peek`, { topic: 'orders', count: 50 })).rejects.toThrow();
    await expect(olivia('POST', `/platforms/${kafkaId}/kafka/peek`, { topic: 'orders' })).rejects.toThrow(/manage|not found|permission|allowed/i);
    const audit = await s.api('GET', `/audit?entityType=platform&entityId=${kafkaId}&limit=20`);
    expect(audit.filter((e: any) => e.action === 'kafka.messages_read').length).toBeGreaterThanOrEqual(3);
    const p = await s.api('GET', `/platforms/${kafkaId}`);
    await s.api('PUT', `/platforms/${kafkaId}`, { config: { ...p.config, variables: { ...p.config.variables, peek: 'off' } } });
    await expect(s.api('POST', `/platforms/${kafkaId}/kafka/peek`, { topic: 'orders' })).rejects.toThrow(/off for this platform/);
  });
});
