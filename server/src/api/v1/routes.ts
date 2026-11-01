/**
 * Endpoints of the public, read-only REST API (/api/v1). They reuse the
 * services and permission checks of the web UI's internal API, but map the
 * results to the stable shapes in schemas.ts.
 */
import YAML from 'yaml';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { vault } from '../../vault.js';
import { currentUser } from '../../auth/context.js';
import { capabilities } from '../../auth/permissions.js';
import { monitorApiRoutes } from '../../monitors/api-v1.js';
import { credentialApiRoutes } from '../../credentials/api-v1.js';
import { recordApiRoutes } from '../../records/api-v1.js';
import { ticketApiRoutes } from '../../tickets/api-v1.js';
import { complianceApiRoutes } from '../../compliance/api-v1.js';
import { serviceApiRoutes } from '../../catalogue/api-v1.js';
import { dutyApiRoutes } from '../../duties/api-v1.js';
import { scorecardApiRoutes } from '../../scorecard/api-v1.js';
import { API_VERSION } from './config.js';
import * as S from './schemas.js';
import type { ApiPrincipal } from './auth.js';
import { processRoutes } from './routes-processes.js';
import { scheduleRoutes } from './routes-schedules.js';
import { semanticModelRoutes } from './routes-semantic.js';
import { platformRoutes } from './routes-platforms.js';
import { dashboardRoutes } from './routes-dashboards.js';
import { auditRoutes } from './routes-audit.js';
import { userRoutes } from './routes-users.js';

const principal = (req: FastifyRequest) => (req as unknown as { smApi: ApiPrincipal }).smApi;

// ---------- route definitions ----------

/** Error statuses an operation can declare (their OpenAPI responses: RESPONSES in ../index.ts). */
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429;

export interface Op {
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  query?: Parameters<typeof S.querySchema>[0];
  params?: Record<string, string>;
  /** Integer path parameters */
  intParams?: Record<string, string>;
  response: Record<string, unknown>;
  /** Paginated list (Link header, nextCursor) */
  paginated?: boolean;
  /** Extra documented error statuses */
  errors?: ErrorStatus[];
}

/** Operations that return pages (documented with a Link header). */
export const PAGINATED_OPERATIONS = new Set<string>();
/** Operations and their extra documented error statuses. */
export const OPERATION_ERRORS = new Map<string, number[]>();

export function schemaOf(op: Op) {
  if (op.paginated) PAGINATED_OPERATIONS.add(op.operationId);
  const errs = new Set<number>([401, 403, 429, ...(op.errors ?? [])]);
  if (op.query) errs.add(400);
  if (op.params || op.intParams) errs.add(404);
  OPERATION_ERRORS.set(op.operationId, [...errs].sort());
  const pathProps = {
    ...(op.params ? S.pathParams(op.params) : {}),
  } as { type?: string; required?: string[]; properties?: Record<string, unknown> };
  if (op.intParams) {
    pathProps.type = 'object';
    pathProps.required = [...(pathProps.required ?? []), ...Object.keys(op.intParams)];
    pathProps.properties = {
      ...(pathProps.properties ?? {}),
      ...Object.fromEntries(Object.entries(op.intParams).map(([n, d]) => [n, { type: 'integer', minimum: 1, description: d }])),
    };
  }
  return {
    tags: [op.tag],
    operationId: op.operationId,
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(op.query ? { querystring: S.querySchema(op.query) } : {}),
    ...(op.params || op.intParams ? { params: pathProps } : {}),
    response: { 200: { description: 'OK', ...op.response } },
  };
}

export async function v1Routes(app: FastifyInstance, opts: { spec: () => Record<string, unknown> }): Promise<void> {
  const get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R, smAuth: 'token' | 'none' | 'spec' = 'token') =>
    app.get(url, { schema: schemaOf(op), config: { smAuth } }, async (req, reply) => handler(req, reply));

  // ---------- meta ----------
  get(
    '/health',
    {
      operationId: 'getHealth',
      tag: 'Meta',
      summary: 'Health of the API',
      description: 'No token needed. Answers 503 with status "unavailable" while the vault is locked.',
      response: S.ref('Health'),
    },
    async (_req, reply) => {
      const ok = vault().unlocked;
      if (!ok) reply.code(503).header('retry-after', '60');
      return { status: ok ? 'ok' : 'unavailable', apiVersion: API_VERSION, time: new Date().toISOString() };
    },
    'none',
  );

  get('/me', { operationId: 'getMe', tag: 'Meta', summary: 'Owner and scope of the token', response: S.ref('Me') }, async (req) => {
    const p = principal(req);
    const caps = capabilities(currentUser());
    return {
      user: { id: p.user.id, username: p.user.username, displayName: p.user.displayName, roles: p.user.roles, teams: p.user.teams },
      token: { id: p.tokenId, name: p.tokenName, scope: p.scope, createdAt: p.createdAt, expiresAt: p.expiresAt, lastUsedAt: p.lastUsedAt },
      capabilities: { viewAudit: caps.viewAudit, manageUsers: caps.manageUsers },
      serverVersion: config.version,
      apiVersion: API_VERSION,
    };
  });

  const specResponse = { type: 'object', additionalProperties: true, description: 'OpenAPI 3.1 document' };
  get(
    '/openapi.json',
    {
      operationId: 'getOpenApiDocument',
      tag: 'Meta',
      summary: 'This OpenAPI document (JSON)',
      description: 'Available with a token, or without one when the documentation is enabled (signed-in users or public, see SM_API_DOCS).',
      response: specResponse,
    },
    async () => opts.spec(),
    'spec',
  );
  app.get('/openapi.yaml', { schema: { hide: true }, config: { smAuth: 'spec' } }, async (_req, reply) =>
    reply.type('application/yaml; charset=utf-8').send(YAML.stringify(opts.spec())),
  );

  processRoutes(get);
  scheduleRoutes(get);
  semanticModelRoutes(get);
  platformRoutes(get);
  dashboardRoutes(get);
  auditRoutes(get);
  userRoutes(get);

  // ---------- monitors ----------
  await monitorApiRoutes(app, get);

  // ---------- credentials register ----------
  credentialApiRoutes(get);
  // ---------- records ----------
  await recordApiRoutes(app, get);
  // ---------- service catalogue ----------
  serviceApiRoutes(get);
  dutyApiRoutes(get);
  scorecardApiRoutes(get);
  // ---------- ticket references ----------
  ticketApiRoutes(get);
  // ---------- compliance ----------
  complianceApiRoutes(get);
}
