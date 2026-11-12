import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as duties from './service.js';
import { params } from '../routes/params.js';
import { namedGrantRule } from '../auth/named-grants.js';

const listQuery = z.object({
  serviceId: z.string().max(200).optional(),
  applicationId: z.string().max(200).optional(),
  archived: z.enum(['0', '1']).optional(),
});

/**
 * Service duties: the web UI's API. Every route checks permissions in the service layer (duties.ts). Deciding an
 * exception is a four-eyes decision of a second person (like approving a record), not a step-up: it changes no rights
 * and no secrets, and both people and the reason are in the audit log.
 */
export async function dutyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/duties', async (req) => {
    const q = listQuery.parse(req.query);
    return duties.listDuties({ serviceId: q.serviceId, applicationId: q.applicationId, archived: q.archived === '1' });
  });
  // owners from outside the service's owning teams ask for the step-up like an access list (#195)
  app.post('/duties', { config: { stepUp: namedGrantRule((req) => duties.dutyNamesOutsiders(null, req.body)) } }, async (req) =>
    duties.createDuty(duties.dutyInput.parse(req.body)),
  );
  app.get('/duties/:id', async (req) => duties.getDuty(params(req).id!));
  app.put('/duties/:id', { config: { stepUp: namedGrantRule((req) => duties.dutyNamesOutsiders(params(req).id!, req.body)) } }, async (req) =>
    duties.updateDuty(params(req).id!, duties.dutyUpdate.parse(req.body)),
  );
  app.post('/duties/:id/archive', async (req) =>
    duties.setDutyArchived(params(req).id!, z.object({ archived: z.boolean() }).strict().parse(req.body).archived),
  );
  app.post('/duties/:id/skips', async (req) => duties.requestSkip(params(req).id!, duties.skipInput.parse(req.body)));
  app.post('/duties/:id/skips/:skipId/decision', async (req) => duties.decideSkip(params(req).id!, params(req).skipId!, duties.decisionInput.parse(req.body)));
  app.post('/duties/:id/skips/:skipId/withdraw', async (req) => duties.withdrawSkip(params(req).id!, params(req).skipId!));
}
