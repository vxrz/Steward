import type { PlantChange, PlantImportProblem } from '@sm/shared';
import { db } from '../db.js';
import { HttpError } from '../util.js';
import type { BlueprintFile, PlantFile } from './format.js';
import { applyTargetBlueprints, importBlueprint, type TargetBlueprints } from './blueprints.js';

/**
 * Machine blueprints in the plant import format (0.30.0, ADR 0041): the document kind `blueprint:` / `blueprints:`, and the
 * keys `blueprints`, `blueprint_mappings` and `blueprint_not_applicable` of a device profile and of an asset's assignment.
 * Blueprints are written first, then what profiles and assets say about them. Blueprints take no part in the id mapping,
 * the "not in source" marks or removal by import; a name that leads nowhere is a warning.
 */

interface Origin {
  file: string;
  path: string;
}

export interface BlueprintPlan {
  docs: Map<string, Origin & { value: BlueprintFile }>;
  targets: Map<string, Origin & { kind: 'profile' | 'asset'; id: string; keys: TargetBlueprints }>;
}

export const emptyBlueprintPlan = (): BlueprintPlan => ({ docs: new Map(), targets: new Map() });
export const blueprintPlanEmpty = (p: BlueprintPlan) => !p.docs.size && !p.targets.size;

type Keys = Pick<NonNullable<PlantFile['device_profile']>, 'blueprints' | 'blueprint_mappings' | 'blueprint_not_applicable'>;

const keysOf = (x: Keys): TargetBlueprints => ({
  ...(x.blueprints ? { blueprints: x.blueprints } : {}),
  ...(x.blueprint_mappings ? { mappings: x.blueprint_mappings.map((m) => ({ blueprint: m.blueprint, signal: m.signal, dataPoints: m.data_points })) } : {}),
  ...(x.blueprint_not_applicable ? { marks: x.blueprint_not_applicable } : {}),
});
const hasKeys = (x: Keys) => !!(x.blueprints || x.blueprint_mappings || x.blueprint_not_applicable);

/** Whether an assignment of a file says nothing but blueprints (it then writes no assignment of the asset). */
export const blueprintOnly = (a: Record<string, unknown>): boolean =>
  Object.keys(a).some((k) => k.startsWith('blueprint')) &&
  Object.keys(a).every((k) => ['asset', 'site', 'blueprints', 'blueprint_mappings', 'blueprint_not_applicable'].includes(k));

export function planBlueprints(p: BlueprintPlan, f: PlantFile, file: string, problems: PlantImportProblem[]): void {
  const docs: [BlueprintFile, string][] = f.blueprint ? [[f.blueprint, 'blueprint']] : (f.blueprints ?? []).map((x, i) => [x, `blueprints[${i}]`]);
  for (const [x, path] of docs) {
    const first = p.docs.get(x.id);
    if (first) problems.push({ file, path, message: `Machine blueprint "${x.id}" is defined twice (also in ${first.file} at ${first.path})` });
    else p.docs.set(x.id, { file, path, value: x });
  }
  const profiles = f.device_profile
    ? [[f.device_profile, 'device_profile'] as const]
    : (f.device_profiles ?? []).map((x, i) => [x, `device_profiles[${i}]`] as const);
  for (const [x, path] of profiles) if (hasKeys(x)) p.targets.set(`profile:${x.id}`, { file, path, kind: 'profile', id: x.id, keys: keysOf(x) });
  const assignments = f.assignment ? [[f.assignment, 'assignment'] as const] : (f.assignments ?? []).map((x, i) => [x, `assignments[${i}]`] as const);
  for (const [x, path] of assignments) if (hasKeys(x)) p.targets.set(`asset:${x.asset}`, { file, path, kind: 'asset', id: x.asset, keys: keysOf(x) });
}

export interface BlueprintCounts {
  added: number;
  changed: number;
  unchanged: number;
  /** Profiles and assets whose blueprints, mappings or marks the files changed */
  targets: number;
  /** 0.30.0 step 2: the entries as the preview lists them (kind `blueprint`, and `blueprint_use` for a profile or asset) */
  changes: PlantChange[];
  /** Not-applicable marks the files set or cleared (a person's decision: an assistant's proposal may not) */
  marks: number;
}

const refuse = (e: unknown, o: Origin, problems: PlantImportProblem[]): void => {
  if (e instanceof HttpError) problems.push({ ...o, message: e.message });
  else throw e;
};

/** Writes the plan (inside the import's transaction; a preview rolls it back). */
export function applyBlueprintPlan(p: BlueprintPlan, importId: string, problems: PlantImportProblem[], warnings: PlantImportProblem[]): BlueprintCounts {
  const n: BlueprintCounts = { added: 0, changed: 0, unchanged: 0, targets: 0, changes: [], marks: 0 };
  for (const d of p.docs.values())
    try {
      const v = d.value;
      const r = importBlueprint(
        {
          id: v.id,
          name: v.name,
          ...(v.description != null ? { description: v.description } : {}),
          ...(v.reference != null ? { reference: v.reference } : {}),
          ...(v.version != null ? { version: v.version } : {}),
          ...(v.signals
            ? {
                signals: v.signals.map((s) => ({
                  id: s.id,
                  name: s.name,
                  meaning: s.meaning ?? '',
                  why: [...new Set(s.why ?? [])],
                  importance: s.importance ?? 'should',
                  aliases: [...new Set(s.aliases ?? [])],
                  kpis: [...new Set(s.kpis ?? [])],
                })),
              }
            : {}),
        },
        importId,
      );
      n[r.result]++;
      for (const message of r.warnings) warnings.push({ ...d, message });
      n.changes.push({
        kind: 'blueprint',
        action: r.result === 'added' ? 'add' : r.result === 'changed' ? 'change' : 'unchanged',
        siteId: '',
        id: v.id,
        name: r.name,
        ...(r.fields.length ? { fields: r.fields } : {}),
        ...(r.drops.length ? { drops: r.drops } : {}),
      });
    } catch (e) {
      refuse(e, d, problems);
    }
  for (const t of p.targets.values())
    try {
      const r = applyTargetBlueprints(t.kind, t.id, t.keys, importId);
      for (const message of r.messages) warnings.push({ file: t.file, path: t.path, message });
      if (r.changed) {
        n.targets++;
        n.marks += r.marks;
        n.changes.push({
          kind: 'blueprint_use',
          action: 'change',
          siteId: t.kind === 'asset' ? (db().get<{ site_id: string }>('SELECT site_id FROM plant_assets WHERE id = ?', t.id)?.site_id ?? '') : '',
          id: t.id,
          name: r.name,
          fields: r.fields,
          ...(r.drops.length ? { drops: r.drops } : {}),
        });
      }
    } catch (e) {
      // a profile or an asset that is not there (yet) is the import's own business: say so, name nothing else
      refuse(e, t, problems);
    }
  return n;
}
