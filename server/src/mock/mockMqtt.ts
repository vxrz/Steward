import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import mqttPacket from 'mqtt-packet';
import { WebSocketServer, type WebSocket } from 'ws';
import { mqttMatches } from '@sm/shared';

/**
 * A small MQTT broker for demo mode and tests (#113), speaking MQTT 3.1.1 over WebSocket at /mock/mqtt on Steward's own
 * port – so the real client (MQTT.js) is exercised end to end. QoS 0 only; retained messages; username/password
 * DEMO_MQTT. The demo simulator publishes the status of four presses (press-4 stays silent) and
 * $SYS/broker/clients/connected.
 */

export const DEMO_MQTT = { username: 'steward', password: 'demo-mqtt-password' };

interface Session {
  ws: WebSocket;
  filters: Set<string>;
}

const sessions = new Set<Session>();
const retained = new Map<string, Buffer>();
let wss: WebSocketServer | null = null;
let simulator: NodeJS.Timeout | null = null;

const send = (s: Session, packet: mqttPacket.Packet) => {
  if (s.ws.readyState === s.ws.OPEN) s.ws.send(mqttPacket.generate(packet));
};

/** Publishes to every subscribed session (and keeps a retained message). */
export function publishMock(topic: string, payload: string | Buffer, retain = false): void {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (retain) retained.set(topic, buf);
  for (const s of sessions)
    if ([...s.filters].some((f) => mqttMatches(f, topic)))
      send(s, { cmd: 'publish', topic, payload: buf, qos: 0, dup: false, retain: false } as mqttPacket.IPublishPacket);
}

export function resetMqtt(): void {
  retained.clear();
}

function onConnection(ws: WebSocket): void {
  const s: Session = { ws, filters: new Set() };
  const parser = mqttPacket.parser({ protocolVersion: 4 });
  let authed = false;
  parser.on('packet', (p: mqttPacket.Packet) => {
    if (p.cmd === 'connect') {
      const c = p as mqttPacket.IConnectPacket;
      authed = c.username === DEMO_MQTT.username && String(c.password ?? '') === DEMO_MQTT.password;
      send(s, { cmd: 'connack', returnCode: authed ? 0 : 4, sessionPresent: false } as mqttPacket.IConnackPacket);
      if (!authed) ws.close();
      else sessions.add(s);
    } else if (!authed) ws.close();
    else if (p.cmd === 'subscribe') {
      const sub = p as mqttPacket.ISubscribePacket;
      for (const x of sub.subscriptions) s.filters.add(x.topic);
      send(s, { cmd: 'suback', messageId: sub.messageId, granted: sub.subscriptions.map(() => 0) } as mqttPacket.ISubackPacket);
      for (const [topic, payload] of retained)
        if (sub.subscriptions.some((x) => mqttMatches(x.topic, topic)))
          send(s, { cmd: 'publish', topic, payload, qos: 0, dup: false, retain: true } as mqttPacket.IPublishPacket);
    } else if (p.cmd === 'unsubscribe') {
      const u = p as mqttPacket.IUnsubscribePacket;
      for (const t of u.unsubscriptions) s.filters.delete(t);
      send(s, { cmd: 'unsuback', messageId: u.messageId } as mqttPacket.IUnsubackPacket);
    } else if (p.cmd === 'publish') {
      const m = p as mqttPacket.IPublishPacket;
      publishMock(m.topic, m.payload as Buffer, m.retain);
    } else if (p.cmd === 'pingreq') send(s, { cmd: 'pingresp' });
    else if (p.cmd === 'disconnect') ws.close();
  });
  parser.on('error', () => ws.close());
  ws.on('message', (data: Buffer) => parser.parse(data));
  ws.on('close', () => sessions.delete(s));
}

/** The demo plant: presses 1–3 report every 20 seconds, press 4 reported once an hour ago and then went silent. */
export function startMqttSimulator(): void {
  if (simulator) return;
  publishMock('$SYS/broker/clients/connected', '12', true);
  const tick = () => {
    for (const n of [1, 2, 3]) publishMock(`plant/press-${n}/status`, JSON.stringify({ state: 'running', at: new Date().toISOString() }));
  };
  tick();
  simulator = setInterval(tick, 20_000);
  simulator.unref();
}

export async function mockMqtt(app: FastifyInstance): Promise<void> {
  wss ??= new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  wss.on('connection', onConnection);
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!(req.url ?? '').split('?')[0]!.endsWith('/mock/mqtt')) return;
    wss!.handleUpgrade(req, socket, head, (ws) => wss!.emit('connection', ws, req));
  });
  // upgraded WebSocket connections would keep the server from closing
  app.addHook('preClose', async () => {
    if (simulator) clearInterval(simulator);
    simulator = null;
    for (const s of sessions) s.ws.terminate();
    sessions.clear();
  });
}
