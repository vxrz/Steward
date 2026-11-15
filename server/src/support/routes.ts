import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACCESS, me } from '../auth/access.js';
import { isAdmin } from '../auth/permissions.js';
import { params } from '../routes/params.js';
import * as levels from './levels.js';

/**
 * The support level catalogue (mounted under /api; 0.26.0, ADR 0039 part 5, docs/SUPPORT.md). Every signed-in reader
 * reads it – also a module-only user (a data products contributor picks a level); administrators change it. An item's
 * channels, level and guides change through the item's own routes (…/support), with its edit right.
 *   GET    /support/levels              the list in its order (administrators also see how many items use each)
 *   POST   /support/levels              add (administrators)
 *   PUT    /support/levels/order        order {ids} (administrators)
 *   PUT    /support/levels/:id          change (administrators)
 *   DELETE /support/levels/:id          remove (?replaceWith=<id>: its items move there; ?clear=1: they have none)
 */
export async function supportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/levels', { config: { access: { plantViewer: true } } }, async () => levels.listLevels(isAdmin(me())));
  app.post('/support/levels', { config: { access: ACCESS.admin } }, async (req) => levels.createLevel(req.body ?? {}));
  app.put('/support/levels/order', { config: { access: ACCESS.admin } }, async (req) => levels.orderLevels(req.body ?? {}));
  app.put('/support/levels/:id', { config: { access: ACCESS.admin } }, async (req) => levels.updateLevel(params(req).id!, req.body ?? {}));
  app.delete('/support/levels/:id', { config: { access: ACCESS.admin } }, async (req, reply) => {
    const q = z
      .object({ replaceWith: z.string().min(1).max(100).optional(), clear: z.enum(['0', '1']).optional() })
      .strict()
      .parse(req.query ?? {});
    levels.deleteLevel(params(req).id!, { replaceWith: q.replaceWith ?? null, clear: q.clear === '1' });
    return reply.code(204).send();
  });
}
