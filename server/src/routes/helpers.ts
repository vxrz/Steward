/** Permission and visibility helpers shared by the route files. */
import type { ProcessPermission } from '@sm/shared';
import { HttpError } from '../util.js';
import * as platforms from '../platforms/service.js';
import * as processes from '../processes/service.js';
import { require } from '../auth/permissions.js';

// ---------- helpers ----------

export { seesDebugRun } from '../engine/visibility.js';
// runs and tasks as the user may see them: in the engine, which the command layer and Teams decisions share
export { requireRun, requireRunView, runCursor, visibleRuns, visibleTask, visibleTasks, withDecisionRights } from '../engine/run-access.js';
export { visibleProcessIds } from '../processes/service.js';

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

export function requirePlatform(id: string, perm: 'use' | 'manage', what: string) {
  const p = platforms.getPlatform(id);
  require(p.permissions, perm, what);
  return p;
}
