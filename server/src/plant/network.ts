import type { z } from 'zod';
import {
  inCidr,
  ipValue,
  PLANT_NETWORK_LIMITS as L,
  subnetDifference,
  type LinkTarget,
  type LiveState,
  type PlantAssetLive,
  type PlantAssetNetwork,
  type PlantConduitValues,
  type PlantConduitView,
  type PlantDataPathValues,
  type PlantDataPathView,
  type PlantDeviceValues,
  type PlantDeviceView,
  type PlantItemRef,
  type PlantLiveStatus,
  type PlantPathLink,
  type PlantPermission,
  type PlantSiteNetwork,
  type PlantVlanValues,
  type PlantVlanView,
  type PlantZoneValues,
  type PlantZoneView,
  type NetworkAttributes,
} from '@sm/shared';
import { db } from '../db.js';
import { refuseAliasId } from './ids.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { currentUser } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { listBacklinks, registerLinkKind, resolveTarget } from '../records/links.js';
import { likeEscape } from '../database/sql.js';
import { attributesOf } from '../catalogue/network.js';
import { createSystem } from '../catalogue/systems.js';
import { monitorRow } from '../monitors/model.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { requireManage, siteRights, sitePermissions } from './access.js';
import { plantEnabled } from './settings.js';
import { changedKeys, siteRowOf, type AssetRow, type SiteRow } from './model.js';
import { visibleAsset, visibleSite } from './service.js';
import { assetLive, checksForReader, liveContext, liveOf, monitorVisible, readableDataset, withHiddenChecks, type LiveContext } from './live.js';
import {
  assetChecksInput,
  assetChecksProblems,
  assetChecksRow,
  assetChecksValuesOf,
  conduitInput,
  conduitProblems,
  conduitRows,
  conduitUpdate,
  conduitValuesOf,
  dataPathInput,
  dataPathProblems,
  dataPathRows,
  dataPathUpdate,
  dataPathValuesOf,
  deviceInput,
  deviceProblems,
  deviceRows,
  deviceUpdate,
  deviceValuesOf,
  namedRefs,
  upsertAssetChecks,
  upsertConduit,
  upsertDataPath,
  upsertDevice,
  upsertVlan,
  upsertZone,
  vlanInput,
  vlanProblems,
  vlanRows,
  vlanUpdate,
  vlanValuesOf,
  zoneInput,
  zoneProblems,
  zoneRows,
  zoneUpdate,
  zoneValuesOf,
  type ConduitRow,
  type DataPathRow,
  type DeviceRow,
  type NamedRef,
  type NetProblem,
  type VlanRow,
} from './network-model.js';

/**
 * The OT network of the plant registry (#220): per site its IEEE 802.1Q VLANs (optionally linked to a Steward
 * network segment), IEC 62443-3-2 zones and conduits; per asset its devices, data paths and the checks that give its
 * live status. Everything follows the site's rights (plant/access.ts): who sees the site sees its OT network, who
 * manages it changes it; every change is audited on the site or the asset. Status viewers never reach it (the
 * module's routes refuse them), and nothing of it is shown on status pages.
 */

const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
const nextPosition = (table: string, key: string, id: string): number =>
  Number(db().get<{ n: number | null }>(`SELECT MAX(position) AS n FROM ${table} WHERE ${key} = ?`, id)?.n ?? -1) + 1;
const count = (sql: string, ...args: unknown[]) => Number(db().get<{ n: number }>(sql, ...args)!.n);

function invalid(problems: NetProblem[]): void {
  if (!problems.length) return;
  const p = problems[0]!;
  throw new HttpError(400, `${p.path}: ${p.message}`, 'PLANT_NETWORK_INVALID', { path: p.path, message: p.message });
}

function notFound(what: 'vlan' | 'zone' | 'conduit' | 'device' | 'data_path', id: string): HttpError {
  if (what === 'vlan') return new HttpError(404, `VLAN ${id} not found`, 'PLANT_VLAN_NOT_FOUND', { id });
  if (what === 'zone') return new HttpError(404, `Zone ${id} not found`, 'PLANT_ZONE_NOT_FOUND', { id });
  if (what === 'conduit') return new HttpError(404, `Conduit ${id} not found`, 'PLANT_CONDUIT_NOT_FOUND', { id });
  if (what === 'device') return new HttpError(404, `Device ${id} not found`, 'PLANT_DEVICE_NOT_FOUND', { id });
  return new HttpError(404, `Data path ${id} not found`, 'PLANT_DATA_PATH_NOT_FOUND', { id });
}

// ---------- references to Steward items ----------

const KIND_TEXT = {
  system: 'system',
  application: 'application',
  platform: 'platform',
  process: 'process',
  monitor: 'monitor',
  dataset: 'dataset',
} as const;
const refKey = (r: NamedRef) => `${r.kind}:${r.id}:${r.detail ?? ''}`;

/**
 * The Steward items a save names that it did not name before must exist and be visible to the caller (a hidden one
 * reads like a missing one); a segment must be a network segment (a system of kind network). A check that reads
 * another check of a monitor, or another filter or time column of a dataset, names it anew. The columns a dataset
 * check reads must be columns of the dataset (as the caller may see it).
 */
export function refProblems(after: Parameters<typeof namedRefs>[0], before: Parameters<typeof namedRefs>[0] | null): NetProblem[] {
  const had = new Set((before ? namedRefs(before) : []).map(refKey));
  const out: NetProblem[] = [];
  for (const r of namedRefs(after)) {
    if (had.has(refKey(r))) continue;
    if (r.kind === 'monitor') {
      if (!monitorVisible(monitorRow(r.id))) out.push({ path: r.path, message: `There is no monitor "${r.id}"` });
      continue;
    }
    if (r.kind === 'dataset') {
      const meta = readableDataset(r.id);
      if (!meta) {
        out.push({ path: r.path, message: `There is no dataset "${r.id}"` });
        continue;
      }
      const at = r.path.replace(/\.ref$/, '');
      if (r.check && meta.columns.length)
        for (const [k, col] of [
          ['column', r.check.column],
          ['timeColumn', r.check.timeColumn],
        ] as const)
          if (col && !meta.columns.includes(col)) out.push({ path: `${at}.${k}`, message: `The dataset "${r.id}" has no column "${col}"` });
      continue;
    }
    if (!resolveTarget(r.kind, r.id)) {
      out.push({ path: r.path, message: `There is no ${KIND_TEXT[r.kind]} "${r.id}"` });
      continue;
    }
    if (r.path === 'segment' && db().get<{ kind: string }>('SELECT kind FROM systems WHERE id = ?', r.id)?.kind !== 'network')
      out.push({ path: r.path, message: 'Link a network segment (a system of the kind Network segment)' });
  }
  return out;
}

/** A Steward item as the reader may see it: named when visible, linked unless they are a plant viewer. */
export function itemRef(kind: PlantItemRef['kind'], id: string): PlantItemRef {
  if (kind === 'job') return { kind, id, label: id, path: null, visible: true };
  if (kind === 'dataset') {
    // not published, or not visible to the reader: the key is shown as written, not linked
    const visible = readableDataset(id) !== null;
    return { kind, id, label: id, path: visible && !plantOnly(currentUser()) ? '/dashboards' : null, visible };
  }
  const r = resolveTarget(kind, id);
  return { kind, id, label: r?.label ?? '', path: r && !plantOnly(currentUser()) ? r.path : null, visible: !!r };
}

// ---------- views ----------

interface SiteData {
  site: SiteRow;
  perms: PlantPermission[];
  vlans: VlanRow[];
  zones: PlantZoneValues[];
  zoneRows: ReturnType<typeof zoneRows>;
  conduits: ConduitRow[];
  assets: AssetRow[];
  devices: DeviceRow[];
  paths: DataPathRow[];
}

function siteData(siteId: string): SiteData {
  const { row, perms } = visibleSite(siteId);
  const assets = db().all<AssetRow>('SELECT id, name, status, site_id FROM plant_assets WHERE site_id = ? ORDER BY name, id', siteId);
  const ids = assets.map((a) => a.id);
  const inAssets = (table: string) =>
    ids.length
      ? db().all<never>(
          `SELECT d.* FROM ${table} d JOIN plant_assets a ON a.id = d.asset_id WHERE a.site_id = ? ORDER BY a.name, a.id, d.position, d.id`,
          siteId,
        )
      : [];
  const zr = zoneRows(siteId);
  return {
    site: row,
    perms,
    vlans: vlanRows(siteId),
    zones: zr.map(zoneValuesOf),
    zoneRows: zr,
    conduits: conduitRows(siteId),
    assets,
    devices: inAssets('plant_devices') as DeviceRow[],
    paths: inAssets('plant_data_paths') as DataPathRow[],
  };
}

const source = (r: { import_id: string | null; not_in_source: number }) => ({ importId: r.import_id, notInSource: !!r.not_in_source });

/** The sites besides its own that a VLAN reaches, as far as the reader may see them (a hidden site reads like none). */
const seenSites = (sites: string[], rights: Map<string, PlantPermission[]>) => sites.filter((s) => rights.get(s)?.includes('view'));

/**
 * The other sites a save sends, with the ones of `before` the caller may not see kept in their place (they cannot
 * name or remove them); sites that no longer exist are left out.
 */
export function withHiddenSites(input: string[], before: string[] | null, rights: Map<string, PlantPermission[]>): string[] {
  const out = [...input];
  (before ?? []).forEach((s, i) => {
    if (!rights.has(s) || rights.get(s)!.includes('view') || out.includes(s)) return;
    out.splice(Math.min(i, out.length), 0, s);
  });
  return out;
}

function vlanView(r: VlanRow, d: SiteData, rights: Map<string, PlantPermission[]>, names: Map<string, string>): PlantVlanView {
  const v = vlanValuesOf(r);
  let segment: PlantVlanView['segment'] = null;
  let segmentHint: PlantVlanView['segmentHint'] = null;
  if (v.segmentId) {
    const ref = itemRef('system', v.segmentId);
    const sys = ref.visible
      ? db().get<{ kind: string; attributes: string | null }>('SELECT kind, attributes FROM systems WHERE id = ?', v.segmentId)
      : undefined;
    const a = sys ? (attributesOf(sys.kind, sys.attributes) as NetworkAttributes) : null;
    segment = { ...ref, vid: a?.vlanId ?? null, subnets: a?.subnets ?? [] };
    if (a) {
      const diff = subnetDifference(
        v.subnets.map((s) => s.cidr),
        a.subnets ?? [],
      );
      const vidDiffers = v.vid !== null && a.vlanId !== null && v.vid !== a.vlanId;
      if (vidDiffers || diff.onlyVlan.length || diff.onlySegment.length) segmentHint = { vidDiffers, ...diff };
    }
  }
  const sites = seenSites(v.sites, rights);
  return {
    ...v,
    sites,
    ...source(r),
    segment,
    segmentHint,
    otherSites: sites.map((s) => ({ id: s, name: names.get(s) ?? s })),
    zones: d.zones.filter((z) => z.vlans.includes(v.id)).map((z) => z.id),
    deviceCount: d.devices.filter((x) => x.vlan_id === v.id).length,
  };
}

function deviceView(r: DeviceRow, assetName: string, vlans: Map<string, PlantVlanValues>, ctx: LiveContext): PlantDeviceView {
  const v = deviceValuesOf(r);
  const hints: PlantDeviceView['hints'] = [];
  const vlan = v.vlan ? vlans.get(v.vlan) : undefined;
  if (v.vlan && !vlan) hints.push('vlan_missing');
  if (vlan && v.address && vlan.subnets.length) {
    const subnet = vlan.subnets.find((s) => inCidr(v.address, s.cidr));
    if (!subnet) hints.push('address_outside');
    else if (subnet.ranges.some((x) => x.type === 'blocked' && addressBetween(v.address, x.start, x.end))) hints.push('address_blocked');
  }
  return { ...v, checks: checksForReader(v.checks, ctx), ...source(r), assetId: r.asset_id, assetName, live: liveOf(v.checks, ctx), hints };
}

function addressBetween(a: string, start: string, end: string): boolean {
  const x = ipValue(a);
  const lo = ipValue(start);
  const hi = ipValue(end);
  return !!x && !!lo && !!hi && x.v === lo.v && x.v === hi.v && x.n >= lo.n && x.n <= hi.n;
}

/** Hosts a data path reads from (transfer peers that are systems, the collector's host) and writes to (destinations). */
const hostsOf = (p: PlantDataPathValues) => ({
  from: [...p.transfers.filter((t) => t.peerKind === 'system').map((t) => t.peer), ...(p.collector?.host ? [p.collector.host] : [])],
  to: p.destinations.filter((x) => x.kind === 'system').map((x) => x.ref),
});

/** A data path of the chains index: where it sits in the index, its hosts. */
interface IndexedPath {
  i: number;
  r: DataPathRow & { asset_name: string };
  v: PlantDataPathValues;
  from: Set<string>;
  to: Set<string>;
}

/**
 * Every data path of the sites the caller may see, indexed by the hosts it reads from and writes to – built once per
 * request, so the chains (which path reads what another writes) cost the links found, not every pair of paths.
 */
interface PathIndex {
  byKey: Map<string, IndexedPath>;
  readers: Map<string, IndexedPath[]>;
  writers: Map<string, IndexedPath[]>;
  /** The chain links of a host list, once per list (many paths share the same hosts) */
  memo: Map<string, { first: IndexedPath[]; count: number }>;
}

const pathKey = (assetId: string, id: string) => `${assetId}\u0000${id}`;

function pathIndex(rights: Map<string, PlantPermission[]>): PathIndex {
  const idx: PathIndex = { byKey: new Map(), readers: new Map(), writers: new Map(), memo: new Map() };
  const add = (m: Map<string, IndexedPath[]>, host: string, x: IndexedPath) => (m.get(host) ?? m.set(host, []).get(host)!).push(x);
  db()
    .all<DataPathRow & { asset_name: string; site_id: string }>(
      'SELECT d.*, a.name AS asset_name, a.site_id FROM plant_data_paths d JOIN plant_assets a ON a.id = d.asset_id ORDER BY a.name, d.position, d.id',
    )
    .filter((r) => rights.get(r.site_id)?.includes('view'))
    .forEach((r, i) => {
      const v = dataPathValuesOf(r);
      const h = hostsOf(v);
      const x: IndexedPath = { i, r, v, from: new Set(h.from), to: new Set(h.to) };
      idx.byKey.set(pathKey(r.asset_id, v.id), x);
      for (const host of x.from) add(idx.readers, host, x);
      for (const host of x.to) add(idx.writers, host, x);
    });
  return idx;
}

/**
 * The data paths that read from (`readers`) or write to (`writers`) any of these hosts, in index order: the first
 * `chainLinks` + 1 (one may be the path itself) and how many there are.
 */
function chainOf(idx: PathIndex, side: 'readers' | 'writers', hosts: string[]): { first: IndexedPath[]; count: number } {
  const key = `${side}\u0000${hosts.join('\u0000')}`;
  const hit = idx.memo.get(key);
  if (hit) return hit;
  const seen = new Set<number>();
  const found: IndexedPath[] = [];
  for (const h of hosts)
    for (const x of idx[side].get(h) ?? []) {
      if (seen.has(x.i)) continue;
      seen.add(x.i);
      found.push(x);
    }
  // the first ones in index order, without sorting them all
  const first: IndexedPath[] = [];
  for (const x of found) {
    if (first.length <= L.chainLinks) first.push(x);
    else if (x.i < first[first.length - 1]!.i) first[first.length - 1] = x;
    else continue;
    first.sort((a, b) => a.i - b.i);
  }
  const out = { first, count: found.length };
  idx.memo.set(key, out);
  return out;
}

function pathView(r: DataPathRow, assetName: string, idx: PathIndex, refs: Map<string, PlantItemRef>): PlantDataPathView {
  const v = dataPathValuesOf(r);
  const ref = (kind: PlantItemRef['kind'], id: string) => {
    const k = `${kind}:${id}`;
    if (!refs.has(k)) refs.set(k, itemRef(kind, id));
    return refs.get(k)!;
  };
  const mine = hostsOf(v);
  const self = idx.byKey.get(pathKey(r.asset_id, v.id));
  const links = (side: 'readers' | 'writers', hosts: string[]): { list: PlantPathLink[]; more: number } => {
    const unique = [...new Set(hosts)];
    if (!unique.length) return { list: [], more: 0 };
    const c = chainOf(idx, side, unique);
    const others = c.first.filter((x) => x !== self).slice(0, L.chainLinks);
    const total = c.count - (self && unique.some((h) => (side === 'readers' ? self.from : self.to).has(h)) ? 1 : 0);
    return {
      list: others.map((x) => ({
        assetId: x.r.asset_id,
        assetName: x.r.asset_name,
        pathId: x.v.id,
        subject: x.v.subject,
        via: unique.find((h) => (side === 'readers' ? x.from : x.to).has(h))!,
      })),
      more: Math.max(0, total - others.length),
    };
  };
  const next = links('readers', mine.to);
  const previous = links('writers', mine.from);
  return {
    ...v,
    ...source(r),
    assetId: r.asset_id,
    assetName,
    collectorRef: v.collector ? ref(v.collector.kind, v.collector.ref) : null,
    collectorHost: v.collector?.host ? ref('system', v.collector.host) : null,
    peers: v.transfers.map((t) => (t.peerKind === 'system' ? ref('system', t.peer) : null)),
    targets: v.destinations.map((x) => (x.kind === 'system' ? ref('system', x.ref) : x.kind === 'dataset' ? ref('dataset', x.ref) : null)),
    next: next.list,
    previous: previous.list,
    nextMore: next.more,
    previousMore: previous.more,
  };
}

function conduitView(siteId: string, r: ConduitRow): PlantConduitView {
  const linkId = `${siteId}/${r.id}`;
  return {
    ...conduitValuesOf(r),
    ...source(r),
    linkId,
    linkedFrom: listBacklinks('conduit', linkId).map((b) => ({ kind: b.kind, id: b.id, label: b.label, path: b.path, note: b.note })),
  };
}

function zoneView(r: ReturnType<typeof zoneRows>[number], d: SiteData): PlantZoneView {
  const v = zoneValuesOf(r);
  const vlans = new Set(v.vlans);
  return {
    ...v,
    ...source(r),
    conduits: d.conduits.filter((c) => c.zone_a === v.id || c.zone_b === v.id).map((c) => c.id),
    deviceCount: d.devices.filter((x) => x.vlan_id && vlans.has(x.vlan_id)).length,
  };
}

const emptyCounts = (): Record<LiveState, number> => ({ online: 0, offline: 0, unknown: 0 });

/** The OT network of a site, with everything a diagram needs: zones, conduits, VLANs, devices, data paths and hosts. */
export function siteNetwork(siteId: string): PlantSiteNetwork {
  const d = siteData(siteId);
  const siteRows = db().all<SiteRow>('SELECT id, name, acl FROM plant_sites');
  const rights = siteRights(siteRows);
  const names = new Map(siteRows.map((s) => [s.id, s.name]));
  const ctx = liveContext();
  const vlanValues = new Map(d.vlans.map((r) => [r.id, vlanValuesOf(r)]));
  const assetName = new Map(d.assets.map((a) => [a.id, a.name]));
  const devices = d.devices.map((r) => deviceView(r, assetName.get(r.asset_id) ?? r.asset_id, vlanValues, ctx));
  const idx = pathIndex(rights);
  const refs = new Map<string, PlantItemRef>();
  const dataPaths = d.paths.map((r) => pathView(r, assetName.get(r.asset_id) ?? r.asset_id, idx, refs));
  const own = new Map(
    db()
      .all<{ asset_id: string; checks: string }>(
        'SELECT c.asset_id, c.checks FROM plant_asset_checks c JOIN plant_assets a ON a.id = c.asset_id WHERE a.site_id = ?',
        siteId,
      )
      .map((r) => [r.asset_id, parseJson<PlantAssetNetwork['checks']>(r.checks, [])]),
  );
  const statusCounts = emptyCounts();
  const assets: PlantAssetLive[] = d.assets.map((a) => {
    const mine = devices.filter((x) => x.assetId === a.id);
    const live = assetLive(
      liveOf(own.get(a.id) ?? [], ctx),
      mine.map((x) => x.live),
    );
    statusCounts[live.state]++;
    return { id: a.id, name: a.name, status: a.status, live, devices: mine.length, paths: dataPaths.filter((p) => p.assetId === a.id).length };
  });
  const hosts = [...refs.values()].filter((x) => x.kind === 'system');
  return {
    site: { id: d.site.id, code: d.site.code, name: d.site.name, names: parseJson(d.site.names, {}) },
    canManage: d.perms.includes('manage'),
    vlans: d.vlans.map((r) => vlanView(r, d, rights, names)),
    zones: d.zoneRows.map((r) => zoneView(r, d)),
    conduits: d.conduits.map((r) => conduitView(siteId, r)),
    devices,
    dataPaths,
    assets,
    statusCounts,
    hosts,
  };
}

/** Live status of every asset of a site, by state (the site page; cheaper than the whole network). */
export function siteLive(siteId: string): { statusCounts: Record<LiveState, number>; assets: PlantAssetLive[] } {
  const n = siteNetwork(siteId);
  return { statusCounts: n.statusCounts, assets: n.assets };
}

// ---------- VLANs ----------

function manageable(siteId: string, what: string): SiteRow {
  const s = visibleSite(siteId);
  requireManage(s.perms, what);
  return s.row;
}
const touchSite = (id: string) => db().run('UPDATE plant_sites SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), me().username, id);
const vlanRowOf = (siteId: string, id: string) => db().get<VlanRow>('SELECT * FROM plant_vlans WHERE site_id = ? AND id = ?', siteId, id);
const zoneRowOf = (siteId: string, id: string) => zoneRows(siteId).find((z) => z.id === id);
const conduitRowOf = (siteId: string, id: string) => db().get<ConduitRow>('SELECT * FROM plant_conduits WHERE site_id = ? AND id = ?', siteId, id);

export function createVlan(siteId: string, input: z.infer<typeof vlanInput>): PlantSiteNetwork {
  manageable(siteId, 'change this site');
  if (vlanRowOf(siteId, input.id)) throw new HttpError(409, `The site has a VLAN "${input.id}" already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('vlan', siteId, input.id);
  if (count('SELECT COUNT(*) AS n FROM plant_vlans WHERE site_id = ?', siteId) >= L.vlansPerSite)
    throw new HttpError(409, `At most ${L.vlansPerSite} VLANs per site`, 'PLANT_LIMIT', { max: L.vlansPerSite });
  const v: PlantVlanValues = input;
  invalid([...vlanProblems(v, siteId), ...refProblems(v, null)]);
  db().tx(() => {
    upsertVlan(siteId, v, nextPosition('plant_vlans', 'site_id', siteId), { at: nowIso(), by: me().username });
    touchSite(siteId);
    audit({
      action: 'site.vlan_added',
      entityType: 'site',
      entityId: siteId,
      summary: `VLAN "${v.name}" (${v.id}${v.vid !== null ? `, VID ${v.vid}` : ''}) added to site ${siteId}`,
      details: { vlan: v.id, vid: v.vid, subnets: v.subnets.map((s) => s.cidr), segmentId: v.segmentId },
    });
  });
  return siteNetwork(siteId);
}

export function updateVlan(siteId: string, vlanId: string, input: z.infer<typeof vlanUpdate>): PlantSiteNetwork {
  manageable(siteId, 'change this site');
  const cur = vlanRowOf(siteId, vlanId);
  if (!cur) throw notFound('vlan', vlanId);
  const before = vlanValuesOf(cur);
  const rights = siteRights(db().all<SiteRow>('SELECT id, acl FROM plant_sites'));
  const v: PlantVlanValues = { id: vlanId, ...input, sites: withHiddenSites(input.sites, before.sites, rights) };
  invalid([...vlanProblems(v, siteId), ...refProblems(v, before)]);
  const changes = changedKeys(before, v);
  if (!changes.length) return siteNetwork(siteId);
  db().tx(() => {
    upsertVlan(siteId, v, cur.position, { at: nowIso(), by: me().username }, { keepSource: true });
    touchSite(siteId);
    audit({
      action: 'site.vlan_changed',
      entityType: 'site',
      entityId: siteId,
      summary: `VLAN "${v.name}" (${vlanId}) of site ${siteId} changed (${changes.join(', ')})`,
      details: { vlan: vlanId, changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return siteNetwork(siteId);
}

export function deleteVlan(siteId: string, vlanId: string): PlantSiteNetwork {
  manageable(siteId, 'change this site');
  const cur = vlanRowOf(siteId, vlanId);
  if (!cur) throw notFound('vlan', vlanId);
  const zones = zoneRows(siteId).filter((z) => parseJson<string[]>(z.vlans, []).includes(vlanId)).length;
  const devices = count(
    'SELECT COUNT(*) AS n FROM plant_devices d JOIN plant_assets a ON a.id = d.asset_id WHERE a.site_id = ? AND d.vlan_id = ?',
    siteId,
    vlanId,
  );
  if (zones || devices) throw new HttpError(409, `${zones} zones and ${devices} devices name VLAN "${cur.name}"`, 'PLANT_VLAN_IN_USE', { zones, devices });
  db().tx(() => {
    db().run('DELETE FROM plant_vlans WHERE site_id = ? AND id = ?', siteId, vlanId);
    touchSite(siteId);
    audit({
      action: 'site.vlan_removed',
      entityType: 'site',
      entityId: siteId,
      summary: `VLAN "${cur.name}" (${vlanId}) removed from site ${siteId}`,
      details: { vlan: vlanId, old: vlanValuesOf(cur) },
    });
  });
  return siteNetwork(siteId);
}

/**
 * "Create segment from this VLAN": a Steward network segment (a system of kind network, with the catalogue's own
 * rights and audit) with the VLAN's VID and subnets, the zones it is in and the site's name – linked to the VLAN.
 * Nothing becomes a segment on its own.
 */
export function createSegmentFromVlan(siteId: string, vlanId: string, name: string | undefined): PlantSiteNetwork {
  const site = manageable(siteId, 'change this site');
  const cur = vlanRowOf(siteId, vlanId);
  if (!cur) throw notFound('vlan', vlanId);
  const v = vlanValuesOf(cur);
  if (v.segmentId && resolveTarget('system', v.segmentId))
    throw new HttpError(409, 'The VLAN is linked to a network segment already', 'PLANT_VLAN_HAS_SEGMENT', { id: v.segmentId });
  const zones = zoneRows(siteId)
    .filter((z) => parseJson<string[]>(z.vlans, []).includes(vlanId))
    .map((z) => z.name);
  const sys = createSystem({
    name: (name ?? v.name).trim().slice(0, 120) || v.name,
    kind: 'network',
    vendor: '',
    cmdbUrl: '',
    owners: [],
    note: `Created from VLAN ${v.id} of plant site ${site.name} (plant registry).`,
    attributes: {
      vlanId: v.vid,
      subnets: v.subnets.map((s) => s.cidr).slice(0, 32),
      zone: zones.join(', ').slice(0, 120),
      site: site.name.slice(0, 120),
      firewallManagedBy: null,
      firewallProvider: '',
    },
  });
  db().tx(() => {
    db().run(
      'UPDATE plant_vlans SET segment_id = ?, updated_at = ?, updated_by = ? WHERE site_id = ? AND id = ?',
      sys.id,
      nowIso(),
      me().username,
      siteId,
      vlanId,
    );
    touchSite(siteId);
    audit({
      action: 'site.vlan_changed',
      entityType: 'site',
      entityId: siteId,
      summary: `Network segment "${sys.name}" created from VLAN "${v.name}" (${vlanId}) of site ${siteId} and linked to it`,
      details: { vlan: vlanId, changes: ['segmentId'], old: { segmentId: v.segmentId }, new: { segmentId: sys.id }, created: sys.id },
    });
  });
  return siteNetwork(siteId);
}

// ---------- zones and conduits ----------

export function createZone(siteId: string, input: z.infer<typeof zoneInput>): PlantSiteNetwork {
  manageable(siteId, 'change this site');
  if (zoneRowOf(siteId, input.id)) throw new HttpError(409, `The site has a zone "${input.id}" already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('zone', siteId, input.id);
  if (zoneRows(siteId).length >= L.zonesPerSite) throw new HttpError(409, `At most ${L.zonesPerSite} zones per site`, 'PLANT_LIMIT', { max: L.zonesPerSite });
  const v: PlantZoneValues = input;
  invalid(zoneProblems(v, new Set(vlanRows(siteId).map((x) => x.id))));
  db().tx(() => {
    upsertZone(siteId, v, nextPosition('plant_zones', 'site_id', siteId), { at: nowIso(), by: me().username });
    touchSite(siteId);
    audit({
      action: 'site.zone_added',
      entityType: 'site',
      entityId: siteId,
      summary: `Zone "${v.name}" (${v.id}) added to site ${siteId}${v.slTarget ? ` (SL-T ${v.slTarget})` : ''}`,
      details: { zone: v.id, criticality: v.criticality, slTarget: v.slTarget, vlans: v.vlans },
    });
  });
  return siteNetwork(siteId);
}

export function updateZone(siteId: string, zoneId: string, input: z.infer<typeof zoneUpdate>): PlantSiteNetwork {
  manageable(siteId, 'change this site');
  const cur = zoneRowOf(siteId, zoneId);
  if (!cur) throw notFound('zone', zoneId);
  const before = zoneValuesOf(cur);
  const v: PlantZoneValues = { id: zoneId, ...input };
  invalid(zoneProblems(v, new Set(vlanRows(siteId).map((x) => x.id))));
  const changes = changedKeys(before, v);
  if (!changes.length) return siteNetwork(siteId);
  db().tx(() => {
    upsertZone(siteId, v, cur.position, { at: nowIso(), by: me().username }, { keepSource: true });
    touchSite(siteId);
    audit({
      action: 'site.zone_changed',
      entityType: 'site',
      entityId: siteId,
      summary: `Zone "${v.name}" (${zoneId}) of site ${siteId} changed (${changes.join(', ')})`,
      details: { zone: zoneId, changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return siteNetwork(siteId);
}

export function deleteZone(siteId: string, zoneId: string): PlantSiteNetwork {
  manageable(siteId, 'change this site');
  const cur = zoneRowOf(siteId, zoneId);
  if (!cur) throw notFound('zone', zoneId);
  const conduits = count('SELECT COUNT(*) AS n FROM plant_conduits WHERE site_id = ? AND (zone_a = ? OR zone_b = ?)', siteId, zoneId, zoneId);
  if (conduits) throw new HttpError(409, `${conduits} conduits connect zone "${cur.name}"`, 'PLANT_ZONE_IN_USE', { conduits });
  db().tx(() => {
    db().run('DELETE FROM plant_zones WHERE site_id = ? AND id = ?', siteId, zoneId);
    touchSite(siteId);
    audit({
      action: 'site.zone_removed',
      entityType: 'site',
      entityId: siteId,
      summary: `Zone "${cur.name}" (${zoneId}) removed from site ${siteId}`,
      details: { zone: zoneId, old: zoneValuesOf(cur) },
    });
  });
  return siteNetwork(siteId);
}

export function createConduit(siteId: string, input: z.infer<typeof conduitInput>): PlantSiteNetwork {
  manageable(siteId, 'change this site');
  if (conduitRowOf(siteId, input.id)) throw new HttpError(409, `The site has a conduit "${input.id}" already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('conduit', siteId, input.id);
  if (count('SELECT COUNT(*) AS n FROM plant_conduits WHERE site_id = ?', siteId) >= L.conduitsPerSite)
    throw new HttpError(409, `At most ${L.conduitsPerSite} conduits per site`, 'PLANT_LIMIT', { max: L.conduitsPerSite });
  const v: PlantConduitValues = input;
  invalid(conduitProblems(v, new Set(zoneRows(siteId).map((x) => x.id))));
  db().tx(() => {
    upsertConduit(siteId, v, nextPosition('plant_conduits', 'site_id', siteId), { at: nowIso(), by: me().username });
    touchSite(siteId);
    audit({
      action: 'site.conduit_added',
      entityType: 'site',
      entityId: siteId,
      summary: `Conduit "${v.name}" (${v.id}) between zones ${v.zones[0]} and ${v.zones[1]} added to site ${siteId}`,
      details: { conduit: v.id, zones: v.zones, direction: v.direction, protocols: v.protocols, controls: v.controls },
    });
  });
  return siteNetwork(siteId);
}

export function updateConduit(siteId: string, conduitId: string, input: z.infer<typeof conduitUpdate>): PlantSiteNetwork {
  manageable(siteId, 'change this site');
  const cur = conduitRowOf(siteId, conduitId);
  if (!cur) throw notFound('conduit', conduitId);
  const before = conduitValuesOf(cur);
  const v: PlantConduitValues = { id: conduitId, ...input };
  invalid(conduitProblems(v, new Set(zoneRows(siteId).map((x) => x.id))));
  const changes = changedKeys(before, v);
  if (!changes.length) return siteNetwork(siteId);
  db().tx(() => {
    upsertConduit(siteId, v, cur.position, { at: nowIso(), by: me().username }, { keepSource: true });
    touchSite(siteId);
    audit({
      action: 'site.conduit_changed',
      entityType: 'site',
      entityId: siteId,
      summary: `Conduit "${v.name}" (${conduitId}) of site ${siteId} changed (${changes.join(', ')})`,
      details: { conduit: conduitId, changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return siteNetwork(siteId);
}

export function deleteConduit(siteId: string, conduitId: string): PlantSiteNetwork {
  manageable(siteId, 'change this site');
  const cur = conduitRowOf(siteId, conduitId);
  if (!cur) throw notFound('conduit', conduitId);
  db().tx(() => {
    db().run('DELETE FROM plant_conduits WHERE site_id = ? AND id = ?', siteId, conduitId);
    touchSite(siteId);
    audit({
      action: 'site.conduit_removed',
      entityType: 'site',
      entityId: siteId,
      summary: `Conduit "${cur.name}" (${conduitId}) removed from site ${siteId}`,
      details: { conduit: conduitId, old: conduitValuesOf(cur) },
    });
  });
  return siteNetwork(siteId);
}

// ---------- an asset: devices, data paths, checks ----------

export function assetNetwork(assetId: string): PlantAssetNetwork {
  const { row, perms } = visibleAsset(assetId);
  const rights = siteRights(db().all<SiteRow>('SELECT id, acl FROM plant_sites'));
  const ctx = liveContext();
  const vlans = vlanRows(row.site_id).map(vlanValuesOf);
  const byId = new Map(vlans.map((v) => [v.id, v]));
  const devices = deviceRows(assetId).map((r) => deviceView(r, row.name, byId, ctx));
  const idx = pathIndex(rights);
  const refs = new Map<string, PlantItemRef>();
  const checksRow = assetChecksRow(assetId);
  const own = liveOf(assetChecksValuesOf(checksRow).checks, ctx);
  return {
    asset: { id: row.id, name: row.name, siteId: row.site_id },
    canManage: perms.includes('manage'),
    live: assetLive(
      own,
      devices.map((d) => d.live),
    ),
    checks: checksForReader(assetChecksValuesOf(checksRow).checks, ctx),
    checksSource: { importId: checksRow?.import_id ?? null, notInSource: !!checksRow?.not_in_source },
    devices,
    dataPaths: dataPathRows(assetId).map((r) => pathView(r, row.name, idx, refs)),
    vlans: vlans.map((v) => ({ id: v.id, name: v.name, vid: v.vid })),
  };
}

function manageableAsset(assetId: string) {
  const a = visibleAsset(assetId);
  requireManage(a.perms, 'change this asset');
  return a.row;
}
const deviceRowOf = (assetId: string, id: string) => db().get<DeviceRow>('SELECT * FROM plant_devices WHERE asset_id = ? AND id = ?', assetId, id);
const pathRowOf = (assetId: string, id: string) => db().get<DataPathRow>('SELECT * FROM plant_data_paths WHERE asset_id = ? AND id = ?', assetId, id);
const siteVlans = (siteId: string) => new Set(vlanRows(siteId).map((v) => v.id));
const assetDevices = (assetId: string) => new Set(deviceRows(assetId).map((d) => d.id));

export function createDevice(assetId: string, input: z.infer<typeof deviceInput>): PlantAssetNetwork {
  const a = manageableAsset(assetId);
  if (deviceRowOf(assetId, input.id)) throw new HttpError(409, `The asset has a device "${input.id}" already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('device', assetId, input.id);
  if (deviceRows(assetId).length >= L.devicesPerAsset)
    throw new HttpError(409, `At most ${L.devicesPerAsset} devices per asset`, 'PLANT_LIMIT', { max: L.devicesPerAsset });
  const hidden = withHiddenChecks(input.checks, null);
  const v: PlantDeviceValues = { ...input, checks: hidden.checks };
  invalid([...hidden.problems, ...deviceProblems(v, siteVlans(a.site_id)), ...refProblems(v, null)]);
  db().tx(() => {
    upsertDevice(assetId, v, nextPosition('plant_devices', 'asset_id', assetId), { at: nowIso(), by: me().username });
    audit({
      action: 'asset.device_added',
      entityType: 'asset',
      entityId: assetId,
      summary: `Device ${v.id}${v.hostname ? ` (${v.hostname})` : ''} added to asset "${a.name}"`,
      details: { device: v.id, vlan: v.vlan, address: v.address, mac: v.mac },
    });
  });
  return assetNetwork(assetId);
}

export function updateDevice(assetId: string, deviceId: string, input: z.infer<typeof deviceUpdate>): PlantAssetNetwork {
  const a = manageableAsset(assetId);
  const cur = deviceRowOf(assetId, deviceId);
  if (!cur) throw notFound('device', deviceId);
  const before = deviceValuesOf(cur);
  const hidden = withHiddenChecks(input.checks, before.checks);
  const v: PlantDeviceValues = { id: deviceId, ...input, checks: hidden.checks };
  invalid([...hidden.problems, ...deviceProblems(v, siteVlans(a.site_id)), ...refProblems(v, before)]);
  const changes = changedKeys(before, v);
  if (!changes.length) return assetNetwork(assetId);
  db().tx(() => {
    upsertDevice(assetId, v, cur.position, { at: nowIso(), by: me().username }, { keepSource: true });
    audit({
      action: 'asset.device_changed',
      entityType: 'asset',
      entityId: assetId,
      summary: `Device ${deviceId} of asset "${a.name}" changed (${changes.join(', ')})`,
      details: { device: deviceId, changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return assetNetwork(assetId);
}

export function deleteDevice(assetId: string, deviceId: string): PlantAssetNetwork {
  const a = manageableAsset(assetId);
  const cur = deviceRowOf(assetId, deviceId);
  if (!cur) throw notFound('device', deviceId);
  const paths = dataPathRows(assetId).filter((p) => {
    const v = dataPathValuesOf(p);
    return v.devices.includes(deviceId) || v.transfers.some((t) => t.peerKind === 'device' && t.peer === deviceId);
  }).length;
  if (paths) throw new HttpError(409, `${paths} data paths name device ${deviceId}`, 'PLANT_DEVICE_IN_USE', { paths });
  db().tx(() => {
    db().run('DELETE FROM plant_devices WHERE asset_id = ? AND id = ?', assetId, deviceId);
    audit({
      action: 'asset.device_removed',
      entityType: 'asset',
      entityId: assetId,
      summary: `Device ${deviceId} removed from asset "${a.name}"`,
      details: { device: deviceId, old: deviceValuesOf(cur) },
    });
  });
  return assetNetwork(assetId);
}

export function createDataPath(assetId: string, input: z.infer<typeof dataPathInput>): PlantAssetNetwork {
  const a = manageableAsset(assetId);
  if (pathRowOf(assetId, input.id)) throw new HttpError(409, `The asset has a data path "${input.id}" already`, 'PLANT_ID_TAKEN', { id: input.id });
  // an old id of a renamed entry still leads there (0.11.0): it is not free
  refuseAliasId('data_path', assetId, input.id);
  if (dataPathRows(assetId).length >= L.pathsPerAsset)
    throw new HttpError(409, `At most ${L.pathsPerAsset} data paths per asset`, 'PLANT_LIMIT', { max: L.pathsPerAsset });
  const v: PlantDataPathValues = input;
  invalid([...dataPathProblems(v, assetDevices(assetId)), ...refProblems(v, null)]);
  db().tx(() => {
    upsertDataPath(assetId, v, nextPosition('plant_data_paths', 'asset_id', assetId), { at: nowIso(), by: me().username });
    audit({
      action: 'asset.data_path_added',
      entityType: 'asset',
      entityId: assetId,
      summary: `Data path "${v.subject}" (${v.id}) added to asset "${a.name}"`,
      details: { path: v.id, collector: v.collector, transfers: v.transfers.length, destinations: v.destinations.length },
    });
  });
  return assetNetwork(assetId);
}

export function updateDataPath(assetId: string, pathId: string, input: z.infer<typeof dataPathUpdate>): PlantAssetNetwork {
  const a = manageableAsset(assetId);
  const cur = pathRowOf(assetId, pathId);
  if (!cur) throw notFound('data_path', pathId);
  const before = dataPathValuesOf(cur);
  const v: PlantDataPathValues = { id: pathId, ...input };
  invalid([...dataPathProblems(v, assetDevices(assetId)), ...refProblems(v, before)]);
  const changes = changedKeys(before, v);
  if (!changes.length) return assetNetwork(assetId);
  db().tx(() => {
    upsertDataPath(assetId, v, cur.position, { at: nowIso(), by: me().username }, { keepSource: true });
    audit({
      action: 'asset.data_path_changed',
      entityType: 'asset',
      entityId: assetId,
      summary: `Data path "${v.subject}" (${pathId}) of asset "${a.name}" changed (${changes.join(', ')})`,
      details: { path: pathId, changes, old: pick(before, changes), new: pick(v, changes) },
    });
  });
  return assetNetwork(assetId);
}

export function deleteDataPath(assetId: string, pathId: string): PlantAssetNetwork {
  const a = manageableAsset(assetId);
  const cur = pathRowOf(assetId, pathId);
  if (!cur) throw notFound('data_path', pathId);
  db().tx(() => {
    db().run('DELETE FROM plant_data_paths WHERE asset_id = ? AND id = ?', assetId, pathId);
    audit({
      action: 'asset.data_path_removed',
      entityType: 'asset',
      entityId: assetId,
      summary: `Data path "${cur.subject}" (${pathId}) removed from asset "${a.name}"`,
      details: { path: pathId, old: dataPathValuesOf(cur) },
    });
  });
  return assetNetwork(assetId);
}

export function putAssetChecks(assetId: string, input: z.infer<typeof assetChecksInput>): PlantAssetNetwork {
  const a = manageableAsset(assetId);
  const cur = assetChecksRow(assetId);
  const before = assetChecksValuesOf(cur);
  const hidden = withHiddenChecks(input.checks, before.checks);
  const after = { checks: hidden.checks };
  invalid([...hidden.problems, ...assetChecksProblems(after), ...refProblems(after, before)]);
  if (JSON.stringify(before.checks) === JSON.stringify(after.checks)) return assetNetwork(assetId);
  db().tx(() => {
    upsertAssetChecks(assetId, after, { at: nowIso(), by: me().username }, { keepSource: true });
    audit({
      action: 'asset.checks_set',
      entityType: 'asset',
      entityId: assetId,
      summary: `Live-status checks of asset "${a.name}" set (${after.checks.length})`,
      details: { old: before.checks, new: after.checks },
    });
  });
  return assetNetwork(assetId);
}

// ---------- conduits as a link kind: firewall changes (FWC) and other records link to them ----------

const like = (q: string) => `%${likeEscape(q.trim().toLowerCase())}%`;

registerLinkKind('conduit', {
  resolve(id) {
    if (!plantEnabled()) return null;
    const i = id.indexOf('/');
    if (i < 1) return null;
    const siteId = id.slice(0, i);
    const s = siteRowOf(siteId);
    const c = s ? conduitRowOf(siteId, id.slice(i + 1)) : undefined;
    if (!s || !c || !sitePermissions(s).includes('view')) return null;
    return {
      label: c.name,
      path: `/plant/sites/${encodeURIComponent(siteId)}/network/zones#conduit-${encodeURIComponent(c.id)}`,
      detail: `${c.zone_a} ↔ ${c.zone_b} · ${s.code || s.name}`,
    };
  },
  search(q, limit): LinkTarget[] {
    if (!plantEnabled()) return [];
    const sites = db().all<SiteRow>('SELECT id, code, name, acl FROM plant_sites');
    const rights = siteRights(sites);
    const byId = new Map(sites.map((s) => [s.id, s]));
    return db()
      .all<ConduitRow>(
        "SELECT * FROM plant_conduits WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(id) LIKE ? ESCAPE '\\' ORDER BY name, site_id, id LIMIT 2000",
        like(q),
        like(q),
      )
      .filter((c) => rights.get(c.site_id)?.includes('view'))
      .slice(0, limit)
      .map((c) => ({
        kind: 'conduit' as const,
        id: `${c.site_id}/${c.id}`,
        label: c.name,
        detail: `${c.zone_a} ↔ ${c.zone_b} · ${byId.get(c.site_id)?.code || byId.get(c.site_id)?.name || c.site_id}`,
      }));
  },
});

export {
  vlanInput,
  vlanUpdate,
  zoneInput,
  zoneUpdate,
  conduitInput,
  conduitUpdate,
  deviceInput,
  deviceUpdate,
  dataPathInput,
  dataPathUpdate,
  assetChecksInput,
};
export type { PlantLiveStatus };
