import type { z } from 'zod';
import {
  macOf,
  type PlantAssetChecksValues,
  type PlantChangeKind,
  type PlantConduitValues,
  type PlantDataPathValues,
  type PlantDeviceValues,
  type PlantImportMode,
  type PlantImportProblem,
  type PlantMissing,
  type PlantPermission,
  type PlantStatusCheck,
  type PlantVlanValues,
  type PlantZoneValues,
} from '@sm/shared';
import { db } from '../db.js';
import type { AssetRow, SiteRow } from './model.js';
import type { AssetNetworkFile, OtNetworkFile, PlantFile, StatusCheckFile } from './format.js';
import { clean, pushWrite, type Origin, type Write } from './import-data.js';
import { refProblems, withHiddenSites } from './network.js';
import { checkVisible, liveContext, withStoredHiddenChecks } from './live.js';
import { siteRights } from './access.js';
import {
  assetChecksInput,
  assetChecksProblems,
  assetChecksValuesOf,
  conduitInput,
  conduitProblems,
  conduitValuesOf,
  dataPathInput,
  dataPathProblems,
  dataPathValuesOf,
  deviceInput,
  deviceProblems,
  deviceValuesOf,
  upsertAssetChecks,
  upsertConduit,
  upsertDataPath,
  upsertDevice,
  upsertVlan,
  upsertZone,
  vlanInput,
  vlanProblems,
  vlanValuesOf,
  zoneInput,
  zoneProblems,
  zoneValuesOf,
  type AssetChecksRow,
  type ConduitRow,
  type DataPathRow,
  type DeviceRow,
  type NetProblem,
  type VlanRow,
  type ZoneRow,
} from './network-model.js';

/**
 * The YAML import and export of part 3 (#220): the OT network of sites (`ot_network(s)`: VLANs, IEC 62443-3-2 zones
 * and conduits) and of assets (`asset_network(s)`: devices, data paths and their live-status checks), in format 1 with
 * the modes of part 1. Records are matched by their ids – a VLAN, zone or conduit by its site and id, a device or data
 * path by its asset and id, the checks by their asset. Everything needs the manage right on the site.
 */

// ---------- the plan ----------

const has = <T extends object>(o: T, k: keyof T) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v)).trim();
const key = (a: string, b: string) => `${a}/${b}`;

interface Planned<V> extends Origin {
  owner: string;
  position: number;
  values: Partial<V> & { id: string };
}

interface PlannedAssetNet extends Origin {
  assetId: string;
  siteId: string | null;
  /** The checks of the asset itself, when the file has the key */
  checks: PlantStatusCheck[] | undefined;
}

export interface NetPlan {
  sites: Map<string, Origin>;
  vlans: Map<string, Planned<PlantVlanValues>>;
  zones: Map<string, Planned<PlantZoneValues>>;
  conduits: Map<string, Planned<PlantConduitValues>>;
  assets: Map<string, PlannedAssetNet>;
  devices: Map<string, Planned<PlantDeviceValues>>;
  paths: Map<string, Planned<PlantDataPathValues>>;
}

export const emptyNetPlan = (): NetPlan => ({
  sites: new Map(),
  vlans: new Map(),
  zones: new Map(),
  conduits: new Map(),
  assets: new Map(),
  devices: new Map(),
  paths: new Map(),
});
export const netPlanEmpty = (p: NetPlan) => !p.sites.size && !p.assets.size;

export const checkFromFile = (c: StatusCheckFile): PlantStatusCheck =>
  c.monitor
    ? { kind: 'monitor', ref: c.monitor.trim(), check: str(c.check), column: '', value: '', timeColumn: '', maxAgeMinutes: null, note: str(c.note) }
    : {
        kind: 'dataset',
        ref: str(c.dataset),
        check: '',
        column: str(c.column),
        value: str(c.value),
        timeColumn: str(c.time_column),
        maxAgeMinutes: c.max_age_minutes ?? null,
        note: str(c.note),
      };

type NetFile = NonNullable<OtNetworkFile['vlans']>[number];
type ZoneFile = NonNullable<OtNetworkFile['zones']>[number];
type ConduitFile = NonNullable<OtNetworkFile['conduits']>[number];
type DeviceFile = NonNullable<AssetNetworkFile['devices']>[number];
type PathFile = NonNullable<AssetNetworkFile['data_paths']>[number];

function vlanFromFile(x: NetFile): Planned<PlantVlanValues>['values'] {
  const v: Planned<PlantVlanValues>['values'] = { id: x.id, name: x.name.trim() };
  if (has(x, 'vid')) v.vid = x.vid ?? null;
  for (const [f, k] of [
    ['type', 'type'],
    ['owner', 'owner'],
    ['description', 'description'],
    ['managed_by', 'managedBy'],
    ['rules_at', 'rulesAt'],
    ['location', 'location'],
    ['notes', 'notes'],
  ] as const)
    if (has(x, f)) v[k] = str(x[f]);
  if (has(x, 'subnets'))
    v.subnets = (x.subnets ?? []).map((s) => ({
      cidr: s.cidr.trim(),
      gateway: str(s.gateway),
      description: str(s.description),
      ranges: (s.ranges ?? []).map((r) => ({ start: r.start.trim(), end: r.end.trim(), type: r.type, notes: str(r.notes) })),
    }));
  if (has(x, 'restricted')) v.restricted = !!x.restricted;
  if (has(x, 'sites')) v.sites = x.sites ?? [];
  if (has(x, 'segment')) v.segmentId = str(x.segment) || null;
  return v;
}

function zoneFromFile(x: ZoneFile): Planned<PlantZoneValues>['values'] {
  const v: Planned<PlantZoneValues>['values'] = { id: x.id, name: x.name.trim() };
  for (const [f, k] of [
    ['description', 'description'],
    ['owner', 'owner'],
    ['risk_assessment', 'riskAssessment'],
    ['notes', 'notes'],
  ] as const)
    if (has(x, f)) v[k] = str(x[f]);
  if (has(x, 'criticality')) v.criticality = x.criticality ?? null;
  if (has(x, 'level')) v.level = x.level ?? null;
  if (has(x, 'vlans')) v.vlans = x.vlans ?? [];
  if (has(x, 'sl_t')) v.slTarget = x.sl_t ?? null;
  if (has(x, 'assessed_at')) v.assessedAt = x.assessed_at ?? null;
  return v;
}

function conduitFromFile(x: ConduitFile): Planned<PlantConduitValues>['values'] {
  const v: Planned<PlantConduitValues>['values'] = { id: x.id, name: x.name.trim(), zones: [x.zones[0], x.zones[1]] };
  for (const k of ['description', 'notes'] as const) if (has(x, k)) v[k] = str(x[k]);
  if (has(x, 'direction')) v.direction = x.direction ?? 'both';
  if (has(x, 'protocols')) v.protocols = (x.protocols ?? []).map((p) => p.trim()).filter(Boolean);
  if (has(x, 'controls')) v.controls = (x.controls ?? []).map((p) => p.trim()).filter(Boolean);
  return v;
}

function deviceFromFile(x: DeviceFile): Planned<PlantDeviceValues>['values'] {
  const v: Planned<PlantDeviceValues>['values'] = { id: x.id };
  for (const [f, k] of [
    ['hostname', 'hostname'],
    ['domain', 'domain'],
    ['purpose', 'purpose'],
    ['serial', 'serial'],
    ['address', 'address'],
    ['switch', 'switch'],
    ['switch_port', 'switchPort'],
    ['wall_outlet', 'wallOutlet'],
    ['cmdb_port', 'cmdbPort'],
    ['owner', 'owner'],
    ['monitoring', 'monitoring'],
    ['notes', 'notes'],
  ] as const)
    if (has(x, f)) v[k] = str(x[f]);
  // a MAC in any usual spelling is stored in IEEE 802 notation; a wrong one is reported by the check below
  if (has(x, 'mac')) v.mac = str(x.mac) ? (macOf(str(x.mac)) ?? str(x.mac)) : '';
  if (has(x, 'vlan')) v.vlan = x.vlan ?? null;
  if (has(x, 'address_type')) v.addressType = x.address_type ?? null;
  if (has(x, 'state')) v.state = x.state ?? 'active';
  if (has(x, 'flags')) v.flags = (x.flags ?? []).map((f) => f.trim());
  if (has(x, 'confidence')) v.confidence = x.confidence ?? null;
  if (has(x, 'checks')) v.checks = (x.checks ?? []).map(checkFromFile);
  return v;
}

function pathFromFile(x: PathFile): Planned<PlantDataPathValues>['values'] {
  const v: Planned<PlantDataPathValues>['values'] = { id: x.id, subject: x.subject.trim() };
  for (const k of ['description', 'notes'] as const) if (has(x, k)) v[k] = str(x[k]);
  if (has(x, 'devices')) v.devices = x.devices ?? [];
  if (has(x, 'collector')) v.collector = x.collector ? { kind: x.collector.kind, ref: x.collector.ref.trim(), host: str(x.collector.host) || null } : null;
  if (has(x, 'transfers'))
    v.transfers = (x.transfers ?? []).map((t) => ({
      protocol: t.protocol.trim(),
      mode: t.mode,
      peerKind: t.peer_kind ?? 'other',
      peer: str(t.peer),
      port: t.port ?? null,
      notes: str(t.notes),
    }));
  if (has(x, 'destinations'))
    v.destinations = (x.destinations ?? []).map((d) => ({ kind: d.kind ?? 'other', ref: d.ref.trim(), path: str(d.path), notes: str(d.notes) }));
  return v;
}

/** Adds what a file says about OT networks to the plan. */
export function planNetwork(p: NetPlan, f: PlantFile, file: string, problems: PlantImportProblem[]): void {
  const twice = (o: Origin, what: string, first: Origin) =>
    problems.push({ ...o, message: `${what} is defined twice (also in ${first.file} at ${first.path})` });
  const nets: [OtNetworkFile, string][] = f.ot_network ? [[f.ot_network, 'ot_network']] : (f.ot_networks ?? []).map((x, i) => [x, `ot_networks[${i}]`]);
  for (const [n, path] of nets) {
    const o = { file, path };
    const first = p.sites.get(n.site);
    if (first) {
      twice(o, `The OT network of site "${n.site}"`, first);
      continue;
    }
    p.sites.set(n.site, o);
    const add = <V>(map: Map<string, Planned<V>>, list: { id: string }[] | undefined, at: string, what: string, of: (x: never) => Planned<V>['values']) =>
      (list ?? []).forEach((x, i) => {
        const ro = { file, path: `${path}.${at}[${i}]` };
        const k = key(n.site, x.id);
        const fx = map.get(k);
        if (fx) return twice(ro, `${what} "${x.id}"`, fx);
        map.set(k, { ...ro, owner: n.site, position: i, values: of(x as never) });
      });
    add(p.vlans, n.vlans, 'vlans', 'VLAN', vlanFromFile);
    add(p.zones, n.zones, 'zones', 'Zone', zoneFromFile);
    add(p.conduits, n.conduits, 'conduits', 'Conduit', conduitFromFile);
  }
  const assets: [AssetNetworkFile, string][] = f.asset_network
    ? [[f.asset_network, 'asset_network']]
    : (f.asset_networks ?? []).map((x, i) => [x, `asset_networks[${i}]`]);
  for (const [a, path] of assets) {
    const o = { file, path };
    const first = p.assets.get(a.asset);
    if (first) {
      twice(o, `The OT network of asset "${a.asset}"`, first);
      continue;
    }
    p.assets.set(a.asset, { ...o, assetId: a.asset, siteId: a.site ?? null, checks: has(a, 'checks') ? (a.checks ?? []).map(checkFromFile) : undefined });
    (a.devices ?? []).forEach((x, i) => {
      const ro = { file, path: `${path}.devices[${i}]` };
      const k = key(a.asset, x.id);
      const fx = p.devices.get(k);
      if (fx) return twice(ro, `Device "${x.id}"`, fx);
      p.devices.set(k, { ...ro, owner: a.asset, position: i, values: deviceFromFile(x) });
    });
    (a.data_paths ?? []).forEach((x, i) => {
      const ro = { file, path: `${path}.data_paths[${i}]` };
      const k = key(a.asset, x.id);
      const fx = p.paths.get(k);
      if (fx) return twice(ro, `Data path "${x.id}"`, fx);
      p.paths.set(k, { ...ro, owner: a.asset, position: i, values: pathFromFile(x) });
    });
  }
}

// ---------- comparing with what is stored ----------

const VLAN_DEFAULTS = (id: string): PlantVlanValues => ({
  id,
  name: id,
  vid: null,
  type: '',
  owner: '',
  description: '',
  subnets: [],
  restricted: false,
  managedBy: '',
  rulesAt: '',
  sites: [],
  location: '',
  segmentId: null,
  notes: '',
});
const ZONE_DEFAULTS = (id: string): PlantZoneValues => ({
  id,
  name: id,
  description: '',
  criticality: null,
  level: null,
  vlans: [],
  owner: '',
  slTarget: null,
  riskAssessment: '',
  assessedAt: null,
  notes: '',
});
const CONDUIT_DEFAULTS = (id: string): PlantConduitValues => ({
  id,
  name: id,
  description: '',
  zones: ['', ''],
  direction: 'both',
  protocols: [],
  controls: [],
  notes: '',
});
const DEVICE_DEFAULTS = (id: string): PlantDeviceValues => ({
  id,
  hostname: '',
  domain: '',
  purpose: '',
  mac: '',
  serial: '',
  vlan: null,
  addressType: null,
  address: '',
  switch: '',
  switchPort: '',
  wallOutlet: '',
  cmdbPort: '',
  state: 'active',
  flags: [],
  confidence: null,
  owner: '',
  monitoring: '',
  checks: [],
  notes: '',
});
const PATH_DEFAULTS = (id: string): PlantDataPathValues => ({
  id,
  subject: id,
  description: '',
  devices: [],
  collector: null,
  transfers: [],
  destinations: [],
  notes: '',
});

/** API names of the values as the file spells them (for the place of a problem). */
const FILE_KEYS: Record<string, string> = {
  segmentId: 'segment',
  slTarget: 'sl_t',
  peerKind: 'peer_kind',
  timeColumn: 'time_column',
  maxAgeMinutes: 'max_age_minutes',
  ref: 'monitor',
};
const fileKey = (k: string) => FILE_KEYS[k] ?? k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const filePath = (path: PropertyKey[]) =>
  path.reduce<string>((s, p) => (typeof p === 'number' ? `${s}[${p}]` : s ? `${s}.${fileKey(String(p))}` : fileKey(String(p))), '');

/** The same rules as an edit: the API's input schema, with the problems at their place in the file. */
function checked<S extends z.ZodType>(schema: S, v: unknown, o: Origin, problems: PlantImportProblem[]): z.infer<S> | null {
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  for (const i of r.error.issues.slice(0, 10))
    problems.push({ file: o.file, path: `${o.path}${i.path.length ? `.${filePath(i.path)}` : ''}`, message: i.message });
  return null;
}
const report = (o: Origin, list: NetProblem[], problems: PlantImportProblem[]) =>
  list.forEach((x) => problems.push({ file: o.file, path: `${o.path}.${x.path}`, message: x.message }));

export interface NetContext {
  plan: NetPlan;
  mode: PlantImportMode;
  missing: PlantMissing;
  prevId: string | null;
  importId: string;
  meta: { importId: string; notInSource: boolean; at: string; by: string };
  writes: Write[];
  problems: PlantImportProblem[];
  warnings: PlantImportProblem[];
  rights: Map<string, PlantPermission[]>;
  sites: Map<string, SiteRow>;
  storedAssets: Map<string, AssetRow>;
  /** Sites there after the import (stored and not removed, or in the files) */
  postSites: Set<string>;
  removedSites: Set<string>;
  postSite: Map<string, string>;
  removedAssets: Set<string>;
  fileSites: Set<string>;
  needManage: (siteId: string, o: Origin) => void;
}

const all = <R>(sql: string) => db().all<R>(sql);

/** Compares the OT network records of the files with what is stored and adds the writes. */
export function computeNetwork(c: NetContext): void {
  const { plan: p, mode, problems, warnings, writes } = c;
  const full = mode === 'replace';
  const fromPrev = (r: { import_id: string | null }) => !!c.prevId && r.import_id === c.prevId;
  const stored = {
    vlans: new Map(all<VlanRow>('SELECT * FROM plant_vlans').map((r) => [key(r.site_id, r.id), r])),
    zones: new Map(all<ZoneRow>('SELECT * FROM plant_zones').map((r) => [key(r.site_id, r.id), r])),
    conduits: new Map(all<ConduitRow>('SELECT * FROM plant_conduits').map((r) => [key(r.site_id, r.id), r])),
    devices: new Map(all<DeviceRow>('SELECT * FROM plant_devices').map((r) => [key(r.asset_id, r.id), r])),
    paths: new Map(all<DataPathRow>('SELECT * FROM plant_data_paths').map((r) => [key(r.asset_id, r.id), r])),
    checks: new Map(all<AssetChecksRow>('SELECT * FROM plant_asset_checks').map((r) => [r.asset_id, r])),
  };
  const visible = (siteId: string) => !c.sites.has(siteId) || !!c.rights.get(siteId)?.includes('view');
  const siteOfAsset = (assetId: string) => c.postSite.get(assetId);

  // ---- which sites and assets the files may touch
  const okSites = new Set<string>();
  for (const [siteId, o] of p.sites) {
    if (!c.postSites.has(siteId) || (!visible(siteId) && !c.fileSites.has(siteId))) {
      problems.push({ ...o, path: `${o.path}.site`, message: `There is no site "${siteId}"` });
      continue;
    }
    c.needManage(siteId, o);
    okSites.add(siteId);
  }
  const okAssets = new Map<string, string>();
  for (const [assetId, a] of p.assets) {
    const siteId = siteOfAsset(assetId);
    const o = { file: a.file, path: `${a.path}.asset` };
    if (siteId === undefined) {
      problems.push({ ...o, message: `There is no asset "${assetId}"` });
      continue;
    }
    // an asset in a site the caller may not see reads like one they may not change
    if (!visible(siteId)) {
      if (c.fileSites.has(siteId)) c.needManage(siteId, a);
      else problems.push({ ...o, message: `You may not add or change asset "${assetId}"` });
      continue;
    }
    if (a.siteId && a.siteId !== siteId)
      problems.push({ ...a, path: `${a.path}.site`, message: `Asset "${assetId}" is in site "${siteId}", not "${a.siteId}"` });
    c.needManage(siteId, a);
    okAssets.set(assetId, siteId);
  }

  // ---- what goes (replace, remove): records of the earlier import the files no longer have
  const goes = <R extends { import_id: string | null }>(map: Map<string, R>, planned: Map<string, unknown>, ownerGone: (r: R) => boolean) =>
    new Set(full && c.missing === 'remove' && c.prevId ? [...map].filter(([k, r]) => fromPrev(r) && !planned.has(k) && !ownerGone(r)).map(([k]) => k) : []);
  const siteGone = (r: { site_id: string }) => c.removedSites.has(r.site_id);
  const assetGone = (r: { asset_id: string }) => c.removedAssets.has(r.asset_id);
  const removing = {
    vlans: goes(stored.vlans, p.vlans, siteGone),
    zones: goes(stored.zones, p.zones, siteGone),
    conduits: goes(stored.conduits, p.conduits, siteGone),
    devices: goes(stored.devices, p.devices, assetGone),
    paths: goes(stored.paths, p.paths, assetGone),
  };
  // records of sites the caller may not change (or see) stay
  const mayChange = (siteId: string | undefined) => !!siteId && !!c.rights.get(siteId)?.includes('manage');
  for (const k of [...removing.vlans]) if (!mayChange(stored.vlans.get(k)!.site_id)) removing.vlans.delete(k);
  for (const k of [...removing.zones]) if (!mayChange(stored.zones.get(k)!.site_id)) removing.zones.delete(k);
  for (const k of [...removing.conduits]) if (!mayChange(stored.conduits.get(k)!.site_id)) removing.conduits.delete(k);
  for (const k of [...removing.devices]) if (!mayChange(siteOfAsset(stored.devices.get(k)!.asset_id))) removing.devices.delete(k);
  for (const k of [...removing.paths]) if (!mayChange(siteOfAsset(stored.paths.get(k)!.asset_id))) removing.paths.delete(k);

  // ---- the ids there after the import, per site and asset
  const postIds = (storedKeys: Iterable<string>, planned: Iterable<string>, gone: Set<string>) => {
    const out = new Map<string, Set<string>>();
    for (const k of [...storedKeys].filter((x) => !gone.has(x)).concat([...planned])) {
      const i = k.indexOf('/');
      const owner = k.slice(0, i);
      (out.get(owner) ?? out.set(owner, new Set()).get(owner)!).add(k.slice(i + 1));
    }
    return out;
  };
  const postVlans = postIds(stored.vlans.keys(), p.vlans.keys(), removing.vlans);
  const postZones = postIds(stored.zones.keys(), p.zones.keys(), removing.zones);
  const postDevices = postIds(stored.devices.keys(), p.devices.keys(), removing.devices);
  const none = new Set<string>();

  // ---- the records of the files
  const plannedRecords = <V extends { id: string }, R extends { import_id: string | null; not_in_source: number }>(args: {
    planned: Map<string, Planned<V>>;
    stored: Map<string, R>;
    ok: (owner: string) => string | null;
    kind: PlantChangeKind;
    defaults: (id: string) => V;
    valuesOf: (r: R) => V;
    schema: z.ZodType;
    rules: (v: V, owner: string, siteId: string) => NetProblem[];
    nameOf: (v: V) => string;
    write: (owner: string, v: V, position: number) => void;
    adopt: (owner: string, id: string, position: number) => void;
    refs?: boolean;
    /** What the importer may not see of the stored record stays (they cannot name or remove it) */
    keep?: (after: V, before: V | null) => V;
  }) => {
    for (const [k, x] of args.planned) {
      const siteId = args.ok(x.owner);
      if (!siteId) continue;
      const cur = args.stored.get(k);
      const before = cur ? args.valuesOf(cur) : null;
      const merged = { ...(before && !full ? before : args.defaults(x.values.id)), ...x.values } as V;
      const parsed = checked(args.schema, merged, x, problems) as V | null;
      if (!parsed) continue;
      const parsedAfter = { ...parsed, id: x.values.id } as V;
      const after = args.keep ? args.keep(parsedAfter, before) : parsedAfter;
      report(x, args.rules(after, x.owner, siteId), problems);
      if (args.refs) report(x, refProblems(after, before), problems);
      const id = args.kind === 'device' || args.kind === 'data_path' ? k : after.id;
      pushWrite(
        writes,
        mode,
        args.kind,
        siteId,
        id,
        args.nameOf(after),
        before,
        after,
        cur,
        () => args.write(x.owner, after, x.position),
        () => args.adopt(x.owner, after.id, x.position),
      );
    }
  };
  const siteOk = (siteId: string) => (okSites.has(siteId) ? siteId : null);
  const assetOk = (assetId: string) => okAssets.get(assetId) ?? null;
  const adoptSql = (table: string, ownerCol: string) => (owner: string, id: string, position: number) =>
    db().run(`UPDATE ${table} SET import_id = ?, not_in_source = 0, position = ? WHERE ${ownerCol} = ? AND id = ?`, c.importId, position, owner, id);

  plannedRecords<PlantVlanValues, VlanRow>({
    planned: p.vlans,
    stored: stored.vlans,
    ok: siteOk,
    kind: 'vlan',
    defaults: VLAN_DEFAULTS,
    valuesOf: vlanValuesOf,
    schema: vlanInput,
    rules: (v, site) => vlanProblems(v, site),
    nameOf: (v) => v.name,
    write: (site, v, pos) => upsertVlan(site, v, pos, c.meta),
    adopt: adoptSql('plant_vlans', 'site_id'),
    refs: true,
    keep: (v, before) => ({ ...v, sites: withHiddenSites(v.sites, before?.sites ?? null, c.rights) }),
  });
  plannedRecords<PlantZoneValues, ZoneRow>({
    planned: p.zones,
    stored: stored.zones,
    ok: siteOk,
    kind: 'zone',
    defaults: ZONE_DEFAULTS,
    valuesOf: zoneValuesOf,
    schema: zoneInput,
    rules: (v, site) => zoneProblems(v, postVlans.get(site) ?? none),
    nameOf: (v) => v.name,
    write: (site, v, pos) => upsertZone(site, v, pos, c.meta),
    adopt: adoptSql('plant_zones', 'site_id'),
  });
  plannedRecords<PlantConduitValues, ConduitRow>({
    planned: p.conduits,
    stored: stored.conduits,
    ok: siteOk,
    kind: 'conduit',
    defaults: CONDUIT_DEFAULTS,
    valuesOf: conduitValuesOf,
    schema: conduitInput,
    rules: (v, site) => conduitProblems(v, postZones.get(site) ?? none),
    nameOf: (v) => v.name,
    write: (site, v, pos) => upsertConduit(site, v, pos, c.meta),
    adopt: adoptSql('plant_conduits', 'site_id'),
  });
  plannedRecords<PlantDeviceValues, DeviceRow>({
    planned: p.devices,
    stored: stored.devices,
    ok: assetOk,
    kind: 'device',
    defaults: DEVICE_DEFAULTS,
    valuesOf: deviceValuesOf,
    schema: deviceInput,
    rules: (v, _asset, site) => deviceProblems(v, postVlans.get(site) ?? none),
    nameOf: (v) => v.hostname || v.id,
    write: (asset, v, pos) => upsertDevice(asset, v, pos, c.meta),
    adopt: adoptSql('plant_devices', 'asset_id'),
    refs: true,
    keep: (v, before) => ({ ...v, checks: withStoredHiddenChecks(v.checks, before?.checks) }),
  });
  plannedRecords<PlantDataPathValues, DataPathRow>({
    planned: p.paths,
    stored: stored.paths,
    ok: assetOk,
    kind: 'data_path',
    defaults: PATH_DEFAULTS,
    valuesOf: dataPathValuesOf,
    schema: dataPathInput,
    rules: (v, asset) => dataPathProblems(v, postDevices.get(asset) ?? none),
    nameOf: (v) => v.subject,
    write: (asset, v, pos) => upsertDataPath(asset, v, pos, c.meta),
    adopt: adoptSql('plant_data_paths', 'asset_id'),
    refs: true,
  });
  // the checks of an asset itself
  for (const [assetId, a] of p.assets) {
    const siteId = okAssets.get(assetId);
    if (!siteId || !a.checks) continue;
    const cur = stored.checks.get(assetId);
    const before = cur ? assetChecksValuesOf(cur) : null;
    const read = checked(assetChecksInput, { checks: a.checks }, a, problems) as PlantAssetChecksValues | null;
    if (!read) continue;
    const parsed: PlantAssetChecksValues = { checks: withStoredHiddenChecks(read.checks, before?.checks) };
    report(a, assetChecksProblems(parsed), problems);
    report(a, refProblems(parsed, before), problems);
    pushWrite(
      writes,
      mode,
      'asset_checks',
      siteId,
      assetId,
      c.storedAssets.get(assetId)?.name ?? assetId,
      before,
      parsed,
      cur,
      () => upsertAssetChecks(assetId, parsed, c.meta),
      () => db().run('UPDATE plant_asset_checks SET import_id = ?, not_in_source = 0 WHERE asset_id = ?', c.importId, assetId),
    );
  }

  // ---- what the earlier import wrote and the files no longer have
  if (!full || !c.prevId) return;
  const gone = (
    kind: PlantChangeKind,
    siteId: string | undefined,
    id: string,
    name: string,
    r: { not_in_source: number },
    remove: () => void,
    mark: () => void,
  ) => {
    // records of sites the caller may not see are not theirs to hear of: they stay, unnamed
    if (!siteId || !c.rights.get(siteId)?.includes('view')) return;
    if (!c.rights.get(siteId)?.includes('manage')) {
      warnings.push({
        file: '(files)',
        path: kind,
        message: `${kind.replace('_', ' ')} "${id}" is not in the files, but you may not change site "${siteId}": it stays`,
      });
      return;
    }
    if (c.missing === 'remove') writes.push({ kind, action: 'remove', siteId, id, name, apply: remove });
    else if (r.not_in_source) writes.push({ kind, action: 'unchanged', siteId, id, name, note: 'not in source', apply: mark });
    else writes.push({ kind, action: 'mark', siteId, id, name, note: 'kept, marked "not in source"', apply: mark });
  };
  const mark = (table: string, ownerCol: string, owner: string, id: string) => () =>
    db().run(`UPDATE ${table} SET not_in_source = 1, import_id = ? WHERE ${ownerCol} = ? AND id = ?`, c.importId, owner, id);
  const del = (table: string, ownerCol: string, owner: string, id: string) => () =>
    db().run(`DELETE FROM ${table} WHERE ${ownerCol} = ? AND id = ?`, owner, id);
  for (const [table, kind, map, planned] of [
    ['plant_vlans', 'vlan', stored.vlans, p.vlans],
    ['plant_zones', 'zone', stored.zones, p.zones],
    ['plant_conduits', 'conduit', stored.conduits, p.conduits],
  ] as const)
    for (const [k, r] of map as Map<string, VlanRow | ZoneRow | ConduitRow>)
      if (fromPrev(r) && !planned.has(k) && !c.removedSites.has(r.site_id))
        gone(kind, r.site_id, r.id, r.name, r, del(table, 'site_id', r.site_id, r.id), mark(table, 'site_id', r.site_id, r.id));
  for (const [k, r] of stored.devices)
    if (fromPrev(r) && !p.devices.has(k) && !c.removedAssets.has(r.asset_id))
      gone(
        'device',
        siteOfAsset(r.asset_id),
        k,
        r.hostname || r.id,
        r,
        del('plant_devices', 'asset_id', r.asset_id, r.id),
        mark('plant_devices', 'asset_id', r.asset_id, r.id),
      );
  for (const [k, r] of stored.paths)
    if (fromPrev(r) && !p.paths.has(k) && !c.removedAssets.has(r.asset_id))
      gone(
        'data_path',
        siteOfAsset(r.asset_id),
        k,
        r.subject,
        r,
        del('plant_data_paths', 'asset_id', r.asset_id, r.id),
        mark('plant_data_paths', 'asset_id', r.asset_id, r.id),
      );
  for (const [assetId, r] of stored.checks)
    if (fromPrev(r) && !p.assets.get(assetId)?.checks && !c.removedAssets.has(assetId))
      gone(
        'asset_checks',
        siteOfAsset(assetId),
        assetId,
        c.storedAssets.get(assetId)?.name ?? assetId,
        r,
        () => db().run('DELETE FROM plant_asset_checks WHERE asset_id = ?', assetId),
        () => db().run('UPDATE plant_asset_checks SET not_in_source = 1, import_id = ? WHERE asset_id = ?', c.importId, assetId),
      );

  // ---- records that stay and name something that goes: the import stops (add it to the files, or keep and mark)
  if (c.missing !== 'remove') return;
  const stop = (what: string, by: string) =>
    problems.push({
      file: '(files)',
      path: 'ot_networks',
      message: `${what} is removed, but ${by} still names it – add it to the files, or keep and mark the missing records`,
    });
  for (const [k, r] of stored.zones) {
    if (removing.zones.has(k) || p.zones.has(k) || c.removedSites.has(r.site_id)) continue;
    for (const v of parseJsonList(r.vlans)) if (removing.vlans.has(key(r.site_id, v))) stop(`VLAN "${v}"`, `zone "${r.id}"`);
  }
  for (const [k, r] of stored.conduits) {
    if (removing.conduits.has(k) || p.conduits.has(k) || c.removedSites.has(r.site_id)) continue;
    for (const z of [r.zone_a, r.zone_b]) if (removing.zones.has(key(r.site_id, z))) stop(`Zone "${z}"`, `conduit "${r.id}"`);
  }
  for (const [k, r] of stored.devices) {
    if (removing.devices.has(k) || p.devices.has(k) || c.removedAssets.has(r.asset_id) || !r.vlan_id) continue;
    const site = siteOfAsset(r.asset_id);
    if (site && removing.vlans.has(key(site, r.vlan_id))) stop(`VLAN "${r.vlan_id}"`, visible(site) ? `device "${r.id}" of asset "${r.asset_id}"` : 'a device');
  }
  for (const [k, r] of stored.paths) {
    if (removing.paths.has(k) || p.paths.has(k) || c.removedAssets.has(r.asset_id)) continue;
    const v = dataPathValuesOf(r);
    for (const d of new Set([...v.devices, ...v.transfers.filter((t) => t.peerKind === 'device').map((t) => t.peer)]))
      if (removing.devices.has(key(r.asset_id, d))) stop(`Device "${d}"`, `data path "${r.id}" of asset "${r.asset_id}"`);
  }
}

const parseJsonList = (s: string): string[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return []; // a damaged value names nothing
  }
};

// ---------- export ----------

const checkOut = (c: PlantStatusCheck) =>
  c.kind === 'monitor'
    ? clean({ monitor: c.ref, check: c.check, note: c.note })
    : clean({ dataset: c.ref, column: c.column, value: c.value, time_column: c.timeColumn, max_age_minutes: c.maxAgeMinutes, note: c.note });

/** The OT network of a site in the file format (null: it has none). */
export function otNetworkOut(siteId: string): Record<string, unknown> | null {
  const rights = siteRights(db().all<SiteRow>('SELECT id, acl FROM plant_sites'));
  const vlans = db().all<VlanRow>('SELECT * FROM plant_vlans WHERE site_id = ? ORDER BY position, id', siteId).map(vlanValuesOf);
  const zones = db().all<ZoneRow>('SELECT * FROM plant_zones WHERE site_id = ? ORDER BY position, id', siteId).map(zoneValuesOf);
  const conduits = db().all<ConduitRow>('SELECT * FROM plant_conduits WHERE site_id = ? ORDER BY position, id', siteId).map(conduitValuesOf);
  if (!vlans.length && !zones.length && !conduits.length) return null;
  return {
    site: siteId,
    ...clean({
      vlans: vlans.map((v) => ({
        ...clean({
          id: v.id,
          name: v.name,
          vid: v.vid,
          type: v.type,
          owner: v.owner,
          description: v.description,
          subnets: v.subnets.map((s) =>
            clean({
              cidr: s.cidr,
              gateway: s.gateway,
              description: s.description,
              ranges: s.ranges.map((r) => clean({ start: r.start, end: r.end, type: r.type, notes: r.notes })),
            }),
          ),
          restricted: v.restricted,
          managed_by: v.managedBy,
          rules_at: v.rulesAt,
          // the other sites as far as the exporter may see them (an import keeps the others)
          sites: v.sites.filter((x) => rights.get(x)?.includes('view')),
          location: v.location,
          segment: v.segmentId,
          notes: v.notes,
        }),
      })),
      zones: zones.map((z) =>
        clean({
          id: z.id,
          name: z.name,
          description: z.description,
          criticality: z.criticality,
          level: z.level,
          vlans: z.vlans,
          owner: z.owner,
          sl_t: z.slTarget,
          risk_assessment: z.riskAssessment,
          assessed_at: z.assessedAt,
          notes: z.notes,
        }),
      ),
      conduits: conduits.map((x) => ({
        ...clean({ id: x.id, name: x.name, description: x.description }),
        zones: x.zones,
        ...clean({ direction: x.direction === 'both' ? '' : x.direction, protocols: x.protocols, controls: x.controls, notes: x.notes }),
      })),
    }),
  };
}

/** The OT networks of assets in the file format (only those with devices, data paths or checks). */
export function assetNetworksOut(assetIds: string[]): Record<string, unknown>[] {
  if (!assetIds.length) return [];
  const want = new Set(assetIds);
  const group = <R extends { asset_id: string }>(rows: R[]) => {
    const m = new Map<string, R[]>();
    for (const r of rows) if (want.has(r.asset_id)) (m.get(r.asset_id) ?? m.set(r.asset_id, []).get(r.asset_id)!).push(r);
    return m;
  };
  const devices = group(db().all<DeviceRow>('SELECT * FROM plant_devices ORDER BY asset_id, position, id'));
  const paths = group(db().all<DataPathRow>('SELECT * FROM plant_data_paths ORDER BY asset_id, position, id'));
  const checks = new Map(
    db()
      .all<AssetChecksRow>('SELECT * FROM plant_asset_checks')
      .map((r) => [r.asset_id, assetChecksValuesOf(r).checks]),
  );
  // checks the exporter may not see are left out (an import keeps them)
  const ctx = liveContext();
  const seen = (list: PlantStatusCheck[]) => list.filter((c) => checkVisible(c, ctx)).map(checkOut);
  return assetIds
    .filter((a) => devices.has(a) || paths.has(a) || checks.has(a))
    .map((a) => ({
      asset: a,
      ...(checks.has(a) ? { checks: seen(checks.get(a)!) } : {}),
      ...clean({
        devices: (devices.get(a) ?? []).map(deviceValuesOf).map((d) =>
          clean({
            id: d.id,
            hostname: d.hostname,
            domain: d.domain,
            purpose: d.purpose,
            mac: d.mac,
            serial: d.serial,
            vlan: d.vlan,
            address_type: d.addressType,
            address: d.address,
            switch: d.switch,
            switch_port: d.switchPort,
            wall_outlet: d.wallOutlet,
            cmdb_port: d.cmdbPort,
            state: d.state === 'active' ? '' : d.state,
            flags: d.flags,
            confidence: d.confidence,
            owner: d.owner,
            monitoring: d.monitoring,
            checks: seen(d.checks),
            notes: d.notes,
          }),
        ),
        data_paths: (paths.get(a) ?? []).map(dataPathValuesOf).map((x) =>
          clean({
            id: x.id,
            subject: x.subject,
            description: x.description,
            devices: x.devices,
            collector: x.collector ? clean({ kind: x.collector.kind, ref: x.collector.ref, host: x.collector.host }) : null,
            transfers: x.transfers.map((t) =>
              clean({ protocol: t.protocol, mode: t.mode, peer_kind: t.peerKind === 'other' ? '' : t.peerKind, peer: t.peer, port: t.port, notes: t.notes }),
            ),
            destinations: x.destinations.map((d) => clean({ kind: d.kind === 'other' ? '' : d.kind, ref: d.ref, path: d.path, notes: d.notes })),
            notes: x.notes,
          }),
        ),
      }),
    }));
}
