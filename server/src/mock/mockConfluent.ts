import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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
 */

export const DEMO_CONFLUENT = {
  cloudKey: 'CLOUDKEY',
  cloudSecret: 'demo-confluent-cloud-secret',
  clusterKey: 'CLUSTERKEY',
  clusterSecret: 'demo-confluent-cluster-secret',
  org: 'org-demo',
  environment: 'env-demo1',
  cluster: 'lkc-demo1',
};

const ORG = `crn://confluent.cloud/organization=${DEMO_CONFLUENT.org}`;
const ENV = `${ORG}/environment=${DEMO_CONFLUENT.environment}`;
const CLUSTER = `${ENV}/cloud-cluster=${DEMO_CONFLUENT.cluster}`;

interface State {
  users: { id: string; email: string; full_name: string }[];
  serviceAccounts: { id: string; display_name: string; description: string }[];
  bindings: { id: string; principal: string; role_name: string; crn_pattern: string }[];
  acls: { resource_type: string; resource_name: string; pattern_type: string; principal: string; host: string; operation: string; permission: string }[];
}

function seed(): State {
  return {
    users: [
      { id: 'u-alice1', email: 'alice@example.com', full_name: 'Alice Admin' },
      { id: 'u-bob22', email: 'bob@example.com', full_name: 'Bob Builder' },
      { id: 'u-erika3', email: 'Erika.Mustermann@example.com', full_name: 'Erika Mustermann' },
    ],
    serviceAccounts: [
      { id: 'sa-orders', display_name: 'orders-service', description: 'Reads the orders topic' },
      { id: 'sa-billing', display_name: 'billing', description: 'Writes payments' },
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
}

const basic = (key: string, secret: string) => `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;

function authorized(req: FastifyRequest, reply: FastifyReply, cluster: boolean): boolean {
  const want = cluster ? basic(DEMO_CONFLUENT.clusterKey, DEMO_CONFLUENT.clusterSecret) : basic(DEMO_CONFLUENT.cloudKey, DEMO_CONFLUENT.cloudSecret);
  if (req.headers.authorization !== want) {
    void reply.code(401).send({ errors: [{ status: '401', detail: 'Unauthorized' }] });
    return false;
  }
  return true;
}

const PAGE = 2;

/** One page of a list, with metadata.next (absolute, like Confluent) while more follow. */
function page<T>(req: FastifyRequest, path: string, all: T[], extra: Record<string, string> = {}) {
  const q = req.query as Record<string, string | undefined>;
  const from = Math.max(0, Number(q.page_token ?? 0) || 0);
  const size = Math.min(PAGE, Math.max(1, Number(q.page_size ?? PAGE) || PAGE));
  const data = all.slice(from, from + size);
  let next: string | null = null;
  if (from + size < all.length) {
    const u = new URL(`${req.protocol}://${req.headers.host}/mock/confluent${path}`);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    u.searchParams.set('page_size', String(size));
    u.searchParams.set('page_token', String(from + size));
    next = u.toString();
  }
  return { api_version: 'iam/v2', kind: 'List', metadata: { next, total_size: all.length }, data };
}

export async function mockConfluent(app: FastifyInstance): Promise<void> {
  const R = '/confluent';
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
