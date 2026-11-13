import { higherModuleRole, isModuleRole, moduleRestrictable, moduleRolesOf, type ModuleId, type ModuleRole } from '@sm/shared';
import { db } from '../db.js';
import { newId, nowIso } from '../util.js';
import { forgetModulePolicy } from './grants.js';
import { recordModuleAccessChange } from './access-audit.js';

/** Who uses a module now, read without the registry (auth/sso.ts imports this module: no route layer here). */
const modeOf = (id: ModuleId): 'everyone' | 'selected' =>
  moduleRestrictable(id) && db().get<{ mode: string }>('SELECT mode FROM module_access WHERE module_id = ?', id)?.mode === 'selected' ? 'selected' : 'everyone';

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
    const mode = modeOf(id);
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
