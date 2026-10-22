/**
 * Streamable HTTP transport of the MCP server: POST /api/mcp (JSON responses, no SSE stream; GET and
 * DELETE answer 405), plus the internal routes for the settings page and the per-platform gateway switch.
 *
 * Every request to the endpoint, in this order (before the body is read):
 *   Host allow-list (app.ts) → Origin check (DNS rebinding) → MCP turned on → bearer token with scope
 *   "mcp" (no cookies, no tokens in the URL) → rate limit per token (per IP without a valid token) →
 *   owner active, no pending password change, vault unlocked → JSON content type, body ≤ 64 kB.
 * Tools then run "as" the token owner with a time limit; a client disconnect cancels them.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError } from '../util.js';
import { currentUser, requestContext } from '../auth/context.js';
import { requireCapability, require as requirePermission } from '../auth/permissions.js';
import { bearerToken, resolveToken } from '../auth/tokens.js';
import { toAuthUser } from '../auth/users.js';
import { TokenBucketLimiter } from '../api/v1/rateLimit.js';
import * as platforms from '../platforms/service.js';
import { emit } from '../events.js';
import { MAX_REQUEST_BYTES, TOOL_TIMEOUT_MS, extraAllowedOrigins, mcpEnabled, mcpForcedOff, mcpRateLimit, mcpServerStatus, setMcpEnabled } from './config.js';
import { PARSE_ERROR, INVALID_REQUEST, INTERNAL_ERROR, STEWARD_ERRORS, errorResponse } from './protocol.js';
import { handleMessage } from './server.js';
import type { McpPrincipal } from './tools.js';

export const mcpLimiter = new TokenBucketLimiter();
const REALM = 'Steward MCP';
const URL_TOKEN_PARAMS = ['access_token', 'token', 'api_key', 'apikey'];

/** A refusal at the HTTP layer, with a JSON-RPC error body without id (as the transport allows). */
function refuse(reply: FastifyReply, status: number, code: number, message: string, outcome: string): FastifyReply {
  emit('mcp.request', { method: 'http', outcome });
  return reply
    .code(status)
    .type('application/json; charset=utf-8')
    .send(JSON.stringify(errorResponse(null, { code, message })));
}

function rateLimited(reply: FastifyReply, key: string): boolean {
  const d = mcpLimiter.take(key, mcpRateLimit());
  reply.header('ratelimit-limit', String(d.limit));
  reply.header('ratelimit-remaining', String(d.remaining));
  reply.header('ratelimit-reset', String(d.resetSeconds));
  reply.header('ratelimit-policy', `${d.limit};w=60`);
  if (d.allowed) return false;
  reply.header('retry-after', String(d.retryAfterSeconds));
  refuse(
    reply,
    429,
    STEWARD_ERRORS.rateLimited,
    `Rate limit of ${d.limit} requests per minute exceeded – retry after ${d.retryAfterSeconds} s`,
    'rate_limited',
  );
  return true;
}

/** Steward's own origin(s) for this request, plus the configured extra origins. */
function originAllowed(req: FastifyRequest, origin: string): boolean {
  let o: string;
  try {
    o = new URL(origin).origin;
  } catch {
    return false; // "null" and other opaque origins
  }
  const host = String(req.headers.host ?? '');
  const own = [`http://${host}`, `https://${host}`].map((x) => {
    try {
      return new URL(x).origin;
    } catch {
      return '';
    }
  });
  return [...own, ...extraAllowedOrigins()].includes(o);
}

const usedToday = new Map<string, string>();
/** First MCP use of a token per UTC day goes to the audit log (survives restarts: checks the log once). */
function recordDailyUse(p: McpPrincipal, ip: string): void {
  const day = new Date().toISOString().slice(0, 10);
  if (usedToday.get(p.tokenId) === day) return;
  usedToday.set(p.tokenId, day);
  const seen = db().get(
    "SELECT 1 AS x FROM audit_log WHERE action = 'mcp.token_used' AND entity_id = ? AND ts >= ? AND seq >= 1 LIMIT 1",
    p.tokenId,
    `${day}T00:00:00.000Z`,
  );
  if (seen) return;
  audit({
    actor: p.user.username,
    action: 'mcp.token_used',
    entityType: 'token',
    entityId: p.tokenId,
    summary: `MCP token "${p.tokenName}" of ${p.user.username} used the MCP server (first use on ${day})`,
    details: { ip },
  });
}

async function guard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('cache-control', 'no-store');
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(req, String(origin))) {
    return void refuse(reply, 403, STEWARD_ERRORS.forbidden, 'Origin not allowed (set SM_MCP_ALLOWED_ORIGINS for browser-based MCP clients)', 'origin');
  }
  if (req.method !== 'POST') return; // answered with 405 by the route
  if (!mcpEnabled()) {
    return void refuse(
      reply,
      403,
      STEWARD_ERRORS.disabled,
      mcpForcedOff()
        ? 'The MCP server is turned off on this server (SM_MCP=off)'
        : 'The MCP server is turned off – an administrator can turn it on under Settings → MCP server',
      'disabled',
    );
  }
  const qs = req.url.includes('?') ? new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1)) : null;
  if (qs && URL_TOKEN_PARAMS.some((k) => qs.has(k))) {
    return void refuse(
      reply,
      400,
      STEWARD_ERRORS.unauthorized,
      'Tokens are not accepted in the URL – send "Authorization: Bearer <token>" (and revoke the token if it was real)',
      'token_in_url',
    );
  }
  const ipKey = `ip:${req.ip}`;
  const bearer = bearerToken(req.headers.authorization);
  if (!bearer) {
    if (rateLimited(reply, ipKey)) return;
    reply.header('www-authenticate', `Bearer realm="${REALM}"`);
    return void refuse(
      reply,
      401,
      STEWARD_ERRORS.unauthorized,
      'Send an MCP token as "Authorization: Bearer <token>" (create one with scope "MCP client" on your profile page)',
      'unauthorized',
    );
  }
  const r = resolveToken(bearer);
  if (!r.ok) {
    if (rateLimited(reply, ipKey)) return;
    logger.debug({ reqId: req.id, ip: req.ip, reason: r.reason }, 'MCP: token refused');
    if (r.reason === 'owner_disabled') return void refuse(reply, 403, STEWARD_ERRORS.forbidden, 'The owner of this token is deactivated', 'forbidden');
    reply.header('www-authenticate', `Bearer realm="${REALM}", error="invalid_token"`);
    return void refuse(reply, 401, STEWARD_ERRORS.unauthorized, 'Invalid, expired or revoked token', 'unauthorized');
  }
  if (rateLimited(reply, `tok:${r.tokenId}`)) return;
  if (r.scope !== 'mcp') {
    return void refuse(
      reply,
      403,
      STEWARD_ERRORS.forbidden,
      'This token is not enabled for MCP – create a token with scope "MCP client" on your profile page',
      'scope',
    );
  }
  if (r.user.mustChangePassword)
    return void refuse(reply, 403, STEWARD_ERRORS.forbidden, 'The owner of this token has to change their password in the web UI first', 'forbidden');
  if (!vault().unlocked) {
    reply.header('retry-after', '60');
    return void refuse(reply, 503, STEWARD_ERRORS.unavailable, 'The vault is locked – an administrator has to unlock it', 'locked');
  }
  const ct = String(req.headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (ct !== 'application/json') return void refuse(reply, 415, INVALID_REQUEST, 'Content-Type must be application/json', 'content_type');
  const accept = String(req.headers.accept ?? '');
  if (accept && !/(application\/json|application\/\*|\*\/\*)/i.test(accept))
    return void refuse(reply, 406, INVALID_REQUEST, 'This server answers with application/json – include it in Accept', 'accept');
  const principal: McpPrincipal = { user: r.user, tokenId: r.tokenId, tokenName: r.name };
  const anyReq = req as unknown as { smMcp?: McpPrincipal; smUser?: string; smToken?: string };
  anyReq.smMcp = principal;
  anyReq.smUser = r.user.username;
  anyReq.smToken = r.tokenId;
  try {
    recordDailyUse(principal, req.ip);
  } catch (e) {
    logger.warn({ err: e }, 'MCP: could not record token use');
  }
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

/** The endpoint, in its own scope: own authentication, JSON-RPC error bodies. */
async function endpoint(app: FastifyInstance): Promise<void> {
  // the app's session hook leaves these routes alone (own authentication, see guard)
  app.addHook('onRoute', (route) => {
    route.config = { ...(route.config ?? {}), smPublicApi: true };
  });
  app.addHook('onRequest', guard);
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (e.statusCode === 413)
      return refuse(reply, 413, STEWARD_ERRORS.tooLarge, `Request body too large (at most ${MAX_REQUEST_BYTES / 1024} kB)`, 'too_large');
    if (e.statusCode === 415) return refuse(reply, 415, INVALID_REQUEST, 'Content-Type must be application/json', 'content_type');
    if (e.statusCode === 400) return refuse(reply, 400, PARSE_ERROR, 'Parse error: the body is not valid JSON', 'parse_error');
    logger.error({ err }, 'MCP endpoint: unhandled error');
    return refuse(reply, 500, INTERNAL_ERROR, 'Internal error', 'failed');
  });

  app.post('/mcp', { bodyLimit: MAX_REQUEST_BYTES }, async (req, reply) => {
    const principal = (req as unknown as { smMcp: McpPrincipal }).smMcp;
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, TOOL_TIMEOUT_MS);
    // the client went away before the answer: stop the work
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) ac.abort();
    });
    try {
      const out = await requestContext.run({ user: toAuthUser(principal.user as UserInfo), ip: req.ip }, () =>
        handleMessage(
          req.body,
          { protocolVersion: header(req, 'mcp-protocol-version'), method: header(req, 'mcp-method'), name: header(req, 'mcp-name') },
          { principal, signal: ac.signal, ip: req.ip },
          () => timedOut,
        ),
      );
      if (out.status === 202 || !out.body) return reply.code(202).send();
      return reply.code(out.status).type('application/json; charset=utf-8').send(JSON.stringify(out.body));
    } finally {
      clearTimeout(timer);
    }
  });
  // No server-to-client stream and no sessions: GET and DELETE are not offered.
  app.route({
    method: ['GET', 'DELETE', 'PUT', 'PATCH'],
    url: '/mcp',
    handler: (_req, reply) => {
      reply.header('allow', 'POST');
      return refuse(reply, 405, INVALID_REQUEST, 'Method not allowed: send JSON-RPC messages with POST', 'method');
    },
  });
}

const gatewayBody = z
  .object({
    enabled: z.boolean(),
    allowedPathPrefixes: z
      .array(
        z
          .string()
          .trim()
          .max(300)
          .refine(
            (p) => /^\/[\x21-\x7e]*$/.test(p) && !/[?#\\%@;]/.test(p) && !p.split('/').some((s) => s === '.' || s === '..') && !p.startsWith('//'),
            'a path starting with "/", without "?", "#", "%", "@", ";", "\\" or dot segments',
          ),
      )
      .max(50)
      .optional(),
  })
  .strict();

/** Registered with prefix "/api". */
export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  await app.register(endpoint);

  // For the settings and profile pages (any signed-in user: it says how to connect, nothing secret).
  app.get('/mcp-server', async () => mcpServerStatus());
  app.put('/mcp-server', async (req) => {
    requireCapability(currentUser(), 'manageSettings', 'change the MCP settings');
    const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    if (b.enabled && mcpForcedOff()) throw new HttpError(409, 'SM_MCP=off turns the MCP server off on this server – remove it to turn the server on here');
    setMcpEnabled(b.enabled);
    return mcpServerStatus();
  });

  app.put('/platforms/:id/mcp-gateway', async (req) => {
    const id = (req.params as { id: string }).id;
    const p = platforms.getPlatform(id);
    if (!p.permissions.length) throw new HttpError(404, `Platform ${id} not found`);
    requirePermission(p.permissions, 'manage', 'change the MCP gateway of this platform');
    return platforms.setMcpGateway(id, gatewayBody.parse(req.body));
  });
}
