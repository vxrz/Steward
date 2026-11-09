import type { z } from 'zod';
import type { PlantAssignmentValues, PlantAssignmentView, PlantKpiInstance, PlantKpiValues, PlantResolvedProfile, PlantResultLink } from '@sm/shared';
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

/**
 * The assignment of an asset (#219): its device profile and controller firmware, per interface whether it is set up
 * and where, data points that differ on this asset, where data points are published, and its KPI instances. It
 * belongs to the asset: whoever may see the asset's site sees it, whoever manages the site changes it. Every change
 * is audited on the asset (asset.assignment_set, asset.assignment_removed).
 */

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

export function getAssignment(assetId: string): PlantAssignmentView {
  const { row, site, perms } = visibleAsset(assetId);
  const r = assignmentRowOf(assetId);
  const a = r ? assignmentValuesOf(r) : null;
  const profile = resolvedProfile(a?.profileId);
  const kpis = allKpis();
  const model = assetModel(a, profile);
  const brief = briefOf(row, site);
  const subject = { kind: 'asset' as const, id: row.id, name: row.name, siteId: row.site_id };
  // every profile resolved: a KPI input names a base whose units it expects (0.12.0)
  const profiles = allProfiles();
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
    assignment: a,
    profile,
    model: model.interfaces,
    added: { interfaces: [...model.added.interfaces], points: [...model.added.points] },
    kpis: (a?.kpis ?? []).map((k) => {
      const d = kpis.get(k.kpi);
      return { ...k, definition: d ? { id: d.id, name: d.name, names: d.names, category: d.category } : null, results: results(k) };
    }),
    checks: a ? assignmentChecks(subject, a, profiles, kpis) : [],
    possibleKpis: [
      ...[...kpis.values()]
        .filter((d) => canHave(d, a ?? empty, profile ?? undefined))
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
      ...rollUpCandidates(assetId, a ?? empty, profile ?? undefined, kpis, profiles, have),
    ],
    canManage: perms.includes('manage'),
    importId: r?.import_id ?? null,
    notInSource: !!r?.not_in_source,
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
): PlantAssignmentView['possibleKpis'] {
  const defs = [...kpis.values()].filter((d) => d.rollUp === 'parts' && !canHave(d, a, profile));
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
  const v: PlantAssignmentValues = { ...input, kpis: input.kpis.map((k) => ({ ...k, params: cleanParams(k.params) })) };
  const profile = resolvedProfile(v.profileId);
  // 0.12.0: a template is only for other profiles to extend
  if (profile?.template) throw new HttpError(400, templateMessage(profile.name), 'PLANT_PROFILE_TEMPLATE', { profile: profile.id, name: profile.name });
  const problems = assignmentProblems(v, profile, (id) => !!kpiRowOf(id));
  if (problems.length)
    throw new HttpError(400, `${problems[0]!.path}: ${problems[0]!.message}`, 'PLANT_ASSIGNMENT_INVALID', {
      path: problems[0]!.path,
      message: problems[0]!.message,
    });
  const r = assignmentRowOf(assetId);
  const before = r ? assignmentValuesOf(r) : null;
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

export { assignmentInput };
