import { bootstrapList, DATA_DISCOVERY_LIMITS, discoveryKeeps, environmentByRules, KAFKA_TOPIC_RE, openLineageDataset, type DiscoveredElement } from '@sm/shared';
import { kafkaError, openKafka } from '../../kafka/client.js';
import { chunks } from '../store.js';
import { DiscoveryError, num, short, type DiscoveryContext } from './common.js';
import { RunRegistry, type SubjectVersion } from './schema-registry.js';

/**
 * Kafka discovery (ADR 0036 part 5): the cluster's topics – internal ones (`_…`) left out – under the source's scope
 * (topic prefixes; none: all), with their topic id, partitions, replication and a settings summary (cleanup.policy,
 * retention.ms) from one metadata and one DescribeConfigs request per DATA_DISCOVERY_LIMITS.topicsPerRequest topics,
 * and the latest version of the subject `<topic>-value` from the platform's Schema Registry. Metadata only: no
 * consumer group, no offsets, no message (the call allow-list of the tests). The brokers are reached through the
 * Kafka client's checks – the platform's bootstrap servers, the advertised brokers in their domain, otherwise the
 * outbound allow-list, every connection by the checked address – and the Schema Registry through the platform's request
 * path (outbound policy, address pinning).
 */

/** The reader calls discovery makes (the metadata-only test). */
export const KAFKA_DISCOVERY_CALLS: readonly RegExp[] = [/^listTopics$/, /^describeTopics \d+$/];

export async function* readKafka(ctx: DiscoveryContext): AsyncGenerator<DiscoveredElement[]> {
  const { source, platform } = ctx;
  const prefixes = source.scope.map((p) => p.trim()).filter(Boolean);
  const bad = prefixes.find((p) => !KAFKA_TOPIC_RE.test(p));
  if (bad)
    throw new DiscoveryError({
      message: `"${bad.slice(0, 100)}" is not a topic prefix (letters, digits, ".", "_" and "-")`,
      code: 'DATA_DISCOVERY_SCOPE',
      params: { context: 'kafka', value: bad.slice(0, 100) },
    });
  const first = bootstrapList(platform.config.variables?.bootstrap)[0];
  const address = first ? `${first.host}:${first.port}` : null;
  const fallback = platform.environment ?? '';
  const registry = new RunRegistry(platform, ctx.secrets);
  let reader;
  try {
    reader = (await openKafka(platform, ctx.secrets)).reader;
  } catch (e) {
    throw new DiscoveryError({ message: `The Kafka cluster could not be read: ${kafkaError(e)}`, code: 'DATA_DISCOVERY_FAILED', params: { message: kafkaError(e) } });
  }
  try {
    let names: string[];
    try {
      names = await reader.listTopics();
    } catch (e) {
      throw new DiscoveryError({ message: `The Kafka cluster could not be read: ${kafkaError(e)}`, code: 'DATA_DISCOVERY_FAILED', params: { message: kafkaError(e) } });
    }
    const topics = names
      .filter(
        (t) =>
          !t.startsWith('_') &&
          KAFKA_TOPIC_RE.test(t) &&
          (!prefixes.length || prefixes.some((p) => t.startsWith(p))) &&
          discoveryKeeps(t, source.includePrefixes, source.excludePrefixes),
      )
      .sort()
      .slice(0, ctx.max);
    let registryFailed = false;
    for (const part of chunks(topics, DATA_DISCOVERY_LIMITS.topicsPerRequest)) {
      if (ctx.signal.aborted) return;
      let described;
      try {
        described = await reader.describeTopics(part);
      } catch (e) {
        throw new DiscoveryError({ message: `The Kafka cluster could not be read: ${kafkaError(e)}`, code: 'DATA_DISCOVERY_FAILED', params: { message: kafkaError(e) } });
      }
      let schemas = new Map<string, SubjectVersion>();
      if (!registryFailed && registry.configured) {
        try {
          schemas = await registry.latestOf(described.map((t) => t.name));
        } catch (e) {
          // the topics stand without their schema versions; the run says what it could not read
          registryFailed = true;
          const message = (e as Error).message.slice(0, 300);
          ctx.warn({ message: `The Schema Registry could not be read: ${message}`, code: 'DATA_DISCOVERY_PARTIAL', params: { context: 'registry', message } });
        }
      }
      yield described.map((t): DiscoveredElement => {
        const ol = openLineageDataset('kafka.topic', address, t.name);
        const s = schemas.get(t.name);
        return {
          kind: 'kafka.topic',
          qualifiedName: t.name,
          displayName: t.name,
          environment: environmentByRules(t.name, source.environmentRules, fallback),
          externalId: t.id,
          flags: t.configs['cleanup.policy']?.includes('compact') ? { compacted: true } : {},
          readout: {
            partitions: t.partitions,
            replicationFactor: t.replicationFactor,
            retentionMs: num(t.configs['retention.ms']),
            cleanupPolicy: short(t.configs['cleanup.policy'], 40),
            ...(s ? { schemaSubject: s.subject.slice(0, 260), schemaVersion: s.version, schemaId: s.id, schemaType: s.type } : {}),
          },
          olNamespace: ol?.namespace ?? null,
          olName: ol?.name ?? null,
        };
      });
    }
    if (registry.capped)
      ctx.warn({
        message: `Schema versions were read for the first ${DATA_DISCOVERY_LIMITS.registrySubjects} topics with a subject; the others have none in this run`,
        code: 'DATA_DISCOVERY_PARTIAL',
        params: { context: 'registryCap', max: DATA_DISCOVERY_LIMITS.registrySubjects },
      });
  } finally {
    await reader.close();
  }
}
