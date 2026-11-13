import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/**
 * A simulated Confluent Cloud API for demo mode and tests (v0.4.0): the read endpoints the Confluent access source uses,
 * in Confluent's shapes, at /mock/confluent (like https://api.confluent.cloud) and the Kafka REST API v3 of one cluster
 * at /mock/confluent/kafka-rest (like https://pkc-….confluent.cloud:443).
 *
 *   GET /iam/v2/role-bindings?crn_pattern=…   Basic DEMO_CONFLUENT.cloudKey / cloudSecret
 *   GET /iam/v2/users, /iam/v2/service-accounts
 *   GET /kafka-rest/kafka/v3/clusters/lkc-demo1/acls   Basic DEMO_CONFLUENT.clusterKey / clusterSecret
 *
 * Lists serve at most two items per page (metadata.next with page_token), so paging is exercised. The organisation
 * org-demo has the environment env-demo1 with the cluster lkc-demo1: alice is OrganizationAdmin, bob EnvironmentAdmin,
 * erika CloudClusterAdmin of the cluster, the service account sa-orders (orders-service) DeveloperRead on the topic
 * orders and an ACL to read it, sa-billing an ACL to write payments; a binding of the unknown user u-gone is left over.
 * Request parameters are compared as plain strings (startsWith / equality) – no pattern is built from them.
 *
 * Costs (#226): GET /billing/v1/costs?start_date=&end_date= – daily lines of the cluster lkc-demo1 (CKUs, storage,
 * network), the Basic cluster lkc-demo2, the managed connectors and the environment's Stream Governance, in US dollars;
 * at most one month per request, like the real API.
 *
 * The readout (0.14.0, #123), in the shapes of Confluent's OpenAPI descriptions (org/v2, cmk/v2, srcm/v3, iam/v2,
 * connect/v1):
 *   GET /org/v2/environments                     production (env-demo1), development (env-demo2), staging (env-demo3)
 *   GET /cmk/v2/clusters?environment=…           orders-cluster (lkc-demo1, Standard, AWS) and sandbox (lkc-demo2, Basic, GCP)
 *   GET /srcm/v3/clusters?environment=…          the Schema Registry of production – its endpoint is the Kafka mock's
 *                                                /mock/schema-registry (key DEMO_KAFKA.registryKey)
 *   GET /iam/v2/api-keys                         five keys of service accounts and a user – metadata only, never a secret
 *   GET /connect/v1/environments/…/clusters/…/connectors?expand=info,status,id
 *                                                orders-s3-sink (RUNNING), shop-events-http-source (task 0 FAILED, its
 *                                                error names a token), clickstream-datagen (PAUSED, on lkc-demo2)
 * Invented names only. Tests change a cluster's phase or a connector's state with setConfluentClusterPhase /
 * setConfluentConnector; resetConfluent restores everything.
 */

export const DEMO_CONFLUENT = {
  cloudKey: 'CLOUDKEY',
  cloudSecret: 'demo-confluent-cloud-secret',
  clusterKey: 'CLUSTERKEY',
  clusterSecret: 'demo-confluent-cluster-secret',
  /** The secret of a key created through the mock (tests: never passed on by Steward) */
  newKeySecret: 'demo-confluent-new-key-secret',
  org: 'org-demo',
  environment: 'env-demo1',
  cluster: 'lkc-demo1',
};

const ORG = `crn://confluent.cloud/organization=${DEMO_CONFLUENT.org}`;
const ENV = `${ORG}/environment=${DEMO_CONFLUENT.environment}`;
const CLUSTER = `${ENV}/cloud-cluster=${DEMO_CONFLUENT.cluster}`;

interface MockConnector {
  id: string;
  name: string;
  cluster: string;
  environment: string;
  type: 'source' | 'sink';
  config: Record<string, string>;
  state: string;
  trace: string;
  tasks: { id: number; state: string; msg?: string }[];
}

interface State {
  environments: { id: string; display_name: string; package: string | null }[];
  clusters: {
    id: string;
    environment: string;
    display_name: string;
    kind: string;
    cloud: string;
    region: string;
    availability: string;
    phase: string;
    host: string;
    created: string;
  }[];
  apiKeys: {
    id: string;
    display_name: string;
    description: string;
    owner: { id: string; kind: string };
    resource: { id: string; kind: string; environment?: string } | null;
    created_at: string;
    expires_at?: string;
  }[];
  connectors: MockConnector[];
  users: { id: string; email: string; full_name: string }[];
  serviceAccounts: { id: string; display_name: string; description: string }[];
  bindings: { id: string; principal: string; role_name: string; crn_pattern: string }[];
  acls: { resource_type: string; resource_name: string; pattern_type: string; principal: string; host: string; operation: string; permission: string }[];
}

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 19) + 'Z';
const dayIn = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
// what Confluent shows instead of a connector's credentials
const MASKED = '****************';

function seed(): State {
  return {
    environments: [
      { id: DEMO_CONFLUENT.environment, display_name: 'production', package: 'ESSENTIALS' },
      { id: 'env-demo2', display_name: 'development', package: null },
      { id: 'env-demo3', display_name: 'staging', package: null },
    ],
    clusters: [
      {
        id: DEMO_CONFLUENT.cluster,
        environment: DEMO_CONFLUENT.environment,
        display_name: 'orders-cluster',
        kind: 'Standard',
        cloud: 'AWS',
        region: 'eu-central-1',
        availability: 'MULTI_ZONE',
        phase: 'PROVISIONED',
        host: 'pkc-demo1.eu-central-1.aws.confluent.invalid',
        created: daysAgo(700),
      },
      {
        id: 'lkc-demo2',
        environment: 'env-demo2',
        display_name: 'sandbox',
        kind: 'Basic',
        cloud: 'GCP',
        region: 'europe-west3',
        availability: 'SINGLE_ZONE',
        phase: 'PROVISIONED',
        host: 'pkc-demo2.europe-west3.gcp.confluent.invalid',
        created: daysAgo(120),
      },
    ],
    apiKeys: [
      {
        id: DEMO_CONFLUENT.cloudKey,
        display_name: 'steward-readonly',
        description: 'Cloud API key of the governance read-out',
        owner: { id: 'sa-steward', kind: 'ServiceAccount' },
        resource: null,
        created_at: daysAgo(40),
      },
      {
        id: 'DEMOKEY',
        display_name: 'orders-service on orders-cluster',
        description: 'Produces and reads orders',
        owner: { id: 'sa-orders', kind: 'ServiceAccount' },
        resource: { id: DEMO_CONFLUENT.cluster, kind: 'Cluster', environment: DEMO_CONFLUENT.environment },
        created_at: daysAgo(500),
      },
      {
        id: 'SRKEY',
        display_name: 'orders-service on the Schema Registry',
        description: 'Reads the schemas of orders',
        owner: { id: 'sa-orders', kind: 'ServiceAccount' },
        resource: { id: 'lsrc-demo1', kind: 'SchemaRegistry', environment: DEMO_CONFLUENT.environment },
        created_at: daysAgo(200),
        expires_at: dayIn(10),
      },
      {
        id: 'CONNECTKEY',
        display_name: 'managed connectors',
        description: 'Used by the managed connectors of orders-cluster',
        owner: { id: 'sa-connect', kind: 'ServiceAccount' },
        resource: { id: DEMO_CONFLUENT.cluster, kind: 'Cluster', environment: DEMO_CONFLUENT.environment },
        created_at: daysAgo(30),
        expires_at: dayIn(335),
      },
      {
        id: 'BOBSANDBOX',
        display_name: 'bob on sandbox',
        description: 'Personal key for experiments',
        owner: { id: 'u-bob22', kind: 'User' },
        resource: { id: 'lkc-demo2', kind: 'Cluster', environment: 'env-demo2' },
        created_at: daysAgo(90),
      },
    ],
    connectors: [
      {
        id: 'lcc-demo1',
        name: 'orders-s3-sink',
        cluster: DEMO_CONFLUENT.cluster,
        environment: DEMO_CONFLUENT.environment,
        type: 'sink',
        config: {
          'connector.class': 'S3_SINK',
          name: 'orders-s3-sink',
          topics: 'orders',
          's3.bucket.name': 'demo-orders-archive',
          'aws.access.key.id': MASKED,
          'aws.secret.access.key': MASKED,
          'kafka.api.key': MASKED,
          'kafka.api.secret': MASKED,
          'tasks.max': '2',
        },
        state: 'RUNNING',
        trace: '',
        tasks: [
          { id: 0, state: 'RUNNING' },
          { id: 1, state: 'RUNNING' },
        ],
      },
      {
        id: 'lcc-demo2',
        name: 'shop-events-http-source',
        cluster: DEMO_CONFLUENT.cluster,
        environment: DEMO_CONFLUENT.environment,
        type: 'source',
        config: {
          'connector.class': 'HttpSource',
          name: 'shop-events-http-source',
          'kafka.topic': 'shop-events',
          url: 'https://events.demo.invalid/api/events',
          'http.api.token': MASKED,
          'kafka.api.key': MASKED,
          'kafka.api.secret': MASKED,
          'tasks.max': '1',
        },
        state: 'RUNNING',
        trace: '',
        tasks: [
          {
            id: 0,
            state: 'FAILED',
            msg: 'org.apache.kafka.connect.errors.ConnectException: GET https://events.demo.invalid/api/events?token=demo-http-source-token answered 401 Unauthorized\n\tat io.confluent.connect.http.source.HttpSourceTask.poll(HttpSourceTask.java:212)',
          },
        ],
      },
      {
        id: 'lcc-demo3',
        name: 'clickstream-datagen',
        cluster: 'lkc-demo2',
        environment: 'env-demo2',
        type: 'source',
        config: {
          'connector.class': 'DatagenSource',
          name: 'clickstream-datagen',
          'kafka.topic': 'clickstream',
          quickstart: 'CLICKSTREAM',
          'kafka.api.key': MASKED,
          'kafka.api.secret': MASKED,
        },
        state: 'PAUSED',
        trace: '',
        tasks: [{ id: 0, state: 'PAUSED' }],
      },
    ],
    users: [
      { id: 'u-alice1', email: 'alice@example.com', full_name: 'Alice Admin' },
      { id: 'u-bob22', email: 'bob@example.com', full_name: 'Bob Builder' },
      { id: 'u-erika3', email: 'Erika.Mustermann@example.com', full_name: 'Erika Mustermann' },
    ],
    serviceAccounts: [
      { id: 'sa-orders', display_name: 'orders-service', description: 'Reads the orders topic' },
      { id: 'sa-billing', display_name: 'billing', description: 'Writes payments' },
      { id: 'sa-connect', display_name: 'managed-connectors', description: 'Runs the managed connectors' },
      { id: 'sa-steward', display_name: 'steward-readonly', description: 'Reads the organisation for Steward' },
    ],
    bindings: [
      { id: 'rb-1', principal: 'User:u-alice1', role_name: 'OrganizationAdmin', crn_pattern: ORG },
      { id: 'rb-2', principal: 'User:u-bob22', role_name: 'EnvironmentAdmin', crn_pattern: ENV },
      { id: 'rb-3', principal: 'User:u-erika3', role_name: 'CloudClusterAdmin', crn_pattern: CLUSTER },
      { id: 'rb-4', principal: 'User:sa-orders', role_name: 'DeveloperRead', crn_pattern: `${CLUSTER}/kafka=${DEMO_CONFLUENT.cluster}/topic=orders` },
      { id: 'rb-5', principal: 'User:u-gone9', role_name: 'MetricsViewer', crn_pattern: ENV },
    ],
    acls: [
      {
        resource_type: 'TOPIC',
        resource_name: 'orders',
        pattern_type: 'LITERAL',
        principal: 'User:sa-orders',
        host: '*',
        operation: 'READ',
        permission: 'ALLOW',
      },
      {
        resource_type: 'GROUP',
        resource_name: 'order-service',
        pattern_type: 'PREFIXED',
        principal: 'User:sa-orders',
        host: '*',
        operation: 'READ',
        permission: 'ALLOW',
      },
      {
        resource_type: 'TOPIC',
        resource_name: 'payments',
        pattern_type: 'LITERAL',
        principal: 'User:sa-billing',
        host: '*',
        operation: 'WRITE',
        permission: 'ALLOW',
      },
    ],
  };
}

let state = seed();

/** For tests and the demo: a new role binding (the next snapshot shows it). */
export function addConfluentBinding(principal: string, role: string, crn = ENV): void {
  state.bindings.push({ id: `rb-${state.bindings.length + 1}`, principal, role_name: role, crn_pattern: crn });
}
export function resetConfluent(): void {
  state = seed();
  forbidden = null;
}
/** For tests: a path the Cloud API key may not read (403), or null. */
let forbidden: string | null = null;
export function setConfluentForbidden(path: string | null): void {
  forbidden = path;
}
/** For tests: a connector deleted. */
export function removeConfluentConnector(name: string): void {
  state.connectors = state.connectors.filter((c) => c.name !== name);
}
/** For tests: a cluster's phase (PROVISIONED, PROVISIONING, FAILED). */
export function setConfluentClusterPhase(id: string, phase: string): void {
  const c = state.clusters.find((x) => x.id === id);
  if (c) c.phase = phase;
}
/** For tests: a connector's state and its tasks' states. */
export function setConfluentConnector(name: string, connectorState: string, taskStates?: string[]): void {
  const c = state.connectors.find((x) => x.name === name);
  if (!c) return;
  c.state = connectorState;
  c.trace = connectorState === 'FAILED' ? 'There were some errors with your configuration: kafka.api.secret: Provided Kafka ApiKey is invalid' : '';
  if (taskStates)
    c.tasks = taskStates.map((st, id) => ({
      id,
      state: st,
      ...(st === 'FAILED' ? { msg: 'org.apache.kafka.connect.errors.ConnectException: task failed' } : {}),
    }));
}

const basic = (key: string, secret: string) => `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;

function authorized(req: FastifyRequest, reply: FastifyReply, cluster: boolean): boolean {
  const want = cluster ? basic(DEMO_CONFLUENT.clusterKey, DEMO_CONFLUENT.clusterSecret) : basic(DEMO_CONFLUENT.cloudKey, DEMO_CONFLUENT.cloudSecret);
  if (req.headers.authorization !== want) {
    void reply.code(401).send({ errors: [{ status: '401', detail: 'Unauthorized' }] });
    return false;
  }
  if (forbidden && req.url.split('?')[0]!.endsWith(forbidden)) {
    void reply.code(403).send({ errors: [{ status: '403', detail: 'Forbidden Access' }] });
    return false;
  }
  return true;
}

/** Where the mocks are: the origin and the path before /mock (a base path such as /steward included). */
function mockBase(req: FastifyRequest): string {
  return `${req.protocol}://${req.headers.host}${config.basePath}`;
}

const PAGE = 2;

/** One page of a list, with metadata.next (absolute, like Confluent) while more follow. */
function page<T>(req: FastifyRequest, path: string, all: T[], extra: Record<string, string> = {}, max = PAGE) {
  const q = req.query as Record<string, string | undefined>;
  const from = Math.max(0, Number(q.page_token ?? 0) || 0);
  const size = Math.min(max, Math.max(1, Number(q.page_size ?? max) || max));
  const data = all.slice(from, from + size);
  let next: string | null = null;
  if (from + size < all.length) {
    const u = new URL(`${mockBase(req)}/mock/confluent${path}`);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    u.searchParams.set('page_size', String(size));
    u.searchParams.set('page_token', String(from + size));
    next = u.toString();
  }
  return { api_version: 'iam/v2', kind: 'List', metadata: { next, total_size: all.length }, data };
}

/** The demo organisation's daily cost lines between two dates (YYYY-MM-DD, end exclusive). */
function costLines(start: string, end: string) {
  const out: Record<string, unknown>[] = [];
  const cluster = { id: DEMO_CONFLUENT.cluster, display_name: 'orders-cluster', environment: { id: DEMO_CONFLUENT.environment } };
  for (let t = Date.parse(`${start}T00:00:00Z`); t < Date.parse(`${end}T00:00:00Z`); t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    const next = new Date(t + DAY).toISOString().slice(0, 10);
    // 0.23.0: each line with its quantity, unit and list price, and a discount on the cluster's lines (invented figures)
    const line = (
      product: string,
      lineType: string,
      amount: number,
      resource: Record<string, unknown>,
      q: { quantity: number; unit: string; discountPct?: number },
    ) => {
      const original = q.discountPct ? Math.round((amount / (1 - q.discountPct / 100)) * 1e6) / 1e6 : amount;
      out.push({
        api_version: 'billing/v1',
        kind: 'Cost',
        start_date: day,
        end_date: next,
        granularity: 'DAILY',
        product,
        line_type: lineType,
        network_access_type: 'INTERNET',
        price: Math.round((original / q.quantity) * 1e6) / 1e6,
        quantity: q.quantity,
        unit: q.unit,
        original_amount: original,
        discount_amount: Math.round((original - amount) * 1e6) / 1e6,
        amount,
        resource,
      });
    };
    line('KAFKA', 'KAFKA_NUM_CKUS', 36, cluster, { quantity: 48, unit: 'CKU-hour', discountPct: 10 });
    line('KAFKA', 'KAFKA_STORAGE', 4.25, cluster, { quantity: 50, unit: 'GB-month', discountPct: 10 });
    line('KAFKA', 'KAFKA_NETWORK_WRITE', 1.5, cluster, { quantity: 30, unit: 'GB', discountPct: 10 });
    line(
      'CONNECT',
      'CONNECT_CAPACITY',
      7.2,
      { id: 'lcc-demo1', display_name: 'orders-s3-sink', environment: { id: DEMO_CONFLUENT.environment } },
      { quantity: 24, unit: 'Task-hour' },
    );
    line(
      'CONNECT',
      'CONNECT_THROUGHPUT',
      0.35,
      { id: 'lcc-demo2', display_name: 'shop-events-http-source', environment: { id: DEMO_CONFLUENT.environment } },
      { quantity: 14, unit: 'GB' },
    );
    line('KAFKA', 'KAFKA_BASE', 0.6, { id: 'lkc-demo2', display_name: 'sandbox', environment: { id: 'env-demo2' } }, { quantity: 24, unit: 'Hour' });
    line(
      'STREAM_GOVERNANCE',
      'GOVERNANCE_BASE',
      0.9,
      {
        id: DEMO_CONFLUENT.environment,
        display_name: 'demo',
        environment: { id: DEMO_CONFLUENT.environment },
      },
      { quantity: 24, unit: 'Hour' },
    );
  }
  return out;
}

export async function mockConfluent(app: FastifyInstance): Promise<void> {
  const R = '/confluent';
  app.get(`${R}/billing/v1/costs`, async (req, reply) => {
    if (!authorized(req, reply, false)) return reply;
    const q = req.query as Record<string, string | undefined>;
    const start = String(q.start_date ?? '');
    const end = String(q.end_date ?? '');
    const s0 = Date.parse(`${start}T00:00:00Z`);
    const e0 = Date.parse(`${end}T00:00:00Z`);
    if (!Number.isFinite(s0) || !Number.isFinite(e0) || e0 <= s0)
      return reply.code(400).send({ errors: [{ status: '400', detail: 'start_date and end_date (YYYY-MM-DD) are required, end after start' }] });
    if (e0 - s0 > 31 * DAY) return reply.code(400).send({ errors: [{ status: '400', detail: 'the date range is at most one month' }] });
    return { ...page(req, '/billing/v1/costs', costLines(start, end), { start_date: start, end_date: end }, 40), api_version: 'billing/v1', kind: 'CostList' };
  });
  // ---------- the readout (0.14.0, #123) ----------
  const env = (req: FastifyRequest) => String((req.query as Record<string, string | undefined>).environment ?? '');
  app.get(`${R}/org/v2/environments`, async (req, reply) =>
    authorized(req, reply, false)
      ? page(
          req,
          '/org/v2/environments',
          state.environments.map((e) => ({
            api_version: 'org/v2',
            kind: 'Environment',
            id: e.id,
            metadata: { created_at: '2024-01-15T09:00:00Z', resource_name: `${ORG}/environment=${e.id}` },
            display_name: e.display_name,
            ...(e.package ? { stream_governance_config: { package: e.package } } : {}),
          })),
        )
      : reply,
  );
  app.get(`${R}/cmk/v2/clusters`, async (req, reply) => {
    if (!authorized(req, reply, false)) return reply;
    // environment is required, like the real API
    if (!env(req)) return reply.code(400).send({ errors: [{ status: '400', detail: 'environment is required' }] });
    return page(
      req,
      '/cmk/v2/clusters',
      state.clusters
        .filter((c) => c.environment === env(req))
        .map((c) => ({
          api_version: 'cmk/v2',
          kind: 'Cluster',
          id: c.id,
          metadata: { created_at: c.created, resource_name: `${ORG}/environment=${c.environment}/cloud-cluster=${c.id}` },
          spec: {
            display_name: c.display_name,
            availability: c.availability,
            cloud: c.cloud,
            region: c.region,
            config: { kind: c.kind },
            kafka_bootstrap_endpoint: `SASL_SSL://${c.host}:9092`,
            http_endpoint: `https://${c.host}:443`,
            endpoints: { PUBLIC: { kafka_bootstrap_endpoint: `SASL_SSL://${c.host}:9092`, http_endpoint: `https://${c.host}:443`, connection_type: 'PUBLIC' } },
            environment: { id: c.environment },
          },
          status: { phase: c.phase },
        })),
      { environment: env(req) },
    );
  });
  app.get(`${R}/srcm/v3/clusters`, async (req, reply) => {
    if (!authorized(req, reply, false)) return reply;
    if (!env(req)) return reply.code(400).send({ errors: [{ status: '400', detail: 'environment is required' }] });
    const list =
      env(req) === DEMO_CONFLUENT.environment
        ? [
            {
              api_version: 'srcm/v3',
              kind: 'Cluster',
              id: 'lsrc-demo1',
              spec: {
                display_name: 'Stream Governance Package',
                package: 'ESSENTIALS',
                cloud: 'AWS',
                region: 'eu-central-1',
                http_endpoint: `${mockBase(req)}/mock/schema-registry`,
                environment: { id: DEMO_CONFLUENT.environment },
              },
              status: { phase: 'PROVISIONED' },
            },
          ]
        : [];
    return page(req, '/srcm/v3/clusters', list, { environment: env(req) });
  });
  app.get(`${R}/iam/v2/api-keys`, async (req, reply) =>
    authorized(req, reply, false)
      ? page(
          req,
          '/iam/v2/api-keys',
          // metadata only: the list never returns spec.secret
          state.apiKeys.map((k) => ({
            api_version: 'iam/v2',
            kind: 'ApiKey',
            id: k.id,
            metadata: { created_at: k.created_at, resource_name: `${ORG}/api-key=${k.id}` },
            spec: {
              display_name: k.display_name,
              description: k.description,
              owner: { id: k.owner.id, kind: k.owner.kind, api_version: 'iam/v2' },
              ...(k.resource
                ? { resource: { id: k.resource.id, kind: k.resource.kind, ...(k.resource.environment ? { environment: k.resource.environment } : {}) } }
                : {}),
              ...(k.expires_at ? { expires_at: k.expires_at } : {}),
            },
          })),
        )
      : reply,
  );
  // creating a key (for tests: a process that rotates a key through Steward): the answer holds the new secret, as
  // Confluent's does once; nothing is kept
  app.post(`${R}/iam/v2/api-keys`, async (req, reply) => {
    if (!authorized(req, reply, false)) return reply;
    const spec = ((req.body as { spec?: Record<string, unknown> } | null)?.spec ?? {}) as Record<string, unknown>;
    return reply.code(202).send({
      api_version: 'iam/v2',
      kind: 'ApiKey',
      id: 'NEWKEY01',
      metadata: { created_at: new Date().toISOString() },
      spec: { display_name: String(spec.display_name ?? ''), secret: DEMO_CONFLUENT.newKeySecret, owner: spec.owner ?? null },
    });
  });
  app.get(`${R}/connect/v1/environments/:env/clusters/:cluster/connectors`, async (req, reply) => {
    if (!authorized(req, reply, false)) return reply;
    const { env: e, cluster } = req.params as { env: string; cluster: string };
    if (!state.clusters.some((c) => c.id === cluster && c.environment === e))
      return reply.code(404).send({ error: { code: 404, message: `Kafka cluster ${cluster} not found in ${e}` } });
    const list = state.connectors.filter((c) => c.cluster === cluster);
    // expand=info,status,id (or the parameter repeated): a map of name → expansions; without: the names
    const raw = (req.query as Record<string, string | string[] | undefined>).expand;
    const expand = new Set((Array.isArray(raw) ? raw : [raw ?? '']).flatMap((x) => String(x).split(',')).map((x) => x.trim()));
    if (!expand.has('status') && !expand.has('info') && !expand.has('id')) return list.map((c) => c.name);
    return Object.fromEntries(
      list.map((c) => [
        c.name,
        {
          ...(expand.has('id') ? { id: { id: c.id, id_type: 'ID' } } : {}),
          ...(expand.has('info') ? { info: { name: c.name, type: c.type, config: { ...c.config } } } : {}),
          ...(expand.has('status')
            ? {
                status: {
                  name: c.name,
                  type: c.type,
                  connector: { state: c.state, worker_id: c.name, trace: c.trace },
                  tasks: c.tasks.map((t) => ({ id: t.id, state: t.state, worker_id: c.name, ...(t.msg ? { msg: t.msg } : {}) })),
                },
              }
            : {}),
        },
      ]),
    );
  });
  app.get(`${R}/iam/v2/users`, async (req, reply) =>
    authorized(req, reply, false)
      ? page(
          req,
          '/iam/v2/users',
          state.users.map((u) => ({ api_version: 'iam/v2', kind: 'User', ...u })),
        )
      : reply,
  );
  app.get(`${R}/iam/v2/service-accounts`, async (req, reply) =>
    authorized(req, reply, false)
      ? page(
          req,
          '/iam/v2/service-accounts',
          state.serviceAccounts.map((s) => ({ api_version: 'iam/v2', kind: 'ServiceAccount', ...s })),
        )
      : reply,
  );
  app.get(`${R}/iam/v2/role-bindings`, async (req, reply) => {
    if (!authorized(req, reply, false)) return reply;
    const crn = String((req.query as Record<string, string | undefined>).crn_pattern ?? '');
    if (!crn) return reply.code(400).send({ errors: [{ status: '400', detail: 'crn_pattern is required' }] });
    // a binding on the CRN or below it (a pattern ending in "=*" counts as the part before the *)
    const base = crn.endsWith('*') ? crn.slice(0, -1) : crn;
    const hits = state.bindings.filter((b) => b.crn_pattern === crn || b.crn_pattern.startsWith(base.endsWith('=') ? base : `${base}/`));
    return page(
      req,
      '/iam/v2/role-bindings',
      hits.map((b) => ({ api_version: 'iam/v2', kind: 'RoleBinding', ...b })),
      { crn_pattern: crn },
    );
  });
  app.get(`${R}/kafka-rest/kafka/v3/clusters/:cluster/acls`, async (req, reply) => {
    if (!authorized(req, reply, true)) return reply;
    const { cluster } = req.params as { cluster: string };
    if (cluster !== DEMO_CONFLUENT.cluster) return reply.code(404).send({ error_code: 404, message: 'Cluster not found' });
    return { kind: 'KafkaAclList', metadata: { next: null }, data: state.acls.map((a) => ({ kind: 'KafkaAcl', cluster_id: cluster, ...a })) };
  });
}
