import type { PlantAssetRef, PlantKpiValues, PlantResolvedProfile } from '@sm/shared';
import { assetInputPoints } from './checks.js';
import { db } from '../db.js';
import { parseJson } from '../util.js';

/**
 * KPI potential (0.12.0, docs/PLANT.md "KPI coverage"): of the assets that could have a KPI – their devices deliver
 * every data point input –, those whose data is collected already. Collected means: the asset's data collections
 * (any collector: a gateway, an ETL job …) have items mapped to every data point the KPI reads. Collections have no
 * state of their own (active or not): every documented collection counts.
 */

/** The data points the collections of each asset map items to, by asset id (all assets, or the given ones). */
export function collectedPoints(assetIds?: Set<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of db().all<{ asset_id: string; items: string }>('SELECT asset_id, items FROM plant_collections')) {
    if (assetIds && !assetIds.has(r.asset_id)) continue;
    const set = out.get(r.asset_id) ?? new Set<string>();
    for (const item of parseJson<{ dataPoint?: string | null }[]>(r.items, [])) if (item?.dataPoint) set.add(item.dataPoint);
    out.set(r.asset_id, set);
  }
  return out;
}

/**
 * Whether the collections of an asset (their mapped data points) cover every data point input of the KPI – 0.13: as the
 * asset's profile reads them (the input's profile it matches and its mapping).
 */
export function isCollected(
  def: Pick<PlantKpiValues, 'inputs'>,
  points: Set<string> | undefined,
  profile: Pick<PlantResolvedProfile, 'chain'> | undefined | null,
): boolean {
  const wanted = assetInputPoints(def, profile);
  if (!wanted.length || !points) return false;
  return wanted.every((x) => points.has(x.point));
}

/**
 * 0.13: the direct parts of each asset (assets whose parent it is), by the asset's id, by name – only assets among
 * `visible` (both the asset and its part). Roll-up from parts (`rollUp: parts`) reads them.
 */
export function partsByAsset(visible: Set<string>): Map<string, PlantAssetRef[]> {
  const out = new Map<string, PlantAssetRef[]>();
  const rows = db().all<{ id: string; name: string; parent_id: string | null }>('SELECT id, name, parent_id FROM plant_assets WHERE parent_id IS NOT NULL');
  rows.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of rows)
    if (r.parent_id && r.parent_id !== r.id && visible.has(r.id) && visible.has(r.parent_id))
      out.set(r.parent_id, [...(out.get(r.parent_id) ?? []), { id: r.id, name: r.name }]);
  return out;
}
