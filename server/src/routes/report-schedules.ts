import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../util.js';
import * as schedules from '../reports/schedules.js';
import { listScheduledReports } from '../reports/service.js';
import { reportSectionIds } from '../reports/sections.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { me } from '../auth/access.js';

/**
 * Scheduled summary reports (mounted under /api):
 *   GET    /report-schedules                 schedules the user may see {items, canCreate, sections}
 *   POST   /report-schedules                 create (the creator becomes the owner)
 *   GET    /report-schedules/reports         generated scheduled reports the user may see
 *   GET    /report-schedules/:id             schedule
 *   PUT    /report-schedules/:id             change (owner, administrators)
 *   DELETE /report-schedules/:id             delete (owner, administrators); reports stay archived
 *   POST   /report-schedules/:id/run         generate now (owner, administrators)
 *   GET    /report-schedules/:id/reports     the schedule's archive
 */

const params = (req: FastifyRequest) => req.params as Record<string, string>;

export async function reportScheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/report-schedules', async () => {
    me();
    return { items: schedules.listReportSchedules(), canCreate: schedules.canCreateReportSchedules(), sections: reportSectionIds() };
  });

  app.post('/report-schedules', async (req) => schedules.createReportSchedule(schedules.scheduleInputSchema.parse(req.body ?? {})));

  app.get('/report-schedules/reports', async (req) => {
    const u = me();
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query ?? {});
    return listScheduledReports(undefined, limit * 2)
      .filter((r) => schedules.canViewScheduledReport(r, u))
      .slice(0, limit);
  });

  app.get('/report-schedules/:id', async (req) => schedules.getReportSchedule(params(req).id!));

  app.put('/report-schedules/:id', async (req) => schedules.updateReportSchedule(params(req).id!, schedules.scheduleInputSchema.parse(req.body ?? {})));

  app.delete('/report-schedules/:id', async (req) => {
    schedules.deleteReportSchedule(params(req).id!);
    return { ok: true };
  });

  app.post('/report-schedules/:id/run', { config: { rateLimit: ROUTE_LIMITS.heavy } }, async (req) => {
    const u = me();
    const s = schedules.getReportSchedule(params(req).id!);
    if (!s.canEdit) throw new HttpError(403, 'Only the owner or an administrator can run this report schedule', 'FORBIDDEN', { context: 'ownerOnly' });
    const { texts: _t, ...rec } = await schedules.runReportSchedule(s.id, { actor: u.username });
    return rec;
  });

  app.get('/report-schedules/:id/reports', async (req) => {
    const u = me();
    const s = schedules.getReportSchedule(params(req).id!);
    return listScheduledReports(s.id).filter((r) => schedules.canViewScheduledReport(r, u));
  });
}
