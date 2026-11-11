import crypto from 'node:crypto';
import fs from 'node:fs';
import { once } from 'node:events';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch, type Dispatcher } from 'undici';
import { trace } from '@opentelemetry/api';
import { INFLUX_KIND, influxVersionOf, type AuthConfig, type Platform } from '@sm/shared';
import { evalExpr, render, renderString } from '../engine/expr.js';
import { HttpError } from '../util.js';
import { SpanKind, SpanStatusCode, injectTraceHeaders, withSpan } from '../telemetry.js';
import { logger } from '../log.js';
import { emit } from '../events.js';
import { assertLiteralAddressSafe, assertOutboundAllowed, assertRedirectAllowed, assertRedirectBodyClean, guardedLookup, sameDestination } from './outbound.js';
import { parseAssumeRole, signRequest, type AwsCredentials } from './sigv4.js';
import { JWT_ALGS, certificateThumbprints, clientAssertion, privateKeyOf, publicKeyFingerprint, signJwt } from './jwt.js';
import { where as originAndPath } from './answers.js';
import { stripValues } from './deniedPaths.js';
import { assertKindRules, destinationKinds } from './restrictedOrigins.js';
import { defaultIdentityId } from './identities.js';

export interface HttpRequest {
  method: string;
  url: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyType?: 'json' | 'form' | 'text' | 'binary';
  /** Fail when the response body is larger (bytes); default: no limit */
  maxResponseBytes?: number;
  /** Stop reading the response body after this many bytes instead (the result is marked `truncated`). */
  truncateResponseBytes?: number;
  /** Keep the body as text (no JSON detection) */
  rawText?: boolean;
  /** Return a redirect response as it is instead of following it. */
  noRedirects?: boolean;
  /** Signs the request as it is about to be sent (AWS SigV4, #114): may add headers */
  sign?: (r: { method: string; url: string; headers: Record<string, string>; body?: string | Buffer }) => Promise<void>;
  /**
   * Write a successful (2xx) response body to this file (0600, replaced) instead of reading it into memory – large
   * downloads such as backups (#117). The result's body is then {bytes, sha256}.
   */
  responseFile?: string;
  /** AWS SigV4 (#116): sign this request for another service or region than the platform's (one AWS account, many APIs). */
  aws?: { service: string; region: string };
  /**
   * Steward's own fixed read that uses another method than GET (0.13.0, ADR 0009): a read-only identity lets it through.
   * Only Steward's code sets it (Prometheus queries, AWS query APIs, Snowflake statements, LLM calls) – never a step.
   */
  intent?: 'read';
  /** Mutual TLS (0.9.0): the client certificate presented on this hop – set per hop for the platform's own origins only */
  clientTls?: ClientTls;
}

/** A client certificate for mutual TLS (PEM). */
export interface ClientTls {
  cert: string;
  key: string;
  passphrase?: string;
}

/**
 * Mutual TLS (0.9.0, #223): the client certificate in the platform's credentials tlsCertificate and tlsKey (PEM; an
 * encrypted key with tlsKeyPassphrase). Presented only to the platform's own origins, like every other credential.
 */
export function clientTlsOf(secrets: Record<string, string>): ClientTls | undefined {
  const cert = secrets.tlsCertificate?.trim();
  const key = secrets.tlsKey?.trim();
  if (!cert || !key) return undefined;
  return { cert, key, ...(secrets.tlsKeyPassphrase ? { passphrase: secrets.tlsKeyPassphrase } : {}) };
}

export interface HttpResult {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
  /** Number of attempts when the request was retried */
  attempts?: number;
  /** The body was cut off at truncateResponseBytes */
  truncated?: boolean;
}

interface CachedToken {
  header: [string, string];
  fetchedAt: number;
  expiresAt: number;
  /** token_request with auth.refresh (v0.5.0): renews the token once it expired, before signing in again */
  refreshToken?: string;
}

/** Whether the identity of a platform object restricts requests (read-only, an operation filter): the fast path stays import-free. */
async function identityRestricts(p: Platform): Promise<boolean> {
  const id = (p as WithIdentity).identityId;
  const known = p.identities?.find((i) => (id ? i.id === id : i.default));
  if (known) return known.readOnly || !!known.operationFilter || known.integrity === 'mismatch' || known.integrity === 'unsealed';
  if (!p.id || p.id.startsWith('offline:')) return false;
  const { restricts } = await import('./identityGuard.js');
  return restricts(p);
}

/** Token and AWS role caches are per identity (0.9.0, ADR 0009): `platformId:identityId`. */
const tokenCache = new Map<string, CachedToken>();
const dispatcherCache = new Map<string, { stamp: string; dispatcher: Dispatcher }>();

/** A platform object as getConnection gives it (with its identity), or as getPlatform does (the default identity). */
type WithIdentity = Pick<Platform, 'id'> & { identityId?: string; identities?: Platform['identities'] };

/**
 * The cache key of the identity a platform object is used with: getConnection sets `identityId`; a plain platform
 * object (getPlatform) stands for the default identity, whose id is derived from the platform id.
 */
export function identityKey(p: WithIdentity): string {
  // a plain platform object (getPlatform) stands for its current default identity (0.13.0: another identity can become
  // the default – changing it clears the platform's caches as well)
  return `${p.id}:${p.identityId ?? p.identities?.find((i) => i.default)?.id ?? defaultIdentityId(p.id)}`;
}

/** The cached access token of a platform identity (login or OAuth2), without the token itself. */
export function tokenInfo(p: WithIdentity): { fetchedAt: string; expiresAt: string } | null {
  const t = tokenCache.get(identityKey(p));
  return t ? { fetchedAt: new Date(t.fetchedAt).toISOString(), expiresAt: new Date(t.expiresAt).toISOString() } : awsCredentialInfo(p);
}

/**
 * The claims of the platform's cached access token when it is a JWT (Entra ID: roles = the application permissions with
 * admin consent, v0.5.0) – never the token itself; null without a cached JWT.
 */
export function tokenClaims(p: WithIdentity): Record<string, unknown> | null {
  const t = tokenCache.get(identityKey(p));
  const parts = t?.header[1].replace(/^Bearer\s+/i, '').split('.');
  if (!parts || parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null; // not a JWT (an opaque token): no claims to read
  }
}

/** Whether the platform logs in for a token that Steward caches (OAuth2 client credentials or a custom login). */
export function usesCachedToken(p: Platform): boolean {
  const type = p.config.auth?.type;
  return type === 'oauth2_client_credentials' || type === 'token_request' || type === 'jwt' || (type === 'aws_sigv4' && !!p.config.auth?.aws?.roleArn);
}

/**
 * Drops the cached token and logs in again right away – for roles or permissions granted since the
 * token was issued, which only a new token carries. Throws what the login request throws.
 */
export async function renewToken(p: Platform, secrets: Record<string, string>, signal?: AbortSignal): Promise<{ fetchedAt: string; expiresAt: string }> {
  if (!usesCachedToken(p)) throw new Error('This platform does not log in for a token');
  tokenCache.delete(identityKey(p));
  awsCache.delete(identityKey(p));
  if (p.config.auth?.type === 'aws_sigv4') await awsCredentials(p, secrets, signal);
  else await obtainAuthHeader(p, secrets, signal);
  const info = tokenInfo(p);
  if (!info) throw new Error('The login did not return a token');
  return info;
}

const invalidationListeners: ((platformId: string, identityId?: string) => void)[] = [];
/**
 * Called whenever a platform's settings or credentials change or it is deleted (database connection pools, 0.7.0);
 * with an identity id when only that identity's credentials changed.
 */
export function onPlatformInvalidated(fn: (platformId: string, identityId?: string) => void): void {
  invalidationListeners.push(fn);
}

function dropKeys(map: Map<string, unknown>, platformId: string): void {
  for (const k of [...map.keys()]) if (k.startsWith(`${platformId}:`)) map.delete(k);
}

/** Clears everything cached for a platform: the tokens and roles of all its identities, its TLS dispatcher. */
export function invalidatePlatformCaches(platformId: string): void {
  for (const fn of invalidationListeners) fn(platformId);
  dropKeys(tokenCache, platformId);
  dropKeys(awsCache, platformId);
  for (const [key, d] of [...dispatcherCache]) {
    // the platform's plain dispatcher and the client-certificate dispatchers of its identities (`${id}:${identity}|mtls`)
    if (key !== platformId && !key.startsWith(`${platformId}:`)) continue;
    dispatcherCache.delete(key);
    d.dispatcher.close().catch(() => undefined); // an old dispatcher: closing it is best effort
  }
}

/** Clears what is cached for one identity (its credentials changed): its token, role, client-certificate dispatcher and database pool – not the platform's dispatcher. */
export function invalidateIdentityCaches(platformId: string, identityId: string): void {
  for (const fn of invalidationListeners) fn(platformId, identityId);
  const key = identityKey({ id: platformId, identityId });
  tokenCache.delete(key);
  awsCache.delete(key);
  const d = dispatcherCache.get(`${key}|mtls`);
  if (d) {
    dispatcherCache.delete(`${key}|mtls`);
    d.dispatcher.close().catch(() => undefined); // an old dispatcher: closing it is best effort
  }
}

function dispatcherFor(p: Platform, tls?: ClientTls): Dispatcher {
  // a dispatcher with the client certificate is kept apart from the one without (hops to other origins), and per
  // identity: two identities with their own certificates do not replace each other's dispatcher (0.9.0)
  const key = tls ? `${identityKey(p)}|mtls` : p.id;
  // compared in memory only (the dispatcher holds the same certificate and key)
  const stamp = tls ? `${p.updatedAt}|${tls.cert}\u0000${tls.key}\u0000${tls.passphrase ?? ''}` : p.updatedAt;
  const hit = dispatcherCache.get(key);
  if (hit && hit.stamp === stamp) return hit.dispatcher;
  if (hit) hit.dispatcher.close().catch(() => undefined); // replaced: closing the old one is best effort
  const connect = {
    rejectUnauthorized: !p.config.http?.insecureTls,
    ...(p.config.http?.caPem ? { ca: p.config.http.caPem } : {}),
    ...(tls ? { cert: tls.cert, key: tls.key, ...(tls.passphrase ? { passphrase: tls.passphrase } : {}) } : {}),
    // Resolve DNS ourselves, reject metadata/link-local addresses and pin the IP
    // for the connection so a name cannot be rebound after the policy check.
    lookup: guardedLookup,
  };
  const proxy = p.config.http?.proxy?.trim();
  let dispatcher: Dispatcher;
  // A real proxy resolves names on its side, so the pinning lookup only applies to direct connections.
  if (proxy === 'none') dispatcher = new Agent({ connect });
  else if (proxy) dispatcher = new ProxyAgent({ uri: proxy, requestTls: connect });
  else dispatcher = new EnvHttpProxyAgent({ connect, requestTls: connect } as never);
  dispatcherCache.set(key, { stamp, dispatcher });
  return dispatcher;
}

function authScope(p: Platform, secrets: Record<string, string>) {
  // without a trailing slash, so "{{ baseUrl }}/.default" (Microsoft Graph) stays one URL
  return { vars: p.config.variables ?? {}, secrets, baseUrl: p.baseUrl.replace(/\/+$/, ''), platform: { name: p.name, kind: p.kind } };
}

export async function resolveBaseUrl(p: Platform, secrets: Record<string, string>): Promise<string> {
  return (await renderString(p.baseUrl, authScope(p, secrets))).replace(/\/+$/, '');
}

/** Whether a request to pathOrUrl may carry the platform's credentials. Relative paths always may. */
/** https://<…>.amazonaws.com (or .amazonaws.com.cn, China) – an endpoint of AWS itself. */
export function isAwsEndpoint(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && !u.port && /^[a-z0-9.-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname);
  } catch {
    return false;
  }
}

export async function credentialsAllowed(p: Platform, secrets: Record<string, string>, pathOrUrl: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(pathOrUrl)) return true;
  let origin: string;
  try {
    origin = new URL(pathOrUrl).origin;
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  try {
    if (p.baseUrl) allowed.add(new URL(await resolveBaseUrl(p, secrets)).origin);
  } catch {
    /* base URL not resolvable – only explicitly trusted origins count */
  }
  // An AWS account (#116) calls many AWS endpoints (ce, tagging, iam, sts …): signed requests may go to AWS's own hosts
  if (p.kind === 'aws' && p.config.auth?.type === 'aws_sigv4' && isAwsEndpoint(origin)) return true;
  for (const o of p.config.http?.trustedOrigins ?? []) {
    try {
      allowed.add(new URL(o).origin);
    } catch {
      /* ignore invalid entries */
    }
  }
  return allowed.has(origin);
}

export async function buildUrl(p: Platform, secrets: Record<string, string>, pathOrUrl: string, query?: Record<string, unknown>): Promise<string> {
  let url: string;
  if (/^https?:\/\//i.test(pathOrUrl)) url = pathOrUrl;
  else {
    const base = await resolveBaseUrl(p, secrets);
    url = base + (pathOrUrl.startsWith('/') ? '' : '/') + pathOrUrl;
  }
  if (query && Object.keys(query).length) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    url = u.toString();
  }
  return url;
}

async function rawRequest(p: Platform, req: HttpRequest, signal?: AbortSignal, attempt = 1): Promise<HttpResult> {
  let target: URL | undefined;
  try {
    target = new URL(req.url);
  } catch {
    /* relative/invalid – reported by fetch */
  }
  return withSpan(
    `HTTP ${req.method}`,
    {
      'http.request.method': req.method,
      'url.full': target ? `${target.origin}${target.pathname}` : req.url, // query omitted (may contain filters with personal data)
      'server.address': target?.hostname,
      'server.port': target ? Number(target.port || (target.protocol === 'https:' ? 443 : 80)) : undefined,
      'sm.platform.id': p.id,
      'sm.platform.name': p.name,
      'sm.http.attempt': attempt,
      // OTel semantic convention: number of times this request was re-sent (retries)
      'http.request.resend_count': attempt > 1 ? attempt - 1 : undefined,
    },
    async (span) => {
      const t0 = Date.now();
      let res: HttpResult;
      try {
        res = await sendRaw(p, req, signal);
      } catch (e) {
        emit('http.request', { host: target?.host ?? 'unknown', method: req.method, status: 0, durationMs: Date.now() - t0, error: true });
        throw e;
      }
      emit('http.request', { host: target?.host ?? 'unknown', method: req.method, status: res.status, durationMs: res.durationMs, error: res.status >= 500 });
      span.setAttribute('http.response.status_code', res.status);
      if (res.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` });
      logger.debug(
        { platform: p.name, method: req.method, host: target?.host, path: target?.pathname, status: res.status, ms: res.durationMs },
        'platform call',
      );
      return res;
    },
    SpanKind.CLIENT,
  );
}

async function sendRaw(p: Platform, req: HttpRequest, signal?: AbortSignal): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: 'application/json, */*;q=0.5', ...(req.headers ?? {}) };
  injectTraceHeaders(headers);
  let body: string | Buffer | undefined;
  if (req.body !== undefined && req.body !== null && !['GET', 'HEAD'].includes(req.method)) {
    const type = req.bodyType ?? (typeof req.body === 'string' ? 'text' : Buffer.isBuffer(req.body) ? 'binary' : 'json');
    if (type === 'binary') {
      body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
      headers['content-type'] ??= 'application/octet-stream';
    } else if (type === 'json') {
      body = JSON.stringify(req.body);
      headers['content-type'] ??= 'application/json';
    } else if (type === 'form') {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      body = params.toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else {
      body = String(req.body);
      headers['content-type'] ??= 'text/plain';
    }
  }
  if (req.sign) await req.sign({ method: req.method, url: req.url, headers, body });
  const timeout = AbortSignal.timeout(p.config.http?.timeoutMs ?? 60000);
  const started = Date.now();
  let res;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers,
      body,
      dispatcher: dispatcherFor(p, req.clientTls),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      // Redirects are followed manually (see followRedirects) so credentials can be
      // re-evaluated per hop; undici only strips Authorization, not custom headers.
      redirect: 'manual',
    });
  } catch (e) {
    const err = e as Error & { cause?: Error & { code?: string } };
    const cause = err.cause?.message ? ` (${err.cause.message})` : '';
    const cancelled = !!signal?.aborted;
    const timedOut = !cancelled && (timeout.aborted || err.name === 'TimeoutError');
    const code = err.cause?.code ?? (err as { code?: string }).code;
    const retryable = !cancelled && (timedOut || (!!code && RETRYABLE_CODES.has(code)));
    throw Object.assign(new Error(`${req.method} ${req.url} failed: ${timedOut ? 'timeout' : err.message}${cause}`), {
      retryable,
      cancelled,
      code: timedOut ? 'ETIMEDOUT' : code,
    });
  }
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (resHeaders[k] = v));
  let parsed: unknown = null;
  let truncated = false;
  if (req.responseFile && res.ok && req.method !== 'HEAD') {
    parsed = await saveBody(res, req.responseFile);
  } else if (req.method !== 'HEAD') {
    let text: string;
    if (req.truncateResponseBytes !== undefined) ({ text, truncated } = await readCapped(res, req.truncateResponseBytes));
    else if (req.maxResponseBytes) text = await readBounded(res, req.maxResponseBytes, req.url);
    else text = await res.text();
    const ct = resHeaders['content-type'] ?? '';
    if (req.rawText) parsed = text;
    else if (text && (ct.includes('json') || /^[\s]*[{[]/.test(text))) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    } else parsed = text;
  }
  return {
    status: res.status,
    ok: res.ok,
    url: req.url,
    headers: resHeaders,
    body: parsed,
    durationMs: Date.now() - started,
    ...(truncated ? { truncated } : {}),
  };
}

/** Streams a response body into a file (0600), hashing it on the way. */
async function saveBody(res: Awaited<ReturnType<typeof fetch>>, file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const out = fs.createWriteStream(file, { flags: 'w', mode: 0o600 });
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        const b = Buffer.from(chunk as Uint8Array);
        hash.update(b);
        bytes += b.length;
        if (!out.write(b)) await once(out, 'drain');
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    await res.body?.cancel().catch(() => undefined); // the body is not read: a failed cancel changes nothing
    throw e;
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** Reads at most `max` bytes of a response body and cancels the rest of the download. */
async function readCapped(res: Awaited<ReturnType<typeof fetch>>, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size));
      truncated = true;
      await reader.cancel().catch(() => undefined); // the rest is not read: a failed cancel changes nothing
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Reads at most `max` bytes of a response body; larger bodies fail (and the connection is released). */
async function readBounded(res: Awaited<ReturnType<typeof fetch>>, max: number, url: string): Promise<string> {
  // origin and path only: the query may carry an API key
  const tooLarge = () =>
    Object.assign(new Error(`The response of ${originAndPath(url)} is larger than ${max} bytes`), { retryable: false, code: 'ETOOLARGE', max });
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined); // the body is not read: a failed cancel changes nothing
    throw tooLarge();
  }
  if (!res.body) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += (chunk as Uint8Array).length;
    if (size > max) {
      await res.body.cancel().catch(() => undefined); // the rest is not read: a failed cancel changes nothing
      throw tooLarge();
    }
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function obtainAuthHeader(p: Platform, secrets: Record<string, string>, signal?: AbortSignal): Promise<[string, string] | null> {
  const auth: AuthConfig = p.config.auth ?? { type: 'none' };
  const scope = authScope(p, secrets);
  switch (auth.type) {
    case 'none':
      return null;
    case 'basic':
      // a Kafka platform's username/password are its SASL credentials; its HTTP API (the Schema Registry) has its own key (#112)
      if (p.kind === 'kafka')
        return ['authorization', 'Basic ' + Buffer.from(`${secrets.registryKey ?? ''}:${secrets.registrySecret ?? ''}`).toString('base64')];
      return ['authorization', 'Basic ' + Buffer.from(`${secrets.username ?? ''}:${secrets.password ?? ''}`).toString('base64')];
    case 'bearer': {
      if (!secrets.token) throw new Error('Secret "token" is not set');
      // GitLab's own header for personal, group and project access tokens: reverse proxies and sign-in gateways in
      // front of GitLab often take over Authorization (v0.3.1). headerName "Authorization" there is for OAuth tokens.
      const name = (auth.headerName || (p.kind === 'gitlab' ? 'PRIVATE-TOKEN' : 'Authorization')).toLowerCase();
      // InfluxDB 2.x documents its own scheme for API tokens (0.18.0): "Authorization: Token <token>"; 1.x (JWT) and 3.x take Bearer
      const scheme = p.kind === INFLUX_KIND && influxVersionOf(p.config.variables) === '2' ? 'Token' : 'Bearer';
      return name === 'authorization' ? ['authorization', `${scheme} ${secrets.token}`] : [name, secrets.token];
    }
    case 'apiKey':
      if (auth.apiKeyIn === 'query') return null;
      return [(auth.apiKeyName || 'x-api-key').toLowerCase(), secrets.apiKey ?? ''];
    case 'oauth2_client_credentials':
    case 'token_request': {
      const cached = tokenCache.get(identityKey(p));
      if (cached && cached.expiresAt > Date.now() + 30000) return cached.header;
      let token: string;
      let expiresIn = 1800;
      let refreshToken: string | undefined;
      if (auth.type === 'oauth2_client_credentials') {
        if (!auth.tokenUrl) throw new Error('OAuth2 token URL is not configured');
        // a signed client assertion instead of the secret (certificate credentials, v0.5.0): chosen, or no secret but a private key
        // '' when not set
        const clientSecret = secrets.clientSecret ?? '';
        const assertion = auth.clientAuth === 'assertion' || (!clientSecret && !!secrets.privateKey?.trim());
        if (!secrets.clientId || (!assertion && !clientSecret))
          throw new Error('Secrets "clientId" and "clientSecret" (or "privateKey" with "certificate" for a client assertion) are required');
        const url = await renderString(auth.tokenUrl, scope);
        const form: Record<string, string> = { grant_type: 'client_credentials' };
        // the scope may name the base URL or a variable (Microsoft Graph: {{ baseUrl }}/.default, national clouds)
        if (auth.scope) form.scope = await renderString(auth.scope, scope);
        for (const [k, v] of Object.entries(auth.extraParams ?? {})) form[k] = await renderString(v, scope);
        const headers: Record<string, string> = {};
        if (assertion) {
          const key = privateKeyOf(secrets.privateKey, secrets.privateKeyPassphrase);
          const thumbprints = certificateThumbprints(secrets.certificate, String(p.config.variables?.certificateThumbprint ?? ''));
          form.client_id = secrets.clientId;
          form.client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
          form.client_assertion = clientAssertion(key, { clientId: secrets.clientId, tokenUrl: url, thumbprints });
        } else if ((auth.clientAuth ?? 'basic') === 'basic') {
          headers.authorization = 'Basic ' + Buffer.from(`${secrets.clientId}:${clientSecret}`).toString('base64');
        } else {
          form.client_id = secrets.clientId;
          form.client_secret = clientSecret;
        }
        const r = await rawRequest(p, { method: 'POST', url, headers, body: form, bodyType: 'form' }, signal);
        const b = r.body as { access_token?: string; expires_in?: number } | null;
        if (!r.ok || !b?.access_token) throw new Error(`Token request POST ${where(url)} failed with HTTP ${r.status}: ${short(r.body)}`);
        token = b.access_token;
        if (b.expires_in) expiresIn = Number(b.expires_in);
      } else {
        const rq = auth.request;
        if (!rq?.url) throw new Error('Login request URL is not configured');
        let got: Awaited<ReturnType<typeof tokenCall>> | null = null;
        // an expired token with a refresh token (v0.5.0): renew it first, sign in again only when that fails
        if (auth.refresh?.request?.url && cached?.refreshToken) {
          try {
            got = await tokenCall(p, secrets, auth, auth.refresh.request, { ...scope, refreshToken: cached.refreshToken }, 'Token refresh', signal);
            got.refreshToken ??= cached.refreshToken;
          } catch (e) {
            logger.debug({ platform: p.name, error: (e as Error).message.slice(0, 300) }, 'token refresh failed – signing in again');
          }
        }
        got ??= await tokenCall(p, secrets, auth, rq, scope, 'Login request', signal);
        token = got.token;
        if (got.expiresIn) expiresIn = got.expiresIn;
        refreshToken = got.refreshToken;
      }
      const headerName = (auth.headerName || 'Authorization').toLowerCase();
      const headerValue = await renderString(auth.headerValue || 'Bearer {{ token }}', { ...scope, token });
      const header: [string, string] = [headerName, headerValue];
      const now = Date.now();
      tokenCache.set(identityKey(p), { header, fetchedAt: now, expiresAt: now + expiresIn * 1000, ...(refreshToken ? { refreshToken } : {}) });
      return header;
    }
    case 'jwt': {
      const cached = tokenCache.get(identityKey(p));
      if (cached && cached.expiresAt > Date.now() + 30000) return cached.header;
      const cfg = auth.jwt ?? {};
      const alg = cfg.alg ?? 'RS256';
      if (!(JWT_ALGS as readonly string[]).includes(alg)) throw new Error(`Unsupported JWT algorithm ${alg}`);
      const key = privateKeyOf(secrets.privateKey, secrets.privateKeyPassphrase);
      const jwtScope = { ...scope, publicKeyFingerprint: publicKeyFingerprint(key) };
      const claims: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(cfg.claims ?? {})) if (!['iat', 'exp', 'jti'].includes(k)) claims[k] = await renderString(String(v), jwtScope);
      const { jwt, exp } = signJwt(key, { alg, claims, lifetimeSeconds: cfg.lifetimeSeconds, kid: cfg.kid });
      let token = jwt;
      let expiresAt = exp * 1000;
      if (cfg.mode === 'exchange') {
        if (!auth.tokenUrl) throw new Error('The token URL for the JWT exchange is not configured');
        const url = await renderString(auth.tokenUrl, scope);
        const form: Record<string, string> = { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt };
        if (auth.scope) form.scope = auth.scope;
        for (const [k, v] of Object.entries(auth.extraParams ?? {})) form[k] = await renderString(v, scope);
        const r = await rawRequest(p, { method: 'POST', url, headers: {}, body: form, bodyType: 'form' }, signal);
        const b = r.body as { access_token?: string; expires_in?: number } | null;
        if (!r.ok || !b?.access_token) throw new Error(`JWT exchange POST ${where(url)} failed with HTTP ${r.status}: ${short(r.body)}`);
        token = b.access_token;
        expiresAt = Date.now() + Number(b.expires_in ?? 1800) * 1000;
      }
      const header: [string, string] = [
        (auth.headerName || 'Authorization').toLowerCase(),
        await renderString(auth.headerValue || 'Bearer {{ token }}', { ...scope, token }),
      ];
      tokenCache.set(identityKey(p), { header, fetchedAt: Date.now(), expiresAt });
      return header;
    }
    case 'aws_sigv4':
      // signed per request (signerFor)
      return null;
    default:
      throw new Error(`Unsupported auth type ${(auth as AuthConfig).type}`);
  }
}

type TokenRequest = NonNullable<AuthConfig['request']>;

/** One login or refresh call of a token_request platform: the token, its lifetime and the refresh token (auth.refresh). */
async function tokenCall(
  p: Platform,
  secrets: Record<string, string>,
  auth: AuthConfig,
  rq: TokenRequest,
  scope: Record<string, unknown>,
  what: string,
  signal?: AbortSignal,
): Promise<{ token: string; expiresIn: number | null; refreshToken?: string }> {
  const url = await renderString(rq.url, scope);
  const fullUrl = /^https?:/i.test(url) ? url : (await resolveBaseUrl(p, secrets)) + url;
  const r = await rawRequest(
    p,
    {
      method: rq.method ?? 'POST',
      url: fullUrl,
      headers: (await render(rq.headers ?? {}, scope)) as Record<string, string>,
      body: rq.body === undefined ? undefined : await render(rq.body, scope),
      bodyType: rq.bodyType ?? 'json',
    },
    signal,
  );
  if (!r.ok) throw new Error(`${what} ${rq.method ?? 'POST'} ${where(fullUrl)} failed with HTTP ${r.status}: ${short(r.body)}`);
  const t = await evalExpr(auth.tokenPath || 'access_token', r.body, { headers: r.headers });
  if (!t || typeof t !== 'string') throw new Error(`${what === 'Login request' ? 'Login' : what} response did not contain a token at "${auth.tokenPath}"`);
  let expiresIn: number | null = null;
  if (auth.expiresInPath) {
    const e = Number(await evalExpr(auth.expiresInPath, r.body));
    if (e > 0) expiresIn = e;
  }
  let refreshToken: string | undefined;
  if (auth.refresh?.tokenPath) {
    const rt = await evalExpr(auth.refresh.tokenPath, r.body);
    if (typeof rt === 'string' && rt) refreshToken = rt;
  }
  return { token: t, expiresIn, ...(refreshToken ? { refreshToken } : {}) };
}

// ---------- AWS SigV4 (#114) ----------

const awsCache = new Map<string, AwsCredentials & { expiration: number; fetchedAt: number }>();

/** The credentials requests are signed with: the platform's keys, or the role they assume (cached until shortly before it ends). */
async function awsCredentials(p: Platform, secrets: Record<string, string>, signal?: AbortSignal): Promise<AwsCredentials> {
  const aws = p.config.auth?.aws;
  if (!aws?.region || !aws.service) throw new Error('AWS signing needs the region and the service (e.g. eu-central-1, s3)');
  if (!secrets.accessKeyId || !secrets.secretAccessKey) throw new Error('Secrets "accessKeyId" and "secretAccessKey" are required');
  const base: AwsCredentials = {
    accessKeyId: secrets.accessKeyId,
    secretAccessKey: secrets.secretAccessKey,
    ...(secrets.sessionToken ? { sessionToken: secrets.sessionToken } : {}),
  };
  if (!aws.roleArn) return base;
  const cached = awsCache.get(identityKey(p));
  if (cached && cached.expiration > Date.now() + 5 * 60_000) return cached;
  if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/.test(aws.roleArn))
    throw new Error('The role ARN is not an IAM role (arn:aws:iam::123456789012:role/name)');
  const url = aws.stsEndpoint?.trim() || `https://sts.${aws.region}.amazonaws.com/`;
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) throw new Error('The STS endpoint must be an https:// URL');
  const form = new URLSearchParams({
    Action: 'AssumeRole',
    Version: '2011-06-15',
    RoleArn: aws.roleArn,
    RoleSessionName: (aws.sessionName || 'steward').replace(/[^\w+=,.@-]/g, '-').slice(0, 64),
    DurationSeconds: '3600',
    ...(aws.externalId ? { ExternalId: aws.externalId } : {}),
  }).toString();
  const r = await rawRequest(
    p,
    {
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: form,
      bodyType: 'text',
      rawText: true,
      sign: async (req) => signRequest(req, { region: aws.region, service: 'sts', credentials: base }),
    },
    signal,
  );
  const creds = typeof r.body === 'string' ? parseAssumeRole(r.body) : null;
  if (!r.ok || !creds) throw new Error(`AssumeRole of ${aws.roleArn} failed with HTTP ${r.status}: ${short(r.body)}`);
  awsCache.set(identityKey(p), { ...creds, fetchedAt: Date.now() });
  return creds;
}

/** The signer for requests to the platform's own origins (AWS SigV4); undefined for other auth types. */
async function signerFor(p: Platform, secrets: Record<string, string>, signal?: AbortSignal, scope?: HttpRequest['aws']): Promise<HttpRequest['sign']> {
  const aws = p.config.auth?.aws;
  if (p.config.auth?.type !== 'aws_sigv4' || !aws) return undefined;
  const credentials = await awsCredentials(p, secrets, signal);
  const region = scope?.region ?? aws.region;
  const service = scope?.service ?? aws.service;
  return async (req) => signRequest(req, { region, service, credentials, unsignedPayload: service === 's3' && aws.unsignedPayload });
}

/** When the assumed role's credentials were fetched and end (like tokenInfo for logins). */
export function awsCredentialInfo(p: WithIdentity): { fetchedAt: string; expiresAt: string } | null {
  const c = awsCache.get(identityKey(p));
  return c ? { fetchedAt: new Date(c.fetchedAt).toISOString(), expiresAt: new Date(c.expiration).toISOString() } : null;
}

/** Where a login or token request went, for error messages: origin and path, never the query (it may hold credentials). */
function where(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'an invalid URL';
  }
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').slice(0, 300);
}

/** Network error codes worth another attempt (connection dropped/refused, DNS hiccup, timeouts). */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
]);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const NON_IDEMPOTENT = new Set(['POST', 'PATCH']);

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryNonIdempotent: boolean;
}

export function retryPolicy(p: Platform): RetryPolicy {
  const r = p.config.http?.retry ?? {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    maxRetries: Math.min(num(r.maxRetries, 3), 10),
    baseDelayMs: num(r.baseDelayMs, 500),
    maxDelayMs: num(r.maxDelayMs, 30000),
    retryNonIdempotent: !!r.retryNonIdempotent,
  };
}

/** Delay before retry number `retry` (1-based): Retry-After if given, else exponential backoff with full jitter. */
export function retryDelay(policy: RetryPolicy, retry: number, retryAfter?: string, now = Date.now()): number {
  if (retryAfter) {
    const t = retryAfter.trim();
    let ms: number | undefined;
    if (/^\d+(\.\d+)?$/.test(t)) ms = Number(t) * 1000;
    else {
      const at = Date.parse(t);
      if (!Number.isNaN(at)) ms = Math.max(0, at - now);
    }
    if (ms !== undefined) return Math.min(ms, policy.maxDelayMs);
  }
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  return Math.floor(Math.random() * cap);
}

/** Per-platform limit of concurrent requests (FIFO). */
export class Semaphore {
  active = 0;
  private queue: (() => void)[] = [];
  constructor(public limit: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw cancelledError();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.queue.indexOf(grant);
          if (i >= 0) this.queue.splice(i, 1);
          reject(cancelledError());
        };
        this.queue.push(grant);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next)
        next(); // slot handed over, active count unchanged
      else this.active--;
    };
  }
}
const semaphores = new Map<string, Semaphore>();

function semaphoreFor(p: Platform): Semaphore {
  const limit = Math.max(1, Math.min(Math.floor(p.config.http?.maxConcurrency ?? 4) || 4, 100));
  let s = semaphores.get(p.id);
  if (!s) semaphores.set(p.id, (s = new Semaphore(limit)));
  s.limit = limit;
  return s;
}

/** Requests currently in flight / waiting per platform (diagnostics, tests). */
export function platformConcurrency(platformId: string): number {
  return semaphores.get(platformId)?.active ?? 0;
}

function cancelledError(): Error {
  return Object.assign(new Error('Cancelled'), { cancelled: true });
}

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(cancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const MAX_REDIRECTS = 5;

/**
 * Send one request and follow up to MAX_REDIRECTS redirects manually. Credentials
 * are attached (and stripped) per hop: a hop that leaves the platform's allowed
 * origins receives no auth header, no default headers and no user header whose
 * value contains one of the platform's secret values. undici's own redirect
 * handling only strips `Authorization`, not custom-named credential headers.
 * Every redirect target goes through the outbound policy (0.9.0): the platform's
 * own origins and redirects that stay on an origin already sent to pass, any
 * other host must be allowed like a first request. A 307/308 to such another
 * host is refused when the body it would send again carries a credential.
 */
async function followRedirects(
  p: Platform,
  secrets: Record<string, string>,
  req: HttpRequest,
  initialQuery: Record<string, unknown>,
  signal: AbortSignal | undefined,
  attempt: number,
): Promise<HttpResult> {
  let method = req.method;
  let url = req.url;
  let body = req.body;
  let sawHttps = /^https:/i.test(url);
  const leakValues = secretValues(secrets);
  const sent: string[] = [];
  let lastStatus = 0;
  // credentials obtained for this request (an OAuth token, a Basic header): not in the platform's stored secrets
  const obtained: string[] = [];
  for (let hop = 0; ; hop++) {
    // paths the kind never calls (v0.5.0): a redirect cannot lead there either – checked with the method this hop is
    // sent with (a 307/308 keeps a changing method, which a read-only kind refuses); the rules of the kind whose
    // platform owns the hop's origin too (0.9.0)
    await assertKindRules(p.kind, url, method);
    // the identity's read-only flag and operation filter (0.13.0, ADR 0009): on every hop, before anything is sent
    if (await identityRestricts(p)) {
      const { assertIdentityAllows } = await import('./identityGuard.js');
      await assertIdentityAllows(p, secrets, { method, url, intent: req.intent });
    }
    // the pinning lookup is never asked for an IP literal: its address is checked here (0.9.0)
    assertLiteralAddressSafe(url);
    const hopTrusted = await credentialsAllowed(p, secrets, url);
    if (hop > 0) {
      // the outbound policy on every redirect hop (0.9.0, #243), with the platform's own origins allowed as for the first request
      await assertRedirectHop(p, url, sent, hopTrusted);
      // a 307/308 sends the body again: not with a credential in it to a host outside the platform's own origins
      if (!hopTrusted && body !== undefined && body !== null && !sameDestination(url, sent))
        assertRedirectBodyClean(body, [...secretValues(secrets), ...obtained], {
          from: sent[sent.length - 1]!,
          to: url,
          status: lastStatus,
          platformName: p.name,
        });
    }
    sent.push(url);
    // AWS SigV4: only requests to the platform's own origins are signed
    let sign: HttpRequest['sign'];
    let clientTls: ClientTls | undefined;
    const headers: Record<string, string> = {};
    if (hopTrusted) for (const [k, v] of Object.entries(p.config.http?.defaultHeaders ?? {})) headers[k.toLowerCase()] = v;
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      // Drop a user-supplied header that carries a secret when the hop is not trusted.
      if (!hopTrusted && typeof v === 'string' && leakValues.some((s) => v.includes(s))) continue;
      headers[k.toLowerCase()] = v;
    }
    if (hopTrusted) {
      if (/^http:/i.test(url) && sawHttps) {
        throw Object.assign(new Error(`Refusing to send credentials over an insecure redirect to ${url} (https → http downgrade)`), { retryable: false });
      }
      const auth = await obtainAuthHeader(p, secrets, signal);
      if (auth && !headers[auth[0]]) headers[auth[0]] = auth[1];
      if (auth) obtained.push(auth[1], auth[1].replace(/^(Bearer|Basic|Token)\s+/i, ''));
      sign = await signerFor(p, secrets, signal, req.aws);
      clientTls = clientTlsOf(secrets);
      if (p.config.auth?.type === 'apiKey' && p.config.auth.apiKeyIn === 'query' && hop === 0 && initialQuery) {
        /* the initial url already carries the query api key (buildUrl) */
      }
    }
    const res = await rawRequest(
      p,
      {
        method,
        url,
        headers,
        body,
        bodyType: req.bodyType,
        maxResponseBytes: req.maxResponseBytes,
        truncateResponseBytes: req.truncateResponseBytes,
        rawText: req.rawText,
        responseFile: req.responseFile,
        sign,
        clientTls,
      },
      signal,
      attempt,
    );
    const location = res.headers['location'];
    if (req.noRedirects) return res;
    if (!REDIRECT_CODES.has(res.status) || !location || hop >= MAX_REDIRECTS) {
      if (REDIRECT_CODES.has(res.status) && location && hop >= MAX_REDIRECTS) {
        throw Object.assign(new Error(`Too many redirects (more than ${MAX_REDIRECTS}) starting at ${req.url}`), { retryable: false });
      }
      return res;
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return res;
    }
    if (/^https:/i.test(url)) sawHttps = true;
    lastStatus = res.status;
    // 301/302/303 turn the request into a bodyless GET; 307/308 preserve method and body.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
    }
    url = next.toString();
  }
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * An absolute URL in place of a path (a check's or a step's path, a test path, an ad-hoc request) to a host that is
 * not the platform's own goes through the outbound policy like every other request (0.8.0): the platforms' origins or
 * the allow-list. The platform's own origins – its base URL, its trusted origins, the AWS endpoints of an AWS account,
 * where its credentials go – are what a path is.
 */
async function assertAbsoluteAllowed(url: string): Promise<void> {
  const { outboundContext } = await import('./policyContext.js');
  await assertOutboundAllowed(url, outboundContext());
}

/** A redirect target of a platform request: the outbound policy as for the first request (outbound.ts). */
async function assertRedirectHop(p: Platform, url: string, sent: string[], own: boolean): Promise<void> {
  const { outboundContext } = await import('./policyContext.js');
  await assertRedirectAllowed(url, sent, outboundContext(), { own, platformName: p.name });
}

/**
 * Perform an authenticated request against a platform.
 * Retries 429/502/503/504 and network errors (honouring Retry-After; POST/PATCH
 * only with retryNonIdempotent) and limits concurrent calls per platform.
 */
export async function platformRequest(p: Platform, secrets: Record<string, string>, req: HttpRequest, signal?: AbortSignal): Promise<HttpResult> {
  if (!p.baseUrl && !/^https?:/i.test(req.url)) throw new HttpError(400, 'Platform has no base URL');
  // Credentials (auth header, API key, default headers) only go to the platform's own origin(s).
  const trusted = await credentialsAllowed(p, secrets, req.url);
  const query = { ...(req.query ?? {}) };
  if (trusted && p.config.auth?.type === 'apiKey' && p.config.auth.apiKeyIn === 'query') {
    query[p.config.auth.apiKeyName || 'api_key'] = secrets.apiKey ?? '';
  }
  const url = await buildUrl(p, secrets, req.url, query);
  // paths the kind never calls, e.g. a vault's secret values (v0.5.0, deniedPaths.ts); kinds that are only read
  // (0.9.0: Kafka Connect #223, changedetection.io #242) refuse every method but GET/HEAD – the platform's kind and the
  // kind of the platform whose origin the URL is (0.9.0, restrictedOrigins.ts)
  await assertKindRules(p.kind, url, req.method);
  if (!trusted && /^https?:\/\//i.test(req.url)) await assertAbsoluteAllowed(url);
  if (!trusted) {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      /* invalid URL – reported by fetch */
    }
    logger.warn({ platform: p.name, host }, 'request to a host outside the platform – sent without credentials (see http.trustedOrigins)');
  }
  const send = (attempt: number) => followRedirects(p, secrets, { ...req, url }, query, signal, attempt);
  const policy = retryPolicy(p);
  const method = req.method.toUpperCase();
  const mayRetry = policy.maxRetries > 0 && (!NON_IDEMPOTENT.has(method) || policy.retryNonIdempotent);
  const sem = semaphoreFor(p);
  let target: URL | undefined;
  try {
    target = new URL(url);
  } catch {
    /* reported by fetch */
  }
  for (let attempt = 1; ; attempt++) {
    let res: HttpResult | undefined;
    let error: (Error & { retryable?: boolean }) | undefined;
    const release = await sem.acquire(signal);
    try {
      res = await send(attempt);
      if (res.status === 401 && tokenCache.has(identityKey(p))) {
        tokenCache.delete(identityKey(p));
        res = await send(attempt);
      }
    } catch (e) {
      error = e as Error & { retryable?: boolean };
    } finally {
      release();
    }
    const retryable = error ? !!error.retryable : RETRYABLE_STATUS.has(res!.status);
    if (!retryable || !mayRetry || attempt > policy.maxRetries || signal?.aborted) {
      if (error) throw error;
      // value keys of a vault's answers never leave this function (deniedPaths.ts) – also when another platform's
      // request ended at the vault's origin (0.9.0)
      let answer = stripValues(p.kind, res!.body);
      for (const k of new Set([...(await destinationKinds(url)), ...(await destinationKinds(res!.url))])) if (k !== p.kind) answer = stripValues(k, answer);
      const out = { ...res!, body: answer };
      return attempt > 1 ? { ...out, attempts: attempt } : out;
    }
    const delay = retryDelay(policy, attempt, res?.headers['retry-after']);
    const info = {
      platform: p.name,
      method,
      host: target?.host,
      path: target?.pathname,
      status: res?.status,
      error: error?.message,
      attempt,
      maxRetries: policy.maxRetries,
      delayMs: delay,
    };
    if (attempt === 1) logger.debug(info, 'platform call will be retried');
    else logger.warn(info, 'platform call will be retried');
    // the enclosing span (e.g. the process node) gets one event per retry
    trace.getActiveSpan()?.addEvent('http.retry', {
      'http.request.method': method,
      'http.response.status_code': res?.status ?? 0,
      'sm.http.attempt': attempt,
      'sm.http.retry_delay_ms': delay,
      ...(error ? { 'error.type': (error as { code?: string }).code ?? 'network' } : {}),
    });
    await waitMs(delay, signal);
  }
}

/** Sensitive values that must never appear in logs for this platform. */
/** Credential fields that identify rather than authenticate – masking them would corrupt ordinary data. */
const IDENTIFIER_KEYS = /^(user(name)?|login|account|client_?id|tenant(_?id)?|email)$/i;

/**
 * The credential values of a platform's secrets – identifiers (user name, client id, tenant …) left out – of at least
 * `min` characters: what may not appear in a request through another connection (0.9.0), where a short or
 * identifying value would match ordinary text.
 */
export function credentialValues(secrets: Record<string, string>, min = 6): string[] {
  return Object.entries(secrets)
    .filter(([k, v]) => typeof v === 'string' && v.length >= min && !IDENTIFIER_KEYS.test(k))
    .map(([, v]) => v);
}

export function secretValues(secrets: Record<string, string>): string[] {
  const vals = Object.entries(secrets)
    .filter(([k, v]) => typeof v === 'string' && v.length >= 4 && !IDENTIFIER_KEYS.test(k))
    .map(([, v]) => v);
  const tok = [...tokenCache.values()].flatMap((t) => [t.header[1].replace(/^(Bearer|Basic)\s+/i, ''), ...(t.refreshToken ? [t.refreshToken] : [])]);
  return [...vals, ...tok];
}
