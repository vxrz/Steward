/**
 * Public REST API: versioned, read-only endpoints under /api/v1, their
 * OpenAPI 3.1 description (generated from the route schemas by
 * @fastify/swagger) and an optional Swagger UI under /api/docs.
 *
 * Registered with prefix "/api" in its own encapsulated scope, so its hooks,
 * error handler and shared schemas never affect the web UI's internal API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance, type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi, { type FastifySwaggerUiOptions } from '@fastify/swagger-ui';
import { BRAND } from '@sm/shared';
import { config } from '../config.js';
import { logger } from '../log.js';
import { requestContext } from '../auth/context.js';
import { toAuthUser } from '../auth/users.js';
import { HttpError } from '../util.js';
import { API_VERSION, DOCS_BASE, setDocsUiAvailable } from './v1/config.js';
import { apiAuthHook, docsAccess, type ApiPrincipal } from './v1/auth.js';
import { ProblemError, problemBody, sendProblem, PROBLEM_BASE } from './v1/problem.js';
import { OPERATION_ERRORS, PAGINATED_OPERATIONS, v1Routes } from './v1/routes.js';
import { componentSchemas } from './v1/schemas.js';

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DESCRIPTION = `Read-only access to the data ${BRAND.name} holds: processes and their versions, runs with their step journal and logs, decisions, schedules, platform metadata, dashboard datasets, the audit log, users and teams.

**Authentication.** Every endpoint except \`/health\` needs a personal API token: \`Authorization: Bearer smt_…\`. Create one on your profile page in the web UI (scope *read* is enough). A token acts with the rights of its owner – use a dedicated service account with the *viewer* or *auditor* role for integrations. Session cookies are not accepted.

**Conventions.** JSON with camelCase fields; timestamps are ISO 8601 in UTC; ids are strings. Lists return \`{ items, nextCursor }\` – pass \`nextCursor\` as \`cursor\` to get the next page (also offered as an RFC 8288 \`Link: <…>; rel="next"\` header). \`limit\` is 1–200 (default 50). Errors are problem details (RFC 9457, \`application/problem+json\`). Responses carry \`Cache-Control: no-store\` and \`RateLimit-*\` headers; above the limit the API answers 429 with \`Retry-After\`.

**Versioning.** The path carries the major version. Within v1 changes are additive (new endpoints, optional parameters and fields) – ignore fields you do not know. Breaking changes get a new major version; endpoints that are going away are announced with \`Deprecation\` and \`Sunset\` headers first.`;

const TAGS = [
  { name: 'Meta', description: 'Health, the token in use and this document' },
  { name: 'Processes', description: 'Process definitions and their version history' },
  { name: 'Runs', description: 'Executions with step journal, logs, decisions and checks' },
  { name: 'Tasks', description: 'User tasks (selections and approvals) of runs' },
  { name: 'Schedules', description: 'Cron schedules' },
  { name: 'Platforms', description: 'Connected systems – metadata only, never credentials' },
  { name: 'Dashboards', description: 'Datasets published by processes, and dashboard definitions' },
  { name: 'Audit', description: 'Tamper-evident audit log (auditors and administrators)' },
  { name: 'Users', description: 'Accounts and teams (administrators)' },
];

const problemContent = { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } };
const RESPONSES: Record<number, [string, string]> = {
  400: ['BadRequest', 'Invalid query parameter, path parameter or cursor'],
  401: ['Unauthorized', 'Missing, invalid, expired or revoked API token'],
  403: ['Forbidden', 'The token owner is not allowed to do this (or is deactivated)'],
  404: ['NotFound', 'Does not exist, or the token owner may not see it'],
  409: ['Conflict', 'The data changed while paging; start again without a cursor'],
  429: ['TooManyRequests', 'Rate limit exceeded; see Retry-After'],
  503: ['ServiceUnavailable', 'The vault is locked; an administrator has to unlock it'],
};

const RATE_HEADERS = {
  'RateLimit-Limit': { $ref: '#/components/headers/RateLimit-Limit' },
  'RateLimit-Remaining': { $ref: '#/components/headers/RateLimit-Remaining' },
  'RateLimit-Reset': { $ref: '#/components/headers/RateLimit-Reset' },
  'RateLimit-Policy': { $ref: '#/components/headers/RateLimit-Policy' },
};

/** Completes the generated document: security, shared responses and headers, error responses per operation. */
function finalizeDocument(doc: Doc): Doc {
  doc.components ??= {};
  doc.components.securitySchemes = {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'smt_ token',
      description: 'Personal API token from the profile page of the web UI (`smt_…`). Read-only tokens are sufficient.',
    },
  };
  doc.components.headers = {
    'RateLimit-Limit': { description: 'Requests allowed per window (per token)', schema: { type: 'integer' } },
    'RateLimit-Remaining': { description: 'Requests left in the current window', schema: { type: 'integer' } },
    'RateLimit-Reset': { description: 'Seconds until the quota is fully restored', schema: { type: 'integer' } },
    'RateLimit-Policy': { description: 'Quota policy, e.g. `600;w=60` (600 requests per 60 seconds)', schema: { type: 'string' } },
    'Retry-After': { description: 'Seconds to wait before retrying', schema: { type: 'integer' } },
    Link: { description: 'RFC 8288 link to the next page (`rel="next"`), when there is one', schema: { type: 'string' } },
  };
  doc.components.responses = Object.fromEntries(
    Object.entries(RESPONSES).map(([status, [name, description]]) => [
      name,
      {
        description,
        content: problemContent,
        ...(status === '429' || status === '503' ? { headers: { 'Retry-After': { $ref: '#/components/headers/Retry-After' } } } : {}),
      },
    ]),
  );
  doc.security = [{ bearerAuth: [] }];
  for (const item of Object.values<Doc>(doc.paths ?? {})) {
    for (const op of Object.values<Doc>(item)) {
      if (!op || typeof op !== 'object' || !op.responses) continue;
      const ok = op.responses['200'];
      if (ok) ok.headers = { ...RATE_HEADERS, ...(PAGINATED_OPERATIONS.has(op.operationId) ? { Link: { $ref: '#/components/headers/Link' } } : {}) };
      const errors = OPERATION_ERRORS.get(op.operationId) ?? [401, 403, 429];
      const anonymous = op.operationId === 'getHealth';
      if (anonymous) {
        op.security = [];
        op.responses['503'] = { description: 'The vault is locked', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } };
        op.responses['429'] = { $ref: '#/components/responses/TooManyRequests' };
        continue;
      }
      if (op.operationId === 'getOpenApiDocument') op.security = [{ bearerAuth: [] }, {}];
      for (const s of [...errors, 503]) op.responses[String(s)] = { $ref: `#/components/responses/${RESPONSES[s]![0]}` };
    }
  }
  return doc;
}

const swaggerOptions = {
  openapi: {
    openapi: '3.1.0',
    info: {
      title: `${BRAND.name} API`,
      version: API_VERSION,
      summary: `Read-only REST API of ${BRAND.name}`,
      description: DESCRIPTION,
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
      contact: { name: BRAND.name, url: BRAND.repoUrl },
    },
    externalDocs: { description: 'API guide (docs/API.md)', url: `${BRAND.repoUrl}/blob/main/docs/API.md` },
    servers: [{ url: '/api/v1', description: 'This server' }],
    tags: TAGS,
  },
  hideUntagged: true,
  refResolver: { buildLocalReference: (json: { $id?: string }, _base: unknown, _frag: unknown, i: number) => json.$id ?? `def-${i}` },
  transformObject: ({ openapiObject }: { openapiObject?: Doc }) => finalizeDocument(openapiObject as Doc),
};

/** Swagger UI assets: unpacked next to the web UI in the desktop executable, else from node_modules. */
function swaggerUiDir(): string | null {
  const candidates = [process.env.SM_SWAGGER_UI_DIR];
  try {
    const req = createRequire(typeof import.meta.url === 'string' ? import.meta.url : path.join(process.cwd(), 'index.js'));
    candidates.push(path.join(path.dirname(req.resolve('@fastify/swagger-ui/package.json')), 'static'));
  } catch {
    /* not installed next to the bundle (single-file executable) */
  }
  return candidates.find((d): d is string => !!d && fs.existsSync(path.join(d, 'swagger-ui-bundle.js'))) ?? null;
}

/** Guard for the documentation routes (SM_API_DOCS / setting). */
async function docsGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const access = docsAccess(req);
  if (access.allowed) return;
  if (access.status === 404) return void sendProblem(req, reply, 404, { detail: 'The API documentation is turned off' });
  if (String(req.headers.accept ?? '').includes('text/html')) {
    return void reply
      .code(401)
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><meta charset="utf-8"><title>${BRAND.name} API</title><p>Sign in to <a href="/">${BRAND.name}</a> first to read the API documentation.</p>`,
      );
  }
  return void sendProblem(req, reply, 401, { type: 'token-required', title: 'Unauthorized', detail: 'Sign in to the web UI to read the API documentation' });
}

async function v1Scope(app: FastifyInstance, opts: { spec: () => Doc }): Promise<void> {
  app.addHook('onRequest', apiAuthHook);
  // Run the handler "as" the token owner, so services apply their permission checks.
  app.addHook('preHandler', (req, _reply, done) => {
    const p = (req as unknown as { smApi?: ApiPrincipal }).smApi;
    if (!p) return done();
    requestContext.run({ user: toAuthUser(p.user), ip: req.ip }, done);
  });
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; validation?: { instancePath?: string; params?: Record<string, string>; message?: string }[]; validationContext?: string };
    if (err instanceof ProblemError) return sendProblem(req, reply, err.status, err.init);
    if (e.validation) {
      const where = e.validationContext === 'params' ? 'path' : 'query';
      return sendProblem(req, reply, 400, {
        type: 'validation-error',
        title: 'Invalid request',
        detail: e.message,
        errors: e.validation.map((v) => ({
          in: where,
          name: (v.instancePath ?? '').replace(/^\//, '').split('/')[0] || v.params?.missingProperty || '',
          message: v.message ?? 'invalid',
        })),
      });
    }
    if (err instanceof HttpError) {
      const s = err.statusCode;
      const type = s === 403 ? 'forbidden' : s === 404 ? 'not-found' : s === 400 ? 'validation-error' : undefined;
      return sendProblem(req, reply, s, { type, detail: err.message });
    }
    if (e.statusCode && e.statusCode < 500) return sendProblem(req, reply, e.statusCode, { detail: e.message });
    logger.error({ err, reqId: req.id }, 'public API: unhandled error');
    return sendProblem(req, reply, 500, { detail: `Internal error (request id ${req.id})` });
  });
  const noEndpoint = (req: FastifyRequest, reply: FastifyReply) =>
    sendProblem(req, reply, 404, { type: 'not-found', title: 'Not found', detail: `No endpoint ${req.method} ${req.url.split('?')[0]}` });
  app.setNotFoundHandler(noEndpoint);
  // Explicit catch-all, so the web UI's static file handler (a root wildcard) never answers under /api/v1.
  app.get('/*', { schema: { hide: true } }, noEndpoint);
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/*',
    schema: { hide: true },
    config: { smAuth: 'none' },
    handler: (req, reply) => {
      reply.header('allow', 'GET, HEAD');
      return sendProblem(req, reply, 405, { type: 'method-not-allowed', title: 'Method not allowed', detail: 'The public API is read-only' });
    },
  });
  await app.register(v1Routes, { spec: opts.spec });
}

/** The plugin; register with `{ prefix: '/api' }`. */
export async function publicApi(app: FastifyInstance): Promise<void> {
  // Mark every route of this scope so the app's session-based preHandler leaves them alone.
  app.addHook('onRoute', (route) => {
    route.config = { ...(route.config ?? {}), smPublicApi: true };
  });
  await app.register(swagger, swaggerOptions as never);
  for (const s of componentSchemas()) app.addSchema(s);

  let cached: Doc | null = null;
  const spec = (): Doc => (cached ??= app.swagger() as unknown as Doc);
  await app.register(v1Scope, { prefix: '/v1', spec });

  const dir = swaggerUiDir();
  setDocsUiAvailable(!!dir);
  if (!dir) {
    logger.info('Swagger UI assets not found – API documentation page disabled (the OpenAPI document stays available)');
    app.get('/docs', { schema: { hide: true } }, async (req, reply) =>
      sendProblem(req, reply, 404, { detail: 'The API documentation page is not available in this build – use /api/v1/openapi.json' }),
    );
    return;
  }
  // Always pass a logo: without one the plugin reads its own file relative to __dirname (missing in the executable).
  const logoFile = [path.join(config.webDist, 'icon.svg'), path.join(dir, 'logo.svg')].find((f) => fs.existsSync(f));
  // Own scope, so the guard also covers the static assets (uiHooks only reach the plugin's own routes).
  await app.register(async (docs) => {
    docs.addHook('onRequest', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      await docsGuard(req, reply);
    });
    await docs.register(swaggerUi as unknown as FastifyPluginAsync<FastifySwaggerUiOptions>, {
      routePrefix: DOCS_BASE.replace(/^\/api/, ''),
      // absolute asset URLs in the page when it is opened without a trailing slash
      indexPrefix: '/api',
      baseDir: dir,
      logo: { type: 'image/svg+xml', content: logoFile ? fs.readFileSync(logoFile) : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), href: '/', target: '_self' },
      theme: { title: `${BRAND.name} API` },
      uiConfig: {
        deepLinking: true,
        displayOperationId: true,
        displayRequestDuration: true,
        defaultModelsExpandDepth: 1,
        persistAuthorization: false,
        supportedSubmitMethods: ['get', 'head'],
        tryItOutEnabled: false,
      },
      validatorUrl: false,
      staticCSP: false,
      transformSpecification: (doc: Readonly<Record<string, unknown>>) => doc as Record<string, unknown>,
      transformSpecificationClone: false,
    });
  });
}

/** Builds the OpenAPI document without starting a server (for `npm run openapi`). */
export async function buildOpenApiDocument(): Promise<Doc> {
  const app = Fastify({ logger: false });
  let doc: Doc | null = null;
  await app.register(
    async (api) => {
      await publicApi(api);
      api.addHook('onReady', async () => {
        doc = api.swagger() as unknown as Doc;
      });
    },
    { prefix: '/api' },
  );
  await app.ready();
  await app.close();
  return doc!;
}

export { problemBody, PROBLEM_BASE };
