import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Edge devices (0.25.0, ADR 0037 part 3, docs/PLANT.md#edge-devices): a device of an asset is the Steward system it is.
 * The asset shows the applications on that system (Apps on this device) and the collections whose collector runs there
 * (Collects data from, grouped by the asset they read); the system's page names the plant devices and the same
 * collections. Derived, team-scoped: what the reader may not see is counted, never named. The device keeps the host name.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client;
let edge = '';
let secretSystem = '';
let connector = '';
let secretApp = '';
const status = async (p: Promise<unknown>): Promise<{ status: number; message?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { params?: { message?: string } } }) => ({
      status: e.status,
      ...(e.body?.params?.message ? { message: e.body.params.message } : {}),
    }),
  );
const device = async (asset: string, id: string, c: Client = s.api) =>
  (await c('GET', `/plant/assets/${asset}/network`)).devices.find((d: { id: string }) => d.id === id);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: 'Plant-password-1' });
  dana = await s.as('dana', 'Plant-password-1');
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  const files = ['brightwater.plant.yaml', 'brightwater-ot-network.plant.yaml'].map((name) => ({
    name,
    content: fs.readFileSync(path.resolve(__dirname, '../../examples/plant', name), 'utf8'),
  }));
  await s.api('POST', '/plant/import', { files, mode: 'add' });
  edge = (await s.api('POST', '/systems', { name: 'ied-line-01.example', kind: 'appliance' })).id;
  secretSystem = (await s.api('POST', '/systems', { name: 'Invented secret edge box', kind: 'appliance' })).id;
  await s.api('PUT', `/access/system/${secretSystem}/scope`, { restricted: true });
  connector = (await s.api('POST', '/applications', { name: 'Invented Modbus import client' })).id;
  secretApp = (await s.api('POST', '/applications', { name: 'Invented secret edge app' })).id;
  await s.api('PUT', `/access/application/${secretApp}/scope`, { restricted: true });
  await s.api('POST', `/applications/${connector}/systems`, { systemId: edge, environment: 'prod' });
  await s.api('POST', `/applications/${secretApp}/systems`, { systemId: edge });
});

describe('a device is a system', () => {
  it('links a device to a system the caller may see; audited; the device keeps its host name', async () => {
    await dana('POST', '/plant/assets/rvs-mill-02/devices', { id: 'edge', hostname: 'ied-line-01', domain: 'example', system: edge });
    expect(await device('rvs-mill-02', 'edge', dana)).toMatchObject({
      hostname: 'ied-line-01',
      system: edge,
      systemRef: { kind: 'system', id: edge, label: 'ied-line-01.example', visible: true },
      systemHidden: false,
    });
    // a system that does not exist, or one she may not see, reads the same
    for (const id of ['sys_nope', secretSystem])
      expect(await status(dana('POST', '/plant/assets/rvs-mill-02/devices', { id: 'x', system: id }))).toMatchObject({
        status: 400,
        message: expect.stringContaining('There is no system'),
      });
    const added = (await s.api('GET', '/audit?action=asset.device_added'))[0];
    expect(added.details).toMatchObject({ device: 'edge' });
  });

  it('a hidden system is not named and stays when she saves; duplicate leaves it out', async () => {
    await s.api('POST', '/plant/assets/rvs-mill-02/devices', { id: 'box', hostname: 'box-01', system: secretSystem });
    const seen = await device('rvs-mill-02', 'box', dana);
    expect(seen).toMatchObject({ system: null, systemRef: null, systemHidden: true });
    expect(JSON.stringify(seen)).not.toContain(secretSystem);
    await dana('PUT', '/plant/assets/rvs-mill-02/devices/box', { hostname: 'box-01', purpose: 'Edge box', system: null });
    expect((await device('rvs-mill-02', 'box')).system).toBe(secretSystem);
    // naming another replaces it
    await dana('PUT', '/plant/assets/rvs-mill-02/devices/box', { hostname: 'box-01', system: edge });
    expect((await device('rvs-mill-02', 'box')).system).toBe(edge);
    await s.api('PUT', '/plant/assets/rvs-mill-02/devices/box', { hostname: 'box-01', system: secretSystem });
    // a duplicate does not copy what identifies the original: the system goes with the host name
    await dana('POST', '/plant/assets/rvs-mill-02/devices/edge/duplicate', { toAsset: 'rvs-mill-02', id: 'edge-copy' });
    expect(await device('rvs-mill-02', 'edge-copy')).toMatchObject({ hostname: '', system: null });
    await s.api('DELETE', '/plant/assets/rvs-mill-02/devices/edge-copy');
  });

  it('export names the system as far as the exporter may see it; an import keeps a hidden one', async () => {
    const yaml: string = await dana('GET', '/plant/export?site=riverside');
    const net = YAML.parse(yaml).asset_networks.find((n: { asset: string }) => n.asset === 'rvs-mill-02');
    expect(net.devices.find((d: { id: string }) => d.id === 'edge').system).toBe(edge);
    expect(net.devices.find((d: { id: string }) => d.id === 'box').system).toBeUndefined();
    expect(yaml).not.toContain(secretSystem);
    await dana('POST', '/plant/import', { files: [{ name: 'r.plant.yaml', content: yaml }], mode: 'update' });
    expect((await device('rvs-mill-02', 'box')).system).toBe(secretSystem);
    expect((await device('rvs-mill-02', 'edge')).system).toBe(edge);
  });
});

describe('apps on this device and collects data from', () => {
  beforeAll(async () => {
    // mill 1: read by the Modbus client that runs on the edge system; mill 3: by a job whose host is the edge system
    await s.api('POST', '/plant/assets/rvs-mill-01/collections', {
      id: 'edge-state',
      name: 'Machine state over Modbus',
      collector: { kind: 'application', ref: connector },
      items: [{ address: 'hr:100', outputName: 'State' }],
    });
    await s.api('POST', '/plant/assets/rvs-mill-03/collections', {
      id: 'edge-energy',
      name: 'Energy',
      collector: { kind: 'job', ref: 'energy-job', host: edge },
      items: [{ address: 'hr:200', outputName: 'Energy' }],
    });
    await s.api('POST', '/plant/assets/hlc-im-01/collections', {
      id: 'edge-hidden',
      name: 'Hidden collection',
      collector: { kind: 'job', ref: 'energy-job', host: edge },
      items: [{ address: 'hr:1', outputName: 'X' }],
    });
    // dana may not see the site Hillcrest
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [{ subject: 'role:admin', permissions: ['view', 'manage'] }] });
  });

  it('the asset lists the applications on its edge device (hidden ones counted) and what collects there, by source asset', async () => {
    const e = await dana('GET', '/plant/assets/rvs-mill-02/edge');
    const d = e.devices.find((x: { deviceId: string }) => x.deviceId === 'edge');
    expect(d).toMatchObject({
      hostname: 'ied-line-01',
      system: { id: edge, name: 'ied-line-01.example' },
      systemHidden: false,
      apps: [{ id: connector, name: 'Invented Modbus import client', environment: 'prod' }],
      hiddenApps: 1,
      iem: null,
    });
    expect(e.devices.find((x: { deviceId: string }) => x.deviceId === 'box')).toMatchObject({ system: null, systemHidden: true, apps: [], hiddenApps: 0 });
    expect(JSON.stringify(e)).not.toContain('Invented secret');
    expect(e.collects.groups.map((g: { asset: { id: string } }) => g.asset.id)).toEqual(['rvs-mill-01', 'rvs-mill-03']);
    expect(e.collects.groups[0].collections).toMatchObject([{ id: 'edge-state', via: 'application' }]);
    expect(e.collects.groups[1].collections).toMatchObject([{ id: 'edge-energy', via: 'host' }]);
    expect(e.collects.hidden).toBe(1);
    expect(JSON.stringify(e)).not.toContain('Hidden collection');
    // the administrator sees all three
    expect((await s.api('GET', '/plant/assets/rvs-mill-02/edge')).collects.groups).toHaveLength(3);
  });

  it('the system names its plant devices and the same collections; one on a hidden site is counted', async () => {
    await s.api('POST', '/plant/assets/hlc-im-01/devices', { id: 'edge-twin', hostname: 'ied-line-01', system: edge });
    const e = await dana('GET', `/plant/systems/${edge}/edge`);
    expect(e.devices).toEqual([
      {
        siteId: 'riverside',
        siteName: expect.any(String),
        assetId: 'rvs-mill-02',
        assetName: expect.any(String),
        deviceId: 'edge',
        hostname: 'ied-line-01',
        domain: 'example',
        address: '',
      },
    ]);
    expect(e.hiddenDevices).toBe(1);
    expect(e.collects.groups).toHaveLength(2);
    expect(e.collects.hidden).toBe(1);
    // a system she may not see answers 404
    expect((await status(dana('GET', `/plant/systems/${secretSystem}/edge`))).status).toBe(404);
  });

  it('the OT network diagram places the edge system on the device’s VLAN and names the apps on it', async () => {
    await s.api('PUT', '/plant/assets/rvs-mill-02/devices/edge', { hostname: 'ied-line-01', domain: 'example', system: edge, vlan: 'rvs-vlan-120' });
    const p = await dana('GET', '/plant/sites/riverside/network/placement');
    expect(p.hosts.find((h: { id: string }) => h.id === edge)).toMatchObject({ vlans: ['rvs-vlan-120'] });
    expect(p.edgeDevices).toEqual([{ asset: 'rvs-mill-02', device: 'edge', system: edge, apps: ['Invented Modbus import client'], hiddenApps: 1 }]);
    expect(JSON.stringify(p)).not.toContain(secretSystem);
  });
});
