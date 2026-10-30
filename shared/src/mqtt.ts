/**
 * MQTT (#113): monitor checks on brokers (Mosquitto, EMQX, HiveMQ, …). A platform of kind mqtt names the broker in the
 * variable `url` (scheme mqtts or wss; mqtt or ws without TLS); credentials username/password or a client certificate.
 */

export const MQTT_KIND = 'mqtt';

export const MQTT_LIMITS = {
  /** Topics one listener keeps at most (per broker) */
  topicsPerBroker: 10_000,
  /** What the listeners saw is written this often */
  flushMs: 60_000,
  /** A listener no check asked about for this long is closed */
  idleCloseMs: 60 * 60_000,
  connectTimeoutMs: 15_000,
  reconnectMs: 10_000,
} as const;

/** The broker URL of a platform; null when its scheme is not mqtt, mqtts, ws or wss, or it has no host. */
export function mqttUrl(v: unknown): URL | null {
  try {
    const u = new URL(String(v ?? '').trim());
    if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

/** Does a topic match an MQTT filter (+ one level, # the rest)? Topics starting with $ only match filters that name them. */
export function mqttMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  if (topic.startsWith('$') && !filter.startsWith('$')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** A valid subscription filter: + and # only as whole levels, # only last. */
export function validMqttFilter(filter: string): boolean {
  if (!filter || filter.length > 500 || filter.includes('\u0000')) return false;
  const levels = filter.split('/');
  return levels.every((l, i) => (l.includes('+') || l.includes('#') ? l === '+' || (l === '#' && i === levels.length - 1) : true));
}
