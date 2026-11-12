import {
  dataPathEnds,
  IMPACT_LIMITS,
  type ImpactGroupKind,
  type ImpactVia,
  type MaintenanceTargetKind,
  type PlantCollectionValues,
  type PlantDataPathValues,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { parseJson } from '../util.js';
import { siteRights } from './access.js';
import { plantEnabled } from './settings.js';
import { dataPathValuesOf, type DataPathRow } from './network-model.js';
import { collectionValuesOf, collectorKey, type CollectionRow } from './collections-model.js';
import { allAssignments, allKpis, allProfiles } from './data-model.js';
import { assetInputPoints, inputGaps } from './checks.js';
import { isCollected } from './potential.js';
import { splitAssetId } from './targets.js';
import { resolveTarget } from '../records/links.js';

/**
 * Impact before maintenance (0.14, docs/APPLICATIONS.md "Impact before maintenance"): what a window's plant targets –
 * and the catalogue items it reaches – affect in the plant registry. Documentation, followed as Steward knows it:
 *
 *   - a **site**: every asset of it; an **asset**: itself and its parts (the equipment hierarchy, down);
 *   - a **device** (a gateway, a switch): itself and the devices behind it – devices whose switch is it (by host name,
 *     `host.domain` or id), again for a switch behind a switch;
 *   - a **data collection**: its collector – every collection and data path the same collector runs;
 *   - catalogue items (listed or reached): data paths and collections whose collector is an affected application or
 *     platform, whose host, peer or destination is an affected system, collections with a sink there, and assets that
 *     link to them;
 *   - then the data paths of affected assets and devices (by the devices they cover and their peers), the paths that
 *     continue from them (they read from a system an affected path writes to), the collections of affected assets and
 *     paths, the data points those collections map, the KPI jobs reading them, the KPIs whose data is collected only
 *     there (coverage), datasets and dashboards of the results and sinks, and the monitors linked to affected assets
 *     and devices.
 *
 * Bounded: chains go IMPACT_LIMITS.depth steps; the walk stops after IMPACT_LIMITS.nodes entries (truncated). Every
 * entry is walked (an item behind a hidden one is still affected), but only entries of sites the reader may see are
 * named; the others are counted.
 */

export interface ImpactFound {
  name: string;
  path: string | null;
  detail: string;
  via: ImpactVia;
  from: string | null;
  visible: boolean;
}

/** Where the walk writes what it finds (catalogue/maintenance-impact.ts). */
export interface ImpactSink {
  /** Adds an item to a group (false: it was there already, or the walk is full) */
  add(group: ImpactGroupKind, key: string, item: ImpactFound): boolean;
  /** A chain was cut at the depth, or the walk is full */
  cut(): void;
}

/** Catalogue items the plant part found (named by the catalogue's rules), and the sites of affected assets. */
export interface PlantImpactOut {
  monitors: { ref: string; via: ImpactVia; from: string }[];
  applications: { id: string; via: ImpactVia; from: string }[];
  platforms: { id: string; via: ImpactVia; from: string }[];
  systems: { id: string; via: ImpactVia; from: string }[];
  /** The visible sites of affected assets (their owning teams and contacts are told) */
  sites: Set<string>;
  /** Datasets of KPI results, sinks and destinations, and dashboards of KPI results (named by their own rights) */
  datasets: Map<string, { via: ImpactVia; from: string; visible: boolean }>;
  dashboards: Map<string, { via: ImpactVia; from: string }>;
}

interface Reach {
  platforms: Set<string>;
  applications: Set<string>;
  systems: Set<string>;
}

type AssetRow = { id: string; name: string; site_id: string; parent_id: string | null };
type DevRow = { asset_id: string; id: string; hostname: string; domain: string; address: string; switch_name: string; checks: string };
const enc = encodeURIComponent;
const lc = (s: string) => s.trim().toLowerCase();
const key2 = (a: string, b: string) => `${a}/${b}`;

export function plantImpact(targets: { kind: MaintenanceTargetKind; id: string }[], reach: Reach, sink: ImpactSink): PlantImpactOut {
  const out: PlantImpactOut = { monitors: [], applications: [], platforms: [], systems: [], sites: new Set(), datasets: new Map(), dashboards: new Map() };
  if (!plantEnabled()) return out;
  const sites = db().all<{ id: string; name: string; acl: string }>('SELECT id, name, acl FROM plant_sites');
  const rights = siteRights(sites, currentUser());
  const seen = (siteId: string) => !!rights.get(siteId)?.includes('view');
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const assets = new Map(
    db()
      .all<AssetRow>('SELECT id, name, site_id, parent_id FROM plant_assets')
      .map((a) => [a.id, a]),
  );
  const assetName = (id: string) => assets.get(id)?.name ?? id;
  const assetPath = (id: string) => `/plant/assets/${enc(id)}`;
  const devices = db().all<DevRow>('SELECT asset_id, id, hostname, domain, address, switch_name, checks FROM plant_devices ORDER BY asset_id, position, id');
  const devByKey = new Map(devices.map((d) => [key2(d.asset_id, d.id), d]));
  const pathRows = db().all<DataPathRow>('SELECT * FROM plant_data_paths ORDER BY asset_id, position, id');
  const paths = pathRows.map((r) => ({ assetId: r.asset_id, v: dataPathValuesOf(r) }));
  const collRows = db().all<CollectionRow>('SELECT * FROM plant_collections ORDER BY asset_id, position, id');
  const colls = collRows.map((r) => ({ assetId: r.asset_id, v: collectionValuesOf(r) }));

  // ---------- what is affected, as sets (keys: asset ids, <asset>/<id>) ----------
  const wholeAssets = new Map<string, { via: ImpactVia; from: string | null }>();
  const someAssets = new Map<string, { via: ImpactVia; from: string | null }>();
  const affDevices = new Map<string, { via: ImpactVia; from: string | null }>();
  const affPaths = new Map<string, { via: ImpactVia; from: string | null }>();
  const affColls = new Map<string, { via: ImpactVia; from: string | null }>();
  const collectors = new Map<string, string>(); // collector key → the target it comes from

  const parts = new Map<string, string[]>();
  for (const a of assets.values()) if (a.parent_id && a.parent_id !== a.id) parts.set(a.parent_id, [...(parts.get(a.parent_id) ?? []), a.id]);
  const wholeAsset = (id: string, via: ImpactVia, from: string | null, depth = 0) => {
    if (!assets.has(id) || wholeAssets.has(id)) return;
    wholeAssets.set(id, { via, from });
    if (depth >= IMPACT_LIMITS.depth) {
      if (parts.get(id)?.length) sink.cut();
      return;
    }
    for (const p of parts.get(id) ?? []) wholeAsset(p, 'part', assetName(id), depth + 1);
  };

  for (const t of targets) {
    if (t.kind === 'site') {
      for (const a of assets.values()) if (a.site_id === t.id) wholeAsset(a.id, 'site', siteName.get(t.id) ?? t.id);
    } else if (t.kind === 'asset') wholeAsset(t.id, 'target', null);
    else if (t.kind === 'device') {
      if (devByKey.has(t.id)) affDevices.set(t.id, { via: 'target', from: null });
    } else if (t.kind === 'collection') {
      const k = splitAssetId(t.id);
      const c = k && colls.find((x) => x.assetId === k.assetId && x.v.id === k.id);
      if (c) {
        affColls.set(t.id, { via: 'target', from: null });
        if (c.v.collector.ref) collectors.set(collectorKey(c.v.collector), c.v.name);
      }
    }
  }
  // every device of an affected asset
  for (const d of devices)
    if (wholeAssets.has(d.asset_id) && !affDevices.has(key2(d.asset_id, d.id)))
      affDevices.set(key2(d.asset_id, d.id), { via: 'asset', from: assetName(d.asset_id) });

  // devices behind a switch: their switch names an affected device (host name, host.domain or id), repeatedly
  const names = (d: DevRow) => [d.hostname, d.hostname && d.domain ? `${d.hostname}.${d.domain}` : '', d.id].filter(Boolean).map(lc);
  let frontier = [...affDevices.keys()];
  for (let depth = 0; frontier.length; depth++) {
    const by = new Map<string, string>();
    for (const k of frontier) for (const n of names(devByKey.get(k)!)) by.set(n, k);
    const next: string[] = [];
    for (const d of devices) {
      const k = key2(d.asset_id, d.id);
      if (affDevices.has(k) || !d.switch_name) continue;
      const via = by.get(lc(d.switch_name));
      if (!via) continue;
      if (depth >= IMPACT_LIMITS.depth) {
        sink.cut();
        continue;
      }
      const sw = devByKey.get(via)!;
      affDevices.set(k, { via: 'switch', from: sw.hostname || sw.id });
      next.push(k);
    }
    frontier = next;
  }
  for (const k of affDevices.keys()) {
    const a = k.slice(0, k.indexOf('/'));
    if (!wholeAssets.has(a) && !someAssets.has(a)) someAssets.set(a, { via: 'device', from: devByKey.get(k)!.hostname || devByKey.get(k)!.id });
  }

  // assets that link to an affected application, platform or system (an asset links to what it uses: a gateway)
  const linked = db().all<{ from_id: string; to_kind: string; to_id: string }>(
    "SELECT from_id, to_kind, to_id FROM item_links WHERE from_kind = 'asset' AND to_kind IN ('application', 'platform', 'system')",
  );
  const inReach = (kind: string, id: string) =>
    (kind === 'application' && reach.applications.has(id)) || (kind === 'platform' && reach.platforms.has(id)) || (kind === 'system' && reach.systems.has(id));
  for (const l of linked)
    if (inReach(l.to_kind, l.to_id) && !wholeAssets.has(l.from_id) && !someAssets.has(l.from_id)) someAssets.set(l.from_id, { via: 'link', from: null });

  // ---------- data paths ----------
  const devHosts = new Map<string, string>(); // a text peer that names an affected device
  for (const k of affDevices.keys()) {
    const d = devByKey.get(k)!;
    for (const n of [...names(d), d.address ? lc(d.address) : ''].filter(Boolean)) devHosts.set(n, k);
  }
  const collectorAffected = (c: { kind: string; ref: string; host: string | null } | null): string | null => {
    if (!c) return null;
    if (c.ref && collectors.has(collectorKey(c as PlantCollectionValues['collector'])))
      return collectors.get(collectorKey(c as PlantCollectionValues['collector']))!;
    // named as the reader may see it (an item they may not see: its kind only)
    if ((c.kind === 'application' && reach.applications.has(c.ref)) || (c.kind === 'platform' && reach.platforms.has(c.ref)))
      return resolveTarget(c.kind, c.ref)?.label ?? c.kind;
    return null;
  };
  const systemName = (id: string) => resolveTarget('system', id)?.label ?? null;
  // what a path reads from and writes to (`system:<id>`), as the chains of the OT network follow them
  const hostsOf = (p: PlantDataPathValues) => dataPathEnds(p);
  /** A Steward item a path names (a peer, a destination, the collector's host) that the maintenance reaches */
  const touched = (p: PlantDataPathValues): { from: string | null } | null => {
    const h = dataPathEnds(p);
    for (const key of [...h.from, ...h.to, ...(p.collector?.host ? [`system:${p.collector.host}`] : [])]) {
      const id = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('system:') && reach.systems.has(id)) return { from: systemName(id) };
    }
    return null;
  };
  for (const { assetId, v } of paths) {
    const k = key2(assetId, v.id);
    if (wholeAssets.has(assetId)) {
      affPaths.set(k, { via: 'asset', from: assetName(assetId) });
      continue;
    }
    const dev =
      v.devices.find((d) => affDevices.has(key2(assetId, d))) ??
      v.transfers.find((t) => t.peerKind === 'device' && affDevices.has(key2(assetId, t.peer)))?.peer ??
      null;
    if (dev) {
      const d = devByKey.get(key2(assetId, dev))!;
      affPaths.set(k, { via: 'device', from: d.hostname || d.id });
      continue;
    }
    const textPeer = v.transfers.find((t) => t.peerKind !== 'device' && t.peerKind !== 'system' && devHosts.has(lc(t.peer)));
    if (textPeer) {
      affPaths.set(k, { via: 'device', from: textPeer.peer });
      continue;
    }
    const col = collectorAffected(v.collector);
    if (col) {
      affPaths.set(k, { via: 'collector', from: col });
      continue;
    }
    const host = touched(v);
    if (host) affPaths.set(k, { via: 'host', from: host.from });
  }
  // the paths that continue from affected ones: they read from a system an affected path writes to
  const readers = new Map<string, string[]>();
  for (const { assetId, v } of paths) for (const h of hostsOf(v).from) readers.set(h, [...(readers.get(h) ?? []), key2(assetId, v.id)]);
  const pathByKey = new Map(paths.map((p) => [key2(p.assetId, p.v.id), p]));
  frontier = [...affPaths.keys()];
  for (let depth = 0; frontier.length; depth++) {
    const next: string[] = [];
    for (const k of frontier)
      for (const h of hostsOf(pathByKey.get(k)!.v).to)
        for (const r of readers.get(h) ?? []) {
          if (affPaths.has(r)) continue;
          if (depth >= IMPACT_LIMITS.depth) {
            sink.cut();
            continue;
          }
          affPaths.set(r, { via: 'chain', from: pathByKey.get(k)!.v.subject });
          next.push(r);
        }
    frontier = next;
  }

  // ---------- collections ----------
  const sinkHit = (c: PlantCollectionValues) =>
    c.sinks.find(
      (s) =>
        (s.kind === 'system' && reach.systems.has(s.ref)) ||
        (s.kind === 'platform' && reach.platforms.has(s.ref)) ||
        (s.kind === 'application' && reach.applications.has(s.ref)),
    );
  for (const { assetId, v } of colls) {
    const k = key2(assetId, v.id);
    if (affColls.has(k)) continue;
    if (wholeAssets.has(assetId)) affColls.set(k, { via: 'asset', from: assetName(assetId) });
    else if (v.dataPathId && affPaths.has(key2(assetId, v.dataPathId)))
      affColls.set(k, { via: 'dataPath', from: pathByKey.get(key2(assetId, v.dataPathId))!.v.subject });
    else if (collectorAffected(v.collector)) affColls.set(k, { via: 'collector', from: collectorAffected(v.collector) });
    else if (v.collector.host && reach.systems.has(v.collector.host)) affColls.set(k, { via: 'host', from: systemName(v.collector.host) });
    else if (sinkHit(v)) affColls.set(k, { via: 'sink', from: sinkHit(v)!.name || null });
  }
  for (const k of [...affPaths.keys(), ...affColls.keys()]) {
    const a = k.slice(0, k.indexOf('/'));
    if (!wholeAssets.has(a) && !someAssets.has(a)) someAssets.set(a, { via: affColls.has(k) ? 'collection' : 'asset', from: null });
  }

  // ---------- name them (only sites the reader may see) ----------
  const visibleAsset = (id: string) => {
    const a = assets.get(id);
    return !!a && seen(a.site_id);
  };
  const detailOf = (assetId: string) => {
    const a = assets.get(assetId);
    return a ? `${a.name} · ${siteName.get(a.site_id) ?? a.site_id}` : assetId;
  };
  const fromName = (x: { from: string | null }) => x.from;
  for (const [id, x] of [...wholeAssets, ...someAssets]) {
    const a = assets.get(id);
    if (!a) continue;
    const visible = seen(a.site_id);
    if (visible) out.sites.add(a.site_id);
    sink.add('assets', id, { name: a.name, path: assetPath(id), detail: siteName.get(a.site_id) ?? a.site_id, via: x.via, from: fromName(x), visible });
  }
  for (const [k, x] of affDevices) {
    const d = devByKey.get(k)!;
    sink.add('devices', k, {
      name: d.hostname || d.id,
      path: `${assetPath(d.asset_id)}#device-${enc(d.id)}`,
      detail: detailOf(d.asset_id),
      via: x.via,
      from: fromName(x),
      visible: visibleAsset(d.asset_id),
    });
  }
  for (const [k, x] of affPaths) {
    const p = pathByKey.get(k)!;
    sink.add('dataPaths', k, {
      name: p.v.subject,
      path: assetPath(p.assetId),
      detail: detailOf(p.assetId),
      via: x.via,
      from: fromName(x),
      visible: visibleAsset(p.assetId),
    });
  }
  const collByKey = new Map(colls.map((c) => [key2(c.assetId, c.v.id), c]));
  const collsOf = new Map<string, typeof colls>();
  for (const c of colls) (collsOf.get(c.assetId) ?? collsOf.set(c.assetId, []).get(c.assetId)!).push(c);
  // the data points each asset's affected collections map
  const points = new Map<string, Set<string>>();
  for (const [k, x] of affColls) {
    const c = collByKey.get(k)!;
    const mapped = c.v.items.map((i) => i.dataPoint).filter((p): p is string => !!p);
    const set = points.get(c.assetId) ?? new Set<string>();
    for (const p of mapped) set.add(p);
    points.set(c.assetId, set);
    sink.add('collections', k, {
      name: c.v.name,
      path: `${assetPath(c.assetId)}/collections?collection=${enc(c.v.id)}`,
      detail: detailOf(c.assetId),
      via: x.via,
      from: fromName(x),
      visible: visibleAsset(c.assetId),
    });
  }

  // ---------- KPI jobs and coverage ----------
  const assignments = allAssignments();
  const profiles = allProfiles();
  const kpis = allKpis();
  const { datasets, dashboards } = out;
  for (const assetId of new Set([...wholeAssets.keys(), ...points.keys()])) {
    const a = assignments.get(assetId);
    if (!a) continue;
    const profile = a.profileId ? profiles.get(a.profileId) : undefined;
    const mine = points.get(assetId) ?? new Set<string>();
    const visible = visibleAsset(assetId);
    for (const job of a.kpis) {
      const def = kpis.get(job.kpi);
      const reads = def ? assetInputPoints(def, profile).filter((x) => mine.has(x.point)) : [];
      if (!wholeAssets.has(assetId) && !reads.length) continue;
      sink.add('kpis', key2(assetId, job.job), {
        name: job.job,
        path: assetPath(assetId),
        detail: `${def?.name ?? job.kpi} · ${detailOf(assetId)}`,
        via: wholeAssets.has(assetId) ? 'asset' : 'dataPoint',
        from: reads[0]?.point ?? null,
        visible,
      });
      if (job.dataset && !datasets.has(job.dataset)) datasets.set(job.dataset, { via: 'result', from: job.job, visible });
      if (job.dashboard && !dashboards.has(job.dashboard)) dashboards.set(job.dashboard, { via: 'result', from: job.job });
    }
    // coverage: KPIs the asset could have whose data only the affected collections collect (no job yet)
    if (!profile || !mine.size) continue;
    const others = new Set<string>();
    for (const c of collsOf.get(assetId) ?? []) if (!affColls.has(key2(assetId, c.v.id))) for (const i of c.v.items) if (i.dataPoint) others.add(i.dataPoint);
    const all = new Set([...mine, ...others]);
    for (const def of kpis.values()) {
      if (a.kpis.some((k) => k.kpi === def.id)) continue;
      if (!isCollected(def, all, profile) || isCollected(def, others, profile) || inputGaps(def, a, profile).length) continue;
      sink.add('coverage', key2(assetId, def.id), {
        name: def.name,
        path: `/plant/kpis/${enc(def.id)}`,
        detail: detailOf(assetId),
        via: 'dataPoint',
        from: null,
        visible,
      });
    }
  }
  for (const k of affColls.keys()) {
    const c = collByKey.get(k)!;
    for (const s of c.v.sinks)
      if (s.kind === 'dataset' && s.ref && !datasets.has(s.ref)) datasets.set(s.ref, { via: 'sink', from: c.v.name, visible: visibleAsset(c.assetId) });
  }
  for (const k of affPaths.keys()) {
    const p = pathByKey.get(k)!;
    for (const d of p.v.destinations)
      if (d.kind === 'dataset' && d.ref && !datasets.has(d.ref)) datasets.set(d.ref, { via: 'sink', from: p.v.subject, visible: visibleAsset(p.assetId) });
  }

  // ---------- monitors linked to affected assets and devices; catalogue items the data passes ----------
  const monitorAssets = new Set([...wholeAssets.keys(), ...[...someAssets].filter(([, x]) => x.via === 'device').map(([id]) => id)]);
  for (const l of db().all<{ from_id: string; to_id: string }>("SELECT from_id, to_id FROM item_links WHERE from_kind = 'asset' AND to_kind = 'monitor'"))
    if (monitorAssets.has(l.from_id)) out.monitors.push({ ref: l.to_id, via: 'link', from: assetName(l.from_id) });
  for (const r of db().all<{ asset_id: string; checks: string }>('SELECT asset_id, checks FROM plant_asset_checks'))
    if (wholeAssets.has(r.asset_id))
      for (const c of parseJson<{ kind: string; ref: string }[]>(r.checks, []))
        if (c.kind === 'monitor' && c.ref) out.monitors.push({ ref: c.ref, via: 'check', from: assetName(r.asset_id) });
  for (const k of affDevices.keys()) {
    const d = devByKey.get(k)!;
    for (const c of parseJson<{ kind: string; ref: string }[]>(d.checks, []))
      if (c.kind === 'monitor' && c.ref) out.monitors.push({ ref: c.ref, via: 'check', from: d.hostname || d.id });
  }
  const item = (kind: 'application' | 'platform' | 'system', id: string, via: ImpactVia, from: string) => {
    const list = kind === 'application' ? out.applications : kind === 'platform' ? out.platforms : out.systems;
    if (id && !list.some((x) => x.id === id)) list.push({ id, via, from });
  };
  for (const k of affColls.keys()) {
    const c = collByKey.get(k)!.v;
    if (c.collector.kind === 'application' || c.collector.kind === 'platform') item(c.collector.kind, c.collector.ref, 'collector', c.name);
    if (c.collector.host) item('system', c.collector.host, 'host', c.name);
    for (const s of c.sinks) if (s.kind === 'system' || s.kind === 'platform' || s.kind === 'application') item(s.kind, s.ref, 'sink', c.name);
  }
  for (const k of affPaths.keys()) {
    const p = pathByKey.get(k)!.v;
    if (p.collector && (p.collector.kind === 'application' || p.collector.kind === 'platform')) item(p.collector.kind, p.collector.ref, 'collector', p.subject);
    const h = hostsOf(p);
    for (const s of [...h.from, ...h.to]) item('system', s, 'host', p.subject);
  }
  return out;
}
