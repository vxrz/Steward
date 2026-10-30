/**
 * Kafka (#112): service-level checks on the topics an application owns – not a data viewer. A platform of kind kafka
 * names the bootstrap servers (variable `bootstrap`), the SASL mechanism and, as its base URL, an optional Schema
 * Registry. Steward reads topic settings, offsets, consumer groups and schema versions; message content only when the
 * platform allows "peek" and a platform administrator asks for it.
 */

export const KAFKA_KIND = 'kafka';

export const KAFKA_SASL = ['plain', 'scram-sha-256', 'scram-sha-512', 'oauthbearer', 'none'] as const;
export type KafkaSasl = (typeof KAFKA_SASL)[number];

/** Topic settings Steward reads and processes check against standards. */
export const KAFKA_TOPIC_CONFIGS = [
  'cleanup.policy',
  'retention.ms',
  'retention.bytes',
  'min.insync.replicas',
  'max.message.bytes',
  'compression.type',
] as const;

export interface KafkaGroupLag {
  group: string;
  /** Stable, Empty, PreparingRebalance, Dead … */
  state: string;
  /** Sum over the partitions of the topic: end offset − committed offset (partitions without a commit count fully) */
  lag: number;
  /** Partitions the group has committed offsets for */
  partitions: number;
}

/** What Steward read from a topic (#112), kept on the component. */
export interface TopicReadout {
  readAt: string;
  /** null: read; else why not */
  error: string | null;
  partitions: number;
  replicationFactor: number | null;
  /** The settings of KAFKA_TOPIC_CONFIGS that are set (also the broker defaults the cluster reports) */
  configs: Record<string, string>;
  /** Sum of the end offsets of all partitions: messages written so far (minus compaction) */
  endOffset: number;
  /** Time of the newest message (broker ≥ 3.0), null when unknown */
  lastMessageAt: string | null;
  groups: KafkaGroupLag[];
  /** Schema Registry, subject <topic>-value; null: no registry or no subject */
  schema: { subject: string; version: number; id: number; type: string; versions: number } | null;
}

/** A message read by "peek" – size-capped, fields that look sensitive hidden. */
export interface PeekedMessage {
  partition: number;
  offset: string;
  timestamp: string | null;
  key: string | null;
  /** The value as text (JSON pretty-printed with sensitive fields hidden), cut at KAFKA_LIMITS.peekBytes */
  value: string;
  truncated: boolean;
  headers: string[];
}

export const KAFKA_LIMITS = {
  /** A topic component is read again after this many hours (the job), or on "Read now" */
  refreshHours: 6,
  /** Consumer groups looked at per cluster */
  groups: 500,
  /** Messages a peek returns at most, and bytes per message */
  peekMessages: 5,
  peekBytes: 4096,
  /** Timeout of one read (ms) */
  timeoutMs: 20_000,
} as const;

/** A Kafka topic name (Kafka's own rule). */
export const KAFKA_TOPIC_RE = /^[A-Za-z0-9._-]{1,249}$/;

/** Bootstrap servers: "host:port, host:port" → entries; invalid entries left out. */
export function bootstrapList(v: string | undefined | null): { host: string; port: number }[] {
  return String(v ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((e) => {
      const m = /^(\[[0-9a-f:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/i.exec(e);
      return m ? { host: m[1]!.replace(/^\[|\]$/g, ''), port: Number(m[2]) } : null;
    })
    .filter((x): x is { host: string; port: number } => !!x && x.port > 0 && x.port < 65536);
}
