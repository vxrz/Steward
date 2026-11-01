import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { validateProcess, type StartRunRequest, type TaskDecision, MANUAL_LIMITS, boundedRecord, notifyPauseSchema, notifyPolicySchema } from '@sm/shared';
import { allAuditAscending } from '../audit.js';
import { HttpError, MAX_DEFINITION_TEXT, rasterImageType } from '../util.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import { startRun, cancelRun, resumeRun, completeTask, completeManualTask, verifyManualTask } from '../engine/runner.js';
import { addEvidence, evidenceForDownload, manualCompletionSchema, removeEvidence, verificationSchema } from '../engine/manual.js';
import * as scheduler from '../scheduler.js';
import { runReportHtml } from '../reports.js';
import { uploadedFile } from '../records/routes.js';
import { contentDisposition, downloadType } from '../records/attachments.js';
import { currentActor } from '../auth/context.js';
import * as users from '../auth/users.js';
import { processAccess } from '../auth/step-up-rules.js';
import { require, requireCapability } from '../auth/permissions.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { me } from '../auth/access.js';
import { requireRun, requirePlatform, withDecisionRights, visibleTasks, visibleRuns } from './helpers.js';

/** Query strings are validated like bodies: one value per parameter, bounded, numbers as numbers. */
const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const runsQuery = z.object({
  processId: z.string().max(200).optional(),
  status: z.string().max(200).optional(),
  scheduleId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  before: z.string().max(64).optional(),
  /** Runs started after this time (ISO), e.g. the start page's "Failed runs (24 h)" */
  since: z
    .string()
    .max(64)
    .refine((x) => !Number.isNaN(Date.parse(x)), 'an ISO timestamp')
    .transform((x) => new Date(x).toISOString())
    .optional(),
  /** `failed`: only runs with a failed check (the start page's "Failed checks" links) */
  checks: z.enum(['failed']).optional(),
});

function requireProcess(processId: string, perm: 'view' | 'run' | 'edit' | 'approve' | 'manage', what: string) {
  const perms = processes.permissionsFor(processId);
  if (!perms.includes('view')) throw new HttpError(404, `Process ${processId} not found`);
  require(perms, perm, what);
  return perms;
}

function requireBindingsUsable(bindings: Record<string, string> | undefined) {
  for (const pid of Object.values(bindings ?? {})) requirePlatform(pid, 'use', `use platform ${pid}`);
}

const params = (req: FastifyRequest) => req.params as Record<string, string>;

/** Processes, runs, tasks and schedules (mounted under /api). */
export async function processRoutes(app: FastifyInstance): Promise<void> {
  // ---------- processes ----------
  app.get('/templates', async () => processes.listTemplates());
  app.get('/processes', async () => processes.listProcesses());
  app.post('/processes', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    requireCapability(me(), 'createProcesses', 'create processes');
    const b = z
      .object({
        definition: z.any().optional(),
        templateId: z.string().max(200).optional(),
        text: z.string().max(MAX_DEFINITION_TEXT).optional(),
        comment: z.string().max(2000).optional(),
      })
      .parse(req.body);
    if (b.templateId) return processes.createFromTemplate(b.templateId);
    const def = b.text ? processes.parseDefinitionText(b.text) : b.definition;
    return processes.createProcess(def, { comment: b.comment ?? (b.text ? 'Imported' : 'Created') });
  });
  app.post('/processes/validate', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    const b = z.object({ definition: z.any().optional(), text: z.string().max(MAX_DEFINITION_TEXT).optional() }).parse(req.body);
    try {
      const def = b.text !== undefined ? processes.parseDefinitionText(b.text) : b.definition;
      const r = validateProcess(def);
      return { ok: r.ok, issues: r.issues, warnings: r.warnings, definition: r.definition };
    } catch (e) {
      return { ok: false, issues: [{ path: '', message: (e as Error).message }], warnings: [] };
    }
  });
  app.post('/processes/to-yaml', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    const b = z.object({ definition: z.any() }).parse(req.body);
    return { text: processes.toYaml(b.definition) };
  });
  app.get('/processes/:id', async (req) => {
    requireProcess(params(req).id!, 'view', 'view this process');
    const q = versionQuery.parse(req.query ?? {});
    return processes.getProcess(params(req).id!, q.version);
  });
  app.put('/processes/:id', { bodyLimit: LARGE_BODIES.definitions.bytes }, async (req) => {
    requireProcess(params(req).id!, 'edit', 'edit this process');
    const b = z.object({ definition: z.any(), comment: z.string().max(2000).optional() }).parse(req.body);
    return processes.saveProcess(params(req).id!, b.definition, b.comment ?? '');
  });
  app.put('/processes/:id/access', { config: { stepUp: { action: 'grantAccess', ...processAccess } } }, async (req) => {
    requireProcess(params(req).id!, 'manage', 'change access to this process');
    const b = z.object({ acl: z.array(z.any()).max(500), owner: z.string().max(64).nullable().optional() }).parse(req.body);
    if (b.owner && !users.findUserByName(b.owner)) throw new HttpError(400, `Unknown user "${b.owner}"`);
    return processes.setProcessAccess(params(req).id!, b);
  });
  app.delete('/processes/:id', async (req) => {
    requireProcess(params(req).id!, 'manage', 'archive this process');
    processes.archiveProcess(params(req).id!);
    return { ok: true };
  });
  app.get('/processes/:id/versions', async (req) => {
    requireProcess(params(req).id!, 'view', 'view this process');
    return processes.listVersions(params(req).id!);
  });
  app.get('/processes/:id/export', async (req, reply) => {
    requireProcess(params(req).id!, 'view', 'view this process');
    const q = versionQuery.parse(req.query ?? {});
    const p = processes.getProcess(params(req).id!, q.version);
    reply.header('content-disposition', `attachment; filename="${p.id}.yaml"`);
    return reply.type('text/yaml').send(processes.toYaml(p.definition));
  });

  // ---------- runs ----------
  app.post('/runs', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const b = z
      .object({
        processId: z.string().max(200),
        version: z.number().int().optional(),
        inputs: boundedRecord(z.unknown(), 200).optional(),
        bindings: boundedRecord(z.string(), 100).optional(),
        dryRun: z.boolean().optional(),
        recorded: z.boolean().optional(),
      })
      .parse(req.body) as StartRunRequest;
    requireProcess(b.processId, 'run', 'run this process');
    requireBindingsUsable(b.bindings);
    return { id: await startRun(b) };
  });
  app.get('/runs', async (req) => visibleRuns(runsQuery.parse(req.query ?? {})));
  app.get('/runs/:id', async (req) => {
    requireRun(params(req).id!, 'view', 'view this run');
    const d = store.getRunDetail(params(req).id!);
    return { ...d, tasks: withDecisionRights(d.tasks) };
  });
  app.get('/runs/:id/steps/:stepId', async (req) => {
    requireRun(params(req).id!, 'view', 'view this run');
    return store.getStepFull(params(req).id!, Number(params(req).stepId));
  });
  app.post('/runs/:id/cancel', async (req) => {
    requireRun(params(req).id!, 'run', 'cancel this run');
    await cancelRun(params(req).id!);
    return { ok: true };
  });
  app.post('/runs/:id/resume', async (req) => {
    requireRun(params(req).id!, 'run', 'resume this run');
    await resumeRun(params(req).id!);
    return { ok: true };
  });
  app.get('/runs/:id/report.html', async (req, reply) => {
    const id = params(req).id!;
    requireRun(id, 'view', 'view this run');
    if ((req.query as { download?: string }).download) reply.header('content-disposition', `attachment; filename="protocol-${id}.html"`);
    return reply.type('text/html').send(runReportHtml(id));
  });
  // PDF reports (GET /runs/:id/report.pdf, POST /runs/:id/reports, …): routes/reports.ts
  app.get('/runs/:id/report.json', async (req, reply) => {
    const id = params(req).id!;
    requireRun(id, 'view', 'view this run');
    const detail = store.getRunDetail(id);
    const steps = detail.steps.map((s) => store.getStepFull(id, s.id));
    reply.header('content-disposition', `attachment; filename="protocol-${id}.json"`);
    return { ...detail, steps, audit: allAuditAscending(id), protocolHash: store.protocolHash(id) };
  });
  app.get('/artifacts/:id', async (req, reply) => {
    const a = store.artifactFile(params(req).id!);
    requireRun(a.runId, 'view', 'view this run');
    const data = fs.readFileSync(a.path);
    // the type comes from the content (screenshots are images): anything else is a download that cannot run as page or script
    const image = rasterImageType(data);
    reply.header('content-disposition', `${image ? 'inline' : 'attachment'}; filename="${a.name.replace(/[^\w.-]/g, '_')}"`);
    reply.header('content-security-policy', "sandbox; default-src 'none'");
    reply.header('x-content-type-options', 'nosniff');
    return reply.type(image ?? 'application/octet-stream').send(data);
  });

  // ---------- tasks ----------
  app.get('/tasks', async (req) => {
    const q = z.object({ status: z.string().max(100).optional(), mine: z.string().max(10).optional() }).parse(req.query ?? {});
    const list = visibleTasks(q.status);
    return q.mine ? list.filter((t) => t.canDecide) : list;
  });
  app.get('/tasks/:id', async (req) => {
    const t = visibleTasks().find((x) => x.id === params(req).id);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    return t;
  });
  app.post('/tasks/:id/complete', async (req) => {
    const id = params(req).id!;
    const t = visibleTasks().find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    if (t.manual?.stage === 'verify') throw new HttpError(409, 'This step was completed and waits for its verification', 'TASK_WAITS_FOR_VERIFICATION');
    if (!t.canDecide) throw new HttpError(403, t.cannotDecideReason ?? 'You may not decide this task', t.cannotDecideCode ?? 'FORBIDDEN', t.cannotDecideParams);
    if (t.mode === 'manual') return { ok: true, ...(await completeManualTask(id, manualCompletionSchema.parse(req.body ?? {}))) };
    const b = z
      .object({ approved: z.boolean(), selectedKeys: z.array(z.string().max(500)).max(10000).default([]), comment: z.string().max(5000).optional() })
      .parse(req.body) as TaskDecision;
    await completeTask(id, b);
    return { ok: true };
  });
  // manual steps: the second person verifies (or sends back / rejects) what the first one entered
  app.post('/tasks/:id/verify', async (req) => {
    const id = params(req).id!;
    const t = visibleTasks().find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    if (t.mode !== 'manual' || t.manual?.stage !== 'verify') throw new HttpError(409, 'This step does not wait for a verification', 'TASK_NOT_IN_VERIFICATION');
    if (!t.canDecide) throw new HttpError(403, t.cannotDecideReason ?? 'You may not verify this step', t.cannotDecideCode ?? 'FORBIDDEN', t.cannotDecideParams);
    return { ok: true, ...(await verifyManualTask(id, verificationSchema.parse(req.body))) };
  });
  /** A manual step the current user may work on now (only they add or remove its evidence). */
  const workableStep = (id: string) => {
    const t = visibleTasks().find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    if (t.mode !== 'manual' || t.manual?.stage !== 'work')
      throw new HttpError(409, 'Evidence can only be added while the step is being worked on', 'TASK_WAITS_FOR_VERIFICATION');
    if (!t.canDecide)
      throw new HttpError(403, t.cannotDecideReason ?? 'You may not work on this step', t.cannotDecideCode ?? 'FORBIDDEN', t.cannotDecideParams);
    return t;
  };
  app.post('/tasks/:id/evidence', async (req) => {
    const t = workableStep(params(req).id!);
    const f = await uploadedFile(req, MANUAL_LIMITS.evidenceBytes);
    return addEvidence(t, f.filename, f.data, currentActor());
  });
  app.delete('/tasks/:id/evidence/:evidenceId', async (req) => {
    const t = workableStep(params(req).id!);
    removeEvidence(t, params(req).evidenceId!, currentActor());
    return { ok: true };
  });
  app.get('/tasks/:id/evidence/:evidenceId/download', async (req, reply) => {
    // whoever may see the run may read its evidence
    const pid = store.taskProcessId(params(req).id!);
    if (!processes.permissionsFor(pid).includes('view')) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    const { e, data } = evidenceForDownload(params(req).id!, params(req).evidenceId!);
    // untrusted files: always a download, never rendered by the browser
    reply.header('content-disposition', contentDisposition(e.filename));
    reply.header('content-security-policy', "sandbox; default-src 'none'");
    reply.header('x-content-type-options', 'nosniff');
    return reply.type(downloadType(e.mime)).send(data);
  });

  // ---------- schedules ----------
  const scheduleBody = z.object({
    name: z.string().min(1).max(200),
    processId: z.string().max(200),
    cron: z.string().min(1).max(100),
    timezone: z.string().max(64).optional(),
    inputs: boundedRecord(z.unknown(), 200).default({}),
    bindings: boundedRecord(z.string(), 100).default({}),
    dryRun: z.boolean().default(false),
    enabled: z.boolean().default(true),
    allowOverlap: z.boolean().default(false),
    // a pause sent back with the rest is ignored: it has its own actions (below)
    notify: notifyPolicySchema.optional(),
  });
  app.get('/schedules', async () => scheduler.listSchedules());
  app.post('/schedules', async (req) => {
    const b = scheduleBody.parse(req.body);
    requireProcess(b.processId, 'run', 'schedule this process');
    requireBindingsUsable(b.bindings);
    return scheduler.saveSchedule(b);
  });
  app.put('/schedules/:id', async (req) => {
    scheduler.requireScheduleEdit(params(req).id!);
    const b = scheduleBody.parse(req.body);
    requireProcess(b.processId, 'run', 'schedule this process');
    requireBindingsUsable(b.bindings);
    return scheduler.saveSchedule(b, params(req).id);
  });
  // pause and resume the messages of a schedule's runs (#139); runs and checks are not affected
  app.post('/schedules/:id/pause', async (req) => {
    scheduler.requireScheduleEdit(params(req).id!);
    return scheduler.setSchedulePause(params(req).id!, notifyPauseSchema.omit({ at: true }).parse(req.body ?? {}));
  });
  app.post('/schedules/:id/resume', async (req) => {
    scheduler.requireScheduleEdit(params(req).id!);
    return scheduler.setSchedulePause(params(req).id!, null);
  });
  app.delete('/schedules/:id', async (req) => {
    scheduler.requireScheduleEdit(params(req).id!);
    scheduler.deleteSchedule(params(req).id!);
    return { ok: true };
  });
  app.post('/schedules/:id/run', { config: { rateLimit: ROUTE_LIMITS.action } }, async (req) => {
    const s = scheduler.getSchedule(params(req).id!);
    requireProcess(s.processId, 'run', 'run this process');
    requireBindingsUsable(s.bindings);
    const id = await scheduler.fire(s.id, true);
    if (!id) throw new HttpError(409, 'Run was not started – see audit log');
    return { id };
  });
  app.post('/cron/preview', async (req) => {
    const b = z.object({ cron: z.string().max(100), timezone: z.string().max(64).optional() }).parse(req.body);
    return { next: scheduler.validateCron(b.cron, b.timezone) };
  });
}
