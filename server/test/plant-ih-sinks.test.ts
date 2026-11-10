import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Insights Hub as a mapped sink (0.14, docs/PLANT.md "Insights Hub mapping", docs/MONITORS.md "From an Insights Hub
 * mapping"): the mapping per item (asset, aspect, variable – freely, with a default on the sink and a placeholder from
 * the asset's external reference), the bulk tool and the CSV, the import/export round trip, the check against the
 * simulated tenant (missing asset, aspect and variable, a unit that differs, the bounds, 403 and 429), the monitors
 * that already watch a target, the disabled draft monitor for the rest with the states of the asset's monitor, the
 * coverage per collection, site and monitor, the KPI coverage, rights and audit.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const u: Record<string, Client> = {};
let IH = '';
let M17 = '';
let PM17 = '';
const ASSET = 'ih-mill-17';
const COLL = 'mill-data';
const SINK = 'to-ih';
const base = `/plant/assets/${ASSET}/collections/${COLL}/sinks/${SINK}/insights-hub`;
const fail = async (p: Promise<unknown>): Promise<{ status: number; code?: string; body?: any }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code, body: e.body }),
  );
const mock = (path: string, body?: object) =>
  fetch(`${s.base}/mock/ih/test/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const db = async () => (await import('../src/db.js')).db();
const audits = async (action: string) =>
  (await db()).all<{ summary: string; details: string }>('SELECT summary, details FROM audit_log WHERE action = ? ORDER BY seq', action);

const ITEMS = [
  { address: 'ns=2;s=Spindle.Speed', outputName: 'spindleSpeed', dataPoint: 'spindle_speed' },
  { address: 'ns=2;s=Machine.State', outputName: 'state', dataPoint: 'machine_state' },
  { address: 'ns=2;s=Tool.Wear', outputName: 'toolWear', dataPoint: 'tool_wear' },
  { address: 'ns=2;s=Power.Active', outputName: 'activePower', dataPoint: 'active_power' },
  { address: 'ns=2;s=Power.Voltage', outputName: 'Voltage_L1', dataPoint: 'voltage' },
  { address: 'ns=2;s=Raw.Thing', outputName: 'rawThing', dataPoint: null },
];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['ivo', 'viewer'],
    ['ilse', 'plant'],
    ['ida', 'designer'],
    ['iris', 'designer'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    u[name] = await s.as(name, PW);
  }
  const platforms = (await s.api('GET', '/platforms')) as { id: string; name: string }[];
  IH = platforms.find((p) => p.name === 'Insights Hub (demo)')!.id;
  const { DEMO_IOT_ASSETS } = await import('../src/mock/mockIot.js');
  M17 = DEMO_IOT_ASSETS.machine17.assetId;
  PM17 = DEMO_IOT_ASSETS.pm17.assetId;
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'ih-site', name: 'Ih works' });
  await s.api('POST', '/plant/profiles', {
    id: 'ih-mill',
    name: 'Example mill',
    interfaces: [
      {
        id: 'opc',
        name: 'OPC UA',
        protocol: 'opc_ua',
        groups: [
          {
            name: '',
            dataPoints: [
              { id: 'spindle_speed', name: 'Spindle speed', address: 'ns=2;s=Spindle.Speed', dataType: 'float', unit: 'rpm' },
              { id: 'machine_state', name: 'Machine state', address: 'ns=2;s=Machine.State', dataType: 'int' },
              { id: 'tool_wear', name: 'Tool wear', address: 'ns=2;s=Tool.Wear', dataType: 'float', unit: '%' },
              // the tenant has kW: a hint
              { id: 'active_power', name: 'Active power', address: 'ns=2;s=Power.Active', dataType: 'float', unit: 'W' },
              { id: 'voltage', name: 'Voltage', address: 'ns=2;s=Power.Voltage', dataType: 'float', unit: 'V' },
            ],
          },
        ],
      },
    ],
  });
  await s.api('POST', '/plant/assets', { id: ASSET, siteId: 'ih-site', name: 'Mill 17', refs: [{ system: 'insights-hub', id: M17, url: '', label: '' }] });
  await s.api('PUT', `/plant/assets/${ASSET}/assignment`, { profileId: 'ih-mill', interfaces: [{ interface: 'opc', active: true }] });
  await s.api('POST', `/plant/assets/${ASSET}/collections`, {
    id: COLL,
    name: 'Mill data',
    collector: { kind: 'job', ref: 'edge-gateway-17' },
    interfaceId: 'opc',
    mode: 'interval',
    intervalMs: 60000,
    items: ITEMS,
    sinks: [{ id: SINK, name: 'Insights Hub', kind: 'platform', ref: IH, mappings: [{ item: 'rawThing', target: '', transform: 'x / 10' }] }],
  });
});

describe('the mapping: per item, a default, bulk, CSV', () => {
  it('starts unmapped; the bulk tool maps the data points to one asset and aspect with the same names', async () => {
    const m0 = await s.api('GET', base);
    expect(m0).toMatchObject({ isIh: true, platform: { id: IH }, counts: { items: 6, mapped: 0 } });
    expect(m0.canCheck).toBe(true);
    const r = await s.api('POST', `${base}/bulk`, {
      items: ['spindleSpeed', 'state', 'toolWear'],
      assetId: M17,
      assetName: 'Machine 17',
      aspect: 'MachineData',
    });
    expect(r.changed).toBe(3);
    expect(r.counts.mapped).toBe(3);
    expect(r.items[0].target).toEqual({ assetId: M17, assetName: 'Machine 17', aspect: 'MachineData', variable: 'spindleSpeed' });
    // the raw item's own name and transformation stay
    const c = await s.api('GET', `/plant/assets/${ASSET}/collections/${COLL}`);
    expect(c.sinks[0].mappings.find((m: { item: string }) => m.item === 'rawThing')).toEqual({ item: 'rawThing', target: '', transform: 'x / 10' });
    expect(c.sinks[0].mappings.find((m: { item: string }) => m.item === 'state')).toMatchObject({ target: 'state', assetId: M17, aspect: 'MachineData' });
    // the change is a collection edit: audited with what it was
    const a = (await audits('plant.collection_updated')).at(-1)!;
    expect(JSON.parse(a.details).insightsHub).toEqual({ sink: SINK, via: 'bulk', items: 3 });
  });

  it('a default asset and aspect, an item of another asset, a variable named differently; a placeholder from the asset’s external reference', async () => {
    // the PowerMeter is another Insights Hub asset: the same collection maps to several assets and aspects
    const r = await s.api('PUT', `${base}/mapping`, {
      default: { assetId: PM17, assetName: 'PowerMeter PM-17', aspect: 'Energy' },
      items: [
        { item: 'activePower', variable: 'activePower' },
        { item: 'Voltage_L1', variable: 'voltage' },
      ],
    });
    const byItem = (k: string) => r.items.find((i: { item: string }) => i.item === k);
    expect(byItem('activePower')).toMatchObject({ fromDefault: true, target: { assetId: PM17, aspect: 'Energy', variable: 'activePower' } });
    expect(byItem('Voltage_L1').target.variable).toBe('voltage');
    expect(r.groups.map((g: { aspect: string; variables: string[] }) => [g.aspect, g.variables])).toEqual([
      ['MachineData', ['spindleSpeed', 'state', 'toolWear']],
      ['Energy', ['activePower', 'voltage']],
    ]);
    // a placeholder: the asset's external reference of that system
    const p = await s.api('PUT', `${base}/mapping`, {
      items: [{ item: 'toolWear', assetId: '{asset.ref:insights-hub}', aspect: 'MachineData', variable: 'toolWear' }],
    });
    expect(p.items[2]).toMatchObject({ placeholder: '{asset.ref:insights-hub}', target: { assetId: M17 } });
    const none = await s.api('PUT', `${base}/mapping`, {
      items: [{ item: 'toolWear', assetId: '{asset.ref:other-system}', aspect: 'MachineData', variable: 'toolWear' }],
    });
    expect(none.items[2].target).toBeNull();
    await s.api('PUT', `${base}/mapping`, {
      items: [{ item: 'toolWear', assetId: M17, assetName: 'Machine 17', aspect: 'MachineData', variable: 'toolWear' }],
    });
  });

  it('CSV: export, import (merge), unknown items and missing variables refused', async () => {
    const csv = await fetch(`${s.base}/api${base}/mapping.csv`, { headers: await authHeaders() });
    const text = await csv.text();
    expect(text.split('\r\n')[0]).toBe('item,asset_id,asset_name,aspect,variable');
    expect(text).toContain(`spindleSpeed,${M17},Machine 17,MachineData,spindleSpeed`);
    expect(await fail(s.api('POST', `${base}/csv`, { csv: 'item,asset_id,aspect,variable\nnope,x,y,z\n' }))).toMatchObject({
      status: 400,
      code: 'PLANT_IH_CSV_INVALID',
    });
    expect(await fail(s.api('POST', `${base}/csv`, { csv: 'item;asset_id;aspect;variable\nstate;abc;MachineData;\n' }))).toMatchObject({
      status: 400,
      code: 'PLANT_IH_CSV_INVALID',
    });
    // `;` as separator, an item by its address
    const r = await s.api('POST', `${base}/csv`, {
      csv: `item;asset_id;asset_name;aspect;variable\nns=2;s=Machine.State;${M17};Machine 17;MachineData;state\n`.replace(
        'ns=2;s=Machine.State',
        '"ns=2;s=Machine.State"',
      ),
    });
    expect(r.changed).toBe(1);
    expect(r.counts.mapped).toBe(5);
  });

  it('only on an Insights Hub sink; viewers and plant viewers read, only who manages the site writes', async () => {
    await s.api('POST', `/plant/assets/${ASSET}/collections`, {
      id: 'other',
      name: 'Other',
      collector: { kind: 'job', ref: 'x' },
      items: [{ address: 'a', outputName: 'a' }],
      sinks: [{ id: 'mqtt', name: 'Broker', kind: 'other', ref: 'mqtt.example.com' }],
    });
    const other = `/plant/assets/${ASSET}/collections/other/sinks/mqtt/insights-hub`;
    expect((await s.api('GET', other)).isIh).toBe(false);
    expect(await fail(s.api('POST', `${other}/bulk`, { assetId: 'x', aspect: 'y' }))).toMatchObject({ status: 409, code: 'PLANT_SINK_NOT_IH' });
    const v = await u.ivo!('GET', base);
    expect(v).toMatchObject({ canManage: false, canCheck: false, canCreateMonitor: false });
    expect((await u.ilse!('GET', base)).counts.mapped).toBe(5);
    expect((await fail(u.ivo!('PUT', `${base}/mapping`, { items: [] }))).status).toBe(403);
    expect((await fail(u.ivo!('POST', `${base}/check`))).status).toBe(403);
    expect((await fail(u.ivo!('POST', `${base}/monitor`, {}))).status).toBe(403);
  });
});

describe('the plant file format', () => {
  it('exports the mapping with insights_hub and asset_id/aspect, and reads it back unchanged', async () => {
    const res = await fetch(`${s.base}/api/plant/export?site=ih-site`, { headers: await authHeaders() });
    const text = await res.text();
    expect(text).toMatch(/insights_hub:\s*\n\s*asset_id: \w+/);
    expect(text).toContain('aspect: MachineData');
    const before = (await s.api('GET', `/plant/assets/${ASSET}/collections/${COLL}`)).sinks;
    const preview = await s.api('POST', '/plant/import/preview', { files: [{ name: 'x.plant.yaml', content: text }], mode: 'update' });
    const changes = (preview.changes ?? []).filter((c: { action: string }) => c.action !== 'unchanged');
    expect(changes).toEqual([]);
    await s.api('POST', '/plant/import', { files: [{ name: 'x.plant.yaml', content: text }], mode: 'update' });
    expect((await s.api('GET', `/plant/assets/${ASSET}/collections/${COLL}`)).sinks).toEqual(before);
  });
});

describe('check against the tenant', () => {
  afterEach(async () => {
    await mock('assetmanagement/reset');
  });
  it('reports per item: ok, unit differs; a missing asset, aspect and variable', async () => {
    await mock('assetmanagement/reset');
    // an item that goes to an aspect the asset has not, one to a variable the aspect type has not, one to no asset
    await s.api('PUT', `${base}/mapping`, {
      items: [
        { item: 'rawThing', assetId: M17, assetName: 'Machine 17', aspect: 'Vibration', variable: 'raw_thing' },
        { item: 'Voltage_L1', variable: 'voltageL1' },
      ],
    });
    await s.api('POST', `/plant/assets/${ASSET}/collections`, {
      id: 'ghost',
      name: 'Ghost',
      collector: { kind: 'job', ref: 'x' },
      items: [{ address: 'g', outputName: 'g' }],
      sinks: [
        { id: 'ih', name: 'IH', kind: 'platform', ref: IH, mappings: [{ item: 'g', target: 'g', assetId: 'feedfeedfeedfeedfeedfeedfeedfeed', aspect: 'A' }] },
      ],
    });
    const r = await s.api('POST', `${base}/check`);
    const st = (k: string) => r.items.find((i: { item: string }) => i.item === k).check?.status;
    expect(st('spindleSpeed')).toBe('ok');
    expect(st('state')).toBe('ok');
    expect(st('activePower')).toBe('unit_differs');
    expect(r.items.find((i: { item: string }) => i.item === 'activePower').check.unit).toEqual({ point: 'W', ih: 'kW' });
    expect(st('Voltage_L1')).toBe('variable_missing');
    expect(st('rawThing')).toBe('aspect_missing');
    expect(r.lastRun).toMatchObject({ checkedBy: 'admin', platformId: IH, assets: 2, capped: false, error: null });
    expect(r.counts).toMatchObject({ mapped: 6, verified: 4 });
    const g = await s.api('POST', `/plant/assets/${ASSET}/collections/ghost/sinks/ih/insights-hub/check`);
    expect(g.items[0].check.status).toBe('asset_missing');
    // audited, without secrets
    const a = (await audits('plant.ih_mapping_checked')).at(-2)!;
    expect(a.summary).toContain('3 of 6 items ok');
    expect(JSON.parse(a.details)).toMatchObject({ platform: IH, assets: 2, error: null });
    // a changed target makes its result old: not shown for the new target
    const changed = await s.api('PUT', `${base}/mapping`, { items: [{ item: 'Voltage_L1', variable: 'voltage' }] });
    expect(changed.items.find((i: { item: string }) => i.item === 'Voltage_L1').check).toBeNull();
    const again = await s.api('POST', `${base}/check`);
    expect(again.items.find((i: { item: string }) => i.item === 'Voltage_L1').check.status).toBe('ok');
  });

  it('reads aspect types when the aspects come without variables; read-only GETs only', async () => {
    await mock('assetmanagement', { omitVariables: true });
    const r = await s.api('POST', `${base}/check`);
    expect(r.items.find((i: { item: string }) => i.item === 'spindleSpeed').check.status).toBe('ok');
    expect(r.lastRun.requests).toBeGreaterThan(4);
    await mock('assetmanagement/reset');
  });

  it('stops on 403 and on 429 with a clear message; the items it did not reach are failed', async () => {
    await mock('assetmanagement', { failWith: 403 });
    const f = await s.api('POST', `${base}/check`);
    expect(f.lastRun.error).toMatchObject({ code: 'forbidden', status: 403 });
    expect(f.lastRun.error.message).toMatch(/may not read Asset Management/);
    expect(f.items.every((i: { check: { status: string } | null; target: unknown }) => !i.target || i.check?.status === 'failed')).toBe(true);
    await mock('assetmanagement', { failWith: 429, failAfter: 2 });
    const r = await s.api('POST', `${base}/check`);
    expect(r.lastRun.error).toMatchObject({ code: 'rate_limited', status: 429, retryAfterSeconds: 0 });
    // the first asset was read before the limit hit
    expect(r.items.find((i: { item: string }) => i.item === 'spindleSpeed').check.status).toBe('ok');
    expect(r.items.find((i: { item: string }) => i.item === 'activePower').check.status).toBe('failed');
    await mock('assetmanagement/reset');
    await s.api('POST', `${base}/check`);
  });

  it('a cap on assets per run: the rest is not checked', async () => {
    const { PLANT_IH_LIMITS } = await import('@sm/shared');
    const n = PLANT_IH_LIMITS.assetsPerRun + 2;
    const items = Array.from({ length: n }, (_, i) => ({ address: `x${i}`, outputName: `v${i}` }));
    await s.api('POST', `/plant/assets/${ASSET}/collections`, {
      id: 'many',
      name: 'Many',
      collector: { kind: 'job', ref: 'x' },
      items,
      sinks: [
        {
          id: 'ih',
          name: 'IH',
          kind: 'platform',
          ref: IH,
          mappings: items.map((x, i) => ({ item: x.outputName, target: 'v', assetId: `a${String(i).padStart(3, '0')}`, aspect: 'A' })),
        },
      ],
    });
    const r = await s.api('POST', `/plant/assets/${ASSET}/collections/many/sinks/ih/insights-hub/check`);
    expect(r.lastRun).toMatchObject({ capped: true, assets: PLANT_IH_LIMITS.assetsPerRun });
    expect(r.lastRun.counts).toEqual({ asset_missing: PLANT_IH_LIMITS.assetsPerRun, not_checked: 2 });
    await s.api('DELETE', `/plant/assets/${ASSET}/collections/many`);
    expect((await db()).get('SELECT 1 FROM plant_ih_checks WHERE collection_id = ?', 'many')).toBeUndefined();
  });

  it('needs the right to use the platform and its identity', async () => {
    const before = await s.api('GET', `/platforms/${IH}`);
    await s.api('PUT', `/platforms/${IH}/access`, {
      acl: [
        { subject: 'user:admin', permissions: ['manage'] },
        { subject: 'user:ida', permissions: ['use'] },
      ],
    });
    try {
      const m = await u.iris!('GET', base);
      expect(m).toMatchObject({ canManage: true, canCheck: false });
      expect(m.checkProblem).toMatch(/may not use the platform/);
      expect(await fail(u.iris!('POST', `${base}/check`))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect((await u.ida!('POST', `${base}/check`)).lastRun.checkedBy).toBe('ida');
    } finally {
      await s.api('PUT', `/platforms/${IH}/access`, { acl: before.acl ?? [] });
    }
  });
});

describe('monitors first', () => {
  it('finds the existing checks that watch a target, and stores the links with the check', async () => {
    const r = await s.api('GET', base);
    const speed = r.items.find((i: { item: string }) => i.item === 'spindleSpeed');
    expect(speed.watchedBy.map((w: { monitorKey: string }) => w.monitorKey)).toEqual(['machine-17-machine-data']);
    const power = r.items.find((i: { item: string }) => i.item === 'activePower');
    expect(power.watchedBy.map((w: { monitorKey: string }) => w.monitorKey)).toEqual(['machine-17-powermeter']);
    const md = r.groups.find((g: { aspect: string }) => g.aspect === 'MachineData');
    expect(md).toMatchObject({ watched: ['spindleSpeed'], unwatched: ['state', 'toolWear'] });
    const energy = r.groups.find((g: { aspect: string }) => g.aspect === 'Energy');
    expect(energy).toMatchObject({ watched: ['activePower'], unwatched: ['voltage'] });
    // the check stored them: the monitor's page tells what it covers
    const mon = (await s.api('GET', '/monitors')).find((m: { key: string }) => m.key === 'machine-17-machine-data');
    const cov = await s.api('GET', `/plant/monitors/${mon.id}/insights-hub`);
    expect(cov.entries).toEqual([
      {
        assetId: ASSET,
        assetName: 'Mill 17',
        collectionId: COLL,
        collectionName: 'Mill data',
        sinkId: SINK,
        sinkName: 'Insights Hub',
        items: 1,
        checks: ['machine-ih'],
      },
    ]);
    // who may not see the monitor learns nothing
    expect((await fail(u.ilse!('GET', `/plant/monitors/${mon.id}/insights-hub`))).status).toBe(404);
  });

  it('creates a disabled draft for the unwatched variables, with the leader’s states and the measured allowance', async () => {
    // the asset links to the PowerMeter monitor, whose states know when the machine is off
    const pm = (await s.api('GET', '/monitors')).find((m: { key: string }) => m.key === 'machine-17-powermeter');
    await s.api('POST', `/plant/assets/${ASSET}/links`, { kind: 'monitor', id: pm.id, note: '' });
    expect((await s.api('GET', base)).leader).toMatchObject({
      key: 'machine-17-powermeter',
      states: [
        { id: 'running', off: false },
        { id: 'off', off: true },
      ],
    });
    expect(await fail(u.ivo!('POST', `${base}/monitor`, {}))).toMatchObject({ status: 403 });
    const r = await s.api('POST', `${base}/monitor`, {});
    expect(r.monitor.enabled).toBe(false);
    expect(r.follows).toMatchObject({ key: 'machine-17-powermeter' });
    expect(r.checks.map((c: { aspect: string; variables: string[] }) => [c.aspect, c.variables])).toEqual([
      ['MachineData', ['state', 'toolWear']],
      ['Energy', ['voltage']],
    ]);
    const m = await s.api('GET', `/monitors/${r.monitor.id}`);
    expect(m.enabled).toBe(false);
    expect(m.definition.checks[0]).toMatchObject({
      type: 'freshness',
      source: 'insightsHub',
      platform: IH,
      assetId: M17,
      aspect: 'MachineData',
      mode: 'cadence',
      expectedIntervalSeconds: 60,
    });
    expect(m.definition.states.from).toBe(pm.id);
    // the PowerMeter's existing check measured its delay (the demo's batched uploads): the draft takes the suggestion
    expect(r.checks[1].allowance).toMatchObject({ source: 'measured', from: { checkId: 'pm-ih' } });
    expect(r.checks[1].allowance.seconds).toBeGreaterThanOrEqual(300);
    expect(m.definition.checks[1].allowedDelaySeconds).toBe(r.checks[1].allowance.seconds);
    expect(r.checks[0].allowance.source).toBe('none');
    expect(m.definition.states.cases.find((c: { id: string }) => c.id === 'off')).toMatchObject({ status: 'off', expect: { 'ih-1': 'down', 'ih-2': 'down' } });
    expect(m.definition.states.cases.find((c: { id: string }) => c.id === 'running').expect).toEqual({ 'ih-1': 'up', 'ih-2': 'up' });
    // now every variable is watched (by the draft): nothing more to create; the links show both ways
    const after = r.mapping;
    expect(after.counts.watched).toBe(after.counts.mapped - 1);
    expect(after.items.find((i: { item: string }) => i.item === 'state').watchedBy[0]).toMatchObject({ monitorId: r.monitor.id, enabled: false, linked: true });
    expect(await fail(s.api('POST', `${base}/monitor`, {}))).toMatchObject({ status: 409, code: 'PLANT_IH_NOTHING_TO_WATCH' });
    const cov = await s.api('GET', `/plant/monitors/${r.monitor.id}/insights-hub`);
    expect(cov.entries[0]).toMatchObject({ collectionId: COLL, items: 3, checks: ['ih-1', 'ih-2'] });
    expect((await audits('plant.ih_monitor_created')).at(-1)!.summary).toMatch(/created \(disabled\)/);
  });

  it('without a leader: no states; the allowance of a peer check on the same asset', async () => {
    const { db: d } = await import('../src/db.js');
    d().run("DELETE FROM item_links WHERE from_kind = 'asset' AND from_id = ?", ASSET);
    await s.api('PUT', `${base}/mapping`, { items: [{ item: 'rawThing', assetId: M17, aspect: 'MachineData', variable: 'feedRate' }] });
    const r = await s.api('POST', `${base}/monitor`, {});
    expect(r.follows).toBeNull();
    expect(r.checks).toHaveLength(1);
    const m = await s.api('GET', `/monitors/${r.monitor.id}`);
    expect(m.definition.states).toBeUndefined();
    expect(m.definition.description).toMatch(/add states/);
  });
});

describe('read by other tools', () => {
  it('/api/v1 and the MCP tool get_insights_hub_mapping return the mapping and the last check', async () => {
    const v1 = await fetch(`${s.base}/api/v1${base}`, { headers: await authHeaders() });
    expect(v1.status).toBe(200);
    const m = (await v1.json()) as any;
    expect(m).toMatchObject({ isIh: true, sinkId: SINK });
    expect(m.canManage).toBeUndefined();
    expect(m.items.find((i: { item: string }) => i.item === 'spindleSpeed').check.status).toBe('ok');
    await s.api('PUT', '/mcp-server', { enabled: true });
    const token = (await s.api('POST', '/me/tokens', { name: 'ih mcp', scope: 'mcp' })).token;
    const res = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'get_insights_hub_mapping',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_insights_hub_mapping',
          arguments: { assetId: ASSET, collectionId: COLL, sinkId: SINK },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
          },
        },
      }),
    });
    const body = (await res.json()) as any;
    expect(body.result, JSON.stringify(body)).toBeTruthy();
    const data = body.result.structuredContent;
    expect(data).toMatchObject({ isInsightsHub: true, counts: { mapped: 6 } });
    expect(data.items.find((i: { item: string }) => i.item === 'spindleSpeed')).toMatchObject({
      check: 'ok',
      watchedBy: [{ monitor: 'machine-17-machine-data' }],
    });
  });
});

describe('coverage', () => {
  it('per site: mapped, verified and watched per sink, the gaps listed', async () => {
    await s.api('POST', `${base}/check`);
    const c = await s.api('GET', '/plant/sites/ih-site/insights-hub');
    const e = c.entries.find((x: { collectionId: string }) => x.collectionId === COLL);
    expect(e.counts).toMatchObject({ items: 6, mapped: 6, watched: 6 });
    // a unit that differs is a hint: verified all the same
    expect(e.counts.verified).toBe(6);
    expect(e.counts.gaps).toEqual({ unmapped: [], unverified: [], unwatched: [] });
    expect(e.checkedAt).toBeTruthy();
    expect(c.totals.sinks).toBe(c.entries.length);
  });

  it('the data point page says where it goes in Insights Hub and how the check went', async () => {
    const list = await s.api('GET', '/plant/profiles/ih-mill/points/spindle_speed/collections');
    const t = list[0].goesTo.find((x: { sink: string }) => x.sink === SINK);
    expect(t.ih).toMatchObject({ assetId: M17, aspect: 'MachineData', variable: 'spindleSpeed', status: 'ok' });
    expect(t.ih.checkedAt).toBeTruthy();
  });

  it('the KPI coverage marks ready cells whose inputs are verified in Insights Hub (additive)', async () => {
    await s.api('POST', '/plant/kpis', { id: 'ih-speed', name: 'Speed', inputs: [{ profile: 'ih-mill', dataPoints: ['spindle_speed'] }] });
    const v = await s.api('GET', '/plant/views/coverage?site=ih-site');
    const row = v.rows.find((r: { asset: { id: string } }) => r.asset.id === ASSET);
    const k = v.kpis.findIndex((x: { id: string }) => x.id === 'ih-speed');
    expect(row.cells[k]).toMatchObject({ state: 'could', collected: true, ihVerified: true });
    expect(v.potential.ihVerified).toBeGreaterThanOrEqual(1);
  });

  it('renaming the asset keeps its checks and links; removing it takes them along', async () => {
    await s.api('POST', '/plant/ids/rename', { kind: 'asset', id: ASSET, newId: 'ih-mill-17b' });
    const d = await db();
    expect(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_ih_checks WHERE asset_id = 'ih-mill-17b'")!.n).toBeGreaterThan(0);
    expect(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_ih_monitor_links WHERE asset_id = 'ih-mill-17b'")!.n).toBeGreaterThan(0);
    await s.api('DELETE', '/plant/assets/ih-mill-17b');
    expect(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_ih_checks WHERE asset_id = 'ih-mill-17b'")!.n).toBe(0);
    expect(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_ih_monitor_links WHERE asset_id = 'ih-mill-17b'")!.n).toBe(0);
  });
});

async function authHeaders(): Promise<Record<string, string>> {
  const t = await s.api('POST', '/me/tokens', { name: `ih-${Math.random()}`, scope: 'read', expiresInDays: 1 });
  return { authorization: `Bearer ${t.token}` };
}
