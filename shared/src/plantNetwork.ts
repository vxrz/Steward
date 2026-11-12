import type { PlantSource } from './plant.js';
import { isCidr, isIpv4, isIpv6 } from './network.js';

/**
 * Plant registry, part 3 (#220): the OT network of a site and its assets – documentation, not a CMDB or an IP address
 * management tool. The vocabulary is the standards':
 *
 * - **IEEE 802.1Q** VLANs with their VLAN identifier (VID, 1–4094), subnets in CIDR notation (IPv4 or IPv6) and address
 *   ranges of a type (blocked, dynamic, static);
 * - **IEC 62443-3-2** zones (criticality, the VLANs in them, an owner and the target security level SL-T, open until a
 *   risk assessment sets it) and conduits between two zones (direction, protocols, controls);
 * - **IEEE 802** MAC addresses as EUI-48 (written AC-DE-48-00-00-80), IP addresses as IPv4 or IPv6.
 *
 * Devices (the network identity of an asset) and data paths (what data leaves an asset, who collects it, how it is
 * transferred, where it ends up) belong to their asset. An asset's or device's live status comes only from the checks
 * linked to it (monitor checks, dataset freshness): online, offline or unknown – never green without a check saying so.
 */

export const VLAN_RANGE_TYPES = ['blocked', 'dynamic', 'static'] as const;
export type VlanRangeType = (typeof VLAN_RANGE_TYPES)[number];

/** How a device gets its address. */
export const ADDRESS_TYPES = ['dynamic', 'reserved', 'static'] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

/** Criticality of a zone (IEC 62443-3-2: the consequence of a compromise of the assets in it). */
export const ZONE_CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ZoneCriticality = (typeof ZONE_CRITICALITIES)[number];

/**
 * Where a zone sits in the levels of the Purdue reference model (ISA-95 / IEC 62443-1-1), bottom to top: field
 * devices (0), basic control – cells, PLCs (1), supervisory – SCADA, HMI (2), site operations – MES, historian (3), the
 * industrial DMZ (3.5), the enterprise network (4–5) and external parties – cloud, vendors. The OT network diagram
 * draws the zones in bands in this order; without a level it derives one.
 */
export const ZONE_LEVELS = ['field', 'control', 'supervisory', 'operations', 'dmz', 'enterprise', 'external'] as const;
export type ZoneLevel = (typeof ZONE_LEVELS)[number];

/** IEC 62443 security levels (SL 1–4); a zone's target (SL-T) is set by a risk assessment. */
export const SECURITY_LEVELS = [1, 2, 3, 4] as const;
export type SecurityLevel = (typeof SECURITY_LEVELS)[number];

/** Which way a conduit's traffic flows between its two zones (the first and the second it names). */
export const CONDUIT_DIRECTIONS = ['a_to_b', 'b_to_a', 'both'] as const;
export type ConduitDirection = (typeof CONDUIT_DIRECTIONS)[number];

export const DEVICE_STATES = ['planned', 'active', 'inactive', 'retired'] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

/** How sure the documentation of a device is. */
export const DEVICE_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type DeviceConfidence = (typeof DEVICE_CONFIDENCE)[number];

/** Flags people usually set on a device (any snake_case flag is allowed). */
export const DEVICE_FLAG_SUGGESTIONS = ['device_ordered', 'port_ordered', 'address_ordered', 'firewall_ordered', 'labelled'] as const;

/** Who collects the data of a data path: a Steward application or platform, a Steward process, or a job elsewhere. */
export const COLLECTOR_KINDS = ['application', 'platform', 'process', 'job'] as const;
export type CollectorKind = (typeof COLLECTOR_KINDS)[number];

/**
 * How a transfer moves the data, seen from the collector: `pull` – the collector fetches it from the peer (the peer is
 * a source); `push` – the collector sends it to the peer (the peer is a target, like a destination); `receive` (0.20) –
 * the peer sends it to the collector (a PLC or HMI publishing over MQTT to a gateway; the peer is a source).
 */
export const TRANSFER_MODES = ['pull', 'push', 'receive'] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];

/** Modes whose peer is where the data comes from (the others send to their peer). */
export const SOURCE_MODES: readonly TransferMode[] = ['pull', 'receive'];

/** The other end of a transfer: a device of the asset, a Steward system (a host) or something else (text). */
export const PEER_KINDS = ['device', 'system', 'other'] as const;
export type PeerKind = (typeof PEER_KINDS)[number];

/** Where a data path's data ends up: a Steward system (host), a Steward dataset or something else (text). */
export const DESTINATION_KINDS = ['system', 'dataset', 'other'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

/** Live status of an asset or device: only linked checks set it. */
export const LIVE_STATES = ['online', 'offline', 'unknown'] as const;
export type LiveState = (typeof LIVE_STATES)[number];

/** Kinds of checks that tell the live status: a monitor (or one of its checks), or the freshness of a dataset. */
export const STATUS_CHECK_KINDS = ['monitor', 'dataset'] as const;
export type StatusCheckKind = (typeof STATUS_CHECK_KINDS)[number];

/**
 * Why a check says what it says (the web app shows the text from the code): a monitor's status (up, degraded, down,
 * unknown, maintenance, off – offline as planned, ADR 0021 –, disabled), the monitor or dataset is missing, a dataset is fresh or stale, has no row for the
 * record or no readable time – or `hidden`: a check the reader may not see (or that no longer exists). Such a check
 * still counts towards the status, but shows only its state: no name, key, check, reason, time or filter.
 */
export const LIVE_REASONS = [
  'up',
  'degraded',
  'down',
  'unknown',
  'maintenance',
  'off',
  'disabled',
  'not_found',
  'fresh',
  'stale',
  'no_data',
  'no_row',
  'no_time',
  'hidden',
] as const;
export type LiveReason = (typeof LIVE_REASONS)[number];

export const PLANT_NETWORK_LIMITS = {
  vlansPerSite: 1000,
  zonesPerSite: 200,
  conduitsPerSite: 1000,
  devicesPerAsset: 100,
  pathsPerAsset: 100,
  subnets: 32,
  ranges: 64,
  sites: 50,
  vlansPerZone: 200,
  devicesPerPath: 100,
  protocols: 30,
  controls: 30,
  flags: 20,
  checks: 20,
  transfers: 20,
  destinations: 20,
  text: 200,
  longText: 4000,
  /** Host name: DNS (253), a domain likewise */
  host: 253,
  /** Data paths listed as the next or previous link of a chain, per data path (the rest is counted) */
  chainLinks: 50,
} as const;

// ---------- values (as stored, the API in camelCase) ----------

export interface PlantVlanRange {
  /** First and last address (IPv4 or IPv6, inside the subnet) */
  start: string;
  end: string;
  type: VlanRangeType;
  notes: string;
}

export interface PlantSubnet {
  /** CIDR notation: 10.20.30.0/24, 2001:db8:30::/48 */
  cidr: string;
  /** The default gateway, or empty */
  gateway: string;
  description: string;
  ranges: PlantVlanRange[];
}

export interface PlantVlanValues {
  id: string;
  name: string;
  /** IEEE 802.1Q VLAN identifier (1–4094); null: not known */
  vid: number | null;
  /** What the VLAN is for: production, management, IoT … (free text) */
  type: string;
  owner: string;
  description: string;
  subnets: PlantSubnet[];
  /** Access to it is restricted (an rVLAN behind a firewall) */
  restricted: boolean;
  /** Who manages it (the own team, a provider) */
  managedBy: string;
  /** Where its access rules are kept (a firewall, a document, a URL) */
  rulesAt: string;
  /**
   * Other sites it reaches (site ids). A view lists only the sites the reader may see; a save keeps the ones the
   * caller may not see.
   */
  sites: string[];
  /** Where it is (a building, a rack, free text) */
  location: string;
  /** The Steward network segment it is linked to (a system of kind network), or null */
  segmentId: string | null;
  notes: string;
}

export interface PlantZoneValues {
  id: string;
  name: string;
  description: string;
  criticality: ZoneCriticality | null;
  /** Its level in the Purdue model (null: not set – the diagram derives one) */
  level: ZoneLevel | null;
  /** VLANs in the zone (ids of VLANs of the site) */
  vlans: string[];
  owner: string;
  /** IEC 62443-3-2 target security level SL-T (1–4); null: open until a risk assessment sets it */
  slTarget: SecurityLevel | null;
  /** The risk assessment that set SL-T (a document number, a link); required with SL-T */
  riskAssessment: string;
  /** When it was assessed (YYYY-MM-DD), or null */
  assessedAt: string | null;
  notes: string;
}

export interface PlantConduitValues {
  id: string;
  name: string;
  description: string;
  /** The two zones it connects (ids of zones of the site; different) */
  zones: [string, string];
  direction: ConduitDirection;
  /** Protocols and ports it carries: opc-ua tcp/4840, https tcp/443 … */
  protocols: string[];
  /** The controls on it: firewall, data diode, jump host … */
  controls: string[];
  notes: string;
}

/** A check that tells the live status of an asset or device. */
export interface PlantStatusCheck {
  kind: StatusCheckKind;
  /** The monitor (id or key) or the dataset (key) */
  ref: string;
  /** A monitor: one of its checks (id), or empty for the whole monitor */
  check: string;
  /** A dataset: only rows whose column has this value (both empty: the whole dataset) */
  column: string;
  value: string;
  /** A dataset: the column with the time of the last value (empty: when the dataset was written) */
  timeColumn: string;
  /** A dataset: older than this is offline (null: the dataset's own freshness) */
  maxAgeMinutes: number | null;
  note: string;
  /**
   * A check the reader may not see (or that no longer exists): everything above is empty, this is its place in the
   * stored list. A save that sends it back keeps that check as it is; a save without it removes the check.
   */
  hiddenSlot?: number;
}

export interface PlantDeviceValues {
  id: string;
  hostname: string;
  domain: string;
  purpose: string;
  /** EUI-48, written in IEEE 802 notation (AC-DE-48-00-00-80), or empty */
  mac: string;
  serial: string;
  /** A VLAN of the asset's site (id), or null */
  vlan: string | null;
  addressType: AddressType | null;
  /** IPv4 or IPv6 address, or empty */
  address: string;
  switch: string;
  switchPort: string;
  wallOutlet: string;
  /** The port's name in the CMDB */
  cmdbPort: string;
  state: DeviceState;
  /** Flags (snake_case): device_ordered, port_ordered, address_ordered … */
  flags: string[];
  confidence: DeviceConfidence | null;
  owner: string;
  /** The monitoring that watches it (text); the live status comes from checks */
  monitoring: string;
  checks: PlantStatusCheck[];
  notes: string;
}

export interface PlantCollector {
  kind: CollectorKind;
  /** An application, platform or process id, or the name of a job elsewhere */
  ref: string;
  /** The Steward system it runs on (a host), or null */
  host: string | null;
}

export interface PlantTransfer {
  /** opc-ua, mqtt, smb, sftp, https … */
  protocol: string;
  mode: TransferMode;
  peerKind: PeerKind;
  /** A device of the asset (id), a Steward system (id) or text */
  peer: string;
  port: number | null;
  notes: string;
}

export interface PlantDestination {
  kind: DestinationKind;
  /** A Steward system (id), a dataset (key) or text */
  ref: string;
  /** Where there: a share path, a topic, an aspect */
  path: string;
  notes: string;
}

export interface PlantDataPathValues {
  id: string;
  /** What data: machine state, NC programs, energy values … */
  subject: string;
  description: string;
  /** Devices of the asset it covers (ids) */
  devices: string[];
  collector: PlantCollector | null;
  transfers: PlantTransfer[];
  destinations: PlantDestination[];
  notes: string;
}

/** The checks linked to an asset itself (its devices have their own). */
export interface PlantAssetChecksValues {
  checks: PlantStatusCheck[];
}

// ---------- views ----------

/** What one linked check says now. */
export interface PlantCheckStatus {
  kind: StatusCheckKind;
  ref: string;
  check: string;
  state: LiveState;
  reason: LiveReason;
  /** The monitor's or dataset's name – empty when the reader may not see it (then `ref`, `check` and `at` are empty too) */
  label: string;
  /** Its page, for readers who may open it */
  path: string | null;
  visible: boolean;
  /** When the value it is based on was taken (a check's last result, the newest row), or null */
  at: string | null;
}

export interface PlantLiveStatus {
  state: LiveState;
  /** No check is linked: unknown, because nothing watches it */
  watched: boolean;
  checks: PlantCheckStatus[];
}

/** A Steward item a record names (a segment, a host, a collector), as the reader may see it. */
export interface PlantItemRef {
  kind: 'system' | 'application' | 'platform' | 'process' | 'dataset' | 'job';
  id: string;
  /** Its name, or empty when the reader may not see it */
  label: string;
  /** Its page (null: not visible, or a plant viewer – they see names only) */
  path: string | null;
  visible: boolean;
}

export interface PlantVlanView extends PlantVlanValues, PlantSource {
  /** The linked segment as the reader may see it, with its VLAN ID and subnets (null: no link) */
  segment: (PlantItemRef & { vid: number | null; subnets: string[] }) | null;
  /** A linked pair whose VLAN ID or subnets differ (null: no link, the segment is not visible, or they agree) */
  segmentHint: { vidDiffers: boolean; onlyVlan: string[]; onlySegment: string[] } | null;
  /** The other sites it reaches, as far as the reader may see them */
  otherSites: { id: string; name: string }[];
  /** Zones that contain it */
  zones: string[];
  deviceCount: number;
}

export interface PlantZoneView extends PlantZoneValues, PlantSource {
  conduits: string[];
  deviceCount: number;
}

export interface PlantConduitView extends PlantConduitValues, PlantSource {
  /** The link id of the conduit (`<site>/<conduit>`), for records that link to it */
  linkId: string;
  /** Firewall changes and other records that link to it (the reader may see) */
  linkedFrom: { kind: string; id: string; label: string; path: string; note: string }[];
}

export interface PlantDeviceView extends PlantDeviceValues, PlantSource {
  assetId: string;
  assetName: string;
  live: PlantLiveStatus;
  /** What looks wrong: the VLAN does not exist, the address is outside its subnets, the address is in a blocked range */
  hints: ('vlan_missing' | 'address_outside' | 'address_blocked')[];
}

/**
 * The Steward items a data path reads from and writes to (0.20, docs/PLANT.md#chains-of-data-paths), as `system:<id>`:
 * it reads from the systems its pull and receive transfers name, and – only when it has no pull or receive transfer –
 * from the system its collector runs on (a job that archives what lands on a file share runs on that share); it
 * writes to the systems its push transfers name and to its destinations. Two paths that only write into the same
 * system share nothing: chains run from a writer to a reader.
 */
export function dataPathEnds(p: Pick<PlantDataPathValues, 'collector' | 'transfers' | 'destinations'>): { from: string[]; to: string[] } {
  const from: string[] = [];
  const to: string[] = [];
  const add = (list: string[], key: string) => {
    if (!list.includes(key)) list.push(key);
  };
  let sourced = false;
  for (const t of p.transfers) {
    const source = SOURCE_MODES.includes(t.mode);
    if (source) sourced = true;
    if (t.peerKind === 'system' && t.peer) add(source ? from : to, `system:${t.peer}`);
  }
  if (!sourced && p.collector?.host) add(from, `system:${p.collector.host}`);
  for (const d of p.destinations) if (d.kind === 'system' && d.ref) add(to, `system:${d.ref}`);
  return { from, to };
}

export interface PlantPathLink {
  assetId: string;
  assetName: string;
  pathId: string;
  subject: string;
  /** The host they share */
  via: string;
}

export interface PlantDataPathView extends PlantDataPathValues, PlantSource {
  assetId: string;
  assetName: string;
  collectorRef: PlantItemRef | null;
  collectorHost: PlantItemRef | null;
  /** Per transfer: its peer when it is a system */
  peers: (PlantItemRef | null)[];
  /** Per destination: the system or dataset */
  targets: (PlantItemRef | null)[];
  /** Data paths that read from a host this one writes to (the next link of a chain; at most `chainLinks`) */
  next: PlantPathLink[];
  /** Data paths that write to a host this one reads from (at most `chainLinks`) */
  previous: PlantPathLink[];
  /** How many more there are than listed */
  nextMore: number;
  previousMore: number;
}

export interface PlantAssetLive {
  id: string;
  name: string;
  status: string;
  live: PlantLiveStatus;
  devices: number;
  paths: number;
}

/**
 * What looks wrong in the documentation of a site's devices (0.12, docs/PLANT.md#data-quality-hints): an IP address,
 * MAC or host name that two devices share, a device without a VLAN, a VLAN a device names that the site does not have,
 * and switch names that differ only by letter case. Retired devices are left out.
 */
export const DATA_QUALITY_KINDS = ['duplicate_address', 'duplicate_mac', 'duplicate_hostname', 'vlan_missing', 'no_vlan', 'switch_case'] as const;
export type DataQualityKind = (typeof DATA_QUALITY_KINDS)[number];

/** A device a data quality hint names. */
export interface PlantDeviceRef {
  assetId: string;
  assetName: string;
  deviceId: string;
  hostname: string;
}

export interface PlantDataQualityHint {
  kind: DataQualityKind;
  /** The value they share (address, MAC, host name, the missing VLAN's id); empty for `no_vlan` */
  value: string;
  /** `switch_case`: the spellings of the switch name, the most used first (else empty) */
  variants: string[];
  /** The devices it concerns (`switch_case`: those not written in the most used spelling) */
  devices: PlantDeviceRef[];
}

/** GET /api/plant/sites/:siteId/network: the OT network of a site – everything a diagram needs, in one answer. */
export interface PlantSiteNetwork {
  site: { id: string; code: string; name: string; names: Record<string, string> };
  canManage: boolean;
  /** 0.13.0: may keep drafts of changes to it (propose) */
  canPropose?: boolean;
  vlans: PlantVlanView[];
  zones: PlantZoneView[];
  conduits: PlantConduitView[];
  devices: PlantDeviceView[];
  dataPaths: PlantDataPathView[];
  /** Every asset of the site with its live status (the overview) */
  assets: PlantAssetLive[];
  /** Assets by live status */
  statusCounts: Record<LiveState, number>;
  /** The Steward systems the data paths name (hosts), as the reader may see them */
  hosts: PlantItemRef[];
  /** What looks wrong in the documentation of its devices (0.12) */
  dataQuality: PlantDataQualityHint[];
}

/** GET /api/plant/assets/:assetId/network: an asset's devices, data paths, own checks and live status. */
export interface PlantAssetNetwork {
  asset: { id: string; name: string; siteId: string };
  canManage: boolean;
  /** 0.13.0: may keep drafts of changes to it (propose) */
  canPropose?: boolean;
  live: PlantLiveStatus;
  checks: PlantStatusCheck[];
  checksSource: PlantSource;
  devices: PlantDeviceView[];
  dataPaths: PlantDataPathView[];
  /** The VLANs of the asset's site (for the device form) */
  vlans: { id: string; name: string; vid: number | null }[];
}

// ---------- formats ----------

const MAC_RE = /^[0-9A-Fa-f]{2}([-:])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}$/;
const MAC_DOTS_RE = /^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$/;
const MAC_BARE_RE = /^[0-9A-Fa-f]{12}$/;

/**
 * A MAC address (EUI-48) in IEEE 802 notation – six upper-case hex pairs with hyphens (AC-DE-48-00-00-80) – from the
 * usual spellings (colons, hyphens, Cisco dots, twelve hex digits); null when it is none.
 */
export function macOf(s: string): string | null {
  const v = s.trim();
  let hex: string;
  if (MAC_RE.test(v)) hex = v.replace(/[-:]/g, '');
  else if (MAC_DOTS_RE.test(v)) hex = v.replace(/\./g, '');
  else if (MAC_BARE_RE.test(v)) hex = v;
  else return null;
  return hex.toUpperCase().match(/.{2}/g)!.join('-');
}

/** An IP address as a number (and its family), or null. */
export function ipValue(s: string): { v: 4 | 6; n: bigint } | null {
  if (isIpv4(s)) return { v: 4, n: s.split('.').reduce((acc, p) => (acc << 8n) + BigInt(Number(p)), 0n) };
  if (!isIpv6(s)) return null;
  let text = s;
  // an IPv4 tail (after the last colon): two groups – plain string parsing, no regular expression on input
  const tailStart = text.lastIndexOf(':') + 1;
  const tail = text.slice(tailStart);
  if (tail.includes('.')) {
    if (!isIpv4(tail)) return null;
    const n = ipValue(tail)!.n;
    text = `${text.slice(0, tailStart)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const hs = head ? head.split(':') : [];
  const ts = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = rest === undefined ? [] : new Array<string>(8 - hs.length - ts.length).fill('0');
  const groups = [...hs, ...fill, ...ts];
  if (groups.length !== 8) return null;
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n) };
}

/** The first address and the size of a subnet in CIDR notation, or null. */
export function cidrRange(cidr: string): { v: 4 | 6; first: bigint; last: bigint } | null {
  if (!isCidr(cidr)) return null;
  const [addr, bits] = cidr.split('/') as [string, string];
  const ip = ipValue(addr)!;
  const width = ip.v === 4 ? 32n : 128n;
  const host = width - BigInt(Number(bits));
  const first = (ip.n >> host) << host;
  return { v: ip.v, first, last: first + (1n << host) - 1n };
}

/** Whether an address lies in a subnet (same family). */
export function inCidr(address: string, cidr: string): boolean {
  const ip = ipValue(address);
  const r = cidrRange(cidr);
  return !!ip && !!r && ip.v === r.v && ip.n >= r.first && ip.n <= r.last;
}

/** A subnet as written canonically (network address, lower case), so that 10.1.2.3/24 and 10.1.2.0/24 compare equal. */
export function canonicalCidr(cidr: string): string {
  const r = cidrRange(cidr);
  if (!r) return cidr.trim().toLowerCase();
  const bits = cidr.split('/')[1]!;
  if (r.v === 4) return `${[24n, 16n, 8n, 0n].map((s) => String((r.first >> s) & 0xffn)).join('.')}/${bits}`;
  const groups = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((s) => ((r.first >> s) & 0xffffn).toString(16));
  // the longest run of zero groups becomes "::" (RFC 5952)
  let best = -1;
  let len = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > len && j - i > 1) {
      best = i;
      len = j - i;
    }
    i = j;
  }
  const text = best < 0 ? groups.join(':') : `${groups.slice(0, best).join(':')}::${groups.slice(best + len).join(':')}`;
  return `${text}/${bits}`;
}

/** The subnets of a linked VLAN and segment that only one of them has (canonical, sorted). */
export function subnetDifference(vlan: string[], segment: string[]): { onlyVlan: string[]; onlySegment: string[] } {
  const a = new Set(vlan.map(canonicalCidr));
  const b = new Set(segment.map(canonicalCidr));
  return { onlyVlan: [...a].filter((x) => !b.has(x)).sort(), onlySegment: [...b].filter((x) => !a.has(x)).sort() };
}

/**
 * The live status from what the linked checks say: offline when any says offline, online only when every one says
 * online, unknown otherwise – and unknown when nothing is linked (unknown never becomes online).
 */
export function combineLive(states: LiveState[]): LiveState {
  if (!states.length) return 'unknown';
  if (states.includes('offline')) return 'offline';
  return states.every((s) => s === 'online') ? 'online' : 'unknown';
}
