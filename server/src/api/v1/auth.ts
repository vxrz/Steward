/**
 * Access control of the public API:
 * - every data endpoint needs `Authorization: Bearer smt_…` (read or full
 *   scope); session cookies are ignored, so CSRF does not apply;
 * - tokens in the URL are refused (they leak into logs and browser history);
 * - per-token rate limit (token bucket), per-IP for unauthenticated calls;
 * - the token's owner must be active, must not have a pending password change,
 *   and the vault must be unlocked.
 * Token use is recorded in the audit log once per token and UTC day; every
 * request is logged at debug level by the app's onResponse hook.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiDocsMode, UserInfo } from '@sm/shared';
import { vault } from '../../vault.js';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import { logger } from '../../log.js';
import { bearerToken, resolveToken } from '../../auth/tokens.js';
import { readCookie, SESSION_COOKIE } from '../../auth/cookies.js';
import { sessionUser } from '../../auth/users.js';
import { BRAND } from '@sm/shared';
import { apiEnabled, docsMode, rateLimitPerMinute } from './config.js';
import { sendProblem } from './problem.js';
import { TokenBucketLimiter } from './rateLimit.js';

export interface ApiPrincipal {
  user: UserInfo;
  tokenId: string;
  tokenName: string;
  scope: 'read' | 'full';
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export type AuthMode = 'token' | 'none' | 'spec';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Public API: how a route is protected (default token) */
    smAuth?: AuthMode;
    /** Set on every route of the public API and its documentation; the app's session hook skips them. */
    smPublicApi?: boolean;
  }
}

export const limiter = new TokenBucketLimiter();

const REALM = `${BRAND.name} API`;
const URL_TOKEN_PARAMS = ['access_token', 'token', 'api_key', 'apikey'];

/** Applies the rate limit for `key`; sends 429 and returns false when exceeded. */
function rateLimit(req: FastifyRequest, reply: FastifyReply, key: string): boolean {
  const limit = rateLimitPerMinute();
  if (!limit) return true;
  const d = limiter.take(key, limit);
  reply.header('ratelimit-limit', String(d.limit));
  reply.header('ratelimit-remaining', String(d.remaining));
  reply.header('ratelimit-reset', String(d.resetSeconds));
  reply.header('ratelimit-policy', `${d.limit};w=60`);
  if (d.allowed) return true;
  reply.header('retry-after', String(d.retryAfterSeconds));
  sendProblem(req, reply, 429, {
    type: 'rate-limited',
    title: 'Too many requests',
    detail: `Rate limit of ${d.limit} requests per minute exceeded – retry after ${d.retryAfterSeconds} s`,
  });
  return false;
}

function unauthorized(req: FastifyRequest, reply: FastifyReply, detail: string, error?: 'invalid_token'): void {
  reply.header('www-authenticate', `Bearer realm="${REALM}"${error ? `, error="${error}"` : ''}`);
  sendProblem(req, reply, 401, { type: error ? 'invalid-token' : 'token-required', title: 'Unauthorized', detail });
}

/** Whether the documentation (and the OpenAPI document without a token) may be shown to this request. */
export function docsAccess(req: FastifyRequest): { allowed: true } | { allowed: false; status: 401 | 404; mode: ApiDocsMode } {
  const { mode } = docsMode();
  if (mode === 'public') return { allowed: true };
  if (mode === 'authenticated') {
    let user: UserInfo | null = null;
    try {
      user = sessionUser(readCookie(req.headers.cookie, SESSION_COOKIE));
    } catch {
      user = null;
    }
    return user ? { allowed: true } : { allowed: false, status: 401, mode };
  }
  return { allowed: false, status: 404, mode };
}

const usedToday = new Map<string, string>();
/** One audit entry per token and UTC day (survives restarts: checks the log once per process). */
function recordDailyUse(p: ApiPrincipal, ip: string): void {
  const day = new Date().toISOString().slice(0, 10);
  if (usedToday.get(p.tokenId) === day) return;
  usedToday.set(p.tokenId, day);
  const seen = db().get(
    "SELECT 1 AS x FROM audit_log WHERE action = 'api.token_used' AND entity_id = ? AND ts >= ? LIMIT 1",
    p.tokenId,
    `${day}T00:00:00.000Z`,
  );
  if (seen) return;
  audit({
    actor: p.user.username,
    action: 'api.token_used',
    entityType: 'token',
    entityId: p.tokenId,
    summary: `API token "${p.tokenName}" of ${p.user.username} used the public API (first use on ${day})`,
    details: { scope: p.scope, ip },
  });
}

/** onRequest hook of the /api/v1 scope. */
export async function apiAuthHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('cache-control', 'no-store');
  if (!apiEnabled()) return void sendProblem(req, reply, 404, { detail: 'The public API is turned off on this server (SM_API_V1=off)' });

  const qs = req.url.includes('?') ? new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1)) : null;
  if (qs && URL_TOKEN_PARAMS.some((k) => qs.has(k))) {
    return void sendProblem(req, reply, 400, {
      type: 'token-in-url',
      title: 'Token in URL',
      detail: 'Tokens are not accepted in the URL (they end up in logs and browser history). Send them as "Authorization: Bearer <token>" – and revoke the token if it was real.',
    });
  }

  const mode: AuthMode = req.routeOptions.config?.smAuth ?? 'token';
  const bearer = bearerToken(req.headers.authorization);
  const ipKey = `ip:${req.ip}`;

  if (mode === 'none' || (mode === 'spec' && !bearer)) {
    if (!rateLimit(req, reply, ipKey)) return;
    if (mode === 'none') return;
    const access = docsAccess(req);
    if (access.allowed) return;
    if (access.status === 404) return void sendProblem(req, reply, 404, { detail: 'The API documentation is turned off – send an API token to get the OpenAPI document' });
    return unauthorized(req, reply, 'Sign in to the web UI or send an API token to get the OpenAPI document');
  }

  if (!bearer) {
    if (!rateLimit(req, reply, ipKey)) return;
    return unauthorized(
      req,
      reply,
      req.headers.cookie
        ? 'The public API does not accept session cookies. Create an API token on your profile page and send it as "Authorization: Bearer <token>".'
        : 'Send an API token as "Authorization: Bearer <token>". Tokens are created on the profile page of the web UI.',
    );
  }

  const r = resolveToken(bearer);
  if (!r.ok) {
    if (!rateLimit(req, reply, ipKey)) return;
    logger.debug({ reqId: req.id, ip: req.ip, reason: r.reason }, 'public API: token refused');
    if (r.reason === 'owner_disabled') {
      return void sendProblem(req, reply, 403, { type: 'owner-disabled', title: 'Forbidden', detail: 'The owner of this API token is deactivated' });
    }
    return unauthorized(req, reply, 'Invalid, expired or revoked API token', 'invalid_token');
  }
  if (!rateLimit(req, reply, `tok:${r.tokenId}`)) return;
  if (r.user.mustChangePassword) {
    return void sendProblem(req, reply, 403, {
      type: 'password-change-required',
      title: 'Forbidden',
      detail: 'The owner of this token has to change their password in the web UI first',
    });
  }
  if (!vault().unlocked) {
    reply.header('retry-after', '60');
    return void sendProblem(req, reply, 503, { type: 'vault-locked', title: 'Vault locked', detail: 'The vault is locked – an administrator has to unlock it' });
  }
  const p: ApiPrincipal = {
    user: r.user,
    tokenId: r.tokenId,
    tokenName: r.name,
    scope: r.scope,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
  };
  const anyReq = req as unknown as { smApi?: ApiPrincipal; smUser?: string; smToken?: string };
  anyReq.smApi = p;
  anyReq.smUser = p.user.username;
  anyReq.smToken = p.tokenId;
  try {
    recordDailyUse(p, req.ip);
  } catch (e) {
    logger.warn({ err: e }, 'public API: could not record token use');
  }
}
