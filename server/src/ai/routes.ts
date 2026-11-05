import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aiBudgetInput, aiGatewaySettingsSchema } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { requirePlatform } from '../routes/helpers.js';
import { getSecrets } from '../platforms/service.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { discoverModels, setGatewaySettings } from './gateway.js';
import { listBudgets, raisesBudget, setBudget, usageEntries, usageOverview } from './usage.js';
import { initAiUsageDataset } from './dataset.js';

/**
 * AI models through LLM gateways (0.6.0, #216, docs/AI.md):
 * - a gateway's models and allowed data – changed with the platform's "manage" right, read with the platform;
 * - its usage: budgets, this period's use, top processes, the latest calls (whoever may use the platform; names of
 *   processes they may not view are left out);
 * - token budgets of the installation, a gateway or a process: administrators; raising one (or removing its limit)
 *   needs a step-up (control point ai.budget), lowering one does not;
 * - the usage log (administrators and auditors).
 * Not in the public API (/api/v1): the usage is in the built-in dataset "AI usage", which /api/v1 serves.
 */
const READERS = { roles: ['admin', 'auditor'] } as const;
const idParam = (req: FastifyRequest) => z.object({ id: z.string().min(1).max(64) }).parse(req.params).id;
const iso = z.string().datetime({ offset: true });

/** A budget change that raises a budget asks for a step-up; a body that does not parse goes on to the route (400). */
const raising = (req: FastifyRequest): boolean => {
  const b = aiBudgetInput.safeParse(req.body);
  return b.success && raisesBudget(b.data);
};

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  initAiUsageDataset();

  app.put('/platforms/:id/ai', async (req) => {
    const id = idParam(req);
    requirePlatform(id, 'manage', 'change the AI settings of this platform');
    return setGatewaySettings(id, aiGatewaySettingsSchema.parse(req.body));
  });

  app.post('/platforms/:id/ai/discover', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const id = idParam(req);
    const p = requirePlatform(id, 'manage', 'change the AI settings of this platform');
    return { models: await discoverModels(p, getSecrets(id)) };
  });

  app.get('/platforms/:id/ai/usage', async (req) => {
    const id = idParam(req);
    requirePlatform(id, 'use', 'use this platform');
    return usageOverview(id);
  });

  app.get('/ai/budgets', { config: { access: READERS } }, async () => ({ budgets: listBudgets() }));

  app.put('/ai/budgets', { config: { access: ACCESS.admin, stepUp: { action: 'changeAiBudget', who: 'manageSettings', when: raising } } }, async (req) => {
    const b = aiBudgetInput.parse(req.body);
    return setBudget({ scope: b.scope, scopeId: b.scopeId, tokensPerDay: b.tokensPerDay, tokensPerMonth: b.tokensPerMonth, comment: b.comment });
  });

  app.get('/ai/usage', { config: { access: READERS } }, async (req) => {
    const q = z
      .object({
        from: iso.optional(),
        to: iso.optional(),
        platformId: z.string().max(64).optional(),
        processId: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(10_000).default(500),
      })
      .strict()
      .parse(req.query ?? {});
    return { entries: usageEntries(q) };
  });
}
