import {
  PLATFORM_PERMISSIONS,
  PROCESS_PERMISSIONS,
  type AclEntry,
  type Capabilities,
  type PlatformPermission,
  type ProcessPermission,
  type Role,
  moduleRoleAtLeast,
} from '@sm/shared';
import { HttpError, type ErrorParams } from '../util.js';
import type { AuthUser } from './context.js';
import { aliasSubjects, sameIdentity } from './aliases.js';
import { fourEyesRequired } from './assurance-policy.js';
import { memberships, platformAccess, processAccess } from './policy.js';
import { moduleRoleOf } from '../modules/grants.js';

/**
 * Access model
 * - Global roles give default rights on every process/platform.
 * - A process or platform with an access list (ACL) is restricted: only the
 *   listed users/teams/roles get the listed rights (plus admins and the owner).
 * - Auditors can always read everything; nobody but admins/owners can change access.
 */

export const DEFAULT_PROCESS: Record<Role, ProcessPermission[]> = {
  admin: [...PROCESS_PERMISSIONS],
  designer: ['view', 'edit', 'run'],
  operator: ['view', 'run'],
  approver: ['view', 'approve'],
  auditor: ['view'],
  viewer: ['view'],
  status: [],
  plant: [],
};

export const DEFAULT_PLATFORM: Record<Role, PlatformPermission[]> = {
  admin: [...PLATFORM_PERMISSIONS],
  designer: ['use'],
  operator: ['use'],
  approver: [],
  auditor: [],
  viewer: [],
  status: [],
  plant: [],
};

export function subjectsOf(u: AuthUser): Set<string> {
  return new Set([
    `user:${u.username.toLowerCase()}`,
    ...u.teams.map((t) => `team:${t.toLowerCase()}`),
    ...u.roles.map((r) => `role:${r}`),
    // former names from an imported migration package (aliases.ts)
    ...aliasSubjects(u),
    ...formerRoleSubjects(u),
  ]);
}

/** Per user object (a request): whether the former role "plant" still names them. */
const formerRoles = new WeakMap<AuthUser, string[]>();

/**
 * The former instance role "plant" (ADR 0034 part 5) became the plant registry's contributor grant: entries of access
 * lists and shares that name `role:plant` still name whoever is granted contributor or more there (directly, through a
 * team or single sign-on) – so nobody lost what such an entry gave them. A manager role that only comes from core roles
 * (designers) is not the former role.
 */
function formerRoleSubjects(u: AuthUser): string[] {
  if (u.roles.includes('plant')) return [];
  let out = formerRoles.get(u);
  if (!out) {
    out = moduleRoleAtLeast(moduleRoleOf(u, 'plant').granted, 'contributor') ? ['role:plant'] : [];
    formerRoles.set(u, out);
  }
  return out;
}

export function matches(u: AuthUser, subject: string): boolean {
  return subjectsOf(u).has(subject.trim().toLowerCase());
}

export const isAdmin = (u: AuthUser | null): boolean => !!u?.roles.includes('admin');

/** The rights on a process (auth/policy.ts decides, with owning teams, #131). */
export function processPermissions(u: AuthUser | null, p: { id: string; owner?: string | null; acl: AclEntry<ProcessPermission>[] }): ProcessPermission[] {
  return processAccess(u, p).permissions;
}

/** The rights on a platform (auth/policy.ts decides, with owning teams, #131). */
export function platformPermissions(u: AuthUser | null, p: { id: string; acl: AclEntry<PlatformPermission>[] }): PlatformPermission[] {
  return platformAccess(u, p).permissions;
}

/** Whether `u` has any of `roles` – the one role check (also exported by auth/access.ts). */
// eslint-disable-next-line no-restricted-syntax -- the definition the rule points to
export const hasRole = (u: AuthUser | null, roles: readonly string[]): boolean => !!u && u.roles.some((r) => roles.includes(r));

export function capabilities(u: AuthUser | null): Capabilities {
  const has = (...r: Role[]) => hasRole(u, r);
  return {
    manageUsers: has('admin'),
    manageSettings: has('admin'),
    viewAudit: has('admin', 'auditor'),
    createProcesses: has('admin', 'designer'),
    createPlatforms: has('admin'),
    createMonitors: has('admin', 'designer'),
    exportEvidence: has('admin', 'designer', 'operator', 'approver', 'auditor'),
  };
}

/** Roles whose people work with schedules and triggers (create, run or audit them); viewers and approvers do not. */
const AUTOMATION_ROLES: Role[] = ['admin', 'designer', 'operator', 'auditor'];

/** Whether the sidebar shows Schedules and Triggers: an automation role in the instance or in one of the user's teams. */
export function viewsAutomation(u: AuthUser | null): boolean {
  if (!u) return false;
  return [...u.roles, ...[...memberships(u).values()].flatMap((m) => m.roles)].some((r) => AUTOMATION_ROLES.includes(r));
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
  task: {
    assignees: string[];
    fourEyes: boolean;
    status: string;
    manual?: ManualForCheck;
    /** A run's start approval (0.14.0, ADR 0009 step 4): who asked for it */
    startApproval?: { requesters: string[] };
  },
  run: { actor: string },
  perms: ProcessPermission[],
): { ok: boolean; reason?: string; code?: string; params?: ErrorParams } {
  if (!u) return { ok: false, reason: 'Not signed in', code: 'NOT_SIGNED_IN' };
  if (task.status !== 'open') return { ok: false, reason: `Task is ${task.status}`, code: 'TASK_CLOSED' };
  if (task.manual?.stage === 'verify') return verificationCheck(u, task.manual, run, perms);
  // the start approval of a privileged run: always a second person – never the starter, nor the owner of the schedule or
  // trigger that started it (by identity) – with the approve right on the process
  if (task.startApproval) {
    if ([run.actor, ...task.startApproval.requesters].some((n) => sameIdentity(n, u)))
      return {
        ok: false,
        reason: 'A second person approves the start of this run – not the person who started it, nor the owner of its schedule or trigger',
        code: 'FOUR_EYES_START',
      };
    if (perms.includes('approve')) return { ok: true };
    return { ok: false, reason: 'You need the approve right on this process to approve its start', code: 'START_APPROVAL_RIGHTS' };
  }
  // the step's own switch, or the assurance policy for every approval (run.decide, auth/assurance-policy.ts)
  if (fourEyesRequired('run.decide', task.fourEyes) && sameIdentity(run.actor, u)) {
    return { ok: false, reason: 'Four-eyes principle: someone other than the person who started the run must decide', code: 'FOUR_EYES_RUN' };
  }
  if (task.assignees.length) {
    if (task.assignees.some((s) => matches(u, s)) || isAdmin(u)) return { ok: true };
    return { ok: false, reason: `Assigned to ${task.assignees.join(', ')}`, code: 'TASK_ASSIGNED', params: { assignees: task.assignees } };
  }
  if (perms.includes('approve') || perms.includes('run')) return { ok: true };
  return { ok: false, reason: 'You need run or approve rights on this process', code: 'TASK_RIGHTS' };
}

/** What the verification rules need to know about a manual step. */
interface ManualForCheck {
  stage: string;
  round: number;
  spec: { verification: { notRunStarter: boolean; verifiers: string[] } };
  submission: { completedBy: string; evidence?: { uploadedBy: string }[] } | null;
  evidence: { uploadedBy: string; round: number }[];
}

/**
 * Whether a user may verify a manual step (second person, maker–checker). Never the person who completed it or added
 * evidence to it (also not under a former name from a moved instance), optionally not the run starter; a verifier list is strict (no
 * administrator override: the list names who checks this work).
 */
export function verificationCheck(
  u: AuthUser,
  m: ManualForCheck,
  run: { actor: string },
  perms: ProcessPermission[],
): { ok: boolean; reason?: string; code?: string; params?: ErrorParams } {
  if (!perms.includes('view')) return { ok: false, reason: 'You may not see this run', code: 'TASK_RIGHTS' };
  // everyone who contributed to the entry: who completed it and who added its evidence files (this round's too)
  const contributors = [
    m.submission?.completedBy,
    ...(m.submission?.evidence ?? []).map((e) => e.uploadedBy),
    ...m.evidence.filter((e) => e.round === m.round).map((e) => e.uploadedBy),
  ];
  if (contributors.some((name) => sameIdentity(name, u)))
    return { ok: false, reason: 'A second person must verify this step – not the person who completed it', code: 'VERIFY_SAME_PERSON' };
  if (m.spec.verification.notRunStarter && sameIdentity(run.actor, u))
    return { ok: false, reason: 'The person who started the run may not verify this step', code: 'VERIFY_RUN_STARTER' };
  const verifiers = m.spec.verification.verifiers;
  if (verifiers.length) {
    if (verifiers.some((s) => matches(u, s))) return { ok: true };
    return { ok: false, reason: `Verified by ${verifiers.join(', ')}`, code: 'VERIFY_ASSIGNED', params: { verifiers } };
  }
  if (perms.includes('approve') || perms.includes('run')) return { ok: true };
  return { ok: false, reason: 'You need run or approve rights on this process to verify', code: 'VERIFY_RIGHTS' };
}
