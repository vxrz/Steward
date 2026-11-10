import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { IMPACT_LIMITS, type ImpactMonitor, type MaintenanceImpact } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Impact before maintenance (0.14, docs/APPLICATIONS.md "Impact before maintenance"): plant targets on maintenance
 * windows (a site, an asset, a device, a collection's collector), what a window affects on a demo-sized graph – the
 * Brightwater example with a switch, a gateway, collections, KPI jobs, a dashboard and monitors – with visibility and
 * limits, the one click "planned downtime for the affected monitors", and telling the affected owners.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client;
const HOUR = 3600000;
const iso = (t: number) => new Date(t).toISOString();
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();
const inbox = async (c: Client) => ((await c('GET', '/notifications?limit=500')) as { items: { title: string; body: string }[] }).items;
const ids = (g: { items: { id: string }[] }) => g.items.map((x) => x.id).sort();
const impactOf = (c: Client, targets: string[], extra = '') =>
  c('GET', `/maintenance-windows/impact?targets=${encodeURIComponent(targets.join(','))}${extra}`) as Promise<MaintenanceImpact>;
const example = (name: string) => ({ name, content: fs.readFileSync(path.resolve(__dirname, '../../examples/plant', name), 'utf8') });

let offMonitor: string, plainMonitor: string, appId: string, dashId: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
});

describe('plant targets while the module is off', () => {
  it('are refused like an item that does not exist, and the impact has no plant part', async () => {
    const r = await status(
      dana('POST', '/maintenance-windows', {
        title: 'Hall 1 switch',
        startsAt: iso(Date.now() + 48 * HOUR),
        endsAt: iso(Date.now() + 50 * HOUR),
        targets: [{ kind: 'site', id: 'riverside' }],
      }),
    );
    expect(r).toEqual({ status: 400, code: 'MAINTENANCE_TARGET_NOT_FOUND' });
    const i = await impactOf(dana, ['site:riverside']);
    expect(i.plant).toBe(false);
    expect(i.targets).toEqual([]);
    expect(i.groups.assets.total).toBe(0);
  });
});

describe('the demo-sized graph', () => {
  beforeAll(async () => {
    await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
    const r = await s.api('POST', '/plant/import', {
      files: [example('brightwater.plant.yaml'), example('brightwater-data-points.plant.yaml'), example('brightwater-ot-network.plant.yaml')],
      mode: 'add',
    });
    expect(r.counts.add).toBeGreaterThan(10);
    // the switch of hall 1 (the example's devices name it) in a network cabinet, and a gateway the machines push to
    await s.api('POST', '/plant/assets', { id: 'rvs-net-h1', siteId: 'riverside', name: 'Network cabinet hall 1' });
    await s.api('POST', '/plant/assets/rvs-net-h1/devices', { id: 'rvs-sw-h1-a1', hostname: 'rvs-sw-h1-a1', domain: 'ot.example.com', purpose: 'Switch' });
    await s.api('POST', '/plant/assets', { id: 'rvs-gw-01', siteId: 'riverside', name: 'Edge gateway hall 1' });
    await s.api('POST', '/plant/assets/rvs-gw-01/devices', { id: 'rvs-gw-01', hostname: 'rvs-gw-01', purpose: 'Edge gateway' });
    // a machine with the profile but no KPI job yet: its data is collected by the edge collector only (coverage)
    await s.api('PUT', '/plant/assets/rvs-mill-03/assignment', {
      profileId: 'example-controls-c80',
      interfaces: [{ interface: 'opc-ua', active: true, endpoint: 'opc.tcp://rvs-mill-03:4840' }],
    });
    app = await dana('POST', '/applications', { name: 'Edge collector app', owners: ['user:olivia'] });
    appId = app.id;
    await s.api('POST', '/plant/assets/rvs-mill-03/collections', {
      id: 'state',
      name: 'Machine state',
      collector: { kind: 'job', ref: 'rvs-edge-collector' },
      interfaceId: 'opc-ua',
      items: [{ address: 'ns=2;s=ProgramStatus', outputName: 'ProgStatus', dataPoint: 'program_status' }],
    });
    // mill 1: the collection of its machine-state path (the KPI job reads program_status) to a dataset, and the push to the gateway
    await s.api('POST', '/plant/assets/rvs-mill-01/collections', {
      id: 'state',
      name: 'Machine state to the historian',
      collector: { kind: 'application', ref: appId },
      dataPathId: 'machine-state',
      interfaceId: 'opc-ua',
      sinks: [{ id: 'ds', name: 'Machine state dataset', kind: 'dataset', ref: 'plant.machine-state' }],
      items: [{ address: 'ns=2;s=ProgramStatus', outputName: 'ProgStatus', dataPoint: 'program_status' }],
    });
    await s.api('POST', '/plant/assets/rvs-mill-01/paths', {
      id: 'to-gateway',
      subject: 'Spindle values to the edge gateway',
      devices: ['rvs-mill-01-ipc'],
      collector: { kind: 'job', ref: 'spindle-push' },
      transfers: [{ protocol: 'mqtt', mode: 'push', peerKind: 'other', peer: 'rvs-gw-01', port: 8883 }],
    });
    // a dashboard that shows the dataset; monitors: one with an Off state linked to mill 1, one without states on mill 2's PC
    dashId = (await s.api('POST', '/dashboards', { text: 'name: Machine states\nwidgets:\n  - { id: t1, type: table, dataset: plant.machine-state }\n' })).id;
    offMonitor = (
      await s.api('POST', '/monitors', {
        key: 'test-mill-01',
        definition: {
          name: 'Mill 1 – machine data',
          checks: [
            { id: 'pc', name: 'Machine PC reachable', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 },
            { id: 'data', name: 'Machine data', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 },
          ],
          states: {
            cases: [
              { id: 'running', name: 'Running', when: { pc: 'up' }, expect: { data: 'up' } },
              { id: 'off', name: 'Off', status: 'off', when: { pc: 'down' }, expect: { data: 'down' } },
            ],
          },
        },
      })
    ).monitor.id;
    plainMonitor = (
      await s.api('POST', '/monitors', {
        key: 'test-mill-02-pc',
        definition: { name: 'Mill 2 PC', checks: [{ id: 'pc', name: 'Machine PC reachable', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] },
      })
    ).monitor.id;
    await s.api('POST', '/plant/assets/rvs-mill-01/links', { kind: 'monitor', id: offMonitor });
    const net = await s.api('GET', '/plant/assets/rvs-mill-02/network');
    const pc = net.devices.find((d: { id: string }) => d.id === 'rvs-mill-02-ipc');
    await s.api('PUT', '/plant/assets/rvs-mill-02/devices/rvs-mill-02-ipc', {
      hostname: pc.hostname,
      domain: pc.domain,
      purpose: pc.purpose,
      mac: pc.mac,
      vlan: pc.vlan,
      addressType: pc.addressType,
      address: pc.address,
      switch: pc.switch,
      switchPort: pc.switchPort,
      confidence: pc.confidence,
      notes: pc.notes,
      checks: [{ kind: 'monitor', ref: 'test-mill-02-pc', check: '', column: '', value: '', timeColumn: '', maxAgeMinutes: null, note: '' }],
    });
  });
  let app: { id: string };

  it('a switch: the devices behind it, their data paths, collections, the KPI job, its dataset and dashboard, monitors', async () => {
    const i = await impactOf(dana, ['device:rvs-net-h1/rvs-sw-h1-a1']);
    expect(i.plant).toBe(true);
    expect(i.targets).toEqual([{ kind: 'device', id: 'rvs-net-h1/rvs-sw-h1-a1', name: 'rvs-sw-h1-a1 (Network cabinet hall 1)' }]);
    expect(ids(i.groups.devices)).toEqual([
      'rvs-mill-01/rvs-mill-01-gw',
      'rvs-mill-01/rvs-mill-01-ipc',
      'rvs-mill-02/rvs-mill-02-ipc',
      'rvs-net-h1/rvs-sw-h1-a1',
    ]);
    const ipc = i.groups.devices.items.find((d) => d.id === 'rvs-mill-01/rvs-mill-01-ipc')!;
    expect(ipc).toMatchObject({ via: 'switch', from: 'rvs-sw-h1-a1', path: '/plant/assets/rvs-mill-01#device-rvs-mill-01-ipc' });
    expect(ids(i.groups.dataPaths)).toEqual(['rvs-mill-01/machine-state', 'rvs-mill-01/to-gateway', 'rvs-mill-02/nc-programs']);
    expect(ids(i.groups.collections)).toEqual(['rvs-mill-01/state']);
    expect(i.groups.collections.items[0]).toMatchObject({ via: 'dataPath', from: 'Machine state and spindle values' });
    expect(ids(i.groups.kpis)).toEqual(['rvs-mill-01/rvs-mill-01-machine-state']);
    expect(ids(i.groups.datasets)).toEqual(['plant.machine-state']);
    expect(ids(i.groups.dashboards)).toEqual([dashId]);
    expect(i.groups.dashboards.items[0]).toMatchObject({ name: 'Machine states', path: `/dashboards/${dashId}` });
    // the application that collects it and the service of nothing; its owner is told
    expect(ids(i.groups.applications)).toEqual([appId]);
    expect(i.contacts.find((c) => c.subject === 'user:olivia')).toMatchObject({ notifiable: true, of: ['Edge collector app'] });
    // monitors with their states: Off rather than down
    const m = i.groups.monitors.items as ImpactMonitor[];
    expect(m.find((x) => x.id === offMonitor)).toMatchObject({ offState: true, expect: 'off', via: 'link', listed: false, canAdd: true });
    expect(m.find((x) => x.id === plainMonitor)).toMatchObject({ offState: false, expect: 'down', via: 'check', from: 'rvs-mill-02-ipc' });
    expect(i.addableMonitors).toBe(2);
    expect(i.truncated).toBe(false);
  });

  it('a gateway asset: the data paths that push to it; a site: every asset; a collection: every collection of its collector', async () => {
    const gw = await impactOf(dana, ['asset:rvs-gw-01']);
    expect(ids(gw.groups.dataPaths)).toEqual(['rvs-mill-01/to-gateway']);
    expect(gw.groups.dataPaths.items[0]).toMatchObject({ via: 'device', from: 'rvs-gw-01' });
    expect(ids(gw.groups.assets)).toEqual(['rvs-gw-01', 'rvs-mill-01']);

    const site = await impactOf(dana, ['site:hillcrest']);
    expect(site.groups.assets.total).toBeGreaterThan(0);
    expect(site.groups.assets.items.every((a) => a.via === 'site' || a.via === 'part')).toBe(true);
    expect(site.groups.dataPaths.total).toBe(0);

    // the edge collector runs mill 3's collection (and mill 1's data path): mill 3's KPI could have it only through it
    const coll = await impactOf(dana, ['collection:rvs-mill-03/state']);
    // mill 1's collection belongs to the data path the collector runs there
    expect(ids(coll.groups.collections)).toEqual(['rvs-mill-01/state', 'rvs-mill-03/state']);
    expect(ids(coll.groups.dataPaths)).toEqual(['rvs-mill-01/machine-state']);
    expect(coll.groups.dataPaths.items[0]).toMatchObject({ via: 'collector', from: 'Machine state' });
    expect(ids(coll.groups.coverage)).toEqual(['rvs-mill-03/machine-state-time']);

    // an application (a collector): its collections, their sink's dataset; its services
    const svc = await dana('POST', '/services', { name: 'Shopfloor data', owners: ['user:vera'] });
    await dana('PUT', `/services/${svc.id}/applications/${appId}`, { role: 'primary' });
    const a = await impactOf(dana, [`application:${appId}`]);
    expect(ids(a.groups.collections)).toEqual(['rvs-mill-01/state']);
    expect(a.groups.collections.items[0]).toMatchObject({ via: 'collector' });
    expect(ids(a.groups.services)).toEqual([svc.id]);
    expect(a.contacts.map((c) => c.subject)).toEqual(expect.arrayContaining(['user:olivia', 'user:vera']));
  });

  it('names only what the reader may see: a hidden site is counted', async () => {
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [{ subject: 'user:dana', permissions: ['view', 'manage'] }] });
    try {
      const mine = await impactOf(dana, ['device:rvs-net-h1/rvs-sw-h1-a1']);
      const theirs = await impactOf(vera, ['device:rvs-net-h1/rvs-sw-h1-a1']);
      expect(theirs.targets).toEqual([]);
      expect(theirs.groups.devices).toEqual({ total: 0, hidden: mine.groups.devices.total, items: [] });
      expect(theirs.groups.dataPaths.hidden).toBe(3);
      expect(theirs.groups.kpis).toEqual({ total: 0, hidden: 1, items: [] });
      // what the reader may see of the catalogue is named as before
      expect(theirs.groups.applications.total).toBe(1);
    } finally {
      await s.api('PUT', '/plant/sites/riverside/access', { acl: [] });
    }
  });

  it('is bounded: switches behind switches up to the depth, each group names at most the limit', async () => {
    const { db } = await import('../src/db.js');
    const now = new Date().toISOString();
    const add = (asset: string, id: string, sw: string) =>
      db().run(
        `INSERT INTO plant_devices (asset_id, id, hostname, switch_name, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'admin', ?, 'admin')`,
        asset,
        id,
        id,
        sw,
        now,
        now,
      );
    // a chain of six switches below the cabinet's, and 120 devices behind the first one
    for (let n = 1; n <= 6; n++) add('rvs-net-h1', `chain-${n}`, n === 1 ? 'rvs-sw-h1-a1' : `chain-${n - 1}`);
    for (let n = 1; n <= 120; n++) add('rvs-net-h1', `leaf-${String(n).padStart(3, '0')}`, 'chain-1');
    try {
      const i = await impactOf(dana, ['device:rvs-net-h1/rvs-sw-h1-a1']);
      expect(i.truncated).toBe(true);
      const total = i.groups.devices.total;
      // the switch, 4 levels of the chain, the 120 leaves and the 3 machine devices – chain-5 and chain-6 are cut
      expect(total).toBe(1 + IMPACT_LIMITS.depth + 120 + 3);
      expect(i.groups.devices.items).toHaveLength(IMPACT_LIMITS.items);
    } finally {
      db().run("DELETE FROM plant_devices WHERE asset_id = 'rvs-net-h1' AND (id LIKE 'chain-%' OR id LIKE 'leaf-%')");
    }
  });

  it('refuses targets that are not kind:id', async () => {
    expect(await status(impactOf(dana, ['nope:x']))).toEqual({ status: 400, code: 'MAINTENANCE_IMPACT_TARGETS' });
  });
});

describe('plant targets on windows, planned downtime for the monitors, telling the owners', () => {
  let windowId: string;
  it('who manages the site plans maintenance for its device; others are refused; the list filter finds it', async () => {
    const body = {
      title: 'Hall 1 switch firmware',
      startsAt: iso(Date.now() + 72 * HOUR),
      endsAt: iso(Date.now() + 74 * HOUR),
      targets: [{ kind: 'device', id: 'rvs-net-h1/rvs-sw-h1-a1' }],
    };
    expect(await status(olivia('POST', '/maintenance-windows', body))).toMatchObject({ status: 403 });
    const w = await dana('POST', '/maintenance-windows', body);
    windowId = w.id;
    expect(w.targets).toEqual([{ kind: 'device', id: 'rvs-net-h1/rvs-sw-h1-a1', name: 'rvs-sw-h1-a1 (Network cabinet hall 1)' }]);
    for (const t of ['device:rvs-net-h1/rvs-sw-h1-a1', 'asset:rvs-net-h1', 'site:riverside']) {
      // the device by itself; its asset or site do not list it (a window on the site would list the device)
      const l = await dana('GET', `/maintenance-windows?target=${encodeURIComponent(t)}`);
      expect(l.windows.map((x: { id: string }) => x.id).includes(windowId)).toBe(t.startsWith('device:'));
    }
    const i = await dana('GET', `/maintenance-windows/${windowId}/impact`);
    expect(ids(i.groups.devices)).toContain('rvs-mill-02/rvs-mill-02-ipc');
  });

  it('adds planned downtime for the affected monitors in one step (and lists them in a window with include)', async () => {
    const r = await dana('POST', `/maintenance-windows/${windowId}/impact/downtime`, { mode: 'downtime' });
    expect(r.added).toBe(2);
    expect(r.window).toMatchObject({ kind: 'downtime', title: 'Hall 1 switch firmware', reminderHours: 0 });
    expect(r.window.targets.map((t: { id: string }) => t.id).sort()).toEqual([offMonitor, plainMonitor].sort());
    const audit = await s.api('GET', `/audit?entityType=maintenance&entityId=${r.window.id}`);
    expect(JSON.stringify(audit)).toContain(`for the monitors affected by ${windowId}`);
    // the planned downtime now covers the Off monitor; the one without states would still go down
    const d = await dana('GET', `/maintenance-windows/${r.window.id}/impact`);
    const m = d.groups.monitors.items as ImpactMonitor[];
    expect(m.find((x) => x.id === offMonitor)!.expect).toBe('downtime');
    expect(m.find((x) => x.id === plainMonitor)!.expect).toBe('down');
    // nothing left to add there
    expect(await status(dana('POST', `/maintenance-windows/${r.window.id}/impact/downtime`, { mode: 'downtime' }))).toEqual({
      status: 400,
      code: 'MAINTENANCE_IMPACT_NO_MONITORS',
    });
    // include: the maintenance window lists them, and keeps them quiet
    const inc = await dana('POST', `/maintenance-windows/${windowId}/impact/downtime`, { mode: 'include' });
    expect(inc.window.id).toBe(windowId);
    expect(inc.window.targets).toHaveLength(3);
    const after = await dana('GET', `/maintenance-windows/${windowId}/impact`);
    expect((after.groups.monitors.items as ImpactMonitor[]).every((x) => x.expect === 'maintenance' && x.listed)).toBe(true);
    expect(after.addableMonitors).toBe(0);
    // who may not plan for the window may not do either
    expect(await status(olivia('POST', `/maintenance-windows/${windowId}/impact/downtime`, {}))).toMatchObject({ status: 403 });
  });

  it('tells the affected owners once per version of the window', async () => {
    await flush();
    const before = (await inbox(olivia)).length;
    expect(await status(olivia('POST', `/maintenance-windows/${windowId}/impact/notify`, {}))).toMatchObject({ status: 403 });
    const r = await dana('POST', `/maintenance-windows/${windowId}/impact/notify`, {});
    expect(r).toEqual({ recipients: expect.any(Number), already: false });
    expect(r.recipients).toBeGreaterThan(0);
    await flush();
    const mine = await inbox(olivia);
    expect(mine.length).toBe(before + 1);
    expect(mine[0]!.title).toBe('Maintenance planned: Hall 1 switch firmware');
    expect(mine[0]!.body).toContain('Edge collector app');
    expect(await dana('POST', `/maintenance-windows/${windowId}/impact/notify`, {})).toEqual({ recipients: 0, already: true });
    // a changed window may be announced again
    const w = await dana('GET', `/maintenance-windows/${windowId}`);
    await dana('PUT', `/maintenance-windows/${windowId}`, {
      title: w.title,
      startsAt: w.startsAt,
      endsAt: iso(Date.parse(w.endsAt) + HOUR),
      targets: w.targets.map((t: { kind: string; id: string }) => ({ kind: t.kind, id: t.id })),
    });
    expect((await dana('POST', `/maintenance-windows/${windowId}/impact/notify`, {})).already).toBe(false);
  });

  it('follows a renamed asset and device; reads as deleted while the module is off', async () => {
    await s.api('POST', '/plant/ids/rename', { kind: 'asset', scope: '', id: 'rvs-net-h1', newId: 'rvs-net-hall-1' });
    let w = await dana('GET', `/maintenance-windows/${windowId}`);
    expect(w.targets.find((t: { kind: string }) => t.kind === 'device').id).toBe('rvs-net-hall-1/rvs-sw-h1-a1');
    await s.api('POST', '/plant/ids/rename', { kind: 'device', scope: 'rvs-net-hall-1', id: 'rvs-sw-h1-a1', newId: 'rvs-sw-hall-1' });
    w = await dana('GET', `/maintenance-windows/${windowId}`);
    expect(w.targets.find((t: { kind: string }) => t.kind === 'device').id).toBe('rvs-net-hall-1/rvs-sw-hall-1');
    await s.api('PUT', '/settings/plant', { enabled: false, enterprise: 'Brightwater Components', labels: {}, fields: {} });
    try {
      w = await s.api('GET', `/maintenance-windows/${windowId}`);
      // the administrator still sees the window (its monitors); the device reads like a deleted item
      expect(w.targets.find((t: { kind: string }) => t.kind === 'device')).toBeUndefined();
    } finally {
      await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
    }
  });
});
