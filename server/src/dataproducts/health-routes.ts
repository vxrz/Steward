import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dataHealthQuery, DATA_PRODUCT_LIMITS, type ProductHealth } from '@sm/shared';
import { me } from '../auth/access.js';
import { productAccess } from './access.js';
import { elementChecks, linkCheck, unlinkCheck } from './check-links.js';
import { healthOf, productHealthByEnvironment } from './health.js';
import { applyMonitor, monitorProposal } from './monitor-draft.js';
import { visibleProduct } from './service.js';
import { productsByIds } from './store.js';

/**
 * Checks and health of the data products module in the internal API (ADR 0036 part 10, WP3). Rights are checked in
 * the services; the module's switch in app.ts (404 MODULE_OFF while it is off).
 *
 *   GET      /api/data-products/health?ids=&environment=      health of a page of products (those the caller may see)
 *   GET      /api/data-products/:id/health                     health per environment (production first)
 *   GET|POST /api/data-products/:id/monitor                    Create / Update monitor: the proposal, and applying it
 *   GET|POST /api/data-elements/:id/checks, DELETE …/:linkId   checks linked to an element (and found ones)
 */

const param = (req: FastifyRequest, name: string): string =>
  z
    .string()
    .min(1)
    .max(200)
    .parse((req.params as Record<string, unknown>)[name]);

export async function dataProductHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/data-products/health', async (req): Promise<ProductHealth[]> => {
    const u = me();
    const q = dataHealthQuery.parse(req.query);
    // products the caller may not see are left out – not named, not counted
    const rows = productsByIds(q.ids.slice(0, DATA_PRODUCT_LIMITS.page));
    // in the order asked for
    const ids = q.ids.filter((id) => {
      const p = rows.get(id);
      return !!p && productAccess(u, p).permissions.includes('view');
    });
    const health = healthOf(u, ids, q.environment ?? null);
    return ids.map((id) => health.get(id)!);
  });
  app.get('/data-products/:id/health', async (req) => {
    const { row } = visibleProduct(param(req, 'id'));
    return productHealthByEnvironment(me(), row.id);
  });
  app.get('/data-products/:id/monitor', async (req) => monitorProposal(param(req, 'id'), req.query));
  app.post('/data-products/:id/monitor', async (req) => applyMonitor(param(req, 'id'), req.body));

  app.get('/data-elements/:id/checks', async (req) => elementChecks(param(req, 'id')));
  app.post('/data-elements/:id/checks', async (req) => linkCheck(param(req, 'id'), req.body));
  app.delete('/data-elements/:id/checks/:linkId', async (req, reply) => {
    unlinkCheck(param(req, 'id'), param(req, 'linkId'));
    return reply.code(204).send();
  });
}
