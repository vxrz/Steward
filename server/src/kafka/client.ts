import crypto from 'node:crypto';
import net from 'node:net';
import { BRAND, bootstrapList, KAFKA_LIMITS, KAFKA_TOPIC_CONFIGS, type KafkaSasl, type Platform } from '@sm/shared';
import { config } from '../config.js';
import { assertAddressSafe, assertNetAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { getSettings } from '../settings.js';
import { HttpError } from '../util.js';

/**
 * What Steward reads from a Kafka cluster (#112), behind one small interface: the native client (@platformatic/kafka,
 * pure JavaScript, loaded only when a Kafka platform is used) and, in demo mode, the simulated cluster of
 * mock/mockKafka.ts. Read-only: no topic, group or offset is ever changed; "peek" reads a few messages with a
 * throw-away consumer group (steward-peek-…) that commits nothing.
 */

export interface TopicInfo {
  name: string;
  partitions: number;
  replicationFactor: number | null;
  configs: Record<string, string>;
}

export interface PartitionEnd {
  partition: number;
  /** end offset (next offset to be written) */
  end: number;
}

export interface GroupInfo {
  group: string;
  state: string;
  /** committed offsets per partition of the topic asked for */
  committed: Map<number, number>;
}

export interface RawMessage {
  partition: number;
  offset: bigint;
  timestamp: bigint | null;
  key: Buffer | null;
  value: Buffer | null;
  headers: string[];
}

export interface KafkaReader {
  listTopics(): Promise<string[]>;
  topic(name: string): Promise<TopicInfo | null>;
  ends(topic: string): Promise<PartitionEnd[]>;
  /** Time of the newest message (ms), null when the broker cannot say (before Kafka 3.0) */
  newest(topic: string): Promise<number | null>;
  /** Consumer groups with committed offsets on the topic (all groups, or the ones named) */
  groups(topic: string, only?: string[]): Promise<GroupInfo[]>;
  /** The last `count` messages over all partitions */
  peek(topic: string, count: number): Promise<RawMessage[]>;
  close(): Promise<void>;
}

const num = (v: bigint | number | string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/** The demo cluster's bootstrap address: only in demo mode, never resolved. */
export const DEMO_KAFKA_BOOTSTRAP = 'kafka.demo.invalid:9092';

interface Opened {
  reader: KafkaReader;
}

/**
 * The bootstrap servers a platform declares may be reached on exactly their port (no other port of those hosts); so may
 * the brokers the cluster advertises when they are in the same domain as a bootstrap server (Confluent Cloud:
 * pkc-….confluent.cloud → b0-pkc-….confluent.cloud). Everything else needs the outbound allow-list. Private and
 * metadata addresses are refused unless allow-listed.
 */
async function assertBrokerAllowed(platform: Platform, host: string, port: number): Promise<void> {
  const declared = bootstrapList(platform.config.variables?.bootstrap);
  const settings = getSettings();
  const domainOf = (h: string) => h.split('.').slice(1).join('.');
  const sameDomain = declared.some((d) => !net.isIP(d.host) && domainOf(d.host).split('.').length >= 2 && host.endsWith(`.${domainOf(d.host)}`));
  const isDeclared = declared.some((d) => d.host.toLowerCase() === host.toLowerCase() && d.port === port);
  if ((settings.outboundPolicy ?? 'platforms') === 'platforms' && (isDeclared || sameDomain)) {
    await assertAddressSafe(`http://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`);
    return;
  }
  await assertNetAllowed(host, port, outboundContext());
}

function sasl(platform: Platform, secrets: Record<string, string>) {
  const mech = String(platform.config.variables?.sasl ?? 'plain').toLowerCase() as KafkaSasl;
  if (mech === 'none') return undefined;
  if (mech === 'oauthbearer') {
    const ext = Object.fromEntries(
      [
        ['logicalCluster', platform.config.variables?.logicalCluster],
        ['identityPoolId', platform.config.variables?.identityPoolId],
      ].filter(([, v]) => !!v) as [string, string][],
    );
    return {
      mechanism: 'OAUTHBEARER' as const,
      token: () => oauthToken(platform, secrets),
      ...(Object.keys(ext).length ? { oauthBearerExtensions: ext } : {}),
    };
  }
  if (!secrets.username || !secrets.password)
    throw new HttpError(400, 'The Kafka platform needs an API key (username) and secret (password)', 'KAFKA_CREDENTIALS');
  return {
    mechanism: mech === 'plain' ? ('PLAIN' as const) : mech === 'scram-sha-256' ? ('SCRAM-SHA-256' as const) : ('SCRAM-SHA-512' as const),
    username: secrets.username,
    password: secrets.password,
  };
}

/** OAUTHBEARER: a client-credentials token from the identity provider (variable tokenUrl, secrets clientId / clientSecret). */
async function oauthToken(platform: Platform, secrets: Record<string, string>): Promise<string> {
  const url = String(platform.config.variables?.tokenUrl ?? '');
  if (!/^https:\/\//.test(url) || !secrets.clientId || !secrets.clientSecret)
    throw new HttpError(400, 'OAUTHBEARER needs the variable tokenUrl (https) and the secrets clientId and clientSecret', 'KAFKA_OAUTH');
  const { assertOutboundAllowed } = await import('../platforms/outbound.js');
  await assertOutboundAllowed(url, outboundContext());
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(KAFKA_LIMITS.timeoutMs),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${secrets.clientId}:${secrets.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      ...(platform.config.variables?.scope ? { scope: String(platform.config.variables.scope) } : {}),
    }),
  });
  const j = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !j?.access_token)
    throw new HttpError(502, `The identity provider answered HTTP ${res.status} without a token`, 'KAFKA_OAUTH_TOKEN', { status: res.status });
  return j.access_token;
}

async function openNative(platform: Platform, secrets: Record<string, string>): Promise<KafkaReader> {
  const brokers = bootstrapList(platform.config.variables?.bootstrap);
  if (!brokers.length) throw new HttpError(400, 'The Kafka platform names no bootstrap servers (variable bootstrap, host:port)', 'KAFKA_BOOTSTRAP');
  for (const b of brokers) await assertBrokerAllowed(platform, b.host, b.port);
  const k = await import('@platformatic/kafka');
  const tls = String(platform.config.variables?.tls ?? 'true') !== 'false';
  const base = {
    clientId: `${BRAND.slug}-reader`,
    bootstrapBrokers: brokers.map((b) => `${b.host}:${b.port}`),
    connectTimeout: KAFKA_LIMITS.timeoutMs,
    requestTimeout: KAFKA_LIMITS.timeoutMs,
    retries: 1,
    ...(tls
      ? { tls: { ...(platform.config.http?.caPem ? { ca: platform.config.http.caPem } : {}), rejectUnauthorized: !platform.config.http?.insecureTls } }
      : {}),
    ...(sasl(platform, secrets) ? { sasl: sasl(platform, secrets) } : {}),
  };
  const admin = new k.Admin(base);
  const consumers: { close: (force?: boolean) => Promise<void> }[] = [];
  // the brokers the cluster advertises are checked before Steward asks them anything
  const checked = (async () => {
    const md = await admin.metadata({ topics: [] });
    for (const b of md.brokers.values()) await assertBrokerAllowed(platform, b.host, b.port);
  })();
  // awaited by every call; a reader closed without a call must not leave an unhandled rejection behind
  checked.catch(() => undefined);
  const ready = () => checked;
  const latest = async (topic: string, timestamp: bigint) => {
    await ready();
    const md = await admin.metadata({ topics: [topic] });
    const t = md.topics.get(topic);
    if (!t) return [];
    const r = await admin.listOffsets({ topics: [{ name: topic, partitions: t.partitions.map((_p, i) => ({ partitionIndex: i, timestamp })) }] });
    return r[0]?.partitions ?? [];
  };
  return {
    async listTopics() {
      await ready();
      return admin.listTopics();
    },
    async topic(name) {
      await ready();
      const topics = await admin.listTopics();
      if (!topics.includes(name)) return null;
      const md = await admin.metadata({ topics: [name] });
      const t = md.topics.get(name)!;
      const cfg = await admin.describeConfigs({
        resources: [{ resourceType: k.ConfigResourceTypes.TOPIC, resourceName: name, configurationKeys: [...KAFKA_TOPIC_CONFIGS] }],
      });
      const configs: Record<string, string> = {};
      for (const c of cfg[0]?.configs ?? []) if (c.value !== null && !c.isSensitive) configs[c.name] = String(c.value);
      const first = t.partitions[0] as { replicas?: number[] } | undefined;
      return { name, partitions: t.partitionsCount, replicationFactor: first?.replicas?.length ?? null, configs };
    },
    async ends(topic) {
      return (await latest(topic, -1n)).map((p) => ({ partition: p.partitionIndex, end: num(p.offset) }));
    },
    async newest(topic) {
      try {
        const ps = await latest(topic, -3n); // MAX_TIMESTAMP (Kafka 3.0+)
        const ts = ps.map((p) => num(p.timestamp)).filter((x) => x > 0);
        return ts.length ? Math.max(...ts) : null;
      } catch {
        return null;
      }
    },
    async groups(topic, only) {
      await ready();
      const all = only?.length ? only : [...(await admin.listGroups()).keys()].slice(0, KAFKA_LIMITS.groups);
      if (!all.length) return [];
      const desc = await admin.describeGroups({ groups: all });
      const offsets = await admin.listConsumerGroupOffsets({ groups: all });
      const out: GroupInfo[] = [];
      for (const g of offsets) {
        const t = g.topics.find((x) => x.name === topic);
        if (!t) continue;
        out.push({
          group: g.groupId,
          state: String(desc.get(g.groupId)?.state ?? 'Unknown'),
          committed: new Map(t.partitions.filter((p) => num(p.committedOffset) >= 0).map((p) => [p.partitionIndex, num(p.committedOffset)])),
        });
      }
      return out;
    },
    async peek(topic, count) {
      await ready();
      const ends = await latest(topic, -1n);
      const starts = await latest(topic, -2n);
      const offsets = ends
        .map((e) => {
          const s = starts.find((x) => x.partitionIndex === e.partitionIndex);
          const from = e.offset - BigInt(count) < (s?.offset ?? 0n) ? (s?.offset ?? 0n) : e.offset - BigInt(count);
          return { topic, partition: e.partitionIndex, offset: from, end: e.offset };
        })
        .filter((o) => o.end > o.offset);
      if (!offsets.length) return [];
      const consumer = new k.Consumer({ ...base, groupId: `${BRAND.slug}-peek-${crypto.randomBytes(6).toString('hex')}`, autocommit: false });
      consumers.push(consumer);
      const stream = await consumer.consume({
        topics: [topic],
        mode: 'manual',
        offsets: offsets.map(({ topic: t, partition, offset }) => ({ topic: t, partition, offset })),
        autocommit: false,
        maxBytes: KAFKA_LIMITS.peekBytes * count * 4,
        maxWaitTime: 2000,
      });
      const out: RawMessage[] = [];
      const deadline = Date.now() + KAFKA_LIMITS.timeoutMs;
      try {
        for await (const m of stream as AsyncIterable<{
          partition: number;
          offset: bigint;
          timestamp: bigint;
          key: Buffer | null;
          value: Buffer | null;
          headers: Map<Buffer, Buffer>;
        }>) {
          out.push({
            partition: m.partition,
            offset: m.offset,
            timestamp: m.timestamp ?? null,
            key: m.key,
            value: m.value,
            headers: [...(m.headers?.keys() ?? [])].map(String),
          });
          if (out.length >= offsets.reduce((n, o) => n + Number(o.end - o.offset), 0) || out.length >= count * offsets.length || Date.now() > deadline) break;
        }
      } finally {
        await (stream as { close?: () => Promise<void> }).close?.().catch(() => undefined);
      }
      return out.sort((a, b) => Number((b.timestamp ?? 0n) - (a.timestamp ?? 0n))).slice(0, count);
    },
    async close() {
      await Promise.all([admin.close().catch(() => undefined), ...consumers.map((c) => c.close(true).catch(() => undefined))]);
    },
  };
}

/** Opens a reader for the platform; callers close it (withKafka does). */
export async function openKafka(platform: Platform, secrets: Record<string, string>): Promise<Opened> {
  if (config.demo && String(platform.config.variables?.bootstrap ?? '').trim() === DEMO_KAFKA_BOOTSTRAP) {
    const { demoKafkaReader } = await import('../mock/mockKafka.js');
    return { reader: demoKafkaReader() };
  }
  return { reader: await openNative(platform, secrets) };
}

export async function withKafka<T>(platform: Platform, secrets: Record<string, string>, fn: (k: KafkaReader) => Promise<T>): Promise<T> {
  const { reader } = await openKafka(platform, secrets);
  try {
    return await fn(reader);
  } finally {
    await reader.close();
  }
}

/** A readable message for errors of the client ("connect ECONNREFUSED", SASL failures …). */
export function kafkaError(e: unknown): string {
  const err = e as Error & { code?: string; errors?: Error[]; cause?: Error };
  const inner = err.errors?.[0]?.message ?? err.cause?.message;
  return `${err.message}${inner && !err.message.includes(inner) ? `: ${inner}` : ''}`.slice(0, 400);
}
