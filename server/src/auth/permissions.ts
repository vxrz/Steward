import {
  PLATFORM_PERMISSIONS,
  PROCESS_PERMISSIONS,
  type AclEntry,
  type Capabilities,
  type PlatformPermission,
  type ProcessPermission,
  type Role,
} from '@sm/shared';
import { HttpError, type ErrorParams } from '../util.js';
import type { AuthUser } from './context.js';

/**
 * Access model
 * - Global roles give default rights on every process/platform.
 * - A process or platform with an access list (ACL) is restricted: only the
 *   listed users/teams/roles get the listed rights (plus admins and the owner).
 * - Auditors can always read everything; nobody but admins/owners can change access.
 */

const DEFAULT_PROCESS: Record<Role, ProcessPermission[]> = {
  admin: [...PROCESS_PERMISSIONS],
  designer: ['view', 'edit', 'run'],
  operator: ['view', 'run'],
  approver: ['view', 'approve'],
  auditor: ['view'],
  viewer: ['view'],
};

const DEFAULT_PLATFORM: Record<Role, PlatformPermission[]> = {
  admin: [...PLATFORM_PERMISSIONS],
  designer: ['use'],
  operator: ['use'],
  approver: [],
  auditor: [],
  viewer: [],
};

export function subjectsOf(u: AuthUser): Set<string> {
  return new Set([`user:${u.username.toLowerCase()}`, ...u.teams.map((t) => `team:${t.toLowerCase()}`), ...u.roles.map((r) => `role:${r}`)]);
}

export function matches(u: AuthUser, subject: string): boolean {
  return subjectsOf(u).has(subject.trim().toLowerCase());
}

export const isAdmin = (u: AuthUser | null): boolean => !!u?.roles.includes('admin');

export function processPermissions(u: AuthUser | null, p: { owner?: string | null; acl: AclEntry<ProcessPermission>[] }): ProcessPermission[] {
  if (!u) return [];
  if (isAdmin(u)) return [...PROCESS_PERMISSIONS];
  if (p.owner && p.owner.toLowerCase() === u.username.toLowerCase()) return [...PROCESS_PERMISSIONS];
  const out = new Set<ProcessPermission>();
  if (u.roles.includes('auditor')) out.add('view');
  if (!p.acl.length) {
    for (const r of u.roles) DEFAULT_PROCESS[r]?.forEach((x) => out.add(x));
  } else {
    for (const e of p.acl) if (matches(u, e.subject)) e.permissions.forEach((x) => out.add(x));
  }
  if (out.size) out.add('view');
  return PROCESS_PERMISSIONS.filter((x) => out.has(x));
}

export function platformPermissions(u: AuthUser | null, p: { acl: AclEntry<PlatformPermission>[] }): PlatformPermission[] {
  if (!u) return [];
  if (isAdmin(u)) return [...PLATFORM_PERMISSIONS];
  const out = new Set<PlatformPermission>();
  if (!p.acl.length) {
    for (const r of u.roles) DEFAULT_PLATFORM[r]?.forEach((x) => out.add(x));
  } else {
    for (const e of p.acl) if (matches(u, e.subject)) e.permissions.forEach((x) => out.add(x));
  }
  if (out.has('manage')) out.add('use');
  return PLATFORM_PERMISSIONS.filter((x) => out.has(x));
}

export function capabilities(u: AuthUser | null): Capabilities {
  const has = (...r: Role[]) => !!u && u.roles.some((x) => r.includes(x));
  return {
    manageUsers: has('admin'),
    manageSettings: has('admin'),
    viewAudit: has('admin', 'auditor'),
    createProcesses: has('admin', 'designer'),
    createPlatforms: has('admin'),
    createMonitors: has('admin', 'designer'),
  };
}

export function requireCapability(u: AuthUser | null, cap: keyof Capabilities, what: string): void {
  if (!capabilities(u)[cap]) throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN');
}

/** 403 FORBIDDEN unless `needed` is among `perms`; the web UI says which right is missing (errors:codes.FORBIDDEN_<needed>). */
export function require<P extends string>(perms: P[], needed: P, what: string): void {
  if (!perms.includes(needed)) throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN', { context: `right_${needed}` });
}

export function cleanAcl<P extends string>(acl: unknown, allowed: readonly P[]): AclEntry<P>[] {
  if (!Array.isArray(acl)) throw new HttpError(400, 'Access list must be an array', 'ACL_INVALID');
  return acl.map((e) => {
    const subject = String((e as AclEntry).subject ?? '')
      .trim()
      .toLowerCase();
    if (!/^(user|team|role):.+/.test(subject))
      throw new HttpError(400, `Invalid subject "${subject}" – use user:<name>, team:<name> or role:<role>`, 'ACL_SUBJECT_INVALID', { subject });
    const permissions = [...new Set(((e as AclEntry).permissions ?? []).filter((p): p is P => (allowed as readonly string[]).includes(p)))];
    return { subject, permissions };
  });
}

/** Whether a user may decide an open task. */
export function decisionCheck(
  u: AuthUser | null,
  task: { assignees: string[]; fourEyes: boolean; status: string },
  run: { actor: string },
  perms: ProcessPermission[],
): { ok: boolean; reason?: string; code?: string; params?: ErrorParams } {
  if (!u) return { ok: false, reason: 'Not signed in', code: 'NOT_SIGNED_IN' };
  if (task.status !== 'open') return { ok: false, reason: `Task is ${task.status}`, code: 'TASK_CLOSED' };
  if (task.fourEyes && run.actor.toLowerCase() === u.username.toLowerCase()) {
    return { ok: false, reason: 'Four-eyes principle: someone other than the person who started the run must decide', code: 'FOUR_EYES_RUN' };
  }
  if (task.assignees.length) {
    if (task.assignees.some((s) => matches(u, s)) || isAdmin(u)) return { ok: true };
    return { ok: false, reason: `Assigned to ${task.assignees.join(', ')}`, code: 'TASK_ASSIGNED', params: { assignees: task.assignees } };
  }
  if (perms.includes('approve') || perms.includes('run')) return { ok: true };
  return { ok: false, reason: 'You need run or approve rights on this process', code: 'TASK_RIGHTS' };
}
