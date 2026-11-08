import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isModuleId, type ModuleId } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { HttpError } from '../util.js';
import { modulesView, switchChanges, switchModule } from './registry.js';
import { plantDemo } from '../plant/routes.js';

/**
 * The module registry (0.11.0, ADR 0016), mounted under /api:
 *
 *   GET /api/settings/modules        every module, on or off, with its maturity (administrators)
 *   PUT /api/settings/modules/:id    { enabled } – switch one on or off (administrators, signed-in session, step-up)
 */

const switchBody = z.object({ enabled: z.boolean() }).strict();

const moduleParam = (req: FastifyRequest): ModuleId => {
  const id = (req.params as { id?: string }).id;
  if (!isModuleId(id)) throw new HttpError(404, `Module "${String(id).slice(0, 60)}" not found`, 'MODULE_NOT_FOUND', { module: String(id).slice(0, 60) });
  return id;
};

/** Only a request that really switches a module asks for a step-up (a repeated or invalid one gets its own answer). */
const switching = (req: FastifyRequest): boolean => {
  const id = (req.params as { id?: string }).id;
  const b = switchBody.safeParse(req.body);
  return isModuleId(id) && b.success && switchChanges(id, b.data.enabled);
};

export async function moduleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings/modules', { config: { access: ACCESS.admin } }, async () => modulesView());
  app.put('/settings/modules/:id', { config: { access: ACCESS.adminSession, stepUp: { action: 'changeModules', when: switching } } }, async (req) =>
    switchModule(moduleParam(req), switchBody.parse(req.body).enabled, plantDemo),
  );
}
