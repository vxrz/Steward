import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Simulated Kubernetes API server for demo mode and tests, mounted at /mock/kubernetes (#111). Only what Steward reads,
 * with the shapes of the real API (apps/v1, core/v1, cert-manager.io/v1):
 *   GET /version
 *   GET /apis/apps/v1/namespaces/{ns}/deployments[/{name}]
 *   GET /api/v1/namespaces/{ns}/pods
 *   GET /apis/cert-manager.io/v1/namespaces/{ns}/certificates   (404 when cert-manager is "not installed")
 * Authentication: `Authorization: Bearer <service account token>`; the namespace "forbidden" answers 403 like RBAC does.
 */

export const DEMO_KUBERNETES = { token: 'demo-k8s-service-account-token' };

interface Deployment {
  name: string;
  replicas: number;
  ready: number;
  images: string[];
}
interface Pod {
  name: string;
  phase: string;
  restarts: number;
  waiting?: string;
  ageMinutes: number;
}
interface Ns {
  deployments: Deployment[];
  pods: Pod[];
  certificates: { name: string; days: number; ready: boolean }[];
}

const DAY = 86_400_000;

function seed(): Record<string, Ns> {
  return {
    'shop-prod': {
      deployments: [
        { name: 'web', replicas: 3, ready: 3, images: ['ghcr.io/acme/shop-web:2.4.1', 'nginx:1.27.3-alpine'] },
        { name: 'db', replicas: 1, ready: 1, images: ['docker.io/library/postgres:16.4'] },
        { name: 'worker', replicas: 2, ready: 1, images: ['node:24-alpine'] },
      ],
      pods: [
        { name: 'web-7f9c-a1', phase: 'Running', restarts: 0, ageMinutes: 3000 },
        { name: 'web-7f9c-b2', phase: 'Running', restarts: 1, ageMinutes: 3000 },
        { name: 'web-7f9c-c3', phase: 'Running', restarts: 0, ageMinutes: 3000 },
        { name: 'db-0', phase: 'Running', restarts: 0, ageMinutes: 9000 },
        { name: 'worker-5d4b-x1', phase: 'Running', restarts: 0, ageMinutes: 600 },
        { name: 'worker-5d4b-y2', phase: 'Running', restarts: 14, waiting: 'CrashLoopBackOff', ageMinutes: 600 },
      ],
      certificates: [
        { name: 'shop-tls', days: 10, ready: true },
        { name: 'api-tls', days: 80, ready: true },
      ],
    },
    'shop-test': {
      deployments: [
        { name: 'web', replicas: 1, ready: 1, images: ['ghcr.io/acme/shop-web:2.5.0-rc1'] },
        { name: 'db', replicas: 1, ready: 1, images: ['postgres:15.8-alpine'] },
      ],
      pods: [
        { name: 'web-1', phase: 'Running', restarts: 0, ageMinutes: 100 },
        { name: 'db-0', phase: 'Running', restarts: 0, ageMinutes: 100 },
      ],
      certificates: [],
    },
  };
}

let data = seed();
let certManager = true;

/** For tests: change a deployment, or say whether cert-manager is installed. */
export function setDeployment(ns: string, name: string, patch: Partial<Deployment>): void {
  const d = data[ns]?.deployments.find((x) => x.name === name);
  if (d) Object.assign(d, patch);
}
export function setCertManager(installed: boolean): void {
  certManager = installed;
}
export function resetKubernetes(): void {
  data = seed();
  certManager = true;
}

const status = (reply: FastifyReply, code: number, reason: string, message: string) =>
  reply.code(code).send({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message, reason, code });

function allowed(req: FastifyRequest, reply: FastifyReply, ns?: string): boolean {
  if (req.headers.authorization !== `Bearer ${DEMO_KUBERNETES.token}`) {
    void status(reply, 401, 'Unauthorized', 'Unauthorized');
    return false;
  }
  if (ns === 'forbidden') {
    void status(
      reply,
      403,
      'Forbidden',
      `deployments.apps is forbidden: User "system:serviceaccount:steward:reader" cannot list resource in the namespace "${ns}"`,
    );
    return false;
  }
  return true;
}

const deployment = (ns: string, d: Deployment) => ({
  metadata: { name: d.name, namespace: ns },
  spec: { replicas: d.replicas, template: { spec: { containers: d.images.map((image, i) => ({ name: i === 0 ? d.name : `sidecar-${i}`, image })) } } },
  status: { replicas: d.replicas, readyReplicas: d.ready || undefined, availableReplicas: d.ready || undefined },
});

export async function mockKubernetes(app: FastifyInstance): Promise<void> {
  app.get('/kubernetes/version', async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    return { major: '1', minor: '31', gitVersion: 'v1.31.4', platform: 'linux/amd64' };
  });
  app.get('/kubernetes/apis/apps/v1/namespaces/:ns/deployments', async (req, reply) => {
    const { ns } = req.params as { ns: string };
    if (!allowed(req, reply, ns)) return reply;
    return { kind: 'DeploymentList', apiVersion: 'apps/v1', items: (data[ns]?.deployments ?? []).map((d) => deployment(ns, d)) };
  });
  app.get('/kubernetes/apis/apps/v1/namespaces/:ns/deployments/:name', async (req, reply) => {
    const { ns, name } = req.params as { ns: string; name: string };
    if (!allowed(req, reply, ns)) return reply;
    const d = data[ns]?.deployments.find((x) => x.name === name);
    return d ? deployment(ns, d) : status(reply, 404, 'NotFound', `deployments.apps "${name}" not found`);
  });
  app.get('/kubernetes/api/v1/namespaces/:ns/pods', async (req, reply) => {
    const { ns } = req.params as { ns: string };
    if (!allowed(req, reply, ns)) return reply;
    return {
      kind: 'PodList',
      apiVersion: 'v1',
      items: (data[ns]?.pods ?? []).map((p) => ({
        metadata: { name: p.name, namespace: ns, creationTimestamp: new Date(Date.now() - p.ageMinutes * 60_000).toISOString() },
        status: {
          phase: p.phase,
          containerStatuses: [
            {
              name: 'main',
              ready: !p.waiting && p.phase === 'Running',
              restartCount: p.restarts,
              state: p.waiting ? { waiting: { reason: p.waiting } } : { running: { startedAt: new Date().toISOString() } },
            },
          ],
        },
      })),
    };
  });
  app.get('/kubernetes/apis/cert-manager.io/v1/namespaces/:ns/certificates', async (req, reply) => {
    const { ns } = req.params as { ns: string };
    if (!allowed(req, reply, ns)) return reply;
    if (!certManager) return status(reply, 404, 'NotFound', 'the server could not find the requested resource');
    return {
      kind: 'CertificateList',
      apiVersion: 'cert-manager.io/v1',
      items: (data[ns]?.certificates ?? []).map((c) => ({
        metadata: { name: c.name, namespace: ns },
        status: {
          notAfter: new Date(Date.now() + c.days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          conditions: [{ type: 'Ready', status: c.ready ? 'True' : 'False' }],
        },
      })),
    };
  });
}
