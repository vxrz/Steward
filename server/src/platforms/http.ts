import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch, type Dispatcher } from 'undici';
import type { AuthConfig, Platform } from '@sm/shared';
import { evalExpr, render, renderString } from '../engine/expr.js';
import { HttpError } from '../util.js';

export interface HttpRequest {
  method: string;
  url: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyType?: 'json' | 'form' | 'text';
}

export interface HttpResult {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

interface CachedToken {
  header: [string, string];
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const dispatcherCache = new Map<string, { stamp: string; dispatcher: Dispatcher }>();

export function invalidatePlatformCaches(platformId: string): void {
  tokenCache.delete(platformId);
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
  };
  const proxy = p.config.http?.proxy?.trim();
  let dispatcher: Dispatcher;
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

export async function buildUrl(
  p: Platform,
  secrets: Record<string, string>,
  pathOrUrl: string,
  query?: Record<string, unknown>,
): Promise<string> {
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

async function rawRequest(p: Platform, req: HttpRequest, signal?: AbortSignal): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: 'application/json, */*;q=0.5', ...(req.headers ?? {}) };
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
      redirect: 'follow',
    });
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const cause = err.cause?.message ? ` (${err.cause.message})` : '';
    throw new Error(`${req.method} ${req.url} failed: ${err.message}${cause}`);
  }
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (resHeaders[k] = v));
  let parsed: unknown = null;
  if (req.method !== 'HEAD') {
    const text = await res.text();
    const ct = resHeaders['content-type'] ?? '';
    if (text && (ct.includes('json') || /^[\s]*[{[]/.test(text))) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    } else parsed = text;
  }
  return { status: res.status, ok: res.ok, url: req.url, headers: resHeaders, body: parsed, durationMs: Date.now() - started };
}

async function obtainAuthHeader(
  p: Platform,
  secrets: Record<string, string>,
  signal?: AbortSignal,
): Promise<[string, string] | null> {
  const auth: AuthConfig = p.config.auth ?? { type: 'none' };
  const scope = authScope(p, secrets);
  switch (auth.type) {
    case 'none':
      return null;
    case 'basic':
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
        if (!r.ok || !b?.access_token) throw new Error(`Token request failed with HTTP ${r.status}: ${short(r.body)}`);
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
        if (!r.ok) throw new Error(`Login request failed with HTTP ${r.status}: ${short(r.body)}`);
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
      tokenCache.set(p.id, { header, expiresAt: Date.now() + expiresIn * 1000 });
      return header;
    }
    default:
      throw new Error(`Unsupported auth type ${(auth as AuthConfig).type}`);
  }
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').slice(0, 300);
}

/** Perform an authenticated request against a platform. */
export async function platformRequest(
  p: Platform,
  secrets: Record<string, string>,
  req: HttpRequest,
  signal?: AbortSignal,
): Promise<HttpResult> {
  if (!p.baseUrl && !/^https?:/i.test(req.url)) throw new HttpError(400, 'Platform has no base URL');
  const query = { ...(req.query ?? {}) };
  if (p.config.auth?.type === 'apiKey' && p.config.auth.apiKeyIn === 'query') {
    query[p.config.auth.apiKeyName || 'api_key'] = secrets.apiKey ?? '';
  }
  const url = await buildUrl(p, secrets, req.url, query);
  const send = async () => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.config.http?.defaultHeaders ?? {})) headers[k.toLowerCase()] = v;
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    const auth = await obtainAuthHeader(p, secrets, signal);
    if (auth && !headers[auth[0]]) headers[auth[0]] = auth[1];
    return rawRequest(p, { ...req, url, headers }, signal);
  };
  let res = await send();
  if (res.status === 401 && tokenCache.has(p.id)) {
    tokenCache.delete(p.id);
    res = await send();
  }
  return res;
}

/** Sensitive values that must never appear in logs for this platform. */
export function secretValues(secrets: Record<string, string>): string[] {
  const vals = Object.values(secrets).filter((v) => typeof v === 'string' && v.length >= 4);
  const tok = [...tokenCache.values()].map((t) => t.header[1].replace(/^(Bearer|Basic)\s+/i, ''));
  return [...vals, ...tok];
}
