/** /api/v1 routes for processes, runs and tasks. */
import { entryEvidence, tagsMatch, type ManualTaskState, type ProcessPermission, type TaskRecord } from '@sm/shared';
import { sealedProtocol } from '../../audit.js';
import { currentUser } from '../../auth/context.js';
import { manualForReader } from '../../engine/manual.js';
import { decisionCheck } from '../../auth/permissions.js';
import * as processes from '../../processes/service.js';
import * as store from '../../engine/store.js';
import { decodeCursor, pageArray, pageRows } from './pagination.js';
import * as S from './schemas.js';
import { iso, notFound, paged, params, query, viewableRun, visibleProcessIds, type Get } from './helpers.js';

function viewableProcess(id: string): ProcessPermission[] {
  const perms = processes.permissionsFor(id);
  if (!perms.includes('view')) throw notFound(`Process ${id}`);
  return perms;
}

const mapProcess = (p: ReturnType<typeof processes.listProcesses>[number]) => ({
  id: p.id,
  name: p.name,
  description: p.description ?? '',
  tags: p.tags ?? [],
  currentVersion: p.currentVersion,
  updatedAt: p.updatedAt,
  owner: p.owner ?? null,
  permissions: p.permissions,
  lastRun: p.lastRun ?? null,
});

const mapRun = (r: ReturnType<typeof store.getRunSummary>) => ({
  id: r.id,
  processId: r.processId,
  processName: r.processName,
  processVersion: r.processVersion,
  status: r.status,
  dryRun: r.dryRun,
  recorded: r.recorded,
  trigger: r.trigger,
  scheduleId: r.scheduleId ?? null,
  parentRunId: r.parentRunId ?? null,
  parentStepKey: r.parentStepKey ?? null,
  actor: r.actor,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt ?? null,
  error: r.error ?? null,
  stats: r.stats,
});

const mapStep = (s: ReturnType<typeof store.getStepFull>) => ({
  id: String(s.id),
  key: s.key,
  parentKey: s.parentKey,
  nodeId: s.stepId,
  type: s.type,
  name: s.name,
  status: s.status,
  startedAt: s.startedAt,
  finishedAt: s.finishedAt ?? null,
  durationMs: s.durationMs ?? null,
  summary: s.summary ?? null,
  error: s.error ?? null,
  input: s.input,
  output: s.output,
  outputTruncated: !!s.outputTruncated,
});

function manualDetail(m: ManualTaskState) {
  const sub = m.submission;
  return {
    round: m.round,
    checklist: m.spec.checklist.map((item, i) => ({ item, checked: sub ? sub.checked.includes(i) : null })),
    checklistAllRequired: m.spec.checklistAllRequired,
    fields: m.spec.fields.map((f) => {
      const v = sub?.fields.find((x) => x.id === f.id);
      return { id: f.id, type: f.type, label: f.label, required: f.use === 'required', value: v?.value ?? null, ticketId: v?.ticketId ?? null };
    }),
    evidence: m.spec.evidence,
    evidenceFiles: entryEvidence(m).map((e) => ({
      id: e.id,
      filename: e.filename,
      mime: e.mime,
      size: e.size,
      sha256: e.sha256,
      uploadedBy: e.uploadedBy,
      uploadedAt: e.uploadedAt,
    })),
    notAvailable: sub?.notAvailable ?? [],
    completed: sub ? { by: sub.completedBy, at: sub.completedAt } : null,
    doneAt: sub?.doneAt ?? null,
    doneAtReason: sub?.doneAtReason ?? null,
    verificationRequired: m.spec.verification.required || !!sub?.verificationReasons.length,
    verificationReasons: sub?.verificationReasons ?? (m.spec.verification.required ? ['step' as const] : []),
    verifiers: m.spec.verification.verifiers,
    verification: m.verification,
    returnedRounds: m.returned.length,
  };
}

function mapTask(t: TaskRecord & { processId: string }, perms: ProcessPermission[]) {
  const check = decisionCheck(currentUser(), t, { actor: t.startedBy ?? '' }, perms);
  return {
    id: t.id,
    runId: t.runId,
    processId: t.processId,
    processName: t.processName ?? '',
    stepKey: t.stepKey,
    mode: t.mode,
    stage: t.manual?.stage ?? null,
    title: t.title,
    instructions: t.instructions ?? null,
    status: t.status,
    assignees: t.assignees,
    fourEyes: t.fourEyes,
    dryRun: !!t.dryRun,
    startedBy: t.startedBy ?? null,
    createdAt: t.createdAt,
    decidedBy: t.decidedBy ?? null,
    decidedAt: t.decidedAt ?? null,
    approved: t.decision ? t.decision.approved : null,
    itemCount: t.items.length,
    canDecide: check.ok,
    cannotDecideReason: check.ok ? null : (check.reason ?? null),
  };
}

export function processRoutes(get: Get): void {
  // ---------- processes ----------
  get(
    '/processes',
    {
      operationId: 'listProcesses',
      tag: 'Processes',
      summary: 'List processes',
      description: 'Processes you may view (archived ones are left out), ordered by name.',
      query: S.ProcessListQuery,
      paginated: true,
      response: S.pageOf('Process', 'A page of processes'),
    },
    async (req, reply) => {
      const q = query<{ tag?: string; q?: string; cursor?: string; limit: number }>(req);
      const needle = q.q?.toLowerCase();
      const list = processes
        .listProcesses()
        .filter((p) => tagsMatch(p.tags, q.tag))
        .filter((p) => !needle || [p.id, p.name, p.description].some((x) => x?.toLowerCase().includes(needle)));
      return paged(
        req,
        reply,
        pageArray(list.map(mapProcess), (p) => [p.name.toLowerCase(), p.id], q, q),
      );
    },
  );

  get(
    '/processes/:processId',
    {
      operationId: 'getProcess',
      tag: 'Processes',
      summary: 'Get a process with its current definition',
      params: { processId: 'Process id' },
      response: S.ref('ProcessDetail'),
    },
    async (req) => {
      viewableProcess(params(req).processId!);
      const p = processes.getProcess(params(req).processId!);
      return { ...mapProcess(p), definition: p.definition, definitionHash: p.definitionHash };
    },
  );

  get(
    '/processes/:processId/versions',
    {
      operationId: 'listProcessVersions',
      tag: 'Processes',
      summary: 'List versions of a process',
      description: 'Newest first.',
      params: { processId: 'Process id' },
      query: S.PageQuery,
      paginated: true,
      response: S.pageOf('ProcessVersion', 'A page of versions'),
    },
    async (req, reply) => {
      const id = params(req).processId!;
      viewableProcess(id);
      const q = query<{ cursor?: string; limit: number }>(req);
      return paged(
        req,
        reply,
        pageArray(processes.listVersions(id), (v) => [-v.version], q, { ...q, id }),
      );
    },
  );

  get(
    '/processes/:processId/versions/:version',
    {
      operationId: 'getProcessVersion',
      tag: 'Processes',
      summary: 'Get a specific version of a process',
      params: { processId: 'Process id' },
      intParams: { version: 'Version number (1, 2, …)' },
      response: S.ref('ProcessVersionDetail'),
    },
    async (req) => {
      const id = params(req).processId!;
      const version = Number(params(req).version);
      viewableProcess(id);
      const v = processes.listVersions(id).find((x) => x.version === version);
      if (!v) throw notFound(`Version ${version} of process ${id}`);
      return { ...v, processId: id, definition: processes.getProcess(id, version).definition };
    },
  );

  // ---------- runs ----------
  get(
    '/runs',
    {
      operationId: 'listRuns',
      tag: 'Runs',
      summary: 'List runs',
      description: 'Runs of processes you may view, newest first.',
      query: S.RunListQuery,
      paginated: true,
      response: S.pageOf('Run', 'A page of runs'),
    },
    async (req, reply) => {
      const q = query<{
        processId?: string;
        status?: string[];
        trigger?: string[];
        scheduleId?: string;
        dryRun?: boolean;
        from?: string;
        to?: string;
        cursor?: string;
        limit: number;
      }>(req);
      const after = decodeCursor(q.cursor, q);
      let ids = visibleProcessIds();
      if (q.processId) ids = ids.includes(q.processId) ? [q.processId] : [];
      const rows = store.listRunsPage({
        processIds: ids,
        status: q.status,
        trigger: q.trigger,
        scheduleId: q.scheduleId,
        dryRun: q.dryRun,
        from: iso(q.from),
        to: iso(q.to),
        after: after ? { startedAt: String(after[0]), id: String(after[1]) } : undefined,
        limit: q.limit + 1,
      });
      return paged(
        req,
        reply,
        pageRows(rows.map(mapRun), q.limit, (r) => [r.startedAt, r.id], q),
      );
    },
  );

  get(
    '/runs/:runId',
    {
      operationId: 'getRun',
      tag: 'Runs',
      summary: 'Get a run',
      description: 'Inputs, platforms used, step summary, decisions, checks, statistics, protocol fingerprint and sub-process runs.',
      params: { runId: 'Run id' },
      response: S.ref('RunDetail'),
    },
    async (req) => {
      const id = params(req).runId!;
      viewableRun(id);
      const d = store.getRunDetail(id);
      const counts = store.stepStatusCounts(id);
      const sealed = sealedProtocol(id);
      const recordedHash = sealed?.hash ?? null;
      const hash = store.protocolHash(id);
      return {
        ...mapRun(d),
        inputs: d.inputs ?? {},
        bindings: d.bindings ?? {},
        definitionHash: d.definitionHash,
        outputs: d.outputs ?? null,
        steps: { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts },
        decisions: d.tasks.map((t) => ({
          taskId: t.id,
          stepKey: t.stepKey,
          mode: t.mode,
          stage: t.manual?.stage ?? null,
          title: t.title,
          status: t.status,
          approved: t.decision ? t.decision.approved : null,
          selectedKeys: t.decision ? t.decision.selectedKeys : null,
          comment: t.decision?.comment ?? null,
          decidedBy: t.decidedBy ?? null,
          decidedAt: t.decidedAt ?? null,
          createdAt: t.createdAt,
        })),
        checks: store.listChecks(id),
        protocol: { hash, recordedHash, intact: recordedHash ? recordedHash === hash : null, importedHistory: sealed?.importedHistory ?? null },
        children: (d.children ?? [])
          .filter((c) => processes.permissionsFor(c.processId).includes('view'))
          .map((c) => ({ ...c, finishedAt: c.finishedAt ?? null })),
      };
    },
  );

  get(
    '/runs/:runId/steps',
    {
      operationId: 'listRunSteps',
      tag: 'Runs',
      summary: 'List the step journal of a run',
      description: 'In execution order. Inputs and outputs are previews (outputTruncated tells whether the output was cut).',
      params: { runId: 'Run id' },
      query: S.StepListQuery,
      paginated: true,
      response: S.pageOf('RunStep', 'A page of journal entries'),
    },
    async (req, reply) => {
      const id = params(req).runId!;
      viewableRun(id);
      const q = query<{ status?: string[]; type?: string; cursor?: string; limit: number }>(req);
      const filters = { ...q, id };
      const after = decodeCursor(q.cursor, filters);
      const rows = store.listStepsPage(id, { afterId: after ? Number(after[0]) : undefined, limit: q.limit + 1, status: q.status, type: q.type });
      return paged(
        req,
        reply,
        pageRows(rows.map(mapStep), q.limit, (s) => [Number(s.id)], filters),
      );
    },
  );

  get(
    '/runs/:runId/steps/:stepId',
    {
      operationId: 'getRunStep',
      tag: 'Runs',
      summary: 'Get one journal entry with its complete output',
      params: { runId: 'Run id', stepId: 'Journal entry id' },
      response: S.ref('RunStep'),
    },
    async (req) => {
      const id = params(req).runId!;
      viewableRun(id);
      const stepId = Number(params(req).stepId);
      if (!Number.isInteger(stepId)) throw notFound(`Step ${params(req).stepId}`);
      try {
        return mapStep(store.getStepFull(id, stepId));
      } catch {
        throw notFound(`Step ${stepId}`);
      }
    },
  );

  get(
    '/runs/:runId/logs',
    {
      operationId: 'listRunLogs',
      tag: 'Runs',
      summary: 'List the log of a run',
      description: 'Oldest first.',
      params: { runId: 'Run id' },
      query: S.LogListQuery,
      paginated: true,
      response: S.pageOf('RunLog', 'A page of log entries'),
    },
    async (req, reply) => {
      const id = params(req).runId!;
      viewableRun(id);
      const q = query<{ level?: string[]; cursor?: string; limit: number }>(req);
      const filters = { ...q, id };
      const after = decodeCursor(q.cursor, filters);
      const rows = store.listLogsPage(id, { afterId: after ? Number(after[0]) : undefined, limit: q.limit + 1, level: q.level });
      const page = pageRows(rows, q.limit, (l) => [l.id], filters);
      return paged(req, reply, {
        items: page.items.map((l) => ({ id: String(l.id), ts: l.ts, level: l.level, stepKey: l.stepKey ?? null, message: l.message, data: l.data })),
        nextCursor: page.nextCursor,
      });
    },
  );

  // ---------- tasks ----------
  const taskPerms = () => {
    const cache = new Map<string, ProcessPermission[]>();
    return (pid: string) => {
      if (!cache.has(pid)) cache.set(pid, processes.permissionsFor(pid));
      return cache.get(pid)!;
    };
  };

  get(
    '/tasks',
    {
      operationId: 'listTasks',
      tag: 'Tasks',
      summary: 'List user tasks (decisions)',
      description: 'Tasks of runs you may view, newest first. Items are left out; get a task for them.',
      query: S.TaskListQuery,
      paginated: true,
      response: S.pageOf('Task', 'A page of tasks'),
    },
    async (req, reply) => {
      const q = query<{ status?: string[]; processId?: string; runId?: string; cursor?: string; limit: number }>(req);
      const after = decodeCursor(q.cursor, q);
      let ids = visibleProcessIds();
      if (q.processId) ids = ids.includes(q.processId) ? [q.processId] : [];
      const rows = store.listTasksPage({
        processIds: ids,
        status: q.status,
        runId: q.runId,
        after: after ? { createdAt: String(after[0]), id: String(after[1]) } : undefined,
        limit: q.limit + 1,
      });
      const perms = taskPerms();
      return paged(
        req,
        reply,
        pageRows(
          rows.map((t) => mapTask(t, perms(t.processId))),
          q.limit,
          (t) => [t.createdAt, t.id],
          q,
        ),
      );
    },
  );

  get(
    '/tasks/:taskId',
    { operationId: 'getTask', tag: 'Tasks', summary: 'Get a task with its items and decision', params: { taskId: 'Task id' }, response: S.ref('TaskDetail') },
    async (req) => {
      const id = params(req).taskId!;
      let pid: string;
      try {
        pid = store.taskProcessId(id);
      } catch {
        throw notFound(`Task ${id}`);
      }
      const perms = processes.permissionsFor(pid);
      if (!perms.includes('view')) throw notFound(`Task ${id}`);
      const t = store.getTask(id);
      return {
        ...mapTask({ ...t, processId: pid }, perms),
        columns: t.columns.map((c) => c.label),
        items: t.items.map((i) => ({ key: String(i.key), cells: i.cells.map((c) => String(c ?? '')), preselected: !!i.preselected })),
        selectedKeys: t.decision ? t.decision.selectedKeys : null,
        comment: t.decision?.comment ?? null,
        manual: t.manual ? manualDetail(manualForReader(t.manual, currentUser())) : null,
      };
    },
  );
}
