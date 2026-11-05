import type { z } from 'zod';
import type { PlantAssignmentValues, PlantAssignmentView, PlantKpiInstance, PlantResultLink } from '@sm/shared';
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
import { briefOf } from './catalogue.js';
import {
  allKpis,
  assignmentInput,
  assignmentProblems,
  assignmentRowOf,
  assignmentValuesOf,
  cleanParams,
  kpiRowOf,
  profileRowOf,
  profileValuesOf,
  removeAssignmentRow,
  upsertAssignment,
} from './data-model.js';
import { assignmentChecks, canHave } from './checks.js';

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
  const pr = a?.profileId ? profileRowOf(a.profileId) : undefined;
  const profile = pr ? profileValuesOf(pr) : null;
  const kpis = allKpis();
  const brief = briefOf(row, site);
  const subject = { kind: 'asset' as const, id: row.id, name: row.name, siteId: row.site_id };
  const profiles = new Map(profile ? [[profile.id, profile]] : []);
  const empty: PlantAssignmentValues = { profileId: null, firmware: '', interfaces: [], overrides: [], publications: [], kpis: [], notes: '' };
  const have = new Set((a?.kpis ?? []).map((k) => k.kpi));
  return {
    asset: brief,
    assignment: a,
    profile,
    kpis: (a?.kpis ?? []).map((k) => {
      const d = kpis.get(k.kpi);
      return { ...k, definition: d ? { id: d.id, name: d.name, names: d.names, category: d.category } : null, results: results(k) };
    }),
    checks: a ? assignmentChecks(subject, a, profiles, kpis) : [],
    possibleKpis: [...kpis.values()]
      .filter((d) => canHave(d, a ?? empty, profile ?? undefined))
      .map((d) => ({ id: d.id, name: d.name, names: d.names, category: d.category, instantiated: have.has(d.id) })),
    canManage: perms.includes('manage'),
    importId: r?.import_id ?? null,
    notInSource: !!r?.not_in_source,
    updatedAt: r?.updated_at ?? null,
    updatedBy: r?.updated_by ?? null,
  };
}

const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));

export function putAssignment(assetId: string, input: z.infer<typeof assignmentInput>): PlantAssignmentView {
  const cur = visibleAsset(assetId);
  requireManage(cur.perms, 'change this asset');
  const v: PlantAssignmentValues = { ...input, kpis: input.kpis.map((k) => ({ ...k, params: cleanParams(k.params) })) };
  const pr = v.profileId ? profileRowOf(v.profileId) : undefined;
  const problems = assignmentProblems(v, pr ? profileValuesOf(pr) : null, (id) => !!kpiRowOf(id));
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
