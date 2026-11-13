/**
 * Runs and tasks as the signed-in user may see them: the checks every caller shares – the internal API's routes, the
 * command layer (commands.ts), decisions from Microsoft Teams, the public API and MCP. Here and not in the routes, so
 * the engine and the services need not import a route module (docs/ARCHITECTURE.md, import rules).
 */
import type { RunSummary, TaskRecord } from '@sm/shared';
import { HttpError } from '../util.js';
import * as processes from '../processes/service.js';
import { currentUser } from '../auth/context.js';
import { decisionCheck, require } from '../auth/permissions.js';
import * as store from './store.js';
import { manualForReader } from './manual.js';
import { seesDebugRun, seesRun } from './visibility.js';

/**
 * A run the current user may see (`view` on its process, debug runs per ADR 0010) with `perm` on its process. A hidden
 * run answers 404 like a missing one; `notFoundCode` adds the RUN_NOT_FOUND code to that answer (the report routes).
 */
export function requireRun(runId: string, perm: 'view' | 'run', what: string, opts: { notFoundCode?: boolean } = {}) {
  const r = store.runRow(runId);
  const perms = processes.permissionsFor(r.process_id);
  if (!seesRun(r, perms))
    throw opts.notFoundCode ? new HttpError(404, `Run ${runId} not found`, 'RUN_NOT_FOUND', { id: runId }) : new HttpError(404, `Run ${runId} not found`);
  require(perms, perm, what);
  return r;
}

/** A run the current user may see (see requireRun). */
export const requireRunView = (runId: string, opts: { notFoundCode?: boolean } = {}) => requireRun(runId, 'view', 'view this run', opts);

/**
 * A run for the public API and MCP: undefined when it is missing, of a process the current user may not view, or a
 * debug run (ADR 0010: those stay in the app). Each caller answers "not found" in its own form.
 */
export function readableRun(id: string): store.RunRow | undefined {
  let r: store.RunRow;
  try {
    r = store.runRow(id);
  } catch {
    return undefined;
  }
  return r.debug || !processes.permissionsFor(r.process_id).includes('view') ? undefined : r;
}

export function withDecisionRights(tasks: TaskRecord[]): TaskRecord[] {
  const permCache = new Map<string, ReturnType<typeof processes.permissionsFor>>();
  return tasks.map((t) => {
    const pid = t.processId ?? store.taskProcessId(t.id);
    if (!permCache.has(pid)) permCache.set(pid, processes.permissionsFor(pid));
    const check = decisionCheck(currentUser(), t, { actor: t.startedBy ?? '' }, permCache.get(pid)!);
    return {
      ...t,
      ...(t.manual ? { manual: manualForReader(t.manual, currentUser()) } : {}),
      canDecide: check.ok,
      cannotDecideReason: check.reason,
      cannotDecideCode: check.code,
      cannotDecideParams: check.params,
    };
  });
}

/** One task as the current user sees it (with its decision rights), or undefined when it is missing or hidden. */
export function visibleTask(id: string): TaskRecord | undefined {
  let t: TaskRecord;
  try {
    t = store.getTask(id);
  } catch {
    return undefined; // not found
  }
  const pid = t.processId ?? store.taskProcessId(t.id);
  if (!processes.permissionsFor(pid).includes('view')) return undefined;
  return withDecisionRights([t])[0];
}

export function visibleTasks(status?: string): TaskRecord[] {
  const visible = processes.visibleProcessIds();
  return withDecisionRights(store.listTasks({ status }).filter((t) => visible.has(t.processId ?? store.taskProcessId(t.id))));
}

/** The `before` cursor of a run list: continue after this run. */
export const runCursor = (r: Pick<RunSummary, 'startedAt' | 'id'>): string => `${r.startedAt},${r.id}`;

/**
 * Runs the user may see, newest first. Runs of hidden processes are left out before the limit applies:
 * further batches are read (older than the last one) until the page is full, so a short page means
 * "no more runs" and `before` = `<startedAt>,<id>` of the oldest run continues the list.
 */
export function visibleRuns(f: Parameters<typeof store.listRuns>[0]): RunSummary[] {
  const visible = processes.visibleProcessIds();
  const user = currentUser();
  const perms = new Map<string, string[]>();
  const permsOf = (pid: string) => perms.get(pid) ?? (perms.set(pid, processes.permissionsFor(pid)), perms.get(pid)!);
  // debug runs (the Debug filter): only those this user may see
  const sees = (r: RunSummary) => visible.has(r.processId) && (!r.debug || seesDebugRun(user, r.actor, permsOf(r.processId)));
  const limit = Math.min(f.limit ?? 100, 1000);
  const batch = Math.min(limit * 3, 1000);
  const out: RunSummary[] = [];
  let before = f.before;
  let after = f.after;
  // the newest-first list continues by start and id, a sorted one (U15) after the id of the last run read
  const sorted = !!f.sort && (f.sort.key !== 'started' || f.sort.dir !== 'desc');
  for (let i = 0; i < 20 && out.length < limit; i++) {
    const rows = store.listRuns({ ...f, before, after, limit: batch });
    out.push(...rows.filter(sees));
    if (rows.length < batch) break;
    if (sorted) after = rows[rows.length - 1]!.id;
    else before = runCursor(rows[rows.length - 1]!);
  }
  return out.slice(0, limit);
}
