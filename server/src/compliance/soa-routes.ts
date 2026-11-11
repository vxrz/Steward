import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SOA_EXPORT_FORMATS } from '@sm/shared';
import { ACCESS } from '../auth/access.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { contentDisposition } from '../records/attachments.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { params } from '../routes/params.js';
import * as soa from './soa.js';
import { getResponsibilities, setResponsibilities } from './responsibilities.js';

/**
 * The statement of applicability and the responsibility matrix in the web app (ADR 0029 part 2; Compliance module).
 * Reading also works with an API token; every change is a decision of a person in a session in the app (ADR 0029
 * decision 9), so the changing routes refuse API tokens. Approving or returning a version, and switching the second
 * person off (administrators), ask for a fresh confirmation (control point soa.approve). Rights on single rows are
 * checked in soa.ts.
 */

const session = { config: { access: ACCESS.session } };
const adminCaller = () => isAdmin(currentUser());
const versionNo = (req: FastifyRequest) => z.coerce.number().int().min(1).max(1_000_000).parse(params(req).n);

export async function soaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/compliance/soa', async () => soa.listSoas());
  app.post(
    '/compliance/soa',
    {
      config: {
        access: ACCESS.session,
        stepUp: { action: 'changeSoaApproval', who: adminCaller, when: (req) => (req.body as { fourEyes?: unknown } | null)?.fourEyes === false },
      },
    },
    async (req) => soa.createSoa(req.body as never),
  );
  app.get('/compliance/soa/:catalogueId', async (req) => soa.getSoa(params(req).catalogueId!));
  app.put(
    '/compliance/soa/:catalogueId/settings',
    // switching the second person off loosens soa.approve: confirmed like approving (administrators; others get the refusal)
    {
      config: {
        access: ACCESS.session,
        stepUp: { action: 'changeSoaApproval', who: adminCaller, when: (req) => soa.switchesFourEyesOff(params(req).catalogueId!, req.body) },
      },
    },
    async (req) => soa.updateSettings(params(req).catalogueId!, req.body as never),
  );
  app.put('/compliance/soa/:catalogueId/entries/:controlId', session, async (req) =>
    soa.updateEntry(params(req).catalogueId!, params(req).controlId!, req.body as never),
  );
  app.post('/compliance/soa/:catalogueId/versions', { config: { access: ACCESS.session, rateLimit: ROUTE_LIMITS.heavy } }, async (req) =>
    soa.submitVersion(params(req).catalogueId!),
  );
  app.get('/compliance/soa/:catalogueId/versions/:n', async (req) => soa.getVersion(params(req).catalogueId!, versionNo(req)));
  app.post(
    '/compliance/soa/:catalogueId/versions/:n/decision',
    {
      config: {
        access: ACCESS.session,
        rateLimit: ROUTE_LIMITS.heavy,
        // approvers and administrators confirm it is them first (soa.approve); anyone else gets the route's own refusal
        stepUp: { action: 'approveSoa', who: () => !!currentUser() && soa.canApproveSoa(currentUser()!) },
      },
    },
    async (req) => soa.decideVersion(params(req).catalogueId!, versionNo(req), req.body as never),
  );
  app.get('/compliance/soa/:catalogueId/versions/:n/export', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req, reply) => {
    const q = z.object({ format: z.enum(SOA_EXPORT_FORMATS).default('zip') }).parse(req.query);
    const f = await soa.exportVersion(params(req).catalogueId!, versionNo(req), q.format);
    reply.header('content-disposition', contentDisposition(f.filename));
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    return reply.type(f.contentType).send(f.body);
  });

  // the responsibility matrix of a service (whoever may edit the service changes it)
  app.get('/services/:id/responsibilities', async (req) => getResponsibilities(params(req).id!));
  app.put('/services/:id/responsibilities', session, async (req) => setResponsibilities(params(req).id!, req.body as never));
}
