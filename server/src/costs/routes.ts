import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withServiceLinks } from '../auth/policy.js';
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
import { commitments, commitmentsCsv } from './commitments.js';
import { importEntries, listEntryImports, previewEntryImport, removeEntryImport } from './entry-import.js';
import { addSchedule, applyContractUpdates, confirmProposals, listSchedules, proposals, removeSchedule, updateSchedule } from './schedules.js';
import {
  addEntry,
  addEntryOf,
  addPlanLine,
  addPlanLineOf,
  bookLine,
  bookLineOf,
  copyPlanYear,
  copyPlanYearOf,
  planCsv,
  planYear,
  platformPlanCsv,
  platformPlanYear,
  removeEntry,
  removeEntryOf,
  removePlanLine,
  removePlanLineOf,
  teamPlanYear,
  updateEntry,
  updateEntryOf,
  updatePlanLine,
  updatePlanLineOf,
  type OwnerRef,
} from './plans.js';
import { costAttribution } from './attribution.js';
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
 *
 * Contract payments, commitments and recorded costs (0.18.0, ADR 0030) – new writes for people: a signed-in session
 * (ACCESS.session), like supplier writes; the entry and line routes above keep accepting API tokens:
 *   POST /api/costs/plans/:serviceId/lines/:lineId/book               Book: one entry from a line's payment in a month
 *   GET  /api/costs/schedules?contractId=|serviceId=                   payment schedules (the paying services the reader may see)
 *   POST /api/costs/schedules, PUT|DELETE /api/costs/schedules/:id     who may change the contract, or edit the paying service and see the contract
 *   GET  /api/costs/plans/:serviceId/proposals?fiscalYear=             "Contract payments to plan" of a fiscal year
 *   POST /api/costs/plans/:serviceId/proposals                         "Add to plan"
 *   POST /api/costs/plans/:serviceId/contract-updates                  "Update lines" (the current and later fiscal years)
 *   GET  /api/costs/commitments?teamId=&serviceId=&supplierId=&currency=&endingWithinDays=   what the schedules still owe
 *   GET  /api/costs/commitments/export?…                               the same as CSV
 *   POST /api/costs/plans/:serviceId/entries/import/preview            a CSV file of entries: every row with what it becomes (nothing stored)
 *   POST /api/costs/plans/:serviceId/entries/import                    import the rows without problems, all or nothing
 *   GET  /api/costs/plans/:serviceId/imports, DELETE …/imports/:importId   the import records; "Remove import"
 *
 * Cost attribution and platform cost plans (0.19.0, ADR 0032):
 *   GET  /api/costs/platform-plans/:platformId[/…]                     a platform's own cost plan – the same routes as a
 *                                                                     service's (lines, entries, copy, export, Book,
 *                                                                     proposals, contract updates, the CSV import);
 *                                                                     who manages the platform and its owning teams' members
 *   GET  /api/costs/schedules?platformId=, /api/costs/commitments?platformId=   what a platform pays
 *   GET  /api/costs/attribution/:kind/:id?fiscalYear=                 an application's or system's "Costs and contracts"
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
/** A platform's own cost plan (0.19.0) */
const platformPlan = (req: FastifyRequest): OwnerRef => ({
  kind: 'platform',
  id: z.object({ platformId: z.string().min(1).max(100) }).parse(req.params).platformId,
});
const scheduleParam = (req: FastifyRequest) => z.object({ costScheduleId: z.string().min(1).max(100) }).parse(req.params).costScheduleId;
const itemParam = (req: FastifyRequest, key: 'lineId' | 'entryId') => z.object({ [key]: z.string().min(1).max(100) }).parse(req.params)[key]!;
/** One name for the fiscal year everywhere (query, bodies, responses, /api/v1, MCP): the calendar year it starts in. */
const yearQuery = z.object({ fiscalYear: z.coerce.number().int().min(FISCAL_YEAR_MIN).max(FISCAL_YEAR_MAX).optional() });
const imports = { config: { rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.costImport.bytes };
/** New writes of ADR 0030 are decisions of people in the app: no API tokens. */
const session = { config: { access: ACCESS.session } };

export async function costRoutes(app: FastifyInstance): Promise<void> {
  app.get('/costs', async (req) => {
    const q = z.object({ scope: z.enum(COST_SCOPES).default('service') }).parse(req.query ?? {});
    return withServiceLinks(() => overview(q.scope));
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
  app.post('/costs/plans/:serviceId/lines/:lineId/book', session, async (req) => bookLine(serviceParam(req), itemParam(req, 'lineId'), req.body));
  app.post('/costs/plans/:serviceId/entries', async (req) => addEntry(serviceParam(req), req.body));
  app.put('/costs/plans/:serviceId/entries/:entryId', async (req) => updateEntry(serviceParam(req), itemParam(req, 'entryId'), req.body));
  app.delete('/costs/plans/:serviceId/entries/:entryId', async (req) => removeEntry(serviceParam(req), itemParam(req, 'entryId')));
  // contract payments (ADR 0030)
  app.get('/costs/schedules', async (req) =>
    listSchedules(
      z
        .object({
          contractId: z.string().min(1).max(100).optional(),
          serviceId: z.string().min(1).max(100).optional(),
          platformId: z.string().min(1).max(100).optional(),
        })
        .parse(req.query ?? {}),
    ),
  );
  app.post('/costs/schedules', session, async (req) => addSchedule(req.body));
  app.put('/costs/schedules/:costScheduleId', session, async (req) => updateSchedule(scheduleParam(req), req.body));
  app.delete('/costs/schedules/:costScheduleId', session, async (req) => removeSchedule(scheduleParam(req)));
  app.get('/costs/plans/:serviceId/proposals', async (req) => proposals(serviceParam(req), yearQuery.parse(req.query ?? {}).fiscalYear));
  app.post('/costs/plans/:serviceId/proposals', session, async (req) => confirmProposals(serviceParam(req), req.body));
  app.post('/costs/plans/:serviceId/contract-updates', session, async (req) => applyContractUpdates(serviceParam(req), req.body));
  const entryImport = { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.heavy }, bodyLimit: LARGE_BODIES.costEntryImport.bytes };
  app.post('/costs/plans/:serviceId/entries/import/preview', entryImport, async (req) => previewEntryImport(serviceParam(req), req.body));
  app.post('/costs/plans/:serviceId/entries/import', entryImport, async (req) => importEntries(serviceParam(req), req.body));
  app.get('/costs/plans/:serviceId/imports', async (req) => listEntryImports(serviceParam(req)));
  app.delete('/costs/plans/:serviceId/imports/:importId', session, async (req) =>
    removeEntryImport(serviceParam(req), z.object({ importId: z.string().min(1).max(100) }).parse(req.params).importId),
  );
  app.get('/costs/commitments', async (req) => commitments(req.query ?? {}));
  app.get('/costs/commitments/export', async (req, reply) => {
    const out = commitmentsCsv(req.query ?? {});
    reply.header('content-disposition', `attachment; filename="${out.name}"`);
    reply.header('cache-control', 'no-store');
    return reply.type('text/csv; charset=utf-8').send(out.csv);
  });
  // ---------- a platform's own cost plan (0.19.0, ADR 0032): the routes of a service's plan ----------
  app.get('/costs/platform-plans/:platformId', async (req) => platformPlanYear(platformPlan(req).id, yearQuery.parse(req.query ?? {}).fiscalYear));
  app.get('/costs/platform-plans/:platformId/export', async (req, reply) => {
    const q = yearQuery.extend({ what: z.enum(['plan', 'entries']).default('plan') }).parse(req.query ?? {});
    const out = platformPlanCsv(platformPlan(req).id, q.fiscalYear, q.what);
    reply.header('content-disposition', `attachment; filename="${out.name}"`);
    reply.header('cache-control', 'no-store');
    return reply.type('text/csv; charset=utf-8').send(out.csv);
  });
  app.post('/costs/platform-plans/:platformId/lines', async (req) => addPlanLineOf(platformPlan(req), req.body));
  app.put('/costs/platform-plans/:platformId/lines/:lineId', async (req) => updatePlanLineOf(platformPlan(req), itemParam(req, 'lineId'), req.body));
  app.delete('/costs/platform-plans/:platformId/lines/:lineId', async (req) => removePlanLineOf(platformPlan(req), itemParam(req, 'lineId')));
  app.post('/costs/platform-plans/:platformId/copy', async (req) => copyPlanYearOf(platformPlan(req), req.body));
  app.post('/costs/platform-plans/:platformId/lines/:lineId/book', session, async (req) => bookLineOf(platformPlan(req), itemParam(req, 'lineId'), req.body));
  app.post('/costs/platform-plans/:platformId/entries', async (req) => addEntryOf(platformPlan(req), req.body));
  app.put('/costs/platform-plans/:platformId/entries/:entryId', async (req) => updateEntryOf(platformPlan(req), itemParam(req, 'entryId'), req.body));
  app.delete('/costs/platform-plans/:platformId/entries/:entryId', async (req) => removeEntryOf(platformPlan(req), itemParam(req, 'entryId')));
  app.get('/costs/platform-plans/:platformId/proposals', async (req) => proposals(platformPlan(req), yearQuery.parse(req.query ?? {}).fiscalYear));
  app.post('/costs/platform-plans/:platformId/proposals', session, async (req) => confirmProposals(platformPlan(req), req.body));
  app.post('/costs/platform-plans/:platformId/contract-updates', session, async (req) => applyContractUpdates(platformPlan(req), req.body));
  app.post('/costs/platform-plans/:platformId/entries/import/preview', entryImport, async (req) => previewEntryImport(platformPlan(req), req.body));
  app.post('/costs/platform-plans/:platformId/entries/import', entryImport, async (req) => importEntries(platformPlan(req), req.body));
  app.get('/costs/platform-plans/:platformId/imports', async (req) => listEntryImports(platformPlan(req)));
  app.delete('/costs/platform-plans/:platformId/imports/:importId', session, async (req) =>
    removeEntryImport(platformPlan(req), z.object({ importId: z.string().min(1).max(100) }).parse(req.params).importId),
  );
  // an application's or system's "Costs and contracts" (0.19.0, ADR 0032): read-only, what the reader may see
  app.get('/costs/attribution/:kind/:id', async (req) => {
    const p = z.object({ kind: z.enum(['application', 'system']), id: z.string().min(1).max(100) }).parse(req.params);
    return costAttribution(p.kind, p.id, yearQuery.parse(req.query ?? {}).fiscalYear);
  });
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
