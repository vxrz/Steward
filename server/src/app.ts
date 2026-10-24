import fs from 'node:fs';
import { BlockList, isIPv6 } from 'node:net';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { vault } from './vault.js';
import { HttpError } from './util.js';
import { registerRoutes } from './routes/index.js';
import { mockPlatform } from './mock/mockPlatform.js';
import { currentUser, requestContext } from './auth/context.js';
import { sessionUser, toAuthUser } from './auth/users.js';
import { LINK_PARAM, readCookie, SESSION_COOKIE, SESSION_HEADER } from './auth/cookies.js';
import { connectVaultToDatabase } from './vault-rotation.js';
import { instanceRoutes } from './instance.js';
import { bearerToken, tokenUser } from './auth/tokens.js';
import { logger } from './log.js';
import { publicApi } from './api/index.js';
import { clientConfig, cspConnectSources, reportError } from './errorReporting.js';
import { themeRoutes } from './theme/routes.js';
import { systemRoutes } from './system/routes.js';
import { mcpRoutes } from './mcp/http.js';
import { MCP_PATH } from './mcp/config.js';
import { countRefused, rateLimitOptions, setRateLimitUser, wasRateLimited } from './rateLimits.js';
import { checkBodyShape } from './bodyShape.js';
import { injectBaseHref, OUTSIDE_BASE, stripBasePath, withBasePath } from './basePath.js';

/** Reachable without signing in. */
const PUBLIC_PATHS = [
  '/api/health',
  '/api/instance',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/vault/status',
  '/api/ready',
  '/api/client-config',
  '/api/theme',
  '/api/theme/logo',
];
/**
 * Identities, sign-in settings and the master passphrase are managed by signed-in people only: an API token
 * (whatever its scope) is refused here. Otherwise a leaked automation token could mint lasting access that
 * outlives revoking it – a new administrator, a reset password, another API token, a changed sign-in setup.
 */
export const SESSION_ONLY_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/me/tokens',
  'POST /api/users',
  'PUT /api/users/:id',
  'POST /api/users/:id/reset-password',
  'POST /api/teams',
  'PUT /api/teams/:id',
  'DELETE /api/teams/:id',
  'POST /api/sso/providers',
  'PUT /api/sso/providers/:id',
  'DELETE /api/sso/providers/:id',
  'PUT /api/settings',
  'POST /api/vault/passphrase',
  'POST /api/vault/lock',
  // Git sync sources carry an access token and decide what may enter the installation
  'POST /api/sync-sources',
  'PUT /api/sync-sources/:id',
  'DELETE /api/sync-sources/:id',
  'POST /api/sync-sources/:id/rotate-webhook-secret',
]);
/** Inbound webhooks: machine-to-machine, authenticated by the trigger's secret (no session, no CSRF header). */
const HOOKS_PREFIX = '/api/hooks/';
/** Reachable while the vault is locked (for signed-in users). */
const LOCKED_OK = ['/api/auth/', '/api/vault/'];

/**
 * Content Security Policy for the SPA (Mantine injects inline styles, hence 'unsafe-inline' for styles only).
 * connect-src additionally allows the error reporting host when browser error reporting is configured.
 */
function contentSecurityPolicy(connectExtra: string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    ["connect-src 'self'", ...connectExtra].join(' '),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; ');
}

/** An error raised by SQLite (node:sqlite) or PostgreSQL (see database/pg-bridge.ts), not by Steward itself. */
export function isDatabaseError(err: unknown): boolean {
  const e = err as { name?: string; code?: unknown } | null;
  return !!e && (e.name === 'PgError' || (typeof e.code === 'string' && e.code.startsWith('ERR_SQLITE')));
}

const isRead = (method: string) => method === 'GET' || method === 'HEAD';
/** The public REST API (/api/v1) authenticates with API tokens only (see api/v1/auth.ts). */
const isPublicApiPath = (url: string) => url === '/api/v1' || url.startsWith('/api/v1/') || url.startsWith('/api/v1?');
/** The MCP endpoint: bearer tokens only, own Origin check, size limit and errors (see mcp/http.ts). */
const isMcpEndpoint = (url: string) => url === MCP_PATH;
/** Liveness and readiness probes: a probe refused for someone else's traffic from its address would restart a healthy server. */
const PROBE_PATHS = ['/api/health', '/api/ready'];
/**
 * Requests the general rate limits (rateLimits.ts) never count: the public API and the MCP endpoint
 * (own per-token limiters), the probes and the demo's mock platforms.
 */
function rateLimitExempt(req: FastifyRequest): boolean {
  const url = req.routeOptions.url ?? req.url.split('?')[0]!;
  return (
    PROBE_PATHS.includes(url) ||
    !!req.routeOptions.config?.smPublicApi ||
    isPublicApiPath(url) ||
    isMcpEndpoint(url) ||
    (config.demo && url.startsWith('/mock/'))
  );
}
/** Public reads of the web UI before sign-in: page, theme, error reporting set-up. */
const WEB_UI_API = ['/api/theme', '/api/theme/logo', '/api/client-config'];
/**
 * The web UI's files (built assets, the page itself, the manifest) and its public start-up reads: counted
 * per address with a higher limit (rateLimits.ts) – a browser with an empty cache fetches dozens per page.
 */
function webUiRequest(req: FastifyRequest): boolean {
  if (!isRead(req.method)) return false;
  const url = req.routeOptions.url ?? req.url.split('?')[0]!;
  return WEB_UI_API.includes(url) || !url.startsWith('/api/');
}

/**
 * TLS settings for the built-in HTTPS server: TLS 1.2 or newer, forward-secret AEAD cipher suites
 * only (TLS 1.3 suites are always on). SM_TLS_CIPHERS overrides the TLS 1.2 list.
 */
export const TLS_CIPHERS =
  'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305';

/** Loopback and private networks (RFC 1918, RFC 4193, link-local): where a reverse proxy in front of Steward lives. */
const PRIVATE_PEERS = (() => {
  const b = new BlockList();
  for (const [net, prefix] of [
    ['127.0.0.0', 8],
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['169.254.0.0', 16],
  ] as const)
    b.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of [
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
  ] as const)
    b.addSubnet(net, prefix, 'ipv6');
  return b;
})();

/**
 * Fastify's trust function for SM_TRUST_PROXY. Addresses/CIDRs: the usual proxy-addr matching. A hop count
 * (Fastify refuses those, as they cannot check the peer): the nearest n hops are trusted, but only when the
 * direct peer is on loopback or a private network – a client from outside cannot forge X-Forwarded-For.
 */
export function trustProxyFn(tp: number | string[]): string[] | ((addr: string, i: number) => boolean) {
  if (Array.isArray(tp)) return tp;
  let peerOk = false;
  return (addr: string, i: number) => {
    if (i === 0) {
      const a = addr.replace(/^::ffff:/, '');
      peerOk = PRIVATE_PEERS.check(a, isIPv6(a) ? 'ipv6' : 'ipv4');
      return peerOk && tp > 0;
    }
    return peerOk && i < tp;
  };
}

/**
 * A request outside the base path (SM_BASE_PATH): 404 – nothing of Steward lives there. Only "/" itself is
 * redirected to the base path (a fixed target, never built from the request). The most likely cause is a
 * reverse proxy that strips the prefix: logged as a hint, at most once a minute.
 */
let lastOutsideHint = 0;
function outsideBasePath(req: FastifyRequest, reply: FastifyReply) {
  const original = String((req.raw as { originalUrl?: string }).originalUrl ?? req.raw.url ?? '');
  if (original === '/' && isRead(req.method)) return reply.code(302).header('location', `${config.basePath}/`).send();
  if (Date.now() - lastOutsideHint > 60_000) {
    lastOutsideHint = Date.now();
    logger.warn(
      { method: req.method, path: original.split('?')[0]!.slice(0, 200), basePath: config.basePath },
      `request outside the base path ${config.basePath} answered with 404 – if a reverse proxy is in front, it has to pass the path on unchanged (no prefix stripping), see docs/INSTALL.md`,
    );
  }
  return reply.code(404).header('cache-control', 'no-store').send({ error: 'Not found' });
}

/** Requests without any credentials may only send small bodies (sign-in, setup); everything else needs a session or token first. */
const ANONYMOUS_BODY_LIMIT = 64 * 1024;

/** Every route an app instance registered (method + full URL, HEAD left out): the route permission matrix test checks them all. */
const ROUTE_TABLES = new WeakMap<FastifyInstance, { method: string; url: string }[]>();
export const registeredRoutes = (app: FastifyInstance): { method: string; url: string }[] => [...(ROUTE_TABLES.get(app) ?? [])];

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  connectVaultToDatabase();
  const BASE = config.basePath;
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: logger } : { logger: false }),
    disableRequestLogging: true,
    bodyLimit: 25 * 1024 * 1024,
    // Under a path prefix (SM_BASE_PATH): strip it once before routing, so every route, check and limit below
    // sees the same paths as at the root; requests outside it are marked and answered with 404 (onRequest).
    ...(BASE ? { rewriteUrl: (req: Parameters<typeof stripBasePath>[0]) => stripBasePath(req, BASE) } : {}),
    // Behind a reverse proxy: believe X-Forwarded-For/-Proto/-Host only from the configured proxies (SM_TRUST_PROXY)
    ...(config.trustProxy !== undefined ? { trustProxy: trustProxyFn(config.trustProxy) } : {}),
    ...(config.tls
      ? {
          https: {
            cert: fs.readFileSync(config.tls.cert),
            key: fs.readFileSync(config.tls.key),
            minVersion: 'TLSv1.2' as const,
            ciphers: process.env.SM_TLS_CIPHERS || TLS_CIPHERS,
            honorCipherOrder: true,
          },
        }
      : {}),
  }) as unknown as FastifyInstance;
  const routeTable: { method: string; url: string }[] = [];
  ROUTE_TABLES.set(app, routeTable);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) if (method !== 'HEAD') routeTable.push({ method, url: r.url });
  });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
  // Rate limits for every route registered below (per user, else per client address; see rateLimits.ts)
  await app.register(rateLimit, rateLimitOptions({ exempt: rateLimitExempt, webUi: webUiRequest }));
  const limitRefused = app.rateLimit();
  // Bounded work for every route's validation: no body with millions of list items or fields (see bodyShape.ts)
  app.addHook('preValidation', checkBodyShape);
  const CSP = contentSecurityPolicy(cspConnectSources());
  /** The single sign-on callback page finishes with a small inline script. */
  const CSP_SSO_CALLBACK = CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");

  // Under a path prefix: redirects to app paths ("/x") stay below it, whoever sends them (routes, plugins, mocks).
  if (BASE) {
    app.addHook('onSend', async (req, reply, payload) => {
      const loc = reply.getHeader('location');
      if (typeof loc === 'string' && !(req.raw as { [OUTSIDE_BASE]?: boolean })[OUTSIDE_BASE]) reply.header('location', withBasePath(loc, BASE));
      return payload;
    });
  }

  // --- local-only safety net ---
  app.addHook('onRequest', async (req, reply) => {
    if ((req.raw as { [OUTSIDE_BASE]?: boolean })[OUTSIDE_BASE]) return outsideBasePath(req, reply);
    // Only origin-form request targets ("/path"). Absolute-form ("GET http://host/api/…") would otherwise
    // reach routes while looking like a non-API URL to the checks below.
    if (!req.url.startsWith('/')) return reply.code(400).send({ error: 'Bad request target' });
    // Decide by the route that actually matched (Fastify decodes and normalises the path for routing).
    const url = req.routeOptions.url ?? req.url.split('?')[0]!;
    if (url.startsWith('/mock/')) return;
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const allowedHosts = ['localhost', '127.0.0.1', '[::1]', ...(process.env.SM_ALLOWED_HOSTS?.split(',') ?? [])];
    if (!allowedHosts.includes(host)) {
      if (isPublicApiPath(url)) {
        return reply
          .code(403)
          .type('application/problem+json')
          .send(JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Host not allowed' }));
      }
      return reply.code(403).send({ error: 'Host not allowed' });
    }
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', url.startsWith('/api/auth/oidc/callback') ? CSP_SSO_CALLBACK : CSP);
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (config.secureCookies) reply.header('strict-transport-security', 'max-age=31536000');
    if (!url.startsWith('/api/') || isPublicApiPath(url) || isMcpEndpoint(url)) return;
    // API responses are never cached (they carry personal data and secrets' metadata); routes may set their own.
    reply.header('cache-control', 'no-store');
    const anonymous = !req.headers.cookie && !req.headers.authorization;
    if (anonymous && !url.startsWith(HOOKS_PREFIX)) {
      if (Number(req.headers['content-length'] ?? 0) > ANONYMOUS_BODY_LIMIT) return reply.code(413).send({ error: 'Request body too large – sign in first' });
      // A body without a length (chunked) could skip the check above
      if (req.headers['transfer-encoding'] && req.headers['content-length'] === undefined)
        return reply.code(411).send({ error: 'Content-Length required – sign in first' });
    }
    // CSRF protection: browsers cannot add custom headers cross-origin without CORS (which we never allow).
    // Requests with a bearer token and no cookie are exempt: browsers never attach bearer tokens on their own.
    const bearerOnly = !!bearerToken(req.headers.authorization) && !req.headers.cookie;
    if (!isRead(req.method) && !bearerOnly && req.headers['x-sm-client'] !== '1' && !url.startsWith(HOOKS_PREFIX)) {
      return reply.code(403).send({ error: 'Missing x-sm-client header' });
    }
  });

  // Authentication: resolve the session and run the rest of the request "as" that user.
  // (Synchronous hook + AsyncLocalStorage.run keeps the user available to all services.)
  app.addHook('preHandler', (req, reply, done) => {
    // The matched route, not the raw URL: encoded or unusual spellings of a path can't skip authentication.
    const url = req.routeOptions.url ?? req.url.split('?')[0]!;
    if (!url.startsWith('/api/')) return done();
    // Public API and its documentation: own authentication (API tokens), see api/.
    if (req.routeOptions.config?.smPublicApi || isPublicApiPath(url)) return done();
    // The cookie alone is not enough: the session key header (or, for GET links, the link key) must match (see users.ts).
    const sessionKey = req.headers[SESSION_HEADER];
    const linkKey = (req.query as Record<string, unknown> | undefined)?.[LINK_PARAM];
    let info = sessionUser(readCookie(req.headers.cookie, SESSION_COOKIE), {
      key: typeof sessionKey === 'string' ? sessionKey : undefined,
      link: typeof linkKey === 'string' ? linkKey : undefined,
      read: isRead(req.method),
    });
    const isPublic =
      PUBLIC_PATHS.includes(url) ||
      url.startsWith('/api/auth/oidc/') ||
      url.startsWith(HOOKS_PREFIX) ||
      (url === '/api/metrics' && process.env.SM_METRICS_PUBLIC === '1');
    // API tokens act as their owner when there is no signed-in session.
    const bearer = info ? undefined : bearerToken(req.headers.authorization);
    if (bearer) {
      const t = tokenUser(bearer);
      if (!t && !isPublic) {
        return countRefused(limitRefused, req, reply, done, () => void reply.code(401).send({ error: 'Invalid, expired or revoked API token' }));
      }
      if (t && t.scope === 'read' && !isRead(req.method)) return void reply.code(403).send({ error: 'This API token is read-only' });
      // MCP tokens work on the MCP endpoint only (its own scope, see mcp/http.ts)
      if (t && t.scope === 'mcp' && !isPublic) return void reply.code(403).send({ error: 'This API token is for MCP clients only (/api/mcp)' });
      if (t && SESSION_ONLY_ROUTES.has(`${req.method} ${url}`)) {
        return void reply.code(403).send({ error: 'API tokens cannot do this – sign in to the web UI', code: 'SESSION_REQUIRED' });
      }
      if (t && t.scope !== 'mcp') {
        info = t.user;
        (req as unknown as { smToken?: string }).smToken = t.tokenId;
      }
    }
    const user = info ? toAuthUser(info) : null;
    setRateLimitUser(req, user?.id);
    if (!isPublic) {
      // made-up cookies or tokens count against the client address (see rateLimits.ts)
      if (!user) return countRefused(limitRefused, req, reply, done, () => void reply.code(401).send({ error: 'Please sign in', code: 'NOT_SIGNED_IN' }));
      if (info!.mustChangePassword && !url.startsWith('/api/auth/')) {
        return void reply.code(403).send({ error: 'Please change your password first', code: 'PASSWORD_CHANGE_REQUIRED' });
      }
      if (!vault().unlocked && !LOCKED_OK.some((p) => url.startsWith(p))) {
        return void reply.code(423).send({ error: 'The vault is locked – an administrator has to unlock it', code: 'VAULT_LOCKED' });
      }
    }
    (req as unknown as { smUser?: string }).smUser = user?.username;
    requestContext.run({ user, ip: req.ip }, done);
  });

  // One log line per API request: debug for routine reads, info for changes, warn/error for problems.
  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const ms = Math.round(reply.elapsedTime);
    const status = reply.statusCode;
    const entry = {
      reqId: req.id,
      method: req.method,
      path: req.url.split('?')[0],
      status,
      ms,
      user: (req as unknown as { smUser?: string }).smUser,
      token: (req as unknown as { smToken?: string }).smToken,
      ip: req.ip,
    };
    // 503 = temporarily unavailable (e.g. /api/v1 while the vault is locked), not a server failure
    if (status >= 500 && status !== 503) logger.error(entry, 'request failed');
    // rate-limited requests: one 'rate limit reached' line per key and minute instead (rateLimits.ts)
    else if (status >= 400 && ![401, 404, 423, 503].includes(status) && !wasRateLimited(req)) logger.warn(entry, 'request rejected');
    else if (ms > 2000) logger.warn(entry, 'slow request');
    else if (req.method !== 'GET') logger.info(entry, 'request');
    else logger.debug(entry, 'request');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply
        .code(err.statusCode)
        .send({ error: err.message, code: err.code, params: err.params, issues: (err as HttpError & { issues?: unknown }).issues });
    }
    if (err instanceof ZodError) {
      // the schema messages stay English (docs/I18N.md); the UI puts them into a translated sentence
      const details = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: details, code: 'INVALID_INPUT', params: { details } });
    }
    const e = err as Error & { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    logger.error({ err }, 'unhandled error');
    reportError(err, {
      tags: { route: req.routeOptions?.url ?? 'unknown', method: req.method, request_id: req.id },
      userId: currentUser()?.id,
      request: { method: req.method, url: req.url },
    });
    // Database errors can quote SQL, constraint and column names: the details go to the log only.
    return reply.code(500).send({ error: isDatabaseError(err) ? `Internal error (request id ${req.id})` : e.message || 'Internal error' });
  });

  // Runtime settings for the web UI (one build works with and without error reporting).
  app.get('/api/client-config', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return clientConfig();
  });

  if (config.demo) await app.register(mockPlatform, { prefix: '/mock' });

  await app.register(publicApi, { prefix: '/api' });
  await app.register(mcpRoutes, { prefix: '/api' });
  await app.register(instanceRoutes, { prefix: '/api' });
  await app.register(registerRoutes, { prefix: '/api' });
  // theme (/api/theme, /api/settings/theme, /manifest.webmanifest), about and system status
  await app.register(themeRoutes);
  await app.register(systemRoutes);

  if (fs.existsSync(config.webDist)) {
    // index.html always comes from the page handler below: it gets the <base href> of the base path
    const page = () => injectBaseHref(fs.readFileSync(path.join(config.webDist, 'index.html'), 'utf8'), BASE);
    await app.register(fastifyStatic, {
      root: config.webDist,
      index: false,
      allowedPath: (pathName) => pathName !== '/index.html',
      preCompressed: true, // serves the .br/.gz files written by the web build
      setHeaders: (res, file) => {
        // hashed build assets never change
        if (/[\\/]assets[\\/]/.test(file)) res.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    // the start page (at the root and at "<base path>" / "<base path>/"): the page, not the directory
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page()));
    // the page fallback reads index.html: limited like the routes (the plugin only hooks routes)
    app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) => {
      // the file-extension check looks at the path only: /records?subject=a@example.com is a page, /missing.js is not
      const pathname = req.url.split('?')[0]!;
      const isPage = req.method === 'GET' && !/^\/(api|mock)\//.test(pathname) && (!/\.[a-z0-9]+$/i.test(pathname) || pathname === '/index.html');
      if (!isPage) return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html; charset=utf-8').send(page());
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send('<p>Web UI not built. Run <code>npm run build</code> or use <code>npm run dev</code>.</p>'),
    );
  }
  return app;
}
