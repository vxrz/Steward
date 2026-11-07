import { currentUser, type AuthUser } from '../auth/context.js';
import { sameIdentity } from '../auth/aliases.js';
import { isAdmin } from '../auth/permissions.js';

/**
 * Debug runs (ADR 0010) are a workbench, not a team record: only their starter, the process's managers, administrators
 * and auditors see them – everywhere (run pages, inspection, the expression assistant, reports, links). Everyone else
 * gets "not found", as for a hidden process.
 */
export function seesDebugRun(u: AuthUser | null, actor: string, perms: readonly string[]): boolean {
  return !!u && (sameIdentity(actor, u) || perms.includes('manage') || isAdmin(u) || u.roles.includes('auditor'));
}

/** Whether the signed-in user may see this run: `view` on its process, and for a debug run the rule above. */
export function seesRun(r: { actor: string; debug?: string | null }, perms: readonly string[]): boolean {
  return perms.includes('view') && (!r.debug || seesDebugRun(currentUser(), r.actor, perms));
}
