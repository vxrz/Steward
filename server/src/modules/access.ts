import {
  MODULES,
  accessModule,
  isModuleId,
  moduleDef,
  moduleOfRoute,
  moduleRestrictable,
  type ModuleAccessMode,
  type ModuleId,
  type ModuleUseState,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, parseJson } from '../util.js';
import { currentStore, currentUser, type AuthUser } from '../auth/context.js';
import { matches } from '../auth/permissions.js';
import { moduleAccessMode, moduleEnabled } from './registry.js';

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

/** Administrators switch modules and give access; auditors' evidence must not depend on who was given a module. */
export const alwaysUsesModules = (u: Pick<AuthUser, 'roles'>): boolean => u.roles.includes('admin') || u.roles.includes('auditor');

/** The subjects (`team:<name>`, `user:<name>`) that use a restricted module, as stored (lower case). */
export function moduleGrantSubjects(id: ModuleId): string[] {
  return db()
    .all<{ subject: string }>('SELECT subject FROM module_grants WHERE module_id = ? ORDER BY subject', id)
    .map((r) => r.subject);
}

/** The restricted modules with their subjects, in one read (for filtering many items at once). */
export function restrictedModules(): Map<ModuleId, string[]> {
  const out = new Map<ModuleId, string[]>();
  for (const r of db().all<{ module_id: string }>("SELECT module_id FROM module_access WHERE mode = 'selected'"))
    if (isModuleId(r.module_id) && moduleRestrictable(r.module_id)) out.set(r.module_id, []);
  if (!out.size) return out;
  for (const g of db().all<{ module_id: string; subject: string }>('SELECT module_id, subject FROM module_grants'))
    out.get(g.module_id as ModuleId)?.push(g.subject);
  return out;
}

/** restrictedModules(), read once per request or job run (a change of access forgets it: forgetModuleAccess). */
function restrictedNow(): Map<ModuleId, string[]> {
  const store = currentStore();
  if (!store) return restrictedModules();
  return (store.moduleAccess ??= restrictedModules()) as Map<ModuleId, string[]>;
}

/** After a change of module access within a request: read it again. */
export function forgetModuleAccess(): void {
  const store = currentStore();
  if (store) store.moduleAccess = undefined;
}

/** Whether `u` uses a module given its mode and subjects (also for the preview of a change). */
export function usesWith(u: ModuleUser, mode: ModuleAccessMode, subjects: readonly string[]): boolean {
  if (mode !== 'selected' || alwaysUsesModules(u)) return true;
  return subjects.some((s) => matches(u as AuthUser, s));
}

/**
 * Whether `user` uses module `id` (whether it is on is moduleEnabled's question). No person – a background job, a
 * scheduled export, a webhook with its own secret – is the instance, which uses every module.
 *
 * The integration point for shares of module items (ADR 0034 decision 15, #289): a share of an item of a module
 * (moduleOfItemKind) to someone who does not use it is refused – subjectUsesModule() for the share's subject.
 */
export function usesModule(user: ModuleUser | null | undefined, id: ModuleId): boolean {
  if (!user) return true;
  const gate = accessModule(id);
  if (!moduleRestrictable(gate) || alwaysUsesModules(user)) return true;
  const subjects = restrictedNow().get(gate);
  return !subjects || usesWith(user, 'selected', subjects);
}

/** The modules `user` does not use (one read; the map follows the plant registry). */
export function modulesNotUsedBy(user: ModuleUser | null | undefined): Set<ModuleId> {
  const out = new Set<ModuleId>();
  if (!user || alwaysUsesModules(user)) return out;
  const restricted = restrictedNow();
  if (!restricted.size) return out;
  for (const m of MODULES) {
    const subjects = restricted.get(accessModule(m.id));
    if (subjects && !usesWith(user, 'selected', subjects)) out.add(m.id);
  }
  return out;
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
  if (m[1]!.toLowerCase() === 'team') return moduleGrantSubjects(gate).some((s) => s.toLowerCase() === `team:${name}`);
  const row = db().get<{ id: string; username: string; roles: string }>('SELECT id, username, roles FROM users WHERE lower(username) = ?', name);
  if (!row) return false;
  const teams = db()
    .all<{ name: string }>('SELECT t.name FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ?', row.id)
    .map((t) => t.name);
  return usesModule({ id: row.id, username: row.username, roles: parseJson<AuthUser['roles']>(row.roles, []), teams }, id);
}
