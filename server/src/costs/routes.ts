import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { COST_SCOPES, costBudgetInput, FISCAL_YEAR_MAX, FISCAL_YEAR_MIN } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { costSettings, fiscalYearChange, setCostSettings } from './access.js';
import { overview, scopeDetail } from './query.js';
import { getSource, importFromUi, listImports, previewImport, setSource } from './service.js';
import { readNow } from './sources.js';
import { mayChangeBudget, raisesBudget, setBudget } from './budgets.js';
import { addEntry, addPlanLine, copyPlanYear, planCsv, planYear, removeEntry, removePlanLine, teamPlanYear, updateEntry, updatePlanLine } from './plans.js';
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
 *   GET  /api/costs/settings/fiscal-year-change?startMonth=           what a new fiscal year start would move (administrators)
 *   GET|PUT /api/costs/platform/:id/source                            how a platform's costs are read (PUT: its manage right)
 *   POST /api/costs/platform/:id/read                                 read a connector's costs now (its manage right)
 *   GET  /api/costs/platform/:id/imports, POST …/imports/preview | …/imports    FOCUS files
 *   GET|POST /api/costs/platform/:id/push-tokens, POST …/:tokenId/rotate, DELETE …/:tokenId   push tokens for CI
 *   POST /api/hooks/costs/:platformId                                 the push from CI (its push token only, push.ts)
 *
 * Service cost planning (0.16.0, ADR 0026, plans.ts) – who may change the service changes its plan, no step-up:
 *   GET  /api/costs/plans/:serviceId?fiscalYear=                      the year view of a fiscal year (default: the current one)
 *   GET  /api/costs/plans/:serviceId/export?fiscalYear=&what=plan|entries   the plan lines or the entries as CSV
 *   POST /api/costs/plans/:serviceId/lines, PUT|DELETE …/lines/:lineId    plan lines
 *   POST /api/costs/plans/:serviceId/copy                             copy a fiscal year's lines into the next one
 *   POST /api/costs/plans/:serviceId/entries, PUT|DELETE …/entries/:entryId   cost entries
 *   GET  /api/costs/team-plans/:teamId?fiscalYear=                    the plans of a team's services
 */

const scopeParams = (req: FastifyRequest) => z.object({ scope: z.enum(COST_SCOPES), id: z.string().min(1).max(100) }).parse(req.params);
const platformParam = (req: FastifyRequest) => z.object({ id: z.string().min(1).max(100) }).parse(req.params).id;
const tokenId = (req: FastifyRequest) => z.object({ tokenId: z.string().min(1).max(100) }).parse(req.params).tokenId;
/** A budget change that raises a budget asks for a step-up (control point cost.budget); a body that does not parse goes on to the route (400). */
const budgetBody = (req: FastifyRequest) => {
  const b = costBudgetInput.safeParse(req.body);
  return b.success ? b.data : null;
};
const serviceParam = (req: FastifyRequest) => z.object({ serviceId: z.string().min(1).max(100) }).parse(req.params).serviceId;
const itemParam = (req: FastifyRequest, key: 'lineId' | 'entryId') => z.object({ [key]: z.string().min(1).max(100) }).parse(req.params)[key]!;
/** One name for the fiscal year everywhere (query, bodies, responses, /api/v1, MCP): the calendar year it starts in. */
const yearQuery = z.object({ fiscalYear: z.coerce.number().int().min(FISCAL_YEAR_MIN).max(FISCAL_YEAR_MAX).optional() });
const imports = { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.costImport.bytes };

export async function costRoutes(app: FastifyInstance): Promise<void> {
  app.get('/costs', async (req) => {
    const q = z.object({ scope: z.enum(COST_SCOPES).default('service') }).parse(req.query ?? {});
    return overview(q.scope);
  });
  app.get('/costs/settings', async () => costSettings());
  app.put('/costs/settings', { config: { access: ACCESS.admin } }, async (req) => setCostSettings(req.body));
  app.get('/costs/settings/fiscal-year-change', { config: { access: ACCESS.admin } }, async (req) =>
    fiscalYearChange(z.object({ startMonth: z.coerce.number().int().min(1).max(12) }).parse(req.query ?? {}).startMonth),
  );
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

  // ---------- service cost planning (ADR 0026) ----------
  app.get('/costs/plans/:serviceId', async (req) => planYear(serviceParam(req), yearQuery.parse(req.query ?? {}).fiscalYear));
  app.get('/costs/plans/:serviceId/export', async (req, reply) => {
    const q = yearQuery.extend({ what: z.enum(['plan', 'entries']).default('plan') }).parse(req.query ?? {});
    const out = planCsv(serviceParam(req), q.fiscalYear, q.what);
    reply.header('content-disposition', `attachment; filename="${out.name}"`);
    reply.header('cache-control', 'no-store');
    return reply.type('text/csv; charset=utf-8').send(out.csv);
  });
  app.post('/costs/plans/:serviceId/lines', async (req) => addPlanLine(serviceParam(req), req.body));
  app.put('/costs/plans/:serviceId/lines/:lineId', async (req) => updatePlanLine(serviceParam(req), itemParam(req, 'lineId'), req.body));
  app.delete('/costs/plans/:serviceId/lines/:lineId', async (req) => removePlanLine(serviceParam(req), itemParam(req, 'lineId')));
  app.post('/costs/plans/:serviceId/copy', async (req) => copyPlanYear(serviceParam(req), req.body));
  app.post('/costs/plans/:serviceId/entries', async (req) => addEntry(serviceParam(req), req.body));
  app.put('/costs/plans/:serviceId/entries/:entryId', async (req) => updateEntry(serviceParam(req), itemParam(req, 'entryId'), req.body));
  app.delete('/costs/plans/:serviceId/entries/:entryId', async (req) => removeEntry(serviceParam(req), itemParam(req, 'entryId')));
  app.get('/costs/team-plans/:teamId', async (req) =>
    teamPlanYear(z.object({ teamId: z.string().min(1).max(100) }).parse(req.params).teamId, yearQuery.parse(req.query ?? {}).fiscalYear),
  );

  // ---------- sources and FOCUS imports ----------
  app.get('/costs/platform/:id/source', async (req) => getSource(platformParam(req)));
  app.put('/costs/platform/:id/source', async (req) => setSource(platformParam(req), req.body));
  app.post('/costs/platform/:id/read', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => readNow(platformParam(req)));
  app.get('/costs/platform/:id/imports', async (req) => listImports(platformParam(req)));
  app.post('/costs/platform/:id/imports/preview', imports, async (req) => previewImport(platformParam(req), req.body));
  app.post('/costs/platform/:id/imports', imports, async (req) => {
    const out = await importFromUi(platformParam(req), req.body);
    return { import: out.import, inserted: out.result.inserted, replaced: out.result.removed, corrections: out.result.corrections, warnings: out.warnings };
  });

  // ---------- push tokens for CI ----------
  app.get('/costs/platform/:id/push-tokens', async (req) => listPushTokens(platformParam(req)));
  // a push token outlives the API token that would create it: sessions only (revoking stays open to tokens)
  app.post('/costs/platform/:id/push-tokens', { config: { access: ACCESS.session } }, async (req) => createPushToken(platformParam(req), req.body));
  app.post('/costs/platform/:id/push-tokens/:tokenId/rotate', { config: { access: ACCESS.session } }, async (req) =>
    rotatePushToken(platformParam(req), tokenId(req)),
  );
  app.delete('/costs/platform/:id/push-tokens/:tokenId', async (req, reply) => {
    revokePushToken(platformParam(req), tokenId(req));
    return reply.code(204).send();
  });

  // ---------- the push from CI: machine to machine, its push token only ----------
  await app.register(async (hooks) => {
    // the body as bytes: its SHA-256 is that of the file as sent
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: LARGE_BODIES.costImport.bytes }, (_req, body, done) => done(null, body));
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
        bodyLimit: LARGE_BODIES.costImport.bytes,
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
          await importPush(token, { raw: Buffer.isBuffer(req.body) ? req.body : undefined, ip: req.ip, query: (req.query ?? {}) as Record<string, unknown> }),
        );
      },
    );
  });
}
