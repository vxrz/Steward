import { CONFLUENT_CRN_PREFIX, CONFLUENT_KIND, type AccessSubject, type Platform } from '@sm/shared';
import { HttpError } from '../util.js';
import { platformRequest, resolveBaseUrl } from '../platforms/http.js';

/**
 * Confluent Cloud as an access review source (v0.4.0, docs/CONFLUENT.md). A platform of kind confluent-cloud is the
 * Confluent Cloud API (https://api.confluent.cloud) with a Cloud API key and secret (basic auth). Steward reads
 *
 *   - the role bindings of an organisation, environment or cluster: GET /iam/v2/role-bindings?crn_pattern=<CRN>
 *   - optionally the Kafka ACLs of a cluster: GET <kafkaRestUrl>/kafka/v3/clusters/<clusterId>/acls, with the cluster's
 *     own API key (credentials clusterApiKey / clusterApiSecret)
 *   - who the principals are: GET /iam/v2/users and /iam/v2/service-accounts (User:u-… → e-mail and name, sa-… → name)
 *
 * Only reads. Every list is followed page by page (metadata.next), on the same origin only; principals and resource
 * names are parsed with indexOf/slice – no pattern is built from what the API returns.
 */

export const CONFLUENT_LIMITS = { pages: 50, pageSize: 100, timeoutMs: 20_000 } as const;

interface Page<T> {
  data?: T[];
  metadata?: { next?: string | null };
}

interface RoleBinding {
  id?: string;
  principal?: string;
  role_name?: string;
  crn_pattern?: string;
}

interface CloudUser {
  id?: string;
  email?: string;
  full_name?: string;
}

interface ServiceAccount {
  id?: string;
  display_name?: string;
  description?: string;
}

interface KafkaAcl {
  resource_type?: string;
  resource_name?: string;
  pattern_type?: string;
  principal?: string;
  host?: string;
  operation?: string;
  permission?: string;
}

/**
 * Every item of a paged list: the first page from `path`, the next ones from metadata.next while it stays on the API's
 * origin (also the Costs API of platform costs, #226, and the readout of 0.14.0, confluent/client.ts).
 */
export async function confluentPages<T>(
  platform: Platform,
  secrets: Record<string, string>,
  path: string,
  query: Record<string, string>,
  what: string,
  /** What a 403 means for this list (default: the role bindings of an access review) */
  forbidden = 'the API key may not read this (OrganizationAdmin or a role that may list role bindings)',
): Promise<T[]> {
  const base = await resolveBaseUrl(platform, secrets);
  const origin = new URL(base).origin;
  const out: T[] = [];
  let url: string = path;
  let q: Record<string, string> | undefined = { ...query, page_size: String(CONFLUENT_LIMITS.pageSize) };
  for (let i = 0; i < CONFLUENT_LIMITS.pages; i++) {
    const r = await platformRequest(
      platform,
      secrets,
      { method: 'GET', url, query: q, maxResponseBytes: 8 * 1024 * 1024, noRedirects: true },
      AbortSignal.timeout(CONFLUENT_LIMITS.timeoutMs),
    );
    if (!r.ok)
      throw new Error(`${what} answered HTTP ${r.status}${r.status === 401 ? ' – check the API key and secret' : r.status === 403 ? ` – ${forbidden}` : ''}`);
    const body = (r.body ?? {}) as Page<T>;
    if (Array.isArray(body.data)) out.push(...body.data);
    const next = typeof body.metadata?.next === 'string' ? body.metadata.next : '';
    if (!next) return out;
    let nextUrl: URL;
    try {
      nextUrl = new URL(next, base);
    } catch {
      return out;
    }
    // the next page stays on the API's own origin (the credentials go nowhere else)
    if (nextUrl.origin !== origin) return out;
    url = nextUrl.toString();
    q = undefined;
  }
  throw new Error(`${what} has more than ${CONFLUENT_LIMITS.pages} pages`);
}

/** "User:u-abc12" → { kind: 'user', id: 'u-abc12' }; "User:sa-xyz" → service account; "User:*" → everyone; others as they are. */
export function parsePrincipal(principal: string): { kind: 'user' | 'serviceAccount' | 'everyone' | 'other'; id: string } {
  const p = principal.trim();
  const colon = p.indexOf(':');
  const id = colon >= 0 ? p.slice(colon + 1) : p;
  const type = colon >= 0 ? p.slice(0, colon) : '';
  if (id === '*') return { kind: 'everyone', id: '*' };
  if (type !== '' && type !== 'User') return { kind: 'other', id: p };
  if (id.startsWith('sa-')) return { kind: 'serviceAccount', id };
  if (id.startsWith('u-')) return { kind: 'user', id };
  return { kind: 'other', id: p };
}

/** The resource of a CRN without the organisation: "environment=env-1/cloud-cluster=lkc-1", or "organization" for the organisation itself. */
export function crnResource(crn: string): string {
  if (!crn.startsWith(CONFLUENT_CRN_PREFIX)) return crn;
  const parts = crn.slice(CONFLUENT_CRN_PREFIX.length).split('/');
  const rest = parts.slice(1).filter(Boolean);
  return rest.length ? rest.join('/') : 'organization';
}

const aclRight = (a: KafkaAcl) =>
  `ACL ${String(a.permission ?? 'ALLOW').toUpperCase()} ${String(a.operation ?? '').toUpperCase()} ${String(a.resource_type ?? '').toUpperCase()}:${a.resource_name ?? ''}${String(a.pattern_type ?? '').toUpperCase() === 'PREFIXED' ? '*' : ''}${a.host && a.host !== '*' ? ` from ${a.host}` : ''}`;

const trimSlashes = (s: string) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
};

/** The Kafka REST endpoint as a platform of its own: its base URL, basic auth with the cluster API key. */
function clusterPlatform(platform: Platform, restUrl: string): Platform {
  return {
    ...platform,
    baseUrl: trimSlashes(restUrl),
    config: { ...platform.config, auth: { type: 'basic' }, http: { ...platform.config.http, defaultHeaders: {}, trustedOrigins: [] }, testPath: undefined },
  };
}

/** The Kafka REST endpoint of the platform's cluster (variable kafkaRestUrl, https) and cluster id, or null when not set. */
export function aclTarget(platform: Platform): { restUrl: string; clusterId: string } | null {
  const restUrl = String(platform.config.variables?.kafkaRestUrl ?? '').trim();
  const clusterId = String(platform.config.variables?.clusterId ?? '').trim();
  if (!restUrl || !clusterId) return null;
  let u: URL;
  try {
    u = new URL(restUrl);
  } catch {
    throw new HttpError(400, 'The variable kafkaRestUrl is not a URL', 'CONFLUENT_REST_URL', { url: restUrl.slice(0, 100) });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new HttpError(400, 'The variable kafkaRestUrl is not a URL', 'CONFLUENT_REST_URL', { url: restUrl.slice(0, 100) });
  if (![...clusterId].every((c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_'))
    throw new HttpError(400, 'The variable clusterId has letters, digits, - and _ (e.g. lkc-abc123)', 'CONFLUENT_CLUSTER_ID', { id: clusterId.slice(0, 60) });
  return { restUrl: u.toString(), clusterId };
}

/**
 * Who has which access in Confluent Cloud under a CRN: one subject per principal with its role bindings (and the
 * cluster's ACLs when kafkaRestUrl, clusterId and the cluster API key are set). Users are named by their e-mail
 * address (person reviews match them), service accounts by their id with the display name.
 */
export async function confluentAccess(platform: Platform, secrets: Record<string, string>, crn: string): Promise<AccessSubject[]> {
  if (platform.kind !== CONFLUENT_KIND) throw new HttpError(400, 'The Confluent source needs a Confluent Cloud API platform', 'ACCESS_CHECK_CONFLUENT_SOURCE');
  const bindings = await confluentPages<RoleBinding>(platform, secrets, '/iam/v2/role-bindings', { crn_pattern: crn }, 'Confluent Cloud (role bindings)');
  const users = await confluentPages<CloudUser>(platform, secrets, '/iam/v2/users', {}, 'Confluent Cloud (users)');
  const accounts = await confluentPages<ServiceAccount>(platform, secrets, '/iam/v2/service-accounts', {}, 'Confluent Cloud (service accounts)');
  let acls: KafkaAcl[] = [];
  const target = aclTarget(platform);
  if (target && secrets.clusterApiKey && secrets.clusterApiSecret) {
    const cluster = clusterPlatform(platform, target.restUrl);
    acls = await confluentPages<KafkaAcl>(
      cluster,
      { username: secrets.clusterApiKey, password: secrets.clusterApiSecret },
      `/kafka/v3/clusters/${encodeURIComponent(target.clusterId)}/acls`,
      {},
      'The Kafka REST API (ACLs)',
    );
  }
  const userById = new Map(users.filter((x) => x.id).map((x) => [x.id!, x]));
  const saById = new Map(accounts.filter((x) => x.id).map((x) => [x.id!, x]));
  const subjects = new Map<string, AccessSubject>();
  const subjectOf = (principal: string): AccessSubject => {
    const p = parsePrincipal(principal);
    let s: AccessSubject;
    if (p.kind === 'user') {
      const u = userById.get(p.id);
      const email = u?.email?.trim().toLowerCase();
      s = { id: email || p.id, name: u?.full_name?.trim() || email || p.id, type: 'user', rights: [], aliases: [p.id, `User:${p.id}`] };
    } else if (p.kind === 'serviceAccount') {
      const sa = saById.get(p.id);
      s = { id: p.id, name: sa?.display_name?.trim() || p.id, type: 'technical', rights: [], aliases: [`User:${p.id}`] };
    } else if (p.kind === 'everyone') s = { id: 'User:*', name: 'Every principal (User:*)', type: 'technical', rights: [] };
    else s = { id: p.id, name: p.id, type: 'technical', rights: [] };
    const key = s.id.toLowerCase();
    const cur = subjects.get(key);
    if (cur) return cur;
    subjects.set(key, s);
    return s;
  };
  for (const b of bindings) {
    if (!b.principal || !b.role_name) continue;
    subjectOf(b.principal).rights.push(`${b.role_name} on ${crnResource(b.crn_pattern ?? crn)}`);
  }
  for (const a of acls) {
    if (!a.principal || !a.operation) continue;
    subjectOf(a.principal).rights.push(aclRight(a));
  }
  return [...subjects.values()].filter((s) => s.rights.length > 0);
}
