import { beforeAll, describe, expect, it } from 'vitest';
import { dataQuality, type QualityDevice } from '../src/plant/network-quality.js';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Editing the plant registry in place (0.12): the data quality hints of a site's OT network (a pure function, and in
 * the network's answer – only for who sees the site), and "Move to…" in the hierarchy: a node moves only below a node
 * of the level above it (never below itself or what is below it), an asset moves to any node of its site, and the
 * assets below a moved node follow it.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const dev = (id: string, x: Partial<QualityDevice> = {}): QualityDevice => ({
  assetId: 'a1',
  assetName: 'Mill 1',
  id,
  hostname: '',
  domain: '',
  address: '',
  mac: '',
  vlan: 'v110',
  switch: '',
  state: 'active',
  ...x,
});
const kinds = (h: ReturnType<typeof dataQuality>) => h.map((x) => [x.kind, x.value, x.devices.map((d) => d.deviceId)]);

describe('data quality hints (pure)', () => {
  const vlans = new Set(['v110', 'v120']);

  it('finds shared addresses, MACs and host names; retired devices are left out', () => {
    const h = dataQuality(
      [
        dev('d1', { address: '10.20.110.21', mac: '00-00-5E-00-53-01', hostname: 'ipc-1', domain: 'ot.example.com' }),
        // the same MAC in another spelling, the same host name in other letter case
        dev('d2', { assetId: 'a2', assetName: 'Mill 2', address: '10.20.110.21', mac: '00:00:5e:00:53:01', hostname: 'IPC-1', domain: 'ot.example.com' }),
        // the same host name in another domain is another host
        dev('d3', { address: '10.20.110.22', hostname: 'ipc-1', domain: 'lab.example.com' }),
        dev('d4', { address: '10.20.110.22', state: 'retired' }),
      ],
      vlans,
    );
    expect(kinds(h)).toEqual([
      ['duplicate_address', '10.20.110.21', ['d1', 'd2']],
      ['duplicate_mac', '00-00-5E-00-53-01', ['d1', 'd2']],
      ['duplicate_hostname', 'ipc-1.ot.example.com', ['d1', 'd2']],
    ]);
    expect(h[0]!.devices[1]).toEqual({ assetId: 'a2', assetName: 'Mill 2', deviceId: 'd2', hostname: 'IPC-1' });
  });

  it('IPv6 addresses compare by value', () => {
    const h = dataQuality([dev('d1', { address: '2001:db8::1' }), dev('d2', { address: '2001:0db8:0:0::1' })], vlans);
    expect(kinds(h)).toEqual([['duplicate_address', '2001:db8::1', ['d1', 'd2']]]);
  });

  it('a device without a VLAN, a VLAN the site does not have, switch names that differ only by letter case', () => {
    const h = dataQuality(
      [
        dev('d1', { vlan: null, switch: 'SW-Hall1-01' }),
        dev('d2', { vlan: 'v999', switch: 'sw-hall1-01' }),
        dev('d3', { switch: 'SW-Hall1-01' }),
        dev('d4', { switch: 'sw-hall1-02' }),
        dev('d5', { vlan: null, state: 'retired' }),
      ],
      vlans,
    );
    expect(kinds(h)).toEqual([
      ['vlan_missing', 'v999', ['d2']],
      ['no_vlan', '', ['d1']],
      ['switch_case', 'SW-Hall1-01', ['d2']],
    ]);
    expect(h.find((x) => x.kind === 'switch_case')!.variants).toEqual(['SW-Hall1-01', 'sw-hall1-01']);
  });

  it('nothing to say about a clean site', () => {
    expect(dataQuality([dev('d1', { address: '10.0.0.1', hostname: 'a' }), dev('d2', { address: '10.0.0.2', hostname: 'b' })], vlans)).toEqual([]);
    expect(dataQuality([], vlans)).toEqual([]);
  });
});

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['vera', 'viewer'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'mv', name: 'Move Works' });
  for (const [id, level, parentId] of [
    ['area-a', 'area', null],
    ['area-b', 'area', null],
    ['line-1', 'work_center', 'area-a'],
    ['line-2', 'work_center', 'area-b'],
    ['cell-1', 'work_unit', 'line-1'],
  ] as const)
    await s.api('POST', '/plant/sites/mv/nodes', { id, level, parentId, name: id });
  await s.api('POST', '/plant/sites', { id: 'other', name: 'Other Works' });
  await s.api('POST', '/plant/sites/other/nodes', { id: 'other-area', level: 'area', name: 'Other area' });
});

describe('data quality hints in the network', () => {
  it('come with the OT network of the site, only for who may see it', async () => {
    await s.api('POST', '/plant/sites/mv/vlans', { id: 'mv-110', name: 'Cells', vid: 110 });
    await s.api('POST', '/plant/assets', { id: 'mv-1', siteId: 'mv', name: 'Press 1' });
    await s.api('POST', '/plant/assets', { id: 'mv-2', siteId: 'mv', name: 'Press 2' });
    await s.api('POST', '/plant/assets/mv-1/devices', { id: 'plc', hostname: 'press-plc', address: '10.30.110.5', vlan: 'mv-110', switch: 'SW-A' });
    await s.api('POST', '/plant/assets/mv-2/devices', { id: 'plc', hostname: 'press-plc-2', address: '10.30.110.5', switch: 'sw-a' });
    const n = await s.api('GET', '/plant/sites/mv/network');
    expect(n.dataQuality.map((h: { kind: string; value: string }) => [h.kind, h.value])).toEqual([
      ['duplicate_address', '10.30.110.5'],
      ['no_vlan', ''],
      ['switch_case', 'SW-A'],
    ]);
    expect(n.dataQuality[0].devices).toEqual([
      { assetId: 'mv-1', assetName: 'Press 1', deviceId: 'plc', hostname: 'press-plc' },
      { assetId: 'mv-2', assetName: 'Press 2', deviceId: 'plc', hostname: 'press-plc-2' },
    ]);
    // the public API carries them too
    const t = await s.api('POST', '/me/tokens', { name: 'dq', scope: 'read' });
    const v1 = await fetch(`${s.base}/api/v1/plant/sites/mv/network`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(((await v1.json()) as { dataQuality: unknown[] }).dataQuality).toHaveLength(3);
    // a site the reader may not see: nothing of it
    await s.api('PUT', '/plant/sites/mv/access', { acl: [{ subject: 'user:dana', permissions: ['view', 'manage'] }] });
    expect(await status(users.vera!('GET', '/plant/sites/mv/network'))).toEqual({ status: 404, code: 'PLANT_SITE_NOT_FOUND' });
    expect((await users.dana!('GET', '/plant/sites/mv/network')).dataQuality).toHaveLength(3);
    await s.api('PUT', '/plant/sites/mv/access', { acl: [] });
  });
});

describe('Move to', () => {
  const move = (id: string, parentId: string | null, c: Client = s.api) => c('PUT', `/plant/sites/mv/nodes/${id}`, { parentId, name: id });

  it('a node moves only below a node of the level above it – never below itself or what is below it', async () => {
    expect(await status(move('line-1', 'line-1'))).toEqual({ status: 400, code: 'PLANT_NODE_PARENT' });
    expect(await status(move('line-1', 'cell-1'))).toEqual({ status: 400, code: 'PLANT_NODE_PARENT' });
    expect(await status(move('cell-1', 'area-b'))).toEqual({ status: 400, code: 'PLANT_NODE_PARENT' });
    expect(await status(move('area-a', 'area-b'))).toEqual({ status: 400, code: 'PLANT_NODE_PARENT' });
    expect(await status(move('line-1', null))).toEqual({ status: 400, code: 'PLANT_NODE_PARENT' });
    expect(await status(move('line-1', 'other-area'))).toEqual({ status: 400, code: 'PLANT_NODE_PARENT' });
    expect(await status(move('line-1', 'area-b', users.vera!))).toMatchObject({ status: 403 });
  });

  it('a node moves with what is below it, to the end of its new parent; its assets follow', async () => {
    await s.api('POST', '/plant/assets', { id: 'mv-cell', siteId: 'mv', name: 'Cell robot', workUnitId: 'cell-1' });
    expect((await s.api('GET', '/plant/assets/mv-cell')).location.area.id).toBe('area-a');
    const site = await move('line-1', 'area-b');
    const b = site.areas.find((a: { id: string }) => a.id === 'area-b');
    expect(b.children.map((c: { id: string }) => c.id)).toEqual(['line-2', 'line-1']);
    expect(b.children[1].children.map((c: { id: string }) => c.id)).toEqual(['cell-1']);
    const a = await s.api('GET', '/plant/assets/mv-cell');
    expect([a.location.area.id, a.location.workCenter.id, a.location.workUnit.id]).toEqual(['area-b', 'line-1', 'cell-1']);
    // a work unit to another work center
    await move('cell-1', 'line-2');
    expect((await s.api('GET', '/plant/assets/mv-cell')).location.workCenter.id).toBe('line-2');
    const log = await s.api('GET', '/audit?action=site.node_changed');
    expect(log.some((e: { summary: string }) => e.summary.includes('(parentId)'))).toBe(true);
  });

  it('an asset moves to any node of its site, not to one of another site', async () => {
    const a = await s.api('GET', '/plant/assets/mv-cell');
    const body = {
      siteId: 'mv',
      areaId: 'area-a',
      workCenterId: null,
      workUnitId: null,
      buildingId: null,
      name: a.name,
    };
    const moved = await s.api('PUT', '/plant/assets/mv-cell', body);
    expect([moved.location.area?.id, moved.location.workCenter, moved.location.workUnit]).toEqual(['area-a', null, null]);
    expect(await status(s.api('PUT', '/plant/assets/mv-cell', { ...body, areaId: 'other-area' }))).toEqual({
      status: 400,
      code: 'PLANT_LOCATION_UNKNOWN',
    });
    expect(await status(s.api('PUT', '/plant/assets/mv-cell', { ...body, areaId: 'line-1' }))).toEqual({ status: 400, code: 'PLANT_LOCATION_LEVEL' });
  });
});
