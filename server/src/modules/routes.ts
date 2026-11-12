import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isModuleId, type ModuleId } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { HttpError } from '../util.js';
import { modulesView, switchChanges, switchModule } from './registry.js';
import { moduleAccessBody, moduleAccessView, moduleAccessWidens, previewModuleAccess, setModuleAccess } from './access-change.js';
import { visibilitySummary } from './visibility.js';
import { plantDemo } from '../plant/routes.js';

/**
 * The module registry (0.11.0, ADR 0016), mounted under /api:
 *
 *   GET /api/settings/modules        every module, on or off, with its maturity (administrators)
 *   PUT /api/settings/modules/:id    { enabled } – switch one on or off (administrators, signed-in session, step-up)
 *   GET /api/settings/modules/:id/access           who uses it: everyone signed in, or selected teams and users (ADR 0034)
 *   PUT /api/settings/modules/:id/access           { mode, grants } – administrators, signed-in session; widening asks
 *                                                  for the step-up grantAccess (control point access.grant)
 *   POST /api/settings/modules/:id/access/preview  { mode, grants } – who would gain and who would lose it, nothing changed
 *   GET /api/me/visibility           the areas the signed-in person may see (the sidebar, honest empty states)
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

/** Widening who uses a module asks for the step-up (opening it, or naming a team or user not on its list). */
const widening = (req: FastifyRequest): boolean => {
  const id = (req.params as { id?: string }).id;
  const b = moduleAccessBody.safeParse(req.body);
  return isModuleId(id) && b.success && moduleAccessWidens(id, b.data);
};

export async function moduleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings/modules', { config: { access: ACCESS.admin } }, async () => modulesView());
  app.put('/settings/modules/:id', { config: { access: ACCESS.adminSession, stepUp: { action: 'changeModules', when: switching } } }, async (req) =>
    switchModule(moduleParam(req), switchBody.parse(req.body).enabled, plantDemo),
  );
  app.get('/settings/modules/:id/access', { config: { access: ACCESS.adminSession } }, async (req) => moduleAccessView(moduleParam(req)));
  app.put(
    '/settings/modules/:id/access',
    { config: { access: ACCESS.adminSession, stepUp: { action: 'grantAccess', who: 'manageUsers', when: widening } } },
    async (req) => setModuleAccess(moduleParam(req), moduleAccessBody.parse(req.body)),
  );
  app.post('/settings/modules/:id/access/preview', { config: { access: ACCESS.adminSession } }, async (req) =>
    previewModuleAccess(moduleParam(req), moduleAccessBody.parse(req.body)),
  );
  app.get('/me/visibility', async () => visibilitySummary());
}
