import {
  DEPRECATED_ROLES,
  MODULE_IDS,
  MODULE_ROLES,
  higherModuleRole,
  isModuleRole,
  moduleDef,
  moduleRolesOf,
  modulesWithRoles,
  type ModuleGrantSource,
  type ModuleId,
  type ModuleRole,
  type Role,
  type UserModuleRole,
} from '@sm/shared';
import { z } from 'zod';
import { audit } from '../audit.js';
import { db } from '../db.js';
import { requireAccessGrant } from '../auth/access-change.js';
import { currentActor, currentUser } from '../auth/context.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { forgetModulePolicy, modulePolicy, type ModulePolicy } from './grants.js';
import { moduleAccessMode } from './registry.js';
import { recordModuleAccessChange } from './access-change.js';

/**
 * A person's own module roles (0.23.0, ADR 0034 parts 4 and 5): the grants whose subject is the person
 * (`user:<name>`) – set in the user form, in the access dialog of the module, or synchronised by single sign-on – and
 * the alias of the former instance role "plant" (Plant viewer), which the API still accepts for one release and turns
 * into the plant registry's contributor grant.
 *
 * Giving a module role or a higher one widens access: the step-up `grantAccess` (control point access.grant) and an
 * access change in the audit log (`access.module_access_changed`, `via` userForm, roleAlias or sso). Only signed-in
 * sessions change them: the user routes are session-only.
 */

/** The module role the deprecated role "plant" stands for. */
export const PLANT_ROLE_ALIAS: { module: ModuleId; role: ModuleRole } = { module: 'plant', role: 'contributor' };

/** Body part of the user form and the user API: per module that declares roles, the role or none (null). */
export const userModuleRolesBody = z
  .array(z.object({ module: z.enum(MODULE_IDS), role: z.enum(MODULE_ROLES).nullable() }).strict())
  .max(20);

export type UserModuleRolesInput = z.infer<typeof userModuleRolesBody>;

/** The person's own module roles from the policy (one per module and source: the highest). */
export function moduleRolesOfUser(username: string, policy: ModulePolicy = modulePolicy()): UserModuleRole[] {
  const subject = `user:${username.toLowerCase()}`;
  const best = new Map<string, UserModuleRole>();
  for (const id of modulesWithRoles())
    for (const g of policy.grants.get(id) ?? []) {
      if (g.subject.trim().toLowerCase() !== subject || !g.role) continue;
      const key = `${id}|${g.source}`;
      const prev = best.get(key);
      best.set(key, { module: id, role: higherModuleRole(prev?.role, g.role)!, source: g.source });
    }
  return [...best.values()].sort((a, b) => a.module.localeCompare(b.module) || a.source.localeCompare(b.source));
}

/** Splits the deprecated roles off a role list: the roles to store, and the module roles they stand for. */
export function splitDeprecatedRoles(roles: readonly Role[]): { roles: Role[]; moduleRoles: { module: ModuleId; role: ModuleRole }[] } {
  const alias = roles.includes('plant');
  return { roles: roles.filter((r) => !DEPRECATED_ROLES.includes(r)), moduleRoles: alias ? [PLANT_ROLE_ALIAS] : [] };
}

interface Row {
  id: string;
  role: string | null;
}

/** The administrators' rows of a person on a module (single sign-on's are left alone). */
const adminRows = (id: ModuleId, subject: string): Row[] =>
  db().all<Row>("SELECT id, role FROM module_grants WHERE module_id = ? AND lower(subject) = ? AND (source IS NULL OR source <> 'sso')", id, subject);

const rank = (r: ModuleRole | null | undefined) => (r ? MODULE_ROLES.indexOf(r) : -1);

/** What a change of a person's own module roles would do: per module, the role before and after (only changes). */
export function userModuleRoleChanges(
  username: string,
  next: UserModuleRolesInput,
  opts: { raiseOnly?: boolean } = {},
): { module: ModuleId; before: ModuleRole | null; after: ModuleRole | null }[] {
  const subject = `user:${username.toLowerCase()}`;
  const out: { module: ModuleId; before: ModuleRole | null; after: ModuleRole | null }[] = [];
  for (const n of next) {
    const id = n.module as ModuleId;
    if (n.role && !moduleRolesOf(id).includes(n.role))
      throw new HttpError(400, `${moduleDef(id).name} has no module role "${n.role}"`, 'MODULE_ROLE_UNKNOWN', { module: id, role: n.role });
    let before: ModuleRole | null = null;
    for (const r of adminRows(id, subject)) before = higherModuleRole(before, isModuleRole(r.role) ? r.role : null);
    // the alias only raises: an account that is a manager already stays one
    const after = opts.raiseOnly ? higherModuleRole(before, n.role) : n.role;
    if (before !== after) out.push({ module: id, before, after });
  }
  return out;
}

/** Whether a change of a person's own module roles widens access (a new role or a higher one). */
export const userModuleRolesWiden = (username: string, next: UserModuleRolesInput, opts: { raiseOnly?: boolean } = {}): boolean =>
  userModuleRoleChanges(username, next, opts).some((c) => rank(c.after) > rank(c.before));

/**
 * Sets a person's own module roles (the user form, the alias of the role "plant"): a widening asks for the step-up
 * access.grant before anything is written; each module whose role changes gets an access change in the audit log.
 * Taking a role away from someone on the list of a restricted module keeps them on the list (they still use it).
 */
export function setUserModuleRoles(username: string, next: UserModuleRolesInput, via: 'userForm' | 'roleAlias', opts: { raiseOnly?: boolean } = {}): void {
  const changes = userModuleRoleChanges(username, next, opts);
  if (!changes.length) return;
  if (changes.some((c) => rank(c.after) > rank(c.before))) requireAccessGrant(currentUser());
  const subject = `user:${username.toLowerCase()}`;
  const now = nowIso();
  db().tx(() => {
    for (const c of changes) {
      const restricted = moduleAccessMode(c.module) === 'selected';
      const rows = adminRows(c.module, subject);
      db().run("DELETE FROM module_grants WHERE module_id = ? AND lower(subject) = ? AND (source IS NULL OR source <> 'sso')", c.module, subject);
      // on a restricted module's list the person stays (without a role), unless they were not on it
      if (c.after || (restricted && rows.length))
        db().run(
          'INSERT INTO module_grants (id, module_id, subject, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          newId('mg_'),
          c.module,
          subject,
          c.after,
          currentActor(),
          now,
        );
      const mode = restricted ? 'selected' : 'everyone';
      recordModuleAccessChange({
        module: c.module,
        before: { mode, subjects: [] },
        after: { mode, subjects: [] },
        // a role on a restricted module puts the person on its list (a role is taken away, the use stays)
        granted: restricted && !rows.length && c.after ? [subject] : [],
        removed: [],
        roles: [{ subject, before: c.before, after: c.after }],
        via,
      });
    }
  });
  forgetModulePolicy();
}

/**
 * Synchronises a person's module roles from single sign-on (ADR 0034 part 6): the grants with source `sso` become
 * exactly `wanted` (the mappings' module roles, the alias of the role "plant" among them), as roles are synchronised.
 * The sign-in is the confirmation (the administrator's mapping decided it); each change is an access change.
 */
export function syncSsoModuleRoles(username: string, wanted: { module: ModuleId; role: ModuleRole }[]): string[] {
  const subject = `user:${username.toLowerCase()}`;
  const want = new Map<ModuleId, ModuleRole>();
  for (const w of wanted) if (moduleRolesOf(w.module).includes(w.role)) want.set(w.module, higherModuleRole(want.get(w.module), w.role)!);
  const have = new Map<ModuleId, ModuleRole | null>();
  for (const r of db().all<{ module_id: string; role: string | null }>(
    "SELECT module_id, role FROM module_grants WHERE lower(subject) = ? AND source = 'sso'",
    subject,
  ))
    have.set(r.module_id as ModuleId, higherModuleRole(have.get(r.module_id as ModuleId), isModuleRole(r.role) ? r.role : null));
  const changes: string[] = [];
  const now = nowIso();
  for (const id of new Set<ModuleId>([...want.keys(), ...have.keys()])) {
    const before = have.get(id) ?? null;
    const after = want.get(id) ?? null;
    if (before === after && have.has(id) === want.has(id)) continue;
    db().run("DELETE FROM module_grants WHERE module_id = ? AND lower(subject) = ? AND source = 'sso'", id, subject);
    if (after)
      db().run(
        "INSERT INTO module_grants (id, module_id, subject, role, source, created_by, created_at) VALUES (?, ?, ?, ?, 'sso', ?, ?)",
        newId('mg_'),
        id,
        subject,
        after,
        username,
        now,
      );
    const mode = moduleAccessMode(id);
    recordModuleAccessChange({
      module: id,
      before: { mode, subjects: [] },
      after: { mode, subjects: [] },
      granted: !before && after ? [subject] : [],
      removed: before && !after ? [subject] : [],
      roles: [{ subject, before, after }],
      via: 'sso',
    });
    changes.push(`${id} ${before ?? '–'} → ${after ?? '–'}`);
  }
  if (changes.length) forgetModulePolicy();
  return changes;
}

/**
 * The former instance role "plant" (ADR 0034 part 5): every account that still carries it – an installation from
 * before 0.23.0, a migration package of an older version – gets the plant registry's contributor grant instead, once.
 * An account of a single sign-on provider that synchronises roles gets it as a synchronised grant (the next sign-in
 * keeps or removes it as the mappings say, as it would have kept or removed the role); every other account as an
 * administrator's grant. Nobody gains or loses a right: contributor gives exactly what the role gave, and `role:plant`
 * entries of access lists and shares still match (auth/permissions.ts). Audited per account. Runs once the vault is
 * open (the audit log needs its key) and after a migration package is imported. Returns the number of accounts.
 */
export function convertDeprecatedRoles(): number {
  const rows = db().all<{ id: string; username: string; roles: string; auth_source: string | null }>(
    "SELECT id, username, roles, auth_source FROM users WHERE lower(roles) LIKE '%plant%'",
  );
  const affected = rows.filter((r) => parseJson<string[]>(r.roles, []).includes('plant'));
  if (!affected.length) return 0;
  const syncing = new Set(
    db()
      .all<{ id: string; config: string }>('SELECT id, config FROM identity_providers')
      .filter((p) => parseJson<{ syncRoles?: boolean }>(p.config, {}).syncRoles !== false)
      .map((p) => p.id),
  );
  const now = nowIso();
  db().tx(() => {
    for (const r of affected) {
      const subject = `user:${r.username.toLowerCase()}`;
      const source: ModuleGrantSource = r.auth_source && r.auth_source !== 'local' && syncing.has(r.auth_source) ? 'sso' : 'admin';
      const has = db().all<{ role: string | null }>(
        `SELECT role FROM module_grants WHERE module_id = 'plant' AND lower(subject) = ? AND ${source === 'sso' ? "source = 'sso'" : "(source IS NULL OR source <> 'sso')"}`,
        subject,
      );
      let before: ModuleRole | null = null;
      for (const h of has) before = higherModuleRole(before, isModuleRole(h.role) ? h.role : null);
      const after = higherModuleRole(before, PLANT_ROLE_ALIAS.role);
      if (after !== before) {
        db().run(
          `DELETE FROM module_grants WHERE module_id = 'plant' AND lower(subject) = ? AND ${source === 'sso' ? "source = 'sso'" : "(source IS NULL OR source <> 'sso')"}`,
          subject,
        );
        db().run(
          'INSERT INTO module_grants (id, module_id, subject, role, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          newId('mg_'),
          'plant',
          subject,
          after,
          source === 'sso' ? 'sso' : null,
          'system',
          now,
        );
      }
      const roles = parseJson<string[]>(r.roles, []).filter((x) => x !== 'plant');
      db().run('UPDATE users SET roles = ?, updated_at = ? WHERE id = ?', JSON.stringify(roles), now, r.id);
      const mode = moduleAccessMode('plant');
      audit({
        actor: 'system',
        action: 'access.module_access_changed',
        entityType: 'settings',
        entityId: 'module:plant',
        summary: `The role "plant" of "${r.username}" became the module role contributor of the plant registry (ADR 0034; nothing changes for them)`,
        details: {
          module: 'plant',
          mode: { before: mode, after: mode },
          granted: [],
          removed: [],
          roles: [{ subject, before, after }],
          via: 'roleAlias',
          user: r.username,
          source,
        },
      });
    }
  });
  forgetModulePolicy();
  return affected.length;
}
