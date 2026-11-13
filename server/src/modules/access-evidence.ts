import { MODULES, isModuleId, moduleDef, moduleRestrictable, type ModuleAccessMode, type ModuleId } from '@sm/shared';
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
  current: { module: ModuleId; name: string; subjects: string[]; updatedAt: string | null; updatedBy: string | null }[];
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
    /** Confirmed with the step-up access.grant (a widening); a narrowing is confirmed in the dialog only */
    confirmed: boolean;
  }[];
  /** Entries that failed their check (left out) */
  rejected: number;
  truncated: boolean;
}

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
const modeOf = (x: unknown): ModuleAccessMode => (x === 'selected' ? 'selected' : 'everyone');

export function moduleAccessEvidence(from: string, to: string): ModuleAccessEvidence {
  const current = MODULES.filter((m) => moduleRestrictable(m.id))
    .map((m) => moduleAccessView(m.id))
    .filter((v) => v.mode === 'selected')
    .map((v) => ({
      module: v.module,
      name: moduleDef(v.module).name,
      subjects: v.grants.map((g) => g.subject),
      updatedAt: v.updatedAt,
      updatedBy: v.updatedBy,
    }));
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
      confirmed: Array.isArray(d.assurance) && d.assurance.some((p) => (p as { point?: string } | null)?.point === 'access.grant'),
    });
  }
  return { current, changes, rejected, truncated: rows.length >= MODULE_ACCESS_EVIDENCE_LIMIT };
}
