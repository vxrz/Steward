import { DATA_QUALITY_KINDS, ipValue, macOf, type DeviceState, type PlantDataQualityHint, type PlantDeviceRef } from '@sm/shared';

/**
 * Data quality hints of a site's OT network (0.12, docs/PLANT.md#data-quality-hints): what looks wrong in the
 * documentation of its devices – two devices with the same IP address, MAC or host name, a device without a VLAN, a
 * VLAN a device names that the site does not have, and switch names that differ only by letter case. Retired devices
 * are left out (their address or name may be in use again). For switch names the most used spelling is the hint's
 * value, and the devices it names are those written another way. A pure function: the site's devices and VLAN ids in,
 * the hints out – whoever sees the site sees all of them, so nothing is filtered here.
 */

export interface QualityDevice {
  assetId: string;
  assetName: string;
  id: string;
  hostname: string;
  domain: string;
  address: string;
  mac: string;
  vlan: string | null;
  switch: string;
  state: DeviceState;
}

const ref = (d: QualityDevice): PlantDeviceRef => ({ assetId: d.assetId, assetName: d.assetName, deviceId: d.id, hostname: d.hostname });

/** Groups devices by a key (devices without a key are left out); only groups of two or more. */
function shared(devices: QualityDevice[], key: (d: QualityDevice) => string | null): Map<string, QualityDevice[]> {
  const groups = new Map<string, QualityDevice[]>();
  for (const d of devices) {
    const k = key(d);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }
  return new Map([...groups].filter(([, g]) => g.length > 1));
}

/** An IP address compared by its value (10.0.0.1 and an IPv6 spelling of the same address are one). */
const addressKey = (d: QualityDevice) => {
  const v = d.address.trim() ? ipValue(d.address.trim()) : null;
  return v ? `${v.v}:${v.n.toString(16)}` : null;
};
/** The host name with its domain (a host name repeats legitimately in two domains), without letter case. */
const hostKey = (d: QualityDevice) => {
  const h = d.hostname.trim().toLowerCase();
  if (!h) return null;
  const domain = d.domain.trim().toLowerCase();
  return domain && !h.endsWith(`.${domain}`) ? `${h}.${domain}` : h;
};
const fqdn = (d: QualityDevice) =>
  d.domain.trim() && !d.hostname.toLowerCase().endsWith(`.${d.domain.toLowerCase()}`) ? `${d.hostname}.${d.domain}` : d.hostname;

export function dataQuality(all: QualityDevice[], vlans: ReadonlySet<string>): PlantDataQualityHint[] {
  const devices = all.filter((d) => d.state !== 'retired');
  const out: PlantDataQualityHint[] = [];
  for (const [, g] of shared(devices, addressKey)) out.push({ kind: 'duplicate_address', value: g[0]!.address.trim(), variants: [], devices: g.map(ref) });
  for (const [mac, g] of shared(devices, (d) => (d.mac.trim() ? macOf(d.mac) : null)))
    out.push({ kind: 'duplicate_mac', value: mac, variants: [], devices: g.map(ref) });
  for (const [, g] of shared(devices, hostKey)) out.push({ kind: 'duplicate_hostname', value: fqdn(g[0]!), variants: [], devices: g.map(ref) });
  const missing = new Map<string, QualityDevice[]>();
  for (const d of devices) {
    if (!d.vlan || vlans.has(d.vlan)) continue;
    missing.set(d.vlan, [...(missing.get(d.vlan) ?? []), d]);
  }
  for (const [vlan, g] of missing) out.push({ kind: 'vlan_missing', value: vlan, variants: [], devices: g.map(ref) });
  const noVlan = devices.filter((d) => !d.vlan);
  if (noVlan.length) out.push({ kind: 'no_vlan', value: '', variants: [], devices: noVlan.map(ref) });
  // switch names that differ only by letter case: one switch written two ways
  const switches = new Map<string, QualityDevice[]>();
  for (const d of devices) {
    const s = d.switch.trim();
    if (!s) continue;
    const k = s.toLowerCase();
    switches.set(k, [...(switches.get(k) ?? []), d]);
  }
  for (const [, g] of switches) {
    // the spellings, the most used first: the devices to look at are those with another one
    const uses = new Map<string, number>();
    for (const d of g) uses.set(d.switch.trim(), (uses.get(d.switch.trim()) ?? 0) + 1);
    if (uses.size < 2) continue;
    const variants = [...uses.keys()].sort((a, b) => uses.get(b)! - uses.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
    out.push({ kind: 'switch_case', value: variants[0]!, variants, devices: g.filter((d) => d.switch.trim() !== variants[0]).map(ref) });
  }
  const order = (k: PlantDataQualityHint['kind']) => DATA_QUALITY_KINDS.indexOf(k);
  return out.sort((a, b) => order(a.kind) - order(b.kind) || a.value.localeCompare(b.value));
}
