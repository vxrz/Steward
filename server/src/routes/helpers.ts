/** Permission and visibility helpers shared by the route files. */
import type { ProcessPermission, RunSummary, TaskRecord } from '@sm/shared';
import { HttpError, parseJson } from '../util.js';
import { db } from '../db.js';
import * as platforms from '../platforms/service.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import { manualForReader } from '../engine/manual.js';
import { seesDebugRun, seesRun } from '../engine/visibility.js';
import { currentUser } from '../auth/context.js';
import { decisionCheck, processPermissions, require } from '../auth/permissions.js';

// ---------- helpers ----------

export { seesDebugRun } from '../engine/visibility.js';

/**
 * A process the current user may see (404 otherwise, as for a missing one) and has one of `needed` on (403): its
 * rights. `forbiddenCode: false` answers the 403 without the FORBIDDEN code and its parameters, as the expression and
 * inspection routes did before this helper was shared (routes/engine-extras.ts).
 */
export function requireProcess(
  processId: string,
  needed: ProcessPermission | readonly ProcessPermission[],
  what: string,
  opts: { forbiddenCode?: boolean } = {},
): ProcessPermission[] {
  const perms = processes.permissionsFor(processId);
  if (!perms.includes('view')) throw new HttpError(404, `Process ${processId} not found`);
  const any = typeof needed === 'string' ? [needed] : needed;
  if (any.some((p) => perms.includes(p))) return perms;
  if (opts.forbiddenCode === false) throw new HttpError(403, `You are not allowed to ${what}`);
  require(perms, any[0]!, what); // throws: FORBIDDEN, with the (first) right as its context
  return perms;
}

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

export function requirePlatform(id: string, perm: 'use' | 'manage', what: string) {
  const p = platforms.getPlatform(id);
  require(p.permissions, perm, what);
  return p;
}

/** Processes the current user may view (one query, permissions evaluated in memory). */
export const visibleProcessIds = (): Set<string> => {
  const user = currentUser();
  return new Set(
    db()
      .all<{ id: string; owner: string | null; acl: string }>('SELECT id, owner, acl FROM processes')
      .filter((r) => processPermissions(user, { id: r.id, owner: r.owner, acl: parseJson(r.acl, []) }).includes('view'))
      .map((r) => r.id),
  );
};

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
  const visible = visibleProcessIds();
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
  const visible = visibleProcessIds();
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
