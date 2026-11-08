import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { json } from './helpers';

/**
 * A larger invented OT network for the network diagram (#230): the site "Lakeside Test Works" with 40 assets in six
 * zones (two cell zones, supervisory, operations, a DMZ and the enterprise network – none with a level, so the diagram
 * has to derive the order), eight VLANs, five conduits (none between the cells and the DMZ: those paths are drawn
 * without a conduit) and 60 data paths. Hosts are Steward systems in the segments of the VLANs, so the paths run
 * through the conduits. Only for tests that start their own server: the shared demo server keeps its two sites.
 */

export const LARGE_SITE = 'lks';

const ZONES = [
  { id: 'lks-z-cells-a', name: 'Cells A', criticality: 'high', vlans: ['lks-v-110', 'lks-v-120'] },
  { id: 'lks-z-cells-b', name: 'Cells B', criticality: 'high', vlans: ['lks-v-130', 'lks-v-140'] },
  { id: 'lks-z-scada', name: 'Supervisory', criticality: 'high', vlans: ['lks-v-200'] },
  { id: 'lks-z-mes', name: 'Site operations', criticality: 'medium', vlans: ['lks-v-300'] },
  { id: 'lks-z-dmz', name: 'Industrial DMZ', criticality: 'medium', vlans: ['lks-v-900'] },
  { id: 'lks-z-office', name: 'Office network', criticality: 'low', vlans: ['lks-v-1000'] },
];
const VLANS = [
  ['lks-v-110', 'Cell line 1', 110, '10.40.110.0/24'],
  ['lks-v-120', 'Cell line 2', 120, '10.40.120.0/24'],
  ['lks-v-130', 'Robots', 130, '10.40.130.0/24'],
  ['lks-v-140', 'Packaging', 140, '10.40.140.0/24'],
  ['lks-v-200', 'SCADA', 200, '10.40.200.0/24'],
  ['lks-v-300', 'MES', 300, '10.40.30.0/24'],
  ['lks-v-900', 'OT DMZ', 900, '192.0.2.64/26'],
  ['lks-v-1000', 'Office', 1000, '198.51.100.0/24'],
] as const;
const CONDUITS = [
  ['lks-c-a-scada', 'Cells A to SCADA', 'lks-z-cells-a', 'lks-z-scada'],
  ['lks-c-b-scada', 'Cells B to SCADA', 'lks-z-cells-b', 'lks-z-scada'],
  ['lks-c-scada-mes', 'SCADA to MES', 'lks-z-scada', 'lks-z-mes'],
  ['lks-c-mes-dmz', 'MES to DMZ', 'lks-z-mes', 'lks-z-dmz'],
  ['lks-c-dmz-office', 'DMZ to office', 'lks-z-dmz', 'lks-z-office'],
] as const;
/** The hosts: a Steward system each, in the segment of a VLAN */
const HOSTS = [
  ['LKS SCADA server', 'lks-v-200', '10.40.200.10'],
  ['LKS historian', 'lks-v-300', '10.40.30.10'],
  ['LKS edge gateway', 'lks-v-900', '192.0.2.70'],
  ['LKS reporting server', 'lks-v-1000', '198.51.100.20'],
] as const;

const pad = (i: number) => String(i).padStart(2, '0');
/** Which VLAN asset i (1–40) is on: 30 in the cells, 6 supervisory, 4 operations */
const vlanOf = (i: number) =>
  i <= 8 ? 'lks-v-110' : i <= 16 ? 'lks-v-120' : i <= 24 ? 'lks-v-130' : i <= 30 ? 'lks-v-140' : i <= 36 ? 'lks-v-200' : 'lks-v-300';
const octet = (vlan: string) =>
  VLANS.find((v) => v[0] === vlan)![3]
    .split('.')
    .slice(0, 3)
    .join('.');

function siteYaml(): string {
  const assets = Array.from({ length: 40 }, (_, k) => k + 1)
    .map(
      (i) =>
        `      - id: lks-a${pad(i)}\n        name: ${i <= 30 ? 'Machine' : i <= 36 ? 'Panel' : 'Station'} ${pad(i)}\n        status: operational\n        location:\n          area: lks-prod`,
    )
    .join('\n');
  const vlans = VLANS.map(([id, name, vid, cidr]) => `    - id: ${id}\n      name: ${name}\n      vid: ${vid}\n      subnets:\n        - cidr: ${cidr}`).join(
    '\n',
  );
  const zones = ZONES.map((z) => `    - id: ${z.id}\n      name: ${z.name}\n      criticality: ${z.criticality}\n      vlans: [${z.vlans.join(', ')}]`).join(
    '\n',
  );
  const conduits = CONDUITS.map(
    ([id, name, a, b]) =>
      `    - id: ${id}\n      name: ${name}\n      zones: [${a}, ${b}]\n      direction: a_to_b\n      protocols: [opc-ua tcp/4840, mqtt tcp/8883]`,
  ).join('\n');
  return [
    'version: 1',
    'sites:',
    `  - id: ${LARGE_SITE}`,
    '    code: LKS',
    '    name: Lakeside Test Works',
    '    areas:',
    '      - id: lks-prod',
    '        name: Production',
    '    assets:',
    assets,
    'ot_network:',
    `  site: ${LARGE_SITE}`,
    '  vlans:',
    vlans,
    '  zones:',
    zones,
    '  conduits:',
    conduits,
    '',
  ].join('\n');
}

/** The devices and the 60 data paths (every asset one, the first 20 a second one), with the hosts' system ids. */
function networksYaml(host: Record<(typeof HOSTS)[number][0], string>): string {
  const out = ['version: 1', 'asset_networks:'];
  for (let i = 1; i <= 40; i++) {
    const vlan = vlanOf(i);
    const dev = `lks-a${pad(i)}-ipc`;
    out.push(
      `  - asset: lks-a${pad(i)}`,
      `    site: ${LARGE_SITE}`,
      '    devices:',
      `      - id: ${dev}`,
      `        hostname: ${dev}`,
      `        vlan: ${vlan}`,
      '        address_type: static',
      `        address: ${octet(vlan)}.${20 + i}`,
      '    data_paths:',
    );
    const cell = i <= 30;
    // the main path: a cell machine is polled by the SCADA server, a panel pushes to the historian, a station to the edge
    out.push(
      '      - id: state',
      '        subject: Machine state',
      `        devices: [${dev}]`,
      `        collector: { kind: job, ref: ${cell ? 'scada-poll' : i <= 36 ? 'panel-forward' : 'mes-export'}, host: ${cell ? host['LKS SCADA server'] : i <= 36 ? host['LKS historian'] : host['LKS edge gateway']} }`,
      '        transfers:',
      `          - { protocol: opc-ua, mode: pull, peer_kind: device, peer: ${dev}, port: 4840 }`,
      `          - { protocol: mqtt, mode: push, peer_kind: system, peer: ${cell ? host['LKS historian'] : host['LKS edge gateway']}, port: 8883 }`,
      '        destinations:',
      `          - { kind: dataset, ref: lks.state-${cell ? 'cells' : 'ops'} }`,
    );
    if (i <= 20)
      // a second path straight to the edge gateway in the DMZ – no conduit from the cells to the DMZ is documented
      out.push(
        '      - id: energy',
        '        subject: Energy values',
        `        devices: [${dev}]`,
        '        transfers:',
        `          - { protocol: ${i % 2 ? 'mqtt' : 'https'}, mode: push, peer_kind: system, peer: ${host['LKS edge gateway']}, port: ${i % 2 ? 8883 : 443} }`,
        '        destinations:',
        `          - { kind: system, ref: ${host['LKS reporting server']}, path: /energy/lks-a${pad(i)} }`,
      );
  }
  out.push('');
  return out.join('\n');
}

/** Creates the large site once (as an administrator). */
export async function setupLargeSite(api: APIRequestContext): Promise<void> {
  const has = await api.get(`/api/plant/sites/${LARGE_SITE}/network`);
  if (has.ok() && (await has.json()).dataPaths.length >= 60) return;
  await json(await api.post('/api/plant/import', { data: { files: [{ name: 'lakeside.plant.yaml', content: siteYaml() }], mode: 'add' } }));
  const systems = await json<{ id: string; name: string }[]>(await api.get('/api/systems'));
  const ids: Record<string, string> = {};
  for (const [name, vlan, address] of HOSTS) {
    let n = await json(await api.get(`/api/plant/sites/${LARGE_SITE}/network`));
    let segmentId = n.vlans.find((v: { id: string }) => v.id === vlan).segmentId as string | null;
    if (!segmentId) {
      n = await json(await api.post(`/api/plant/sites/${LARGE_SITE}/vlans/${vlan}/segment`, { data: { name: `LKS ${vlan}` } }));
      segmentId = n.vlans.find((v: { id: string }) => v.id === vlan).segmentId;
    }
    const sys = systems.find((x) => x.name === name) ?? (await json<{ id: string }>(await api.post('/api/systems', { data: { name, kind: 'server' } })));
    await api.post(`/api/systems/${sys.id}/segments`, { data: { segmentId, address } });
    ids[name] = sys.id;
  }
  const content = networksYaml(ids as Record<(typeof HOSTS)[number][0], string>);
  await json(await api.post('/api/plant/import', { data: { files: [{ name: 'lakeside-networks.plant.yaml', content }], mode: 'add' } }));
  const n = await json(await api.get(`/api/plant/sites/${LARGE_SITE}/network`));
  expect(n.assets.length).toBe(40);
  expect(n.dataPaths.length).toBe(60);
}
