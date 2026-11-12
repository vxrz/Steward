import {
  MODULE_ACCESS_LIMITS,
  MODULE_ACCESS_MODES,
  OWNED_KINDS,
  moduleDef,
  moduleRestrictable,
  type ModuleAccessInput,
  type ModuleAccessMode,
  type ModuleAccessPreview,
  type ModuleAccessView,
  type ModuleId,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { assertKnownSubjects, subjectExists } from '../auth/subjects.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { HttpError, newId, nowIso } from '../util.js';
import { forgetModuleAccess, moduleAccessMode, moduleGrantSubjects, usesWith } from './access.js';

/**
 * Changing who uses a module (0.21.0, ADR 0034 part 7): administrators, in a signed-in session; widening – opening a
 * restricted module or adding a team or user – asks for the step-up `grantAccess` (control point access.grant, see
 * modules/routes.ts); narrowing is confirmed in the dialog with the preview of who loses it. Every change is an access
 * change in the audit log (`access.module_access_changed`).
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
    grants: z.array(z.object({ subject }).strict()).max(MODULE_ACCESS_LIMITS.grants).default([]),
  })
  .strict();

function restrictable(id: ModuleId): void {
  if (!moduleRestrictable(id))
    throw new HttpError(400, `${moduleDef(id).name} cannot be restricted to selected teams and users`, 'MODULE_NOT_RESTRICTABLE', { module: id });
}

interface GrantRow {
  subject: string;
  created_by: string;
  created_at: string;
}

/** GET /api/settings/modules/:id/access */
export function moduleAccessView(id: ModuleId): ModuleAccessView {
  const row = db().get<{ updated_by: string; updated_at: string }>('SELECT updated_by, updated_at FROM module_access WHERE module_id = ?', id);
  const seen = new Set<string>();
  const grants = db()
    .all<GrantRow>('SELECT subject, created_by, created_at FROM module_grants WHERE module_id = ? ORDER BY subject, created_at', id)
    .filter((g) => !seen.has(g.subject.toLowerCase()) && !!seen.add(g.subject.toLowerCase()))
    .map((g) => ({ subject: g.subject, createdBy: g.created_by, createdAt: g.created_at, known: subjectExists(g.subject) }));
  return {
    module: id,
    restrictable: moduleRestrictable(id),
    mode: moduleAccessMode(id),
    grants,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/** The subjects of an input: lower case, each once; none while the module is open to everyone. */
function subjectsOf(input: ModuleAccessInput): string[] {
  if (input.mode === 'everyone') return [];
  return [...new Set(input.grants.map((g) => g.subject.trim().toLowerCase()))];
}

const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());

/** Whether a change widens who uses the module: opening it, or naming a team or user that is not on its list. */
export function moduleAccessWidens(id: ModuleId, input: ModuleAccessInput): boolean {
  const mode = moduleAccessMode(id);
  if (mode === 'everyone') return false; // open already: restricting only narrows
  if (input.mode === 'everyone') return true;
  const before = new Set(lower(moduleGrantSubjects(id)));
  return subjectsOf(input).some((s) => !before.has(s));
}

/** Who gains and who loses use of the module, and the teams owning its items that would not use it – nothing changed. */
export function previewModuleAccess(id: ModuleId, input: ModuleAccessInput): ModuleAccessPreview {
  restrictable(id);
  const mode = moduleAccessMode(id);
  const before = moduleGrantSubjects(id);
  const after = subjectsOf(input);
  const gains: ModuleAccessPreview['gains'] = [];
  const loses: ModuleAccessPreview['loses'] = [];
  for (const u of listUsers().filter((x) => x.active)) {
    const au = toAuthUser(u);
    const was = usesWith(au, mode, before);
    const will = usesWith(au, input.mode, after);
    if (was !== will) (will ? gains : loses).push({ username: u.username, displayName: u.displayName });
  }
  // teams that own items of the module (owning-team kinds among its item kinds) but would not use it
  const kinds = (moduleDef(id).access?.itemKinds ?? []).filter((k) => (OWNED_KINDS as readonly string[]).includes(k));
  const owningTeamsWithout =
    input.mode === 'selected' && kinds.length
      ? db()
          .all<{ name: string }>(
            `SELECT DISTINCT t.name FROM resource_teams rt JOIN teams t ON t.id = rt.team_id WHERE rt.kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY t.name`,
            ...kinds,
          )
          .map((t) => t.name)
          .filter((n) => !after.includes(`team:${n.toLowerCase()}`))
      : [];
  return { module: id, widens: moduleAccessWidens(id, input), gains, loses, owningTeamsWithout };
}

export interface ModuleAccessChange {
  module: ModuleId;
  before: { mode: ModuleAccessMode; subjects: string[] };
  after: { mode: ModuleAccessMode; subjects: string[] };
  granted: string[];
  removed: string[];
}

/**
 * The audit entry of a change of module access, in the family of access changes (ADR 0033): mode before and after,
 * who was granted and removed; the step-up's proof is added by audit(). One function, so it can move to the shared
 * access-change module (#289) without touching the callers.
 */
export function recordModuleAccessChange(c: ModuleAccessChange): void {
  const name = moduleDef(c.module).name;
  const what =
    c.after.mode === 'everyone'
      ? 'everyone signed in'
      : `selected teams and users${c.after.subjects.length ? ` (${c.after.subjects.join(', ')})` : ' (administrators and auditors only)'}`;
  audit({
    action: 'access.module_access_changed',
    entityType: 'settings',
    entityId: `module:${c.module}`,
    summary: `Who uses the module "${name}": ${what}${c.before.mode !== c.after.mode ? ` (was: ${c.before.mode === 'everyone' ? 'everyone signed in' : 'selected teams and users'})` : ''}`,
    details: { module: c.module, mode: { before: c.before.mode, after: c.after.mode }, granted: c.granted, removed: c.removed },
  });
}

/** Sets a module's access (administrators; the route asks for the step-up when it widens). Audited; nothing for no change. */
export function setModuleAccess(id: ModuleId, input: ModuleAccessInput): ModuleAccessView {
  restrictable(id);
  const u = me();
  const beforeMode = moduleAccessMode(id);
  const beforeSubjects = [...new Set(lower(moduleGrantSubjects(id)))];
  // only users and teams that exist; a grant the module has already stays accepted (a deleted team)
  assertKnownSubjects(subjectsOf(input), beforeSubjects);
  const after = subjectsOf(input);
  const granted = after.filter((s) => !beforeSubjects.includes(s));
  const removed = beforeMode === 'selected' ? beforeSubjects.filter((s) => !after.includes(s)) : [];
  if (beforeMode === input.mode && !granted.length && !removed.length) return moduleAccessView(id);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO module_access (module_id, mode, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (module_id) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      id,
      input.mode,
      u.username,
      now,
    );
    // opened to everyone: the list goes (restricting again starts from the teams and users named then)
    for (const s of input.mode === 'everyone' ? beforeSubjects : removed)
      db().run('DELETE FROM module_grants WHERE module_id = ? AND lower(subject) = ?', id, s);
    for (const s of granted)
      db().run(
        'INSERT INTO module_grants (id, module_id, subject, role, created_by, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
        newId('mg_'),
        id,
        s,
        u.username,
        now,
      );
    recordModuleAccessChange({
      module: id,
      before: { mode: beforeMode, subjects: beforeMode === 'selected' ? beforeSubjects : [] },
      after: { mode: input.mode, subjects: after },
      granted,
      removed,
    });
  });
  forgetModuleAccess();
  return moduleAccessView(id);
}
