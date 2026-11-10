import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../auth/context.js';
import { requireCapability } from '../auth/permissions.js';
import { ACCESS } from '../auth/access.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { params } from '../routes/params.js';
import { confirmExportTarget, createExportJob, exportsStatus, getExportJob, listExportRuns, removeExportJob, startExportRun, updateExportJob } from './jobs.js';

/**
 * Scheduled exports to S3 (0.16.0, docs/EXPORTS.md, ADR 0027): administrators only (manageSettings). Defining,
 * changing and removing an export asks for a step-up (control point export.settings): it sends data out of Steward.
 * "Run now" does not – it runs what was confirmed, like _Back up now_: a run whose S3 target is not the confirmed one
 * fails (EXPORT_TARGET_CHANGED) until an administrator confirms it again (also with a step-up).
 */
export async function exportJobRoutes(app: FastifyInstance): Promise<void> {
  const admin = (what: string) => requireCapability(currentUser(), 'manageSettings', what);
  const stepUp = { action: 'changeExports', who: 'manageSettings' } as const;
  app.get('/exports', { config: { access: ACCESS.admin } }, async () => {
    admin('see the exports');
    return exportsStatus();
  });
  app.post('/exports', { config: { access: ACCESS.admin, stepUp } }, async (req, reply) => {
    admin('define an export');
    return reply.code(201).send(createExportJob(req.body));
  });
  app.get('/exports/:id', { config: { access: ACCESS.admin } }, async (req) => {
    admin('see the exports');
    return getExportJob(params(req).id!);
  });
  app.put('/exports/:id', { config: { access: ACCESS.admin, stepUp } }, async (req) => {
    admin('change an export');
    return updateExportJob(params(req).id!, req.body);
  });
  app.delete('/exports/:id', { config: { access: ACCESS.admin, stepUp } }, async (req, reply) => {
    admin('remove an export');
    removeExportJob(params(req).id!);
    return reply.code(204).send();
  });
  // the platform of the export changed (its manager may change it without the export's step-up): an administrator
  // checks it and confirms the target again
  app.post('/exports/:id/confirm-target', { config: { access: ACCESS.admin, stepUp } }, async (req) => {
    admin('confirm the target of an export');
    return confirmExportTarget(params(req).id!);
  });
  app.get('/exports/:id/runs', { config: { access: ACCESS.admin } }, async (req) => {
    admin('see the exports');
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    return listExportRuns(params(req).id!, q.limit);
  });
  app.post('/exports/:id/run', { config: { access: ACCESS.admin, rateLimit: ROUTE_LIMITS.heavy } }, async (req, reply) => {
    admin('start an export');
    return reply.code(202).send(startExportRun(params(req).id!, 'manual'));
  });
}
