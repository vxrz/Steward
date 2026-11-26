import type { PlantBlueprintCoverage, PlantBlueprintKpiGap } from '@sm/shared';
import { allAssignments, allProfiles } from './data-model.js';
import { assetModel } from './resolve.js';
import { collectedPoints } from './potential.js';
import type { CatalogueScope } from './catalogue-access.js';
import { coverageOf, indexBySignal, pointsOfInterfaces, signalsForReader, type Indexed } from './blueprints.js';
import * as store from './blueprint-store.js';

/**
 * Machine blueprints read for many assets at once (0.30.0 step 2, ADR 0041): the site matrix and the KPI views. The
 * assignments, mappings and marks are read once; every blueprint is one the reader may see, with the links to KPI
 * definitions the reader may see – nothing hidden is named or counted.
 */

export interface BlueprintSource {
  /** The coverage of an asset by the blueprints it has (directly or through its profile), in the order of their names */
  of(assetId: string): PlantBlueprintCoverage[];
}

export function blueprintSource(assetIds: Set<string>, scope: CatalogueScope, only?: string): BlueprintSource {
  const blueprints = store
    .allBlueprints()
    .filter((b) => scope.blueprint(b.row.id) && (!only || b.row.id === only))
    .map((b) => ({ ...b.values, signals: signalsForReader(b.values.signals, scope) }));
  const assigned = store.allAssignments();
  const mappings = store.allMappings();
  const marks = store.allMarks();
  const assignments = allAssignments();
  const profiles = allProfiles();
  const collected = collectedPoints(assetIds);
  const memo = new Map<string, PlantBlueprintCoverage[]>();
  // the mappings and marks of a target are indexed once (a profile's serve all its assets)
  const mapIndex = new Map<string, Indexed<store.StoredMapping>>();
  const markIndex = new Map<string, Indexed<store.StoredMark>>();
  const mapsOf = (t: store.TargetKey) => {
    const k = store.targetKey(t);
    let by = mapIndex.get(k);
    if (!by) mapIndex.set(k, (by = indexBySignal(mappings.get(k) ?? [])));
    return { list: mappings.get(k) ?? [], by };
  };
  const marksOf = (t: store.TargetKey) => {
    const k = store.targetKey(t);
    let by = markIndex.get(k);
    if (!by) markIndex.set(k, (by = indexBySignal(marks.get(k) ?? [])));
    return { list: marks.get(k) ?? [], by };
  };
  return {
    of(assetId) {
      const hit = memo.get(assetId);
      if (hit) return hit;
      const a = assignments.get(assetId);
      const profile = a?.profileId ? profiles.get(a.profileId) : undefined;
      const own = { kind: 'asset' as const, id: assetId };
      const prof = profile && a?.profileId ? { kind: 'profile' as const, id: a.profileId } : null;
      const direct = new Set(assigned.get(store.targetKey(own)) ?? []);
      const viaProfile = new Set(prof ? (assigned.get(store.targetKey(prof)) ?? []) : []);
      const out: PlantBlueprintCoverage[] = [];
      if (direct.size || viaProfile.size) {
        const ctx = { points: pointsOfInterfaces(assetModel(a ?? null, profile ?? null).interfaces), collected: collected.get(assetId) ?? new Set<string>() };
        const m = [...(prof ? [{ source: 'profile' as const, ...mapsOf(prof) }] : []), { source: 'asset' as const, ...mapsOf(own) }];
        const k = [...(prof ? [{ on: 'profile' as const, ...marksOf(prof) }] : []), { on: 'asset' as const, ...marksOf(own) }];
        for (const b of blueprints) {
          if (!direct.has(b.id) && !viaProfile.has(b.id)) continue;
          out.push(
            coverageOf(b, direct.has(b.id) && viaProfile.has(b.id) ? 'both' : direct.has(b.id) ? 'direct' : 'profile', m, k, ctx, { suggestions: false }),
          );
        }
      }
      memo.set(assetId, out);
      return out;
    },
  };
}

/** KPI definition id → the signals (of blueprints the reader may see) that feed it. Empty while no signal links a KPI. */
export function kpiLinks(
  scope: CatalogueScope,
): Map<string, { blueprint: { id: string; name: string }; signal: { id: string; name: string; importance: 'must' | 'should' | 'nice' } }[]> {
  const out = new Map<string, { blueprint: { id: string; name: string }; signal: { id: string; name: string; importance: 'must' | 'should' | 'nice' } }[]>();
  for (const b of store.allBlueprints()) {
    if (!scope.blueprint(b.row.id)) continue;
    for (const s of signalsForReader(b.values.signals, scope))
      for (const k of s.kpis) {
        const l = out.get(k) ?? [];
        l.push({ blueprint: { id: b.row.id, name: b.row.name }, signal: { id: s.id, name: s.name, importance: s.importance } });
        out.set(k, l);
      }
  }
  return out;
}

/** The linked signals of one KPI definition that are missing (or not collected) on an asset. */
export function kpiGaps(links: ReturnType<typeof kpiLinks>, kpiId: string, covered: PlantBlueprintCoverage[]): PlantBlueprintKpiGap[] {
  const wanted = links.get(kpiId);
  if (!wanted?.length) return [];
  const out: PlantBlueprintKpiGap[] = [];
  for (const c of covered)
    for (const s of c.signals)
      if ((s.state === 'missing' || s.state === 'notCollected') && s.signal.kpis.includes(kpiId))
        out.push({ blueprint: { id: c.blueprint.id, name: c.blueprint.name }, signal: { id: s.signal.id, name: s.signal.name }, state: s.state });
  return out;
}
