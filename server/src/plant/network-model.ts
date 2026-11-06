import { z } from 'zod';
import {
  ADDRESS_TYPES,
  cidrRange,
  COLLECTOR_KINDS,
  CONDUIT_DIRECTIONS,
  DESTINATION_KINDS,
  DEVICE_CONFIDENCE,
  DEVICE_STATES,
  ipValue,
  inCidr,
  isCidr,
  isHostName,
  isIpAddress,
  macOf,
  PEER_KINDS,
  PLANT_FIELD_KEY_RE,
  PLANT_LIMITS,
  PLANT_NETWORK_LIMITS as L,
  STATUS_CHECK_KINDS,
  TRANSFER_MODES,
  VLAN_RANGE_TYPES,
  ZONE_CRITICALITIES,
  type PlantAssetChecksValues,
  type PlantCollector,
  type PlantConduitValues,
  type PlantDataPathValues,
  type PlantDeviceValues,
  type PlantStatusCheck,
  type PlantVlanValues,
  type PlantZoneValues,
  type SecurityLevel,
} from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { plantId } from './model.js';
import { isDate } from './settings.js';

/**
 * Part 3 of the plant registry (#220), as stored and as values: VLANs, IEC 62443-3-2 zones and conduits of a site;
 * devices, data paths and the linked checks of an asset. Ids of VLANs, zones and conduits are unique in their site,
 * ids of devices and data paths in their asset. Rules that hold on every save (an edit or an import) are here.
 */

// ---------- rows ----------

interface Source {
  import_id: string | null;
  not_in_source: number;
  position: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface VlanRow extends Source {
  site_id: string;
  id: string;
  name: string;
  vid: number | null;
  type: string;
  owner: string;
  description: string;
  subnets: string;
  restricted: number;
  managed_by: string;
  rules_at: string;
  sites: string;
  location: string;
  segment_id: string | null;
  notes: string;
}

export interface ZoneRow extends Source {
  site_id: string;
  id: string;
  name: string;
  description: string;
  criticality: string | null;
  vlans: string;
  owner: string;
  sl_target: number | null;
  risk_assessment: string;
  assessed_at: string | null;
  notes: string;
}

export interface ConduitRow extends Source {
  site_id: string;
  id: string;
  name: string;
  description: string;
  zone_a: string;
  zone_b: string;
  direction: string;
  protocols: string;
  controls: string;
  notes: string;
}

export interface DeviceRow extends Source {
  asset_id: string;
  id: string;
  hostname: string;
  domain: string;
  purpose: string;
  mac: string;
  serial: string;
  vlan_id: string | null;
  address_type: string | null;
  address: string;
  switch_name: string;
  switch_port: string;
  wall_outlet: string;
  cmdb_port: string;
  state: string;
  flags: string;
  confidence: string | null;
  owner: string;
  monitoring: string;
  checks: string;
  notes: string;
}

export interface DataPathRow extends Source {
  asset_id: string;
  id: string;
  subject: string;
  description: string;
  devices: string;
  collector: string | null;
  transfers: string;
  destinations: string;
  notes: string;
}

export interface AssetChecksRow extends Omit<Source, 'position'> {
  asset_id: string;
  checks: string;
}

export const vlanValuesOf = (r: VlanRow): PlantVlanValues => ({
  id: r.id,
  name: r.name,
  vid: r.vid === null ? null : Number(r.vid),
  type: r.type,
  owner: r.owner,
  description: r.description,
  subnets: parseJson(r.subnets, []),
  restricted: !!Number(r.restricted),
  managedBy: r.managed_by,
  rulesAt: r.rules_at,
  sites: parseJson(r.sites, []),
  location: r.location,
  segmentId: r.segment_id,
  notes: r.notes,
});

export const zoneValuesOf = (r: ZoneRow): PlantZoneValues => ({
  id: r.id,
  name: r.name,
  description: r.description,
  criticality: (r.criticality || null) as PlantZoneValues['criticality'],
  vlans: parseJson(r.vlans, []),
  owner: r.owner,
  slTarget: r.sl_target === null ? null : (Number(r.sl_target) as SecurityLevel),
  riskAssessment: r.risk_assessment,
  assessedAt: r.assessed_at,
  notes: r.notes,
});

export const conduitValuesOf = (r: ConduitRow): PlantConduitValues => ({
  id: r.id,
  name: r.name,
  description: r.description,
  zones: [r.zone_a, r.zone_b],
  direction: r.direction as PlantConduitValues['direction'],
  protocols: parseJson(r.protocols, []),
  controls: parseJson(r.controls, []),
  notes: r.notes,
});

export const deviceValuesOf = (r: DeviceRow): PlantDeviceValues => ({
  id: r.id,
  hostname: r.hostname,
  domain: r.domain,
  purpose: r.purpose,
  mac: r.mac,
  serial: r.serial,
  vlan: r.vlan_id,
  addressType: (r.address_type || null) as PlantDeviceValues['addressType'],
  address: r.address,
  switch: r.switch_name,
  switchPort: r.switch_port,
  wallOutlet: r.wall_outlet,
  cmdbPort: r.cmdb_port,
  state: r.state as PlantDeviceValues['state'],
  flags: parseJson(r.flags, []),
  confidence: (r.confidence || null) as PlantDeviceValues['confidence'],
  owner: r.owner,
  monitoring: r.monitoring,
  checks: parseJson(r.checks, []),
  notes: r.notes,
});

export const dataPathValuesOf = (r: DataPathRow): PlantDataPathValues => ({
  id: r.id,
  subject: r.subject,
  description: r.description,
  devices: parseJson(r.devices, []),
  collector: parseJson<PlantCollector | null>(r.collector, null),
  transfers: parseJson(r.transfers, []),
  destinations: parseJson(r.destinations, []),
  notes: r.notes,
});

export const assetChecksValuesOf = (r: AssetChecksRow | undefined): PlantAssetChecksValues => ({ checks: r ? parseJson(r.checks, []) : [] });

// ---------- reading ----------

export const vlanRows = (siteId: string) => db().all<VlanRow>('SELECT * FROM plant_vlans WHERE site_id = ? ORDER BY position, id', siteId);
export const zoneRows = (siteId: string) => db().all<ZoneRow>('SELECT * FROM plant_zones WHERE site_id = ? ORDER BY position, id', siteId);
export const conduitRows = (siteId: string) => db().all<ConduitRow>('SELECT * FROM plant_conduits WHERE site_id = ? ORDER BY position, id', siteId);
export const deviceRows = (assetId: string) => db().all<DeviceRow>('SELECT * FROM plant_devices WHERE asset_id = ? ORDER BY position, id', assetId);
export const dataPathRows = (assetId: string) => db().all<DataPathRow>('SELECT * FROM plant_data_paths WHERE asset_id = ? ORDER BY position, id', assetId);
export const assetChecksRow = (assetId: string) => db().get<AssetChecksRow>('SELECT * FROM plant_asset_checks WHERE asset_id = ?', assetId);

// ---------- input (the API, camelCase) ----------

const text = (max: number = L.text) => z.string().trim().max(max).default('');
const POISON = new Set(['__proto__', 'constructor', 'prototype']);
const name = z.string().trim().min(1).max(PLANT_LIMITS.name);
const ip = z
  .string()
  .trim()
  .max(45)
  .refine((v) => !v || isIpAddress(v), 'Use an IPv4 or IPv6 address (192.0.2.10, 2001:db8::10)');
const cidr = z
  .string()
  .trim()
  .max(50)
  .refine((v) => isCidr(v), 'Use a subnet in CIDR notation, IPv4 or IPv6 (192.0.2.0/24, 2001:db8::/48)');
const list = (max: number, item = z.string().trim().min(1).max(L.text)) => z.array(item).max(max).default([]);
const date = z
  .string()
  .trim()
  .refine((v) => isDate(v), 'Use a date (YYYY-MM-DD)')
  .nullable()
  .default(null);

export const statusCheckInput = z
  .object({
    kind: z.enum(STATUS_CHECK_KINDS),
    ref: z.string().trim().max(200),
    check: text(128),
    column: text(120),
    value: text(L.text),
    timeColumn: text(120),
    maxAgeMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 365)
      .nullable()
      .default(null),
    note: text(500),
    /** A check the caller may not see, sent back as it was read (live.ts `withHiddenChecks`) */
    hiddenSlot: z
      .number()
      .int()
      .min(0)
      .max(L.checks - 1)
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.hiddenSlot === undefined && !c.ref) ctx.addIssue({ code: 'custom', path: ['ref'], message: 'Name the monitor or dataset' });
  });
export const checksInput = z.array(statusCheckInput).max(L.checks).default([]);

export const vlanInput = z
  .object({
    id: plantId,
    name,
    vid: z.number().int().min(1, 'An IEEE 802.1Q VLAN ID is 1–4094').max(4094, 'An IEEE 802.1Q VLAN ID is 1–4094').nullable().default(null),
    type: text(60),
    owner: text(),
    description: text(L.longText),
    subnets: z
      .array(
        z
          .object({
            cidr,
            gateway: ip.default(''),
            description: text(500),
            ranges: z
              .array(z.object({ start: ip, end: ip, type: z.enum(VLAN_RANGE_TYPES), notes: text(500) }).strict())
              .max(L.ranges)
              .default([]),
          })
          .strict(),
      )
      .max(L.subnets)
      .default([]),
    restricted: z.boolean().default(false),
    managedBy: text(),
    rulesAt: text(2000),
    sites: list(L.sites, plantId),
    location: text(),
    segmentId: z.string().trim().min(1).max(100).nullable().default(null),
    notes: text(L.longText),
  })
  .strict();
export const vlanUpdate = vlanInput.omit({ id: true });

export const zoneInput = z
  .object({
    id: plantId,
    name,
    description: text(L.longText),
    criticality: z.enum(ZONE_CRITICALITIES).nullable().default(null),
    vlans: list(L.vlansPerZone, plantId),
    owner: text(),
    slTarget: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .nullable()
      .default(null),
    riskAssessment: text(500),
    assessedAt: date,
    notes: text(L.longText),
  })
  .strict();
export const zoneUpdate = zoneInput.omit({ id: true });

export const conduitInput = z
  .object({
    id: plantId,
    name,
    description: text(L.longText),
    zones: z.tuple([plantId, plantId]),
    direction: z.enum(CONDUIT_DIRECTIONS).default('both'),
    protocols: list(L.protocols),
    controls: list(L.controls),
    notes: text(L.longText),
  })
  .strict();
export const conduitUpdate = conduitInput.omit({ id: true });

export const deviceInput = z
  .object({
    id: plantId,
    hostname: text(L.host),
    domain: text(L.host),
    purpose: text(),
    mac: z
      .string()
      .trim()
      .max(20)
      .refine((v) => !v || macOf(v) !== null, 'Use a MAC address (EUI-48): AC-DE-48-00-00-80, ac:de:48:00:00:80 or acde.4800.0080')
      .transform((v) => (v ? macOf(v)! : ''))
      .default(''),
    serial: text(),
    vlan: plantId.nullable().default(null),
    addressType: z.enum(ADDRESS_TYPES).nullable().default(null),
    address: ip.default(''),
    switch: text(),
    switchPort: text(100),
    wallOutlet: text(100),
    cmdbPort: text(),
    state: z.enum(DEVICE_STATES).default('active'),
    flags: list(
      L.flags,
      z
        .string()
        .trim()
        .regex(PLANT_FIELD_KEY_RE, 'A flag is snake_case: device_ordered, port_ordered …')
        .refine((v) => !POISON.has(v)),
    ),
    confidence: z.enum(DEVICE_CONFIDENCE).nullable().default(null),
    owner: text(),
    monitoring: text(500),
    checks: checksInput,
    notes: text(L.longText),
  })
  .strict();
export const deviceUpdate = deviceInput.omit({ id: true });

const collectorInput = z
  .object({
    kind: z.enum(COLLECTOR_KINDS),
    ref: z.string().trim().min(1).max(L.text),
    host: z.string().trim().min(1).max(100).nullable().default(null),
  })
  .strict();

export const dataPathInput = z
  .object({
    id: plantId,
    subject: z.string().trim().min(1).max(L.text),
    description: text(L.longText),
    devices: list(L.devicesPerPath, plantId),
    collector: collectorInput.nullable().default(null),
    transfers: z
      .array(
        z
          .object({
            protocol: z.string().trim().min(1).max(60),
            mode: z.enum(TRANSFER_MODES),
            peerKind: z.enum(PEER_KINDS).default('other'),
            peer: text(),
            port: z.number().int().min(1).max(65535).nullable().default(null),
            notes: text(500),
          })
          .strict(),
      )
      .max(L.transfers)
      .default([]),
    destinations: z
      .array(
        z.object({ kind: z.enum(DESTINATION_KINDS).default('other'), ref: z.string().trim().min(1).max(L.text), path: text(500), notes: text(500) }).strict(),
      )
      .max(L.destinations)
      .default([]),
    notes: text(L.longText),
  })
  .strict();
export const dataPathUpdate = dataPathInput.omit({ id: true });

export const assetChecksInput = z.object({ checks: checksInput }).strict();

// ---------- rules (refused on save and import) ----------

export interface NetProblem {
  /** Where, in the values (subnets[0].ranges[1].start) */
  path: string;
  message: string;
}

/** What a VLAN may not hold: a subnet twice, a gateway or range outside its subnet, a range upside down, its own site. */
export function vlanProblems(v: PlantVlanValues, siteId: string): NetProblem[] {
  const out: NetProblem[] = [];
  const seen = new Set<string>();
  v.subnets.forEach((s, i) => {
    const at = `subnets[${i}]`;
    const r = cidrRange(s.cidr);
    if (!r) return void out.push({ path: `${at}.cidr`, message: 'Use a subnet in CIDR notation, IPv4 or IPv6' });
    const key = `${r.v}/${r.first}/${r.last}`;
    if (seen.has(key)) out.push({ path: `${at}.cidr`, message: `Subnet ${s.cidr} is there twice` });
    seen.add(key);
    if (s.gateway && !inCidr(s.gateway, s.cidr)) out.push({ path: `${at}.gateway`, message: `The gateway ${s.gateway} is not in ${s.cidr}` });
    s.ranges.forEach((x, j) => {
      const rp = `${at}.ranges[${j}]`;
      if (!x.start || !x.end) return void out.push({ path: rp, message: 'A range needs its first and last address' });
      for (const [k, a] of [
        ['start', x.start],
        ['end', x.end],
      ] as const)
        if (!inCidr(a, s.cidr)) out.push({ path: `${rp}.${k}`, message: `${a} is not in ${s.cidr}` });
      const a = ipValue(x.start);
      const b = ipValue(x.end);
      if (a && b && a.v === b.v && a.n > b.n) out.push({ path: rp, message: `The range starts after it ends (${x.start} – ${x.end})` });
    });
  });
  if (v.sites.includes(siteId)) out.push({ path: 'sites', message: 'The other sites are the ones besides its own' });
  if (new Set(v.sites).size !== v.sites.length) out.push({ path: 'sites', message: 'A site is named twice' });
  return out;
}

/** What a zone may not hold: a VLAN the site does not have, SL-T without the risk assessment that set it. */
export function zoneProblems(v: PlantZoneValues, vlans: Set<string>): NetProblem[] {
  const out: NetProblem[] = [];
  v.vlans.forEach((x, i) => !vlans.has(x) && out.push({ path: `vlans[${i}]`, message: `The site has no VLAN "${x}"` }));
  if (new Set(v.vlans).size !== v.vlans.length) out.push({ path: 'vlans', message: 'A VLAN is named twice' });
  if (v.slTarget !== null && !v.riskAssessment)
    out.push({ path: 'risk_assessment', message: 'A target security level (SL-T) is set by a risk assessment: name it' });
  if (v.assessedAt && !isDate(v.assessedAt)) out.push({ path: 'assessed_at', message: 'Use a date (YYYY-MM-DD)' });
  return out;
}

/** What a conduit may not hold: a zone the site does not have, the same zone twice. */
export function conduitProblems(v: PlantConduitValues, zones: Set<string>): NetProblem[] {
  const out: NetProblem[] = [];
  v.zones.forEach((x, i) => !zones.has(x) && out.push({ path: `zones[${i}]`, message: `The site has no zone "${x}"` }));
  if (v.zones[0] === v.zones[1]) out.push({ path: 'zones', message: 'A conduit connects two different zones' });
  return out;
}

const checkProblems = (checks: PlantStatusCheck[], at = 'checks'): NetProblem[] =>
  checks.flatMap((c, i) => {
    const p = `${at}[${i}]`;
    if (c.kind === 'monitor' && (c.column || c.value || c.timeColumn || c.maxAgeMinutes !== null))
      return [{ path: p, message: 'A monitor check has no column, value, time column or maximum age (those are for datasets)' }];
    if (c.kind === 'dataset' && c.check) return [{ path: `${p}.check`, message: 'A dataset has no checks: name a column and value instead' }];
    if (c.kind === 'dataset' && !!c.column !== !!c.value) return [{ path: p, message: 'Give both the column and its value, or neither' }];
    return [];
  });

/** What a device may not hold: a VLAN its asset's site does not have, an address that is no IP address, odd checks. */
export function deviceProblems(v: PlantDeviceValues, vlans: Set<string>): NetProblem[] {
  const out: NetProblem[] = [];
  if (v.vlan && !vlans.has(v.vlan)) out.push({ path: 'vlan', message: `The site has no VLAN "${v.vlan}"` });
  if (v.address && !isIpAddress(v.address)) out.push({ path: 'address', message: 'Use an IPv4 or IPv6 address' });
  if (v.mac && macOf(v.mac) !== v.mac) out.push({ path: 'mac', message: 'Use a MAC address (EUI-48)' });
  for (const [k, x] of [
    ['hostname', v.hostname],
    ['domain', v.domain],
  ] as const)
    if (x && !isHostName(x)) out.push({ path: k, message: 'Use a DNS name: letters, digits and hyphens between dots' });
  if (new Set(v.flags).size !== v.flags.length) out.push({ path: 'flags', message: 'A flag is set twice' });
  out.push(...checkProblems(v.checks));
  return out;
}

/** What a data path may not hold: a device its asset does not have, a device peer that is none of them. */
export function dataPathProblems(v: PlantDataPathValues, devices: Set<string>): NetProblem[] {
  const out: NetProblem[] = [];
  v.devices.forEach((x, i) => !devices.has(x) && out.push({ path: `devices[${i}]`, message: `The asset has no device "${x}"` }));
  if (new Set(v.devices).size !== v.devices.length) out.push({ path: 'devices', message: 'A device is named twice' });
  v.transfers.forEach((t, i) => {
    if (t.peerKind === 'device' && !devices.has(t.peer)) out.push({ path: `transfers[${i}].peer`, message: `The asset has no device "${t.peer}"` });
    if (t.peerKind !== 'other' && !t.peer) out.push({ path: `transfers[${i}].peer`, message: 'Name the peer' });
  });
  return out;
}

export const assetChecksProblems = (v: PlantAssetChecksValues): NetProblem[] => checkProblems(v.checks);

/** A Steward item a record names; `detail` is what a check reads of it (a monitor's check, a dataset's filter). */
export interface NamedRef {
  kind: 'system' | 'application' | 'platform' | 'process' | 'monitor' | 'dataset';
  id: string;
  path: string;
  detail?: string;
  check?: PlantStatusCheck;
}

/**
 * The Steward items a record names – a segment, a collector, hosts, monitors, datasets – as `kind:id` (with what a
 * check reads of it). A save checks the ones that are new (the caller must see them); one that was there already may
 * stay although the caller cannot see it. Another check of a monitor, or another filter or time column of a dataset,
 * is a new reference.
 */
export function namedRefs(v: Partial<PlantVlanValues & PlantDeviceValues & PlantDataPathValues & PlantAssetChecksValues>): NamedRef[] {
  const out: NamedRef[] = [];
  if (v.segmentId) out.push({ kind: 'system', id: v.segmentId, path: 'segment' });
  if (v.collector) {
    if (v.collector.kind !== 'job') out.push({ kind: v.collector.kind, id: v.collector.ref, path: 'collector.ref' });
    if (v.collector.host) out.push({ kind: 'system', id: v.collector.host, path: 'collector.host' });
  }
  v.transfers?.forEach((t, i) => t.peerKind === 'system' && out.push({ kind: 'system', id: t.peer, path: `transfers[${i}].peer` }));
  // a dataset destination is documentation (it may be published later): only systems must be visible
  v.destinations?.forEach((d, i) => d.kind === 'system' && out.push({ kind: 'system', id: d.ref, path: `destinations[${i}].ref` }));
  v.checks?.forEach((c, i) =>
    out.push(
      c.kind === 'monitor'
        ? { kind: 'monitor', id: c.ref, path: `checks[${i}].ref`, detail: c.check, check: c }
        : { kind: 'dataset', id: c.ref, path: `checks[${i}].ref`, detail: JSON.stringify([c.column, c.value, c.timeColumn, c.maxAgeMinutes]), check: c },
    ),
  );
  return out;
}

// ---------- writing (callers check rights and rules) ----------

interface Meta {
  importId?: string | null;
  notInSource?: boolean;
  at: string;
  by: string;
}
const src = (m: Meta) => [m.importId ?? null, m.notInSource ? 1 : 0] as const;
const keep = (opts: { keepSource?: boolean }) => (opts.keepSource ? '' : 'import_id = excluded.import_id, not_in_source = excluded.not_in_source,');
const j = (v: unknown) => JSON.stringify(v);

export function upsertVlan(siteId: string, v: PlantVlanValues, position: number, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_vlans (site_id, id, name, vid, type, owner, description, subnets, restricted, managed_by, rules_at, sites, location, segment_id, notes,
       position, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, id) DO UPDATE SET name = excluded.name, vid = excluded.vid, type = excluded.type, owner = excluded.owner,
       description = excluded.description, subnets = excluded.subnets, restricted = excluded.restricted, managed_by = excluded.managed_by,
       rules_at = excluded.rules_at, sites = excluded.sites, location = excluded.location, segment_id = excluded.segment_id, notes = excluded.notes,
       position = excluded.position, ${keep(opts)} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    siteId,
    v.id,
    v.name,
    v.vid,
    v.type,
    v.owner,
    v.description,
    j(v.subnets),
    v.restricted ? 1 : 0,
    v.managedBy,
    v.rulesAt,
    j(v.sites),
    v.location,
    v.segmentId,
    v.notes,
    position,
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export function upsertZone(siteId: string, v: PlantZoneValues, position: number, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_zones (site_id, id, name, description, criticality, vlans, owner, sl_target, risk_assessment, assessed_at, notes,
       position, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, id) DO UPDATE SET name = excluded.name, description = excluded.description, criticality = excluded.criticality,
       vlans = excluded.vlans, owner = excluded.owner, sl_target = excluded.sl_target, risk_assessment = excluded.risk_assessment,
       assessed_at = excluded.assessed_at, notes = excluded.notes, position = excluded.position, ${keep(opts)} updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    siteId,
    v.id,
    v.name,
    v.description,
    v.criticality,
    j(v.vlans),
    v.owner,
    v.slTarget,
    v.riskAssessment,
    v.assessedAt,
    v.notes,
    position,
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export function upsertConduit(siteId: string, v: PlantConduitValues, position: number, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_conduits (site_id, id, name, description, zone_a, zone_b, direction, protocols, controls, notes,
       position, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, id) DO UPDATE SET name = excluded.name, description = excluded.description, zone_a = excluded.zone_a, zone_b = excluded.zone_b,
       direction = excluded.direction, protocols = excluded.protocols, controls = excluded.controls, notes = excluded.notes, position = excluded.position,
       ${keep(opts)} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    siteId,
    v.id,
    v.name,
    v.description,
    v.zones[0],
    v.zones[1],
    v.direction,
    j(v.protocols),
    j(v.controls),
    v.notes,
    position,
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export function upsertDevice(assetId: string, v: PlantDeviceValues, position: number, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_devices (asset_id, id, hostname, domain, purpose, mac, serial, vlan_id, address_type, address, switch_name, switch_port, wall_outlet,
       cmdb_port, state, flags, confidence, owner, monitoring, checks, notes, position, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (asset_id, id) DO UPDATE SET hostname = excluded.hostname, domain = excluded.domain, purpose = excluded.purpose, mac = excluded.mac,
       serial = excluded.serial, vlan_id = excluded.vlan_id, address_type = excluded.address_type, address = excluded.address,
       switch_name = excluded.switch_name, switch_port = excluded.switch_port, wall_outlet = excluded.wall_outlet, cmdb_port = excluded.cmdb_port,
       state = excluded.state, flags = excluded.flags, confidence = excluded.confidence, owner = excluded.owner, monitoring = excluded.monitoring,
       checks = excluded.checks, notes = excluded.notes, position = excluded.position, ${keep(opts)} updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    assetId,
    v.id,
    v.hostname,
    v.domain,
    v.purpose,
    v.mac,
    v.serial,
    v.vlan,
    v.addressType,
    v.address,
    v.switch,
    v.switchPort,
    v.wallOutlet,
    v.cmdbPort,
    v.state,
    j(v.flags),
    v.confidence,
    v.owner,
    v.monitoring,
    j(v.checks),
    v.notes,
    position,
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export function upsertDataPath(assetId: string, v: PlantDataPathValues, position: number, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_data_paths (asset_id, id, subject, description, devices, collector, transfers, destinations, notes,
       position, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (asset_id, id) DO UPDATE SET subject = excluded.subject, description = excluded.description, devices = excluded.devices,
       collector = excluded.collector, transfers = excluded.transfers, destinations = excluded.destinations, notes = excluded.notes,
       position = excluded.position, ${keep(opts)} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    assetId,
    v.id,
    v.subject,
    v.description,
    j(v.devices),
    v.collector ? j(v.collector) : null,
    j(v.transfers),
    j(v.destinations),
    v.notes,
    position,
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export function upsertAssetChecks(assetId: string, v: PlantAssetChecksValues, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_asset_checks (asset_id, checks, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (asset_id) DO UPDATE SET checks = excluded.checks, ${keep(opts)} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    assetId,
    j(v.checks),
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

/** Removes the OT network of an asset: its devices, data paths and checks. */
export function removeAssetNetwork(assetId: string): void {
  db().run('DELETE FROM plant_devices WHERE asset_id = ?', assetId);
  db().run('DELETE FROM plant_data_paths WHERE asset_id = ?', assetId);
  db().run('DELETE FROM plant_asset_checks WHERE asset_id = ?', assetId);
}

/** Removes the OT network of a site: its VLANs, zones and conduits. */
export function removeSiteNetwork(siteId: string): void {
  db().run('DELETE FROM plant_conduits WHERE site_id = ?', siteId);
  db().run('DELETE FROM plant_zones WHERE site_id = ?', siteId);
  db().run('DELETE FROM plant_vlans WHERE site_id = ?', siteId);
}
