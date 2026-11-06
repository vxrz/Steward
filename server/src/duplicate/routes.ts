import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DUPLICATE_KINDS, type DuplicateKind } from '@sm/shared';
import { ROUTE_LIMITS } from '../rateLimits.js';
import type { RouteAccess } from '../auth/access.js';
import { copiedFrom, duplicate, suggestion } from './common.js';
import { DUPLICATORS } from './kinds.js';

/**
 * Duplicating (0.4.0): POST /api/<kind>/:id/duplicate for each kind, the dialog's suggestion and where a copy came
 * from. Signed-in people (session or API token), no status viewers; the rights on the original and to create the kind
 * are checked per object (duplicate/common.ts).
 */
const SIGNED_IN: RouteAccess = { auth: 'user' };

/** The route of each kind, with the name of its id parameter (as the kind's other routes have it). */
const ROUTES: Record<DuplicateKind, { path: string; param: string }> = {
  monitor: { path: '/monitors/:id/duplicate', param: 'id' },
  process: { path: '/processes/:id/duplicate', param: 'id' },
  dashboard: { path: '/dashboards/:id/duplicate', param: 'id' },
  credential: { path: '/credentials/:id/duplicate', param: 'id' },
  application: { path: '/applications/:id/duplicate', param: 'id' },
  service: { path: '/services/:id/duplicate', param: 'id' },
  schedule: { path: '/schedules/:id/duplicate', param: 'id' },
  'report-schedule': { path: '/report-schedules/:id/duplicate', param: 'id' },
  'maintenance-window': { path: '/maintenance-windows/:id/duplicate', param: 'id' },
  'access-check': { path: '/compliance/access-checks/:accessCheckId/duplicate', param: 'accessCheckId' },
  'status-page': { path: '/status-pages/:pageId/duplicate', param: 'pageId' },
  system: { path: '/systems/:id/duplicate', param: 'id' },
  asset: { path: '/plant/assets/:assetId/duplicate', param: 'assetId' },
  'device-profile': { path: '/plant/profiles/:profileId/duplicate', param: 'profileId' },
  'kpi-definition': { path: '/plant/kpis/:kpiId/duplicate', param: 'kpiId' },
};

const param = (req: FastifyRequest, name: string) => String((req.params as Record<string, string>)[name] ?? '');
const body = (req: FastifyRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});

/**
 * Copying the access settings shares the copy with everyone on the original's access list and in its owning teams –
 * like granting access, it needs a recent confirmation of who is asking (step-up).
 */
const ACCESS_COPY = { action: 'grantAccess' as const, when: (req: FastifyRequest) => body(req).copyAccess === true };

const kindParam = z.object({ kind: z.enum(DUPLICATE_KINDS), id: z.string().min(1).max(200) });
const suggestionQuery = z.object({ lang: z.string().max(10).optional() });

export async function duplicateRoutes(app: FastifyInstance): Promise<void> {
  for (const kind of DUPLICATE_KINDS) {
    const { path, param: p } = ROUTES[kind];
    app.post(
      path,
      {
        config: {
          access: SIGNED_IN,
          rateLimit: ROUTE_LIMITS.action,
          ...(DUPLICATORS[kind].accessApplies ? { stepUp: ACCESS_COPY } : {}),
        },
      },
      async (req) => duplicate(DUPLICATORS[kind], param(req, p), req.body),
    );
  }
  // what the dialog suggests: a free name and key, whether access settings may be copied, the options
  app.get('/duplicates/:kind/:id', { config: { access: SIGNED_IN } }, async (req) => {
    const { kind, id } = kindParam.parse(req.params);
    return suggestion(DUPLICATORS[kind], id, suggestionQuery.parse(req.query ?? {}).lang);
  });
  // where a copy came from (null: it is not a copy)
  app.get('/duplicates/:kind/:id/source', { config: { access: SIGNED_IN } }, async (req) => {
    const { kind, id } = kindParam.parse(req.params);
    return { copiedFrom: copiedFrom(DUPLICATORS[kind], id) };
  });
}
