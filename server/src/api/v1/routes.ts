/**
 * Endpoints of the public, read-only REST API (/api/v1). They reuse the
 * services and permission checks of the web UI's internal API, but map the
 * results to the stable shapes in schemas.ts.
 */
import YAML from 'yaml';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatasetRow, ProcessPermission, TaskRecord } from '@sm/shared';
import { config } from '../../config.js';
import { vault } from '../../vault.js';
import { db } from '../../db.js';
import { audit, queryAudit, sealedProtocolHash } from '../../audit.js';
import { createCheckpoint, verificationResult, verifyWithAnchors } from '../../audit-anchor.js';
import { currentUser } from '../../auth/context.js';
import { capabilities, decisionCheck, requireCapability } from '../../auth/permissions.js';
import * as users from '../../auth/users.js';
import * as processes from '../../processes/service.js';
import * as store from '../../engine/store.js';
import * as scheduler from '../../scheduler.js';
import * as platforms from '../../platforms/service.js';
import * as triggers from '../../triggers/service.js';
import { semanticModel, type OssieVersion } from '../../semantic/ossie.js';
import * as datasets from '../../dashboards/datasets.js';
import * as dashboards from '../../dashboards/service.js';
import { monitorDatasetVisible } from '../../monitors/datasets.js';
import { monitorApiRoutes } from '../../monitors/api-v1.js';
import { credentialApiRoutes } from '../../credentials/api-v1.js';
import { recordApiRoutes } from '../../records/api-v1.js';
import { ticketApiRoutes } from '../../tickets/api-v1.js';
import { complianceApiRoutes } from '../../compliance/api-v1.js';
import { HttpError } from '../../util.js';
import { API_VERSION } from './config.js';
import { ProblemError } from './problem.js';
import { decodeCursor, encodeCursor, linkNext, pageArray, pageRows } from './pagination.js';
import * as S from './schemas.js';
import type { ApiPrincipal } from './auth.js';

type Q = Record<string, unknown>;
type Paged<T> = { items: T[]; nextCursor: string | null };

const params = (req: FastifyRequest) => req.params as Record<string, string>;
const query = <T = Q>(req: FastifyRequest) => req.query as T;
const principal = (req: FastifyRequest) => (req as unknown as { smApi: ApiPrincipal }).smApi;
const iso = (s: string | undefined) => (s ? new Date(s).toISOString() : undefined);
const notFound = (what: string) => new ProblemError(404, { type: 'not-found', title: 'Not found', detail: `${what} not found` });

/** Send a page with an RFC 8288 Link header. */
function paged<T>(req: FastifyRequest, reply: FastifyReply, page: Paged<T>): Paged<T> {
  linkNext(req, reply, page.nextCursor);
  return page;
}

// ---------- visibility helpers (mirror the internal API) ----------

function visibleProcessIds(): string[] {
  return db()
    .all<{ id: string }>('SELECT id FROM processes')
    .map((r) => r.id)
    .filter((id) => processes.permissionsFor(id).includes('view'));
}

function viewableProcess(id: string): ProcessPermission[] {
  const perms = processes.permissionsFor(id);
  if (!perms.includes('view')) throw notFound(`Process ${id}`);
  return perms;
}

function viewableRun(id: string): store.RunRow {
  let r: store.RunRow;
  try {
    r = store.runRow(id);
  } catch {
    throw notFound(`Run ${id}`);
  }
  if (!processes.permissionsFor(r.process_id).includes('view')) throw notFound(`Run ${id}`);
  return r;
}

function visibleDataset(key: string) {
  let meta;
  try {
    meta = datasets.getDatasetMeta(key);
  } catch {
    throw notFound(`Dataset ${key}`);
  }
  if (!(monitorDatasetVisible(meta.processId) ?? processes.permissionsFor(meta.processId).includes('view'))) throw notFound(`Dataset ${key}`);
  return meta;
}

// ---------- mappers ----------

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

function mapTask(t: TaskRecord & { processId: string }, perms: ProcessPermission[]) {
  const check = decisionCheck(currentUser(), t, { actor: t.startedBy ?? '' }, perms);
  return {
    id: t.id,
    runId: t.runId,
    processId: t.processId,
    processName: t.processName ?? '',
    stepKey: t.stepKey,
    mode: t.mode,
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

const mapSchedule = (s: ReturnType<typeof scheduler.getSchedule>) => ({
  id: s.id,
  name: s.name,
  processId: s.processId,
  processName: s.processName ?? '',
  cron: s.cron,
  timezone: s.timezone ?? null,
  enabled: s.enabled,
  dryRun: s.dryRun,
  allowOverlap: s.allowOverlap,
  inputs: s.inputs,
  bindings: s.bindings,
  owner: s.owner ?? null,
  nextRunAt: s.nextRunAt ?? null,
  lastRunAt: s.lastRunAt ?? null,
  lastRunId: s.lastRunId ?? null,
  lastRunStatus: s.lastRunStatus ?? null,
  createdAt: s.createdAt,
});

/** Base URL without user info, query or fragment (they could carry credentials). */
export function safeBaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, raw.endsWith('/') ? '/' : '');
  } catch {
    return raw.replace(/\/\/[^/@]*@/, '//').replace(/[?#].*$/, '');
  }
}

const mapTrigger = (t: ReturnType<typeof triggers.getTrigger>) => ({
  id: t.id,
  name: t.name,
  description: t.description ?? '',
  processId: t.processId,
  processName: t.processName ?? '',
  processVersion: t.processVersion ?? null,
  enabled: t.enabled,
  dryRun: t.dryRun,
  authMode: t.authMode,
  owner: t.owner,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  lastFiredAt: t.lastFiredAt,
  lastRunId: t.lastRunId,
  lastRunStatus: t.lastRunStatus,
  fireCount: t.fireCount,
  rejectedCount: t.rejectedCount,
});

const mapPlatform = (p: ReturnType<typeof platforms.getPlatform>) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  description: p.description ?? '',
  environment: p.environment ?? '',
  baseUrl: safeBaseUrl(p.baseUrl ?? ''),
  authType: p.config?.auth?.type ?? 'none',
  permissions: p.permissions,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const mapDataset = (d: ReturnType<typeof datasets.getDatasetMeta>) => ({
  key: d.key,
  title: d.title,
  processId: d.processId,
  processName: d.processName,
  runId: d.runId,
  dryRun: d.dryRun,
  updatedAt: d.updatedAt,
  rowCount: d.rowCount,
  columns: d.columns,
  statusCounts: d.statusCounts,
  metrics: d.metrics,
  staleAfterMinutes: d.staleAfterMinutes ?? null,
  stale: d.stale,
});

const mapDashboard = (d: ReturnType<typeof dashboards.getDashboard>) => ({
  id: d.id,
  name: d.name,
  description: d.description ?? '',
  definition: d.definition,
  owner: d.owner ?? null,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

const mapAudit = (a: ReturnType<typeof queryAudit>[number]) => ({
  seq: a.seq,
  ts: a.ts,
  actor: a.actor,
  action: a.action,
  entityType: a.entityType,
  entityId: a.entityId ?? null,
  runId: a.runId ?? null,
  summary: a.summary,
  details: a.details ?? null,
  hash: a.hash,
});

const mapUser = (u: ReturnType<typeof users.getUser>) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  email: u.email ?? null,
  roles: u.roles,
  teams: u.teams,
  active: u.active,
  authSource: u.authSource,
  mustChangePassword: u.mustChangePassword,
  lastLoginAt: u.lastLoginAt ?? null,
  createdAt: u.createdAt,
});

// ---------- route definitions ----------

/** Error statuses an operation can declare (their OpenAPI responses: RESPONSES in ../index.ts). */
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429;

export interface Op {
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  query?: Parameters<typeof S.querySchema>[0];
  params?: Record<string, string>;
  /** Integer path parameters */
  intParams?: Record<string, string>;
  response: Record<string, unknown>;
  /** Paginated list (Link header, nextCursor) */
  paginated?: boolean;
  /** Extra documented error statuses */
  errors?: ErrorStatus[];
}

/** Operations that return pages (documented with a Link header). */
export const PAGINATED_OPERATIONS = new Set<string>();
/** Operations and their extra documented error statuses. */
export const OPERATION_ERRORS = new Map<string, number[]>();

export function schemaOf(op: Op) {
  if (op.paginated) PAGINATED_OPERATIONS.add(op.operationId);
  const errs = new Set<number>([401, 403, 429, ...(op.errors ?? [])]);
  if (op.query) errs.add(400);
  if (op.params || op.intParams) errs.add(404);
  OPERATION_ERRORS.set(op.operationId, [...errs].sort());
  const pathProps = {
    ...(op.params ? S.pathParams(op.params) : {}),
  } as { type?: string; required?: string[]; properties?: Record<string, unknown> };
  if (op.intParams) {
    pathProps.type = 'object';
    pathProps.required = [...(pathProps.required ?? []), ...Object.keys(op.intParams)];
    pathProps.properties = {
      ...(pathProps.properties ?? {}),
      ...Object.fromEntries(Object.entries(op.intParams).map(([n, d]) => [n, { type: 'integer', minimum: 1, description: d }])),
    };
  }
  return {
    tags: [op.tag],
    operationId: op.operationId,
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(op.query ? { querystring: S.querySchema(op.query) } : {}),
    ...(op.params || op.intParams ? { params: pathProps } : {}),
    response: { 200: { description: 'OK', ...op.response } },
  };
}

export async function v1Routes(app: FastifyInstance, opts: { spec: () => Record<string, unknown> }): Promise<void> {
  const get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R, smAuth: 'token' | 'none' | 'spec' = 'token') =>
    app.get(url, { schema: schemaOf(op), config: { smAuth } }, async (req, reply) => handler(req, reply));

  // ---------- meta ----------
  get(
    '/health',
    {
      operationId: 'getHealth',
      tag: 'Meta',
      summary: 'Health of the API',
      description: 'No token needed. Answers 503 with status "unavailable" while the vault is locked.',
      response: S.ref('Health'),
    },
    async (_req, reply) => {
      const ok = vault().unlocked;
      if (!ok) reply.code(503).header('retry-after', '60');
      return { status: ok ? 'ok' : 'unavailable', apiVersion: API_VERSION, time: new Date().toISOString() };
    },
    'none',
  );

  get('/me', { operationId: 'getMe', tag: 'Meta', summary: 'Owner and scope of the token', response: S.ref('Me') }, async (req) => {
    const p = principal(req);
    const caps = capabilities(currentUser());
    return {
      user: { id: p.user.id, username: p.user.username, displayName: p.user.displayName, roles: p.user.roles, teams: p.user.teams },
      token: { id: p.tokenId, name: p.tokenName, scope: p.scope, createdAt: p.createdAt, expiresAt: p.expiresAt, lastUsedAt: p.lastUsedAt },
      capabilities: { viewAudit: caps.viewAudit, manageUsers: caps.manageUsers },
      serverVersion: config.version,
      apiVersion: API_VERSION,
    };
  });

  const specResponse = { type: 'object', additionalProperties: true, description: 'OpenAPI 3.1 document' };
  get(
    '/openapi.json',
    {
      operationId: 'getOpenApiDocument',
      tag: 'Meta',
      summary: 'This OpenAPI document (JSON)',
      description: 'Available with a token, or without one when the documentation is enabled (signed-in users or public, see SM_API_DOCS).',
      response: specResponse,
    },
    async () => opts.spec(),
    'spec',
  );
  app.get('/openapi.yaml', { schema: { hide: true }, config: { smAuth: 'spec' } }, async (_req, reply) =>
    reply.type('application/yaml; charset=utf-8').send(YAML.stringify(opts.spec())),
  );

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
        .filter((p) => !q.tag || p.tags.includes(q.tag))
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
      const recordedHash = sealedProtocolHash(id);
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
        protocol: { hash, recordedHash, intact: recordedHash ? recordedHash === hash : null },
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
      };
    },
  );

  // ---------- schedules ----------
  get(
    '/schedules',
    {
      operationId: 'listSchedules',
      tag: 'Schedules',
      summary: 'List schedules',
      description: 'Schedules of processes you may view, ordered by name.',
      query: S.ScheduleListQuery,
      paginated: true,
      response: S.pageOf('Schedule', 'A page of schedules'),
    },
    async (req, reply) => {
      const q = query<{ processId?: string; enabled?: boolean; cursor?: string; limit: number }>(req);
      const list = scheduler
        .listSchedules()
        .filter((s) => !q.processId || s.processId === q.processId)
        .filter((s) => q.enabled === undefined || s.enabled === q.enabled)
        .map(mapSchedule);
      return paged(
        req,
        reply,
        pageArray(list, (s) => [s.name.toLowerCase(), s.id], q, q),
      );
    },
  );

  get(
    '/schedules/:scheduleId',
    { operationId: 'getSchedule', tag: 'Schedules', summary: 'Get a schedule', params: { scheduleId: 'Schedule id' }, response: S.ref('Schedule') },
    async (req) => {
      let s;
      try {
        s = scheduler.getSchedule(params(req).scheduleId!);
      } catch {
        throw notFound(`Schedule ${params(req).scheduleId}`);
      }
      if (!processes.permissionsFor(s.processId).includes('view')) throw notFound(`Schedule ${s.id}`);
      return mapSchedule(s);
    },
  );

  // ---------- webhook triggers ----------
  get(
    '/triggers',
    {
      operationId: 'listTriggers',
      tag: 'Triggers',
      summary: 'List webhook triggers',
      description: 'Triggers of processes you may view, ordered by name. Secrets are never returned.',
      query: S.TriggerListQuery,
      paginated: true,
      response: S.pageOf('Trigger', 'A page of webhook triggers'),
    },
    async (req, reply) => {
      const q = query<{ processId?: string; enabled?: boolean; cursor?: string; limit: number }>(req);
      const list = triggers
        .listTriggers()
        .filter((t) => !q.processId || t.processId === q.processId)
        .filter((t) => q.enabled === undefined || t.enabled === q.enabled)
        .map(mapTrigger);
      return paged(
        req,
        reply,
        pageArray(list, (t) => [t.name.toLowerCase(), t.id], q, q),
      );
    },
  );

  get(
    '/triggers/:triggerId',
    { operationId: 'getTrigger', tag: 'Triggers', summary: 'Get a webhook trigger', params: { triggerId: 'Trigger id' }, response: S.ref('Trigger') },
    async (req) => {
      try {
        return mapTrigger(triggers.getTrigger(params(req).triggerId!));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Trigger ${params(req).triggerId}`);
        throw e;
      }
    },
  );

  // ---------- semantic model ----------
  get(
    '/semantic-model',
    {
      operationId: 'getSemanticModel',
      tag: 'Semantic model',
      summary: 'Data model of this API as an Apache Ossie semantic model',
      description:
        'Datasets (the API resources), fields with types, relationships and metrics such as the run success rate or monitor availability, as an [Apache Ossie](https://github.com/apache/ossie) (formerly OSI) document. JSON or YAML (`Accept: application/yaml` or `format=yaml`). The model describes the schema, not data, and is the same for every token. See docs/SEMANTIC-MODEL.md.',
      query: S.SemanticModelQuery,
      response: {
        content: {
          'application/json': { schema: S.ossieDocumentSchema },
          'application/yaml': { schema: { type: 'string', description: 'The same document as YAML' } },
        },
      },
    },
    async (req, reply) => {
      const q = query<{ format?: 'json' | 'yaml'; version: OssieVersion }>(req);
      const accept = String(req.headers.accept ?? '');
      const yamlFirst = /yaml/i.test(accept) && (!/json/i.test(accept) || accept.search(/yaml/i) < accept.search(/json/i));
      const doc = semanticModel(q.version);
      if (q.format === 'yaml' || (!q.format && yamlFirst)) {
        return reply.type('application/yaml; charset=utf-8').send(YAML.stringify(doc, { lineWidth: 0 }));
      }
      return reply.type('application/json; charset=utf-8').send(JSON.stringify(doc));
    },
  );

  // ---------- platforms ----------
  get(
    '/platforms',
    {
      operationId: 'listPlatforms',
      tag: 'Platforms',
      summary: 'List platforms (metadata only)',
      description: 'Only platforms the token owner has some permission on. Credentials, variables and authentication settings are never returned.',
      query: S.PlatformListQuery,
      paginated: true,
      response: S.pageOf('Platform', 'A page of platforms'),
    },
    async (req, reply) => {
      const q = query<{ kind?: string; environment?: string; cursor?: string; limit: number }>(req);
      // Like the web UI: only platforms the token owner has some permission on.
      const list = platforms
        .listPlatforms()
        .filter((p) => p.permissions.length > 0)
        .filter((p) => !q.kind || p.kind === q.kind)
        .filter((p) => !q.environment || p.environment === q.environment)
        .map(mapPlatform);
      return paged(
        req,
        reply,
        pageArray(list, (p) => [p.name.toLowerCase(), p.id], q, q),
      );
    },
  );

  get(
    '/platforms/:platformId',
    {
      operationId: 'getPlatform',
      tag: 'Platforms',
      summary: 'Get a platform (metadata only)',
      params: { platformId: 'Platform id' },
      response: S.ref('Platform'),
    },
    async (req) => {
      try {
        const p = platforms.getPlatform(params(req).platformId!);
        // 404 (not 403) without any permission, so platform ids can't be probed.
        if (!p.permissions.length) throw notFound(`Platform ${params(req).platformId}`);
        return mapPlatform(p);
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Platform ${params(req).platformId}`);
        throw e;
      }
    },
  );

  // ---------- datasets & dashboards ----------
  get(
    '/datasets',
    {
      operationId: 'listDatasets',
      tag: 'Dashboards',
      summary: 'List datasets',
      description: 'Datasets published by processes you may view, ordered by key.',
      query: S.PageQuery,
      paginated: true,
      response: S.pageOf('Dataset', 'A page of datasets'),
    },
    async (req, reply) => {
      const q = query<{ cursor?: string; limit: number }>(req);
      const visible = new Set(visibleProcessIds());
      const list = datasets
        .listDatasets()
        .filter((d) => monitorDatasetVisible(d.processId) ?? visible.has(d.processId))
        .map(mapDataset);
      return paged(
        req,
        reply,
        pageArray(list, (d) => [d.key], q, q),
      );
    },
  );

  get(
    '/datasets/:datasetKey',
    {
      operationId: 'getDataset',
      tag: 'Dashboards',
      summary: 'Get dataset metadata',
      params: { datasetKey: 'Dataset key, e.g. iem.devices' },
      response: S.ref('Dataset'),
    },
    async (req) => mapDataset(visibleDataset(params(req).datasetKey!)),
  );

  get(
    '/datasets/:datasetKey/rows',
    {
      operationId: 'listDatasetRows',
      tag: 'Dashboards',
      summary: 'List the rows of a dataset snapshot',
      description:
        'In published order. When the dataset is re-published while you page through it, the next page answers 409 (dataset-changed) – start again without a cursor.',
      params: { datasetKey: 'Dataset key' },
      query: S.DatasetRowsQuery,
      paginated: true,
      errors: [409],
      response: S.pageOf('DatasetRow', 'A page of rows'),
    },
    async (req, reply) => {
      const meta = visibleDataset(params(req).datasetKey!);
      const q = query<{ status?: string[]; cursor?: string; limit: number }>(req);
      const filters = { ...q, key: meta.key };
      const after = decodeCursor(q.cursor, filters);
      if (after && after[1] !== meta.updatedAt) {
        throw new ProblemError(409, {
          type: 'dataset-changed',
          title: 'Dataset changed',
          detail: 'The dataset was re-published since the first page – start again without a cursor',
        });
      }
      const rows: DatasetRow[] = datasets.getDataset(meta.key).rows.filter((r) => !q.status?.length || q.status.includes(r._status ?? 'unknown'));
      const offset = after ? Number(after[0]) : 0;
      const items = rows.slice(offset, offset + q.limit);
      const next = offset + q.limit < rows.length ? encodeCursor([offset + q.limit, meta.updatedAt], filters) : null;
      return paged(req, reply, { items, nextCursor: next });
    },
  );

  get(
    '/datasets/:datasetKey/metrics',
    {
      operationId: 'getDatasetMetrics',
      tag: 'Dashboards',
      summary: 'Metric history of a dataset',
      params: { datasetKey: 'Dataset key' },
      query: S.MetricsQuery,
      response: {
        type: 'object',
        required: ['key', 'days', 'series'],
        additionalProperties: false,
        properties: { key: { type: 'string' }, days: { type: 'integer' }, series: { type: 'array', items: S.ref('MetricSeries') } },
      },
    },
    async (req) => {
      const meta = visibleDataset(params(req).datasetKey!);
      const q = query<{ names?: string[]; days: number; points: number }>(req);
      return { key: meta.key, days: q.days, series: datasets.metricSeries(meta.key, q.names?.length ? q.names : undefined, q.days, q.points) };
    },
  );

  get(
    '/dashboards',
    {
      operationId: 'listDashboards',
      tag: 'Dashboards',
      summary: 'List dashboard definitions',
      description: 'Ordered by name.',
      query: S.PageQuery,
      paginated: true,
      response: S.pageOf('Dashboard', 'A page of dashboards'),
    },
    async (req, reply) => {
      const q = query<{ cursor?: string; limit: number }>(req);
      return paged(
        req,
        reply,
        pageArray(dashboards.listDashboards().map(mapDashboard), (d) => [d.name.toLowerCase(), d.id], q, q),
      );
    },
  );

  get(
    '/dashboards/:dashboardId',
    {
      operationId: 'getDashboard',
      tag: 'Dashboards',
      summary: 'Get a dashboard definition',
      params: { dashboardId: 'Dashboard id' },
      response: S.ref('Dashboard'),
    },
    async (req) => {
      try {
        return mapDashboard(dashboards.getDashboard(params(req).dashboardId!));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404) throw notFound(`Dashboard ${params(req).dashboardId}`);
        throw e;
      }
    },
  );

  // ---------- audit ----------
  get(
    '/audit',
    {
      operationId: 'listAuditEntries',
      tag: 'Audit',
      summary: 'List audit log entries',
      description: 'Auditors and administrators; others only with `runId` of a run they may view. Newest first.',
      query: S.AuditListQuery,
      paginated: true,
      response: S.pageOf('AuditEntry', 'A page of audit entries'),
    },
    async (req, reply) => {
      const q = query<{
        action?: string;
        actor?: string;
        entityType?: string;
        entityId?: string;
        runId?: string;
        q?: string;
        from?: string;
        to?: string;
        cursor?: string;
        limit: number;
      }>(req);
      if (q.runId && !capabilities(currentUser()).viewAudit) viewableRun(q.runId);
      else requireCapability(currentUser(), 'viewAudit', 'view the audit log');
      const after = decodeCursor(q.cursor, q);
      const rows = queryAudit({
        action: q.action,
        actor: q.actor,
        entityType: q.entityType,
        entityId: q.entityId,
        runId: q.runId,
        q: q.q,
        from: iso(q.from),
        to: iso(q.to),
        beforeSeq: after ? Number(after[0]) : undefined,
        limit: q.limit + 1,
      });
      return paged(
        req,
        reply,
        pageRows(rows.map(mapAudit), q.limit, (a) => [a.seq], q),
      );
    },
  );

  get(
    '/audit/verify',
    {
      operationId: 'verifyAuditLog',
      tag: 'Audit',
      summary: 'Verify the hash chain of the audit log',
      description: 'Auditors and administrators. The verification itself is recorded in the audit log.',
      response: S.ref('AuditVerifyResult'),
    },
    async () => {
      requireCapability(currentUser(), 'viewAudit', 'verify the audit log');
      // compared with the configured anchors (local anchor file, SM_AUDIT_ANCHOR[_FILE]); a success is checkpointed
      const r = await verifyWithAnchors();
      audit({ action: 'audit.verified', entityType: 'audit', summary: `Audit chain verified via the API: ${r.message}`, details: verificationResult(r, null) });
      if (r.ok) await createCheckpoint('verify');
      return { ok: r.ok, checked: r.checked, firstBadSeq: r.firstBadSeq ?? null, message: r.message };
    },
  );

  // ---------- users & teams ----------
  get(
    '/users',
    {
      operationId: 'listUsers',
      tag: 'Users',
      summary: 'List users',
      description: 'Administrators only. Ordered by user name.',
      query: S.UserListQuery,
      paginated: true,
      response: S.pageOf('User', 'A page of users'),
    },
    async (req, reply) => {
      requireCapability(currentUser(), 'manageUsers', 'list users');
      const q = query<{ active?: boolean; cursor?: string; limit: number }>(req);
      const list = users
        .listUsers()
        .filter((u) => q.active === undefined || u.active === q.active)
        .map(mapUser);
      return paged(
        req,
        reply,
        pageArray(list, (u) => [u.username.toLowerCase(), u.id], q, q),
      );
    },
  );

  get(
    '/users/:userId',
    {
      operationId: 'getUser',
      tag: 'Users',
      summary: 'Get a user',
      description: 'Administrators only.',
      params: { userId: 'User id' },
      response: S.ref('User'),
    },
    async (req) => {
      requireCapability(currentUser(), 'manageUsers', 'view users');
      try {
        return mapUser(users.getUser(params(req).userId!));
      } catch {
        throw notFound(`User ${params(req).userId}`);
      }
    },
  );

  get(
    '/teams',
    {
      operationId: 'listTeams',
      tag: 'Users',
      summary: 'List teams',
      description: 'Administrators only. Ordered by name.',
      query: S.PageQuery,
      paginated: true,
      response: S.pageOf('Team', 'A page of teams'),
    },
    async (req, reply) => {
      requireCapability(currentUser(), 'manageUsers', 'list teams');
      const q = query<{ cursor?: string; limit: number }>(req);
      return paged(
        req,
        reply,
        pageArray(users.listTeams(), (t) => [t.name.toLowerCase(), t.id], q, q),
      );
    },
  );

  // ---------- monitors ----------
  await monitorApiRoutes(app, get);

  // ---------- credentials register ----------
  credentialApiRoutes(get);
  // ---------- records ----------
  await recordApiRoutes(app, get);
  // ---------- ticket references ----------
  ticketApiRoutes(get);
  // ---------- compliance ----------
  complianceApiRoutes(get);
}
