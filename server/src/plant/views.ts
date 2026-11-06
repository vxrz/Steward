import {
  PLANT_VIEW_LIMITS,
  worstLive,
  type AssetStatus,
  type PlantAssignmentValues,
  type PlantCheck,
  type PlantCoverage,
  type PlantCoverageCell,
  type PlantCoverageRow,
  type PlantCoverageState,
  type PlantFlowEdge,
  type PlantFlowGraph,
  type PlantFlowNode,
  type PlantFlowPath,
  type PlantHostPlacement,
  type PlantKpiValues,
  type PlantLive,
  type PlantLiveState,
  type PlantProfileValues,
  type PlantSiteTile,
  type PlantStructure,
  type PlantStructureNode,
  type Translations,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { permissionsOfRow } from '../monitors/model.js';
import { resolveTarget } from '../records/links.js';
import { getDatasetMeta } from '../dashboards/datasets.js';
import { builtinDatasetVisible } from '../dashboards/builtin.js';
import { permissionsFor } from '../processes/service.js';
import { parseJson } from '../util.js';
import { siteRights } from './access.js';
import { requirePlant } from './settings.js';
import { assetBuilding, loadAllIndexes, loadIndex, type AssetRow, type SiteRow } from './model.js';
import { visibleAsset, visibleSite } from './service.js';
import { briefOf, kpiNotFound, pointNotFound, profileNotFound } from './catalogue.js';
import { allAssignments, allKpis, allProfiles, assignmentRowOf, assignmentValuesOf, pointsOf, profileRowOf, profileValuesOf } from './data-model.js';
import { assignmentChecks, deliveries, inputGaps } from './checks.js';
import { siteNetwork } from './network.js';

/**
 * The plant registry's visualizations (#230), read-only aggregates for the web app: a site's structure, an asset's data
 * flow, a data point's lineage, the KPI coverage matrix and the site overview tiles.
 *
 * What they show is what the registry documents. Status comes only from Steward items that are linked to a part: the
 * monitors an asset links to, the dataset a KPI instance names (its freshness), and the plant checks. A part without
 * such a link has `live: null` (documentation only); a linked item without data is "unknown", never "ok".
 *
 * Hidden-site rules: only assets of sites the caller may see are drawn or counted; a hidden site reads like a missing
 * one (404); monitors, datasets and dashboards follow their own rights (a hidden one is not named).
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

/** The monitors each asset links to that the caller may see, with their state (assets without one are missing). */
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
    if (!wanted.has(m.id) || m.is_template || !permissionsOfRow(m, user).includes('view')) continue;
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
    const live = monitors.get(l.to_id);
    if (live) out.set(l.from_id, [...(out.get(l.from_id) ?? []), live]);
  }
  return out;
}

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
    const meta = getDatasetMeta(key);
    const visible = builtinDatasetVisible(meta.processId) ?? permissionsFor(meta.processId).includes('view');
    if (!visible) return none;
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

type SlimAsset = Pick<AssetRow, 'id' | 'name' | 'status' | 'site_id' | 'area_id' | 'work_center_id' | 'work_unit_id'>;

function visible(): { sites: Map<string, SiteRow>; assets: SlimAsset[] } {
  const rows = db().all<SiteRow>('SELECT id, code, name, names, acl FROM plant_sites');
  const rights = siteRights(rows);
  const sites = new Map(rows.filter((s) => rights.get(s.id)!.includes('view')).map((s) => [s.id, s]));
  const assets = db()
    .all<SlimAsset>('SELECT id, name, status, site_id, area_id, work_center_id, work_unit_id FROM plant_assets')
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
  /** The profiles its inputs name (an asset with another profile cannot have it) */
  profiles: Set<string>;
}

const planOf = (def: PlantKpiValues): KpiPlan => {
  const inputs = def.inputs.filter((i) => i.kind === 'data_point');
  return { def, data: inputs.length > 0, profiles: new Set(inputs.map((i) => i.profile).filter(Boolean)) };
};

/** The cell of one asset and one KPI definition; `checks` are the asset's checks (assignmentChecks). */
function cellOf(
  plan: KpiPlan,
  a: PlantAssignmentValues | undefined,
  profile: PlantProfileValues | undefined,
  checks: PlantCheck[],
  details: boolean,
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
  if ([...plan.profiles].some((p) => p !== a.profileId) && !details) return { state: 'cannot' };
  const gaps = inputGaps(def, a, profile);
  if (!gaps.length) return { state: 'could' };
  return { state: 'cannot', ...(details ? { gaps: gaps.map((g) => ({ code: g.code, params: g.params })) } : {}) };
}

const emptyTotals = (): Record<PlantCoverageState, number> => ({ has: 0, problem: 0, could: 0, cannot: 0, unchecked: 0 });

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
  if (f.profile) assets = assets.filter((a) => assignments.get(a.id)?.profileId === f.profile);
  const siteName = (id: string) => v.sites.get(id)?.name ?? '';
  assets = [...assets].sort((a, b) => siteName(a.site_id).localeCompare(siteName(b.site_id)) || (a.site_id < b.site_id ? -1 : a.site_id > b.site_id ? 1 : 0));
  const maxRows = Math.min(PLANT_VIEW_LIMITS.coverageRows, Math.floor(PLANT_VIEW_LIMITS.coverageCells / Math.max(1, plans.length)));
  const totals = emptyTotals();
  const rows: PlantCoverageRow[] = [];
  for (const asset of assets) {
    const a = assignments.get(asset.id);
    const profile = a?.profileId ? profiles.get(a.profileId) : undefined;
    const site = v.sites.get(asset.site_id)!;
    const checks = a ? assignmentChecks({ kind: 'asset', id: asset.id, name: asset.name, siteId: asset.site_id }, a, profiles, kpiMap) : [];
    const details = rows.length < maxRows;
    const cells = plans.map((p) => cellOf(p, a, profile, checks, details));
    for (const c of cells) totals[c.state]++;
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
    totals,
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
  const tiles = new Map<string, PlantSiteTile>(
    [...v.sites.keys()].map((id) => [id, { siteId: id, counts: {}, total: 0, coverage: emptyTotals(), checks: 0, live: {} }]),
  );
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
    for (const p of plans) t.coverage[cellOf(p, a, profile, checks, false).state]++;
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
  const pr = a?.profileId ? profileRowOf(a.profileId) : undefined;
  const profile = pr ? profileValuesOf(pr) : undefined;
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
  const pathOf = new Map<string, PlantFlowPath>();
  if (profile) {
    const delivered = deliveries(a, profile);
    for (const iface of profile.interfaces) {
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
        if (!pubs.length) {
          last.push(client ? collector(client) : ifId);
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
    const inputs = (def?.inputs ?? []).filter((i) => i.kind === 'data_point' && (!i.profile || i.profile === a.profileId)).flatMap((i) => i.dataPoints);
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
  const pr = profileRowOf(profileId);
  if (!pr) throw profileNotFound(profileId);
  const profile = profileValuesOf(pr);
  const found = pointsOf(profile).find((x) => x.point.id === pointId);
  if (!found) throw pointNotFound(pointId);
  const v = visible();
  const assignments = allAssignments();
  const kpis = allKpis();
  const profiles = new Map([[profile.id, profile]]);
  const readers = new Set(
    [...kpis.values()]
      .filter((k) => k.inputs.some((i) => i.kind === 'data_point' && i.profile === profileId && i.dataPoints.includes(pointId)))
      .map((k) => k.id),
  );
  const holders = v.assets.filter((x) => assignments.get(x.id)?.profileId === profileId);
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
    const d = deliveries(a, profile).get(pointId)!;
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
  const vlansOfSegment = new Map<string, string[]>();
  for (const v of n.vlans) if (v.segmentId) vlansOfSegment.set(v.segmentId, [...(vlansOfSegment.get(v.segmentId) ?? []), v.id]);
  const hosts = n.hosts.filter((h) => h.visible);
  if (!hosts.length || !vlansOfSegment.size) return { hosts: [] };
  const wanted = new Set(hosts.map((h) => h.id));
  const segmentVisible = new Map<string, boolean>();
  const visibleSegment = (id: string) => {
    if (!segmentVisible.has(id)) segmentVisible.set(id, !!resolveTarget('system', id));
    return segmentVisible.get(id)!;
  };
  const out = new Map<string, Set<string>>();
  for (const r of db().all<{ system_id: string; segment_id: string }>('SELECT system_id, segment_id FROM system_segments')) {
    if (!wanted.has(r.system_id) || !vlansOfSegment.has(r.segment_id) || !visibleSegment(r.segment_id)) continue;
    const set = out.get(r.system_id) ?? new Set<string>();
    for (const v of vlansOfSegment.get(r.segment_id)!) set.add(v);
    out.set(r.system_id, set);
  }
  return {
    hosts: [...out]
      .map(([id, vlans]) => ({ id, vlans: n.vlans.filter((v) => vlans.has(v.id)).map((v) => v.id) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}
