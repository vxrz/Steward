import { moduleDef, type ModuleAccessMode, type ModuleId, type ModuleRole } from '@sm/shared';
import { audit } from '../audit.js';

/**
 * The audit entry of a change of module access and module roles (ADR 0034 part 7), on its own so the dialog
 * (access-change.ts), the user form and single sign-on (user-roles.ts) write the same entry without importing each other.
 */

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
  // an entry of the access family (auth/access-change.ts auditAccessChange: the step-up's proof is attached by audit())
  audit({
    action: 'access.module_access_changed',
    entityType: 'settings',
    entityId: `module:${c.module}`,
    summary:
      `Who uses the module "${name}": ${what}${c.before.mode !== c.after.mode ? ` (was: ${c.before.mode === 'everyone' ? 'everyone signed in' : 'selected teams and users'})` : ''}${roles.length ? `; module roles ${roles.join(', ')}` : ''}`.slice(
        0,
        500,
      ),
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
