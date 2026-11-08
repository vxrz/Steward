import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Renaming and removing plant entries with the 0.11.0 model: a base profile and a derived one, an asset of the derived
 * profile with additions, data collections and remembered gateway names. A rename of an asset, a profile, an
 * interface, a data point and a data path reaches every place that names it (plant/rename.ts REFERENCES); removing an
 * asset takes its collections along (with "also remove"), and a base that another profile extends refuses removal.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const rename = (kind: string, id: string, newId: string, scope = '') => s.api('POST', '/plant/ids/rename', { kind, scope, id, newId });
const db = async () => (await import('../src/db.js')).db();
const row = async (sql: string, ...p: unknown[]) => (await db()).get<Record<string, string>>(sql, ...p) as Record<string, string>;
const json = (v: string) => JSON.parse(v);
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'south', name: 'South works' });
  await s.api('POST', '/plant/profiles', {
    id: 'base-ctrl',
    name: 'Base controller',
    interfaces: [
      {
        id: 'cnc',
        name: 'CNC',
        protocol: 'other',
        groups: [
          {
            name: 'State',
            dataPoints: [
              { id: 'prog_status', name: 'Program status', address: '/Channel/State/progStatus[u1]' },
              { id: 'op_mode', name: 'Operating mode', address: '/Bag/State/opMode[u1]' },
            ],
          },
        ],
      },
    ],
  });
  await s.api('POST', '/plant/profiles', {
    id: 'derived-ctrl',
    name: 'Derived controller',
    extends: 'base-ctrl',
    interfaceOverrides: [{ interface: 'cnc', defaultPort: 102, groups: [{ name: 'State', dataPoints: [{ id: 'spindle_load', name: 'Spindle load' }] }] }],
    pointOverrides: [{ dataPoint: 'prog_status', address: '/Channel/State/progStatus[u2]' }],
  });
  await s.api('POST', '/plant/kpis', { id: 'run-time', name: 'Run time', inputs: [{ profile: 'derived-ctrl', dataPoints: ['prog_status'] }] });
  await s.api('POST', '/plant/assets', { id: 'south-mill-1', siteId: 'south', name: 'Mill 1' });
  await s.api('POST', '/plant/assets/south-mill-1/paths', { id: 'to-historian', subject: 'Machine state' });
  await s.api('PUT', '/plant/assets/south-mill-1/assignment', {
    profileId: 'derived-ctrl',
    interfaces: [{ interface: 'cnc', active: true }],
    overrides: [{ dataPoint: 'prog_status', address: '/Channel/State/progStatus[u3]' }],
    additions: { interfaces: [], dataPoints: [{ interface: 'cnc', group: 'Extra', id: 'air_pressure', name: 'Air pressure' }] },
  });
  await s.api('POST', '/plant/assets/south-mill-1/collections/import', {
    collector: { kind: 'job', ref: 'gw' },
    interfaceId: 'cnc',
    dataPathId: 'to-historian',
    files: [
      { name: 'c.csv', content: 'collection,source_address,output_name\nstate,/Channel/State/progStatus[u3],ProgStatus\nstate,/Bag/State/opMode[u1],OpMode\n' },
    ],
  });
});
afterAll(async () => {
  await s?.app.close();
});

describe('renames reach the 0.11.0 columns', () => {
  it('the collections are there to follow', async () => {
    const c = await row("SELECT * FROM plant_collections WHERE asset_id = 'south-mill-1'");
    expect(c).toMatchObject({ interface_id: 'cnc', data_path_id: 'to-historian' });
    expect(json(c.items).map((i: { dataPoint: string }) => i.dataPoint)).toEqual(['prog_status', 'op_mode']);
    expect((await (await db()).all("SELECT * FROM plant_collection_mappings WHERE asset_id = 'south-mill-1'")).length).toBe(2);
  });

  it('a data point of the base: the derived profile, the asset’s differences, KPI inputs, collections and remembered names follow', async () => {
    await rename('data_point', 'prog_status', 'program_status', 'base-ctrl');
    const d = await row("SELECT point_overrides FROM plant_profiles WHERE id = 'derived-ctrl'");
    expect(json(d.point_overrides)[0].dataPoint).toBe('program_status');
    const a = await row("SELECT overrides FROM plant_assignments WHERE asset_id = 'south-mill-1'");
    expect(json(a.overrides)[0].dataPoint).toBe('program_status');
    expect(json((await row("SELECT inputs FROM plant_kpis WHERE id = 'run-time'")).inputs)[0].dataPoints).toEqual(['program_status']);
    const c = await row("SELECT items FROM plant_collections WHERE asset_id = 'south-mill-1'");
    expect(json(c.items)[0].dataPoint).toBe('program_status');
    expect(await row("SELECT data_point FROM plant_collection_mappings WHERE asset_id = 'south-mill-1' AND gateway_name = 'ProgStatus'")).toEqual({
      data_point: 'program_status',
    });
    const view = await s.api('GET', '/plant/assets/south-mill-1/assignment');
    expect(view.checks).toEqual([]);
  });

  it('a data point the derived profile adds to an inherited interface is renamed in its own part', async () => {
    await rename('data_point', 'spindle_load', 'spindle_load_pct', 'derived-ctrl');
    const d = await row("SELECT interface_overrides FROM plant_profiles WHERE id = 'derived-ctrl'");
    expect(json(d.interface_overrides)[0].groups[0].dataPoints[0].id).toBe('spindle_load_pct');
    // an id the family has already is refused: the base's op_mode would be in the derived profile twice
    expect(await status(rename('data_point', 'spindle_load_pct', 'op_mode', 'derived-ctrl'))).toEqual({ status: 409, code: 'PLANT_ID_TAKEN' });
  });

  it('an interface of the base: the derived profile’s override, the assignment, its additions and the collections follow', async () => {
    await rename('interface', 'cnc', 'cnc-vars', 'base-ctrl');
    expect(json((await row("SELECT interface_overrides FROM plant_profiles WHERE id = 'derived-ctrl'")).interface_overrides)[0].interface).toBe('cnc-vars');
    const a = await row("SELECT interfaces, additions FROM plant_assignments WHERE asset_id = 'south-mill-1'");
    expect(json(a.interfaces)[0].interface).toBe('cnc-vars');
    expect(json(a.additions).dataPoints[0].interface).toBe('cnc-vars');
    expect((await row("SELECT interface_id FROM plant_collections WHERE asset_id = 'south-mill-1'")).interface_id).toBe('cnc-vars');
    const view = await s.api('GET', '/plant/assets/south-mill-1/assignment');
    expect(view.checks).toEqual([]);
    expect(view.added.points).toEqual(['air_pressure']);
  });

  it('a profile that is extended: the derived profile follows its new id', async () => {
    await rename('profile', 'base-ctrl', 'base-controller');
    expect((await row("SELECT base_id FROM plant_profiles WHERE id = 'derived-ctrl'")).base_id).toBe('base-controller');
    expect((await s.api('GET', '/plant/profiles/derived-ctrl')).bases.map((b: { id: string }) => b.id)).toEqual(['base-controller']);
  });

  it('a data path and an asset: the collections and remembered names follow', async () => {
    await rename('data_path', 'to-historian', 'to-plant-historian', 'south-mill-1');
    expect((await row("SELECT data_path_id FROM plant_collections WHERE asset_id = 'south-mill-1'")).data_path_id).toBe('to-plant-historian');
    await rename('asset', 'south-mill-1', 'south-mill-01');
    expect(Number((await row("SELECT COUNT(*) AS n FROM plant_collections WHERE asset_id = 'south-mill-01'")).n)).toBe(1);
    expect(Number((await row("SELECT COUNT(*) AS n FROM plant_collection_mappings WHERE asset_id = 'south-mill-01'")).n)).toBe(2);
    expect(Number((await row("SELECT COUNT(*) AS n FROM plant_collections WHERE asset_id = 'south-mill-1'")).n)).toBe(0);
    expect((await s.api('GET', '/plant/assets/south-mill-01/collections')).collections).toHaveLength(1);
  });
});

describe('removal', () => {
  it('a base that another profile extends refuses removal unless that one goes too', async () => {
    const p = await s.api('POST', '/plant/bulk/preview', { kind: 'profile', action: 'remove', items: [{ id: 'base-controller' }] });
    expect(p.items[0]).toMatchObject({ outcome: 'refused' });
  });

  it('a data path with a collection refuses without "also remove"; with it, the collection loses the link', async () => {
    const { planRemoval } = await import('../src/plant/removal.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const admin = toAuthUser(findUserByName('admin')!);
    const target = { kind: 'data_path' as const, scope: 'south-mill-01', id: 'to-plant-historian' };
    const refused = runAs(admin, () => planRemoval([target], { cascade: false }));
    expect(refused.plan.items[0]).toMatchObject({ refused: { code: 'PLANT_REMOVE_HAS_ENTRIES' }, with: [{ what: 'collection', count: 1 }] });
    const d = await db();
    runAs(admin, () => d.tx(() => planRemoval([target], { cascade: true }).apply()));
    expect((await row("SELECT data_path_id FROM plant_collections WHERE asset_id = 'south-mill-01'")).data_path_id).toBeNull();
    expect(await row("SELECT 1 AS x FROM plant_data_paths WHERE asset_id = 'south-mill-01'")).toBeUndefined();
  });

  it('an asset takes its collections and remembered names along with "also remove", and refuses without it', async () => {
    const without = await s.api('POST', '/plant/bulk/preview', { kind: 'asset', action: 'remove', items: [{ id: 'south-mill-01' }] });
    expect(without.items[0]).toMatchObject({ outcome: 'refused', reason: { code: 'PLANT_REMOVE_HAS_ENTRIES' } });
    const r = await s.api('POST', '/plant/bulk', { kind: 'asset', action: 'remove', items: [{ id: 'south-mill-01' }], cascade: true });
    expect(r.applied).toBe(true);
    expect(r.items[0].with.map((w: { what: string }) => w.what)).toEqual(expect.arrayContaining(['collection', 'collection_mapping']));
    expect(Number((await row("SELECT COUNT(*) AS n FROM plant_collections WHERE asset_id = 'south-mill-01'")).n)).toBe(0);
    expect(Number((await row("SELECT COUNT(*) AS n FROM plant_collection_mappings WHERE asset_id = 'south-mill-01'")).n)).toBe(0);
    // now nothing has the derived profile: removing both profiles together is allowed
    const both = await s.api('POST', '/plant/bulk/preview', { kind: 'profile', action: 'remove', items: [{ id: 'base-controller' }, { id: 'derived-ctrl' }] });
    expect(both.items.map((i: { outcome: string }) => i.outcome)).toEqual(['removed', 'removed']);
  });
});
