import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { KafkaReader, RawMessage } from '../kafka/client.js';

/**
 * A simulated Kafka cluster and Schema Registry for demo mode and tests (#112). The cluster is reached through the
 * reader interface (kafka/client.ts, bootstrap kafka.demo.invalid:9092 in demo mode only); the Schema Registry speaks
 * Confluent's HTTP API at /mock/schema-registry (Basic auth with DEMO_KAFKA.registryKey / registrySecret).
 *
 *   orders        3 partitions, new messages every minute, group order-service keeps up, group billing is stuck
 *   payments      no new message for 3 hours
 *   shop-events   compacted, 1 partition, retention -1
 */

export const DEMO_KAFKA = { username: 'DEMOKEY', password: 'demo-kafka-secret', registryKey: 'SRKEY', registrySecret: 'demo-registry-secret' };

const MIN = 60_000;

interface Topic {
  partitions: number;
  replication: number;
  configs: Record<string, string>;
  /** end offset per partition */
  ends: number[];
  /** time of the newest message */
  newest: number;
  /** the newest messages, for peek */
  messages: { partition: number; offset: number; at: number; key: string; value: string }[];
}

interface Group {
  state: string;
  committed: Record<string, number[]>;
}

const order = (i: number) =>
  JSON.stringify({
    orderId: `o-${1000 + i}`,
    customer: { name: 'Erika Mustermann', email: 'erika@example.com' },
    total: 42.5 + i,
    cardNumber: '4111111111111111',
  });

function seed() {
  const now = Date.now();
  const topics: Record<string, Topic> = {
    orders: {
      partitions: 3,
      replication: 3,
      configs: { 'cleanup.policy': 'delete', 'retention.ms': String(7 * 24 * 3600_000), 'min.insync.replicas': '2', 'max.message.bytes': '1048588' },
      ends: [4200, 4180, 4215],
      newest: now - MIN,
      messages: Array.from({ length: 6 }, (_, i) => ({ partition: i % 3, offset: 4170 + i, at: now - (6 - i) * MIN, key: `o-${1000 + i}`, value: order(i) })),
    },
    payments: {
      partitions: 2,
      replication: 3,
      configs: { 'cleanup.policy': 'delete', 'retention.ms': String(3 * 24 * 3600_000), 'min.insync.replicas': '2' },
      ends: [900, 912],
      newest: now - 180 * MIN,
      messages: [
        {
          partition: 0,
          offset: 899,
          at: now - 180 * MIN,
          key: 'p-77',
          value: JSON.stringify({ paymentId: 'p-77', iban: 'DE02120300000000202051', amount: 10 }),
        },
      ],
    },
    'shop-events': {
      partitions: 1,
      replication: 1,
      configs: { 'cleanup.policy': 'compact', 'retention.ms': '-1', 'min.insync.replicas': '1' },
      ends: [55],
      newest: now - 20 * MIN,
      messages: [{ partition: 0, offset: 54, at: now - 20 * MIN, key: 'cart-9', value: 'not json: cart 9 checked out' }],
    },
  };
  const groups: Record<string, Group> = {
    'order-service': { state: 'Stable', committed: { orders: [4199, 4180, 4210] } },
    billing: { state: 'Stable', committed: { orders: [3100, 3050, 3122], payments: [900, 912] } },
  };
  return { topics, groups };
}

let data = seed();

/** For tests and the demo: new messages on a topic (the newest now), a group's commits, the state of a group. */
export function produceKafka(topic: string, n = 1): void {
  const t = data.topics[topic];
  if (!t) return;
  for (let i = 0; i < n; i++) t.ends[i % t.partitions]! += 1;
  t.newest = Date.now();
}
export function commitKafka(group: string, topic: string, committed: number[]): void {
  data.groups[group] ??= { state: 'Stable', committed: {} };
  data.groups[group]!.committed[topic] = committed;
}
export function setKafkaNewest(topic: string, at: number): void {
  if (data.topics[topic]) data.topics[topic].newest = at;
}
export function resetKafka(): void {
  data = seed();
  schemas = seedSchemas();
}

export function demoKafkaReader(): KafkaReader {
  return {
    async listTopics() {
      return Object.keys(data.topics);
    },
    async topic(name) {
      const t = data.topics[name];
      return t ? { name, partitions: t.partitions, replicationFactor: t.replication, configs: { ...t.configs } } : null;
    },
    async ends(topic) {
      return (data.topics[topic]?.ends ?? []).map((end, partition) => ({ partition, end }));
    },
    async newest(topic) {
      return data.topics[topic]?.newest ?? null;
    },
    async groups(topic, only) {
      return Object.entries(data.groups)
        .filter(([g, x]) => x.committed[topic] && (!only?.length || only.includes(g)))
        .map(([group, x]) => ({ group, state: x.state, committed: new Map(x.committed[topic]!.map((o, p) => [p, o])) }));
    },
    async peek(topic, count): Promise<RawMessage[]> {
      return (data.topics[topic]?.messages ?? [])
        .slice(-count)
        .reverse()
        .map((m) => ({
          partition: m.partition,
          offset: BigInt(m.offset),
          timestamp: BigInt(m.at),
          key: Buffer.from(m.key),
          value: Buffer.from(m.value),
          headers: ['traceparent'],
        }));
    },
    async close() {},
  };
}

// ---------- Schema Registry (Confluent API subset) ----------

interface Version {
  version: number;
  id: number;
  schemaType: string;
  schema: string;
}

const avro = (fields: { name: string; type: string }[]) => JSON.stringify({ type: 'record', name: 'Order', namespace: 'com.acme.shop', fields });

function seedSchemas(): Record<string, Version[]> {
  return {
    'orders-value': [
      { version: 1, id: 101, schemaType: 'AVRO', schema: avro([{ name: 'orderId', type: 'string' }]) },
      {
        version: 2,
        id: 102,
        schemaType: 'AVRO',
        schema: avro([
          { name: 'orderId', type: 'string' },
          { name: 'total', type: 'double' },
        ]),
      },
    ],
    'payments-value': [{ version: 1, id: 201, schemaType: 'JSON', schema: JSON.stringify({ type: 'object', properties: { paymentId: { type: 'string' } } }) }],
  };
}

let schemas = seedSchemas();

/** For tests and the demo: register a new schema version of a subject. */
export function registerSchema(subject: string, schema: string, schemaType = 'AVRO'): number {
  const list = (schemas[subject] ??= []);
  const version = (list.at(-1)?.version ?? 0) + 1;
  list.push({ version, id: 100 + Object.values(schemas).flat().length + 1, schemaType, schema });
  return version;
}

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers.authorization !== `Basic ${Buffer.from(`${DEMO_KAFKA.registryKey}:${DEMO_KAFKA.registrySecret}`).toString('base64')}`) {
    void reply.code(401).send({ error_code: 401, message: 'Unauthorized' });
    return false;
  }
  return true;
}

const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error_code: 40401, message: `${what} not found` });

export async function mockSchemaRegistry(app: FastifyInstance): Promise<void> {
  const R = '/schema-registry';
  app.get(`${R}/subjects`, async (req, reply) => (authorized(req, reply) ? Object.keys(schemas) : reply));
  app.get(`${R}/subjects/:subject/versions`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const list = schemas[(req.params as { subject: string }).subject];
    return list ? list.map((v) => v.version) : notFound(reply, 'Subject');
  });
  app.get(`${R}/subjects/:subject/versions/:version`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const { subject, version } = req.params as { subject: string; version: string };
    const list = schemas[subject];
    if (!list) return notFound(reply, 'Subject');
    const v = version === 'latest' ? list.at(-1) : list.find((x) => x.version === Number(version));
    return v ? { subject, ...v } : notFound(reply, 'Version');
  });
  app.get(`${R}/config/:subject`, async (req, reply) => (authorized(req, reply) ? { compatibilityLevel: 'BACKWARD' } : reply));
  app.post(`${R}/compatibility/subjects/:subject/versions/:version`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const body = req.body as { schema?: string } | null;
    // the demo's rule: a schema that drops orderId is not compatible
    return { is_compatible: !body?.schema || String(body.schema).includes('orderId') };
  });
}
