import type { ConnectTask } from './kafkaConnect.js';

/**
 * Confluent Cloud as a platform of its own (0.14.0, #123, docs/CONFLUENT.md): besides the access reviews (role
 * bindings, ACLs) and the Costs API, Steward reads – read-only, with the Cloud API key – the organisation's
 * environments, Kafka clusters, Schema Registry clusters, service accounts and the metadata of API keys (never a
 * secret), the managed connectors of each cluster with their tasks and, with a Schema Registry key, the subjects with
 * their compatibility and versions. What it read is kept per platform (confluent_readouts) without any connector
 * configuration. Clusters link to the Kafka platforms whose variable confluentClusterId names them.
 */

/** Limits of a read (per platform). */
export const CONFLUENT_READ_LIMITS = {
  environments: 100,
  clusters: 200,
  serviceAccounts: 2000,
  apiKeys: 5000,
  /** Connectors kept per cluster */
  connectors: 500,
  /** Subjects listed; the versions and compatibility are read for the first `subjectDetails` of them */
  subjects: 2000,
  subjectDetails: 200,
  /** Requests to the Schema Registry at once */
  registryConcurrency: 4,
  /** Topics kept per connector */
  topics: 200,
  /** The job reads each Confluent Cloud platform again after this many minutes (or on "Read now") */
  refreshMinutes: 60,
  /** An API key older than this has a rotation hint */
  rotateAfterDays: 365,
  /** An API key that expires within this many days is "expiring" */
  expiringDays: 30,
} as const;

/** The phases of a Kafka cluster (cmk/v2 status.phase). */
export const CONFLUENT_CLUSTER_PHASES = ['PROVISIONED', 'PROVISIONING', 'FAILED'] as const;
/** The states of a managed connector (connect/v1 status.connector.state). */
export const CONFLUENT_CONNECTOR_STATES = ['NONE', 'PROVISIONING', 'RUNNING', 'DEGRADED', 'FAILED', 'PAUSED', 'DELETED'] as const;

/** The parts of a read: each is read on its own, a part that fails keeps its error and the others stand. */
export const CONFLUENT_PARTS = ['environments', 'clusters', 'schemaRegistries', 'serviceAccounts', 'apiKeys', 'connectors', 'subjects'] as const;
export type ConfluentPart = (typeof CONFLUENT_PARTS)[number];

export interface ConfluentEnvironment {
  /** env-… */
  id: string;
  name: string;
  /** The Stream Governance package (ESSENTIALS, ADVANCED), null when none is named */
  governance: string | null;
}

export interface ConfluentCluster {
  /** lkc-… */
  id: string;
  name: string;
  environmentId: string;
  /** Basic, Standard, Enterprise, Dedicated, Freight */
  type: string;
  /** AWS, GCP, AZURE */
  cloud: string;
  region: string;
  /** SINGLE_ZONE, MULTI_ZONE (HIGH, LOW) */
  availability: string;
  /** PROVISIONED, PROVISIONING, FAILED */
  phase: string;
  /** Dedicated clusters: the CKUs it has */
  cku: number | null;
  /** host:port of the bootstrap servers (public endpoint), null when the API names none */
  bootstrap: string | null;
}

export interface ConfluentSchemaRegistry {
  /** lsrc-… */
  id: string;
  environmentId: string;
  /** ESSENTIALS, ADVANCED */
  package: string;
  cloud: string;
  region: string;
  /** Its HTTP endpoint (https://psrc-….confluent.cloud) – read only when the platform's variable schemaRegistryUrl names it */
  endpoint: string;
  phase: string;
}

export interface ConfluentServiceAccount {
  /** sa-… */
  id: string;
  name: string;
  description: string;
}

/** An API key's metadata as Confluent lists it – never its secret (the list does not return it; Steward drops it anyway). */
export interface ConfluentApiKey {
  /** The key itself (an identifier, like a user name) */
  id: string;
  name: string;
  description: string;
  /** sa-… or u-… */
  ownerId: string;
  /** ServiceAccount, User */
  ownerKind: string;
  /** The service account's or user's name (null: not found) */
  ownerName: string | null;
  /** lkc-…, lsrc-…, cloud …; null: a Cloud API key */
  resourceId: string | null;
  /** Cluster, SchemaRegistry, Cloud … */
  resourceKind: string | null;
  environmentId: string | null;
  createdAt: string | null;
  /** YYYY-MM-DD; null: does not expire */
  expiresAt: string | null;
}

export interface ConfluentSubject {
  name: string;
  /** Versions registered (null: not read – beyond CONFLUENT_READ_LIMITS.subjectDetails) */
  versions: number | null;
  latest: number | null;
  /** The subject's own compatibility level, else the registry's; null: not read */
  compatibility: string | null;
  /** The level is the subject's own (not the registry's default) */
  ownCompatibility: boolean;
}

export interface ConfluentConnector {
  /** lcc-… */
  id: string;
  name: string;
  clusterId: string;
  environmentId: string;
  type: 'source' | 'sink' | 'unknown';
  /** connector.class, e.g. S3_SINK, PostgresCdcSourceV2 */
  class: string;
  state: string;
  /** The error of a failed connector, trimmed, secret-looking values removed */
  trace: string | null;
  tasks: ConnectTask[];
  /** The topics of its configuration (topics, kafka.topic) */
  topics: string[];
}

/** What Steward last read from Confluent Cloud – no connector configuration, no secret – kept per platform. */
export interface ConfluentReadout {
  readAt: string;
  /** null: every part read; else why the read failed as a whole (the last values stay) */
  error: string | null;
  /** Parts that could not be read, with why (e.g. the key may not list API keys); their last values stay */
  partErrors: { part: ConfluentPart; message: string }[];
  environments: ConfluentEnvironment[];
  clusters: ConfluentCluster[];
  schemaRegistries: ConfluentSchemaRegistry[];
  serviceAccounts: ConfluentServiceAccount[];
  apiKeys: ConfluentApiKey[];
  connectors: ConfluentConnector[];
  /** The subjects of the Schema Registry the variable schemaRegistryUrl names; null: none named or no key */
  registry: { url: string; compatibility: string | null; subjects: ConfluentSubject[]; truncated: boolean } | null;
}

/** A cluster as the platform page shows it: with the Kafka platform that names it (one the reader may see). */
export interface ConfluentClusterView extends ConfluentCluster {
  environmentName: string;
  kafkaPlatform: { id: string; name: string } | null;
}

export interface ConfluentConnectorView extends ConfluentConnector {
  /** Kafka topic components (of applications the reader may see) on the linked Kafka platform, per topic */
  topicComponents: { topic: string; applicationId: string; applicationName: string; componentId: string }[];
}

export interface ConfluentApiKeyView extends ConfluentApiKey {
  /** expired, expiring (within expiringDays), rotate (older than rotateAfterDays), or ok */
  hint: 'expired' | 'expiring' | 'rotate' | 'ok';
}

export interface ConfluentView {
  platformId: string;
  readAt: string | null;
  error: string | null;
  partErrors: ConfluentReadout['partErrors'];
  environments: ConfluentEnvironment[];
  clusters: ConfluentClusterView[];
  schemaRegistries: ConfluentSchemaRegistry[];
  connectors: ConfluentConnectorView[];
  registry: ConfluentReadout['registry'];
  /** Service accounts and API keys: only for who may use the platform (null otherwise) */
  serviceAccounts: ConfluentServiceAccount[] | null;
  apiKeys: ConfluentApiKeyView[] | null;
  /** Who may use the platform: Read now, the service accounts and API keys */
  canRead: boolean;
}

/** The hint of an API key: expired, expiring soon, old enough to rotate, or ok. */
export function confluentKeyHint(k: Pick<ConfluentApiKey, 'createdAt' | 'expiresAt'>, now = Date.now()): ConfluentApiKeyView['hint'] {
  const day = 86_400_000;
  if (k.expiresAt) {
    // the key stays valid through the end of its expiry date (UTC)
    const end = Date.parse(`${k.expiresAt.slice(0, 10)}T23:59:59Z`);
    if (Number.isFinite(end)) {
      if (end < now) return 'expired';
      if (end - now <= CONFLUENT_READ_LIMITS.expiringDays * day) return 'expiring';
    }
  }
  const created = k.createdAt ? Date.parse(k.createdAt) : NaN;
  if (Number.isFinite(created) && now - created > CONFLUENT_READ_LIMITS.rotateAfterDays * day) return 'rotate';
  return 'ok';
}
