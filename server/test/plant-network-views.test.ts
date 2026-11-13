import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The OT network diagram (#230, view 5) draws from #220's site network and one aggregate of its own: which VLANs of
 * the site the hosts of its data paths are in – through the Steward network segments they are members of – so that a
 * data path into another zone can be drawn across its conduit. Hidden sites and segments place nothing.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const URL = '/plant/sites/riverside/network/placement';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['pia', 'plant'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
});

describe('host placement', () => {
  it('answers 404 PLANT_MODULE_OFF while the module is off', async () => {
    expect(await status(s.api('GET', URL))).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  });

  it('places a host in the VLANs whose segment it is a member of', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const content = fs.readFileSync(path.resolve(__dirname, '../../examples/plant/brightwater-ot-network.plant.yaml'), 'utf8');
    await s.api('POST', '/plant/import', { files: [{ name: 'brightwater-ot-network.plant.yaml', content }], mode: 'add' });
    // the example names no Steward system: nothing to place
    expect(await s.api('GET', URL)).toEqual({ hosts: [], applications: [], platforms: [], edgeDevices: [] });

    // an edge server in the DMZ segment (created from VLAN 900), named by a data path of milling centre 1
    const made = (await s.api('POST', '/plant/sites/riverside/vlans/rvs-vlan-900/segment', { name: 'RVS OT DMZ' })).vlans.find(
      (v: { id: string }) => v.id === 'rvs-vlan-900',
    );
    const edge = await s.api('POST', '/systems', { name: 'RVS edge server', kind: 'server' });
    const office = await s.api('POST', '/systems', { name: 'Office archive', kind: 'server' });
    await s.api('POST', `/systems/${edge.id}/segments`, { segmentId: made.segmentId, address: '192.0.2.10' });
    await s.api('POST', '/plant/assets/rvs-mill-01/paths', {
      id: 'to-edge',
      subject: 'Machine state to the edge server',
      devices: ['rvs-mill-01-ipc'],
      collector: { kind: 'job', ref: 'edge-collector', host: edge.id },
      transfers: [{ protocol: 'opc-ua', mode: 'pull', peerKind: 'device', peer: 'rvs-mill-01-ipc', port: 4840 }],
      destinations: [{ kind: 'system', ref: office.id }],
    });
    // the office archive is in no segment of the site: not placed
    expect(await s.api('GET', URL)).toEqual({ hosts: [{ id: edge.id, vlans: ['rvs-vlan-900'], zones: [] }], applications: [], platforms: [], edgeDevices: [] });
    // the Plant viewer sees the same (names, no links)
    expect(await users.pia!('GET', URL)).toEqual({
      hosts: [{ id: edge.id, vlans: ['rvs-vlan-900'], zones: [] }],
      applications: [],
      platforms: [],
      edgeDevices: [],
    });

    // the site's network answer still has everything the diagram draws
    const n = await s.api('GET', '/plant/sites/riverside/network');
    expect(n.conduits.map((c: { id: string; zones: string[] }) => [c.id, c.zones])).toEqual([['rvs-cdt-cells-dmz', ['rvs-zone-cells', 'rvs-zone-dmz']]]);
    expect(n.hosts.map((h: { id: string }) => h.id).sort()).toEqual([edge.id, office.id].sort());
  });

  it('0.20: a system without a VLAN of the site stands in a zone that lists it; an application with its system; a platform in its zone', async () => {
    const cloud = await s.api('POST', '/systems', { name: 'Invented cloud historian', kind: 'server' });
    const edge = (await s.api('GET', '/plant/sites/riverside/network')).hosts.find((h: { label: string }) => h.label === 'RVS edge server');
    const app = await s.api('POST', '/applications', { name: 'Invented InfluxDB' });
    await s.api('POST', `/applications/${app.id}/systems`, { systemId: cloud.id });
    await s.api('POST', `/applications/${app.id}/systems`, { systemId: edge.id });
    const ih = await s.api('POST', '/platforms', { name: 'Invented IoT platform', kind: 'generic', baseUrl: 'http://127.0.0.1:9/api' });
    await s.api('POST', '/plant/sites/riverside/zones', { id: 'rvs-zone-ext', name: 'External', level: 'external', systems: [cloud.id], platforms: [ih.id] });
    await s.api('POST', '/plant/assets/rvs-mill-02/paths', {
      id: 'to-cloud',
      subject: 'Programs to the cloud',
      collector: { kind: 'job', ref: 'cloud-sync' },
      transfers: [
        { protocol: 'https', mode: 'push', peerKind: 'system', peer: cloud.id },
        { protocol: 'http', mode: 'push', peerKind: 'application', peer: app.id },
      ],
      destinations: [{ kind: 'platform', ref: ih.id }],
    });
    const placed = await s.api('GET', URL);
    expect(placed.hosts).toEqual(
      expect.arrayContaining([
        { id: edge.id, vlans: ['rvs-vlan-900'], zones: [] },
        { id: cloud.id, vlans: [], zones: ['rvs-zone-ext'] },
      ]),
    );
    // the application runs on both: the first one placed in this site (the cloud historian, added first)
    expect(placed.applications).toEqual([{ id: app.id, system: cloud.id }]);
    expect(placed.platforms).toEqual([{ id: ih.id, zones: ['rvs-zone-ext'] }]);
    // a platform the reader may not see places nothing
    await s.api('PUT', `/platforms/${ih.id}/access`, { acl: [{ subject: 'role:admin', permissions: ['use', 'manage'] }] });
    expect((await users.dana!('GET', URL)).platforms).toEqual([]);
  });

  it('a site the reader may not see answers 404, like one that does not exist', async () => {
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [{ subject: 'user:pia', permissions: ['view'] }] });
    try {
      expect(await status(users.dana!('GET', URL))).toEqual({ status: 404, code: 'PLANT_SITE_NOT_FOUND' });
      expect(await status(users.dana!('GET', '/plant/sites/nope/network/placement'))).toEqual({ status: 404, code: 'PLANT_SITE_NOT_FOUND' });
    } finally {
      await s.api('PUT', '/plant/sites/riverside/access', { acl: [] });
    }
  });
});
