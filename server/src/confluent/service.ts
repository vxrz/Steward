import {
  CONFLUENT_KIND,
  CONFLUENT_READ_LIMITS,
  KAFKA_KIND,
  confluentKeyHint,
  type ConfluentClusterView,
  type ConfluentConnectorView,
  type ConfluentReadout,
  type ConfluentView,
  type Platform,
  type TopicConnectorRef,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, parseJson } from '../util.js';
import { getConnection, getPlatform } from '../platforms/service.js';
import { requireVisiblePlatform } from '../monitors/platforms.js';
import { catalogueVisibleNow } from '../records/access.js';
import { readConfluent } from './client.js';

/**
 * Confluent Cloud platforms (0.14.0, #123, docs/CONFLUENT.md): what Steward last read – environments, clusters, Schema
 * Registries and subjects, service accounts, API key metadata, managed connectors – kept per platform
 * (confluent_readouts), never a secret or a connector configuration. The links: a cluster belongs to the Kafka platform
 * whose variable confluentClusterId names it, and a connector's topics to the Kafka topic components on that platform.
 * Links name only what the reader may see; service accounts and API keys only who may use the platform.
 */

interface ReadoutRow {
  platform_id: string;
  readout: string;
  read_at: string;
  read_by: string;
}

function storedRow(platformId: string): ReadoutRow | undefined {
  return db().get<ReadoutRow>('SELECT * FROM confluent_readouts WHERE platform_id = ?', platformId);
}

export function storedConfluent(platformId: string): ConfluentReadout | null {
  const r = storedRow(platformId);
  return r ? parseJson<ConfluentReadout | null>(r.readout, null) : null;
}

const visible = (id: string): Platform | null => {
  try {
    const p = getPlatform(id);
    return p.permissions.length ? p : null;
  } catch {
    return null;
  }
};

/** The Kafka platforms by the Confluent cluster their variable confluentClusterId names (whoever may see them). */
export function kafkaPlatformsByCluster(): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>();
  for (const r of db().all<{ id: string; name: string; config: string }>('SELECT id, name, config FROM platforms WHERE kind = ? ORDER BY name', KAFKA_KIND)) {
    const cluster = String(parseJson<{ variables?: Record<string, unknown> }>(r.config, {}).variables?.confluentClusterId ?? '').trim();
    // the first by name when two name the same cluster
    if (cluster && !out.has(cluster)) out.set(cluster, { id: r.id, name: r.name });
  }
  return out;
}

/** Topic components of a Kafka platform per topic name, of applications the reader may see (archived ones left out). */
function topicComponents(kafkaPlatformId: string): Map<string, ConfluentConnectorView['topicComponents']> {
  const rows = db().all<{ id: string; name: string; application_id: string; app_name: string; owners: string }>(
    `SELECT c.id, c.name, c.application_id, a.name AS app_name, a.owners FROM application_components c JOIN applications a ON a.id = c.application_id
     WHERE c.type = 'kafka-topic' AND c.platform_id = ? AND a.archived = 0 ORDER BY a.name, c.name`,
    kafkaPlatformId,
  );
  const out = new Map<string, ConfluentConnectorView['topicComponents']>();
  for (const r of rows) {
    if (!catalogueVisibleNow('application', { id: r.application_id, owners: r.owners })) continue;
    out.set(r.name, [...(out.get(r.name) ?? []), { topic: r.name, applicationId: r.application_id, applicationName: r.app_name, componentId: r.id }]);
  }
  return out;
}

/** The platform page's view (GET /api/platforms/:id/confluent): the last readout with the links the reader may see. */
export function getConfluentView(platformId: string, now = Date.now()): ConfluentView {
  const p = requireVisiblePlatform(platformId);
  if (p.kind !== CONFLUENT_KIND) throw new HttpError(400, 'Choose a Confluent Cloud platform', 'CONFLUENT_PLATFORM');
  const r = storedConfluent(platformId);
  const canRead = p.permissions.includes('use');
  const byCluster = kafkaPlatformsByCluster();
  const kafkaOf = (clusterId: string) => {
    const k = byCluster.get(clusterId);
    return k && visible(k.id) ? k : null;
  };
  const envName = new Map((r?.environments ?? []).map((e) => [e.id, e.name]));
  const clusters: ConfluentClusterView[] = (r?.clusters ?? []).map((c) => ({
    ...c,
    environmentName: envName.get(c.environmentId) ?? c.environmentId,
    kafkaPlatform: kafkaOf(c.id),
  }));
  const topicsByKafka = new Map<string, Map<string, ConfluentConnectorView['topicComponents']>>();
  const topicsOf = (kafkaId: string) => {
    let m = topicsByKafka.get(kafkaId);
    if (!m) topicsByKafka.set(kafkaId, (m = topicComponents(kafkaId)));
    return m;
  };
  const connectors: ConfluentConnectorView[] = (r?.connectors ?? []).map((c) => {
    const kafka = kafkaOf(c.clusterId);
    return { ...c, topicComponents: kafka ? c.topics.flatMap((t) => topicsOf(kafka.id).get(t) ?? []) : [] };
  });
  return {
    platformId,
    readAt: r?.readAt ?? null,
    error: r?.error ?? null,
    partErrors: r?.partErrors ?? [],
    environments: r?.environments ?? [],
    clusters,
    schemaRegistries: r?.schemaRegistries ?? [],
    connectors,
    registry: r?.registry ?? null,
    serviceAccounts: canRead ? (r?.serviceAccounts ?? []) : null,
    apiKeys: canRead ? (r?.apiKeys ?? []).map((k) => ({ ...k, hint: confluentKeyHint(k, now) })) : null,
    canRead,
  };
}

/** A short message for an error of a read (the API's answer, the outbound policy, a timeout). */
export function confluentErrorMessage(e: unknown): string {
  const err = e as Error & { cause?: Error };
  return `${err.message}${err.cause?.message && !err.message.includes(err.cause.message) ? `: ${err.cause.message}` : ''}`.slice(0, 400);
}

const EMPTY: Omit<ConfluentReadout, 'readAt' | 'error'> = {
  partErrors: [],
  environments: [],
  clusters: [],
  schemaRegistries: [],
  serviceAccounts: [],
  apiKeys: [],
  connectors: [],
  registry: null,
};

/** Names added and removed between two lists. */
function changes(was: string[], is: string[]): string[] {
  const a = new Set(was);
  const b = new Set(is);
  return [...[...b].filter((n) => !a.has(n)).map((n) => `+${n}`), ...[...a].filter((n) => !b.has(n)).map((n) => `-${n}`)];
}

/**
 * Reads Confluent Cloud now and keeps the readout; a failed read keeps the last values and records why. Clusters and
 * connectors that appear or disappear are recorded in the platform's history (platform.clusters_changed,
 * platform.connectors_changed) – names and ids only.
 */
export async function refreshConfluent(platformId: string, actor: string, now = Date.now()): Promise<ConfluentReadout> {
  const { platform, secrets } = getConnection(platformId);
  if (platform.kind !== CONFLUENT_KIND) throw new HttpError(400, 'Choose a Confluent Cloud platform', 'CONFLUENT_PLATFORM');
  const before = storedConfluent(platformId);
  const at = new Date(now).toISOString();
  let readout: ConfluentReadout;
  try {
    readout = { readAt: at, error: null, ...(await readConfluent(platform, secrets, { before, now })) };
  } catch (e) {
    readout = { ...EMPTY, ...(before ?? {}), readAt: at, error: confluentErrorMessage(e) };
  }
  db().run(
    `INSERT INTO confluent_readouts (platform_id, readout, read_at, read_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(platform_id) DO UPDATE SET readout = excluded.readout, read_at = excluded.read_at, read_by = excluded.read_by`,
    platformId,
    JSON.stringify(readout),
    at,
    actor,
  );
  // compared with a read that found something (a failed part keeps its last values, which compare as unchanged)
  if (!readout.error && before && !before.error) {
    const clusters = changes(
      before.clusters.map((c) => c.id),
      readout.clusters.map((c) => c.id),
    );
    if (clusters.length)
      audit({
        action: 'platform.clusters_changed',
        entityType: 'platform',
        entityId: platformId,
        actor,
        summary: `Kafka clusters of "${platform.name}" changed: ${clusters.join(', ')}`.slice(0, 500),
        details: { changes: clusters.slice(0, 50) },
      });
    const key = (c: { clusterId: string; name: string }) => `${c.clusterId}/${c.name}`;
    const connectors = changes(before.connectors.map(key), readout.connectors.map(key));
    if (connectors.length)
      audit({
        action: 'platform.connectors_changed',
        entityType: 'platform',
        entityId: platformId,
        actor,
        summary: `Connectors of "${platform.name}" changed: ${connectors.join(', ')}`.slice(0, 500),
        details: { changes: connectors.slice(0, 50) },
      });
  }
  // 0.25.0 (ADR 0037 part 1): the managed connectors' lineage as proposals of the data products module (while it is on)
  if (!readout.error) await (await import('../kafkaconnect/service.js')).proposeConnectorLineage(platformId);
  return readout;
}

/** The job: every Confluent Cloud platform is read again after CONFLUENT_READ_LIMITS.refreshMinutes. */
export async function runConfluentJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const ids = db()
    .all<{ id: string }>('SELECT id FROM platforms WHERE kind = ? ORDER BY name', CONFLUENT_KIND)
    .map((r) => r.id);
  let n = 0;
  for (const id of ids) {
    const last = storedRow(id);
    if (last && now - Date.parse(last.read_at) < CONFLUENT_READ_LIMITS.refreshMinutes * 60_000) continue;
    try {
      await refreshConfluent(id, 'system', now);
      n++;
    } catch (err) {
      logger.warn({ err: confluentErrorMessage(err), platform: id }, 'reading a Confluent Cloud platform failed');
    }
  }
  return n;
}

/**
 * The managed connectors that use topics of a Kafka platform (its variable confluentClusterId names their cluster), per
 * topic – for Kafka topic components on the application page. Only Confluent Cloud platforms the reader may see.
 */
export function confluentTopicConnectors(kafkaPlatformId: string): Map<string, TopicConnectorRef[]> {
  const out = new Map<string, TopicConnectorRef[]>();
  const kafka = db().get<{ config: string }>('SELECT config FROM platforms WHERE id = ? AND kind = ?', kafkaPlatformId, KAFKA_KIND);
  const cluster = kafka ? String(parseJson<{ variables?: Record<string, unknown> }>(kafka.config, {}).variables?.confluentClusterId ?? '').trim() : '';
  if (!cluster || kafkaPlatformsByCluster().get(cluster)?.id !== kafkaPlatformId) return out;
  for (const r of db().all<ReadoutRow>('SELECT * FROM confluent_readouts')) {
    const p = visible(r.platform_id);
    if (!p) continue;
    for (const c of parseJson<ConfluentReadout | null>(r.readout, null)?.connectors ?? [])
      if (c.clusterId === cluster)
        for (const t of c.topics)
          out.set(t, [...(out.get(t) ?? []), { platformId: p.id, platformName: p.name, connector: c.name, type: c.type, state: c.state }]);
  }
  return out;
}
