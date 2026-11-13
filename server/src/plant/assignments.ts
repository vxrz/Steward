import type { z } from 'zod';
import {
  PLANT_HIDDEN,
  PLANT_HIDDEN_REF_RE,
  type PlantAssignmentValues,
  type PlantAssignmentView,
  type PlantKpiInstance,
  type PlantKpiValues,
  type PlantProfileValues,
  type PlantResolvedProfile,
  type PlantResultLink,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { currentUser } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { resolveTarget } from '../records/links.js';
import { getDatasetMeta } from '../dashboards/datasets.js';
import { builtinDatasetVisible } from '../dashboards/builtin.js';
import { permissionsFor } from '../processes/service.js';
import { HttpError, nowIso } from '../util.js';
import { requireManage } from './access.js';
import { changedKeys } from './model.js';
import { visibleAsset } from './service.js';
import { briefOf, visibleAssets } from './catalogue.js';
import {
  allKpis,
  allProfiles,
  assignmentInput,
  assignmentProblems,
  assignmentRowOf,
  assignmentValuesOf,
  cleanParams,
  kpiRowOf,
  removeAssignmentRow,
  resolvedProfile,
  templateMessage,
  upsertAssignment,
} from './data-model.js';
import { assignmentChecks, canHave, unitMismatches } from './checks.js';
import { collectedPoints, isCollected, partsByAsset } from './potential.js';
import { assetModel } from './resolve.js';
import { HiddenRefs, anonymousProfile, catalogueScope, presentKpis, presentProfiles, presentResolved, type CatalogueScope } from './catalogue-access.js';

/**
 * The assignment of an asset (#219): its device profile and controller firmware, per interface whether it is set up
 * and where, data points that differ on this asset, where data points are published, and its KPI instances. It
 * belongs to the asset: whoever may see the asset's site sees it, whoever manages the site changes it. Every change
 * is audited on the asset (asset.assignment_set, asset.assignment_removed).
 *
 * 0.21.0 (#293, decision 10): a profile the reader may not see stays the asset's model – its interfaces and data points
 * are shown as the asset's own, without the profile's name, id or bases (`profileHidden`); a KPI instance whose
 * definition is hidden shows "a KPI definition you may not see". Their placeholders (`~hidden-1`) keep them on save.
 */

/** Placeholders of the profiles an assignment names (the assigned one first, then its bases) and of its KPI definitions. */
function refsOf(a: PlantAssignmentValues | null, profile: PlantResolvedProfile | null, scope: CatalogueScope) {
  return {
    profiles: new HiddenRefs(scope.profile, [a?.profileId, ...(profile?.chain.slice(1) ?? [])]),
    kpis: new HiddenRefs(scope.kpi, (a?.kpis ?? []).map((k) => k.kpi)),
  };
}

/** The assigned profile as the reader may see it: its model; unnamed (and without its own part) when it is hidden. */
function shownProfile(profile: PlantResolvedProfile | null, refs: HiddenRefs): PlantProfileValues | null {
  if (!profile) return null;
  const p = presentResolved(profile, refs);
  const own: PlantProfileValues = {
    id: refs.ref(p.id),
    name: p.name,
    manufacturer: p.manufacturer,
    model: p.model,
    version: p.version,
    category: p.category,
    description: p.description,
    notes: p.notes,
    interfaces: p.interfaces,
    extends: p.extends,
    template: p.template,
    interfaceOverrides: p.interfaceOverrides,
    pointOverrides: p.pointOverrides,
  };
  return refs.hides(profile.id) ? { ...anonymousProfile(own), extends: null, interfaceOverrides: [], pointOverrides: [] } : own;
}

/** Where a KPI instance's result is shown, as the caller may see it. */
function results(k: PlantKpiInstance): PlantResultLink[] {
  const viewerOnly = plantOnly(currentUser());
  const out: PlantResultLink[] = [];
  if (k.dashboard) {
    const r = resolveTarget('dashboard', k.dashboard);
    out.push({ kind: 'dashboard', id: k.dashboard, label: r?.label ?? '', path: r && !viewerOnly ? r.path : null, visible: !!r });
  }
  if (k.dataset) {
    let visible: boolean;
    try {
      const meta = getDatasetMeta(k.dataset);
      visible = builtinDatasetVisible(meta.processId) ?? permissionsFor(meta.processId).includes('view');
    } catch {
      visible = false; // a dataset that does not exist (yet) or that the caller may not see reads the same
    }
    // a dataset's key is the reference itself (as written in the job's configuration): shown, linked only when visible
    out.push({ kind: 'dataset', id: k.dataset, label: k.dataset, path: visible && !viewerOnly ? '/dashboards' : null, visible });
  }
  return out;
}

export function getAssignment(assetId: string, scope: CatalogueScope = catalogueScope()): PlantAssignmentView {
  const { row, site, perms } = visibleAsset(assetId);
  const r = assignmentRowOf(assetId);
  const a = r ? assignmentValuesOf(r) : null;
  const profile = resolvedProfile(a?.profileId);
  const allDefs = allKpis();
  // the checks name what the reader may not see "~hidden"; everything is computed on the whole catalogue (part 4)
  const kpis = presentKpis(allDefs, scope);
  const model = assetModel(a, profile);
  const brief = briefOf(row, site);
  const subject = { kind: 'asset' as const, id: row.id, name: row.name, siteId: row.site_id };
  const refs = refsOf(a, profile, scope);
  // every profile resolved: a KPI input names a base whose units it expects (0.12.0)
  const profiles = presentProfiles(allProfiles(), scope);
  const empty: PlantAssignmentValues = {
    profileId: null,
    firmware: '',
    interfaces: [],
    overrides: [],
    additions: { interfaces: [], dataPoints: [] },
    publications: [],
    kpis: [],
    notes: '',
  };
  const have = new Set((a?.kpis ?? []).map((k) => k.kpi));
  const collected = collectedPoints(new Set([assetId])).get(assetId);
  return {
    asset: brief,
    assignment: a ? { ...a, profileId: refs.profiles.ref(a.profileId), kpis: a.kpis.map((k) => ({ ...k, kpi: refs.kpis.ref(k.kpi) })) } : null,
    profile: shownProfile(profile, refs.profiles),
    ...(profile && refs.profiles.hides(profile.id) ? { profileHidden: true } : {}),
    model: model.interfaces,
    added: { interfaces: [...model.added.interfaces], points: [...model.added.points] },
    kpis: (a?.kpis ?? []).map((k) => {
      const d = kpis.get(k.kpi);
      const hidden = refs.kpis.hides(k.kpi);
      return {
        ...k,
        kpi: refs.kpis.ref(k.kpi),
        definition: d ? { id: refs.kpis.ref(d.id), name: d.name, names: d.names, category: hidden ? '' : d.category, ...(hidden ? { hidden: true } : {}) } : null,
        results: results(k),
      };
    }),
    checks: a ? assignmentChecks(subject, a, profiles, kpis) : [],
    possibleKpis: [
      ...[...kpis.values()]
        .filter((d) => scope.kpi(d.id) && canHave(d, a ?? empty, profile ?? undefined))
        .map((d) => ({
          id: d.id,
          name: d.name,
          names: d.names,
          category: d.category,
          instantiated: have.has(d.id),
          // 0.12.0: inputs in another unit, and whether a data collection of the asset maps every input
          units: unitMismatches(d, a ?? empty, profile ?? undefined, profiles),
          collected: isCollected(d, collected, profile),
        })),
      ...rollUpCandidates(assetId, a ?? empty, profile ?? undefined, kpis, profiles, have, scope),
    ],
    canManage: perms.includes('manage'),
    importId: r?.import_id ?? null,
    notInSource: !!r?.not_in_source,
    ...(r ? { revision: Number(r.revision ?? 1) } : {}),
    updatedAt: r?.updated_at ?? null,
    updatedBy: r?.updated_by ?? null,
  };
}

/**
 * 0.13: the KPIs that roll up from parts (`rollUp: parts`) the asset cannot have itself, but a part of it (that the
 * reader may see) can – or has a job of: the asset's "KPIs it can have" lists them with the part (`via`).
 */
function rollUpCandidates(
  assetId: string,
  a: PlantAssignmentValues,
  profile: PlantResolvedProfile | undefined,
  kpis: Map<string, PlantKpiValues>,
  profiles: Map<string, PlantResolvedProfile>,
  have: Set<string>,
  scope: CatalogueScope,
): PlantAssignmentView['possibleKpis'] {
  const defs = [...kpis.values()].filter((d) => scope.kpi(d.id) && d.rollUp === 'parts' && !canHave(d, a, profile));
  if (!defs.length) return [];
  const parts = partsByAsset(new Set(visibleAssets().assets.keys())).get(assetId) ?? [];
  if (!parts.length) return [];
  const assignments = new Map<string, PlantAssignmentValues>();
  for (const p of parts) {
    const r = assignmentRowOf(p.id);
    if (r) assignments.set(p.id, assignmentValuesOf(r));
  }
  const collected = collectedPoints(new Set(parts.map((p) => p.id)));
  const out: PlantAssignmentView['possibleKpis'] = [];
  for (const d of defs) {
    const options = parts.flatMap((part) => {
      const pa = assignments.get(part.id);
      const pp = pa?.profileId ? profiles.get(pa.profileId) : undefined;
      const job = !!pa?.kpis.some((k) => k.kpi === d.id);
      if (!pa || (!job && !canHave(d, pa, pp))) return [];
      return [{ part, job, units: unitMismatches(d, pa, pp, profiles), collected: isCollected(d, collected.get(part.id), pp) }];
    });
    const best = options.find((x) => x.job) ?? options.find((x) => x.collected) ?? options[0];
    if (!best) continue;
    out.push({
      id: d.id,
      name: d.name,
      names: d.names,
      category: d.category,
      instantiated: have.has(d.id) || best.job,
      units: best.units,
      collected: best.collected,
      via: best.part,
    });
  }
  return out;
}

const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));

export function putAssignment(assetId: string, input: z.infer<typeof assignmentInput>): PlantAssignmentView {
  const cur = visibleAsset(assetId);
  requireManage(cur.perms, 'change this asset');
  const scope = catalogueScope();
  const stored = assignmentRowOf(assetId);
  const was = stored ? assignmentValuesOf(stored) : null;
  const refs = refsOf(was, resolvedProfile(was?.profileId), scope);
  // 0.21.0 (#293): placeholders keep the hidden profile and KPI definitions they stand for; a hidden entry the asset did
  // not have reads like one that does not exist (the same refusal as an unknown id)
  const v: PlantAssignmentValues = {
    ...input,
    profileId: input.profileId ? keptOrUnknown(input.profileId, refs.profiles) : null,
    kpis: input.kpis.map((k) => ({ ...k, kpi: keptOrUnknown(k.kpi, refs.kpis), params: cleanParams(k.params) })),
  };
  const known = (id: string, visible: (id: string) => boolean, kept: HiddenRefs) => visible(id) || kept.hides(id);
  const profile = v.profileId && known(v.profileId, scope.profile, refs.profiles) ? resolvedProfile(v.profileId) : null;
  // 0.12.0: a template is only for other profiles to extend
  if (profile?.template) {
    const shown = refs.profiles.hides(profile.id) ? PLANT_HIDDEN : profile.name;
    throw new HttpError(400, templateMessage(shown), 'PLANT_PROFILE_TEMPLATE', { profile: refs.profiles.ref(profile.id), name: shown });
  }
  const problems = assignmentProblems(v, profile, (id) => !!kpiRowOf(id) && known(id, scope.kpi, refs.kpis));
  if (problems.length)
    throw new HttpError(400, `${problems[0]!.path}: ${problems[0]!.message}`, 'PLANT_ASSIGNMENT_INVALID', {
      path: problems[0]!.path,
      message: problems[0]!.message,
    });
  const before = was;
  const changes = before ? changedKeys(before, v) : Object.keys(v);
  if (before && !changes.length) return getAssignment(assetId);
  db().tx(() => {
    upsertAssignment(assetId, v, { at: nowIso(), by: me().username }, { keepSource: true });
    audit({
      action: 'asset.assignment_set',
      entityType: 'asset',
      entityId: assetId,
      summary: before
        ? `Assignment of asset "${cur.row.name}" changed (${changes.join(', ')})`
        : `Asset "${cur.row.name}" assigned${v.profileId ? ` device profile ${v.profileId}` : ''} with ${v.kpis.length} KPI instances`,
      details: { changes, old: before ? pick(before, changes) : null, new: pick(v, changes) },
    });
  });
  return getAssignment(assetId);
}

export function deleteAssignment(assetId: string): PlantAssignmentView {
  const cur = visibleAsset(assetId);
  requireManage(cur.perms, 'change this asset');
  const r = assignmentRowOf(assetId);
  if (r)
    db().tx(() => {
      removeAssignmentRow(assetId);
      audit({
        action: 'asset.assignment_removed',
        entityType: 'asset',
        entityId: assetId,
        summary: `Assignment of asset "${cur.row.name}" removed (profile ${r.profile_id ?? 'none'})`,
        details: { old: assignmentValuesOf(r) },
      });
    });
  return getAssignment(assetId);
}

/**
 * The id a form sends for a profile or KPI definition: a placeholder becomes the entry it stands for on this asset; an
 * unknown placeholder stays as sent (refused as an unknown id by the rules of the save).
 */
function keptOrUnknown(v: string, refs: HiddenRefs): string {
  if (!PLANT_HIDDEN_REF_RE.test(v)) return v;
  return refs.id(v) ?? v;
}

export { assignmentInput };
