import {
  PLANT_IH_VERIFIED,
  type ExternalRef,
  type PlantCollectionSink,
  type PlantCollectionValues,
  type PlantIhCheckRun,
  type PlantIhItemCheck,
  type PlantIhTarget,
  type PlantIhTargetBrief,
  type PlantSinkMapping,
} from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { refsOf } from './model.js';
import { collectionRowOf, collectionValuesOf, type CollectionRow } from './collections-model.js';

/**
 * The parts of Insights Hub as a mapped sink (0.14, ih.ts) that other plant modules read without the rest – the target
 * of an item, the stored check of a mapping, the verified data points of the KPI coverage – kept apart so the views and
 * the collections do not load the services ih.ts needs.
 */

export const IH_PLATFORM_KIND = 'insights-hub';

/** The item as a sink's mapping names it: its output name, else its address. */
export const itemKey = (it: { outputName: string; address: string }) => it.outputName || it.address;

/** The Insights Hub platform a sink names (kind platform, its target the platform's id or name), or null. */
export function ihPlatformOf(s: Pick<PlantCollectionSink, 'kind' | 'ref'>): { id: string; name: string } | null {
  if (s.kind !== 'platform' || !s.ref) return null;
  const r =
    db().get<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM platforms WHERE id = ?', s.ref) ??
    db().get<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM platforms WHERE lower(name) = lower(?)', s.ref);
  return r && r.kind === IH_PLATFORM_KIND ? { id: r.id, name: r.name } : null;
}

/** `{asset.ref:<system>}`: the asset's external reference of that system (one mapping for many assets). */
const PLACEHOLDER = /^\{asset\.ref:([^{}]{1,100})\}$/i;
const systemKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function resolveAssetId(raw: string, refs: ExternalRef[]): { assetId: string | null; placeholder: string | null } {
  const t = raw.trim();
  const m = PLACEHOLDER.exec(t);
  if (!m) return { assetId: t || null, placeholder: null };
  const want = systemKey(m[1]!);
  const ref = refs.find((x) => systemKey(x.system) === want && x.id.trim());
  return { assetId: ref ? ref.id.trim() : null, placeholder: t };
}

/** Where an item goes: its own asset and aspect, else the sink's default; its variable is its target name in the sink. */
export function ihTargetOf(
  sink: Pick<PlantCollectionSink, 'ih'>,
  m: PlantSinkMapping | undefined,
  refs: ExternalRef[],
): { target: PlantIhTarget | null; fromDefault: boolean; placeholder: string | null } {
  const d = sink.ih ?? null;
  const rawAsset = m?.assetId || d?.assetId || '';
  const aspect = m?.aspect || d?.aspect || '';
  const variable = m?.target || '';
  const fromDefault = (!m?.assetId && !!d?.assetId) || (!m?.aspect && !!d?.aspect);
  const { assetId, placeholder } = resolveAssetId(rawAsset, refs);
  const assetName = (m?.assetId ? m.assetName : d?.assetName) ?? '';
  if (!assetId || !aspect || !variable) return { target: null, fromDefault, placeholder };
  return { target: { assetId, assetName, aspect, variable }, fromDefault, placeholder };
}

export const sameTarget = (a: Pick<PlantIhTarget, 'assetId' | 'aspect' | 'variable'>, b: Pick<PlantIhTarget, 'assetId' | 'aspect' | 'variable'>) =>
  a.assetId.toLowerCase() === b.assetId.toLowerCase() && a.aspect === b.aspect && a.variable === b.variable;

// ---------- the stored check ----------

export interface CheckRow {
  asset_id: string;
  collection_id: string;
  sink_id: string;
  platform_id: string;
  checked_at: string;
  checked_by: string;
  run: string;
  items: string;
}

export const checkRowOf = (assetId: string, collectionId: string, sinkId: string) =>
  db().get<CheckRow>('SELECT * FROM plant_ih_checks WHERE asset_id = ? AND collection_id = ? AND sink_id = ?', assetId, collectionId, sinkId);

export const runOf = (r: CheckRow | undefined): PlantIhCheckRun | null => (r ? parseJson<PlantIhCheckRun | null>(r.run, null) : null);
export const checkedItems = (r: CheckRow | undefined): PlantIhItemCheck[] => (r ? parseJson<PlantIhItemCheck[]>(r.items, []) : []);

/** The stored result for an item's current target (none when the item's target changed since the check). */
export const resultFor = (checked: Map<string, PlantIhItemCheck>, item: string, t: PlantIhTarget | null): PlantIhItemCheck | null => {
  const c = checked.get(item);
  return c && t && sameTarget(c, t) ? c : null;
};

/**
 * KPI coverage (0.14): the data points of each asset that go to Insights Hub through a sink whose last check found
 * their target (verified) – for "Collected – ready" cells, additive.
 */
export function ihVerifiedPoints(assetIds: Set<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const checks = db().all<CheckRow>('SELECT * FROM plant_ih_checks');
  if (!checks.length) return out;
  const wanted = checks.filter((c) => assetIds.has(c.asset_id));
  const refs = refsOf('asset', [...new Set(wanted.map((c) => c.asset_id))]);
  const rows = new Map<string, CollectionRow | undefined>();
  for (const c of wanted) {
    const rk = `${c.asset_id}\u0000${c.collection_id}`;
    if (!rows.has(rk)) rows.set(rk, collectionRowOf(c.asset_id, c.collection_id));
    const row = rows.get(rk);
    if (!row) continue;
    const v = collectionValuesOf(row);
    const sink = v.sinks.find((s) => s.id === c.sink_id);
    if (!sink || !ihPlatformOf(sink)) continue;
    const checked = new Map(checkedItems(c).map((x) => [x.item, x]));
    for (const it of v.items) {
      if (!it.dataPoint) continue;
      const key = itemKey(it);
      const r = resultFor(
        checked,
        key,
        ihTargetOf(
          sink,
          sink.mappings.find((m) => m.item === key),
          refs.get(c.asset_id) ?? [],
        ).target,
      );
      if (r && PLANT_IH_VERIFIED.includes(r.status)) {
        const set = out.get(c.asset_id) ?? new Set<string>();
        set.add(it.dataPoint);
        out.set(c.asset_id, set);
      }
    }
  }
  return out;
}

/** The data point page (0.14): where a data point goes in Insights Hub through one sink, with the last check. */
export function ihTargetBrief(assetId: string, v: PlantCollectionValues, sink: PlantCollectionSink, pointId: string): PlantIhTargetBrief | null {
  if (!ihPlatformOf(sink)) return null;
  const refs = refsOf('asset', [assetId]).get(assetId) ?? [];
  const check = checkRowOf(assetId, v.id, sink.id);
  const checked = new Map(checkedItems(check).map((x) => [x.item, x]));
  for (const it of v.items) {
    if (it.dataPoint !== pointId) continue;
    const key = itemKey(it);
    const { target } = ihTargetOf(
      sink,
      sink.mappings.find((m) => m.item === key),
      refs,
    );
    if (!target) continue;
    const r = resultFor(checked, key, target);
    return { ...target, status: r?.status ?? null, checkedAt: r ? (check?.checked_at ?? null) : null };
  }
  return null;
}

/** A collection or sink that goes takes its check and links along. */
export function removeIhState(assetId: string, collectionId: string, sinkIds?: string[]): number {
  let n = 0;
  for (const t of ['plant_ih_checks', 'plant_ih_monitor_links'])
    if (!sinkIds) n += db().run(`DELETE FROM ${t} WHERE asset_id = ? AND collection_id = ?`, assetId, collectionId).changes;
    else for (const s of sinkIds) n += db().run(`DELETE FROM ${t} WHERE asset_id = ? AND collection_id = ? AND sink_id = ?`, assetId, collectionId, s).changes;
  return n;
}
