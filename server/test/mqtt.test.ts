import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mqttMatches, validMqttFilter } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * MQTT (#113): the listener per broker (real MQTT.js client against the built-in broker over WebSocket), the monitor
 * check type `mqtt` – messages within a window, silent devices, connected clients – and what is stored (times and
 * counts only).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let mqttId: string;
let broker: typeof import('../src/mock/mockMqtt.js');
let listener: typeof import('../src/mqtt/listener.js');
let eng: typeof import('../src/monitors/engine.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  mqttId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'MQTT (demo)').id;
  broker = await import('../src/mock/mockMqtt.js');
  listener = await import('../src/mqtt/listener.js');
  eng = await import('../src/monitors/engine.js');
});
afterAll(async () => {
  await s?.app.close();
});

describe('topics and patterns', () => {
  it('match like a broker does', () => {
    expect(mqttMatches('plant/+/status', 'plant/press-1/status')).toBe(true);
    expect(mqttMatches('plant/+/status', 'plant/press-1/status/x')).toBe(false);
    expect(mqttMatches('plant/#', 'plant/press-1/status')).toBe(true);
    expect(mqttMatches('plant/#', 'plant')).toBe(true);
    expect(mqttMatches('#', '$SYS/broker/clients/connected')).toBe(false);
    expect(mqttMatches('$SYS/broker/clients/connected', '$SYS/broker/clients/connected')).toBe(true);
    expect(validMqttFilter('plant/+/status')).toBe(true);
    expect(validMqttFilter('plant/#/status')).toBe(false);
    expect(validMqttFilter('plant/press+/x')).toBe(false);
  });
});

describe('MQTT broker', () => {
  it('tests the connection with the real client, and refuses a wrong password', async () => {
    expect(await s.api('POST', `/platforms/${mqttId}/test`, {})).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^Connection works – ws:\/\/127\.0\.0\.1:\d+ accepted/),
    });
    await s.api('PUT', `/platforms/${mqttId}/secrets`, { password: 'wrong' });
    expect(await s.api('POST', `/platforms/${mqttId}/test`, {})).toMatchObject({ ok: false, message: expect.stringMatching(/could not be reached/) });
    await s.api('PUT', `/platforms/${mqttId}/secrets`, { password: broker.DEMO_MQTT.password });
  });

  it('monitor checks: messages within the window, silent devices, connected clients; stores times and counts only', async () => {
    const m = (id: string, extra: Record<string, unknown>) => ({
      id,
      name: id,
      type: 'mqtt',
      platform: 'MQTT (demo)',
      topic: 'plant/+/status',
      withinMinutes: 30,
      ...extra,
    });
    await expect(s.api('POST', '/monitors', { definition: { name: 'Bad pattern', checks: [m('bad', { topic: 'plant/#/x' })] } })).rejects.toThrow(
      /no MQTT topic or pattern/,
    );
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Presses',
        failuresBeforeDown: 1,
        checks: [
          m('any', {}),
          m('each', { mode: 'each' }),
          m('clients', { topic: 'plant/press-1/status', minClients: 20 }),
          m('quiet', { topic: 'line/9/#', withinMinutes: 1 }),
        ],
      },
    });
    const statuses = async () => {
      await eng.evaluateMonitorNow(monitor.id);
      const r = await s.api('GET', `/monitors/${monitor.id}`);
      return Object.fromEntries(r.checks.map((c: any) => [c.checkId, [c.status, c.last?.message]]));
    };
    // the first evaluation starts the listener and its subscriptions
    await statuses();
    await sleep(500);
    for (const n of [1, 2, 3]) broker.publishMock(`plant/press-${n}/status`, '{"state":"running","operator":"erika@example.com"}');
    broker.publishMock('plant/press-2/temperature', '71');
    await sleep(500);
    const st = await statuses();
    expect(st.any).toEqual(['up', 'MQTT: plant/+/status – newest message 0 minutes ago']);
    // press-4 was last heard an hour ago (the demo's stored row): one of four silent
    expect(st.each).toEqual(['degraded', 'MQTT: plant/+/status – 1 of 4 silent for more than 30 minutes: plant/press-4/status']);
    expect(st.clients).toEqual(['degraded', 'MQTT: plant/press-1/status – newest message 0 minutes ago, 12 clients connected (at least 20)']);
    expect(st.quiet[0]).toBe('unknown');
    // stored: per topic the time and the count, nothing of the content
    expect(listener.flushMqtt()).toBeGreaterThanOrEqual(3);
    const { db } = await import('../src/db.js');
    const rows = db().all<any>('SELECT * FROM mqtt_topics WHERE platform_id = ? ORDER BY topic', mqttId);
    expect(rows.map((r: any) => r.topic)).toEqual(['plant/press-1/status', 'plant/press-2/status', 'plant/press-3/status', 'plant/press-4/status']);
    expect(Object.keys(rows[0]).sort()).toEqual(['last_at', 'messages', 'platform_id', 'topic']);
    expect(JSON.stringify(rows)).not.toMatch(/erika|running/);
    // devices taken away are forgotten
    expect(listener.forgetMqttTopics(mqttId, 'plant/press-4/#')).toBe(1);
    const after = await statuses();
    expect(after.each).toEqual(['up', 'MQTT: plant/+/status – all 3 topics sent within 30 minutes']);
  });
});
