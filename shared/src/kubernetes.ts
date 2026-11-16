/**
 * Kubernetes (#111): what Steward reads from a namespace, and how container images become tech stack entries.
 *
 * An image such as `docker.io/library/postgres:16.4-alpine` becomes PostgreSQL 16.4; the product comes from the last
 * part of the repository (`postgres`), the version from the leading numbers of the tag. Images Steward cannot map are
 * listed as "not mapped" instead of being guessed; administrators add their own images (End of life → settings).
 */

export interface ImageProductRule {
  /** The image repository, e.g. "postgres", "bitnami/redis" or "ghcr.io/acme/base-node" (matched at the end, case-insensitive) */
  image: string;
  /** endoflife.date product id */
  product: string;
}

/** Common official images and the endoflife.date product they run. */
export const BUILTIN_IMAGE_PRODUCTS: readonly ImageProductRule[] = [
  { image: 'postgres', product: 'postgresql' },
  { image: 'postgresql', product: 'postgresql' },
  { image: 'mysql', product: 'mysql' },
  { image: 'mariadb', product: 'mariadb' },
  { image: 'mongo', product: 'mongodb' },
  { image: 'mongodb', product: 'mongodb' },
  { image: 'redis', product: 'redis' },
  { image: 'valkey', product: 'valkey' },
  { image: 'memcached', product: 'memcached' },
  { image: 'rabbitmq', product: 'rabbitmq' },
  { image: 'elasticsearch', product: 'elasticsearch' },
  { image: 'kibana', product: 'kibana' },
  { image: 'nginx', product: 'nginx' },
  { image: 'httpd', product: 'apache-http-server' },
  { image: 'haproxy', product: 'haproxy' },
  { image: 'traefik', product: 'traefik' },
  { image: 'node', product: 'nodejs' },
  { image: 'python', product: 'python' },
  { image: 'php', product: 'php' },
  { image: 'ruby', product: 'ruby' },
  { image: 'golang', product: 'go' },
  { image: 'eclipse-temurin', product: 'eclipse-temurin' },
  { image: 'openjdk', product: 'openjdk-builds-from-oracle' },
  { image: 'tomcat', product: 'tomcat' },
  { image: 'alpine', product: 'alpine-linux' },
  { image: 'ubuntu', product: 'ubuntu' },
  { image: 'debian', product: 'debian' },
  { image: 'grafana', product: 'grafana' },
  { image: 'grafana/grafana', product: 'grafana' },
  { image: 'prometheus', product: 'prometheus' },
  { image: 'prom/prometheus', product: 'prometheus' },
  { image: 'keycloak', product: 'keycloak' },
  { image: 'keycloak/keycloak', product: 'keycloak' },
  { image: 'kafka', product: 'apache-kafka' },
  { image: 'zookeeper', product: 'zookeeper' },
];

/** The repository and tag of an image reference ("registry/path/name:tag@sha256:…"). */
export function splitImage(ref: string): { repository: string; tag: string } {
  const noDigest = ref.trim().split('@')[0]!;
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  // a colon after the last slash separates the tag; one before it belongs to a registry port
  return colon > slash ? { repository: noDigest.slice(0, colon), tag: noDigest.slice(colon + 1) } : { repository: noDigest, tag: 'latest' };
}

/** The version a tag names: its leading numbers ("16.4-alpine" → "16.4", "v2.4.1" → "2.4.1"); null for "latest" etc. */
export function tagVersion(tag: string): string | null {
  const m = /^v?(\d+(?:\.\d+){0,3})(?:$|[-_+.a-z])/i.exec(tag);
  return m ? m[1]! : null;
}

/** Leading and trailing "/" removed – a loop, not a regular expression (no backtracking on long inputs). */
function trimSlashes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '/') a++;
  while (b > a && s[b - 1] === '/') b--;
  return s.slice(a, b);
}

/** Strips the registry and "library/" from a repository: "docker.io/library/postgres" → "postgres". */
const shortRepository = (repository: string): string => {
  const parts = repository.toLowerCase().split('/');
  if (parts.length > 1 && (parts[0]!.includes('.') || parts[0]!.includes(':') || parts[0] === 'localhost')) parts.shift();
  if (parts[0] === 'library') parts.shift();
  return parts.join('/');
};

export interface MappedImage {
  image: string;
  product: string;
  /** The tag's version; empty when the tag names none (e.g. "latest") */
  version: string;
}

/**
 * The product of an image: the most specific rule whose image matches the end of the repository, own rules before the
 * built-in ones. null: not mapped.
 */
export function imageProduct(ref: string, own: readonly ImageProductRule[] = []): MappedImage | null {
  const { repository, tag } = splitImage(ref);
  const repo = shortRepository(repository);
  const full = repository.toLowerCase();
  const match = (r: ImageProductRule) => {
    const want = trimSlashes(r.image.toLowerCase());
    return full === want || repo === want || repo.endsWith(`/${want}`) || full.endsWith(`/${want}`);
  };
  const rule =
    [...own].sort((a, b) => b.image.length - a.image.length).find(match) ??
    // built-in rules only for the image's own name or its well-known path, never for "acme/postgres-backup"
    [...BUILTIN_IMAGE_PRODUCTS]
      .sort((a, b) => b.image.length - a.image.length)
      .find((r) => repo === r.image || (r.image.includes('/') && repo.endsWith(`/${r.image}`)));
  if (!rule) return null;
  return { image: ref, product: rule.product, version: tagVersion(tag) ?? '' };
}

/** What Steward read from a namespace (#111), kept on the component. */
export interface NamespaceReadout {
  readAt: string;
  /** null: read; else why not (no rights, cluster not reachable …) */
  error: string | null;
  deployments: { name: string; ready: number; desired: number; images: string[] }[];
  /** Pods that are not running well: crash-looping, failed, pending for long, many restarts */
  unhealthyPods: { name: string; reason: string; restarts: number }[];
  /** cert-manager Certificates; null when they were not read – certificatesState says why */
  certificates: { name: string; notAfter: string | null; ready: boolean }[] | null;
  /**
   * Whether the certificates were read (0.26.1); absent in readouts of earlier versions, where null certificates meant
   * "cert-manager not installed" – use namespaceCertificatesState().
   */
  certificatesState?: CertificatesState;
  /** Why the certificates could not be read (forbidden, failed); null otherwise */
  certificatesError?: string | null;
  /** Images Steward could not map to a product */
  unmapped: string[];
}

/**
 * The cert-manager certificates of a namespace are optional (0.26.1): a cluster without cert-manager, or a service
 * account without a rule for cert-manager.io, still has its deployments and pods read.
 * - read: read (the list may be empty)
 * - notInstalled: the cluster answered 404 – cert-manager is not installed
 * - forbidden: the cluster answered 403 – the service account may not list certificates
 * - off: the platform's variable certManager is off – Steward does not ask
 * - failed: any other failure of that one call (e.g. 5xx, timeout); certificatesError says why (null when the namespace
 *   itself was never read – its error says why)
 */
export const CERTIFICATES_STATES = ['read', 'notInstalled', 'forbidden', 'off', 'failed'] as const;
export type CertificatesState = (typeof CERTIFICATES_STATES)[number];

/** The state of a readout's certificates, also for readouts stored before 0.26.1 (no state: null meant "not installed"). */
export function namespaceCertificatesState(r: Pick<NamespaceReadout, 'certificates' | 'certificatesState'>): CertificatesState {
  return r.certificatesState ?? (r.certificates === null ? 'notInstalled' : 'read');
}

/**
 * Whether Steward reads cert-manager certificates from a Kubernetes platform: its variable certManager, on unless it
 * says off (also false, no, 0) – platforms created before 0.26.1 have no such variable and keep reading.
 */
export function readsCertManager(variables: Record<string, unknown> | undefined): boolean {
  const v = String(variables?.certManager ?? 'on')
    .trim()
    .toLowerCase();
  return !['off', 'false', 'no', '0'].includes(v);
}

export const KUBERNETES_LIMITS = {
  /** A namespace is read again after this many hours (the job), or on "Read now" */
  refreshHours: 6,
  /** Restarts from which a running pod counts as unhealthy */
  restartsUnhealthy: 5,
  /** A pod pending longer than this counts as unhealthy */
  pendingMinutes: 10,
  /** Own image rules at most */
  imageRules: 200,
} as const;
