import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { COST_SCOPES, costBudgetInput } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { COST_PUSH_BODY_LIMIT, LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { costSettings, setCostSettings } from './access.js';
import { overview, scopeDetail } from './query.js';
import { getSource, importFromUi, listImports, previewImport, setSource } from './service.js';
import { readNow } from './sources.js';
import { mayChangeBudget, raisesBudget, setBudget } from './budgets.js';
import {
  authorizePush,
  createPushToken,
  importPush,
  listPushTokens,
  REFUSED,
  revokePushToken,
  rotatePushToken,
  type PushResponse,
  type VerifiedPushToken,
} from './push.js';

/**
 * Platform costs (0.9.0, #226, docs/COSTS.md) in the internal API. Rights are checked in the services: a scope the
 * caller may not see answers 404; amounts are left out where the caller may not see them.
 *
 *   GET  /api/costs?scope=service|application|team|platform          the overview of a kind
 *   GET  /api/costs/:scope/:id                                        one scope: 12 months, this month, trend, forecast, budget
 *   PUT  /api/costs/budgets                                           a month's budget (raising one: step-up, control point cost.budget)
 *   GET|PUT /api/costs/settings                                       hide amounts from viewers, default currency (PUT: administrators)
 *   GET|PUT /api/costs/platform/:id/source                            how a platform's costs are read (PUT: its manage right)
 *   POST /api/costs/platform/:id/read                                 read a connector's costs now (its manage right)
 *   GET  /api/costs/platform/:id/imports, POST …/imports/preview | …/imports    FOCUS files
 *   GET|POST /api/costs/platform/:id/push-tokens, POST …/:tokenId/rotate, DELETE …/:tokenId   push tokens for CI
 *   POST /api/hooks/costs/:platformId                                 the push from CI (its push token only, push.ts)
 */

const scopeParams = (req: FastifyRequest) => z.object({ scope: z.enum(COST_SCOPES), id: z.string().min(1).max(100) }).parse(req.params);
const platformParam = (req: FastifyRequest) => z.object({ id: z.string().min(1).max(100) }).parse(req.params).id;
const tokenId = (req: FastifyRequest) => z.object({ tokenId: z.string().min(1).max(100) }).parse(req.params).tokenId;
/** A budget change that raises a budget asks for a step-up (control point cost.budget); a body that does not parse goes on to the route (400). */
const budgetBody = (req: FastifyRequest) => {
  const b = costBudgetInput.safeParse(req.body);
  return b.success ? b.data : null;
};
const imports = { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.costImport.bytes };

export async function costRoutes(app: FastifyInstance): Promise<void> {
  app.get('/costs', async (req) => {
    const q = z.object({ scope: z.enum(COST_SCOPES).default('service') }).parse(req.query ?? {});
    return overview(q.scope);
  });
  app.get('/costs/settings', async () => costSettings());
  app.put('/costs/settings', { config: { access: ACCESS.admin } }, async (req) => setCostSettings(req.body));
  app.put(
    '/costs/budgets',
    {
      config: {
        stepUp: {
          action: 'changeCostBudget',
          who: (req: FastifyRequest) => {
            const b = budgetBody(req);
            return !!b && mayChangeBudget(b.scope, b.scopeId);
          },
          when: (req: FastifyRequest) => {
            const b = budgetBody(req);
            return !!b && raisesBudget(b);
          },
        },
      },
    },
    async (req) => ({ budget: setBudget(req.body) }),
  );
  app.get('/costs/:scope/:id', async (req) => {
    const p = scopeParams(req);
    return scopeDetail(p.scope, p.id);
  });

  // ---------- sources and FOCUS imports ----------
  app.get('/costs/platform/:id/source', async (req) => getSource(platformParam(req)));
  app.put('/costs/platform/:id/source', async (req) => setSource(platformParam(req), req.body));
  app.post('/costs/platform/:id/read', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => readNow(platformParam(req)));
  app.get('/costs/platform/:id/imports', async (req) => listImports(platformParam(req)));
  app.post('/costs/platform/:id/imports/preview', imports, async (req) => previewImport(platformParam(req), req.body));
  app.post('/costs/platform/:id/imports', imports, async (req) => {
    const out = importFromUi(platformParam(req), req.body);
    return { import: out.import, inserted: out.result.inserted, replaced: out.result.removed, corrections: out.result.corrections, warnings: out.warnings };
  });

  // ---------- push tokens for CI ----------
  app.get('/costs/platform/:id/push-tokens', async (req) => listPushTokens(platformParam(req)));
  app.post('/costs/platform/:id/push-tokens', async (req) => createPushToken(platformParam(req), req.body));
  app.post('/costs/platform/:id/push-tokens/:tokenId/rotate', async (req) => rotatePushToken(platformParam(req), tokenId(req)));
  app.delete('/costs/platform/:id/push-tokens/:tokenId', async (req, reply) => {
    revokePushToken(platformParam(req), tokenId(req));
    return reply.code(204).send();
  });

  // ---------- the push from CI: machine to machine, its push token only ----------
  await app.register(async (hooks) => {
    // the body as bytes: its SHA-256 is that of the file as sent
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: COST_PUSH_BODY_LIMIT }, (_req, body, done) => done(null, body));
    const verified = new WeakMap<FastifyRequest, VerifiedPushToken>();
    const answer = (reply: FastifyReply, res: PushResponse) => {
      reply.header('cache-control', 'no-store');
      if (res.headers) reply.headers(res.headers);
      return reply.code(res.status).send(res.body);
    };
    hooks.post(
      '/hooks/costs/:platformId',
      {
        config: { rateLimit: ROUTE_LIMITS.webhook },
        bodyLimit: COST_PUSH_BODY_LIMIT,
        // the token is checked from the headers before the body is read
        onRequest: async (req, reply) => {
          const platformId = String((req.params as { platformId?: string }).platformId ?? '');
          const a = authorizePush({ platformId, contentType: req.headers['content-type'], headers: req.headers, ip: req.ip });
          if (!a.ok) return answer(reply, a.res);
          verified.set(req, a.token);
        },
      },
      async (req, reply) => {
        const token = verified.get(req);
        if (!token) return answer(reply, REFUSED);
        return answer(
          reply,
          importPush(token, { raw: Buffer.isBuffer(req.body) ? req.body : undefined, ip: req.ip, query: (req.query ?? {}) as Record<string, unknown> }),
        );
      },
    );
  });
}
