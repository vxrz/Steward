import {
  BLUEPRINT_IMPORTANCES,
  PLANT_HIDDEN,
  PLANT_VIEW_LIMITS,
  type BlueprintImportance,
  type BlueprintState,
  type PlantBlueprintImportanceTotals,
  type PlantKpiBlueprints,
  type PlantBlueprintMatrix,
  type PlantBlueprintMatrixRow,
  type PlantBlueprintTotals,
} from '@sm/shared';
import { requirePlant } from './settings.js';
import { loadAllIndexes } from './model.js';
import { visibleSite } from './service.js';
import { briefOf, kpiNotFound } from './catalogue.js';
import { allAssignments, allProfiles, kpiRowOf } from './data-model.js';
import { isOrExtends } from './resolve.js';
import { HiddenRefs, catalogueScope, presentProfiles, requireEntry, type CatalogueScope } from './catalogue-access.js';
import { names, visible } from './views.js';
import { noTotals, notFound } from './blueprints.js';
import { blueprintSource, kpiGaps, kpiLinks } from './blueprint-source.js';
import * as store from './blueprint-store.js';

/**
 * The site-wide matrix of machine blueprints (0.30.0 step 2, ADR 0041): assets by the blueprints they have, with the
 * coverage of their signals per importance – in the style of the KPI coverage matrix (views.ts). Team scope: only
 * blueprints, profiles and assets the reader may see are rows, columns or counted; a hidden blueprint is not even
 * counted. Advice only: nothing here changes a profile or an asset.
 */

export interface BlueprintMatrixFilter {
  site?: string;
  area?: string;
  profile?: string;
  blueprint?: string;
}

const emptyByImportance = (): PlantBlueprintImportanceTotals =>
  Object.fromEntries(BLUEPRINT_IMPORTANCES.map((i) => [i, noTotals()])) as PlantBlueprintImportanceTotals;

function add(into: PlantBlueprintTotals, t: PlantBlueprintTotals): void {
  for (const k of Object.keys(into) as (keyof PlantBlueprintTotals)[]) into[k] += t[k];
}
const addAll = (into: PlantBlueprintImportanceTotals, t: PlantBlueprintImportanceTotals): void => {
  for (const i of BLUEPRINT_IMPORTANCES) add(into[i], t[i]);
};

export function blueprintMatrix(f: BlueprintMatrixFilter, scope: CatalogueScope = catalogueScope()): PlantBlueprintMatrix {
  requirePlant();
  // a site the caller may not see reads like one that does not exist
  if (f.site) visibleSite(f.site);
  if (f.blueprint && (!store.blueprintRowOf(f.blueprint) || !scope.blueprint(f.blueprint))) throw notFound(f.blueprint);
  const v = visible();
  const profiles = presentProfiles(allProfiles(), scope);
  const assignments = allAssignments();
  const indexes = loadAllIndexes();
  let assets = v.assets;
  if (f.site) assets = assets.filter((a) => a.site_id === f.site);
  if (f.area) assets = assets.filter((a) => a.area_id === f.area);
  // a profile filter includes the profiles that extend it; one the caller may not see matches nothing, as an unknown one
  if (f.profile) {
    const wanted = f.profile;
    assets = scope.profile(wanted) ? assets.filter((a) => isOrExtends(profiles.get(assignments.get(a.id)?.profileId ?? ''), wanted)) : [];
  }
  const siteName = (id: string) => v.sites.get(id)?.name ?? '';
  assets = [...assets].sort((a, b) => siteName(a.site_id).localeCompare(siteName(b.site_id)) || (a.site_id < b.site_id ? -1 : a.site_id > b.site_id ? 1 : 0));
  const source = blueprintSource(new Set(assets.map((a) => a.id)), scope, f.blueprint);

  // the assets that have a blueprint the reader may see, and the columns they need (by name)
  const have = assets.map((asset) => ({ asset, covs: source.of(asset.id) })).filter((x) => x.covs.length);
  const columns = new Map<string, { id: string; name: string; assets: number; byImportance: PlantBlueprintImportanceTotals }>();
  for (const { covs } of have)
    for (const c of covs) {
      const col = columns.get(c.blueprint.id) ?? { id: c.blueprint.id, name: c.blueprint.name, assets: 0, byImportance: emptyByImportance() };
      columns.set(c.blueprint.id, col);
      col.assets++;
      addAll(col.byImportance, c.byImportance);
    }
  const blueprints = [...columns.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  const at = new Map(blueprints.map((b, i) => [b.id, i]));
  const maxRows = Math.min(PLANT_VIEW_LIMITS.coverageRows, Math.floor(PLANT_VIEW_LIMITS.coverageCells / Math.max(1, blueprints.length)));

  const totals = emptyByImportance();
  const groups = new Map<string, PlantBlueprintMatrix['groups'][number]>();
  const groupOf = (siteId: string, areaId: string | null) => {
    const key = `${siteId}\u0000${areaId ?? ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { siteId, areaId, assets: 0, byImportance: emptyByImportance() }));
    return g;
  };
  const rows: PlantBlueprintMatrixRow[] = [];
  for (const { asset, covs } of have) {
    const into = [groupOf(asset.site_id, null), ...(asset.area_id ? [groupOf(asset.site_id, asset.area_id)] : [])];
    const sum = emptyByImportance();
    for (const c of covs) addAll(sum, c.byImportance);
    addAll(totals, sum);
    for (const g of into) {
      g.assets++;
      addAll(g.byImportance, sum);
    }
    if (rows.length >= maxRows) continue;
    const site = v.sites.get(asset.site_id)!;
    const a = assignments.get(asset.id);
    const area = asset.area_id ? indexes.get(asset.site_id)?.nodes.get(asset.area_id) : undefined;
    const cells: PlantBlueprintMatrixRow['cells'] = blueprints.map(() => null);
    for (const c of covs) cells[at.get(c.blueprint.id)!] = { via: c.via, totals: c.totals, byImportance: c.byImportance };
    rows.push({
      asset: briefOf(asset, site),
      area: area ? { id: area.id, name: area.name, names: names(area.names) } : null,
      profile: a?.profileId
        ? scope.profile(a.profileId)
          ? { id: a.profileId, name: profiles.get(a.profileId)?.name ?? a.profileId }
          : { id: new HiddenRefs(scope.profile, [a.profileId]).ref(a.profileId), name: PLANT_HIDDEN, hidden: true }
        : null,
      cells,
    });
  }
  const siteList = [...v.sites.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    blueprints,
    rows,
    totals,
    groups: [...groups.values()],
    total: have.length,
    truncated: have.length > rows.length,
    options: {
      sites: siteList.map((s) => ({ id: s.id, code: s.code, name: s.name, names: names(s.names) })),
      areas: siteList.flatMap((s) =>
        [...(indexes.get(s.id)?.nodes.values() ?? [])]
          .filter((n) => n.level === 'area')
          .map((n) => ({ siteId: s.id, id: n.id, name: n.name, names: names(n.names) })),
      ),
      profiles: [...profiles.values()]
        .filter((p) => scope.profile(p.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ id: p.id, name: p.name })),
    },
  };
}

/**
 * The signals that feed a KPI definition (of blueprints the reader may see), how many assets the reader may see have each
 * in which state, and per asset the linked signals that are missing or not collected. Additional information only.
 */
export function kpiBlueprints(kpiId: string, scope: CatalogueScope = catalogueScope()): PlantKpiBlueprints {
  requirePlant();
  requireEntry(scope, 'kpi_definition', kpiId, kpiNotFound);
  if (!kpiRowOf(kpiId)) throw kpiNotFound(kpiId);
  const links = kpiLinks(scope);
  const mine = links.get(kpiId) ?? [];
  const out: PlantKpiBlueprints = { signals: [], gaps: {} };
  if (!mine.length) return out;
  const v = visible();
  const ids = new Set(v.assets.map((a) => a.id));
  const source = blueprintSource(ids, scope);
  const counts = new Map(
    mine.map((m) => [
      `${m.blueprint.id}\u0000${m.signal.id}`,
      { ...m, assets: { covered: 0, missing: 0, notCollected: 0, notApplicable: 0 } as Record<BlueprintState, number> },
    ]),
  );
  for (const a of v.assets) {
    const covs = source.of(a.id);
    if (!covs.length) continue;
    for (const c of covs)
      for (const s of c.signals) counts.get(`${c.blueprint.id}\u0000${s.signal.id}`) && counts.get(`${c.blueprint.id}\u0000${s.signal.id}`)!.assets[s.state]++;
    const gaps = kpiGaps(links, kpiId, covs);
    if (gaps.length) out.gaps[a.id] = gaps;
  }
  const importance = (i: BlueprintImportance) => BLUEPRINT_IMPORTANCES.indexOf(i);
  out.signals = [...counts.values()].sort(
    (a, b) =>
      importance(a.signal.importance) - importance(b.signal.importance) ||
      a.blueprint.name.localeCompare(b.blueprint.name) ||
      a.signal.name.localeCompare(b.signal.name),
  );
  return out;
}
