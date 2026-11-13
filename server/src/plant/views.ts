import {
  kpiInputProfiles,
  PLANT_VIEW_LIMITS,
  worstLive,
  type AssetStatus,
  type PlantAssetRef,
  type PlantAssignmentValues,
  type PlantCheck,
  type PlantCoverage,
  type PlantCoverageCell,
  type PlantCoverageGroup,
  type PlantCoverageRow,
  type PlantKpiPotential,
  type PlantCoverageState,
  type PlantFlowEdge,
  type PlantFlowGraph,
  type PlantFlowNode,
  type PlantFlowPath,
  type PlantHostPlacement,
  type PlantKpiValues,
  type PlantLive,
  type PlantLiveState,
  type PlantResolvedProfile,
  type PlantSiteTile,
  type PlantStructure,
  type PlantStructureNode,
  type Translations,
  type LiveState,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { resolveTarget } from '../records/links.js';
import { parseJson } from '../util.js';
import { siteRights } from './access.js';
import { requirePlant } from './settings.js';
import { assetBuilding, loadAllIndexes, loadIndex, type AssetRow, type SiteRow } from './model.js';
import { visibleAsset, visibleSite } from './service.js';
import { briefOf, kpiNotFound, pointNotFound, profileNotFound } from './catalogue.js';
import { allAssignments, allKpis, allProfiles, assignmentRowOf, assignmentValuesOf, pointsOf, profileRowOf, resolvedProfile } from './data-model.js';
import { assetInputPoints, assignmentChecks, deliveries, inputGaps, matchedProfile, namedInputPoints, unitMismatches } from './checks.js';
import { collectedPoints, isCollected } from './potential.js';
import { ihVerifiedPoints } from './ih-core.js';
import { assetModel, isOrExtends } from './resolve.js';
import { collectionRows, collectionValuesOf, collectorKey } from './collections-model.js';
import type { PlantCollectionValues } from '@sm/shared';

/** A collection's sinks (0.12; the destination of 0.11 is the first) as nodes of a flow: a dataset, else a target. */
function destinationNodes(g: GraphBuilder, c: PlantCollectionValues): string[] {
  return c.sinks.map((d) => {
    if (d.kind === 'dataset') {
      const id = g.node({ id: `ds:${d.ref}`, kind: 'dataset', label: d.ref, detail: '', path: null, live: datasetLive(d.ref) });
      g.nodes.get(id)!.path = g.nodes.get(id)!.live?.path ?? null;
      return id;
    }
    const item = d.kind === 'system' || d.kind === 'platform' || d.kind === 'application';
    const label = item ? (resolveTarget(d.kind, d.ref)?.label ?? '') : d.ref || d.name;
    return g.node({
      id: `tgt:${norm(`${d.kind}:${d.ref || d.name}`)}`,
      kind: 'target',
      label: label || '–',
      detail: d.object,
      path: null,
      hidden: item && !label,
    });
  });
}

/** The collector of a collection as a node (one per collector; its label as the reader may see it). */
function collectorNode(g: GraphBuilder, c: PlantCollectionValues, detail: string): string {
  const k = c.collector;
  const label = k.kind === 'job' ? k.ref : (resolveTarget(k.kind, k.ref)?.label ?? '');
  return g.node({ id: `coll:${collectorKey(k)}`, kind: 'collector', label: label || '–', detail, path: null, hidden: k.kind !== 'job' && !label });
}
import { siteNetwork } from './network.js';
import { monitorState, monitorVisible, readableDataset } from './live.js';

/**
 * The plant registry's visualizations (#230), read-only aggregates for the web app: a site's structure, an asset's data
 * flow, a data point's lineage, the KPI coverage matrix and the site overview tiles.
 *
 * What they show is what the registry documents. Status comes only from Steward items that are linked to a part: the
 * monitors an asset links to, the dataset a KPI instance names (its freshness), and the plant checks. A part without
 * such a link has `live: null` (documentation only); a linked item without data is "unknown", never "ok".
 *
 * Hidden-site rules: only assets of sites the caller may see are drawn or counted; a hidden site reads like a missing
 * one (404); monitors, datasets and dashboards follow their own rights (a hidden one is not named). A linked monitor
 * the caller may not see counts with its state only, by the same rule as the OT network's live status (live.ts).
 */

// ---------- live status of linked Steward items ----------

const MONITOR_STATE: Record<string, PlantLiveState> = { up: 'ok', degraded: 'warn', maintenance: 'warn', down: 'fail', blocked: 'fail', unknown: 'unknown' };

interface MonitorStateRow {
  id: string;
  name: string;
  owner: string;
  acl: string;
  enabled: number;
  is_template: number;
  status: string | null;
  last_evaluated_at: string | null;
}

/** A state of the OT network's rule (live.ts) in the views' words: what a hidden item may tell. */
const AS_VIEW: Record<LiveState, PlantLiveState> = { online: 'ok', offline: 'fail', unknown: 'unknown' };

/**
 * The monitors each asset links to, with their state (assets without one are missing). The rule of the OT network
 * (live.ts): a monitor the caller may see is named and linked; one they may not see (or that no longer exists) still
 * counts, as "a check you may not see" with its state only (ok, fail or unknown – as online, offline or unknown
 * there), without name, status word, time or link.
 */
export function assetMonitors(assetIds: Set<string>): Map<string, PlantLive[]> {
  const out = new Map<string, PlantLive[]>();
  const links = db()
    .all<{ from_id: string; to_id: string }>("SELECT from_id, to_id FROM item_links WHERE from_kind = 'asset' AND to_kind = 'monitor'")
    .filter((l) => assetIds.has(l.from_id));
  if (!links.length) return out;
  const wanted = new Set(links.map((l) => l.to_id));
  const user = currentUser();
  const viewerOnly = plantOnly(user);
  const monitors = new Map<string, PlantLive>();
  for (const m of db().all<MonitorStateRow>(
    'SELECT m.id, m.name, m.owner, m.acl, m.enabled, m.is_template, s.status, s.last_evaluated_at FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id',
  )) {
    if (!wanted.has(m.id)) continue;
    if (!monitorVisible(m)) {
      monitors.set(m.id, hiddenLive(m.is_template ? 'unknown' : AS_VIEW[monitorState(m)]));
      continue;
    }
    // a disabled monitor knows nothing now
    const status = m.enabled ? (m.status ?? 'unknown') : 'unknown';
    monitors.set(m.id, {
      source: 'monitor',
      state: MONITOR_STATE[status] ?? 'unknown',
      status,
      label: m.name,
      path: viewerOnly ? null : `/monitors/${m.id}`,
      at: m.last_evaluated_at,
    });
  }
  for (const l of links) {
    const live = monitors.get(l.to_id) ?? hiddenLive('unknown'); // a monitor that no longer exists reads like a hidden one
    out.set(l.from_id, [...(out.get(l.from_id) ?? []), live]);
  }
  return out;
}

const hiddenLive = (state: PlantLiveState): PlantLive => ({ source: 'monitor', state, status: 'hidden', label: '', path: null, at: null });

/** The worst of an asset's monitors (null: none linked that the caller may see). */
const worstOf = (lives: PlantLive[] | undefined): PlantLive | null => {
  if (!lives?.length) return null;
  const w = worstLive(lives.map((l) => l.state));
  return lives.find((l) => l.state === w) ?? null;
};

/**
 * A dataset a KPI instance names, with its freshness: fresh, due (a scheduled run is overdue), stale – or "no data"
 * when it has none yet or the caller may not see it (both read the same, as on the asset page).
 */
function datasetLive(key: string): PlantLive {
  const none: PlantLive = { source: 'dataset', state: 'unknown', status: 'no_data', label: key, path: null, at: null };
  try {
    // who may see the dataset: the one rule of the OT network (live.ts)
    const meta = readableDataset(key);
    if (!meta) return none;
    const now = Date.now();
    const due = meta.sources.some((s) => {
      const age = now - Date.parse(s.updatedAt);
      return !!s.expectedMinutes && age > s.expectedMinutes * 60000 + Math.max(2 * 60000, s.expectedMinutes * 15000);
    });
    const status = meta.stale ? 'stale' : due ? 'due' : 'fresh';
    return {
      source: 'dataset',
      state: status === 'stale' ? 'fail' : status === 'due' ? 'warn' : 'ok',
      status,
      label: key,
      path: plantOnly(currentUser()) ? null : '/dashboards',
      at: meta.updatedAt,
    };
  } catch {
    return none; // no data yet, or not for this caller: the same answer
  }
}

// ---------- the assets the caller may see ----------

type SlimAsset = Pick<AssetRow, 'id' | 'name' | 'status' | 'site_id' | 'area_id' | 'work_center_id' | 'work_unit_id' | 'parent_id'>;

function visible(): { sites: Map<string, SiteRow>; assets: SlimAsset[] } {
  const rows = db().all<SiteRow>('SELECT id, code, name, names, acl FROM plant_sites');
  const rights = siteRights(rows);
  const sites = new Map(rows.filter((s) => rights.get(s.id)!.includes('view')).map((s) => [s.id, s]));
  const assets = db()
    .all<SlimAsset>('SELECT id, name, status, site_id, area_id, work_center_id, work_unit_id, parent_id FROM plant_assets')
    .filter((a) => sites.has(a.site_id));
  // sorted here, not in SQL: the same order on every database
  assets.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { sites, assets };
}

const names = (s: string): Translations => parseJson<Translations>(s, {});

// ---------- 1. site structure ----------

export function siteStructure(siteId: string): PlantStructure {
  const { row } = visibleSite(siteId);
  const index = loadIndex(siteId);
  const assets = db().all<AssetRow>('SELECT id, name, status, area_id, work_center_id, work_unit_id, building_id FROM plant_assets WHERE site_id = ?', siteId);
  assets.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  const monitors = assetMonitors(new Set(assets.map((a) => a.id)));
  const node = (id: string, level: PlantStructureNode['level'], parentId: string | null, name: string, n: string, type: string): PlantStructureNode => ({
    id,
    level,
    parentId,
    name,
    names: names(n),
    type,
    childIds: [],
    counts: {},
    total: 0,
    own: 0,
    live: {},
  });
  const fn = new Map<string, PlantStructureNode>();
  for (const n of index.nodes.values()) fn.set(n.id, node(n.id, n.level, n.parent_id, n.name, n.names, n.type));
  for (const n of fn.values()) if (n.parentId) fn.get(n.parentId)?.childIds.push(n.id);
  const loc = new Map<string, PlantStructureNode>();
  for (const b of index.buildings.values()) loc.set(b.id, node(b.id, 'building', b.parent_id, b.name, b.names, b.kind));
  for (const b of loc.values()) if (b.parentId) loc.get(b.parentId)?.childIds.push(b.id);

  const counts: Partial<Record<AssetStatus, number>> = {};
  const live: Partial<Record<PlantLiveState, number>> = {};
  const unplaced = { function: {} as Partial<Record<AssetStatus, number>>, location: {} as Partial<Record<AssetStatus, number>> };
  const inc = <K extends string>(o: Partial<Record<K, number>>, k: K) => (o[k] = (o[k] ?? 0) + 1);
  // up the tree from where the asset is (a guard against cycles in damaged data)
  const climb = (map: Map<string, PlantStructureNode>, start: string | null, status: AssetStatus, l: PlantLiveState | null): boolean => {
    let cur = start ? map.get(start) : undefined;
    if (!cur) return false;
    cur.own++;
    for (let i = 0; cur && i < 12; i++) {
      inc(cur.counts, status);
      cur.total++;
      if (l) inc(cur.live, l);
      cur = cur.parentId ? map.get(cur.parentId) : undefined;
    }
    return true;
  };
  const out: PlantStructure['assets'] = [];
  for (const a of assets) {
    const l = worstLive((monitors.get(a.id) ?? []).map((x) => x.state));
    inc(counts, a.status);
    if (l) inc(live, l);
    const at = a.work_unit_id ?? a.work_center_id ?? a.area_id;
    if (!climb(fn, at, a.status, l)) inc(unplaced.function, a.status);
    const b = assetBuilding(index, { buildingId: a.building_id, areaId: a.area_id, workCenterId: a.work_center_id, workUnitId: a.work_unit_id });
    if (!climb(loc, b?.id ?? null, a.status, l)) inc(unplaced.location, a.status);
    if (out.length < PLANT_VIEW_LIMITS.structureAssets) out.push({ id: a.id, name: a.name, status: a.status, nodeId: at, buildingId: b?.id ?? null, live: l });
  }
  return {
    site: { id: row.id, code: row.code, name: row.name, names: names(row.names) },
    function: [...fn.values()],
    location: [...loc.values()],
    counts,
    total: assets.length,
    live,
    unplaced,
    assets: out,
    assetsTruncated: assets.length > out.length,
  };
}

// ---------- coverage: one asset × one KPI definition ----------

interface KpiPlan {
  def: PlantKpiValues;
  /** It reads data points (else nothing can be checked) */
  data: boolean;
  /** Its data point inputs that name profiles (an asset whose profile matches none of an input's cannot have it) */
  named: PlantKpiValues['inputs'];
}

const planOf = (def: PlantKpiValues): KpiPlan => {
  const inputs = def.inputs.filter((i) => i.kind === 'data_point');
  return { def, data: inputs.length > 0, named: inputs.filter((i) => kpiInputProfiles(i).length > 0) };
};

/** What a cell reads besides the asset (0.12.0): every profile resolved, the data points its collections map. */
interface CellContext {
  profiles: Map<string, PlantResolvedProfile>;
  collected: Set<string> | undefined;
  /** 0.14: the data points whose Insights Hub mapping is verified (the KPI coverage only) */
  ihVerified?: Set<string>;
}

/** The cell of one asset and one KPI definition; `checks` are the asset's checks (assignmentChecks). */
function cellOf(
  plan: KpiPlan,
  a: PlantAssignmentValues | undefined,
  profile: PlantResolvedProfile | undefined,
  checks: PlantCheck[],
  details: boolean,
  ctx: CellContext,
): PlantCoverageCell {
  const { def } = plan;
  const mine = a?.kpis.filter((k) => k.kpi === def.id) ?? [];
  if (mine.length) {
    const jobs = mine.map((k) => k.job);
    const failing = checks.filter((c) => c.job !== undefined && jobs.includes(c.job));
    return {
      state: failing.length ? 'problem' : 'has',
      jobs,
      ...(mine.every((k) => !k.active) ? { inactive: true } : {}),
      ...(failing.length && details ? { checks: failing } : {}),
    };
  }
  if (!plan.data) return { state: 'unchecked' };
  if (!a || !a.profileId || !profile) return { state: 'cannot', ...(details ? { gaps: [{ code: 'kpi_no_profile', params: { kpi: def.name } }] } : {}) };
  // a KPI of another profile: no need to look at every data point (the common case on a large site)
  if (!details && plan.named.some((i) => matchedProfile(i, profile) === null)) return { state: 'cannot' };
  const gaps = inputGaps(def, a, profile);
  if (!gaps.length) {
    // 0.12.0: KPI potential – collected already, or the device delivers and a collection is missing; a unit that differs
    // is shown (the asset still could have the KPI: its job converts, or the input's unit is corrected)
    const units = details ? unitMismatches(def, a, profile, ctx.profiles) : [];
    const collected = isCollected(def, ctx.collected, profile);
    // 0.14: every input also verified in Insights Hub (a sink's mapping checked against the tenant)
    const ih = collected && ctx.ihVerified && isCollected(def, ctx.ihVerified, profile);
    return { state: 'could', collected, ...(ih ? { ihVerified: true } : {}), ...(units.length ? { units } : {}) };
  }
  return { state: 'cannot', ...(details ? { gaps: gaps.map((g) => ({ code: g.code, params: g.params })) } : {}) };
}

const emptyTotals = (): Record<PlantCoverageState, number> => ({ has: 0, problem: 0, could: 0, cannot: 0, unchecked: 0 });

/** Counts a cell into totals and KPI potential (0.12.0); a part's cell its machine counts (0.13) is not counted again. */
function count(into: { totals: Record<PlantCoverageState, number>; potential: PlantKpiPotential }, c: PlantCoverageCell): void {
  if (c.rolledUp) return;
  into.totals[c.state]++;
  if (c.state === 'could') into.potential[c.collected ? 'ready' : 'collect']++;
  if (c.state === 'could' && c.collected && c.ihVerified) into.potential.ihVerified = (into.potential.ihVerified ?? 0) + 1;
}

/** The states a part contributes to its machine (0.13): a job, or the inputs it delivers. */
const COUNTS_FOR_MACHINE = new Set<PlantCoverageState>(['has', 'problem', 'could']);

/**
 * 0.13, KPIs that roll up from parts (`rollUp: parts`, docs/PLANT.md "KPI coverage"): the cell of an asset with parts
 * (assets that are part of it, direct ones, among `cells`) takes a part's state where it has none itself – a part's job
 * where the asset has none, else a part that delivers the inputs where the asset does not (collected first) – marked
 * `via` the part. Every part that has a job or delivers the inputs is marked `rolledUp` to the asset: the KPI counts once
 * per machine. Decided on the cells as they were (a part's own state, not one it has from its parts).
 */
function rollUpParts(plans: KpiPlan[], cells: Map<string, PlantCoverageCell[]>, assets: SlimAsset[]): void {
  const which = plans.map((p, j) => (p.def.rollUp === 'parts' ? j : -1)).filter((j) => j >= 0);
  if (!which.length) return;
  const partsOf = new Map<string, SlimAsset[]>();
  for (const a of assets)
    if (a.parent_id && a.parent_id !== a.id && cells.has(a.parent_id) && cells.has(a.id)) partsOf.set(a.parent_id, [...(partsOf.get(a.parent_id) ?? []), a]);
  if (!partsOf.size) return;
  const byId = new Map(assets.map((a) => [a.id, a]));
  const own = new Map([...cells].map(([id, list]) => [id, [...list]]));
  const ref = (a: SlimAsset): PlantAssetRef => ({ id: a.id, name: a.name });
  for (const [machineId, parts] of partsOf) {
    const machine = byId.get(machineId)!;
    for (const j of which) {
      const mine = own.get(machineId)![j]!;
      const counted = parts.map((p) => ({ p, c: own.get(p.id)![j]! })).filter((x) => COUNTS_FOR_MACHINE.has(x.c.state));
      if (!counted.length) continue;
      let next = mine;
      if (mine.state !== 'has' && mine.state !== 'problem') {
        const job = counted.find((x) => x.c.state === 'has') ?? counted.find((x) => x.c.state === 'problem');
        const could = counted.find((x) => x.c.state === 'could' && x.c.collected) ?? counted.find((x) => x.c.state === 'could');
        const from = job ?? (mine.state === 'could' ? undefined : could);
        if (from) {
          const { rolledUp: _r, ...c } = from.c;
          next = { ...c, via: ref(from.p) };
        }
      }
      cells.get(machineId)![j] = { ...next, ...(cells.get(machineId)![j]!.rolledUp ? { rolledUp: cells.get(machineId)![j]!.rolledUp } : {}) };
      for (const x of counted) cells.get(x.p.id)![j] = { ...cells.get(x.p.id)![j]!, rolledUp: ref(machine) };
    }
  }
}

// ---------- 4. the coverage matrix ----------

export interface CoverageFilter {
  site?: string;
  area?: string;
  profile?: string;
  kpi?: string;
}

export function coverage(f: CoverageFilter): PlantCoverage {
  requirePlant();
  // a site the caller may not see reads like one that does not exist
  if (f.site) visibleSite(f.site);
  const v = visible();
  const profiles = allProfiles();
  const kpiMap = allKpis();
  let defs = [...kpiMap.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  if (f.kpi) {
    const k = kpiMap.get(f.kpi);
    if (!k) throw kpiNotFound(f.kpi);
    defs = [k];
  }
  const plans = defs.map(planOf);
  const assignments = allAssignments();
  const indexes = loadAllIndexes();
  let assets = v.assets;
  if (f.site) assets = assets.filter((a) => a.site_id === f.site);
  if (f.area) assets = assets.filter((a) => a.area_id === f.area);
  // a profile filter includes the profiles that extend it (0.11.0)
  if (f.profile) {
    const wanted = f.profile;
    assets = assets.filter((a) => isOrExtends(profiles.get(assignments.get(a.id)?.profileId ?? ''), wanted));
  }
  const siteName = (id: string) => v.sites.get(id)?.name ?? '';
  assets = [...assets].sort((a, b) => siteName(a.site_id).localeCompare(siteName(b.site_id)) || (a.site_id < b.site_id ? -1 : a.site_id > b.site_id ? 1 : 0));
  const maxRows = Math.min(PLANT_VIEW_LIMITS.coverageRows, Math.floor(PLANT_VIEW_LIMITS.coverageCells / Math.max(1, plans.length)));
  const all = { totals: emptyTotals(), potential: { ready: 0, collect: 0 } };
  const rows: PlantCoverageRow[] = [];
  const collected = collectedPoints(new Set(assets.map((a) => a.id)));
  const ihVerified = ihVerifiedPoints(new Set(assets.map((a) => a.id)));
  // 0.12.0: totals per site (area null) and per area of a site
  const groups = new Map<string, PlantCoverageGroup>();
  const groupOf = (siteId: string, areaId: string | null) => {
    const key = `${siteId}\u0000${areaId ?? ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { siteId, areaId, assets: 0, totals: emptyTotals(), potential: { ready: 0, collect: 0 } }));
    return g;
  };
  // the rows shown, and their parts (0.13: a row's cell may come from a part's, with its details)
  const shown = new Set(assets.slice(0, maxRows).map((a) => a.id));
  const withDetails = new Set([...shown, ...assets.filter((a) => a.parent_id && shown.has(a.parent_id)).map((a) => a.id)]);
  const cellsOf = new Map<string, PlantCoverageCell[]>();
  for (const asset of assets) {
    const a = assignments.get(asset.id);
    const profile = a?.profileId ? profiles.get(a.profileId) : undefined;
    const checks = a ? assignmentChecks({ kind: 'asset', id: asset.id, name: asset.name, siteId: asset.site_id }, a, profiles, kpiMap) : [];
    cellsOf.set(
      asset.id,
      plans.map((p) =>
        cellOf(p, a, profile, checks, withDetails.has(asset.id), { profiles, collected: collected.get(asset.id), ihVerified: ihVerified.get(asset.id) }),
      ),
    );
  }
  rollUpParts(plans, cellsOf, assets);
  for (const asset of assets) {
    const a = assignments.get(asset.id);
    const profile = a?.profileId ? profiles.get(a.profileId) : undefined;
    const site = v.sites.get(asset.site_id)!;
    const details = shown.has(asset.id);
    const cells = cellsOf.get(asset.id)!;
    const into = [all, groupOf(asset.site_id, null), ...(asset.area_id ? [groupOf(asset.site_id, asset.area_id)] : [])];
    for (const g of into.slice(1)) (g as PlantCoverageGroup).assets++;
    for (const c of cells) for (const g of into) count(g, c);
    if (!details) continue;
    const area = asset.area_id ? indexes.get(asset.site_id)?.nodes.get(asset.area_id) : undefined;
    rows.push({
      asset: briefOf(asset, site),
      area: area ? { id: area.id, name: area.name, names: names(area.names) } : null,
      profile: a?.profileId ? { id: a.profileId, name: profile?.name ?? a.profileId } : null,
      cells,
    });
  }
  const siteList = [...v.sites.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    kpis: defs.map((d) => ({ id: d.id, name: d.name, names: d.names, category: d.category })),
    rows,
    totals: all.totals,
    potential: all.potential,
    groups: [...groups.values()],
    total: assets.length,
    truncated: assets.length > rows.length,
    options: {
      sites: siteList.map((s) => ({ id: s.id, code: s.code, name: s.name, names: names(s.names) })),
      areas: siteList.flatMap((s) =>
        [...(indexes.get(s.id)?.nodes.values() ?? [])]
          .filter((n) => n.level === 'area')
          .map((n) => ({ siteId: s.id, id: n.id, name: n.name, names: names(n.names) })),
      ),
      profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name })),
    },
  };
}

// ---------- 6. the site overview ----------

export function overview(): PlantSiteTile[] {
  requirePlant();
  const v = visible();
  const profiles = allProfiles();
  const kpiMap = allKpis();
  const plans = [...kpiMap.values()].map(planOf);
  const assignments = allAssignments();
  const monitors = assetMonitors(new Set(v.assets.map((a) => a.id)));
  const collected = collectedPoints(new Set(v.assets.map((a) => a.id)));
  const tiles = new Map<string, PlantSiteTile>(
    [...v.sites.keys()].map((id) => [
      id,
      { siteId: id, counts: {}, total: 0, coverage: emptyTotals(), potential: { ready: 0, collect: 0 }, checks: 0, live: {} },
    ]),
  );
  const cellsOf = new Map<string, PlantCoverageCell[]>();
  for (const asset of v.assets) {
    const t = tiles.get(asset.site_id)!;
    t.counts[asset.status] = (t.counts[asset.status] ?? 0) + 1;
    t.total++;
    const l = worstLive((monitors.get(asset.id) ?? []).map((x) => x.state));
    if (l) t.live[l] = (t.live[l] ?? 0) + 1;
    const a = assignments.get(asset.id);
    const profile = a?.profileId ? profiles.get(a.profileId) : undefined;
    const checks = a ? assignmentChecks({ kind: 'asset', id: asset.id, name: asset.name, siteId: asset.site_id }, a, profiles, kpiMap) : [];
    t.checks += checks.length;
    cellsOf.set(
      asset.id,
      plans.map((p) => cellOf(p, a, profile, checks, false, { profiles, collected: collected.get(asset.id) })),
    );
  }
  // 0.13: KPIs that roll up from parts count once per machine
  rollUpParts(plans, cellsOf, v.assets);
  for (const asset of v.assets) {
    const t = tiles.get(asset.site_id)!;
    for (const c of cellsOf.get(asset.id)!) count({ totals: t.coverage, potential: t.potential }, c);
  }
  return [...tiles.values()];
}

// ---------- 2. the data flow of an asset ----------

/** Nodes, edges (with the data points or assets that take them) and paths, built step by step. */
class GraphBuilder {
  nodes = new Map<string, PlantFlowNode>();
  private edges = new Map<string, PlantFlowEdge & { via: Set<string> }>();
  paths: PlantFlowPath[] = [];

  node(n: Omit<PlantFlowNode, 'checks' | 'live' | 'inactive'> & Partial<Pick<PlantFlowNode, 'checks' | 'live' | 'inactive'>>): string {
    if (!this.nodes.has(n.id)) this.nodes.set(n.id, { checks: [], live: null, inactive: false, ...n });
    return n.id;
  }

  /** An edge; `via` is the data point (flow) or asset (lineage) that takes it, for the count. */
  edge(from: string, to: string, via: string | null, o: Partial<Pick<PlantFlowEdge, 'inactive' | 'problem' | 'result' | 'files'>> = {}): string {
    const id = `${from}>${to}`;
    let e = this.edges.get(id);
    if (!e) {
      e = { id, from, to, points: 0, assets: 0, files: 0, inactive: !!o.inactive, problem: false, result: !!o.result, via: new Set() };
      this.edges.set(id, e);
    }
    // an edge stays inactive only while every way over it is
    if (!o.inactive) e.inactive = false;
    if (o.problem) e.problem = true;
    if (o.files) e.files = Math.max(e.files, o.files);
    if (via) e.via.add(via);
    return id;
  }

  graph(mode: 'points' | 'assets', grouped: boolean, empty: PlantFlowGraph['empty']): PlantFlowGraph {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()].map(({ via, ...e }) => ({
        ...e,
        points: mode === 'points' && !e.result ? via.size : 0,
        assets: mode === 'assets' ? via.size : 0,
      })),
      paths: this.paths,
      grouped,
      empty,
    };
  }
}

/** The result of a KPI instance: kpi → dataset → dashboard (or one of them). Returns the nodes and edges added. */
function addResults(
  g: GraphBuilder,
  from: string,
  k: { dataset: string | null; dashboard: string | null },
  via: string | null,
): { nodes: string[]; edges: string[] } {
  const out = { nodes: [] as string[], edges: [] as string[] };
  let prev = from;
  if (k.dataset) {
    const id = g.node({ id: `ds:${k.dataset}`, kind: 'dataset', label: k.dataset, detail: '', path: null, live: datasetLive(k.dataset) });
    g.nodes.get(id)!.path = g.nodes.get(id)!.live?.path ?? null;
    out.edges.push(g.edge(prev, id, via, { result: true }));
    out.nodes.push(id);
    prev = id;
  }
  if (k.dashboard) {
    const r = resolveTarget('dashboard', k.dashboard);
    const viewerOnly = plantOnly(currentUser());
    const id = g.node({
      id: `db:${k.dashboard}`,
      kind: 'dashboard',
      label: r?.label ?? '',
      detail: '',
      hidden: !r,
      path: r && !viewerOnly ? r.path : null,
    });
    out.edges.push(g.edge(prev, id, via, { result: true }));
    out.nodes.push(id);
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

export function assetFlow(assetId: string): PlantFlowGraph {
  const { row } = visibleAsset(assetId);
  const r = assignmentRowOf(assetId);
  const a = r ? assignmentValuesOf(r) : null;
  const g = new GraphBuilder();
  const monitors = assetMonitors(new Set([assetId]));
  const profile = resolvedProfile(a?.profileId) ?? undefined;
  const kpis = allKpis();
  const checks = a
    ? assignmentChecks({ kind: 'asset', id: row.id, name: row.name, siteId: row.site_id }, a, new Map(profile ? [[profile.id, profile]] : []), kpis)
    : [];
  const root = g.node({
    id: 'asset',
    kind: 'asset',
    label: row.name,
    detail: [row.manufacturer, row.model].filter(Boolean).join(' '),
    path: `/plant/assets/${encodeURIComponent(row.id)}`,
    checks: checks.filter((c) => c.job === undefined),
    live: worstOf(monitors.get(assetId)),
  });
  if (!a) return g.graph('points', false, 'no_assignment');

  // per data point: the nodes its data reaches last (where a KPI reads it), and its path
  const ends = new Map<string, string[]>();
  // the data collections that read the asset's data points (0.11.0): interface → collector → destination
  const collections = collectionRows(assetId).map(collectionValuesOf);
  const pathOf = new Map<string, PlantFlowPath>();
  // the asset's model: its resolved profile with the data points and interfaces it adds (0.11.0)
  const model = assetModel(a, profile);
  if (profile || model.interfaces.length) {
    const delivered = deliveries(a, profile);
    for (const iface of model.interfaces) {
      const set = a.interfaces.find((x) => x.interface === iface.id);
      const active = !!set?.active;
      const ifId = g.node({
        id: `if:${iface.id}`,
        kind: 'interface',
        label: iface.name || iface.id,
        detail: set?.endpoint ?? '',
        protocol: iface.protocol,
        direction: iface.direction,
        path: null,
        inactive: !active,
      });
      const pts = pointsOf({ interfaces: [iface] });
      // an interface without data points (file transfer, a web page) still has its way from the asset
      if (!pts.length) g.edge(root, ifId, null, { inactive: !active, files: iface.fileSets.length });
      const client = iface.client.trim();
      for (const { point } of pts) {
        const d = delivered.get(point.id)!;
        const path: PlantFlowPath = {
          id: point.id,
          kind: 'point',
          label: point.name || point.id,
          detail: point.address,
          delivers: d.delivers,
          reason: d.reason,
          nodes: [root, ifId],
          edges: [],
        };
        g.paths.push(path);
        pathOf.set(point.id, path);
        // a data point the asset lacks (override): no way at all
        if (d.reason === 'unavailable') {
          path.nodes = [root];
          continue;
        }
        path.edges.push(g.edge(root, ifId, point.id, { inactive: !active, files: iface.fileSets.length }));
        if (!active) {
          ends.set(point.id, [ifId]);
          continue;
        }
        const pubs = a.publications.filter((p) => p.dataPoint === point.id);
        const last: string[] = [];
        const collector = (name: string) => {
          const id = g.node({ id: `col:${norm(name)}`, kind: 'collector', label: name, detail: '', path: null });
          if (!path.nodes.includes(id)) path.nodes.push(id);
          path.edges.push(g.edge(ifId, id, point.id));
          return id;
        };
        for (const c of collections.filter((x) => x.items.some((i) => i.dataPoint === point.id))) {
          const cId = collectorNode(g, c, c.name);
          if (!path.nodes.includes(cId)) path.nodes.push(cId);
          path.edges.push(g.edge(ifId, cId, point.id));
          const dIds = destinationNodes(g, c);
          for (const dId of dIds) {
            if (!path.nodes.includes(dId)) path.nodes.push(dId);
            path.edges.push(g.edge(cId, dId, point.id));
          }
          last.push(...(dIds.length ? dIds : [cId]));
        }
        if (!pubs.length) {
          if (!last.length) last.push(client ? collector(client) : ifId);
        } else
          for (const p of pubs) {
            const by = p.publishedBy.trim() || client;
            const from = by ? collector(by) : ifId;
            const target = p.target.trim() || '–';
            const tId = g.node({ id: `tgt:${norm(target)}`, kind: 'target', label: target, detail: '', path: null });
            const t = g.nodes.get(tId)!;
            const where = [p.path, p.name].filter(Boolean).join(' / ');
            // the target's paths (the first three, then how many more)
            if (where) {
              const shown = t.detail ? t.detail.split('\n') : [];
              if (!shown.includes(where) && shown.length < 3) t.detail = [...shown, where].join('\n');
            }
            path.edges.push(g.edge(from, tId, point.id));
            if (!path.nodes.includes(tId)) path.nodes.push(tId);
            last.push(tId);
          }
        ends.set(point.id, [...new Set(last)]);
      }
    }
  }

  // KPI instances: they read data points where the data arrives, and show their result in a dataset or dashboard
  for (const k of a.kpis) {
    const def = kpis.get(k.kpi);
    const jobChecks = checks.filter((c) => c.job === k.job);
    const kId = g.node({
      id: `kpi:${k.job}`,
      kind: 'kpi',
      label: def?.name ?? k.kpi,
      detail: k.job,
      path: def ? `/plant/kpis/${encodeURIComponent(def.id)}` : null,
      inactive: !k.active,
      checks: jobChecks,
    });
    // 0.13: through the input's profile the asset's matches, with its mapping
    const inputs = def ? assetInputPoints(def, profile).map((x) => x.point) : [];
    const reached: { nodes: string[]; edges: string[] }[] = [];
    for (const dp of new Set(inputs)) {
      const from = ends.get(dp);
      const path = pathOf.get(dp);
      const delivered = !!path?.delivers;
      const sources = from?.length ? from : [root];
      for (const s of sources) {
        const e = g.edge(s, kId, dp, { problem: !delivered || jobChecks.some((c) => c.params.point === dp), inactive: !k.active });
        if (path) {
          path.edges.push(e);
          if (!path.nodes.includes(kId)) path.nodes.push(kId);
          reached.push(path);
        }
      }
    }
    // a KPI without data point inputs (or of another profile, or whose definition is gone): straight from the asset
    if (!inputs.length || !profile) g.edge(root, kId, null, { problem: !def || jobChecks.length > 0, inactive: !k.active });
    const res = addResults(g, kId, k, null);
    for (const p of reached) {
      for (const n of res.nodes) if (!p.nodes.includes(n)) p.nodes.push(n);
      for (const e of res.edges) if (!p.edges.includes(e)) p.edges.push(e);
    }
  }
  return g.graph('points', false, profile ? null : 'no_profile');
}

// ---------- 3. the lineage of a data point ----------

export function pointLineage(profileId: string, pointId: string): PlantFlowGraph {
  requirePlant();
  if (!profileRowOf(profileId)) throw profileNotFound(profileId);
  const profiles = allProfiles();
  const profile = profiles.get(profileId)!;
  const found = pointsOf(profile).find((x) => x.point.id === pointId);
  if (!found) throw pointNotFound(pointId);
  const v = visible();
  const assignments = allAssignments();
  const kpis = allKpis();
  const readers = new Set([...kpis.values()].filter((k) => namedInputPoints(k, profile).includes(pointId)).map((k) => k.id));
  // assets of this profile and of the profiles that extend it, unless theirs drops the data point (0.11.0)
  const theirs = (assetId: string) => profiles.get(assignments.get(assetId)?.profileId ?? '');
  const holders = v.assets.filter((x) => {
    const p = theirs(x.id);
    return isOrExtends(p, profileId) && pointsOf(p!).some((y) => y.point.id === pointId);
  });
  const grouped = holders.length > PLANT_VIEW_LIMITS.lineageAssets;
  const monitors = grouped ? new Map<string, PlantLive[]>() : assetMonitors(new Set(holders.map((x) => x.id)));
  const g = new GraphBuilder();
  const root = g.node({
    id: 'point',
    kind: 'point',
    label: found.point.name || found.point.id,
    detail: [found.iface.name || found.iface.id, found.point.address].filter(Boolean).join(' · '),
    protocol: found.iface.protocol,
    path: null,
  });
  if (!holders.length) return g.graph('assets', false, 'no_assets');
  const siteCounts = new Map<string, { total: number; delivering: number }>();
  for (const asset of holders) {
    const a = assignments.get(asset.id)!;
    const d = deliveries(a, theirs(asset.id)).get(pointId)!;
    const site = v.sites.get(asset.site_id)!;
    const checks = assignmentChecks({ kind: 'asset', id: asset.id, name: asset.name, siteId: asset.site_id }, a, profiles, kpis);
    let holder: string;
    if (grouped) {
      const c = siteCounts.get(site.id) ?? { total: 0, delivering: 0 };
      c.total++;
      if (d.delivers) c.delivering++;
      siteCounts.set(site.id, c);
      holder = g.node({ id: `site:${site.id}`, kind: 'site', label: site.name, detail: site.code, path: `/plant/sites/${encodeURIComponent(site.id)}` });
      g.nodes.get(holder)!.count = c;
    } else
      holder = g.node({
        id: `asset:${asset.id}`,
        kind: 'asset',
        label: asset.name,
        detail: site.name,
        path: `/plant/assets/${encodeURIComponent(asset.id)}/flow`,
        inactive: !d.delivers,
        checks: checks.filter((c) => c.params.point === pointId),
        live: worstOf(monitors.get(asset.id)),
      });
    const path: PlantFlowPath = {
      id: asset.id,
      kind: 'asset',
      label: asset.name,
      detail: site.name,
      delivers: d.delivers,
      reason: d.reason,
      nodes: [root, holder],
      edges: [g.edge(root, holder, asset.id, { inactive: !d.delivers })],
    };
    g.paths.push(path);
    const add = (n: string, e: string) => {
      if (!path.nodes.includes(n)) path.nodes.push(n);
      if (!path.edges.includes(e)) path.edges.push(e);
    };
    const last: string[] = [];
    // the collections that read it on this asset (0.11.0): asset → collector → destination
    if (d.delivers)
      for (const c of collectionRows(asset.id)
        .map(collectionValuesOf)
        .filter((x) => x.items.some((i) => i.dataPoint === pointId))) {
        const cId = collectorNode(g, c, '');
        add(cId, g.edge(holder, cId, asset.id));
        const dIds = destinationNodes(g, c);
        for (const dId of dIds) add(dId, g.edge(cId, dId, asset.id));
        last.push(...(dIds.length ? dIds : [cId]));
      }
    if (d.delivers)
      for (const p of a.publications.filter((x) => x.dataPoint === pointId)) {
        const target = p.target.trim() || '–';
        const tId = g.node({ id: `tgt:${norm(target)}`, kind: 'target', label: target, detail: '', path: null });
        add(tId, g.edge(holder, tId, asset.id));
        last.push(tId);
      }
    for (const k of a.kpis.filter((x) => readers.has(x.kpi))) {
      const def = kpis.get(k.kpi)!;
      const failing = checks.filter((c) => c.job === k.job);
      const kId = g.node({ id: `kpi:${def.id}`, kind: 'kpi', label: def.name, detail: '', path: `/plant/kpis/${encodeURIComponent(def.id)}`, inactive: true });
      const kn = g.nodes.get(kId)!;
      if (k.active) kn.inactive = false;
      kn.checks.push(...failing);
      kn.instances = (kn.instances ?? 0) + 1;
      for (const s of last.length ? [...new Set(last)] : [holder])
        add(kId, g.edge(s, kId, asset.id, { problem: !d.delivers || failing.length > 0, inactive: !k.active }));
      const res = addResults(g, kId, k, asset.id);
      res.nodes.forEach((n, i) => add(n, res.edges[i]!));
    }
  }
  return g.graph('assets', grouped, null);
}

// ---------- 5. the OT network: where the hosts are ----------

/**
 * Which VLANs of a site the hosts of its data paths are in (#220 data, for the diagram of #230): a host is a Steward
 * system, a system is in network segments (the catalogue), a VLAN is linked to a segment. Only hosts and segments the
 * caller may see count – a hidden one places nothing.
 */
export function hostPlacement(siteId: string): PlantHostPlacement {
  const n = siteNetwork(siteId);
  // the visible Steward items the data paths name (hosts are systems; 0.20: applications and platforms too)
  const named = { application: new Set<string>(), platform: new Set<string>() };
  for (const p of n.dataPaths)
    for (const r of [p.collectorRef, ...p.peers, ...p.targets]) if (r?.visible && (r.kind === 'application' || r.kind === 'platform')) named[r.kind].add(r.id);
  const zonesListing = (kind: 'systems' | 'platforms', id: string) => n.zones.filter((z) => z[kind].includes(id)).map((z) => z.id);
  // the systems the named applications run on, in the order they were added
  const runsOn = new Map<string, string[]>();
  if (named.application.size)
    for (const r of db().all<{ application_id: string; system_id: string }>(
      'SELECT application_id, system_id FROM application_systems ORDER BY created_at, id',
    ))
      if (named.application.has(r.application_id) && resolveTarget('system', r.system_id))
        runsOn.set(r.application_id, [...(runsOn.get(r.application_id) ?? []), r.system_id]);
  const wanted = new Set([...n.hosts.filter((h) => h.visible).map((h) => h.id), ...[...runsOn.values()].flat()]);
  const vlansOfSegment = new Map<string, string[]>();
  for (const v of n.vlans) if (v.segmentId) vlansOfSegment.set(v.segmentId, [...(vlansOfSegment.get(v.segmentId) ?? []), v.id]);
  const segmentVisible = new Map<string, boolean>();
  const visibleSegment = (id: string) => {
    if (!segmentVisible.has(id)) segmentVisible.set(id, !!resolveTarget('system', id));
    return segmentVisible.get(id)!;
  };
  const onVlans = new Map<string, Set<string>>();
  if (wanted.size && vlansOfSegment.size)
    for (const r of db().all<{ system_id: string; segment_id: string }>('SELECT system_id, segment_id FROM system_segments')) {
      if (!wanted.has(r.system_id) || !vlansOfSegment.has(r.segment_id) || !visibleSegment(r.segment_id)) continue;
      const set = onVlans.get(r.system_id) ?? new Set<string>();
      for (const v of vlansOfSegment.get(r.segment_id)!) set.add(v);
      onVlans.set(r.system_id, set);
    }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const hosts = [...wanted]
    .map((id) => ({ id, vlans: n.vlans.filter((v) => onVlans.get(id)?.has(v.id)).map((v) => v.id), zones: zonesListing('systems', id) }))
    .filter((h) => h.vlans.length || h.zones.length)
    .sort(byId);
  const placed = new Set(hosts.map((h) => h.id));
  return {
    hosts,
    applications: [...runsOn]
      .map(([id, systems]) => ({ id, system: systems.find((x) => placed.has(x)) ?? '' }))
      .filter((a) => a.system)
      .sort(byId),
    platforms: [...named.platform]
      .map((id) => ({ id, zones: zonesListing('platforms', id) }))
      .filter((x) => x.zones.length)
      .sort(byId),
  };
}
