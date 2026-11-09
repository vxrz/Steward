import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  validateProcess,
  type StartRunRequest,
  type TaskDecision,
  MANUAL_LIMITS,
  boundedRecord,
  notifyPauseSchema,
  notifyPolicySchema,
  SCHEDULE_CATCH_UP,
} from '@sm/shared';
import { allAuditAscending } from '../audit.js';
import { HttpError, MAX_DEFINITION_TEXT, rasterImageType } from '../util.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import { engine, modeOf } from '../engine/index.js';
import { authorizeCancel, authorizeSignal, authorizeStart } from '../engine/commands.js';
import { addEvidence, evidenceForDownload, manualCompletionSchema, removeEvidence, verificationSchema } from '../engine/manual.js';
import * as scheduler from '../scheduler.js';
import { runReportHtml } from '../reports.js';
import { uploadedFile } from '../records/routes.js';
import { contentDisposition, downloadType } from '../records/attachments.js';
import { currentActor } from '../auth/context.js';
import * as users from '../auth/users.js';
import { processAccess } from '../auth/step-up-rules.js';
import { requireCapability } from '../auth/permissions.js';
import { ROUTE_LIMITS } from '../rateLimits.js';
import { LARGE_BODIES } from '../bodyLimits.js';
import { me } from '../auth/access.js';
import { requireProcess, requireRun, withDecisionRights, visibleTasks, visibleRuns } from './helpers.js';
import { params } from './params.js';

/** Query strings are validated like bodies: one value per parameter, bounded, numbers as numbers. */
const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() });
const runsQuery = z.object({
  processId: z.string().max(200).optional(),
  status: z.string().max(200).optional(),
  scheduleId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  /** `<startedAt>,<id>` of the last run shown (a bare `<startedAt>` still works) */
  before: z.string().max(200).optional(),
  /** Runs started after this time (ISO), e.g. the start page's "Failed runs (24 h)" */
  since: z
    .string()
    .max(64)
    .refine((x) => !Number.isNaN(Date.parse(x)), 'an ISO timestamp')
    .transform((x) => new Date(x).toISOString())
    .optional(),
  /** `failed`: only runs with a failed check (the start page's "Failed checks" links) */
  checks: z.enum(['failed']).optional(),
  /** `findings`: runs that completed with findings; `succeeded`: runs that succeeded without (the Runs page's status filter) */
  outcome: z.enum(['succeeded', 'findings']).optional(),
  /** `1`: debug runs only (ADR 0010: they are left out otherwise, and only their starter, managers, administrators and auditors see them) */
  debug: z
    .enum(['0', '1'])
    .transform((x) => x === '1')
    .optional(),
  /** Sort column (U15): started (default), process, status, by, duration; `dir` asc or desc (default desc) */
  sort: z.enum(store.RUN_SORT_KEYS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  /** With a sort: the id of the last run shown ("Load more"); `before` is the cursor of the default order */
  after: z.string().max(200).optional(),
});

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
        /** The id the person chose in the "New process" dialog (U7): taken as given, refused when it exists */
        id: z
          .string()
          .trim()
          .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, 'Lower-case letters, digits and dashes, at most 48')
          .optional(),
      })
      .parse(req.body);
    if (b.templateId) return processes.createFromTemplate(b.templateId);
    const def = b.text ? processes.parseDefinitionText(b.text) : b.definition;
    return processes.createProcess(def, { comment: b.comment ?? (b.text ? 'Imported' : 'Created'), ...(b.id ? { id: b.id, exactId: true } : {}) });
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
        // slot → identity id (0.13.0, ADR 0009); a missing slot: the platform's default identity
        identities: boundedRecord(z.string().max(100), 100).optional(),
        dryRun: z.boolean().optional(),
        recorded: z.boolean().optional(),
      })
      .parse(req.body) as StartRunRequest;
    // the command layer (ADR 0011): process run, use on each bound platform and its identity
    authorizeStart(undefined, { processId: b.processId, bindings: b.bindings, identities: b.identities });
    const { runId } = await engine().start({
      processId: b.processId,
      version: b.version,
      inputs: b.inputs ?? {},
      bindings: b.bindings ?? {},
      ...(b.identities ? { identities: b.identities } : {}),
      mode: modeOf(b),
      actor: currentActor(),
      origin: { trigger: 'manual' },
    });
    return { id: runId };
  });
  app.get('/runs', async (req) => {
    const { sort, dir, ...q } = runsQuery.parse(req.query ?? {});
    const order: store.RunSort = { key: sort ?? 'started', dir: dir ?? 'desc' };
    if (q.before && (order.key !== 'started' || order.dir !== 'desc'))
      throw new HttpError(400, 'before= continues the newest-first list; use after=<run id> with a sort', 'RUN_CURSOR_SORT');
    return visibleRuns({ ...q, sort: order });
  });
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
    const id = params(req).id!;
    authorizeCancel(id);
    // the reason goes into run.cancelled (ADR 0011)
    const b = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    await engine().cancel(id, b.reason || `Cancelled by ${currentActor()}`, currentActor());
    return { ok: true };
  });
  app.post('/runs/:id/resume', async (req) => {
    const id = params(req).id!;
    authorizeSignal(id, { type: 'resume' });
    await engine().signal(id, { type: 'resume' }, currentActor());
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
    // the command layer: who may decide, and the four-eyes proof (the run's starter asked, this person decides)
    authorizeSignal(t.runId, { type: t.mode === 'manual' ? 'manual.complete' : 'task.decide', taskId: id });
    if (t.mode === 'manual') {
      const input = manualCompletionSchema.parse(req.body ?? {});
      return await engine().signal(t.runId, { type: 'manual.complete', taskId: id, input }, currentActor());
    }
    const decision = z
      .object({ approved: z.boolean(), selectedKeys: z.array(z.string().max(500)).max(10000).default([]), comment: z.string().max(5000).optional() })
      .parse(req.body) as TaskDecision;
    return await engine().signal(t.runId, { type: 'task.decide', taskId: id, decision }, currentActor());
  });
  // manual steps: the second person verifies (or sends back / rejects) what the first one entered
  // (a step-up when the assurance policy asks for one on verifying manual steps – off by default)
  const verifiable = (req: FastifyRequest) => {
    const t = visibleTasks().find((x) => x.id === params(req).id);
    return !!t && t.mode === 'manual' && t.manual?.stage === 'verify' && !!t.canDecide;
  };
  app.post('/tasks/:id/verify', { config: { stepUp: { action: 'verifyManualStep', optional: true, who: verifiable } } }, async (req) => {
    const id = params(req).id!;
    const t = visibleTasks().find((x) => x.id === id);
    if (!t) throw new HttpError(404, 'Task not found', 'TASK_NOT_FOUND');
    if (t.mode !== 'manual' || t.manual?.stage !== 'verify') throw new HttpError(409, 'This step does not wait for a verification', 'TASK_NOT_IN_VERIFICATION');
    authorizeSignal(t.runId, { type: 'manual.verify', taskId: id });
    const input = verificationSchema.parse(req.body);
    return await engine().signal(t.runId, { type: 'manual.verify', taskId: id, input }, currentActor());
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
    // slot → identity id (0.13.0, ADR 0009); checked against the owner when saved and at every fire
    identities: boundedRecord(z.string().max(100), 100).optional(),
    dryRun: z.boolean().default(false),
    enabled: z.boolean().default(true),
    allowOverlap: z.boolean().default(false),
    catchUp: z.enum(SCHEDULE_CATCH_UP).optional(),
    // a pause sent back with the rest is ignored: it has its own actions (below)
    notify: notifyPolicySchema.optional(),
  });
  app.get('/schedules', async () => scheduler.listSchedules());
  app.post('/schedules', async (req) => {
    const b = scheduleBody.parse(req.body);
    authorizeStart(undefined, { processId: b.processId, bindings: b.bindings, identities: b.identities });
    return scheduler.saveSchedule(b);
  });
  app.put('/schedules/:id', async (req) => {
    scheduler.requireScheduleEdit(params(req).id!);
    const b = scheduleBody.parse(req.body);
    authorizeStart(undefined, { processId: b.processId, bindings: b.bindings, identities: b.identities });
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
    authorizeStart(undefined, { processId: s.processId, bindings: s.bindings, identities: s.identities });
    const id = await scheduler.fire(s.id, true);
    if (!id) throw new HttpError(409, 'Run was not started – see audit log');
    return { id };
  });
  app.post('/cron/preview', async (req) => {
    const b = z.object({ cron: z.string().max(100), timezone: z.string().max(64).optional() }).parse(req.body);
    return { next: scheduler.validateCron(b.cron, b.timezone), warnings: scheduler.cronWarnings(b.cron) };
  });
}
