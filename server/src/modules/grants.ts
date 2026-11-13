import {
  MODULES,
  accessModule,
  declaredModuleRole,
  higherModuleRole,
  isModuleId,
  isModuleRole,
  moduleRestrictable,
  moduleRoleFromCore,
  moduleRolesOf,
  type ModuleGrantSource,
  type ModuleId,
  type ModuleRole,
  type ModuleRoleReason,
  type Role,
} from '@sm/shared';
import { db } from '../db.js';
import { currentStore } from '../auth/context.js';
import { aliasSubjects } from '../auth/aliases.js';

/**
 * The module policy (ADR 0034, 0.21.0 module access, 0.23.0 module roles): the one place that reads who uses which
 * module and with which module role. Everything that decides – the route hook, usesModule, the policy module's module
 * role reasons, the plant registry's role defaults, the costs managers, the access dialog's preview, _Why do I have
 * access?_ – asks here.
 *
 * - **Read once per request or job run** (`modulePolicy`): the modes of `module_access` and every row of
 *   `module_grants` in one statement; a change forgets it (`forgetModulePolicy`). Deciding for a thousand rows costs
 *   lookups, never a statement each.
 * - **A grant** names a user or a team (`user:<name>`, `team:<name>`, lower case) and a module role or none. On a
 *   restricted module every grant means "uses it"; a grant with a role also gives that role, on an open module too.
 *   `source` says who keeps it: an administrator (the access dialog, the user form) or single sign-on (synchronised
 *   at each sign-in).
 * - **A person's module role** is the highest of what their core roles give (`fromCoreRoles`) and the roles granted to
 *   them, a team they are in, or through single sign-on – only while they use the module.
 */

export interface GrantRow {
  module: ModuleId;
  /** As stored (lower case for new grants) */
  subject: string;
  role: ModuleRole | null;
  source: ModuleGrantSource;
}

export interface ModulePolicy {
  /** The restricted modules (mode `selected`, restrictable) */
  restricted: Set<ModuleId>;
  /** Every grant per module (open modules included: their grants give roles) */
  grants: Map<ModuleId, GrantRow[]>;
}

/** Reads the module policy: one statement, whatever the number of modules and grants. */
export function readModulePolicy(): ModulePolicy {
  const restricted = new Set<ModuleId>();
  const grants = new Map<ModuleId, GrantRow[]>();
  for (const r of db().all<{ module_id: string; subject: string | null; role: string | null; source: string | null; mode: string | null }>(
    `SELECT module_id, subject, role, source, NULL AS mode FROM module_grants
     UNION ALL SELECT module_id, NULL, NULL, NULL, mode FROM module_access`,
  )) {
    if (!isModuleId(r.module_id)) continue;
    if (r.subject === null) {
      if (r.mode === 'selected' && moduleRestrictable(r.module_id)) restricted.add(r.module_id);
      continue;
    }
    const list = grants.get(r.module_id) ?? [];
    list.push({
      module: r.module_id,
      subject: r.subject,
      role: isModuleRole(r.role) ? r.role : null,
      source: r.source === 'sso' ? 'sso' : 'admin',
    });
    grants.set(r.module_id, list);
  }
  return { restricted, grants };
}

/** The module policy of this request or job run, read once (without one: read now). */
export function modulePolicy(): ModulePolicy {
  const store = currentStore();
  if (!store) return readModulePolicy();
  return (store.moduleAccess ??= readModulePolicy()) as ModulePolicy;
}

/** After a change of module access or module roles within a request: read it again. */
export function forgetModulePolicy(): void {
  const store = currentStore();
  if (store) store.moduleAccess = undefined;
}

/** Who is asked: their name, teams and core roles (former names of an imported package count, as on access lists). */
export interface GrantPerson {
  id: string;
  username: string;
  roles: readonly Role[];
  teams: readonly string[];
}

/** The user and team subjects of a person (lower case), for matching grants – never `role:` subjects. */
export function grantSubjects(u: GrantPerson): Set<string> {
  return new Set([
    `user:${u.username.toLowerCase()}`,
    ...u.teams.map((t) => `team:${t.toLowerCase()}`),
    ...aliasSubjects({ id: u.id, teams: [...u.teams] }).filter((s) => !s.startsWith('role:')),
  ]);
}

/** The grants of a module that name `u` (directly, through a team, or synchronised for them). */
export function grantsOf(u: GrantPerson, id: ModuleId, policy: ModulePolicy = modulePolicy(), subjects: Set<string> = grantSubjects(u)): GrantRow[] {
  return (policy.grants.get(id) ?? []).filter((g) => subjects.has(g.subject.trim().toLowerCase()));
}

/** A grant's part in _Why do I have access?_: to the person, a team they are in, or through single sign-on. */
export function grantReason(g: GrantRow, role: ModuleRole): ModuleRoleReason {
  if (g.source === 'sso') return { source: 'sso', role };
  const m = /^team:(.+)$/i.exec(g.subject.trim());
  return m ? { source: 'team', role, team: m[1]! } : { source: 'user', role };
}

/** Administrators switch modules and give access; auditors' evidence must not depend on who was given a module. */
export const alwaysUsesModules = (u: Pick<GrantPerson, 'roles'>): boolean => u.roles.includes('admin') || u.roles.includes('auditor');

/** Whether `u` uses module `id` (its gate: the map follows the plant registry) by the policy – null person: the instance. */
export function usesByPolicy(u: GrantPerson | null | undefined, id: ModuleId, policy: ModulePolicy = modulePolicy()): boolean {
  if (!u) return true;
  const gate = accessModule(id);
  if (!policy.restricted.has(gate) || alwaysUsesModules(u)) return true;
  return grantsOf(u, gate, policy).length > 0;
}

/**
 * Whether `u` uses module `id` leaving out the grants single sign-on keeps for them (their own `user:` subject): what
 * the deprecated role "plant" of a mapping may turn into a grant without putting the person on a restricted list.
 */
export function usesWithoutOwnSso(u: GrantPerson, id: ModuleId, policy: ModulePolicy = modulePolicy()): boolean {
  const gate = accessModule(id);
  const subject = `user:${u.username.toLowerCase()}`;
  const grants = new Map(policy.grants);
  grants.set(
    gate,
    (policy.grants.get(gate) ?? []).filter((g) => !(g.source === 'sso' && g.subject.trim().toLowerCase() === subject)),
  );
  return usesByPolicy(u, id, { restricted: policy.restricted, grants });
}

/** A person's module role and where it comes from (empty `through`: none). */
export interface ModuleRoleOf {
  role: ModuleRole | null;
  through: ModuleRoleReason[];
  /** The role from grants alone (not core roles): what manager settings and the plant alias ask */
  granted: ModuleRole | null;
}

const NONE: ModuleRoleOf = { role: null, through: [], granted: null };

/**
 * The module role of `u` in module `id` (ADR 0034 part 4): the highest of their core roles' (`fromCoreRoles`) and the
 * roles granted to them, a team they are in or through single sign-on – none while they do not use the module, and
 * none in a module that declares no roles. Every source is listed in `through`.
 */
export function moduleRoleOf(u: GrantPerson | null | undefined, id: ModuleId, policy: ModulePolicy = modulePolicy()): ModuleRoleOf {
  if (!u || !moduleRolesOf(id).length || !usesByPolicy(u, id, policy)) return NONE;
  const through: ModuleRoleReason[] = [];
  let role: ModuleRole | null = null;
  let granted: ModuleRole | null = null;
  const fromCore = moduleRoleFromCore(id, u.roles);
  if (fromCore) {
    // the core role that gives it (the first that maps to the role)
    const map = MODULES.find((m) => m.id === id)?.access?.fromCoreRoles ?? {};
    const coreRole = u.roles.find((r) => declaredModuleRole(id, map[r]) === fromCore);
    through.push({ source: 'coreRole', role: fromCore, ...(coreRole ? { coreRole } : {}) });
    role = fromCore;
  }
  for (const g of grantsOf(u, id, policy)) {
    const r = declaredModuleRole(id, g.role);
    if (!r) continue;
    through.push(grantReason(g, r));
    role = higherModuleRole(role, r);
    granted = higherModuleRole(granted, r);
  }
  return { role, through, granted };
}

/** The roles granted to `u` in a module (not core roles), each with where it comes from – the policy module's reasons. */
export function grantedModuleRoles(u: GrantPerson, id: ModuleId, policy: ModulePolicy = modulePolicy()): ModuleRoleReason[] {
  if (!moduleRolesOf(id).length || !usesByPolicy(u, id, policy)) return [];
  const out: ModuleRoleReason[] = [];
  for (const g of grantsOf(u, id, policy)) {
    const r = declaredModuleRole(id, g.role);
    if (r) out.push(grantReason(g, r));
  }
  return out;
}

/** Whether any module role is granted to `u` (directly, through a team or single sign-on) – the question of moduleOnly. */
export function modulesGrantingRoles(u: GrantPerson, policy: ModulePolicy = modulePolicy()): ModuleId[] {
  const subjects = grantSubjects(u);
  const out: ModuleId[] = [];
  for (const [id, rows] of policy.grants)
    if (rows.some((g) => !!declaredModuleRole(id, g.role) && subjects.has(g.subject.trim().toLowerCase())) && usesByPolicy(u, id, policy)) out.push(id);
  return out;
}

/** Per person object (a request): the former roles that still name them. */
const formerRoleCache = new WeakMap<object, Role[]>();

/**
 * The former instance role "plant" (ADR 0034 part 5) as it still counts outside the plant registry: whoever is granted
 * the plant registry's contributor or manager role (directly, through a team or single sign-on) is treated as having
 * it where the role meant something – entries of access lists and shares that name `role:plant`, and the names of
 * catalogue items, dashboards and ticket references a plant page shows. So converting the role into a grant changes
 * nobody's rights. Someone who still carries the role, or whose manager role only comes from core roles, gets nothing
 * more here.
 */
export function formerRolesOf(u: GrantPerson): Role[] {
  if (u.roles.includes('plant')) return [];
  let out = formerRoleCache.get(u);
  if (!out) {
    const granted = moduleRoleOf(u, 'plant').granted;
    out = granted === 'contributor' || granted === 'manager' ? ['plant'] : [];
    formerRoleCache.set(u, out);
  }
  return out;
}
