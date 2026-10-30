import crypto from 'node:crypto';
import net from 'node:net';
import { BRAND, MQTT_LIMITS, mqttMatches, mqttUrl, type Platform } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, nowIso } from '../util.js';
import { assertAddressSafe, assertNetAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { getSettings } from '../settings.js';
import { getPlatform, getSecrets } from '../platforms/service.js';

/**
 * MQTT (#113): one listening connection per broker that a monitor check uses. It subscribes to the topics and patterns
 * the checks name and keeps, per topic, only when the last message came and how many came – never their content
 * (the one exception: the number in $SYS/broker/clients/connected, when a check asks for connected clients). What it
 * saw is written to mqtt_topics every minute, so silent devices are still known after a restart.
 */

interface Seen {
  lastAt: number;
  messages: number;
  dirty: boolean;
}

interface Listener {
  platformId: string;
  client: import('mqtt').MqttClient | null;
  filters: Set<string>;
  topics: Map<string, Seen>;
  clients: number | null;
  wantClients: boolean;
  listeningSince: number | null;
  error: string | null;
  usedAt: number;
  connecting: Promise<void> | null;
}

const CLIENTS_TOPIC = '$SYS/broker/clients/connected';
const listeners = new Map<string, Listener>();
let flushTimer: NodeJS.Timeout | null = null;

/** The broker named by the platform (variable url) may be reached on exactly its port; anything else needs the allow-list. */
async function assertBrokerAllowed(platform: Platform): Promise<URL> {
  const u = mqttUrl(platform.config.variables?.url);
  if (!u) throw new HttpError(400, 'The MQTT platform needs the variable url (scheme mqtts, wss, mqtt or ws, with host and port)', 'MQTT_URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || (u.protocol === 'mqtts:' ? 8883 : u.protocol === 'wss:' ? 443 : u.protocol === 'ws:' ? 80 : 1883));
  if ((getSettings().outboundPolicy ?? 'platforms') === 'platforms') await assertAddressSafe(`http://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`);
  else await assertNetAllowed(host, port, outboundContext());
  return u;
}

function options(platform: Platform, secrets: Record<string, string>) {
  const tlsOpts = {
    ...(platform.config.http?.caPem ? { ca: platform.config.http.caPem } : {}),
    ...(secrets.certificate && secrets.privateKey ? { cert: secrets.certificate, key: secrets.privateKey } : {}),
    rejectUnauthorized: !platform.config.http?.insecureTls,
  };
  return {
    clientId: `${BRAND.slug}-${crypto.randomBytes(5).toString('hex')}`,
    ...(secrets.username ? { username: secrets.username, password: secrets.password ?? '' } : {}),
    ...tlsOpts,
    connectTimeout: MQTT_LIMITS.connectTimeoutMs,
    reconnectPeriod: MQTT_LIMITS.reconnectMs,
    clean: true,
    protocolVersion: 4 as const,
  };
}

/** Connection test: connects, subscribes to nothing, disconnects. */
export async function testMqtt(platform: Platform, secrets: Record<string, string>): Promise<string> {
  const u = await assertBrokerAllowed(platform);
  const mqtt = await import('mqtt');
  const client = await mqtt.connectAsync(u.toString(), { ...options(platform, secrets), reconnectPeriod: 0 }).catch((e: Error) => {
    throw new Error(`the broker could not be reached: ${e.message}`);
  });
  await client.endAsync(true).catch(() => undefined);
  return `Connection works – ${u.protocol.replace(':', '')}://${u.host} accepted the connection`;
}

function load(l: Listener): void {
  for (const r of db().all<{ topic: string; last_at: string; messages: number }>(
    'SELECT topic, last_at, messages FROM mqtt_topics WHERE platform_id = ?',
    l.platformId,
  ))
    l.topics.set(r.topic, { lastAt: Date.parse(r.last_at), messages: Number(r.messages), dirty: false });
}

/** Writes what the listeners saw since the last flush (one row per topic). */
export function flushMqtt(): number {
  let n = 0;
  for (const l of listeners.values())
    for (const [topic, s] of l.topics) {
      if (!s.dirty) continue;
      db().run(
        'INSERT INTO mqtt_topics (platform_id, topic, last_at, messages) VALUES (?, ?, ?, ?) ON CONFLICT(platform_id, topic) DO UPDATE SET last_at = excluded.last_at, messages = excluded.messages',
        l.platformId,
        topic,
        new Date(s.lastAt).toISOString(),
        s.messages,
      );
      s.dirty = false;
      n++;
    }
  return n;
}

async function connect(l: Listener): Promise<void> {
  const platform = getPlatform(l.platformId);
  if (platform.kind !== 'mqtt') throw new HttpError(400, `"${platform.name}" is not an MQTT platform`, 'MQTT_PLATFORM');
  const u = await assertBrokerAllowed(platform);
  const mqtt = await import('mqtt');
  const client = mqtt.connect(u.toString(), options(platform, getSecrets(l.platformId)));
  l.client = client;
  client.on('connect', () => {
    l.error = null;
    l.listeningSince ??= Date.now();
    const filters = [...l.filters, ...(l.wantClients ? [CLIENTS_TOPIC] : [])];
    if (filters.length) client.subscribe(filters, { qos: 0 }, (err) => err && (l.error = `subscribing failed: ${err.message}`));
  });
  client.on('message', (topic, payload) => {
    if (topic === CLIENTS_TOPIC) {
      const n = Number(payload.subarray(0, 20).toString('utf8').trim());
      l.clients = Number.isFinite(n) ? n : null;
      return;
    }
    if (![...l.filters].some((f) => mqttMatches(f, topic))) return;
    const s = l.topics.get(topic);
    if (s) {
      s.lastAt = Date.now();
      s.messages++;
      s.dirty = true;
    } else if (l.topics.size < MQTT_LIMITS.topicsPerBroker) l.topics.set(topic, { lastAt: Date.now(), messages: 1, dirty: true });
    else l.error = `more than ${MQTT_LIMITS.topicsPerBroker} topics – narrow the patterns`;
  });
  client.on('error', (e) => (l.error = e.message.slice(0, 300)));
  client.on('offline', () => (l.error ??= 'the broker is not reachable (reconnecting)'));
  flushTimer ??= setInterval(() => {
    try {
      flushMqtt();
      closeIdle();
    } catch (err) {
      logger.warn({ err }, 'writing MQTT topics failed');
    }
  }, MQTT_LIMITS.flushMs);
  flushTimer.unref();
}

/** Listeners no check asked about for a while are closed. */
function closeIdle(now = Date.now()): void {
  for (const [id, l] of listeners)
    if (now - l.usedAt > MQTT_LIMITS.idleCloseMs) {
      l.client?.end(true);
      listeners.delete(id);
    }
}

/**
 * What the listener of a broker saw for a topic or pattern; starts the listener (and the subscription) when needed.
 * `listeningSince`: when the listener connected (null: not connected yet).
 */
export async function mqttState(
  platformId: string,
  filter: string,
  wantClients = false,
): Promise<{ topics: { topic: string; lastAt: number; messages: number }[]; clients: number | null; listeningSince: number | null; error: string | null }> {
  if (!vault().unlocked) return { topics: [], clients: null, listeningSince: null, error: 'the vault is locked' };
  let l = listeners.get(platformId);
  if (!l) {
    l = {
      platformId,
      client: null,
      filters: new Set(),
      topics: new Map(),
      clients: null,
      wantClients,
      listeningSince: null,
      error: null,
      usedAt: Date.now(),
      connecting: null,
    };
    listeners.set(platformId, l);
    load(l);
  }
  l.usedAt = Date.now();
  const add = !l.filters.has(filter) || (wantClients && !l.wantClients);
  l.filters.add(filter);
  l.wantClients ||= wantClients;
  if (!l.client && !l.connecting)
    l.connecting = connect(l)
      .catch((e: Error) => {
        l!.error = e.message.slice(0, 300);
        l!.client = null;
      })
      .finally(() => (l!.connecting = null));
  else if (add && l.client?.connected) l.client.subscribe([filter, ...(wantClients ? [CLIENTS_TOPIC] : [])], { qos: 0 });
  if (l.connecting) await Promise.race([l.connecting, new Promise((r) => setTimeout(r, 2000))]);
  const topics = [...l.topics]
    .filter(([t]) => mqttMatches(filter, t))
    .map(([topic, s]) => ({ topic, lastAt: s.lastAt, messages: s.messages }))
    .sort((a, b) => a.topic.localeCompare(b.topic));
  return { topics, clients: l.clients, listeningSince: l.listeningSince, error: l.error };
}

/** Tests and shutdown: close every listener (after writing what they saw). */
export async function closeMqtt(): Promise<void> {
  flushMqtt();
  await Promise.all([...listeners.values()].map((l) => l.client?.endAsync(true).catch(() => undefined)));
  listeners.clear();
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}

/** Forget a broker's topics (e.g. devices taken away): rows and memory. */
export function forgetMqttTopics(platformId: string, filter: string): number {
  const l = listeners.get(platformId);
  const rows = db()
    .all<{ topic: string }>('SELECT topic FROM mqtt_topics WHERE platform_id = ?', platformId)
    .filter((r) => mqttMatches(filter, r.topic));
  for (const r of rows) {
    db().run('DELETE FROM mqtt_topics WHERE platform_id = ? AND topic = ?', platformId, r.topic);
    l?.topics.delete(r.topic);
  }
  return rows.length;
}

export const mqttNow = nowIso;
