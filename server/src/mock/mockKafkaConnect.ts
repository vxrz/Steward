import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEMO_DB, DEMO_DB_HOST } from '../dbms/demo.js';

/**
 * A simulated Kafka Connect REST API for demo mode and tests (0.9.0, #223) under /mock/kafka-connect, Basic auth with
 * DEMO_KAFKA_CONNECT. Read endpoints only (changing ones answer 405 – Steward never sends them anyway):
 *
 *   shop-cdc        Debezium PostgreSQL source of the demo database (host postgres.demo.invalid, database shop),
 *                   RUNNING, writes shop.public.orders and shop.public.customers on Kafka (demo)
 *   orders-archive  Debezium JDBC sink of the topic orders into a warehouse, RUNNING – task 1 FAILED (its trace names
 *                   the connection URL with a password, which Steward must never show)
 *
 * The configurations hold made-up credentials on purpose: Steward removes them from every answer.
 */

export const DEMO_KAFKA_CONNECT = { username: 'connect-reader', password: 'demo-connect-secret' };
/** The made-up secrets in the demo configurations – tests check that none of them leaves Steward. */
export const DEMO_CONNECT_SECRETS = ['demo-cdc-password', 'demo-archive-password', 'demo-registry-password', 'Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRg'];

const WORKERS = ['connect-1.demo.invalid:8083', 'connect-2.demo.invalid:8083'];

interface Connector {
  type: 'source' | 'sink';
  config: Record<string, string>;
  state: string;
  worker: string;
  tasks: { state: string; worker: string; trace?: string }[];
  topics: string[];
}

const ARCHIVE_TRACE = [
  'org.apache.kafka.connect.errors.ConnectException: Exiting WorkerSinkTask due to unrecoverable exception.',
  '\tat org.apache.kafka.connect.runtime.WorkerSinkTask.deliverMessages(WorkerSinkTask.java:632)',
  '\tat org.apache.kafka.connect.runtime.WorkerSinkTask.poll(WorkerSinkTask.java:350)',
  'Caused by: org.hibernate.exception.JDBCConnectionException: Unable to open JDBC Connection for DDL execution [FATAL: password authentication failed for user "archiver"]',
  '\tat org.hibernate.exception.internal.SQLStateConversionDelegate.convert(SQLStateConversionDelegate.java:100)',
  'Caused by: org.postgresql.util.PSQLException: connection to jdbc:postgresql://archiver:demo-archive-password@warehouse.demo.invalid:5432/archive?password=demo-archive-password failed',
  '\tat org.postgresql.core.v3.ConnectionFactoryImpl.openConnectionImpl(ConnectionFactoryImpl.java:346)',
  '\tat org.postgresql.core.ConnectionFactory.openConnection(ConnectionFactory.java:54)',
  '\tat org.postgresql.jdbc.PgConnection.<init>(PgConnection.java:263)',
  '\tat org.postgresql.Driver.makeConnection(Driver.java:443)',
  '\tat org.postgresql.Driver.connect(Driver.java:297)',
  '\tat java.sql/java.sql.DriverManager.getConnection(DriverManager.java:681)',
  '\tat java.sql/java.sql.DriverManager.getConnection(DriverManager.java:229)',
  '\t... 14 more',
].join('\n');

function seed(): Record<string, Connector> {
  return {
    'shop-cdc': {
      type: 'source',
      config: {
        name: 'shop-cdc',
        'connector.class': 'io.debezium.connector.postgresql.PostgresConnector',
        'tasks.max': '1',
        'database.hostname': DEMO_DB_HOST,
        'database.port': '5432',
        'database.dbname': DEMO_DB.database,
        'database.user': 'debezium',
        'database.password': 'demo-cdc-password',
        'topic.prefix': 'shop',
        'table.include.list': 'public.orders,public.customers',
        'plugin.name': 'pgoutput',
        'slot.name': 'steward_demo_cdc',
        'key.converter': 'org.apache.kafka.connect.json.JsonConverter',
        'value.converter': 'org.apache.kafka.connect.json.JsonConverter',
        'value.converter.schema.registry.url': 'https://registry.demo.invalid',
        'value.converter.basic.auth.user.info': 'registry:demo-registry-password',
        // a random-looking value under a harmless key: removed by the value heuristics
        'notification.sink.signing': 'Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRg',
      },
      state: 'RUNNING',
      worker: WORKERS[0]!,
      tasks: [{ state: 'RUNNING', worker: WORKERS[0]! }],
      topics: ['shop.public.customers', 'shop.public.orders'],
    },
    'orders-archive': {
      type: 'sink',
      config: {
        name: 'orders-archive',
        'connector.class': 'io.debezium.connector.jdbc.JdbcSinkConnector',
        'tasks.max': '2',
        topics: 'orders',
        'connection.url': 'jdbc:postgresql://warehouse.demo.invalid:5432/archive',
        'connection.username': 'archiver',
        'connection.password': 'demo-archive-password',
        'insert.mode': 'upsert',
        'primary.key.mode': 'record_key',
        'key.converter': 'org.apache.kafka.connect.json.JsonConverter',
        'errors.tolerance': 'none',
      },
      state: 'RUNNING',
      worker: WORKERS[1]!,
      tasks: [
        { state: 'RUNNING', worker: WORKERS[1]! },
        { state: 'FAILED', worker: WORKERS[0]!, trace: ARCHIVE_TRACE },
      ],
      topics: ['orders'],
    },
  };
}

let connectors = seed();

/** For tests: a connector's or task's state (task -1: the connector itself), and a fresh start. */
export function setConnectState(name: string, task: number, state: string, trace?: string): void {
  const c = connectors[name];
  if (!c) return;
  if (task < 0) c.state = state;
  else if (c.tasks[task]) c.tasks[task] = { ...c.tasks[task], state, ...(trace !== undefined ? { trace } : {}) };
}
export function removeConnector(name: string): void {
  delete connectors[name];
}
export function resetKafkaConnect(): void {
  connectors = seed();
}

const PLUGINS = [
  { class: 'io.debezium.connector.jdbc.JdbcSinkConnector', type: 'sink', version: '2.7.3.Final' },
  { class: 'io.debezium.connector.postgresql.PostgresConnector', type: 'source', version: '2.7.3.Final' },
  { class: 'org.apache.kafka.connect.file.FileStreamSinkConnector', type: 'sink', version: '3.9.0' },
  { class: 'org.apache.kafka.connect.file.FileStreamSourceConnector', type: 'source', version: '3.9.0' },
  { class: 'org.apache.kafka.connect.mirror.MirrorSourceConnector', type: 'source', version: '3.9.0' },
];

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers.authorization !== `Basic ${Buffer.from(`${DEMO_KAFKA_CONNECT.username}:${DEMO_KAFKA_CONNECT.password}`).toString('base64')}`) {
    void reply.code(401).send({ error_code: 401, message: 'Unauthorized' });
    return false;
  }
  return true;
}

const status = (name: string, c: Connector) => ({
  name,
  connector: { state: c.state, worker_id: c.worker },
  tasks: c.tasks.map((t, id) => ({ id, state: t.state, worker_id: t.worker, ...(t.trace ? { trace: t.trace } : {}) })),
  type: c.type,
});
const info = (name: string, c: Connector) => ({ name, config: { ...c.config }, tasks: c.tasks.map((_t, task) => ({ connector: name, task })), type: c.type });

export async function mockKafkaConnect(app: FastifyInstance): Promise<void> {
  const R = '/kafka-connect';
  const one = (req: FastifyRequest, reply: FastifyReply): [string, Connector] | null => {
    const name = (req.params as { name: string }).name;
    // the mock's own key, not the requested text: answers never echo the URL
    const key = Object.keys(connectors).find((k) => k === name);
    if (key === undefined) {
      void reply.code(404).send({ error_code: 404, message: 'Connector not found' });
      return null;
    }
    return [key, connectors[key]!];
  };
  app.get(`${R}/`, async (req, reply) =>
    authorized(req, reply) ? { version: '3.9.0', commit: 'a1b2c3d4e5f60718', kafka_cluster_id: 'demo-cluster-0001' } : reply,
  );
  app.get(`${R}/connectors`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const q = (req.query as { expand?: string | string[] }).expand;
    const expand = Array.isArray(q) ? q : q ? [q] : [];
    if (!expand.length) return Object.keys(connectors);
    return Object.fromEntries(
      Object.entries(connectors).map(([name, c]) => [
        name,
        { ...(expand.includes('status') ? { status: status(name, c) } : {}), ...(expand.includes('info') ? { info: info(name, c) } : {}) },
      ]),
    );
  });
  app.get(`${R}/connectors/:name`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const hit = one(req, reply);
    return hit ? info(...hit) : reply;
  });
  app.get(`${R}/connectors/:name/config`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const hit = one(req, reply);
    return hit ? { ...hit[1].config } : reply;
  });
  app.get(`${R}/connectors/:name/status`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const hit = one(req, reply);
    return hit ? status(...hit) : reply;
  });
  app.get(`${R}/connectors/:name/tasks`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const hit = one(req, reply);
    return hit ? hit[1].tasks.map((_t, task) => ({ id: { connector: hit[0], task }, config: { ...hit[1].config, 'task.class': 'demo.Task' } })) : reply;
  });
  app.get(`${R}/connectors/:name/topics`, async (req, reply) => {
    if (!authorized(req, reply)) return reply;
    const hit = one(req, reply);
    return hit ? { [hit[0]]: { topics: hit[1].topics } } : reply;
  });
  app.get(`${R}/connector-plugins`, async (req, reply) => (authorized(req, reply) ? PLUGINS : reply));
  // writes are not part of the demo: Steward refuses them before they are sent
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const)
    app.route({ method, url: `${R}/*`, handler: async (_req, reply) => reply.code(405).send({ error_code: 405, message: 'Read-only demo' }) });
}
