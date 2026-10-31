/**
 * The read-only tools of Steward's MCP server. Every tool runs "as" the owner of the API token
 * (requestContext), through the same services and permission checks as the web UI and /api/v1 –
 * never with more rights. Results are compact JSON (structuredContent plus the same JSON as text),
 * paginated with opaque cursors and capped in size.
 */
import { z } from 'zod';
import { DATASET_STATUSES, MONITOR_STATUSES, TICKET_LINK_KINDS, TICKET_STATUSES, type DatasetRow } from '@sm/shared';
import { db } from '../db.js';
import { queryAudit } from '../audit.js';
import { config } from '../config.js';
import { currentUser } from '../auth/context.js';
import { capabilities } from '../auth/permissions.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import * as scheduler from '../scheduler.js';
import * as platforms from '../platforms/service.js';
import * as datasets from '../dashboards/datasets.js';
import * as dashboards from '../dashboards/service.js';
import * as monitors from '../monitors/service.js';
import * as triggers from '../triggers/service.js';
import * as tickets from '../tickets/service.js';
import { monitorDatasetVisible } from '../monitors/datasets.js';
import { systemStatus } from '../system/routes.js';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { decodeCursor, encodeCursor, pageArray, pageRows } from '../api/v1/pagination.js';
import { RUN_STATUSES, RUN_TRIGGERS, STEP_STATUSES } from '../api/v1/schemas.js';
import { safeBaseUrl } from '../api/v1/routes.js';
import { MAX_RESULT_CHARS, SUPPORTED_VERSIONS } from './config.js';
import { gatewayTools } from './gateway.js';
import { requestTools } from './requests.js';
import { ToolError, cap, cursorArg, defineTool, idArg, isoArg, limitArg, type ToolContext, type ToolDef } from './tooling.js';
import { zodJsonSchema } from '../jsonSchema.js';

export { ToolError, type McpPrincipal, type ToolContext, type ToolDef } from './tooling.js';

const short = (s: string | null | undefined, n = 300) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : (s ?? null));
const iso = (s: string | undefined) => (s ? new Date(s).toISOString() : undefined);
const notFound = (what: string) => new ToolError(`${what} not found (or you may not see it)`);

function visibleProcessIds(): string[] {
  return db()
    .all<{ id: string }>('SELECT id FROM processes')
    .map((r) => r.id)
    .filter((id) => processes.permissionsFor(id).includes('view'));
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

function viewableMonitor(idOrKey: string) {
  try {
    return monitors.getMonitor(idOrKey);
  } catch (e) {
    if (e instanceof HttpError && (e.statusCode === 404 || e.statusCode === 403)) throw notFound(`Monitor ${idOrKey}`);
    throw e;
  }
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

const mapRun = (r: ReturnType<typeof store.getRunSummary>) => ({
  id: r.id,
  processId: r.processId,
  processName: r.processName,
  processVersion: r.processVersion,
  status: r.status,
  dryRun: r.dryRun,
  trigger: r.trigger,
  actor: r.actor,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt ?? null,
  error: short(r.error, 500),
  parentRunId: r.parentRunId ?? null,
});

const mapStep = (s: ReturnType<typeof store.getStepFull>) => ({
  id: s.id,
  key: s.key,
  parentKey: s.parentKey,
  nodeId: s.stepId,
  type: s.type,
  name: s.name,
  status: s.status,
  startedAt: s.startedAt,
  finishedAt: s.finishedAt ?? null,
  durationMs: s.durationMs ?? null,
  summary: short(s.summary, 300),
  error: short(s.error, 1000),
});

// ---------- the tools ----------

const steward: ToolDef[] = [
  defineTool({
    name: 'search_processes',
    title: 'Search processes',
    description:
      'Lists the service processes (automated procedures) you may view, ordered by name. Filter with a free-text query (id, name, description) or a tag. Returns id, name, description, tags, current version, owner, your permissions and the last run.',
    input: z
      .object({
        query: z.string().max(200).optional().describe('Case-insensitive text to look for in id, name and description'),
        tag: z.string().max(60).optional().describe('Only processes with this tag'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    handler: (a) => {
      const needle = a.query?.toLowerCase();
      const list = processes
        .listProcesses()
        .filter((p) => !a.tag || p.tags.includes(a.tag))
        .filter((p) => !needle || [p.id, p.name, p.description].some((x) => x?.toLowerCase().includes(needle)))
        .map((p) => ({
          id: p.id,
          name: p.name,
          description: short(p.description),
          tags: p.tags ?? [],
          currentVersion: p.currentVersion,
          owner: p.owner ?? null,
          permissions: p.permissions,
          lastRun: p.lastRun ?? null,
          updatedAt: p.updatedAt,
        }));
      return pageArray(list, (p) => [p.name.toLowerCase(), p.id], a, { query: a.query, tag: a.tag });
    },
  }),

  defineTool({
    name: 'get_process',
    title: 'Get a process',
    description:
      'Summary of one process definition: inputs (name, type, required), connection slots (which kind of platform it needs), the steps (node id, type, name), declared outputs and the version. Use search_processes to find the id.',
    input: z.object({ processId: idArg('Process id') }).strict(),
    handler: (a) => {
      if (!processes.permissionsFor(a.processId).includes('view')) throw notFound(`Process ${a.processId}`);
      const p = processes.getProcess(a.processId);
      const d = p.definition;
      const byType: Record<string, number> = {};
      for (const n of d.nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
      return {
        id: p.id,
        name: p.name,
        description: short(p.description, 2000),
        tags: p.tags,
        currentVersion: p.currentVersion,
        definitionHash: p.definitionHash,
        owner: p.owner ?? null,
        permissions: p.permissions,
        lastRun: p.lastRun ?? null,
        // defaults are left out: a default may be a value someone did not mean to share
        inputs: (d.inputs ?? []).map((i) => ({
          name: i.name,
          label: i.label ?? null,
          type: i.type,
          required: !!i.required,
          description: short(i.description),
          options: i.options ?? null,
        })),
        connections: (d.connections ?? []).map((c) => ({ slot: c.slot, kind: c.kind ?? null, description: short(c.description) })),
        outputs: Object.keys(d.outputs ?? {}),
        nodeCount: d.nodes.length,
        nodeTypes: byType,
        nodes: d.nodes.slice(0, 200).map((n) => ({ id: n.id, type: n.type, name: (n as { name?: string }).name ?? null })),
      };
    },
  }),

  defineTool({
    name: 'list_runs',
    title: 'List runs',
    description:
      'Runs (executions) of processes you may view, newest first. Filter by process, status (e.g. ["failed"]), trigger, dry run and start time. Use get_run for steps and errors of one run.',
    input: z
      .object({
        processId: z.string().max(200).optional().describe('Only runs of this process'),
        status: z.array(z.enum(RUN_STATUSES)).max(7).optional().describe('Only runs with one of these statuses'),
        trigger: z.array(z.enum(RUN_TRIGGERS)).max(6).optional().describe('Only runs started this way'),
        dryRun: z.boolean().optional().describe('true: only dry runs, false: only real runs'),
        from: isoArg('Started at or after (ISO 8601)'),
        to: isoArg('Started before (ISO 8601)'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    handler: (a) => {
      const filters = { processId: a.processId, status: a.status, trigger: a.trigger, dryRun: a.dryRun, from: a.from, to: a.to };
      const after = decodeCursor(a.cursor, filters);
      let ids = visibleProcessIds();
      if (a.processId) ids = ids.includes(a.processId) ? [a.processId] : [];
      const rows = store.listRunsPage({
        processIds: ids,
        status: a.status,
        trigger: a.trigger,
        dryRun: a.dryRun,
        from: iso(a.from),
        to: iso(a.to),
        after: after ? { startedAt: String(after[0]), id: String(after[1]) } : undefined,
        limit: a.limit + 1,
      });
      return pageRows(rows.map(mapRun), a.limit, (r) => [r.startedAt, r.id], filters);
    },
  }),

  defineTool({
    name: 'get_run',
    title: 'Get a run',
    description:
      'One run: status, error, inputs (secret inputs show as ***), platforms used, step journal (paginated; filter by step status, e.g. ["failed"]), checks, decisions, the first warnings/errors of the log and sub-process runs. Step inputs and outputs are left out – use get_run_step for one step.',
    input: z
      .object({
        runId: idArg('Run id'),
        stepStatus: z.array(z.enum(STEP_STATUSES)).max(6).optional().describe('Only steps with one of these statuses'),
        stepCursor: cursorArg,
        stepLimit: limitArg(200, 50),
      })
      .strict(),
    handler: (a) => {
      viewableRun(a.runId);
      const d = store.getRunDetail(a.runId);
      const filters = { id: a.runId, status: a.stepStatus };
      const after = decodeCursor(a.stepCursor, filters);
      const steps = pageRows(
        store.listStepsPage(a.runId, { afterId: after ? Number(after[0]) : undefined, limit: a.stepLimit + 1, status: a.stepStatus }).map(mapStep),
        a.stepLimit,
        (s) => [Number(s.id)],
        filters,
      );
      const problems = store.listLogsPage(a.runId, { limit: 20, level: ['warn', 'error'] });
      return {
        ...mapRun(d),
        inputs: cap(d.inputs ?? {}, { maxString: 500 }),
        platforms: Object.fromEntries(Object.entries(d.bindings ?? {}).map(([slot, b]) => [slot, { platformId: b.platformId, platformName: b.platformName }])),
        outputs: d.outputs ? cap(d.outputs, { maxString: 1000 }) : null,
        stepCounts: store.stepStatusCounts(a.runId),
        steps: steps.items,
        nextStepCursor: steps.nextCursor,
        checks: store.listChecks(a.runId).map((c) => ({ ...c, message: short(c.message, 500) })),
        decisions: d.tasks.map((t) => ({
          taskId: t.id,
          title: t.title,
          mode: t.mode,
          status: t.status,
          approved: t.decision ? t.decision.approved : null,
          decidedBy: t.decidedBy ?? null,
          decidedAt: t.decidedAt ?? null,
        })),
        problems: problems.map((l) => ({ ts: l.ts, level: l.level, stepKey: l.stepKey ?? null, message: short(l.message, 500) })),
        children: (d.children ?? []).filter((c) => processes.permissionsFor(c.processId).includes('view')),
      };
    },
  }),

  defineTool({
    name: 'get_run_step',
    title: 'Get a run step',
    description: "One entry of a run's step journal with its (redacted) input and output, both cut to a readable size. The step id comes from get_run.",
    input: z.object({ runId: idArg('Run id'), stepId: z.number().int().min(1).describe('Journal entry id (`id` of a step in get_run)') }).strict(),
    handler: (a) => {
      viewableRun(a.runId);
      let s;
      try {
        s = store.getStepFull(a.runId, a.stepId);
      } catch {
        throw notFound(`Step ${a.stepId}`);
      }
      return {
        ...mapStep(s),
        input: cap(s.input ?? null, { maxString: 4000, maxArray: 50 }),
        output: cap(s.output ?? null, { maxString: 4000, maxArray: 50 }),
      };
    },
  }),

  defineTool({
    name: 'list_monitors',
    title: 'List monitors',
    description:
      'Monitors (composed uptime checks) you may view with their current status (up, degraded, down, unknown, blocked, maintenance), uptime for 24 h / 7 d / 30 d, maintenance and acknowledgement. Filter by status, tag or text.',
    input: z
      .object({
        status: z.array(z.enum(MONITOR_STATUSES)).max(6).optional().describe('Only monitors with one of these statuses'),
        tag: z.string().max(60).optional(),
        query: z.string().max(200).optional().describe('Case-insensitive text to look for in key and name'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    handler: (a) => {
      const needle = a.query?.toLowerCase();
      const list = monitors
        .listMonitors({ templates: false })
        .filter((m) => !a.status?.length || a.status.includes(m.status))
        .filter((m) => !a.tag || m.tags.includes(a.tag))
        .filter((m) => !needle || m.key.includes(needle) || m.name.toLowerCase().includes(needle))
        .map((m) => ({
          id: m.id,
          key: m.key,
          name: m.name,
          description: short(m.description),
          tags: m.tags,
          enabled: m.enabled,
          status: m.status,
          since: m.since,
          checkCount: m.checkCount,
          counts: m.counts,
          uptime: m.uptime,
          maintenance: m.maintenance ? { startsAt: m.maintenance.startsAt, endsAt: m.maintenance.endsAt, reason: short(m.maintenance.reason) } : null,
          acknowledged: m.acknowledged ? { by: m.acknowledged.by, at: m.acknowledged.at } : null,
        }));
      return pageArray(list, (m) => [m.name.toLowerCase(), m.id], a, { status: a.status, tag: a.tag, query: a.query });
    },
  }),

  defineTool({
    name: 'get_monitor',
    title: 'Get monitor status',
    description:
      'Current status of one monitor (id or key) and each of its checks: last result message, duration, last ok time, root causes and uptime, plus the 10 most recent status changes.',
    input: z.object({ monitor: idArg('Monitor id or key') }).strict(),
    handler: (a) => {
      const m = viewableMonitor(a.monitor);
      return {
        id: m.id,
        key: m.key,
        name: m.name,
        enabled: m.enabled,
        status: m.status,
        since: m.since,
        rootCauses: m.rootCauses,
        uptime: m.uptime,
        maintenance: m.maintenance ? { startsAt: m.maintenance.startsAt, endsAt: m.maintenance.endsAt, reason: short(m.maintenance.reason) } : null,
        checks: m.checks.map((c) => ({
          checkId: c.checkId,
          name: c.name,
          type: c.type,
          critical: c.critical,
          enabled: c.enabled,
          status: c.status,
          since: c.since,
          lastCheckedAt: c.last?.ts ?? null,
          lastOkAt: c.lastOkAt,
          message: short(c.last?.message, 500),
          durationMs: c.last?.durationMs ?? null,
          causedBy: c.causedBy,
          uptime: c.uptime,
        })),
        recentChanges: monitors.listHistory(m.id, { limit: 10 }).map((h) => ({ ...h, message: short(h.message, 300) })),
      };
    },
  }),

  defineTool({
    name: 'get_monitor_history',
    title: 'Monitor history',
    description: 'Status changes of a monitor and its checks, newest first (kept for the monitor retention period). Optionally only one check.',
    input: z
      .object({
        monitor: idArg('Monitor id or key'),
        check: z.string().max(200).optional().describe('Only this check id'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    handler: (a) => {
      const m = viewableMonitor(a.monitor);
      const filters = { check: a.check, id: m.id };
      const after = decodeCursor(a.cursor, filters);
      const rows = monitors.listHistory(m.id, { checkId: a.check, limit: a.limit + 1, beforeId: after ? Number(after[0]) : undefined });
      return pageRows(
        rows.map((h) => ({ ...h, message: short(h.message, 500) })),
        a.limit,
        (h) => [Number(h.id)],
        filters,
      );
    },
  }),

  defineTool({
    name: 'list_dashboards',
    title: 'List dashboards',
    description: 'Dashboard definitions (name, description, owner) and the dataset keys each dashboard shows. Read the data with read_dataset.',
    input: z.object({ cursor: cursorArg, limit: limitArg() }).strict(),
    handler: (a) =>
      pageArray(
        dashboards.listDashboards().map((d) => ({
          id: d.id,
          name: d.name,
          description: short(d.description),
          owner: d.owner ?? null,
          updatedAt: d.updatedAt,
          datasets: dashboards.datasetsOf(d.definition),
        })),
        (d) => [d.name.toLowerCase(), d.id],
        a,
        {},
      ),
  }),

  defineTool({
    name: 'list_datasets',
    title: 'List datasets',
    description:
      'Datasets published by processes (and monitors) you may view: key, title, columns, row count, status counts, latest metric values and whether the data is stale.',
    input: z.object({ cursor: cursorArg, limit: limitArg() }).strict(),
    handler: (a) => {
      const visible = new Set(visibleProcessIds());
      const list = datasets
        .listDatasets()
        .filter((d) => monitorDatasetVisible(d.processId) ?? visible.has(d.processId))
        .map((d) => ({
          key: d.key,
          title: d.title,
          processId: d.processId,
          processName: d.processName,
          updatedAt: d.updatedAt,
          rowCount: d.rowCount,
          columns: d.columns,
          statusCounts: d.statusCounts,
          metrics: d.metrics,
          stale: d.stale,
        }));
      return pageArray(list, (d) => [d.key], a, {});
    },
  }),

  defineTool({
    name: 'read_dataset',
    title: 'Read a dataset',
    description:
      'Rows of a dataset snapshot in published order (each row has a `_status`: good, warning, serious, critical, unknown). Filter by status. If the dataset is re-published while you page, start again without a cursor.',
    input: z
      .object({
        key: idArg('Dataset key, e.g. iem.devices'),
        status: z.array(z.enum(DATASET_STATUSES)).max(5).optional().describe('Only rows with one of these statuses'),
        cursor: cursorArg,
        limit: limitArg(100, 25),
      })
      .strict(),
    handler: (a) => {
      const meta = visibleDataset(a.key);
      const filters = { key: meta.key, status: a.status };
      const after = decodeCursor(a.cursor, filters);
      if (after && after[1] !== meta.updatedAt) throw new ToolError('The dataset was re-published since the first page – start again without a cursor');
      const rows: DatasetRow[] = datasets.getDataset(meta.key).rows.filter((r) => !a.status?.length || a.status.includes(r._status ?? 'unknown'));
      const offset = after ? Number(after[0]) : 0;
      const items = rows.slice(offset, offset + a.limit).map((r) => cap(r, { maxString: 500, maxArray: 50, maxDepth: 4 }));
      return {
        dataset: { key: meta.key, title: meta.title, updatedAt: meta.updatedAt, rowCount: meta.rowCount, columns: meta.columns, stale: meta.stale },
        items,
        nextCursor: offset + a.limit < rows.length ? encodeCursor([offset + a.limit, meta.updatedAt], filters) : null,
      };
    },
  }),

  defineTool({
    name: 'list_platforms',
    title: 'List platforms',
    description:
      'Connected platforms you have rights on – metadata only (name, kind, environment, base URL, auth type, your permissions, whether the read-only MCP gateway is on). Credentials and variables are never returned.',
    input: z.object({ kind: z.string().max(100).optional(), environment: z.string().max(100).optional() }).strict(),
    handler: (a) => {
      const items = platforms
        .listPlatforms()
        .filter((p) => p.permissions.length > 0)
        .filter((p) => !a.kind || p.kind === a.kind)
        .filter((p) => !a.environment || p.environment === a.environment)
        .slice(0, 200)
        .map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          environment: p.environment,
          description: short(p.description),
          baseUrl: safeBaseUrl(p.baseUrl ?? ''),
          authType: p.config?.auth?.type ?? 'none',
          permissions: p.permissions,
          mcpGateway: !!p.config.mcpGateway?.enabled,
        }));
      return { items };
    },
  }),

  defineTool({
    name: 'list_schedules',
    title: 'List schedules',
    description: 'Cron schedules of processes you may view: cron expression, time zone, enabled, dry run, next and last run.',
    input: z.object({ processId: z.string().max(200).optional(), enabled: z.boolean().optional(), cursor: cursorArg, limit: limitArg() }).strict(),
    handler: (a) => {
      const list = scheduler
        .listSchedules()
        .filter((s) => !a.processId || s.processId === a.processId)
        .filter((s) => a.enabled === undefined || s.enabled === a.enabled)
        .map((s) => ({
          id: s.id,
          name: s.name,
          processId: s.processId,
          processName: s.processName ?? '',
          cron: s.cron,
          timezone: s.timezone ?? null,
          enabled: s.enabled,
          dryRun: s.dryRun,
          owner: s.owner ?? null,
          nextRunAt: s.nextRunAt ?? null,
          lastRunAt: s.lastRunAt ?? null,
          lastRunId: s.lastRunId ?? null,
          lastRunStatus: s.lastRunStatus ?? null,
        }));
      return pageArray(list, (s) => [s.name.toLowerCase(), s.id], a, { processId: a.processId, enabled: a.enabled });
    },
  }),

  defineTool({
    name: 'list_triggers',
    title: 'List webhook triggers',
    description:
      'Webhook triggers of processes you may view: name, process, enabled, dry run, owner, last firing and its result, counts of accepted and rejected calls. Secrets are never returned.',
    input: z.object({ processId: z.string().max(200).optional(), enabled: z.boolean().optional(), cursor: cursorArg, limit: limitArg() }).strict(),
    handler: (a) => {
      const list = triggers
        .listTriggers()
        .filter((t) => !a.processId || t.processId === a.processId)
        .filter((t) => a.enabled === undefined || t.enabled === a.enabled)
        .map((t) => ({
          id: t.id,
          name: t.name,
          description: short(t.description),
          processId: t.processId,
          processName: t.processName ?? '',
          enabled: t.enabled,
          dryRun: t.dryRun,
          owner: t.owner,
          lastFiredAt: t.lastFiredAt,
          lastRunId: t.lastRunId,
          lastRunStatus: t.lastRunStatus,
          lastResult: short(t.lastResult),
          fireCount: t.fireCount,
          rejectedCount: t.rejectedCount,
        }));
      return pageArray(list, (t) => [t.name.toLowerCase(), t.id], a, { processId: a.processId, enabled: a.enabled });
    },
  }),

  defineTool({
    name: 'list_ticket_references',
    title: 'List ticket references',
    description:
      'Tickets in other systems that the service team documents in Steward: ServiceNow incidents reported by users and tickets opened with vendors. Source, number, link, title, vendor, status (open, waitingVendor, waitingUs, resolved, closed), responsible people, age, last check and the affected services, platforms, credentials and records (names only for items you may see). Default: open tickets only.',
    input: z
      .object({
        state: z.enum(['open', 'closed', 'all']).default('open').describe('open: open, waitingVendor, waitingUs; closed: resolved, closed'),
        status: z.array(z.enum(TICKET_STATUSES)).max(5).optional().describe('Only these statuses (overrides state)'),
        source: z.array(z.string().max(40)).max(30).optional().describe('Ticket source keys, e.g. servicenow-incident, vendor'),
        vendor: z.string().max(120).optional(),
        affectedKind: z.enum(TICKET_LINK_KINDS).optional().describe('With affectedId: only tickets that name this item as affected'),
        affectedId: z.string().max(200).optional(),
        query: z.string().max(200).optional().describe('Case-insensitive text in number, title, vendor and note'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    handler: (a) => {
      if (!!a.affectedKind !== !!a.affectedId) throw new ToolError('Give affectedKind and affectedId together');
      const list = tickets
        .listTickets({
          state: a.state,
          status: a.status,
          source: a.source,
          vendor: a.vendor,
          link: a.affectedKind ? `${a.affectedKind}:${a.affectedId}` : undefined,
          q: a.query,
        })
        .map((t) => ({
          id: t.id,
          source: t.source,
          sourceLabel: t.sourceLabel,
          externalNumber: t.externalNumber,
          externalUrl: t.externalUrl,
          title: t.title,
          note: short(t.note),
          vendor: t.vendor,
          status: t.status,
          responsible: t.responsible,
          openedAt: t.openedAt,
          resolvedAt: t.resolvedAt,
          lastCheckedAt: t.lastCheckedAt,
          ageDays: t.ageDays,
          affected: t.links.filter((l) => l.visible).map((l) => ({ kind: l.kind, id: l.targetId, name: l.label })),
        }));
      return pageArray(list, (t) => [-Date.parse(t.openedAt), t.id], a, {
        state: a.state,
        status: a.status,
        source: a.source,
        vendor: a.vendor,
        affectedKind: a.affectedKind,
        affectedId: a.affectedId,
        query: a.query,
      });
    },
  }),

  defineTool({
    name: 'search_audit_log',
    title: 'Search the audit log',
    description:
      'Entries of the tamper-evident audit log, newest first (auditors and administrators only). Filter by action (e.g. "run.started"), actor, entity, run, free text in the summary and time range.',
    input: z
      .object({
        action: z.string().max(100).optional(),
        actor: z.string().max(200).optional().describe('Exact user name (or "system")'),
        entityType: z.string().max(60).optional(),
        entityId: z.string().max(200).optional(),
        runId: z.string().max(200).optional(),
        query: z.string().max(200).optional().describe('Case-insensitive text in the summary'),
        from: isoArg('At or after (ISO 8601)'),
        to: isoArg('Before (ISO 8601)'),
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    visible: () => capabilities(currentUser()).viewAudit,
    handler: (a) => {
      if (!capabilities(currentUser()).viewAudit) throw new ToolError('Only auditors and administrators may read the audit log');
      const { cursor: _c, limit: _l, ...filters } = a;
      const after = decodeCursor(a.cursor, filters);
      const rows = queryAudit({
        action: a.action,
        actor: a.actor,
        entityType: a.entityType,
        entityId: a.entityId,
        runId: a.runId,
        q: a.query,
        from: iso(a.from),
        to: iso(a.to),
        beforeSeq: after ? Number(after[0]) : undefined,
        limit: a.limit + 1,
      });
      return pageRows(
        rows.map((e) => ({
          seq: e.seq,
          ts: e.ts,
          actor: e.actor,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId ?? null,
          runId: e.runId ?? null,
          summary: short(e.summary, 500),
          details: e.details ? cap(e.details, { maxString: 300, maxArray: 30, maxDepth: 4 }) : null,
        })),
        a.limit,
        (e) => [e.seq],
        filters,
      );
    },
  }),

  defineTool({
    name: 'get_system_status',
    title: 'System status',
    description:
      'Version of Steward, the MCP protocol versions it speaks, who you are (user, roles, what you may do) and – for administrators and auditors – the health of the server (vault, database, scheduler, monitors).',
    input: z.object({}).strict(),
    handler: (_a, ctx) => {
      const caps = capabilities(currentUser());
      const u = ctx.principal.user;
      return {
        server: { name: 'Steward', version: config.version, time: new Date().toISOString() },
        mcp: { protocolVersions: SUPPORTED_VERSIONS, token: { id: ctx.principal.tokenId, name: ctx.principal.tokenName } },
        you: { username: u.username, displayName: u.displayName, roles: u.roles, teams: u.teams, capabilities: caps },
        // the limited view (no file paths, host names or connection details), also for administrators
        ...(caps.viewAudit ? { status: systemStatus(false) } : {}),
      };
    },
  }),
];

export function allTools(): ToolDef[] {
  return [...steward, ...gatewayTools, ...requestTools];
}

export function findTool(name: string): ToolDef | undefined {
  return allTools().find((t) => t.name === name);
}

const schemaCache = new Map<string, Record<string, unknown>>();
function inputSchema(t: ToolDef): Record<string, unknown> {
  let s = schemaCache.get(t.name);
  if (!s) {
    s = zodJsonSchema(t.input, 'input'); // MCP's default dialect is JSON Schema 2020-12
    schemaCache.set(t.name, s);
  }
  return s;
}

/** The tool list for this token owner, in a fixed order (stable for client-side caching). */
export function listTools(ctx: ToolContext): Record<string, unknown>[] {
  return allTools()
    .filter((t) => !t.visible || t.visible(ctx))
    .map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: inputSchema(t),
      annotations: { title: t.title, readOnlyHint: !t.asks, destructiveHint: false, idempotentHint: !t.asks, openWorldHint: !!t.gateway },
    }));
}

export interface ToolOutcome {
  result: Record<string, unknown>;
  ok: boolean;
  /** For the operational log: error text of a failed call */
  error?: string;
}

const errorResult = (message: string): ToolOutcome => ({ ok: false, error: message, result: { content: [{ type: 'text', text: message }], isError: true } });

/**
 * Runs a tool and wraps the outcome as a CallToolResult. Tool output is data, not instructions:
 * it is returned as JSON (structuredContent and the same JSON as text), never as prose.
 */
export async function callTool(t: ToolDef, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = t.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ')}`.slice(0, 2000));
  }
  let value: unknown;
  try {
    value = await t.handler(parsed.data, ctx);
  } catch (e) {
    if (e instanceof ToolError) return errorResult(e.message);
    if (e instanceof ProblemError) return errorResult(e.init.detail ?? e.message);
    if (e instanceof HttpError && e.statusCode < 500) return errorResult(e.message);
    throw e;
  }
  let text = JSON.stringify(value);
  if (text.length > MAX_RESULT_CHARS) {
    value = cap(value, { maxString: 500, maxArray: 50, maxDepth: 6 });
    text = JSON.stringify(value);
    if (text.length > MAX_RESULT_CHARS) return errorResult('The result is too large – ask for fewer items (a smaller limit) or narrow the filters');
  }
  return { ok: true, result: { content: [{ type: 'text', text }], structuredContent: value } };
}
