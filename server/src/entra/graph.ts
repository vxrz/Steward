import type { Platform } from '@sm/shared';
import { platformRequest, resolveBaseUrl, type HttpResult } from '../platforms/http.js';

/**
 * The one way Steward reads Microsoft Graph (v0.5.0, docs/ENTRA.md): every request goes through the platform layer
 * (its sign-in, credentials only to the base URL's origin, concurrency limit) with a retry policy for Graph's
 * throttling – 429 and 503 are retried after Retry-After (at most GRAPH_LIMITS.retries times, each wait at most a
 * minute) – and lists follow @odata.nextLink page by page, on the base URL's origin only, up to GRAPH_LIMITS.pages.
 * Only GET: Steward never changes anything in Entra ID.
 *
 * Errors become a GraphError in plain words: a 403 names the application permission the endpoint needs (and that admin
 * consent may be missing), a missing Entra ID P1/P2 licence is marked (`licence`), so optional parts can be skipped.
 */

export const GRAPH_LIMITS = {
  /** Pages of one list */
  pages: 500,
  /** Items per page asked for ($top; Graph's maximum for most lists is 999) */
  pageSize: 999,
  /** Largest answer of one page */
  pageBytes: 16 * 1024 * 1024,
  timeoutMs: 60_000,
  /** Retries after 429/503 (with Retry-After) and network errors */
  retries: 4,
  maxRetryDelayMs: 60_000,
} as const;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** A missing Entra ID P1/P2 licence (the part is not available in this tenant) */
    readonly licence = false,
    /** The application permission the endpoint needs, when it answered 403 */
    readonly permission: string | null = null,
  ) {
    super(message);
  }
  /** Not readable because of the licence or a missing permission – an optional part is skipped, not failed. */
  get unavailable(): boolean {
    return this.licence || this.status === 403;
  }
}

/** The least-privileged application permission an endpoint needs (for the error messages). */
export function permissionFor(path: string, query: Record<string, unknown> = {}): string {
  const p = path.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/(v1\.0|beta)/, '');
  const select = String(query.$select ?? /[?&]\$select=([^&]*)/.exec(path)?.[1] ?? '');
  if (p.startsWith('/users') && /signInActivity/i.test(decodeURIComponent(select))) return 'AuditLog.Read.All';
  if (p.startsWith('/users')) return 'User.Read.All';
  if (p.startsWith('/groups')) return 'Group.Read.All';
  if (p.startsWith('/roleManagement')) return 'RoleManagement.Read.Directory';
  if (p.startsWith('/applications') || p.startsWith('/servicePrincipals')) return 'Application.Read.All';
  if (p.startsWith('/reports')) return 'AuditLog.Read.All';
  if (p.startsWith('/admin/serviceAnnouncement')) return 'ServiceHealth.Read.All';
  return 'Directory.Read.All';
}

const LICENCE_CODES = new Set(['Authentication_RequestFromNonPremiumTenantOrB2CTenant', 'AadPremiumLicenseRequired']);

/** A failed Graph answer in plain words. */
export function graphError(res: Pick<HttpResult, 'status' | 'body'>, path: string, query: Record<string, unknown> = {}): GraphError {
  const err = (res.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof err?.code === 'string' ? err.code.slice(0, 100) : '';
  const msg = typeof err?.message === 'string' ? err.message.slice(0, 300) : '';
  const what = path
    .replace(/^https?:\/\/[^/]+/i, '')
    .split('?')[0]!
    .slice(0, 120);
  if (LICENCE_CODES.has(code) || /premium licen[sc]e|Entra ID P[12]|Azure AD Premium/i.test(msg))
    return new GraphError(`${what}: not available – the tenant has no Microsoft Entra ID P1/P2 licence for it (${msg || code})`, res.status, code, true);
  if (res.status === 403) {
    const permission = permissionFor(path, query);
    return new GraphError(
      `${what}: not allowed – the app registration lacks the application permission ${permission}, or an administrator has not granted admin consent for it (docs/ENTRA.md)`,
      403,
      code || 'Authorization_RequestDenied',
      false,
      permission,
    );
  }
  if (res.status === 401)
    return new GraphError(
      `${what}: Microsoft Graph did not accept the access token (HTTP 401${code ? ` ${code}` : ''}) – check the tenant, the client id and the base URL`,
      401,
      code,
    );
  if (res.status === 429 || res.status === 503)
    return new GraphError(
      `${what}: Microsoft Graph is throttling (HTTP ${res.status}) and still was after ${GRAPH_LIMITS.retries} retries – try again later`,
      res.status,
      code,
    );
  return new GraphError(`${what}: Microsoft Graph answered HTTP ${res.status}${code ? ` ${code}` : ''}${msg ? ` – ${msg}` : ''}`, res.status, code);
}

/** The platform with Graph's retry policy: at least GRAPH_LIMITS.retries retries of 429/503, waiting as Retry-After says. */
function withGraphRetries(p: Platform): Platform {
  const r = p.config.http?.retry ?? {};
  return {
    ...p,
    config: {
      ...p.config,
      http: {
        ...p.config.http,
        retry: {
          ...r,
          maxRetries: Math.max(r.maxRetries ?? 0, GRAPH_LIMITS.retries),
          baseDelayMs: r.baseDelayMs ?? 1000,
          maxDelayMs: Math.max(r.maxDelayMs ?? 0, GRAPH_LIMITS.maxRetryDelayMs),
        },
      },
    },
  };
}

/** One GET; throws a GraphError when Graph does not answer 2xx. */
export async function graphGet<T>(
  p: Platform,
  secrets: Record<string, string>,
  path: string,
  query: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const res = await platformRequest(
    withGraphRetries(p),
    secrets,
    { method: 'GET', url: path, query, maxResponseBytes: GRAPH_LIMITS.pageBytes, noRedirects: true },
    signal ?? AbortSignal.timeout(GRAPH_LIMITS.timeoutMs * 3),
  );
  if (!res.ok) throw graphError(res, path, query);
  return res.body as T;
}

/**
 * Every item of a Graph list: the first page from `path` (with $top), the next ones from @odata.nextLink while it stays
 * on the base URL's origin. `maxItems`: fail beyond that many (the callers' snapshot limits).
 */
export async function graphList<T>(
  p: Platform,
  secrets: Record<string, string>,
  path: string,
  query: Record<string, unknown> = {},
  o: { maxItems?: number; pageSize?: number } = {},
): Promise<T[]> {
  const origin = new URL(await resolveBaseUrl(p, secrets)).origin;
  const out: T[] = [];
  let url = path;
  let q: Record<string, unknown> = { $top: o.pageSize ?? GRAPH_LIMITS.pageSize, ...query };
  for (let page = 0; page < GRAPH_LIMITS.pages; page++) {
    const body = await graphGet<{ value?: T[]; '@odata.nextLink'?: string } | null>(p, secrets, url, q);
    if (Array.isArray(body?.value)) out.push(...body.value);
    if (o.maxItems !== undefined && out.length > o.maxItems)
      throw new GraphError(`${path.split('?')[0]} has more than ${o.maxItems} items`, 400, 'TooManyItems');
    const next = typeof body?.['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : '';
    if (!next) return out;
    let nextUrl: URL;
    try {
      nextUrl = new URL(next, origin);
    } catch {
      return out;
    }
    // the next page stays on Graph's own origin: the token goes nowhere else
    if (nextUrl.origin !== origin)
      throw new GraphError(`${path.split('?')[0]}: the next page is on another host (${nextUrl.host}) – not followed`, 502, 'ForeignNextLink');
    url = nextUrl.toString();
    q = {};
  }
  throw new GraphError(`${path.split('?')[0]} has more than ${GRAPH_LIMITS.pages} pages`, 400, 'TooManyPages');
}

/** Like graphList, but a part the tenant cannot read (licence, permission) gives null and the reason instead of failing. */
export async function optionalList<T>(
  p: Platform,
  secrets: Record<string, string>,
  path: string,
  query: Record<string, unknown> = {},
  o: { maxItems?: number } = {},
): Promise<{ items: T[] | null; unavailable: string | null }> {
  try {
    return { items: await graphList<T>(p, secrets, path, query, o), unavailable: null };
  } catch (e) {
    if (e instanceof GraphError && e.unavailable) return { items: null, unavailable: e.message };
    throw e;
  }
}
