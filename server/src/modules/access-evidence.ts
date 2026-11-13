import {
  MODULES,
  isModuleId,
  isModuleRole,
  moduleDef,
  moduleRestrictable,
  moduleRolesOf,
  type ModuleAccessMode,
  type ModuleGrantSource,
  type ModuleId,
  type ModuleRole,
} from '@sm/shared';
import { authenticRows } from '../audit.js';
import { parseJson } from '../util.js';
import { moduleAccessView } from './access-change.js';

/**
 * Module access as evidence (ADR 0034 part 7): who uses each restricted module now, and every change of module access in
 * a period – read from the authentic entries of the audit log (`access.module_access_changed`), so a changed or deleted
 * entry is left out and counted. Read by the assurance report (and with it evidence packs that include it) and written
 * into every evidence pack of an auditor or administrator (`access/module-access.json`).
 */

export const MODULE_ACCESS_EVIDENCE_LIMIT = 5000;

export interface ModuleAccessEvidence {
  /** The modules restricted to selected teams and users now (the others: everyone signed in) */
  current: {
    module: ModuleId;
    name: string;
    /** Restricted to selected teams and users (false: open, listed for its module roles) */
    restricted?: boolean;
    subjects: string[];
    /** The module roles given (0.23.0): subject, role and whether single sign-on keeps it */
    roles?: { subject: string; role: ModuleRole; source: ModuleGrantSource }[];
    updatedAt: string | null;
    updatedBy: string | null;
  }[];
  /** The changes in the period, oldest first */
  changes: {
    seq: number;
    at: string;
    actor: string;
    module: ModuleId;
    name: string;
    before: ModuleAccessMode;
    after: ModuleAccessMode;
    granted: string[];
    removed: string[];
    /** Module roles given, changed or taken (0.23.0) */
    roles?: { subject: string; before: ModuleRole | null; after: ModuleRole | null }[];
    /** Where the change was made when not in the access dialog: the user form, single sign-on, the role "plant" */
    via?: string;
    /** Confirmed with the step-up access.grant (a widening); a narrowing is confirmed in the dialog only */
    confirmed: boolean;
  }[];
  /** Entries that failed their check (left out) */
  rejected: number;
  truncated: boolean;
}

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
const modeOf = (x: unknown): ModuleAccessMode => (x === 'selected' ? 'selected' : 'everyone');
const roleOf = (x: unknown): ModuleRole | null => (isModuleRole(x) ? x : null);
const roleChanges = (x: unknown[]): { subject: string; before: ModuleRole | null; after: ModuleRole | null }[] =>
  x
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { subject?: unknown }).subject === 'string')
    .map((r) => ({ subject: r.subject as string, before: roleOf(r.before), after: roleOf(r.after) }));

export function moduleAccessEvidence(from: string, to: string): ModuleAccessEvidence {
  const current = MODULES.filter((m) => moduleRestrictable(m.id) || moduleRolesOf(m.id).length > 0)
    .map((m) => moduleAccessView(m.id))
    .filter((v) => v.mode === 'selected' || v.grants.some((g) => g.role))
    .map((v) => {
      const roles = v.grants.filter((g) => g.role).map((g) => ({ subject: g.subject, role: g.role!, source: g.source }));
      return {
        module: v.module,
        name: moduleDef(v.module).name,
        restricted: v.mode === 'selected',
        subjects: v.mode === 'selected' ? [...new Set(v.grants.map((g) => g.subject))] : [],
        ...(roles.length ? { roles } : {}),
        updatedAt: v.updatedAt,
        updatedBy: v.updatedBy,
      };
    });
  const { rows, rejected } = authenticRows("action = 'access.module_access_changed' AND ts >= ? AND ts <= ?", [from, to], {
    ascending: true,
    limit: MODULE_ACCESS_EVIDENCE_LIMIT,
    ownOnly: true,
  });
  const changes: ModuleAccessEvidence['changes'] = [];
  for (const r of rows) {
    const d = parseJson<Record<string, unknown>>(r.details, {});
    if (!isModuleId(d.module)) continue;
    const mode = (d.mode ?? {}) as { before?: unknown; after?: unknown };
    changes.push({
      seq: Number(r.seq),
      at: r.ts,
      actor: r.actor,
      module: d.module,
      name: moduleDef(d.module).name,
      before: modeOf(mode.before),
      after: modeOf(mode.after),
      granted: strings(d.granted),
      removed: strings(d.removed),
      ...(Array.isArray(d.roles) ? { roles: roleChanges(d.roles) } : {}),
      ...(typeof d.via === 'string' ? { via: d.via } : {}),
      confirmed: Array.isArray(d.assurance) && d.assurance.some((p) => (p as { point?: string } | null)?.point === 'access.grant'),
    });
  }
  return { current, changes, rejected, truncated: rows.length >= MODULE_ACCESS_EVIDENCE_LIMIT };
}
