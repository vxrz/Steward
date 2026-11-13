import {
  MODULES,
  accessModule,
  managerSetting,
  moduleDef,
  moduleOfRoute,
  moduleRestrictable,
  moduleRoleAtLeast,
  moduleRolesOf,
  type ModuleAccessMode,
  type ModuleId,
  type ModuleRole,
  type ModuleUse,
  type ModuleUseReason,
  type ModuleUseState,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, parseJson } from '../util.js';
import { currentStore, currentUser, type AuthUser } from '../auth/context.js';
import { moduleAccessMode, moduleEnabled } from './registry.js';
import {
  alwaysUsesModules,
  forgetModulePolicy,
  grantReason,
  grantSubjects,
  grantsOf,
  modulePolicy,
  moduleRoleOf,
  usesByPolicy,
  type ModulePolicy,
} from './grants.js';

export { moduleAccessMode };

/**
 * Module access (0.21.0, ADR 0034): who uses a module that is on. A module's access is **everyone signed in** (the
 * default – no row, so an upgrade changes nothing) or **selected teams and users** (module_access.mode `selected`,
 * module_grants). Administrators always use every module, auditors always (as viewers); the status pages cannot be
 * restricted and the map of sites follows the plant registry (shared/src/modules.ts, `access`).
 *
 * Someone who does not use a module meets it like a switched-off one, with a code of its own: its routes answer
 * 404 MODULE_NO_ACCESS (app.ts, after authentication, before step-up and the route's code), and its MCP tools,
 * notification events, report sections, export parts, datasets and links leave it out. Background jobs keep running:
 * they are the instance's. Changing a module's access: access-change.ts.
 */

/** Who is asked: a signed-in person, a token's owner, a recipient (roles, teams and former names decide). */
export type ModuleUser = Pick<AuthUser, 'id' | 'username' | 'roles' | 'teams'>;

export { alwaysUsesModules };

/** After a change of module access within a request: read it again. */
export const forgetModuleAccess = forgetModulePolicy;

/** Whether `u` uses a module given its mode and subjects (also for the preview of a change). */
export function usesWith(u: ModuleUser, mode: ModuleAccessMode, subjects: readonly string[]): boolean {
  if (mode !== 'selected' || alwaysUsesModules(u)) return true;
  const mine = grantSubjects(u);
  return subjects.some((s) => mine.has(s.trim().toLowerCase()));
}

/**
 * Whether `user` uses module `id` (whether it is on is moduleEnabled's question). No person – a background job, a
 * scheduled export, a webhook with its own secret – is the instance, which uses every module.
 *
 * The integration point for shares of module items (ADR 0034 decision 15, #289): a share of an item of a module
 * (moduleOfItemKind) to someone who does not use it is refused – subjectUsesModule() for the share's subject.
 */
export function usesModule(user: ModuleUser | null | undefined, id: ModuleId): boolean {
  return usesByPolicy(user, id);
}

/** The modules `user` does not use (one read; the map follows the plant registry). */
export function modulesNotUsedBy(user: ModuleUser | null | undefined): Set<ModuleId> {
  const out = new Set<ModuleId>();
  if (!user || alwaysUsesModules(user)) return out;
  const policy = modulePolicy();
  if (!policy.restricted.size) return out;
  for (const m of MODULES) if (!usesByPolicy(user, m.id, policy)) out.add(m.id);
  return out;
}

/**
 * Whether `user` uses module `id` and through what (ADR 0034 part 7): _Why do I have access?_, person access reviews and
 * the test sign-in name the module layer – everyone signed in, administrator, auditor, named on the list, a team on
 * it, or single sign-on – and, for a module that declares roles, their module role and where it comes from. A module
 * that follows another (the map) is answered for that one.
 */
export function moduleUseOf(user: ModuleUser, id: ModuleId): ModuleUse {
  const policy = modulePolicy();
  const gate = accessModule(id);
  const restricted = moduleRestrictable(gate) && policy.restricted.has(gate);
  const through: ModuleUseReason[] = [];
  if (user.roles.includes('admin')) through.push({ source: 'admin' });
  if (user.roles.includes('auditor')) through.push({ source: 'auditor' });
  if (!restricted) through.push({ source: 'everyone' });
  else
    for (const g of grantsOf(user, gate, policy)) {
      const r = grantReason(g, 'viewer');
      through.push(r.source === 'team' ? { source: 'team', team: r.team! } : { source: r.source === 'sso' ? 'sso' : 'user' });
    }
  const out: ModuleUse = { module: id, enabled: moduleEnabled(id), restricted, uses: through.length > 0, through };
  if (moduleRolesOf(id).length) {
    const r = moduleRoleOf(user, id, policy);
    out.role = r.role;
    out.roleThrough = r.through;
  }
  return out;
}

/** The restricted modules (each once: the map follows the plant registry) and whether `user` uses each. */
export function restrictedModuleUses(user: ModuleUser): ModuleUse[] {
  const policy = modulePolicy();
  return MODULES.filter((m) => accessModule(m.id) === m.id && policy.restricted.has(m.id)).map((m) => moduleUseOf(user, m.id));
}

/**
 * The module layer of a person access review (ADR 0034 part 7): the restricted modules, and the modules in which a
 * module role is granted to the person (directly, through a team or single sign-on) – each once, with their role and
 * where it comes from. What core roles give by default follows from the roles the review shows anyway.
 */
export function moduleUsesForReview(user: ModuleUser): ModuleUse[] {
  const policy = modulePolicy();
  return MODULES.filter(
    (m) =>
      accessModule(m.id) === m.id && (policy.restricted.has(m.id) || (moduleRolesOf(m.id).length > 0 && moduleRoleOf(user, m.id, policy).granted !== null)),
  ).map((m) => moduleUseOf(user, m.id));
}

/**
 * The test sign-in (ADR 0034 part 6): the restricted modules and the modules the mappings give a role in, as the person
 * would use them with these roles, teams and module roles (synchronised grants as they would be after the sign-in).
 */
export function previewModuleUses(user: ModuleUser, moduleRoles: readonly { module: ModuleId; role: ModuleRole }[]): ModuleUse[] {
  const now = modulePolicy();
  const subject = `user:${user.username.toLowerCase()}`;
  const grants = new Map(now.grants);
  for (const [id, rows] of now.grants)
    grants.set(
      id,
      rows.filter((g) => !(g.source === 'sso' && g.subject.trim().toLowerCase() === subject)),
    );
  for (const m of moduleRoles) grants.set(m.module, [...(grants.get(m.module) ?? []), { module: m.module, subject, role: m.role, source: 'sso' }]);
  const store = currentStore();
  const policy: ModulePolicy = { restricted: now.restricted, grants };
  const run = () =>
    MODULES.filter((m) => accessModule(m.id) === m.id && (policy.restricted.has(m.id) || moduleRoles.some((r) => r.module === m.id))).map((m) =>
      moduleUseOf(user, m.id),
    );
  if (!store) return run();
  const saved = store.moduleAccess;
  store.moduleAccess = policy;
  try {
    return run();
  } finally {
    store.moduleAccess = saved;
  }
}

/** The module role of the current person (or `user`) in a module: null when it declares none or they do not use it. */
export function moduleRole(id: ModuleId, user: ModuleUser | null | undefined = currentUser()): ModuleRole | null {
  return moduleRoleOf(user, id).role;
}

/**
 * Whether `user` may change a module's setting `key` (ADR 0034 decision 11): administrators always; otherwise only a
 * **granted** manager role of a module that declares the setting as content (`managerSettings`) – a manager role that
 * comes from core roles gives the module's items, not its settings, so nobody gained settings at the upgrade.
 */
export function mayChangeModuleSetting(id: ModuleId, key: string, user: ModuleUser | null | undefined = currentUser()): boolean {
  if (!user) return false;
  if (user.roles.includes('admin')) return true;
  return managerSetting(id, key) && moduleRoleAtLeast(moduleRoleOf(user, id).granted, 'manager');
}

/** The modules whose manager settings `user` may change (Capabilities.moduleSettings). */
export function moduleSettingsOf(user: ModuleUser | null | undefined): ModuleId[] {
  if (!user) return [];
  return MODULES.filter((m) => (m.access?.managerSettings ?? []).some((k) => mayChangeModuleSetting(m.id, k, user))).map((m) => m.id);
}

/** A module is on and the current person (if any) uses it: what request-scoped surfaces ask instead of moduleEnabled. */
export function moduleAvailable(id: ModuleId, user: ModuleUser | null | undefined = currentUser()): boolean {
  return moduleEnabled(id) && usesModule(user, id);
}

/** Per module, how it looks to the person: on, switched off, or on but not theirs (GET /api/auth/status). */
export function moduleUseStates(user: ModuleUser | null | undefined): Record<ModuleId, ModuleUseState> {
  const notUsed = modulesNotUsedBy(user);
  return Object.fromEntries(MODULES.map((m) => [m.id, !moduleEnabled(m.id) ? 'off' : notUsed.has(m.id) ? 'notYours' : 'on'])) as Record<
    ModuleId,
    ModuleUseState
  >;
}

/** 404 MODULE_NO_ACCESS: as if the route did not exist, with the module, so the web app can say why. */
export function moduleNoAccess(id: ModuleId): HttpError {
  return new HttpError(404, `You do not use ${moduleDef(id).name} – an administrator can give you access`, 'MODULE_NO_ACCESS', { module: id });
}

/** The module of a registered route, if `user` does not use it (app.ts answers 404 MODULE_NO_ACCESS then). */
export function unusedModuleOfRoute(url: string, user: ModuleUser | null | undefined): ModuleId | undefined {
  if (!user || alwaysUsesModules(user)) return undefined;
  const id = moduleOfRoute(url);
  return id && !usesModule(user, id) ? id : undefined;
}

/** 404 MODULE_NO_ACCESS unless the current person uses the module (services that are reached from outside its routes). */
export function requireModuleUse(id: ModuleId, user: ModuleUser | null | undefined = currentUser()): void {
  if (!usesModule(user, id)) throw moduleNoAccess(id);
}

/**
 * Whether the subject of a share or a recipient list – `user:<name>` or `team:<name>` – uses a module. A user: their
 * roles and teams decide; a team: it is on the module's list (or the module is open to everyone). Unknown users do
 * not use a restricted module. For #289 (shares of module items, decision 15) and the recipients of reports.
 */
export function subjectUsesModule(subject: string, id: ModuleId): boolean {
  const gate = accessModule(id);
  if (!moduleRestrictable(gate) || moduleAccessMode(gate) !== 'selected') return true;
  const m = /^(user|team):(.+)$/i.exec(subject.trim());
  if (!m) return false;
  const name = m[2]!.trim().toLowerCase();
  if (m[1]!.toLowerCase() === 'team') return (modulePolicy().grants.get(gate) ?? []).some((g) => g.subject.toLowerCase() === `team:${name}`);
  const row = db().get<{ id: string; username: string; roles: string }>('SELECT id, username, roles FROM users WHERE lower(username) = ?', name);
  if (!row) return false;
  const teams = db()
    .all<{ name: string }>('SELECT t.name FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ?', row.id)
    .map((t) => t.name);
  return usesModule({ id: row.id, username: row.username, roles: parseJson<AuthUser['roles']>(row.roles, []), teams }, id);
}
