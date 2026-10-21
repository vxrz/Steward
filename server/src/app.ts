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

const OPEN_API_PATHS = ['/api/health', '/api/vault/'];

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: 'warn' } : false,
    bodyLimit: 25 * 1024 * 1024,
  });
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
    if (!url.startsWith('/api/')) return;
    // CSRF protection: browsers cannot add custom headers cross-origin without CORS (which we never allow).
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-sm-client'] !== '1') {
      return reply.code(403).send({ error: 'Missing x-sm-client header' });
    }
    if (!vault().unlocked && !OPEN_API_PATHS.some((p) => url.startsWith(p))) {
      return reply.code(423).send({ error: 'Vault is locked' });
    }
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
    console.error(err);
    return reply.code(500).send({ error: e.message || 'Internal error' });
  });

  if (config.demo) await app.register(mockPlatform, { prefix: '/mock' });

  await app.register(registerRoutes, { prefix: '/api' });

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
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
