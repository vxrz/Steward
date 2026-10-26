import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import * as objectives from './objectives.js';
import { setObjectiveArchived } from './sampling.js';
import * as rules from './rules.js';
import * as scorecard from './scorecard.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

const listQuery = z.object({
  serviceId: z.string().max(200).optional(),
  applicationId: z.string().max(200).optional(),
  archived: z.enum(['0', '1']).optional(),
});
const trendQuery = z.object({
  days: z.coerce.number().int().min(1).max(730).default(90),
  owner: z.string().trim().max(130).optional(),
});

/**
 * Availability objectives and the service scorecard: the web UI's API. Permissions are checked in the service layer:
 * everyone who can sign in reads (like services), service editors define objectives, administrators keep the
 * expected-document rules. Nothing here changes rights or secrets, so no step-up.
 */
export async function scorecardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/objectives', async (req) => {
    const q = listQuery.parse(req.query);
    return objectives.listObjectives({ serviceId: q.serviceId, applicationId: q.applicationId, archived: q.archived === '1' });
  });
  app.post('/objectives', async (req) => objectives.createObjective(objectives.objectiveInput.parse(req.body)));
  app.get('/objectives/:id', async (req) => objectives.getObjective(params(req).id!));
  app.put('/objectives/:id', async (req) => objectives.updateObjective(params(req).id!, objectives.objectiveUpdate.parse(req.body)));
  // archived, never deleted: the history of an objective stays (scorecard.ts counts a recently archived one)
  app.post('/objectives/:id/archive', async (req) =>
    setObjectiveArchived(params(req).id!, z.object({ archived: z.boolean() }).strict().parse(req.body).archived),
  );

  app.get('/scorecard', async () => scorecard.scorecardOverview());
  app.get('/scorecard/trend', async (req) => {
    const q = trendQuery.parse(req.query);
    return scorecard.scorecardTrend({ days: q.days, owner: q.owner });
  });
  app.get('/scorecard/services/:id', async (req) => scorecard.serviceScorecard(params(req).id!));
  app.get('/scorecard/rules', async () => rules.listRules());
  app.post('/scorecard/rules', async (req) => rules.createRule(rules.ruleInput.parse(req.body)));
  app.put('/scorecard/rules/:id', async (req) => rules.updateRule(params(req).id!, rules.ruleInput.parse(req.body)));
  app.delete('/scorecard/rules/:id', async (req) => rules.deleteRule(params(req).id!));
}
