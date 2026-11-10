import {
  PLANT_IH_LIMITS as IL,
  PLANT_IH_VERIFIED,
  type ExternalRef,
  type PlantCollectionSink,
  type PlantCollectionValues,
  type PlantIhCounts,
  type PlantIhCoverageEntry,
  type PlantIhGroup,
  type PlantIhMapping,
  type PlantIhMappingItem,
  type PlantIhMonitorCoverage,
  type PlantIhSiteCoverage,
  type PlantIhWatcher,
  type PlantSinkIhDefault,
  type PlantSinkMapping,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import { currentUser } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { getPlatform } from '../platforms/service.js';
import { canCreateMonitors, permissionsOfRow, type MonitorRow } from '../monitors/model.js';
import { csvTable } from '../csv.js';
import { HttpError } from '../util.js';
import { refsOf } from './model.js';
import { visibleAsset } from './service.js';
import { visibleAssets } from './catalogue.js';
import { assetPoints, collectionRowOf, collectionValuesOf, ihClean, type CollectionRow } from './collections-model.js';
import { assignmentRowOf, assignmentValuesOf, resolvedProfile } from './data-model.js';
import { parseCsvRows } from './collections-formats.js';
import { ihWatchIndex, leaderOf, sinkLinks, watcherOf, watching, type IhWatchCheck, type LinkRow } from './ih-monitors.js';
import { checkRowOf, checkedItems, ihPlatformOf, ihTargetOf, itemKey, resultFor, runOf, type CheckRow } from './ih-core.js';

export { IH_PLATFORM_KIND, ihPlatformOf, ihTargetBrief, ihTargetOf, ihVerifiedPoints, itemKey, removeIhState, resolveAssetId, sameTarget } from './ih-core.js';

/**
 * Insights Hub as a mapped sink (0.14, docs/PLANT.md "Insights Hub mapping"). A sink whose target is an Insights Hub
 * platform maps each item of its collection to an asset (its id there – or a placeholder the asset's external
 * reference fills –, its name kept for display), an aspect and a variable (the item's target name in the sink) –
 * freely per item, with an optional default asset and aspect on the sink. Nothing here compares the plant hierarchy
 * with the asset hierarchy in Insights Hub: they differ on purpose. The check against the tenant (ih-check.ts) and the
 * monitors that watch the targets (ih-monitors.ts) are read here for the sink's page, the data point's page, a site's
 * coverage and a monitor's page.
 */

// ---------- the sink's mapping, as its page shows it ----------

interface Computed {
  items: PlantIhMappingItem[];
  groups: PlantIhGroup[];
  counts: PlantIhCounts;
}

/** The items, groups and counts of a sink: its targets, the stored check, and who watches them. */
function compute(
  v: PlantCollectionValues,
  sink: PlantCollectionSink,
  platformId: string | null,
  refs: ExternalRef[],
  points: Map<string, { id: string; name: string; unit: string; dataType: string }>,
  check: CheckRow | undefined,
  links: LinkRow[],
  index: IhWatchCheck[],
): Computed {
  const checked = new Map(checkedItems(check).map((c) => [c.item, c]));
  const byMonitorCheck = new Map(index.map((w) => [`${w.monitor.id}\u0000${w.check.id}`, w]));
  const linkKeys = new Set(links.map((l) => `${l.item}\u0000${l.monitor_id}\u0000${l.check_id}`));
  const groups = new Map<string, PlantIhGroup & { watchers: Map<string, PlantIhWatcher>; hidden: Set<string> }>();
  const items: PlantIhMappingItem[] = v.items.map((it, at) => {
    const key = itemKey(it);
    const m = sink.mappings.find((x) => x.item === key);
    const t = ihTargetOf(sink, m, refs);
    const p = it.dataPoint ? points.get(it.dataPoint) : undefined;
    const watchedBy: PlantIhWatcher[] = [];
    let hiddenWatchers = 0;
    if (t.target && platformId) {
      // the checks that watch it now, and the stored links whose check still exists
      const found = new Map<string, IhWatchCheck>();
      for (const w of watching(index, platformId, t.target.assetId, t.target.aspect, t.target.variable)) found.set(`${w.monitor.id}\u0000${w.check.id}`, w);
      for (const l of links)
        if (l.item === key) {
          const w = byMonitorCheck.get(`${l.monitor_id}\u0000${l.check_id}`);
          if (w) found.set(`${l.monitor_id}\u0000${l.check_id}`, w);
        }
      for (const [k, w] of found) {
        const x = watcherOf(w, linkKeys.has(`${key}\u0000${k}`));
        if (x) watchedBy.push(x);
        else hiddenWatchers++;
      }
      const gk = `${t.target.assetId.toLowerCase()}\u0000${t.target.aspect}`;
      let g = groups.get(gk);
      if (!g)
        groups.set(
          gk,
          (g = {
            assetId: t.target.assetId,
            assetName: t.target.assetName,
            aspect: t.target.aspect,
            variables: [],
            watched: [],
            unwatched: [],
            monitors: [],
            hiddenMonitors: 0,
            items: [],
            watchers: new Map(),
            hidden: new Set(),
          }),
        );
      if (!g.assetName && t.target.assetName) g.assetName = t.target.assetName;
      g.items.push(at);
      if (!g.variables.includes(t.target.variable)) g.variables.push(t.target.variable);
      const watched = watchedBy.length > 0 || hiddenWatchers > 0;
      if (watched && !g.watched.includes(t.target.variable)) g.watched.push(t.target.variable);
      for (const w of watchedBy) g.watchers.set(`${w.monitorId}\u0000${w.checkId}`, w);
      for (const [k] of found) if (!g.watchers.has(k)) g.hidden.add(k);
    }
    return {
      index: at,
      item: key,
      address: it.address,
      outputName: it.outputName,
      dataPoint: p ? { id: p.id, name: p.name, unit: p.unit, dataType: p.dataType } : null,
      target: t.target,
      fromDefault: t.fromDefault,
      placeholder: t.placeholder,
      check: resultFor(checked, key, t.target),
      watchedBy,
      hiddenWatchers,
    };
  });
  const out: PlantIhGroup[] = [...groups.values()].map(({ watchers, hidden, ...g }) => ({
    ...g,
    unwatched: g.variables.filter((x) => !g.watched.includes(x)),
    monitors: [...watchers.values()],
    hiddenMonitors: hidden.size,
  }));
  return { items, groups: out, counts: countsOf(items) };
}

export function countsOf(items: PlantIhMappingItem[]): PlantIhCounts {
  const gaps: PlantIhCounts['gaps'] = { unmapped: [], unverified: [], unwatched: [] };
  let mapped = 0;
  let verified = 0;
  let watched = 0;
  for (const it of items) {
    if (!it.target) {
      gaps.unmapped.push(it.index);
      continue;
    }
    mapped++;
    if (it.check && PLANT_IH_VERIFIED.includes(it.check.status)) verified++;
    else gaps.unverified.push(it.index);
    if (it.watchedBy.length || it.hiddenWatchers) watched++;
    else gaps.unwatched.push(it.index);
  }
  return { items: items.length, mapped, verified, watched, gaps };
}

export function sinkOf(assetId: string, collectionId: string, sinkId: string) {
  const a = visibleAsset(assetId);
  const r = collectionRowOf(assetId, collectionId);
  if (!r) throw new HttpError(404, `Data collection ${collectionId} not found`, 'PLANT_COLLECTION_NOT_FOUND', { id: collectionId });
  const v = collectionValuesOf(r);
  const sink = v.sinks.find((s) => s.id === sinkId);
  if (!sink) throw new HttpError(404, `Sink ${sinkId} not found`, 'PLANT_SINK_NOT_FOUND', { id: sinkId });
  return { ...a, r, v, sink };
}

/** Why the current user may not read the platform with its default identity (the check's reads), or null. */
export function platformUseProblem(platformId: string): string | null {
  try {
    const p = getPlatform(platformId);
    if (!p.permissions.includes('use')) return `You may not use the platform "${p.name}"`;
    const i = p.identities?.find((x) => x.default);
    if (i && !i.mayUse) return `You may not use the identity "${i.name}" of the platform "${p.name}"`;
    return null;
  } catch {
    return `The platform ${platformId} does not exist`;
  }
}

/** The asset's data points (its model with its own additions), as the collections read them. */
function pointsOf(assetId: string): Map<string, { id: string; name: string; unit: string; dataType: string }> {
  const r = assignmentRowOf(assetId);
  const assignment = r ? assignmentValuesOf(r) : null;
  const { points } = assetPoints(assignment, resolvedProfile(assignment?.profileId));
  return new Map(points.map((p) => [p.id, { id: p.id, name: p.name, unit: p.unit, dataType: p.dataType }] as const));
}

/** GET …/collections/:collectionId/sinks/:sinkId/insights-hub */
export function ihMapping(assetId: string, collectionId: string, sinkId: string): PlantIhMapping {
  const { row, perms, v, sink } = sinkOf(assetId, collectionId, sinkId);
  const platform = ihPlatformOf(sink);
  const refs = refsOf('asset', [assetId]).get(assetId) ?? [];
  const check = checkRowOf(assetId, collectionId, sinkId);
  const c = compute(v, sink, platform?.id ?? null, refs, pointsOf(assetId), check, sinkLinks(assetId, collectionId, sinkId), platform ? ihWatchIndex() : []);
  const canManage = perms.includes('manage');
  const problem = platform ? platformUseProblem(platform.id) : 'The sink names no Insights Hub platform';
  let visiblePlatform: PlantIhMapping['platform'] = null;
  if (platform) {
    const seen = (() => {
      try {
        return getPlatform(platform.id).permissions.length > 0;
      } catch {
        return false;
      }
    })();
    // named for who may see the platform, linked unless the reader sees the plant registry only
    visiblePlatform = { id: platform.id, name: seen ? platform.name : '', path: seen && !plantOnly(currentUser()) ? `/platforms/${platform.id}` : null };
  }
  return {
    assetId,
    assetName: row.name,
    collectionId,
    collectionName: v.name,
    sinkId,
    sinkName: sink.name,
    isIh: !!platform,
    platform: visiblePlatform,
    default: sink.ih ?? null,
    ...c,
    lastRun: runOf(check),
    leader: leaderOf(assetId),
    canManage,
    canCheck: canManage && !problem,
    checkProblem: canManage ? problem : null,
    canCreateMonitor: canManage && !!platform && canCreateMonitors(me()),
  };
}

// ---------- writing the mapping (the route saves the collection as any edit does) ----------

export const ihDefaultInput = z
  .object({ assetId: z.string().trim().max(200), assetName: z.string().trim().max(200).default(''), aspect: z.string().trim().max(200) })
  .strict();
const itemInput = z
  .object({
    item: z.string().trim().min(1).max(500),
    assetId: z.string().trim().max(200).default(''),
    assetName: z.string().trim().max(200).default(''),
    aspect: z.string().trim().max(200).default(''),
    variable: z.string().trim().max(500).default(''),
  })
  .strict();
export type IhItemInput = z.output<typeof itemInput>;

/** PUT …/insights-hub/mapping: the default and the listed items (the others stay as they are). */
export const ihMappingInput = z
  .object({
    default: ihDefaultInput.nullable().optional(),
    items: z.array(itemInput).max(5000).default([]),
    revision: z.number().int().min(1).optional(),
  })
  .strict();

/** POST …/insights-hub/bulk: map items to one asset and aspect, with the same variable names. */
export const ihBulkInput = z
  .object({
    /** all items, those mapped to a data point, or the listed ones (item keys) */
    items: z.union([z.enum(['all', 'data_points']), z.array(z.string().trim().min(1).max(500)).max(5000)]).default('all'),
    assetId: z.string().trim().min(1).max(200),
    assetName: z.string().trim().max(200).default(''),
    aspect: z.string().trim().min(1).max(200),
    /** The variable: the item's output name (else its address), its data point's id, or its name in the sink as it is */
    names: z.enum(['output', 'data_point', 'keep']).default('output'),
    /** Also items that are mapped already */
    overwrite: z.boolean().default(false),
    revision: z.number().int().min(1).optional(),
  })
  .strict();

/** POST …/insights-hub/csv: `item,asset_id,asset_name,aspect,variable` (asset_name optional; `;` allowed). */
export const ihCsvInput = z
  .object({
    csv: z.string().max(IL.csvBytes),
    /** merge: the lines change their items; replace: items the file does not list lose their Insights Hub target */
    mode: z.enum(['merge', 'replace']).default('merge'),
    revision: z.number().int().min(1).optional(),
  })
  .strict();

/** The sink with the given items' Insights Hub targets changed (an empty change removes them). */
export function withItems(sink: PlantCollectionSink, changes: IhItemInput[], def?: PlantSinkIhDefault | null): PlantCollectionSink {
  let mappings = [...sink.mappings];
  for (const c of changes) {
    const i = mappings.findIndex((m) => m.item === c.item);
    const cur: PlantSinkMapping = i >= 0 ? mappings[i]! : { item: c.item, target: '', transform: '' };
    const next = ihClean({ ...cur, target: c.variable, assetId: c.assetId, assetName: c.assetId ? c.assetName : '', aspect: c.aspect });
    const empty = !next.target && !next.transform && !next.assetId && !next.aspect;
    if (i >= 0) mappings = empty ? mappings.filter((_, k) => k !== i) : mappings.map((m, k) => (k === i ? next : m));
    else if (!empty) mappings.push(next);
  }
  const out: PlantCollectionSink = { ...sink, mappings };
  if (def !== undefined) {
    if (def && (def.assetId || def.aspect)) out.ih = { assetId: def.assetId, assetName: def.assetId ? def.assetName : '', aspect: def.aspect };
    else delete out.ih;
  }
  return out;
}

function requireIhSink(sink: PlantCollectionSink): void {
  if (!ihPlatformOf(sink))
    throw new HttpError(409, 'The sink’s target is no Insights Hub platform – choose the platform as its target first', 'PLANT_SINK_NOT_IH', { sink: sink.id });
}

/** Checks item keys against the collection: an unknown one is refused. */
function requireItems(v: PlantCollectionValues, keys: string[]): void {
  const known = new Set(v.items.map(itemKey));
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length)
    throw new HttpError(400, `Unknown items: ${unknown.slice(0, 10).join(', ')}`, 'PLANT_IH_UNKNOWN_ITEM', {
      items: unknown.slice(0, 50),
      count: unknown.length,
    });
}

export function mappingSinks(v: PlantCollectionValues, sinkId: string, input: z.output<typeof ihMappingInput>): PlantCollectionSink[] {
  const sink = v.sinks.find((s) => s.id === sinkId)!;
  requireIhSink(sink);
  requireItems(
    v,
    input.items.map((x) => x.item),
  );
  return v.sinks.map((s) => (s.id === sinkId ? withItems(s, input.items, input.default) : s));
}

export function bulkSinks(
  v: PlantCollectionValues,
  sinkId: string,
  input: z.output<typeof ihBulkInput>,
  refs: ExternalRef[],
): { sinks: PlantCollectionSink[]; changed: number } {
  const sink = v.sinks.find((s) => s.id === sinkId)!;
  requireIhSink(sink);
  if (Array.isArray(input.items)) requireItems(v, input.items);
  const chosen = v.items.filter((it) =>
    input.items === 'all' ? true : input.items === 'data_points' ? !!it.dataPoint : (input.items as string[]).includes(itemKey(it)),
  );
  const changes: IhItemInput[] = [];
  for (const it of chosen) {
    const key = itemKey(it);
    const m = sink.mappings.find((x) => x.item === key);
    if (!input.overwrite && ihTargetOf(sink, m, refs).target) continue;
    const variable = input.names === 'data_point' ? (it.dataPoint ?? '') : input.names === 'keep' ? (m?.target ?? '') : key;
    if (!variable) continue;
    changes.push({ item: key, assetId: input.assetId, assetName: input.assetName, aspect: input.aspect, variable });
  }
  return { sinks: v.sinks.map((s) => (s.id === sinkId ? withItems(s, changes) : s)), changed: changes.length };
}

export function csvSinks(v: PlantCollectionValues, sinkId: string, input: z.output<typeof ihCsvInput>): { sinks: PlantCollectionSink[]; changed: number } {
  const sink = v.sinks.find((s) => s.id === sinkId)!;
  requireIhSink(sink);
  const rows = parseCsvRows(input.csv.replace(/^\uFEFF/, ''));
  if (rows.length > IL.csvLines) throw new HttpError(400, `At most ${IL.csvLines} lines`, 'PLANT_IH_CSV_INVALID', { max: IL.csvLines });
  const byAddress = new Map(v.items.map((it) => [it.address, itemKey(it)]));
  const known = new Set(v.items.map(itemKey));
  const problems: { line: number; message: string }[] = [];
  const changes: IhItemInput[] = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const raw = r.item ?? r.output_name ?? r.gateway_name ?? '';
    const key = known.has(raw) ? raw : (byAddress.get(r.address ?? raw) ?? '');
    if (!key) return void problems.push({ line, message: `no item "${(raw || r.address || '').slice(0, 100)}"` });
    const assetId = (r.asset_id ?? r.assetid ?? '').trim();
    const aspect = (r.aspect ?? '').trim();
    const variable = (r.variable ?? r.target ?? '').trim();
    if (!variable && (assetId || aspect)) return void problems.push({ line, message: 'a variable is needed' });
    for (const [k, x, max] of [
      ['asset_id', assetId, 200],
      ['aspect', aspect, 200],
      ['variable', variable, 500],
    ] as const)
      if (x.length > max) return void problems.push({ line, message: `${k} is longer than ${max} characters` });
    changes.push({ item: key, assetId, assetName: (r.asset_name ?? '').trim().slice(0, 200), aspect, variable });
  });
  if (!rows.length) problems.push({ line: 1, message: 'no lines: the header is item,asset_id,asset_name,aspect,variable' });
  if (problems.length)
    throw new HttpError(
      400,
      problems
        .slice(0, 5)
        .map((p) => `line ${p.line}: ${p.message}`)
        .join('; '),
      'PLANT_IH_CSV_INVALID',
      {
        problems: problems.slice(0, 50),
        count: problems.length,
      },
    );
  if (input.mode === 'replace') {
    const listed = new Set(changes.map((c) => c.item));
    for (const m of sink.mappings)
      if (!listed.has(m.item) && (m.assetId || m.aspect || m.target)) changes.push({ item: m.item, assetId: '', assetName: '', aspect: '', variable: '' });
  }
  return { sinks: v.sinks.map((s) => (s.id === sinkId ? withItems(s, changes) : s)), changed: changes.length };
}

/** GET …/insights-hub/mapping.csv: every item with its target as written (placeholders stay placeholders). */
export function mappingCsv(assetId: string, collectionId: string, sinkId: string): { filename: string; content: string } {
  const { v, sink } = sinkOf(assetId, collectionId, sinkId);
  const rows = v.items.map((it) => {
    const m = sink.mappings.find((x) => x.item === itemKey(it));
    return [itemKey(it), m?.assetId ?? '', m?.assetName ?? '', m?.aspect ?? '', m?.target ?? ''];
  });
  return {
    filename: `${assetId}.${collectionId}.${sinkId}.insights-hub.csv`,
    content: csvTable(['item', 'asset_id', 'asset_name', 'aspect', 'variable'], rows, { quote: 'needed' }),
  };
}

// ---------- coverage: per collection, per site, per monitor ----------

interface SinkSet {
  row: CollectionRow;
  v: PlantCollectionValues;
  sink: PlantCollectionSink;
  platformId: string;
}

/** The Insights Hub sinks of the given collections. */
function ihSinks(rows: CollectionRow[]): SinkSet[] {
  const out: SinkSet[] = [];
  for (const row of rows) {
    const v = collectionValuesOf(row);
    for (const sink of v.sinks) {
      const p = ihPlatformOf(sink);
      if (p) out.push({ row, v, sink, platformId: p.id });
    }
  }
  return out;
}

/** GET /api/plant/sites/:siteId/insights-hub: per Insights Hub sink of the site's collections its counts and gaps. */
export function siteIhCoverage(siteId: string): PlantIhSiteCoverage {
  const vis = visibleAssets();
  if (!vis.sites.has(siteId)) throw new HttpError(404, `Site ${siteId} not found`, 'PLANT_SITE_NOT_FOUND', { id: siteId });
  const assets = [...vis.assets.values()].filter((a) => a.site_id === siteId);
  const rows = assets.length
    ? db().all<CollectionRow>(
        `SELECT * FROM plant_collections WHERE asset_id IN (${assets.map(() => '?').join(', ')}) ORDER BY asset_id, position, id`,
        ...assets.map((a) => a.id),
      )
    : [];
  const sets = ihSinks(rows);
  const index = sets.length ? ihWatchIndex() : [];
  const refs = refsOf(
    'asset',
    sets.map((s) => s.row.asset_id),
  );
  const points = new Map<string, ReturnType<typeof pointsOf>>();
  const entries: PlantIhCoverageEntry[] = sets.map((s) => {
    const a = s.row.asset_id;
    if (!points.has(a)) points.set(a, pointsOf(a));
    const check = checkRowOf(a, s.v.id, s.sink.id);
    const c = compute(s.v, s.sink, s.platformId, refs.get(a) ?? [], points.get(a)!, check, sinkLinks(a, s.v.id, s.sink.id), index);
    return {
      assetId: a,
      assetName: vis.assets.get(a)!.name,
      collectionId: s.v.id,
      collectionName: s.v.name,
      sinkId: s.sink.id,
      sinkName: s.sink.name,
      counts: c.counts,
      checkedAt: check?.checked_at ?? null,
    };
  });
  const sum = (k: 'items' | 'mapped' | 'verified' | 'watched') => entries.reduce((n, e) => n + e.counts[k], 0);
  return { siteId, entries, totals: { sinks: entries.length, items: sum('items'), mapped: sum('mapped'), verified: sum('verified'), watched: sum('watched') } };
}

/** GET /api/plant/monitors/:monitorId/insights-hub: the mapped items whose stored links name the monitor. */
export function monitorIhCoverage(monitorId: string): PlantIhMonitorCoverage {
  const m = db().get<Pick<MonitorRow, 'id' | 'owner' | 'acl'>>(
    'SELECT id, owner, acl FROM monitors WHERE id = ? OR key = ?',
    monitorId,
    monitorId.toLowerCase(),
  );
  // the monitor's page asks: who may not see the monitor learns nothing about it
  if (!m || !permissionsOfRow(m).includes('view')) throw new HttpError(404, 'Monitor not found', 'MONITOR_NOT_FOUND');
  const vis = visibleAssets();
  const groups = new Map<string, PlantIhMonitorCoverage['entries'][number] & { keys: Set<string> }>();
  let hidden = 0;
  const hiddenKeys = new Set<string>();
  for (const l of db().all<LinkRow>('SELECT * FROM plant_ih_monitor_links WHERE monitor_id = ? ORDER BY asset_id, collection_id, sink_id', m.id)) {
    const k = `${l.asset_id}\u0000${l.collection_id}\u0000${l.sink_id}`;
    const asset = vis.assets.get(l.asset_id);
    if (!asset) {
      if (!hiddenKeys.has(k)) hidden++;
      hiddenKeys.add(k);
      continue;
    }
    let g = groups.get(k);
    if (!g) {
      const row = collectionRowOf(l.asset_id, l.collection_id);
      const sink = row ? collectionValuesOf(row).sinks.find((s) => s.id === l.sink_id) : undefined;
      if (!row || !sink) continue;
      groups.set(
        k,
        (g = {
          assetId: l.asset_id,
          assetName: asset.name,
          collectionId: l.collection_id,
          collectionName: row.name,
          sinkId: l.sink_id,
          sinkName: sink.name,
          items: 0,
          checks: [],
          keys: new Set(),
        }),
      );
    }
    g.keys.add(l.item);
    if (!g.checks.includes(l.check_id)) g.checks.push(l.check_id);
  }
  return { monitorId: m.id, entries: [...groups.values()].map(({ keys, ...g }) => ({ ...g, items: keys.size })), hidden };
}
