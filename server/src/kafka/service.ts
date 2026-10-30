import { isSensitiveKey, KAFKA_KIND, KAFKA_LIMITS, KAFKA_TOPIC_RE, type KafkaGroupLag, type PeekedMessage, type Platform, type TopicReadout } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, parseJson } from '../util.js';
import { platformRequest } from '../platforms/http.js';
import { platformFor } from '../monitors/platforms.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { kafkaError, withKafka, type GroupInfo, type KafkaReader, type PartitionEnd } from './client.js';

/**
 * Kafka topics of applications (#112): a component of type kafka-topic names its Kafka platform and the topic.
 * Steward reads the topic's settings, partitions, the newest message's time, the consumer groups and their lag, and
 * the subject <topic>-value in the Schema Registry – never message content (that is "peek", below).
 */

export function assertTopic(name: string): void {
  if (!KAFKA_TOPIC_RE.test(name) || name === '.' || name === '..')
    throw new HttpError(400, 'A Kafka topic name has letters, digits, ".", "_" and "-" (at most 249)', 'KAFKA_TOPIC_NAME', { name: name.slice(0, 100) });
}

/** Lag of a group on a topic: end − committed per partition; partitions without a commit count fully. */
export function lagOf(ends: PartitionEnd[], g: GroupInfo): KafkaGroupLag {
  let lag = 0;
  for (const e of ends) lag += Math.max(0, e.end - (g.committed.get(e.partition) ?? 0));
  return { group: g.group, state: g.state, lag, partitions: g.committed.size };
}

// ---------- Schema Registry ----------

/** GET on the Schema Registry (the platform's base URL; with auth basic, registryKey / registrySecret). 404 → null. */
export async function registryGet(platform: Platform, secrets: Record<string, string>, path: string): Promise<unknown> {
  if (!platform.baseUrl) return null;
  // the platform's auth (basic: registryKey / registrySecret on Kafka platforms, see platforms/http.ts)
  const headers: Record<string, string> = { accept: 'application/vnd.schemaregistry.v1+json, application/json' };
  const r = await platformRequest(
    platform,
    secrets,
    { method: 'GET', url: path, headers, maxResponseBytes: 2 * 1024 * 1024, noRedirects: true },
    AbortSignal.timeout(KAFKA_LIMITS.timeoutMs),
  );
  if (r.ok) return r.body;
  if (r.status === 404) return null;
  throw new Error(`the Schema Registry answered HTTP ${r.status}${r.status === 401 ? ' – check registryKey and registrySecret' : ''}`);
}

export async function schemaOf(platform: Platform, secrets: Record<string, string>, topic: string): Promise<TopicReadout['schema']> {
  const subject = `${topic}-value`;
  const latest = (await registryGet(platform, secrets, `/subjects/${encodeURIComponent(subject)}/versions/latest`)) as {
    version?: number;
    id?: number;
    schemaType?: string;
  } | null;
  if (!latest?.version) return null;
  const versions = (await registryGet(platform, secrets, `/subjects/${encodeURIComponent(subject)}/versions`)) as number[] | null;
  return {
    subject,
    version: Number(latest.version),
    id: Number(latest.id ?? 0),
    type: String(latest.schemaType ?? 'AVRO'),
    versions: Array.isArray(versions) ? versions.length : 1,
  };
}

// ---------- reading a topic ----------

export async function readTopic(platform: Platform, secrets: Record<string, string>, topic: string): Promise<Omit<TopicReadout, 'readAt' | 'error'>> {
  assertTopic(topic);
  if (platform.kind !== KAFKA_KIND) throw new HttpError(400, 'Choose a Kafka platform', 'COMPONENT_TOPIC_PLATFORM');
  const fromCluster = await withKafka(platform, secrets, async (k: KafkaReader) => {
    const info = await k.topic(topic);
    if (!info) throw new Error(`no topic "${topic}" (or the service account may not describe it)`);
    const ends = await k.ends(topic);
    const newest = await k.newest(topic);
    const groups = (await k.groups(topic)).map((g) => lagOf(ends, g)).sort((a, b) => b.lag - a.lag || a.group.localeCompare(b.group));
    return { info, ends, newest, groups };
  });
  let schema: TopicReadout['schema'] = null;
  try {
    schema = await schemaOf(platform, secrets, topic);
  } catch (e) {
    logger.warn({ err: e, topic }, 'reading the Schema Registry failed');
  }
  return {
    partitions: fromCluster.info.partitions,
    replicationFactor: fromCluster.info.replicationFactor,
    configs: fromCluster.info.configs,
    endOffset: fromCluster.ends.reduce((n, e) => n + e.end, 0),
    lastMessageAt: fromCluster.newest ? new Date(fromCluster.newest).toISOString() : null,
    groups: fromCluster.groups,
    schema,
  };
}

interface Row {
  id: string;
  application_id: string;
  name: string;
  environment: string;
  platform_id: string | null;
  updated_by: string;
  topic_state?: string | null;
}

/** Reads the topic of a component now, with the rights of `actor` on the Kafka platform; a failed read keeps the last one and records why. */
export async function refreshTopic(componentId: string, actor: string, now = Date.now()): Promise<TopicReadout> {
  const c = db().get<Row>("SELECT * FROM application_components WHERE id = ? AND type = 'kafka-topic'", componentId);
  if (!c) throw new HttpError(404, `Component ${componentId} not found`, 'COMPONENT_NOT_FOUND', { id: componentId });
  if (!c.platform_id) throw new HttpError(400, 'Choose the Kafka platform of the topic first', 'COMPONENT_TOPIC_REQUIRED');
  const at = new Date(now).toISOString();
  const before = parseJson<TopicReadout | null>(c.topic_state ?? null, null);
  let readout: TopicReadout;
  try {
    const { platform, secrets } = platformFor(actor, c.platform_id);
    readout = { readAt: at, error: null, ...(await readTopic(platform, secrets, c.name)) };
  } catch (e) {
    readout = {
      ...(before ?? { partitions: 0, replicationFactor: null, configs: {}, endOffset: 0, lastMessageAt: null, groups: [], schema: null }),
      readAt: at,
      error: kafkaError(e),
    };
  }
  db().run('UPDATE application_components SET topic_state = ? WHERE id = ?', JSON.stringify(readout), componentId);
  // a new schema version is worth a line in the application's history
  if (!readout.error && readout.schema && before?.schema && readout.schema.version !== before.schema.version)
    audit({
      action: 'application.topic_schema_changed',
      entityType: 'application',
      entityId: c.application_id,
      actor,
      summary: `Schema of the topic "${c.name}" changed: ${readout.schema.subject} version ${before.schema.version} → ${readout.schema.version}`,
      details: { componentId, subject: readout.schema.subject, from: before.schema.version, to: readout.schema.version, id: readout.schema.id },
    });
  return readout;
}

export async function runKafkaJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const rows = db().all<Row>(
    `SELECT c.* FROM application_components c JOIN applications a ON a.id = c.application_id
     WHERE c.type = 'kafka-topic' AND c.platform_id IS NOT NULL AND a.archived = 0`,
  );
  let n = 0;
  for (const r of rows) {
    const last = parseJson<TopicReadout | null>(r.topic_state ?? null, null);
    if (last && now - Date.parse(last.readAt) < KAFKA_LIMITS.refreshHours * 3_600_000) continue;
    try {
      await refreshTopic(r.id, r.updated_by, now);
      n++;
    } catch (err) {
      logger.warn({ err, component: r.id }, 'reading a Kafka topic failed');
    }
  }
  return n;
}

/** Connection test: the cluster answers and lists its topics; the Schema Registry, when one is set, answers too. */
export async function testKafka(platform: Platform, secrets: Record<string, string>): Promise<string> {
  let topics: number;
  try {
    topics = await withKafka(platform, secrets, async (k) => (await k.listTopics()).length);
  } catch (e) {
    throw new Error(`Kafka could not be reached: ${kafkaError(e)}`);
  }
  let registry = '';
  if (platform.baseUrl) {
    const subjects = await registryGet(platform, secrets, '/subjects');
    registry = `, Schema Registry with ${Array.isArray(subjects) ? subjects.length : 0} subjects`;
  }
  return `Connection works – ${topics} topics${registry}`;
}

// ---------- peek ----------

/** Keys that hold personal data or secrets: their values are hidden in peeked messages. */
const PERSONAL =
  /(e-?mail|phone|mobile|iban|bic|card|cvv|ssn|tax.?id|birth|passport|address|street|zip|postcode|first.?name|last.?name|full.?name|^name$|ip.?addr)/i;
const PATTERNS: [RegExp, string][] = [
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, '***IBAN***'],
  [/\b(?:\d[ -]?){13,19}\b/g, '***number***'],
];

/** E-mail addresses → ***@*** – a scan over the words, not a regular expression (linear on any input). */
function maskEmails(s: string): string {
  return s
    .split(/([\s"',;<>()[\]{}]+)/)
    .map((w) => {
      const at = w.indexOf('@');
      return at > 0 && w.indexOf('.', at) > at + 1 && w.indexOf('@', at + 1) < 0 ? '***@***' : w;
    })
    .join('');
}

/** Hides sensitive fields (by key) and patterns (e-mail, IBAN, card numbers) in a message value. */
export function hideSensitive(v: unknown, depth = 0): unknown {
  if (depth > 20) return '…';
  if (typeof v === 'string') return PATTERNS.reduce((s, [re, to]) => s.replace(re, to), maskEmails(v));
  if (Array.isArray(v)) return v.map((x) => hideSensitive(x, depth + 1));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, isSensitiveKey(k) || PERSONAL.test(k) ? '***' : hideSensitive(x, depth + 1)]),
    );
  return v;
}

/** Control characters other than tab and line breaks: binary data (e.g. Avro), not text. */
function isBinary(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) return true;
  }
  return false;
}

function render(buf: Buffer | null): { text: string; truncated: boolean } {
  if (!buf) return { text: '', truncated: false };
  const raw = buf.subarray(0, KAFKA_LIMITS.peekBytes * 4).toString('utf8');
  let text: string;
  try {
    text = JSON.stringify(hideSensitive(JSON.parse(raw)), null, 2);
  } catch {
    // not JSON: shown as text with the patterns hidden; binary (e.g. Avro) as a length only
    text = isBinary(raw) ? `(binary, ${buf.length} bytes)` : (hideSensitive(raw) as string);
  }
  const truncated = text.length > KAFKA_LIMITS.peekBytes || buf.length > KAFKA_LIMITS.peekBytes * 4;
  return { text: text.slice(0, KAFKA_LIMITS.peekBytes), truncated };
}

/**
 * The newest messages of a topic, for troubleshooting: only when the platform allows it (variable peek = on), only for
 * who may manage the platform, at most KAFKA_LIMITS.peekMessages of KAFKA_LIMITS.peekBytes, sensitive fields hidden,
 * every read audited.
 */
export async function peekTopic(platformId: string, topic: string, count: number, actor: string, canManage: boolean): Promise<PeekedMessage[]> {
  assertTopic(topic);
  const platform = getPlatform(platformId);
  if (platform.kind !== KAFKA_KIND) throw new HttpError(400, 'Choose a Kafka platform', 'COMPONENT_TOPIC_PLATFORM');
  if (String(platform.config.variables?.peek ?? 'off') !== 'on')
    throw new HttpError(403, 'Reading messages is off for this platform (variable peek = on turns it on)', 'KAFKA_PEEK_OFF');
  if (!canManage) throw new HttpError(403, 'Only who may manage the platform reads messages', 'KAFKA_PEEK_FORBIDDEN');
  const n = Math.max(1, Math.min(KAFKA_LIMITS.peekMessages, Math.floor(count) || KAFKA_LIMITS.peekMessages));
  let raw;
  try {
    raw = await withKafka(platform, getSecrets(platformId), (k) => k.peek(topic, n));
  } catch (e) {
    throw new HttpError(502, `Kafka could not be read: ${kafkaError(e)}`, 'KAFKA_READ', { detail: kafkaError(e) });
  }
  const out = raw.slice(0, n).map((m) => {
    const v = render(m.value);
    return {
      partition: m.partition,
      offset: m.offset.toString(),
      timestamp: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : null,
      key: m.key ? (hideSensitive(m.key.subarray(0, 200).toString('utf8')) as string) : null,
      value: v.text,
      truncated: v.truncated,
      headers: m.headers.slice(0, 20),
    };
  });
  audit({
    action: 'kafka.messages_read',
    entityType: 'platform',
    entityId: platformId,
    actor,
    summary: `${out.length} messages of the topic "${topic}" read on "${platform.name}" (sensitive fields hidden)`,
    details: { topic, count: out.length, offsets: out.map((m) => `${m.partition}:${m.offset}`) },
  });
  return out;
}
