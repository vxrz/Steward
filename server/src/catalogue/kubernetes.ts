import { imageProduct, KUBERNETES_LIMITS, type ImageProductRule, type NamespaceReadout, type Platform } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { platformRequest } from '../platforms/http.js';
import { platformFor } from '../monitors/platforms.js';
import { isKnownProduct, stackSummary, type StackDiff } from './components.js';
import { lifecycleSettings } from './lifecycle.js';

/**
 * Kubernetes namespaces of applications (#111): a component of type kubernetes-namespace names a cluster (a platform
 * of kind kubernetes, read-only service account token) and a namespace. Steward reads its deployments with their
 * images, the pods that are not well, and cert-manager certificates; the images that map to a product become the
 * component's tech stack (source "cluster"; entries entered by hand win), so end-of-life checks cover them.
 */

export const KUBERNETES_KIND = 'kubernetes';

const ns = (n: string) => encodeURIComponent(n);

async function get(platform: Platform, secrets: Record<string, string>, path: string, optional = false): Promise<Record<string, unknown> | null> {
  const r = await platformRequest(platform, secrets, { method: 'GET', url: path, headers: { accept: 'application/json' } }, AbortSignal.timeout(30000));
  if (r.ok) return r.body as Record<string, unknown>;
  if (optional && r.status === 404) return null;
  const msg = (r.body as { message?: string } | null)?.message;
  if (r.status === 401) throw new Error('the cluster refused the token (401) – check the service account token');
  if (r.status === 403) throw new Error(`no permission (403)${msg ? `: ${String(msg).slice(0, 200)}` : ''} – see the read-only role in docs/KUBERNETES.md`);
  throw new Error(`the cluster answered HTTP ${r.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`);
}

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Reads a namespace: deployments, unhealthy pods, cert-manager certificates. */
export async function readNamespace(
  platform: Platform,
  secrets: Record<string, string>,
  namespace: string,
  now = Date.now(),
): Promise<Omit<NamespaceReadout, 'unmapped' | 'readAt' | 'error'>> {
  const deps = ((await get(platform, secrets, `/apis/apps/v1/namespaces/${ns(namespace)}/deployments`))?.items ?? []) as Obj[];
  const pods = ((await get(platform, secrets, `/api/v1/namespaces/${ns(namespace)}/pods`))?.items ?? []) as Obj[];
  const certs = await get(platform, secrets, `/apis/cert-manager.io/v1/namespaces/${ns(namespace)}/certificates`, true);
  const deployments = deps.map((d) => ({
    name: String(d.metadata?.name ?? ''),
    desired: Number(d.spec?.replicas ?? 1),
    ready: Number(d.status?.readyReplicas ?? 0),
    images: [...(d.spec?.template?.spec?.initContainers ?? []), ...(d.spec?.template?.spec?.containers ?? [])]
      .map((c: Obj) => String(c.image ?? ''))
      .filter(Boolean),
  }));
  const unhealthyPods: NamespaceReadout['unhealthyPods'] = [];
  for (const p of pods) {
    const statuses = (p.status?.containerStatuses ?? []) as Obj[];
    const restarts = statuses.reduce((n, c) => n + Number(c.restartCount ?? 0), 0);
    const waiting = statuses.map((c) => c.state?.waiting?.reason).find((r) => r && r !== 'ContainerCreating');
    const phase = String(p.status?.phase ?? '');
    const age = (now - Date.parse(String(p.metadata?.creationTimestamp ?? ''))) / 60_000;
    const reason = waiting
      ? String(waiting)
      : phase === 'Failed'
        ? 'Failed'
        : phase === 'Pending' && age > KUBERNETES_LIMITS.pendingMinutes
          ? 'Pending'
          : restarts >= KUBERNETES_LIMITS.restartsUnhealthy
            ? `${restarts} restarts`
            : null;
    if (reason && phase !== 'Succeeded') unhealthyPods.push({ name: String(p.metadata?.name ?? ''), reason, restarts });
  }
  const certificates =
    certs === null
      ? null
      : ((certs.items ?? []) as Obj[]).map((c) => ({
          name: String(c.metadata?.name ?? ''),
          notAfter: c.status?.notAfter ? String(c.status.notAfter) : null,
          ready: ((c.status?.conditions ?? []) as Obj[]).some((x) => x.type === 'Ready' && x.status === 'True'),
        }));
  return { deployments, unhealthyPods, certificates };
}

/** Numeric comparison of versions: the oldest one wins when several images run the same product. */
export const older = (a: string, b: string): boolean => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
};

/** Images → products (own rules first), the oldest version per product; images without a known product are "unmapped". */
export function mapImages(images: string[], own: readonly ImageProductRule[]): { found: Map<string, { version: string; ref: string }>; unmapped: string[] } {
  const found = new Map<string, { version: string; ref: string }>();
  const unmapped: string[] = [];
  for (const image of [...new Set(images)]) {
    const m = imageProduct(image, own);
    if (!m || !isKnownProduct(m.product)) {
      unmapped.push(image);
      continue;
    }
    const prev = found.get(m.product);
    if (!prev || (m.version && (!prev.version || older(m.version, prev.version)))) found.set(m.product, { version: m.version, ref: image });
  }
  return { found, unmapped: unmapped.sort() };
}

interface Row {
  id: string;
  application_id: string;
  name: string;
  environment: string;
  platform_id: string | null;
  updated_by: string;
}

/** The entries of one source (cluster: the images; repository: its files) follow what was read; entries entered by hand or from an SBOM stay. */
export function syncStack(
  componentId: string,
  found: Map<string, { version: string; ref: string }>,
  actor: string,
  now: string,
  source: 'cluster' | 'repository' = 'cluster',
): StackDiff {
  const diff: StackDiff = { added: [], changed: [], removed: [] };
  const before = new Map(
    db()
      .all<{ product: string; version: string; source: string }>('SELECT product, version, source FROM component_stack WHERE component_id = ?', componentId)
      .map((r) => [r.product, r]),
  );
  for (const [product, f] of found) {
    const old = before.get(product);
    if (!old) {
      db().run(
        'INSERT INTO component_stack (component_id, product, version, source, sbom_ref, set_at, set_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        componentId,
        product,
        f.version,
        source,
        f.ref,
        now,
        actor,
      );
      diff.added.push({ product, version: f.version });
    } else if (old.source === source && old.version !== f.version) {
      db().run(
        'UPDATE component_stack SET version = ?, sbom_ref = ?, set_at = ?, set_by = ? WHERE component_id = ? AND product = ?',
        f.version,
        f.ref,
        now,
        actor,
        componentId,
        product,
      );
      diff.changed.push({ product, from: old.version, to: f.version });
    }
  }
  for (const [product, old] of before)
    if (old.source === source && !found.has(product)) {
      db().run('DELETE FROM component_stack WHERE component_id = ? AND product = ?', componentId, product);
      diff.removed.push({ product, version: old.version });
    }
  return diff;
}

/**
 * Reads the namespace of a component now, with the rights of `actor` on the cluster platform, and stores what it found.
 * A read that fails keeps the stack and records the error.
 */
export async function refreshNamespace(componentId: string, actor: string, now = Date.now()): Promise<NamespaceReadout> {
  const c = db().get<Row>("SELECT * FROM application_components WHERE id = ? AND type = 'kubernetes-namespace'", componentId);
  if (!c) throw new HttpError(404, `Component ${componentId} not found`, 'COMPONENT_NOT_FOUND', { id: componentId });
  if (!c.platform_id) throw new HttpError(400, 'Choose the cluster of the namespace first', 'COMPONENT_CLUSTER_REQUIRED');
  const at = new Date(now).toISOString();
  let readout: NamespaceReadout;
  let diff: StackDiff = { added: [], changed: [], removed: [] };
  try {
    const { platform, secrets } = platformFor(actor, c.platform_id);
    const r = await readNamespace(platform, secrets, c.name, now);
    const { found, unmapped } = mapImages(
      r.deployments.flatMap((d) => d.images),
      lifecycleSettings().imageMap ?? [],
    );
    readout = { readAt: at, error: null, ...r, unmapped };
    db().tx(() => {
      diff = syncStack(componentId, found, actor, nowIso());
    });
  } catch (e) {
    const prev = parseJson<NamespaceReadout | null>(
      db().get<{ cluster_state: string | null }>('SELECT cluster_state FROM application_components WHERE id = ?', componentId)?.cluster_state ?? null,
      null,
    );
    readout = { ...(prev ?? { deployments: [], unhealthyPods: [], certificates: null, unmapped: [] }), readAt: at, error: (e as Error).message.slice(0, 500) };
  }
  db().run('UPDATE application_components SET cluster_state = ? WHERE id = ?', JSON.stringify(readout), componentId);
  if (diff.added.length || diff.changed.length || diff.removed.length)
    audit({
      action: 'application.component_cluster_read',
      entityType: 'application',
      entityId: c.application_id,
      actor,
      summary: `Tech stack of the namespace "${c.name}"${c.environment ? ` (${c.environment})` : ''} read from the cluster: ${stackSummary(diff)}`,
      details: { componentId, ...diff },
    });
  return readout;
}

/** The job: every namespace with a cluster, read again after KUBERNETES_LIMITS.refreshHours, as whoever last changed the component. */
export async function runKubernetesJob(now = Date.now()): Promise<number> {
  if (!vault().unlocked) return 0;
  const rows = db().all<Row & { cluster_state: string | null }>(
    `SELECT c.* FROM application_components c JOIN applications a ON a.id = c.application_id
     WHERE c.type = 'kubernetes-namespace' AND c.platform_id IS NOT NULL AND a.archived = 0`,
  );
  let n = 0;
  for (const r of rows) {
    const last = parseJson<NamespaceReadout | null>(r.cluster_state, null);
    if (last && now - Date.parse(last.readAt) < KUBERNETES_LIMITS.refreshHours * 3_600_000) continue;
    try {
      await refreshNamespace(r.id, r.updated_by, now);
      n++;
    } catch (err) {
      logger.warn({ err, component: r.id }, 'reading a Kubernetes namespace failed');
    }
  }
  return n;
}
