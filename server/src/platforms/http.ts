import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch, type Dispatcher } from 'undici';
import { trace } from '@opentelemetry/api';
import type { AuthConfig, Platform } from '@sm/shared';
import { evalExpr, render, renderString } from '../engine/expr.js';
import { HttpError } from '../util.js';
import { SpanKind, SpanStatusCode, injectTraceHeaders, withSpan } from '../telemetry.js';
import { logger } from '../log.js';
import { emit } from '../events.js';
import { guardedLookup } from './outbound.js';
import { parseAssumeRole, signRequest, type AwsCredentials } from './sigv4.js';
import { JWT_ALGS, privateKeyOf, publicKeyFingerprint, signJwt } from './jwt.js';

export interface HttpRequest {
  method: string;
  url: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyType?: 'json' | 'form' | 'text';
  /** Fail when the response body is larger (bytes); default: no limit */
  maxResponseBytes?: number;
  /** Stop reading the response body after this many bytes instead (the result is marked `truncated`). */
  truncateResponseBytes?: number;
  /** Keep the body as text (no JSON detection) */
  rawText?: boolean;
  /** Return a redirect response as it is instead of following it. */
  noRedirects?: boolean;
  /** Signs the request as it is about to be sent (AWS SigV4, #114): may add headers */
  sign?: (r: { method: string; url: string; headers: Record<string, string>; body?: string }) => Promise<void>;
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
}

const tokenCache = new Map<string, CachedToken>();
const dispatcherCache = new Map<string, { stamp: string; dispatcher: Dispatcher }>();

/** The cached access token of a platform (login or OAuth2), without the token itself. */
export function tokenInfo(platformId: string): { fetchedAt: string; expiresAt: string } | null {
  const t = tokenCache.get(platformId);
  return t ? { fetchedAt: new Date(t.fetchedAt).toISOString(), expiresAt: new Date(t.expiresAt).toISOString() } : awsCredentialInfo(platformId);
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
  tokenCache.delete(p.id);
  awsCache.delete(p.id);
  if (p.config.auth?.type === 'aws_sigv4') await awsCredentials(p, secrets, signal);
  else await obtainAuthHeader(p, secrets, signal);
  const info = tokenInfo(p.id);
  if (!info) throw new Error('The login did not return a token');
  return info;
}

export function invalidatePlatformCaches(platformId: string): void {
  tokenCache.delete(platformId);
  awsCache.delete(platformId);
  const d = dispatcherCache.get(platformId);
  if (d) {
    dispatcherCache.delete(platformId);
    d.dispatcher.close().catch(() => undefined);
  }
}

function dispatcherFor(p: Platform): Dispatcher {
  const stamp = p.updatedAt;
  const hit = dispatcherCache.get(p.id);
  if (hit && hit.stamp === stamp) return hit.dispatcher;
  const connect = {
    rejectUnauthorized: !p.config.http?.insecureTls,
    ...(p.config.http?.caPem ? { ca: p.config.http.caPem } : {}),
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
  dispatcherCache.set(p.id, { stamp, dispatcher });
  return dispatcher;
}

function authScope(p: Platform, secrets: Record<string, string>) {
  return { vars: p.config.variables ?? {}, secrets, baseUrl: p.baseUrl, platform: { name: p.name, kind: p.kind } };
}

export async function resolveBaseUrl(p: Platform, secrets: Record<string, string>): Promise<string> {
  return (await renderString(p.baseUrl, authScope(p, secrets))).replace(/\/+$/, '');
}

/** Whether a request to pathOrUrl may carry the platform's credentials. Relative paths always may. */
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
  let body: string | undefined;
  if (req.body !== undefined && req.body !== null && !['GET', 'HEAD'].includes(req.method)) {
    const type = req.bodyType ?? (typeof req.body === 'string' ? 'text' : 'json');
    if (type === 'json') {
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
      dispatcher: dispatcherFor(p),
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
  if (req.method !== 'HEAD') {
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
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Reads at most `max` bytes of a response body; larger bodies fail (and the connection is released). */
async function readBounded(res: Awaited<ReturnType<typeof fetch>>, max: number, url: string): Promise<string> {
  const tooLarge = () => Object.assign(new Error(`The response of ${url} is larger than ${max} bytes`), { retryable: false, code: 'ETOOLARGE' });
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += (chunk as Uint8Array).length;
    if (size > max) {
      await res.body.cancel().catch(() => undefined);
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
    case 'bearer':
      if (!secrets.token) throw new Error('Secret "token" is not set');
      return ['authorization', `Bearer ${secrets.token}`];
    case 'apiKey':
      if (auth.apiKeyIn === 'query') return null;
      return [(auth.apiKeyName || 'x-api-key').toLowerCase(), secrets.apiKey ?? ''];
    case 'oauth2_client_credentials':
    case 'token_request': {
      const cached = tokenCache.get(p.id);
      if (cached && cached.expiresAt > Date.now() + 30000) return cached.header;
      let token: string;
      let expiresIn = 1800;
      if (auth.type === 'oauth2_client_credentials') {
        if (!auth.tokenUrl) throw new Error('OAuth2 token URL is not configured');
        if (!secrets.clientId || !secrets.clientSecret) throw new Error('Secrets "clientId" and "clientSecret" are required');
        const url = await renderString(auth.tokenUrl, scope);
        const form: Record<string, string> = { grant_type: 'client_credentials' };
        if (auth.scope) form.scope = auth.scope;
        for (const [k, v] of Object.entries(auth.extraParams ?? {})) form[k] = await renderString(v, scope);
        const headers: Record<string, string> = {};
        if ((auth.clientAuth ?? 'basic') === 'basic') {
          headers.authorization = 'Basic ' + Buffer.from(`${secrets.clientId}:${secrets.clientSecret}`).toString('base64');
        } else {
          form.client_id = secrets.clientId;
          form.client_secret = secrets.clientSecret;
        }
        const r = await rawRequest(p, { method: 'POST', url, headers, body: form, bodyType: 'form' }, signal);
        const b = r.body as { access_token?: string; expires_in?: number } | null;
        if (!r.ok || !b?.access_token) throw new Error(`Token request POST ${where(url)} failed with HTTP ${r.status}: ${short(r.body)}`);
        token = b.access_token;
        if (b.expires_in) expiresIn = Number(b.expires_in);
      } else {
        const rq = auth.request;
        if (!rq?.url) throw new Error('Login request URL is not configured');
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
        if (!r.ok) throw new Error(`Login request ${rq.method ?? 'POST'} ${where(fullUrl)} failed with HTTP ${r.status}: ${short(r.body)}`);
        const t = await evalExpr(auth.tokenPath || 'access_token', r.body, { headers: r.headers });
        if (!t || typeof t !== 'string') throw new Error(`Login response did not contain a token at "${auth.tokenPath}"`);
        token = t;
        if (auth.expiresInPath) {
          const e = Number(await evalExpr(auth.expiresInPath, r.body));
          if (e > 0) expiresIn = e;
        }
      }
      const headerName = (auth.headerName || 'Authorization').toLowerCase();
      const headerValue = await renderString(auth.headerValue || 'Bearer {{ token }}', { ...scope, token });
      const header: [string, string] = [headerName, headerValue];
      const now = Date.now();
      tokenCache.set(p.id, { header, fetchedAt: now, expiresAt: now + expiresIn * 1000 });
      return header;
    }
    case 'jwt': {
      const cached = tokenCache.get(p.id);
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
      tokenCache.set(p.id, { header, fetchedAt: Date.now(), expiresAt });
      return header;
    }
    case 'aws_sigv4':
      // signed per request (signerFor)
      return null;
    default:
      throw new Error(`Unsupported auth type ${(auth as AuthConfig).type}`);
  }
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
  const cached = awsCache.get(p.id);
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
  awsCache.set(p.id, { ...creds, fetchedAt: Date.now() });
  return creds;
}

/** The signer for requests to the platform's own origins (AWS SigV4); undefined for other auth types. */
async function signerFor(p: Platform, secrets: Record<string, string>, signal?: AbortSignal): Promise<HttpRequest['sign']> {
  const aws = p.config.auth?.aws;
  if (p.config.auth?.type !== 'aws_sigv4' || !aws) return undefined;
  const credentials = await awsCredentials(p, secrets, signal);
  return async (req) => signRequest(req, { region: aws.region, service: aws.service, credentials, unsignedPayload: aws.unsignedPayload });
}

/** When the assumed role's credentials were fetched and end (like tokenInfo for logins). */
export function awsCredentialInfo(platformId: string): { fetchedAt: string; expiresAt: string } | null {
  const c = awsCache.get(platformId);
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
  for (let hop = 0; ; hop++) {
    const hopTrusted = await credentialsAllowed(p, secrets, url);
    // AWS SigV4: only requests to the platform's own origins are signed
    let sign: HttpRequest['sign'];
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
      sign = await signerFor(p, secrets, signal);
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
        sign,
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
      if (res.status === 401 && tokenCache.has(p.id)) {
        tokenCache.delete(p.id);
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
      return attempt > 1 ? { ...res!, attempts: attempt } : res!;
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

export function secretValues(secrets: Record<string, string>): string[] {
  const vals = Object.entries(secrets)
    .filter(([k, v]) => typeof v === 'string' && v.length >= 4 && !IDENTIFIER_KEYS.test(k))
    .map(([, v]) => v);
  const tok = [...tokenCache.values()].map((t) => t.header[1].replace(/^(Bearer|Basic)\s+/i, ''));
  return [...vals, ...tok];
}
