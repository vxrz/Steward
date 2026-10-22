import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { config } from './config.js';
import { vault } from './vault.js';
import { HttpError } from './util.js';
import { registerRoutes } from './routes/index.js';
import { mockPlatform } from './mock/mockPlatform.js';
import { requestContext } from './auth/context.js';
import { sessionUser, toAuthUser } from './auth/users.js';
import { readCookie, SESSION_COOKIE } from './auth/cookies.js';
import { bearerToken, tokenUser } from './auth/tokens.js';
import { logger } from './log.js';

/** Reachable without signing in. */
const PUBLIC_PATHS = ['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/setup', '/api/vault/status', '/api/ready'];
/** Reachable while the vault is locked (for signed-in users). */
const LOCKED_OK = ['/api/auth/', '/api/vault/'];

/** Content Security Policy for the SPA (Mantine injects inline styles, hence 'unsafe-inline' for styles only). */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');
/** The single sign-on callback page finishes with a small inline script. */
const CSP_SSO_CALLBACK = CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");

const isRead = (method: string) => method === 'GET' || method === 'HEAD';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: logger } : { logger: false }),
    disableRequestLogging: true,
    bodyLimit: 25 * 1024 * 1024,
    ...(config.tls ? { https: { cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) } } : {}),
  }) as unknown as FastifyInstance;
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  // --- local-only safety net ---
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (url.startsWith('/mock/')) return;
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const allowedHosts = ['localhost', '127.0.0.1', '[::1]', ...(process.env.SM_ALLOWED_HOSTS?.split(',') ?? [])];
    if (!allowedHosts.includes(host)) {
      return reply.code(403).send({ error: 'Host not allowed' });
    }
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', url.startsWith('/api/auth/oidc/callback') ? CSP_SSO_CALLBACK : CSP);
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (config.tls) reply.header('strict-transport-security', 'max-age=31536000');
    if (!url.startsWith('/api/')) return;
    // CSRF protection: browsers cannot add custom headers cross-origin without CORS (which we never allow).
    // Requests with a bearer token and no cookie are exempt: browsers never attach bearer tokens on their own.
    const bearerOnly = !!bearerToken(req.headers.authorization) && !req.headers.cookie;
    if (!isRead(req.method) && !bearerOnly && req.headers['x-sm-client'] !== '1') {
      return reply.code(403).send({ error: 'Missing x-sm-client header' });
    }
  });

  // Authentication: resolve the session and run the rest of the request "as" that user.
  // (Synchronous hook + AsyncLocalStorage.run keeps the user available to all services.)
  app.addHook('preHandler', (req, reply, done) => {
    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/')) return done();
    let info = sessionUser(readCookie(req.headers.cookie, SESSION_COOKIE));
    const isPublic =
      PUBLIC_PATHS.includes(url) || url.startsWith('/api/auth/oidc/') || (url === '/api/metrics' && process.env.SM_METRICS_PUBLIC === '1');
    // API tokens act as their owner when there is no signed-in session.
    const bearer = info ? undefined : bearerToken(req.headers.authorization);
    if (bearer) {
      const t = tokenUser(bearer);
      if (!t && !isPublic) return void reply.code(401).send({ error: 'Invalid, expired or revoked API token' });
      if (t && t.scope === 'read' && !isRead(req.method)) return void reply.code(403).send({ error: 'This API token is read-only' });
      if (t) {
        info = t.user;
        (req as unknown as { smToken?: string }).smToken = t.tokenId;
      }
    }
    const user = info ? toAuthUser(info) : null;
    if (!isPublic) {
      if (!user) return void reply.code(401).send({ error: 'Please sign in' });
      if (info!.mustChangePassword && !url.startsWith('/api/auth/')) {
        return void reply.code(403).send({ error: 'Please change your password first', code: 'PASSWORD_CHANGE_REQUIRED' });
      }
      if (!vault().unlocked && !LOCKED_OK.some((p) => url.startsWith(p))) {
        return void reply.code(423).send({ error: 'The vault is locked – an administrator has to unlock it' });
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
      ip: req.ip,
    };
    if (status >= 500) logger.error(entry, 'request failed');
    else if (status >= 400 && ![401, 404, 423].includes(status)) logger.warn(entry, 'request rejected');
    else if (ms > 2000) logger.warn(entry, 'slow request');
    else if (req.method !== 'GET') logger.info(entry, 'request');
    else logger.debug(entry, 'request');
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, issues: (err as HttpError & { issues?: unknown }).issues });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const e = err as Error & { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    logger.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: e.message || 'Internal error' });
  });

  if (config.demo) await app.register(mockPlatform, { prefix: '/mock' });

  await app.register(registerRoutes, { prefix: '/api' });

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      preCompressed: true, // serves the .br/.gz files written by the web build
      setHeaders: (res, file) => {
        // hashed build assets never change
        if (/[\\/]assets[\\/]/.test(file)) res.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const isPage = req.method === 'GET' && !/^\/(api|mock)\//.test(req.url) && !/\.[a-z0-9]+(\?|$)/i.test(req.url);
      if (!isPage) return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html').send(fs.readFileSync(path.join(config.webDist, 'index.html')));
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send('<p>Web UI not built. Run <code>npm run build</code> or use <code>npm run dev</code>.</p>'),
    );
  }
  return app;
}
