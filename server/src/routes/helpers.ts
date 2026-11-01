/** Permission and visibility helpers shared by the route files. */
import type { RunSummary, TaskRecord } from '@sm/shared';
import { HttpError, parseJson } from '../util.js';
import { db } from '../db.js';
import * as platforms from '../platforms/service.js';
import * as processes from '../processes/service.js';
import * as store from '../engine/store.js';
import { manualForReader } from '../engine/manual.js';
import { currentUser } from '../auth/context.js';
import { decisionCheck, processPermissions, require } from '../auth/permissions.js';

// ---------- helpers ----------

export function requireRun(runId: string, perm: 'view' | 'run', what: string) {
  const r = store.runRow(runId);
  const perms = processes.permissionsFor(r.process_id);
  if (!perms.includes('view')) throw new HttpError(404, `Run ${runId} not found`);
  require(perms, perm, what);
  return r;
}

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

export function visibleTasks(status?: string): TaskRecord[] {
  const visible = visibleProcessIds();
  return withDecisionRights(store.listTasks({ status }).filter((t) => visible.has(t.processId ?? store.taskProcessId(t.id))));
}

/**
 * Runs the user may see, newest first. Runs of hidden processes are left out before the limit applies:
 * further batches are read (older than the last one) until the page is full, so a short page means
 * "no more runs" and `before` = the oldest run's start continues the list.
 */
export function visibleRuns(f: Parameters<typeof store.listRuns>[0]): RunSummary[] {
  const visible = visibleProcessIds();
  const limit = Math.min(f.limit ?? 100, 1000);
  const batch = Math.min(limit * 3, 1000);
  const out: RunSummary[] = [];
  let before = f.before;
  for (let i = 0; i < 20 && out.length < limit; i++) {
    const rows = store.listRuns({ ...f, before, limit: batch });
    out.push(...rows.filter((r) => visible.has(r.processId)));
    if (rows.length < batch) break;
    before = rows[rows.length - 1]!.startedAt;
  }
  return out.slice(0, limit);
}
