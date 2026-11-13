import {
  MODULE_ACCESS_LIMITS,
  MODULE_ACCESS_MODES,
  MODULE_ROLES,
  OWNED_KINDS,
  higherModuleRole,
  isModuleRole,
  moduleDef,
  moduleRestrictable,
  moduleRolesOf,
  type ModuleAccessInput,
  type ModuleAccessMode,
  type ModuleAccessPreview,
  type ModuleAccessView,
  type ModuleGrantSource,
  type ModuleId,
  type ModuleRole,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { auditAccessChange, requireAccessGrant } from '../auth/access-change.js';
import { isStatusViewer, me } from '../auth/access.js';
import { assertKnownSubjects, subjectExists } from '../auth/subjects.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { moduleOnlyModules } from '../auth/policy.js';
import { HttpError, newId, nowIso } from '../util.js';
import { forgetModuleAccess, moduleAccessMode } from './access.js';
import { modulePolicy, moduleRoleOf, usesByPolicy, type ModulePolicy } from './grants.js';

/**
 * Changing who uses a module (0.21.0, ADR 0034 part 7) and the module roles given on it (0.23.0, part 4):
 * administrators, in a signed-in session; widening – opening a restricted module, adding a team or user, giving a
 * module role or a higher one – asks for the step-up `grantAccess` (control point access.grant, see
 * modules/routes.ts); narrowing is confirmed in the dialog with the preview of who loses it. Every change is an access
 * change in the audit log (`access.module_access_changed`, with `roles` for the module roles).
 */

const subject = z
  .string()
  .trim()
  .min(6)
  .max(200)
  .regex(/^(user|team):\S/i, 'a user or team: "user:<name>" or "team:<name>"');

export const moduleAccessBody = z
  .object({
    mode: z.enum(MODULE_ACCESS_MODES),
    grants: z
      .array(z.object({ subject, role: z.enum(MODULE_ROLES).nullable().optional() }).strict())
      .max(MODULE_ACCESS_LIMITS.grants)
      .default([]),
  })
  .strict();

/** A module whose access an administrator sets: one that can be restricted, or one that declares roles (given on an open module). */
function settable(id: ModuleId, input?: ModuleAccessInput): void {
  const roles = moduleRolesOf(id);
  if (!moduleRestrictable(id) && (!roles.length || input?.mode === 'selected'))
    throw new HttpError(400, `${moduleDef(id).name} cannot be restricted to selected teams and users`, 'MODULE_NOT_RESTRICTABLE', { module: id });
  for (const g of input?.grants ?? [])
    if (g.role && !roles.includes(g.role))
      throw new HttpError(400, `${moduleDef(id).name} has no module role "${g.role}"`, 'MODULE_ROLE_UNKNOWN', { module: id, role: g.role });
}

interface GrantRow {
  subject: string;
  role: string | null;
  source: string | null;
  created_by: string;
  created_at: string;
}

/** GET /api/settings/modules/:id/access */
export function moduleAccessView(id: ModuleId): ModuleAccessView {
  const row = db().get<{ updated_by: string; updated_at: string }>('SELECT updated_by, updated_at FROM module_access WHERE module_id = ?', id);
  const seen = new Set<string>();
  const grants = db()
    .all<GrantRow>('SELECT subject, role, source, created_by, created_at FROM module_grants WHERE module_id = ? ORDER BY subject, created_at', id)
    .map((g) => ({ ...g, src: (g.source === 'sso' ? 'sso' : 'admin') as ModuleGrantSource }))
    // one row per subject and source (two rows of a subject: the highest role)
    .sort((a, b) => MODULE_ROLES.indexOf(b.role as ModuleRole) - MODULE_ROLES.indexOf(a.role as ModuleRole))
    .filter((g) => !seen.has(`${g.src}|${g.subject.toLowerCase()}`) && !!seen.add(`${g.src}|${g.subject.toLowerCase()}`))
    .sort((a, b) => a.subject.localeCompare(b.subject) || a.src.localeCompare(b.src))
    .map((g) => ({
      subject: g.subject,
      role: isModuleRole(g.role) ? g.role : null,
      source: g.src,
      createdBy: g.created_by,
      createdAt: g.created_at,
      known: subjectExists(g.subject),
    }));
  return {
    module: id,
    restrictable: moduleRestrictable(id),
    roles: moduleRolesOf(id),
    mode: moduleAccessMode(id),
    grants,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/** The administrators' grants of a module: subject (lower case) → role (null: uses it) – the highest of duplicates. */
function adminGrants(id: ModuleId): Map<string, ModuleRole | null> {
  const out = new Map<string, ModuleRole | null>();
  for (const g of modulePolicy().grants.get(id) ?? []) {
    if (g.source === 'sso') continue;
    const key = g.subject.trim().toLowerCase();
    out.set(key, out.has(key) ? higherModuleRole(out.get(key), g.role) : g.role);
  }
  return out;
}

/**
 * The grants of an input: subject (lower case) → role, each once (the highest). Open to everyone, only grants with a
 * role are kept – they give the role; a grant without one means nothing then.
 */
function grantsOfInput(input: ModuleAccessInput): Map<string, ModuleRole | null> {
  const out = new Map<string, ModuleRole | null>();
  for (const g of input.grants) {
    const key = g.subject.trim().toLowerCase();
    const role = g.role ?? null;
    if (input.mode === 'everyone' && !role) continue;
    out.set(key, out.has(key) ? higherModuleRole(out.get(key), role) : role);
  }
  return out;
}

const rank = (role: ModuleRole | null | undefined): number => (role ? MODULE_ROLES.indexOf(role) : -1);

/**
 * Whether a change widens who uses the module or what they may do in it: opening it, naming a team or user that is
 * not on its list (while it is restricted), giving a module role or a higher one.
 */
export function moduleAccessWidens(id: ModuleId, input: ModuleAccessInput): boolean {
  const mode = moduleAccessMode(id);
  const before = adminGrants(id);
  const after = grantsOfInput(input);
  if (mode === 'selected' && input.mode === 'everyone') return true;
  for (const [s, role] of after) {
    if (input.mode === 'selected' && mode === 'selected' && !before.has(s)) return true;
    if (rank(role) > rank(before.get(s))) return true;
  }
  return false;
}

/** The module policy as it would be after the change (only this module's administrators' grants and mode differ). */
function policyAfter(id: ModuleId, input: ModuleAccessInput): ModulePolicy {
  const now = modulePolicy();
  const restricted = new Set(now.restricted);
  if (input.mode === 'selected') restricted.add(id);
  else restricted.delete(id);
  const grants = new Map(now.grants);
  const kept = (now.grants.get(id) ?? []).filter((g) => g.source === 'sso');
  grants.set(id, [...kept, ...[...grantsOfInput(input)].map(([subject, role]) => ({ module: id, subject, role, source: 'admin' as const }))]);
  return { restricted, grants };
}

/** Who gains and who loses use of the module, whose module role changes, and the teams owning its items that would not use it – nothing changed. */
export function previewModuleAccess(id: ModuleId, input: ModuleAccessInput): ModuleAccessPreview {
  settable(id, input);
  const before = modulePolicy();
  const after = policyAfter(id, input);
  const gains: ModuleAccessPreview['gains'] = [];
  const loses: ModuleAccessPreview['loses'] = [];
  const roleChanges: NonNullable<ModuleAccessPreview['roleChanges']> = [];
  const withRoles = moduleRolesOf(id).length > 0;
  // status viewers reach the status pages only (which cannot be restricted), module-only users their modules only:
  // they neither gain nor lose another module
  for (const u of listUsers().filter((x) => x.active)) {
    const au = toAuthUser(u);
    const only = moduleOnlyModules(au);
    if (isStatusViewer(u.roles) && !only.length) continue;
    if (only.length && !only.includes(id)) continue;
    const was = usesByPolicy(au, id, before);
    const will = usesByPolicy(au, id, after);
    if (was !== will) (will ? gains : loses).push({ username: u.username, displayName: u.displayName });
    if (withRoles) {
      const r0 = moduleRoleOf(au, id, before).role;
      const r1 = moduleRoleOf(au, id, after).role;
      if (r0 !== r1 && was && will) roleChanges.push({ username: u.username, displayName: u.displayName, before: r0, after: r1 });
    }
  }
  // teams that own items of the module (owning-team kinds among its item kinds) but would not use it
  const kinds = (moduleDef(id).access?.itemKinds ?? []).filter((k) => (OWNED_KINDS as readonly string[]).includes(k));
  const subjects = [...grantsOfInput(input).keys()];
  const owningTeamsWithout =
    input.mode === 'selected' && kinds.length
      ? db()
          .all<{ name: string }>(
            `SELECT DISTINCT t.name FROM resource_teams rt JOIN teams t ON t.id = rt.team_id WHERE rt.kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY t.name`,
            ...kinds,
          )
          .map((t) => t.name)
          .filter((n) => !subjects.includes(`team:${n.toLowerCase()}`))
      : [];
  return { module: id, widens: moduleAccessWidens(id, input), gains, loses, ...(withRoles ? { roleChanges } : {}), owningTeamsWithout };
}

export interface ModuleAccessChange {
  module: ModuleId;
  before: { mode: ModuleAccessMode; subjects: string[] };
  after: { mode: ModuleAccessMode; subjects: string[] };
  granted: string[];
  removed: string[];
  /** Module roles given, changed or taken (0.23.0): subject, before and after (null: none) */
  roles?: { subject: string; before: ModuleRole | null; after: ModuleRole | null }[];
  /** Who changed it when it was not the dialog (the user form, single sign-on) */
  via?: 'userForm' | 'sso' | 'roleAlias';
}

/**
 * The audit entry of a change of module access, in the family of access changes (ADR 0033): mode before and after,
 * who was granted and removed, whose module role changed; the step-up's proof is added by audit(). One function, so it
 * can move to the shared access-change module (#289) without touching the callers.
 */
export function recordModuleAccessChange(c: ModuleAccessChange): void {
  const name = moduleDef(c.module).name;
  const what =
    c.after.mode === 'everyone'
      ? 'everyone signed in'
      : `selected teams and users${c.after.subjects.length ? ` (${c.after.subjects.join(', ')})` : ' (administrators and auditors only)'}`;
  const roles = (c.roles ?? []).map((r) => `${r.subject} ${r.before ?? '–'} → ${r.after ?? '–'}`);
  auditAccessChange({
    action: 'access.module_access_changed',
    entityType: 'settings',
    entityId: `module:${c.module}`,
    summary: `Who uses the module "${name}": ${what}${c.before.mode !== c.after.mode ? ` (was: ${c.before.mode === 'everyone' ? 'everyone signed in' : 'selected teams and users'})` : ''}${roles.length ? `; module roles ${roles.join(', ')}` : ''}`,
    details: {
      module: c.module,
      mode: { before: c.before.mode, after: c.after.mode },
      granted: c.granted,
      removed: c.removed,
      ...(c.roles?.length ? { roles: c.roles } : {}),
      ...(c.via ? { via: c.via } : {}),
    },
  });
}

/** Sets a module's access and module roles (administrators; the route asks for the step-up when it widens). Audited; nothing for no change. */
export function setModuleAccess(id: ModuleId, input: ModuleAccessInput): ModuleAccessView {
  settable(id, input);
  const u = me();
  const beforeMode = moduleAccessMode(id);
  const before = adminGrants(id);
  const after = grantsOfInput(input);
  // only users and teams that exist; a grant the module has already stays accepted (a deleted team)
  assertKnownSubjects([...after.keys()], [...before.keys()]);
  const listed = (mode: ModuleAccessMode, g: Map<string, ModuleRole | null>) => (mode === 'selected' ? [...g.keys()] : [...g].filter(([, r]) => r).map(([s]) => s));
  const beforeSubjects = listed(beforeMode, before);
  const afterSubjects = listed(input.mode, after);
  const granted = afterSubjects.filter((s) => !beforeSubjects.includes(s));
  const removed = beforeSubjects.filter((s) => !afterSubjects.includes(s));
  const roles = [...new Set([...before.keys(), ...after.keys()])]
    .map((subject) => ({ subject, before: before.get(subject) ?? null, after: after.get(subject) ?? null }))
    .filter((r) => r.before !== r.after && (r.before || r.after));
  const stale = [...before.keys()].filter((s) => !after.has(s));
  if (beforeMode === input.mode && !granted.length && !removed.length && !roles.length && !stale.length) return moduleAccessView(id);
  // a widening is confirmed here as well as by the route's rule, before anything is written (ADR 0033 part 5)
  if (moduleAccessWidens(id, input)) requireAccessGrant(u);
  const now = nowIso();
  db().tx(() => {
    if (moduleRestrictable(id))
      db().run(
        `INSERT INTO module_access (module_id, mode, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (module_id) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        id,
        input.mode,
        u.username,
        now,
      );
    // the administrators' grants become the input's (single sign-on's stay: they are synchronised at each sign-in)
    for (const s of before.keys())
      if (!after.has(s) || after.get(s) !== before.get(s))
        db().run("DELETE FROM module_grants WHERE module_id = ? AND lower(subject) = ? AND (source IS NULL OR source <> 'sso')", id, s);
    for (const [s, role] of after)
      if (!before.has(s) || before.get(s) !== role)
        db().run(
          'INSERT INTO module_grants (id, module_id, subject, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          newId('mg_'),
          id,
          s,
          role,
          u.username,
          now,
        );
    recordModuleAccessChange({
      module: id,
      before: { mode: beforeMode, subjects: beforeSubjects },
      after: { mode: input.mode, subjects: afterSubjects },
      granted,
      removed,
      ...(roles.length ? { roles } : {}),
    });
  });
  forgetModuleAccess();
  return moduleAccessView(id);
}
