import type { PlantKpiValues } from '@sm/shared';
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

/** Whether the collections of an asset (their mapped data points) cover every data point input of the KPI. */
export function isCollected(def: Pick<PlantKpiValues, 'inputs'>, points: Set<string> | undefined): boolean {
  const wanted = def.inputs.filter((i) => i.kind === 'data_point').flatMap((i) => i.dataPoints);
  if (!wanted.length || !points) return false;
  return wanted.every((dp) => points.has(dp));
}
