import {
  CONFLUENT_KIND,
  CONFLUENT_READ_LIMITS,
  KAFKA_CONNECT_LIMITS,
  SCRUBBED,
  trimTrace,
  type ConfluentApiKey,
  type ConfluentCluster,
  type ConfluentConnector,
  type ConfluentEnvironment,
  type ConfluentPart,
  type ConfluentReadout,
  type ConfluentSchemaRegistry,
  type ConfluentServiceAccount,
  type ConfluentSubject,
  type ConnectTask,
  type Platform,
} from '@sm/shared';
import { HttpError } from '../util.js';
import { buildUrl, platformRequest } from '../platforms/http.js';
import { assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { CONFLUENT_LIMITS, confluentPages } from '../kafka/confluent.js';

/**
 * Reading Confluent Cloud (0.14.0, #123, docs/CONFLUENT.md), read-only, with the platform's Cloud API key:
 *
 *   GET /org/v2/environments                                          environments
 *   GET /cmk/v2/clusters?environment=env-…                            Kafka clusters of each environment
 *   GET /srcm/v3/clusters?environment=env-…                           Schema Registry clusters of each environment
 *   GET /iam/v2/service-accounts, /iam/v2/users                       service accounts (and who owns a key)
 *   GET /iam/v2/api-keys                                              API key metadata – the list never holds a secret
 *   GET /connect/v1/environments/env-…/clusters/lkc-…/connectors?expand=info,status,id   managed connectors
 *
 * and, when the variable schemaRegistryUrl and the credentials registryKey / registrySecret are set, the subjects of that
 * Schema Registry with its own key: GET /subjects, /config, /subjects/{s}/versions, /config/{s}.
 *
 * Lists are followed page by page on the API's own origin (confluentPages). Every part is read on its own: a part the
 * key may not read (e.g. API keys without OrganizationAdmin) keeps its error and the others stand. Requests go through
 * platformRequest: the outbound policy (the base URL and the Schema Registry URL are checked first), the kind's
 * read-only rule (deniedPaths.ts) and retries of 429 with Retry-After. Connector configurations are never kept – only
 * the class, the type and the topics are taken from them, and an error trace has the configuration's secret-looking
 * values removed.
 */

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');
const cut = (x: unknown, n = 200) => str(x).slice(0, n);
const SAFE_ID = (s: string) => !!s && s.length <= 100 && [...s].every((c) => /[A-Za-z0-9._-]/.test(c));

/** The base URL is allowed by the outbound policy (an allow-list policy may leave out even the platform's own origin). */
export async function assertConfluentOutbound(platform: Platform, secrets: Record<string, string>): Promise<void> {
  if (platform.kind !== CONFLUENT_KIND) throw new HttpError(400, 'Choose a Confluent Cloud platform', 'CONFLUENT_PLATFORM');
  if (!platform.baseUrl) throw new HttpError(400, 'The Confluent Cloud platform has no base URL', 'CONFLUENT_BASE_URL');
  await assertOutboundAllowed(await buildUrl(platform, secrets, '/'), outboundContext());
}

const pages = <T>(platform: Platform, secrets: Record<string, string>, path: string, query: Record<string, string>, what: string, forbidden: string) =>
  confluentPages<T>(platform, secrets, path, query, what, forbidden);

const ORG_ROLE = 'the API key may not read this (its service account needs OrganizationAdmin, or EnvironmentAdmin on each environment)';

export async function readEnvironments(platform: Platform, secrets: Record<string, string>): Promise<ConfluentEnvironment[]> {
  const list = await pages<Obj>(platform, secrets, '/org/v2/environments', {}, 'Confluent Cloud (environments)', ORG_ROLE);
  return list
    .map((e) => ({
      id: cut(e.id, 100),
      name: cut(e.display_name) || cut(e.id, 100),
      governance: isObj(e.stream_governance_config) ? cut(e.stream_governance_config.package, 40) || null : null,
    }))
    .filter((e) => SAFE_ID(e.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, CONFLUENT_READ_LIMITS.environments);
}

/** The public bootstrap endpoint of a cluster: endpoints.PUBLIC, else the deprecated kafka_bootstrap_endpoint (without SASL_SSL://). */
function bootstrapOf(spec: Obj): string | null {
  const eps = isObj(spec.endpoints) ? spec.endpoints : {};
  const pub = isObj(eps.PUBLIC) ? eps.PUBLIC : Object.values(eps).find(isObj);
  let b = cut(isObj(pub) ? pub.kafka_bootstrap_endpoint : undefined, 300) || cut(spec.kafka_bootstrap_endpoint, 300);
  const scheme = b.indexOf('://');
  if (scheme >= 0) b = b.slice(scheme + 3);
  return b || null;
}

export async function readClusters(platform: Platform, secrets: Record<string, string>, envs: ConfluentEnvironment[]): Promise<ConfluentCluster[]> {
  const out: ConfluentCluster[] = [];
  for (const env of envs) {
    const list = await pages<Obj>(platform, secrets, '/cmk/v2/clusters', { environment: env.id }, 'Confluent Cloud (Kafka clusters)', ORG_ROLE);
    for (const c of list) {
      const spec = isObj(c.spec) ? c.spec : {};
      const status = isObj(c.status) ? c.status : {};
      const config = isObj(spec.config) ? spec.config : {};
      const cku = Number(status.cku ?? config.cku);
      out.push({
        id: cut(c.id, 100),
        name: cut(spec.display_name) || cut(c.id, 100),
        environmentId: env.id,
        type: cut(config.kind, 40),
        cloud: cut(spec.cloud, 20),
        region: cut(spec.region, 60),
        availability: cut(spec.availability, 40),
        phase: cut(status.phase, 40).toUpperCase() || 'PROVISIONED',
        cku: Number.isFinite(cku) && cku > 0 ? cku : null,
        bootstrap: bootstrapOf(spec),
      });
    }
  }
  return out
    .filter((c) => SAFE_ID(c.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, CONFLUENT_READ_LIMITS.clusters);
}

export async function readSchemaRegistries(
  platform: Platform,
  secrets: Record<string, string>,
  envs: ConfluentEnvironment[],
): Promise<ConfluentSchemaRegistry[]> {
  const out: ConfluentSchemaRegistry[] = [];
  for (const env of envs) {
    const list = await pages<Obj>(platform, secrets, '/srcm/v3/clusters', { environment: env.id }, 'Confluent Cloud (Schema Registry clusters)', ORG_ROLE);
    for (const c of list) {
      const spec = isObj(c.spec) ? c.spec : {};
      const status = isObj(c.status) ? c.status : {};
      out.push({
        id: cut(c.id, 100),
        environmentId: env.id,
        package: cut(spec.package, 40),
        cloud: cut(spec.cloud, 20),
        region: cut(spec.region, 60),
        endpoint: cut(spec.http_endpoint, 300),
        phase: cut(status.phase, 40).toUpperCase(),
      });
    }
  }
  return out.filter((c) => SAFE_ID(c.id)).slice(0, CONFLUENT_READ_LIMITS.environments);
}

export async function readServiceAccounts(platform: Platform, secrets: Record<string, string>): Promise<ConfluentServiceAccount[]> {
  const list = await pages<Obj>(platform, secrets, '/iam/v2/service-accounts', {}, 'Confluent Cloud (service accounts)', ORG_ROLE);
  return list
    .map((s) => ({ id: cut(s.id, 100), name: cut(s.display_name) || cut(s.id, 100), description: cut(s.description, 500) }))
    .filter((s) => SAFE_ID(s.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, CONFLUENT_READ_LIMITS.serviceAccounts);
}

/**
 * The API keys' metadata: id, name, owner, resource, created, expires – never `spec.secret` (the list does not return
 * it, and it is not taken if it ever did). Owners are named from the service accounts and users.
 */
export async function readApiKeys(platform: Platform, secrets: Record<string, string>, accounts: ConfluentServiceAccount[]): Promise<ConfluentApiKey[]> {
  const keys = await pages<Obj>(
    platform,
    secrets,
    '/iam/v2/api-keys',
    {},
    'Confluent Cloud (API keys)',
    'the API key may not list API keys (its service account needs OrganizationAdmin)',
  );
  const needUsers = keys.some((k) => isObj(k.spec) && isObj(k.spec.owner) && str(k.spec.owner.id).startsWith('u-'));
  // a key that may list API keys but not users: the owners are named by their ids
  const users = needUsers ? await pages<Obj>(platform, secrets, '/iam/v2/users', {}, 'Confluent Cloud (users)', ORG_ROLE).catch(() => [] as Obj[]) : [];
  const names = new Map<string, string>([
    ...accounts.map((a): [string, string] => [a.id, a.name]),
    ...users.map((u): [string, string] => [cut(u.id, 100), cut(u.full_name) || cut(u.email)]),
  ]);
  return keys
    .map((k): ConfluentApiKey => {
      const spec = isObj(k.spec) ? k.spec : {};
      const meta = isObj(k.metadata) ? k.metadata : {};
      const owner = isObj(spec.owner) ? spec.owner : {};
      const res = isObj(spec.resource) ? spec.resource : null;
      const env = res && isObj(res.environment) ? cut(res.environment.id, 100) : '';
      const ownerId = cut(owner.id, 100);
      return {
        id: cut(k.id, 100),
        name: cut(spec.display_name),
        description: cut(spec.description, 500),
        ownerId,
        ownerKind: cut(owner.kind, 40),
        ownerName: names.get(ownerId) || null,
        resourceId: res ? cut(res.id, 100) || null : null,
        resourceKind: res ? cut(res.kind, 40) || null : null,
        environmentId: env || null,
        createdAt: cut(meta.created_at, 40) || null,
        expiresAt: cut(spec.expires_at, 40) || null,
      };
    })
    .filter((k) => SAFE_ID(k.id))
    .sort((a, b) => (a.ownerName ?? a.ownerId).localeCompare(b.ownerName ?? b.ownerId) || a.id.localeCompare(b.id))
    .slice(0, CONFLUENT_READ_LIMITS.apiKeys);
}

/** Topics in a configuration value (comma-separated), without masked ones. */
const topicList = (...vals: unknown[]): string[] => [
  ...new Set(
    vals
      .flatMap((v) => str(v).split(','))
      .map((x) => x.trim())
      .filter((x) => x && x !== SCRUBBED && !x.startsWith('*')),
  ),
];

/** The values of a configuration that look secret (to remove them from an error trace). */
function configSecrets(config: Obj): string[] {
  return Object.entries(config)
    .filter(([k, v]) => typeof v === 'string' && v.length >= 4 && /pass|secret|token|key|credential|jaas|auth/i.test(k) && !/^(\*+|\$\{.*\})$/.test(v))
    .map(([, v]) => v as string);
}

function task(t: unknown, before: ConnectTask | undefined, now: string, secrets: string[]): ConnectTask | null {
  if (!isObj(t)) return null;
  const state = str(t.state).toUpperCase() || 'UNASSIGNED';
  const failed = state === 'FAILED';
  const msg = str(t.trace) || str(t.msg);
  return {
    id: Number(t.id) || 0,
    state,
    workerId: cut(t.worker_id),
    trace: failed && msg ? trimTrace(msg, secrets) : null,
    failedSince: failed ? (before?.state === 'FAILED' && before.failedSince ? before.failedSince : now) : null,
  };
}

/** One managed connector from its expansion (id, info, status); the configuration is only read for class, type and topics. */
export function toConfluentConnector(
  name: string,
  x: Obj,
  cluster: Pick<ConfluentCluster, 'id' | 'environmentId'>,
  before: ConfluentConnector | undefined,
  now: string,
): ConfluentConnector {
  const info = isObj(x.info) ? x.info : {};
  const config = isObj(info.config) ? info.config : {};
  const status = isObj(x.status) ? x.status : {};
  const c = isObj(status.connector) ? status.connector : {};
  const id = isObj(x.id) ? cut(x.id.id, 100) : '';
  const typeRaw = (str(status.type) || str(info.type) || str(config.type)).toLowerCase();
  const type = typeRaw === 'source' || typeRaw === 'sink' ? typeRaw : 'unknown';
  const state = str(c.state).toUpperCase() || 'NONE';
  const secrets = configSecrets(config);
  const tasks = (Array.isArray(status.tasks) ? status.tasks : [])
    .map((t) =>
      task(
        t,
        before?.tasks.find((b) => isObj(t) && b.id === Number(t.id)),
        now,
        secrets,
      ),
    )
    .filter((t): t is ConnectTask => !!t)
    .sort((a, b) => a.id - b.id);
  const trace = str(c.trace);
  return {
    id,
    name: name.slice(0, 255),
    clusterId: cluster.id,
    environmentId: cluster.environmentId,
    type,
    class: cut(config['connector.class'], 300),
    state,
    trace: (state === 'FAILED' || state === 'DEGRADED') && trace ? trimTrace(trace, secrets) : null,
    tasks,
    topics: topicList(config.topics, config['kafka.topic']).slice(0, KAFKA_CONNECT_LIMITS.topics),
  };
}

/** The managed connectors of one cluster (one request: a map of name → {id, info, status}). */
export async function readConnectorsOf(
  platform: Platform,
  secrets: Record<string, string>,
  cluster: Pick<ConfluentCluster, 'id' | 'environmentId'>,
  before: ConfluentConnector[],
  now: string,
): Promise<ConfluentConnector[]> {
  const path = `/connect/v1/environments/${encodeURIComponent(cluster.environmentId)}/clusters/${encodeURIComponent(cluster.id)}/connectors`;
  const r = await platformRequest(
    platform,
    secrets,
    { method: 'GET', url: path, query: { expand: 'info,status,id' }, maxResponseBytes: 16 * 1024 * 1024, noRedirects: true },
    AbortSignal.timeout(CONFLUENT_LIMITS.timeoutMs),
  );
  if (!r.ok)
    throw new Error(
      `Confluent Cloud (connectors of ${cluster.id}) answered HTTP ${r.status}${r.status === 401 ? ' – check the API key and secret' : r.status === 403 ? ' – the API key may not read the connectors (its service account needs a role on the cluster, e.g. CloudClusterAdmin or ConnectManager)' : ''}`,
    );
  const body = isObj(r.body) ? r.body : {};
  return Object.entries(body)
    .filter(([k, v]) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype' && isObj(v))
    .slice(0, CONFLUENT_READ_LIMITS.connectors)
    .map(([name, v]) =>
      toConfluentConnector(
        name,
        v as Obj,
        cluster,
        before.find((b) => b.clusterId === cluster.id && b.name === name),
        now,
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Schema Registry ----------

const trimSlashes = (s: string) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
};

/** The Schema Registry the variable schemaRegistryUrl names (https or http), or null when it is not set. */
export function registryTarget(platform: Platform): string | null {
  const raw = String(platform.config.variables?.schemaRegistryUrl ?? '').trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'The variable schemaRegistryUrl is not a URL', 'CONFLUENT_REGISTRY_URL', { url: raw.slice(0, 100) });
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password)
    throw new HttpError(400, 'The variable schemaRegistryUrl is not a URL', 'CONFLUENT_REGISTRY_URL', { url: raw.slice(0, 100) });
  return trimSlashes(u.origin + u.pathname);
}

/** The Schema Registry as a platform of its own: its URL as the base URL, basic auth with its own key. */
function registryPlatform(platform: Platform, url: string): Platform {
  return {
    ...platform,
    baseUrl: url,
    config: { ...platform.config, auth: { type: 'basic' }, http: { ...platform.config.http, defaultHeaders: {}, trustedOrigins: [] }, testPath: undefined },
  };
}

class RegistryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The subjects of the Schema Registry with their versions and compatibility. The URL goes through the outbound policy
 * like any other host (a platform's origin – e.g. the Kafka platform whose base URL it is – or the allow-list).
 */
export async function readSubjects(platform: Platform, secrets: Record<string, string>, url: string): Promise<NonNullable<ConfluentReadout['registry']>> {
  await assertOutboundAllowed(url, outboundContext());
  const reg = registryPlatform(platform, url);
  const creds = { username: secrets.registryKey ?? '', password: secrets.registrySecret ?? '' };
  const get = async (path: string, query?: Record<string, unknown>): Promise<unknown> => {
    const r = await platformRequest(
      reg,
      creds,
      {
        method: 'GET',
        url: path,
        query,
        headers: { accept: 'application/vnd.schemaregistry.v1+json, application/json' },
        maxResponseBytes: 8 * 1024 * 1024,
        noRedirects: true,
      },
      AbortSignal.timeout(CONFLUENT_LIMITS.timeoutMs),
    );
    if (r.ok) return r.body;
    throw new RegistryError(
      `The Schema Registry answered HTTP ${r.status} for GET ${path.split('?')[0]}${r.status === 401 ? ' – check registryKey and registrySecret (a key of this Schema Registry)' : ''}`,
      r.status,
    );
  };
  // the subjects, page by page (offset/limit), up to CONFLUENT_READ_LIMITS.subjects
  const names: string[] = [];
  const page = 500;
  let truncated = false;
  for (let offset = 0; ; offset += page) {
    const body = await get('/subjects', { offset, limit: page });
    const list = Array.isArray(body) ? body.map(str).filter(Boolean) : [];
    names.push(...list);
    if (names.length >= CONFLUENT_READ_LIMITS.subjects) {
      truncated = names.length > CONFLUENT_READ_LIMITS.subjects || list.length === page;
      break;
    }
    if (list.length < page) break;
  }
  const subjects = [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(0, CONFLUENT_READ_LIMITS.subjects);
  // a registry that does not show its level (a key without the right to read it): the subjects' own levels still count
  const global = await get('/config').catch(() => null);
  const globalLevel = isObj(global) ? cut(global.compatibilityLevel ?? global.compatibility, 40) || null : null;
  const out: ConfluentSubject[] = subjects.map((name) => ({
    name: name.slice(0, 300),
    versions: null,
    latest: null,
    compatibility: null,
    ownCompatibility: false,
  }));
  // versions and compatibility of the first subjectDetails subjects, a few at a time
  const detail = out.slice(0, CONFLUENT_READ_LIMITS.subjectDetails);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const s = detail[next++];
      if (!s) return;
      const enc = encodeURIComponent(s.name);
      const versions = await get(`/subjects/${enc}/versions`);
      const nums = Array.isArray(versions) ? versions.map(Number).filter((n) => Number.isInteger(n)) : [];
      s.versions = nums.length;
      s.latest = nums.length ? Math.max(...nums) : null;
      try {
        const c = await get(`/config/${enc}`);
        const level = isObj(c) ? cut(c.compatibilityLevel ?? c.compatibility, 40) : '';
        s.compatibility = level || globalLevel;
        s.ownCompatibility = !!level;
      } catch (e) {
        // 404 (40408): the subject has no level of its own – the registry's applies
        if (!(e instanceof RegistryError) || e.status !== 404) throw e;
        s.compatibility = globalLevel;
      }
    }
  };
  await Promise.all(Array.from({ length: CONFLUENT_READ_LIMITS.registryConcurrency }, worker));
  return { url, compatibility: globalLevel, subjects: out, truncated: truncated || subjects.length > CONFLUENT_READ_LIMITS.subjectDetails };
}

// ---------- everything ----------

const errorText = (e: unknown): string => {
  const err = e as Error & { cause?: Error };
  return `${err.message}${err.cause?.message && !err.message.includes(err.cause.message) ? `: ${err.cause.message}` : ''}`.slice(0, 400);
};

/**
 * Everything Steward reads from Confluent Cloud. Each part is read on its own: a part that fails keeps the values of
 * `before` and its error (partErrors); the environments are needed for clusters, Schema Registries and connectors.
 * The outbound policy is checked first for the base URL – a refusal fails the whole read; one for the Schema Registry
 * URL is the error of the subjects.
 */
export async function readConfluent(
  platform: Platform,
  secrets: Record<string, string>,
  opts: { before?: ConfluentReadout | null; now?: number } = {},
): Promise<Omit<ConfluentReadout, 'readAt' | 'error'>> {
  await assertConfluentOutbound(platform, secrets);
  const before = opts.before ?? null;
  const now = new Date(opts.now ?? Date.now()).toISOString();
  const partErrors: ConfluentReadout['partErrors'] = [];
  const part = async <T>(name: ConfluentPart, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      partErrors.push({ part: name, message: errorText(e) });
      return fallback;
    }
  };
  const environments = await part('environments', before?.environments ?? [], () => readEnvironments(platform, secrets));
  const clusters = await part('clusters', before?.clusters ?? [], () => readClusters(platform, secrets, environments));
  const schemaRegistries = await part('schemaRegistries', before?.schemaRegistries ?? [], () => readSchemaRegistries(platform, secrets, environments));
  const serviceAccounts = await part('serviceAccounts', before?.serviceAccounts ?? [], () => readServiceAccounts(platform, secrets));
  const apiKeys = await part('apiKeys', before?.apiKeys ?? [], () => readApiKeys(platform, secrets, serviceAccounts));
  const connectors: ConfluentConnector[] = [];
  for (const c of clusters.filter((x) => x.phase !== 'PROVISIONING')) {
    connectors.push(
      ...(await part(
        'connectors',
        (before?.connectors ?? []).filter((x) => x.clusterId === c.id),
        () => readConnectorsOf(platform, secrets, c, before?.connectors ?? [], now),
      )),
    );
  }
  const url = registryTarget(platform);
  const registry =
    url && secrets.registryKey && secrets.registrySecret ? await part('subjects', before?.registry ?? null, () => readSubjects(platform, secrets, url)) : null;
  return { partErrors, environments, clusters, schemaRegistries, serviceAccounts, apiKeys, connectors, registry };
}
