import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The plant registry, part 3 (#220): the OT network – IEEE 802.1Q VLANs with subnets and ranges (and their optional
 * link to a Steward network segment), IEC 62443-3-2 zones and conduits, devices and data paths of assets, the live
 * status from linked checks (online, offline, unknown – never online without a check), the rights (the site's;
 * hidden sites stay hidden; the Plant viewer; status viewers never), the audit, the YAML import and export and the
 * read endpoints of the public API.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};

const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string; message?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string; params?: { message?: string } } }) => ({
      status: e.status,
      code: e.body?.code,
      ...(e.body?.params?.message ? { message: e.body.params.message } : {}),
    }),
  );
const file = (name: string, content: string | object) => ({ name, content: typeof content === 'string' ? content : YAML.stringify(content) });
const enable = (enabled = true) => s.api('PUT', '/settings/plant', { enabled, enterprise: 'Brightwater Components', labels: {}, fields: {} });
const net = (site = 'riverside', c: Client = s.api) => c('GET', `/plant/sites/${site}/network`);
const assetNet = (asset: string, c: Client = s.api) => c('GET', `/plant/assets/${asset}/network`);
const exportYaml = async (q = ''): Promise<string> => s.api('GET', `/plant/export${q}`);
const db = async () => (await import('../src/db.js')).db();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['vera', 'viewer'],
    ['pia', 'plant'],
    ['olaf', 'operator'],
    ['stella', 'status'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
});

describe('module switch', () => {
  it('while the module is off, the OT network routes answer 404 PLANT_MODULE_OFF', async () => {
    for (const url of ['/plant/sites/riverside/network', '/plant/assets/rvs-mill-01/network'])
      expect(await status(s.api('GET', url)), url).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    expect(await status(s.api('POST', '/plant/sites/riverside/vlans', { id: 'x', name: 'X' }))).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    await enable();
  });
});

describe('the example', () => {
  it('imports the invented OT network of Riverside Works: VLANs, zones, a conduit, devices and data paths', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const content = fs.readFileSync(path.resolve(__dirname, '../../examples/plant/brightwater-ot-network.plant.yaml'), 'utf8');
    const r = await s.api('POST', '/plant/import', { files: [{ name: 'brightwater-ot-network.plant.yaml', content }], mode: 'add' });
    expect(r.byKind).toMatchObject({ vlan: { add: 3 }, zone: { add: 2 }, conduit: { add: 1 }, device: { add: 3 }, data_path: { add: 2 } });
    const n = await net();
    expect(n.vlans.map((v: { id: string; vid: number }) => [v.id, v.vid])).toEqual([
      ['rvs-vlan-110', 110],
      ['rvs-vlan-120', 120],
      ['rvs-vlan-900', 900],
    ]);
    expect(n.zones.map((z: { id: string; slTarget: number | null }) => [z.id, z.slTarget])).toEqual([
      ['rvs-zone-cells', 2],
      ['rvs-zone-dmz', null],
    ]);
    expect(n.conduits).toMatchObject([
      { id: 'rvs-cdt-cells-dmz', zones: ['rvs-zone-cells', 'rvs-zone-dmz'], direction: 'a_to_b', linkId: 'riverside/rvs-cdt-cells-dmz' },
    ]);
    expect(n.devices.map((d: { id: string }) => d.id)).toEqual(['rvs-mill-01-ipc', 'rvs-mill-01-gw', 'rvs-mill-02-ipc']);
    // any spelling of a MAC address is stored as EUI-48 in IEEE 802 notation
    expect(n.devices[2].mac).toBe('00-00-5E-00-53-21');
    expect(n.dataPaths.map((p: { assetId: string; id: string }) => `${p.assetId}/${p.id}`)).toEqual(['rvs-mill-01/machine-state', 'rvs-mill-02/nc-programs']);
    // nothing is linked: every asset is unknown, never online
    expect(n.statusCounts).toEqual({ online: 0, offline: 0, unknown: n.assets.length });
    expect(n.assets.every((a: { live: { watched: boolean } }) => !a.live.watched)).toBe(true);
    expect(n.vlans[0]).toMatchObject({ zones: ['rvs-zone-cells'], deviceCount: 3, segment: null, segmentHint: null });
  });
});

describe('VLANs', () => {
  it('checks the IEEE 802.1Q VLAN ID, CIDR subnets, gateways and ranges', async () => {
    const add = (body: object) => status(s.api('POST', '/plant/sites/riverside/vlans', { id: 'rvs-vlan-t', name: 'Test', ...body }));
    expect((await add({ vid: 4095 })).status).toBe(400);
    expect((await add({ vid: 0 })).status).toBe(400);
    expect((await add({ subnets: [{ cidr: '10.1.2.0/33' }] })).status).toBe(400);
    expect((await add({ subnets: [{ cidr: '10.1.2.0/24', gateway: '10.1.3.1' }] })).code).toBe('PLANT_NETWORK_INVALID');
    expect(await add({ subnets: [{ cidr: '10.1.2.0/24', ranges: [{ start: '10.1.2.50', end: '10.1.2.10', type: 'static' }] }] })).toMatchObject({
      status: 400,
      code: 'PLANT_NETWORK_INVALID',
    });
    expect(await add({ subnets: [{ cidr: '2001:db8::/48' }, { cidr: '2001:db8:0::/48' }] })).toMatchObject({ status: 400, code: 'PLANT_NETWORK_INVALID' });
    expect((await add({ sites: ['riverside'] })).code).toBe('PLANT_NETWORK_INVALID');
    const ok = await s.api('POST', '/plant/sites/riverside/vlans', {
      id: 'rvs-vlan-t',
      name: 'Test',
      vid: 4094,
      subnets: [{ cidr: '10.1.2.0/24', gateway: '10.1.2.1', ranges: [{ start: '10.1.2.1', end: '10.1.2.9', type: 'blocked' }] }, { cidr: '2001:db8:1::/64' }],
      sites: ['hillcrest'],
    });
    expect(ok.vlans.find((v: { id: string }) => v.id === 'rvs-vlan-t')).toMatchObject({
      vid: 4094,
      otherSites: [{ id: 'hillcrest', name: 'Hillcrest Plant' }],
    });
    expect(await status(s.api('POST', '/plant/sites/riverside/vlans', { id: 'rvs-vlan-t', name: 'Again' }))).toMatchObject({
      status: 409,
      code: 'PLANT_ID_TAKEN',
    });
    const log = await s.api('GET', '/audit?action=site.vlan_added');
    expect(log.some((e: { summary: string }) => e.summary.includes('rvs-vlan-t'))).toBe(true);
  });

  it('links a Steward network segment – picked or created from the VLAN – and hints when the subnets differ', async () => {
    const seg = await s.api('POST', '/systems', {
      name: 'RVS machining segment',
      kind: 'network',
      attributes: { vlanId: 110, subnets: ['10.20.110.0/24', '10.20.111.0/24'] },
    });
    const server = await s.api('POST', '/systems', { name: 'RVS file share', kind: 'server' });
    const vlan = (await net()).vlans.find((v: { id: string }) => v.id === 'rvs-vlan-110');
    const { id: _id, segment: _s, segmentHint: _h, otherSites: _o, zones: _z, deviceCount: _d, importId: _i, notInSource: _n, ...values } = vlan;
    // only a network segment can be linked
    expect(await status(s.api('PUT', '/plant/sites/riverside/vlans/rvs-vlan-110', { ...values, segmentId: server.id }))).toMatchObject({
      status: 400,
      code: 'PLANT_NETWORK_INVALID',
    });
    expect((await status(s.api('PUT', '/plant/sites/riverside/vlans/rvs-vlan-110', { ...values, segmentId: 'sys_nope' }))).code).toBe('PLANT_NETWORK_INVALID');
    const linked = (await s.api('PUT', '/plant/sites/riverside/vlans/rvs-vlan-110', { ...values, segmentId: seg.id })).vlans.find(
      (v: { id: string }) => v.id === 'rvs-vlan-110',
    );
    expect(linked.segment).toMatchObject({ id: seg.id, label: 'RVS machining segment', path: `/systems/${seg.id}`, vid: 110, visible: true });
    expect(linked.segmentHint).toEqual({ vidDiffers: false, onlyVlan: [], onlySegment: ['10.20.111.0/24'] });
    // "Create segment from this VLAN": a system of kind network with the VLAN's VID and subnets, linked
    const made = (await s.api('POST', '/plant/sites/riverside/vlans/rvs-vlan-900/segment', { name: 'RVS OT DMZ' })).vlans.find(
      (v: { id: string }) => v.id === 'rvs-vlan-900',
    );
    expect(made.segment).toMatchObject({ label: 'RVS OT DMZ', vid: 900, subnets: ['192.0.2.0/26'] });
    expect(made.segmentHint).toBeNull();
    const sys = await s.api('GET', `/systems/${made.segmentId}`);
    expect(sys).toMatchObject({ kind: 'network', attributes: { vlanId: 900, subnets: ['192.0.2.0/26'], zone: 'OT DMZ', site: 'Riverside Works' } });
    expect(await status(s.api('POST', '/plant/sites/riverside/vlans/rvs-vlan-900/segment', {}))).toMatchObject({ status: 409, code: 'PLANT_VLAN_HAS_SEGMENT' });
    // designers manage the site, but creating a segment needs the catalogue's right too (they have it); viewers neither
    expect((await status(users.vera!('POST', '/plant/sites/riverside/vlans/rvs-vlan-120/segment', {}))).status).toBe(403);
  });

  it('a VLAN that zones or devices name cannot be removed', async () => {
    expect(await status(s.api('DELETE', '/plant/sites/riverside/vlans/rvs-vlan-110'))).toMatchObject({ status: 409, code: 'PLANT_VLAN_IN_USE' });
    await s.api('DELETE', '/plant/sites/riverside/vlans/rvs-vlan-t');
    expect((await net()).vlans.some((v: { id: string }) => v.id === 'rvs-vlan-t')).toBe(false);
  });
});

describe('zones and conduits (IEC 62443-3-2)', () => {
  it('a zone names VLANs of its site; SL-T needs the risk assessment that set it', async () => {
    const add = (body: object) => status(s.api('POST', '/plant/sites/riverside/zones', { id: 'rvs-zone-t', name: 'Test zone', ...body }));
    expect(await add({ vlans: ['nope'] })).toMatchObject({ status: 400, code: 'PLANT_NETWORK_INVALID' });
    expect(await add({ slTarget: 3 })).toMatchObject({ status: 400, code: 'PLANT_NETWORK_INVALID' });
    expect((await add({ slTarget: 5, riskAssessment: 'RA-1' })).status).toBe(400);
    const n = await s.api('POST', '/plant/sites/riverside/zones', {
      id: 'rvs-zone-t',
      name: 'Test zone',
      criticality: 'critical',
      vlans: ['rvs-vlan-120'],
      slTarget: 3,
      riskAssessment: 'RA-RVS-2026-07',
      assessedAt: '2026-07-01',
    });
    expect(n.zones.find((z: { id: string }) => z.id === 'rvs-zone-t')).toMatchObject({ slTarget: 3, criticality: 'critical', conduits: [] });
  });

  it('a conduit connects two different zones; firewall changes link to it', async () => {
    const add = (body: object) => status(s.api('POST', '/plant/sites/riverside/conduits', { id: 'rvs-cdt-t', name: 'Test conduit', ...body }));
    expect(await add({ zones: ['rvs-zone-t', 'rvs-zone-t'] })).toMatchObject({ status: 400, code: 'PLANT_NETWORK_INVALID' });
    expect(await add({ zones: ['rvs-zone-t', 'nope'] })).toMatchObject({ status: 400, code: 'PLANT_NETWORK_INVALID' });
    await s.api('POST', '/plant/sites/riverside/conduits', {
      id: 'rvs-cdt-t',
      name: 'Test conduit',
      zones: ['rvs-zone-t', 'rvs-zone-dmz'],
      direction: 'both',
      protocols: ['https tcp/443'],
      controls: ['firewall'],
    });
    expect(await status(s.api('DELETE', '/plant/sites/riverside/zones/rvs-zone-t'))).toMatchObject({ status: 409, code: 'PLANT_ZONE_IN_USE' });
    // a conduit is a link kind: a firewall change names it
    const found = await s.api('GET', '/link-targets?kind=conduit&q=test');
    expect(found).toEqual([expect.objectContaining({ kind: 'conduit', id: 'riverside/rvs-cdt-t', label: 'Test conduit' })]);
    const fwc = await users.dana!('POST', '/records', { type: 'FWC', title: 'HTTPS through the test conduit' });
    await users.dana!('POST', `/records/${fwc.id}/links`, { kind: 'conduit', id: 'riverside/rvs-cdt-t', note: 'affected' });
    const c = (await net()).conduits.find((x: { id: string }) => x.id === 'rvs-cdt-t');
    expect(c.linkedFrom).toEqual([expect.objectContaining({ kind: 'record', id: fwc.id, note: 'affected' })]);
    const rec = await s.api('GET', `/records/${fwc.id}`);
    expect(rec.links.find((l: { kind: string }) => l.kind === 'conduit')).toMatchObject({ label: 'Test conduit', visible: true });
  });
});

describe('devices and data paths of an asset', () => {
  it('a device: EUI-48 MAC, IPv4/IPv6 address, a VLAN of the site; hints for addresses outside the subnets', async () => {
    const add = (body: object) => status(s.api('POST', '/plant/assets/rvs-mill-03/devices', { id: 'rvs-mill-03-ipc', ...body }));
    expect((await add({ mac: '00-00-5E-00-53' })).status).toBe(400);
    expect((await add({ address: '10.20.110.300' })).status).toBe(400);
    expect(await add({ vlan: 'nope' })).toMatchObject({ status: 400, code: 'PLANT_NETWORK_INVALID' });
    expect((await add({ hostname: 'bad_name!' })).code).toBe('PLANT_NETWORK_INVALID');
    expect((await add({ flags: ['Port Ordered'] })).status).toBe(400);
    const n = await s.api('POST', '/plant/assets/rvs-mill-03/devices', {
      id: 'rvs-mill-03-ipc',
      hostname: 'rvs-mill-03-ipc',
      mac: '0000.5e00.5331',
      vlan: 'rvs-vlan-110',
      addressType: 'static',
      address: '10.20.111.5',
      flags: ['port_ordered'],
    });
    expect(n.devices[0]).toMatchObject({ mac: '00-00-5E-00-53-31', hints: ['address_outside'], live: { state: 'unknown', watched: false } });
    const blocked = await s.api('PUT', '/plant/assets/rvs-mill-03/devices/rvs-mill-03-ipc', {
      ...n.devices[0],
      id: undefined,
      ...stripView(),
      address: '10.20.110.3',
    });
    expect(blocked.devices[0].hints).toEqual(['address_blocked']);
    const v6 = await s.api('PUT', '/plant/assets/rvs-mill-03/devices/rvs-mill-03-ipc', {
      ...pickDevice(blocked.devices[0]),
      address: '2001:db8::5',
      vlan: null,
    });
    expect(v6.devices[0]).toMatchObject({ address: '2001:db8::5', hints: [] });
    expect((await s.api('GET', '/audit?action=asset.device_changed')).length).toBeGreaterThan(0);
  });

  it('a data path: devices of the asset, a collector, transfers and destinations; chains are followed host by host', async () => {
    const share = await s.api('POST', '/systems', { name: 'CAM file share', kind: 'server' });
    const archive = await s.api('POST', '/systems', { name: 'NC archive', kind: 'server' });
    expect(await status(s.api('POST', '/plant/assets/rvs-mill-03/paths', { id: 'p', subject: 'S', devices: ['nope'] }))).toMatchObject({
      status: 400,
      code: 'PLANT_NETWORK_INVALID',
    });
    expect(
      await status(s.api('POST', '/plant/assets/rvs-mill-03/paths', { id: 'p', subject: 'S', collector: { kind: 'application', ref: 'app_nope' } })),
    ).toMatchObject({ status: 400, code: 'PLANT_NETWORK_INVALID' });
    // pull job → file share
    await s.api('POST', '/plant/assets/rvs-mill-03/paths', {
      id: 'programs-out',
      subject: 'NC programs back',
      devices: ['rvs-mill-03-ipc'],
      collector: { kind: 'job', ref: 'pull-job' },
      transfers: [{ protocol: 'smb', mode: 'pull', peerKind: 'device', peer: 'rvs-mill-03-ipc', port: 445 }],
      destinations: [{ kind: 'system', ref: share.id, path: '\\\\share\\nc' }],
    });
    // file share → archive job (on another asset of the site)
    const n = await s.api('POST', '/plant/assets/rvs-press-01/paths', {
      id: 'archive',
      subject: 'Archive of NC programs',
      collector: { kind: 'job', ref: 'archive-job', host: archive.id },
      transfers: [{ protocol: 'smb', mode: 'pull', peerKind: 'system', peer: share.id }],
      destinations: [{ kind: 'system', ref: archive.id }],
    });
    expect(n.dataPaths[0]).toMatchObject({
      collectorHost: { id: archive.id, label: 'NC archive', visible: true },
      peers: [{ id: share.id, label: 'CAM file share' }],
      previous: [{ assetId: 'rvs-mill-03', pathId: 'programs-out', via: share.id }],
      next: [],
    });
    const first = await assetNet('rvs-mill-03');
    expect(first.dataPaths[0].next).toEqual([expect.objectContaining({ assetId: 'rvs-press-01', pathId: 'archive', via: share.id })]);
    // a device a data path names cannot be removed
    expect(await status(s.api('DELETE', '/plant/assets/rvs-mill-03/devices/rvs-mill-03-ipc'))).toMatchObject({ status: 409, code: 'PLANT_DEVICE_IN_USE' });
    const site = await net();
    expect(site.hosts.map((h: { id: string }) => h.id).sort()).toEqual([share.id, archive.id].sort());
  });
});

const VIEW_KEYS = ['assetId', 'assetName', 'live', 'hints', 'importId', 'notInSource', 'id'];
const stripView = () => Object.fromEntries(VIEW_KEYS.map((k) => [k, undefined]));
const pickDevice = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => !VIEW_KEYS.includes(k)));

describe('live status', () => {
  let monitorId = '';
  const setCheck = async (st: string) => {
    (await db()).run(
      'UPDATE monitor_checks SET status = ?, last_checked_at = ? WHERE monitor_id = ? AND check_id = ?',
      st,
      new Date().toISOString(),
      monitorId,
      'ipc',
    );
  };
  beforeAll(async () => {
    const r = await s.api('POST', '/monitors', {
      key: 'rvs-ot',
      definition: {
        name: 'Riverside OT',
        checks: [
          { id: 'ipc', name: 'Mill 1 machine PC', type: 'heartbeat', key: 'rvs.mill-01-ipc', mode: 'maxAge', maxAgeSeconds: 600 },
          { id: 'gw', name: 'Mill 1 gateway', type: 'heartbeat', key: 'rvs.mill-01-gw', mode: 'maxAge', maxAgeSeconds: 600 },
        ],
      },
    });
    monitorId = r.monitor?.id ?? r.id;
    const d = await db();
    if (!d.get('SELECT 1 FROM monitor_checks WHERE monitor_id = ? AND check_id = ?', monitorId, 'ipc'))
      for (const c of ['ipc', 'gw'])
        d.run(
          "INSERT INTO monitor_checks (monitor_id, check_id, status, created_at, updated_at) VALUES (?, ?, 'unknown', ?, ?)",
          monitorId,
          c,
          new Date().toISOString(),
          new Date().toISOString(),
        );
  });

  it('comes only from linked checks: online, offline, unknown – an unknown check never makes it online', async () => {
    const dev = (await assetNet('rvs-mill-01')).devices[0];
    // a monitor that does not exist cannot be linked
    expect(
      await status(s.api('PUT', '/plant/assets/rvs-mill-01/devices/rvs-mill-01-ipc', { ...pickDevice(dev), checks: [{ kind: 'monitor', ref: 'nope' }] })),
    ).toMatchObject({ status: 400, code: 'PLANT_NETWORK_INVALID' });
    await s.api('PUT', '/plant/assets/rvs-mill-01/devices/rvs-mill-01-ipc', { ...pickDevice(dev), checks: [{ kind: 'monitor', ref: 'rvs-ot', check: 'ipc' }] });
    await setCheck('up');
    let a = await assetNet('rvs-mill-01');
    expect(a.devices[0].live).toMatchObject({
      state: 'online',
      watched: true,
      checks: [{ state: 'online', reason: 'up', label: 'Riverside OT', visible: true }],
    });
    // the asset: its watched devices (the gateway has no check: it says nothing)
    expect(a.live).toMatchObject({ state: 'online', watched: true });
    await setCheck('down');
    a = await assetNet('rvs-mill-01');
    expect([a.devices[0].live.state, a.live.state]).toEqual(['offline', 'offline']);
    await setCheck('unknown');
    a = await assetNet('rvs-mill-01');
    expect([a.devices[0].live.state, a.live.state]).toEqual(['unknown', 'unknown']);
    // the asset's own check: offline wins, an unknown one keeps it from being online
    await setCheck('up');
    await s.api('PUT', '/plant/assets/rvs-mill-01/checks', { checks: [{ kind: 'monitor', ref: 'rvs-ot', check: 'rvs.mill-01-gw' }] });
    a = await assetNet('rvs-mill-01');
    expect(a.live).toMatchObject({ state: 'unknown', checks: [{ reason: 'unknown' }] });
    // a disabled monitor says nothing
    await s.api('POST', `/monitors/${monitorId}/enabled`, { enabled: false });
    expect((await assetNet('rvs-mill-01')).devices[0].live.checks[0]).toMatchObject({ state: 'unknown', reason: 'disabled' });
    await s.api('POST', `/monitors/${monitorId}/enabled`, { enabled: true });
    const site = await net();
    expect(site.assets.find((x: { id: string }) => x.id === 'rvs-mill-01').live.state).toBe('unknown');
    expect(site.statusCounts.online + site.statusCounts.offline + site.statusCounts.unknown).toBe(site.assets.length);
    expect((await s.api('GET', '/audit?action=asset.checks_set')).length).toBe(1);
  });

  it('dataset freshness: the newest row of the asset, or the dataset itself', async () => {
    const { publishDataset } = await import('../src/dashboards/datasets.js');
    const proc = await s.api('POST', '/processes', { definition: { name: 'OT values', steps: [{ id: 'n', type: 'log', message: 'x' }] } });
    const now = Date.now();
    publishDataset({
      key: 'plant.last-values',
      title: 'Last values',
      processId: proc.id,
      processName: 'OT values',
      runId: '',
      dryRun: false,
      columns: ['asset', 'ts'],
      rows: [
        { asset: 'rvs-mill-02', ts: new Date(now - 5 * 60_000).toISOString() },
        { asset: 'rvs-press-01', ts: new Date(now - 90 * 60_000).toISOString() },
      ],
      metrics: {},
    });
    const put = (asset: string, check: object) =>
      s.api('PUT', `/plant/assets/${asset}/checks`, { checks: [{ kind: 'dataset', ref: 'plant.last-values', ...check }] });
    const fresh = await put('rvs-mill-02', { column: 'asset', value: 'rvs-mill-02', timeColumn: 'ts', maxAgeMinutes: 15 });
    expect(fresh.live).toMatchObject({ state: 'online', checks: [{ kind: 'dataset', reason: 'fresh' }] });
    const stale = await put('rvs-press-01', { column: 'asset', value: 'rvs-press-01', timeColumn: 'ts', maxAgeMinutes: 15 });
    expect(stale.live).toMatchObject({ state: 'offline', checks: [{ reason: 'stale' }] });
    const missing = await put('rvs-mill-03', { column: 'asset', value: 'rvs-mill-03', timeColumn: 'ts', maxAgeMinutes: 15 });
    expect(missing.live).toMatchObject({ state: 'unknown', checks: [{ reason: 'no_row' }] });
    // a dataset that has no data cannot be linked (it reads like one the caller may not see), nor a column it lacks
    expect(await status(put('rvs-test-bench-01', { ref: 'plant.not-there' }))).toMatchObject({
      status: 400,
      message: 'There is no dataset "plant.not-there"',
    });
    expect(await status(put('rvs-test-bench-01', { column: 'machine', value: 'x' }))).toMatchObject({
      status: 400,
      message: 'The dataset "plant.last-values" has no column "machine"',
    });
    // a monitor check has no dataset settings
    expect(
      await status(s.api('PUT', '/plant/assets/rvs-mill-02/checks', { checks: [{ kind: 'monitor', ref: 'rvs-ot', column: 'asset', value: 'x' }] })),
    ).toMatchObject({ status: 400, code: 'PLANT_NETWORK_INVALID' });
  });
});

describe('rights', () => {
  it('who sees the site sees its OT network; who manages it changes it; status viewers never', async () => {
    expect((await net('riverside', users.vera!)).vlans.length).toBe(3);
    expect((await net('riverside', users.olaf!)).canManage).toBe(false);
    expect((await status(users.olaf!('POST', '/plant/sites/riverside/vlans', { id: 'x', name: 'X' }))).status).toBe(403);
    expect((await status(users.vera!('PUT', '/plant/assets/rvs-mill-01/checks', { checks: [] }))).status).toBe(403);
    expect((await status(users.stella!('GET', '/plant/sites/riverside/network'))).status).toBe(403);
    expect((await status(users.dana!('POST', '/plant/sites/riverside/zones', { id: 'rvs-zone-dana', name: 'By Dana' }))).status).toBe(200);
  });

  it('the Plant viewer sees the OT network and the live status – monitors and systems by name only, never a link', async () => {
    const n = await net('riverside', users.pia!);
    expect(n.canManage).toBe(false);
    const a = await assetNet('rvs-mill-01', users.pia!);
    // a plant viewer may not see monitors: the status is shown, the monitor not named
    expect(a.devices[0].live.checks[0]).toMatchObject({ visible: false, label: '', path: null });
    const v = n.vlans.find((x: { id: string }) => x.id === 'rvs-vlan-110');
    expect(v.segment).toMatchObject({ label: 'RVS machining segment', path: null });
    expect((await status(users.pia!('POST', '/plant/sites/riverside/vlans', { id: 'x', name: 'X' }))).status).toBe(403);
  });

  it('a site someone may not see: its OT network reads like one that does not exist, also in the import', async () => {
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [{ subject: 'user:dana', permissions: ['view', 'manage'] }] });
    expect(await status(net('hillcrest', users.vera!))).toMatchObject({ status: 404, code: 'PLANT_SITE_NOT_FOUND' });
    expect(await status(assetNet('hlc-im-01', users.vera!))).toMatchObject({ status: 404, code: 'PLANT_ASSET_NOT_FOUND' });
    await users.dana!('POST', '/plant/sites/hillcrest/vlans', { id: 'hlc-vlan-1', name: 'Moulding', vid: 210 });
    // the VLAN's other sites and the conduit link targets leave the hidden site out
    await s.api('PUT', '/plant/sites/riverside/vlans/rvs-vlan-120', { ...vlanValues((await net()).vlans[1]), sites: ['hillcrest'] });
    expect((await net('riverside', users.vera!)).vlans[1].otherSites).toEqual([]);
    expect((await net('riverside', users.dana!)).vlans[1].otherSites).toEqual([{ id: 'hillcrest', name: 'Hillcrest Plant' }]);
    const tom = await s.as('tom', PW).catch(async () => {
      const { createUser } = await import('../src/auth/users.js');
      createUser({ username: 'tom', roles: ['designer'], password: PW });
      return s.as('tom', PW);
    });
    const preview = await tom('POST', '/plant/import/preview', {
      files: [file('hidden.yaml', { version: 1, ot_network: { site: 'hillcrest', vlans: [{ id: 'hlc-vlan-1', name: 'Taken?' }] } })],
      mode: 'update',
    });
    expect(preview.problems).toEqual([expect.objectContaining({ path: 'ot_network.site', message: 'There is no site "hillcrest"' })]);
    expect(JSON.stringify(preview.changes)).not.toContain('hlc-vlan-1');
    const asset = await tom('POST', '/plant/import/preview', {
      files: [file('a.yaml', { version: 1, asset_network: { asset: 'hlc-im-01', devices: [{ id: 'd1' }] } })],
      mode: 'update',
    });
    expect(asset.problems.map((p: { message: string }) => p.message)).toEqual(['You may not add or change asset "hlc-im-01"']);
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [] });
  });
});

const vlanValues = (v: Record<string, unknown>) => {
  const { id: _i, segment: _s, segmentHint: _h, otherSites: _o, zones: _z, deviceCount: _d, importId: _m, notInSource: _n, ...rest } = v;
  return rest;
};

describe('import and export', () => {
  it('the export carries the OT network; importing it again (replace) changes nothing', async () => {
    const yaml = await exportYaml('?site=riverside');
    const doc = YAML.parse(yaml);
    expect(doc.ot_network.site).toBe('riverside');
    expect(doc.ot_network.vlans.map((v: { id: string }) => v.id)).toEqual(['rvs-vlan-110', 'rvs-vlan-120', 'rvs-vlan-900']);
    expect(doc.ot_network.zones.find((z: { id: string }) => z.id === 'rvs-zone-cells')).toMatchObject({ sl_t: 2, risk_assessment: 'RA-RVS-2026-01' });
    const mill = doc.asset_networks.find((a: { asset: string }) => a.asset === 'rvs-mill-01');
    expect(mill.checks).toEqual([{ monitor: 'rvs-ot', check: 'rvs.mill-01-gw' }]);
    expect(mill.devices[0].checks).toEqual([{ monitor: 'rvs-ot', check: 'ipc' }]);
    const press = doc.asset_networks.find((a: { asset: string }) => a.asset === 'rvs-press-01');
    expect(press.data_paths[0]).toMatchObject({
      collector: { kind: 'job', ref: 'archive-job' },
      transfers: [{ protocol: 'smb', mode: 'pull', peer_kind: 'system' }],
    });
    // the whole registry: ot_networks
    const whole = YAML.parse(await exportYaml());
    expect(whole.ot_networks.map((n: { site: string }) => n.site).sort()).toEqual(['hillcrest', 'riverside']);
    const imp = await s.api('POST', '/plant/import', { files: [file('riverside.yaml', yaml)], mode: 'update' });
    expect(imp.counts).toMatchObject({ add: 0, change: 0, remove: 0 });
    const preview = await s.api('POST', '/plant/import/preview', {
      files: [file('riverside.yaml', yaml)],
      mode: 'replace',
      replaces: imp.import.id,
      missing: 'remove',
    });
    expect(preview.problems).toEqual([]);
    expect(preview.counts).toMatchObject({ add: 0, change: 0, remove: 0 });
    expect(preview.byKind.vlan).toMatchObject({ unchanged: 3 });
    expect(preview.byKind.device).toMatchObject({ unchanged: 4 });
    await s.api('POST', '/plant/import', { files: [file('riverside.yaml', yaml)], mode: 'replace', replaces: imp.import.id, missing: 'remove' });
    const again = await exportYaml('?site=riverside');
    const body = (x: string) => x.split('\n').slice(2).join('\n');
    expect(body(again)).toBe(body(yaml));
  });

  it('modes: add, update (keys left out keep their values), replace (what goes, what stops the import)', async () => {
    const add = await s.api('POST', '/plant/import', {
      files: [
        file('net.yaml', {
          version: 1,
          ot_network: {
            site: 'riverside',
            vlans: [{ id: 'rvs-vlan-130', name: 'Test bench', vid: 130, subnets: [{ cidr: '10.20.130.0/24' }] }],
            zones: [{ id: 'rvs-zone-test', name: 'Test zone', vlans: ['rvs-vlan-130'] }],
          },
          asset_network: { asset: 'rvs-test-bench-01', devices: [{ id: 'tb-ipc', mac: 'AC:DE:48:00:00:80', vlan: 'rvs-vlan-130', address: '10.20.130.5' }] },
        }),
      ],
      mode: 'add',
    });
    expect(add.byKind).toMatchObject({ vlan: { add: 1 }, zone: { add: 1 }, device: { add: 1 } });
    expect((await assetNet('rvs-test-bench-01')).devices[0]).toMatchObject({ mac: 'AC-DE-48-00-00-80', vlan: 'rvs-vlan-130' });
    // update: only what the file says
    const upd = await s.api('POST', '/plant/import', {
      files: [file('net2.yaml', { version: 1, ot_network: { site: 'riverside', vlans: [{ id: 'rvs-vlan-130', name: 'Test benches' }] } })],
      mode: 'update',
    });
    expect(upd.changes.find((c: { id: string }) => c.id === 'rvs-vlan-130')).toMatchObject({ action: 'change', fields: ['name'] });
    expect((await net()).vlans.find((v: { id: string }) => v.id === 'rvs-vlan-130')).toMatchObject({ vid: 130, name: 'Test benches' });
    // replace with remove: a VLAN that goes while a zone that stays names it stops the import
    const stops = await s.api('POST', '/plant/import/preview', {
      files: [
        file('net.yaml', { version: 1, ot_network: { site: 'riverside', zones: [{ id: 'rvs-zone-test', name: 'Test zone', vlans: ['rvs-vlan-130'] }] } }),
      ],
      mode: 'replace',
      // the update wrote the VLAN last: replacing it removes the VLAN
      replaces: upd.import.id,
      missing: 'remove',
    });
    expect(stops.problems.map((p: { message: string }) => p.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('The site has no VLAN "rvs-vlan-130"')]),
    );
    const gone = await s.api('POST', '/plant/import/preview', {
      files: [file('net.yaml', { version: 1, ot_network: { site: 'riverside', vlans: [{ id: 'rvs-vlan-130', name: 'Test benches' }] } })],
      mode: 'replace',
      replaces: add.import.id,
      missing: 'remove',
    });
    expect(gone.problems).toEqual([]);
    expect(
      gone.changes
        .filter((c: { action: string }) => c.action === 'remove')
        .map((c: { kind: string; id: string }) => `${c.kind}:${c.id}`)
        .sort(),
    ).toEqual(['device:rvs-test-bench-01/tb-ipc', 'zone:rvs-zone-test']);
    // problems name the place in the file
    const bad = await s.api('POST', '/plant/import/preview', {
      files: [
        file('vid.yaml', { version: 1, ot_network: { site: 'hillcrest', vlans: [{ id: 'v-bad', name: 'Bad', vid: 5000 }] } }),
        file('bad.yaml', {
          version: 1,
          ot_network: { site: 'riverside', conduits: [{ id: 'c', name: 'C', zones: ['rvs-zone-cells', 'nope'] }] },
          asset_network: { asset: 'rvs-mill-01', devices: [{ id: 'd', mac: 'not-a-mac' }], data_paths: [{ id: 'p', subject: 'P', devices: ['nope'] }] },
        }),
      ],
      mode: 'update',
    });
    expect(bad.problems.map((p: { path: string }) => p.path)).toEqual(
      expect.arrayContaining([
        'ot_network.vlans[0].vid',
        'ot_network.conduits[0].zones[1]',
        'asset_network.devices[0].mac',
        'asset_network.data_paths[0].devices[0]',
      ]),
    );
  });

  it('the published JSON Schema knows the new keys', async () => {
    const schema = await s.api('GET', '/plant/schema');
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['ot_network', 'ot_networks', 'asset_network', 'asset_networks']));
  });
});

describe('public API', () => {
  it('reads the OT network of a site and an asset with a token; hidden sites answer 404', async () => {
    const t = await s.api('POST', '/me/tokens', { name: 'ot', scope: 'read' });
    const v1 = (url: string, token = t.token) => fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
    const n = await (await v1('/plant/sites/riverside/network')).json();
    expect(n.canManage).toBeUndefined();
    expect(n.vlans.length).toBeGreaterThan(2);
    expect(n.conduits[0]).toMatchObject({ zones: ['rvs-zone-cells', 'rvs-zone-dmz'], linkId: 'riverside/rvs-cdt-cells-dmz' });
    const a = await (await v1('/plant/assets/rvs-mill-01/network')).json();
    expect(a.devices[0]).toMatchObject({ id: 'rvs-mill-01-ipc', live: { watched: true } });
    expect(a.vlans).toBeUndefined();
    // a plant viewer's token works too
    const pt = await users.pia!('POST', '/me/tokens', { name: 'ot', scope: 'read' });
    expect((await v1('/plant/sites/riverside/network', pt.token)).status).toBe(200);
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
    const vt = await users.vera!('POST', '/me/tokens', { name: 'ot', scope: 'read' });
    expect((await v1('/plant/sites/hillcrest/network', vt.token)).status).toBe(404);
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [] });
    await enable(false);
    expect((await v1('/plant/sites/riverside/network')).status).toBe(404);
    await enable();
  });
});

describe('deleting', () => {
  it('an asset takes its devices, data paths and checks along; a site its VLANs, zones and conduits', async () => {
    await s.api('DELETE', '/plant/assets/rvs-press-01');
    const d = await db();
    expect(d.get("SELECT 1 FROM plant_data_paths WHERE asset_id = 'rvs-press-01'")).toBeUndefined();
    expect(d.get("SELECT 1 FROM plant_asset_checks WHERE asset_id = 'rvs-press-01'")).toBeUndefined();
    await s.api('POST', '/plant/sites', { id: 'gamma', name: 'Gamma' });
    await s.api('POST', '/plant/sites/gamma/vlans', { id: 'g1', name: 'G1' });
    await s.api('DELETE', '/plant/sites/gamma');
    expect(d.get("SELECT 1 FROM plant_vlans WHERE site_id = 'gamma'")).toBeUndefined();
  });
});
