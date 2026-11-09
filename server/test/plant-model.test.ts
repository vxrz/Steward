import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The plant registry, 0.11.0: profile inheritance (a profile extends one base, several levels, no cycles; it inherits,
 * adds, changes and marks inherited items as not present; the resolved profile is what every page reads) and asset
 * additions (an assignment adds data points and interfaces for its one asset; they count as delivered). The YAML
 * import and export keep the own part and import back unchanged.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const file = (name: string, content: object) => ({ name, content: YAML.stringify(content) });
const pointIds = (p: { interfaces: { groups: { dataPoints: { id: string }[] }[] }[] }) =>
  p.interfaces.flatMap((i) => i.groups.flatMap((g) => g.dataPoints.map((d) => d.id)));

const BASE = {
  id: 'example-cnc-base',
  name: 'Example CNC controller',
  manufacturer: 'Example Controls',
  model: 'CNC',
  category: 'CNC controller',
  interfaces: [
    {
      id: 'opc',
      name: 'OPC UA server',
      protocol: 'opc_ua',
      defaultPort: 4840,
      groups: [
        {
          name: 'State',
          dataPoints: [
            { id: 'prog_status', name: 'Program status', dataType: 'Int32', address: 'ns=2;s=/Channel/State/progStatus', aliases: ['ProgStatus'] },
            { id: 'prog_name', name: 'Program name', dataType: 'String', address: 'ns=2;s=/Channel/ProgramPointer/progName' },
            { id: 'legacy_alarm', name: 'Legacy alarm', dataType: 'Boolean', address: 'ns=2;s=/Legacy/Alarm' },
          ],
        },
      ],
    },
    { id: 'web', name: 'Web UI', protocol: 'http', groups: [] },
  ],
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'north', name: 'North works' });
  for (const id of ['north-mill-1', 'north-mill-2', 'north-mill-3']) await s.api('POST', '/plant/assets', { id, siteId: 'north', name: id });
});
afterAll(async () => {
  await s?.app.close();
});

describe('profile inheritance', () => {
  it('a derived profile inherits, changes, adds and drops; several levels resolve', async () => {
    await s.api('POST', '/plant/profiles', BASE);
    const v2 = await s.api('POST', '/plant/profiles', {
      id: 'example-cnc-v2',
      name: 'Example CNC controller v2',
      version: '2',
      extends: 'example-cnc-base',
      interfaceOverrides: [
        {
          interface: 'opc',
          defaultPort: 4841,
          groups: [{ name: 'State', dataPoints: [{ id: 'spindle_load', name: 'Spindle load', unit: '%', address: 'ns=2;s=/DriveHsa/State/load' }] }],
        },
        { interface: 'web', present: false },
      ],
      pointOverrides: [
        { dataPoint: 'prog_name', address: 'ns=3;s=/Channel/ProgramPointer/progName[u1,1]' },
        { dataPoint: 'legacy_alarm', present: false },
      ],
      interfaces: [
        { id: 'mqtt', name: 'MQTT', protocol: 'mqtt', groups: [{ name: '', dataPoints: [{ id: 'part_count', name: 'Part count', address: 'cnc/parts' }] }] },
      ],
    });
    expect(v2).toMatchObject({
      extends: 'example-cnc-base',
      manufacturer: 'Example Controls',
      category: 'CNC controller',
      bases: [{ id: 'example-cnc-base' }],
    });
    expect(v2.interfaces.map((i: { id: string }) => i.id)).toEqual(['opc', 'mqtt']);
    expect(v2.interfaces[0].defaultPort).toBe(4841);
    expect(pointIds(v2)).toEqual(['prog_status', 'prog_name', 'spindle_load', 'part_count']);
    expect(v2.interfaces[0].groups[0].dataPoints[1].address).toBe('ns=3;s=/Channel/ProgramPointer/progName[u1,1]');
    expect(v2.origins.points).toMatchObject({
      prog_status: { kind: 'inherited', from: 'example-cnc-base' },
      prog_name: { kind: 'overridden', from: 'example-cnc-base', fields: ['address'] },
      spindle_load: { kind: 'own', from: 'example-cnc-v2' },
      part_count: { kind: 'own' },
    });
    expect(v2.origins.interfaces.opc).toMatchObject({ kind: 'overridden', fields: ['defaultPort'] });
    expect(v2.notPresent).toEqual({
      interfaces: [{ id: 'web', name: 'Web UI', by: 'example-cnc-v2' }],
      points: [{ id: 'legacy_alarm', name: 'Legacy alarm', interface: 'opc', by: 'example-cnc-v2' }],
    });
    expect(v2.own.interfaces.map((i: { id: string }) => i.id)).toEqual(['mqtt']);
    expect(v2.dataPointCount).toBe(4);
    // a third level: inherits v2's change, overrides the unit
    const v3 = await s.api('POST', '/plant/profiles', {
      id: 'example-cnc-v3',
      name: 'Example CNC controller v3',
      extends: 'example-cnc-v2',
      pointOverrides: [{ dataPoint: 'spindle_load', unit: '1' }],
    });
    expect(v3.bases.map((b: { id: string }) => b.id)).toEqual(['example-cnc-v2', 'example-cnc-base']);
    expect(v3.origins.points.prog_name).toMatchObject({ kind: 'inherited', from: 'example-cnc-base', changedBy: ['example-cnc-v2'] });
    expect(v3.origins.points.spindle_load).toMatchObject({ kind: 'overridden', from: 'example-cnc-v2', fields: ['unit'] });
    expect((await s.api('GET', '/plant/profiles/example-cnc-base')).extendedBy).toEqual([{ id: 'example-cnc-v2', name: 'Example CNC controller v2' }]);
  });

  it('changes to a base flow down', async () => {
    const base = structuredClone(BASE) as any;
    base.interfaces[0].groups[0].dataPoints.push({ id: 'feed_override', name: 'Feed override', unit: '%', address: 'ns=2;s=/Channel/State/feedRateOvr' });
    const { id: _id, ...body } = base;
    await s.api('PUT', '/plant/profiles/example-cnc-base', body);
    const v3 = await s.api('GET', '/plant/profiles/example-cnc-v3');
    expect(pointIds(v3)).toContain('feed_override');
    expect(v3.origins.points.feed_override).toMatchObject({ kind: 'inherited', from: 'example-cnc-base' });
  });

  it('refuses cycles, itself, a missing base, a clash with an inherited id; a base that is extended cannot be deleted', async () => {
    const put = (id: string, b: object) => status(s.api('PUT', `/plant/profiles/${id}`, { name: id, ...b }));
    expect(await put('example-cnc-base', { ...BASE, id: undefined, extends: 'example-cnc-v3' })).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(await put('example-cnc-v3', { extends: 'example-cnc-v3' })).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(await put('example-cnc-v3', { extends: 'nope' })).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(
      await put('example-cnc-v3', {
        extends: 'example-cnc-v2',
        interfaces: [{ id: 'opc', protocol: 'opc_ua', groups: [] }],
      }),
    ).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(
      await put('example-cnc-v3', {
        extends: 'example-cnc-v2',
        interfaceOverrides: [{ interface: 'opc', groups: [{ name: 'State', dataPoints: [{ id: 'prog_status', name: 'Twice' }] }] }],
      }),
    ).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    // the base gets a data point the derived one adds already: refused, naming the derived profile
    const base = structuredClone(BASE) as any;
    base.interfaces[0].groups[0].dataPoints.push({ id: 'spindle_load', name: 'Spindle load', address: 'ns=2;s=x' });
    const { id: _i, ...body } = base;
    const e = await s.api('PUT', '/plant/profiles/example-cnc-base', body).catch((x: { body: { error: string } }) => x.body.error);
    expect(e).toMatch(/example-cnc-v2" extends this one/);
    expect(await status(s.api('DELETE', '/plant/profiles/example-cnc-base'))).toEqual({ status: 409, code: 'PLANT_PROFILE_EXTENDED' });
  });

  it('duplicate keeps extends', async () => {
    await s.api('POST', '/plant/profiles/example-cnc-v2/duplicate', { name: 'Example CNC v2 copy', key: 'example-cnc-v2-copy' });
    const c = await s.api('GET', '/plant/profiles/example-cnc-v2-copy');
    expect(c).toMatchObject({ extends: 'example-cnc-base', dataPointCount: 5 });
    await s.api('DELETE', '/plant/profiles/example-cnc-v2-copy');
  });
});

describe('assets of a derived profile and asset additions', () => {
  it('a KPI that reads the base reads the derived profile; the data point page lists the derived assets', async () => {
    await s.api('POST', '/plant/kpis', {
      id: 'program-time',
      name: 'Program time',
      inputs: [{ profile: 'example-cnc-base', dataPoints: ['prog_status', 'prog_name'] }],
    });
    await s.api('PUT', '/plant/assets/north-mill-1/assignment', {
      profileId: 'example-cnc-v2',
      interfaces: [{ interface: 'opc', active: true, endpoint: 'opc.tcp://north-mill-1:4841' }],
      kpis: [{ kpi: 'program-time', job: 'north-mill-1-program-time' }],
    });
    const a = await s.api('GET', '/plant/assets/north-mill-1/assignment');
    expect(a.checks).toEqual([]);
    const point = await s.api('GET', '/plant/profiles/example-cnc-base/points/prog_status');
    expect(point.assets.map((x: { asset: { id: string }; delivers: boolean }) => `${x.asset.id}:${x.delivers}`)).toEqual(['north-mill-1:true']);
    // a data point the derived profile drops: its assets are not listed
    const legacy = await s.api('GET', '/plant/profiles/example-cnc-base/points/legacy_alarm');
    expect(legacy.assets).toEqual([]);
    expect((await s.api('GET', '/plant/profiles/example-cnc-v2/points/prog_name')).origin).toMatchObject({ kind: 'overridden', fields: ['address'] });
    expect((await s.api('GET', '/plant/profiles/example-cnc-base')).kpis.map((k: { id: string }) => k.id)).toEqual(['program-time']);
    expect((await s.api('GET', '/plant/profiles/example-cnc-v3')).kpis.map((k: { id: string }) => k.id)).toEqual(['program-time']);
    const list = await s.api('GET', '/plant/assets?profile=example-cnc-base&dataPoint=prog_status');
    expect(list.assets ?? list).toBeDefined();
    const lineage = await s.api('GET', '/plant/profiles/example-cnc-base/points/prog_status/lineage');
    expect(lineage.nodes.some((n: { id: string }) => n.id === 'asset:north-mill-1')).toBe(true);
  });

  it('additions: data points and interfaces of one asset count as delivered, in checks, KPI inputs and the data flow', async () => {
    await s.api('POST', '/plant/kpis', { id: 'air-pressure', name: 'Air pressure', inputs: [{ profile: '', dataPoints: ['air_pressure', 'clamp_state'] }] });
    const put = (b: object) =>
      s.api('PUT', '/plant/assets/north-mill-2/assignment', {
        profileId: 'example-cnc-v2',
        interfaces: [
          { interface: 'opc', active: true },
          { interface: 'clamp-io', active: true, endpoint: '10.0.0.5:502' },
        ],
        kpis: [{ kpi: 'air-pressure', job: 'north-mill-2-air' }],
        ...b,
      });
    const a = await put({
      additions: {
        interfaces: [
          {
            id: 'clamp-io',
            name: 'Clamp I/O',
            protocol: 'modbus_tcp',
            groups: [{ name: '', dataPoints: [{ id: 'clamp_state', name: 'Clamp state', address: 'coil:4' }] }],
          },
        ],
        dataPoints: [
          { interface: 'opc', group: 'Pneumatics', id: 'air_pressure', name: 'Air pressure', unit: 'bar', address: 'ns=2;s=/Plc/Air', aliases: ['AirP'] },
        ],
      },
    });
    expect(a.checks).toEqual([]);
    expect(a.added).toEqual({ interfaces: ['clamp-io'], points: ['clamp_state', 'air_pressure'] });
    expect(a.model.map((i: { id: string }) => i.id)).toEqual(['opc', 'mqtt', 'clamp-io']);
    expect(a.possibleKpis.map((k: { id: string }) => k.id)).toContain('air-pressure');
    const flow = await s.api('GET', '/plant/assets/north-mill-2/flow');
    expect(flow.nodes.some((n: { id: string }) => n.id === 'if:clamp-io')).toBe(true);
    expect(flow.paths.find((p: { id: string }) => p.id === 'air_pressure')).toMatchObject({ delivers: true });
    // rules: an added interface with the profile's id, a data point twice, an address that does not fit
    for (const bad of [
      { interfaces: [{ id: 'opc', protocol: 'opc_ua', groups: [] }], dataPoints: [] },
      { interfaces: [], dataPoints: [{ interface: 'opc', group: '', id: 'prog_status', name: 'Again' }] },
      { interfaces: [], dataPoints: [{ interface: 'nope', group: '', id: 'x1', name: 'X' }] },
      { interfaces: [], dataPoints: [{ interface: 'opc', group: '', id: 'x2', name: 'X', address: 'holding:1' }] },
    ])
      expect(await status(put({ additions: bad }))).toEqual({ status: 400, code: 'PLANT_ASSIGNMENT_INVALID' });
  });

  it('a data point added on the asset that the profile gets later is the profile’s: shown as a check', async () => {
    await s.api('PUT', '/plant/profiles/example-cnc-v3', {
      name: 'Example CNC controller v3',
      extends: 'example-cnc-v2',
      interfaceOverrides: [
        { interface: 'opc', groups: [{ name: 'Pneumatics', dataPoints: [{ id: 'air_pressure', name: 'Air pressure', address: 'ns=2;s=/Plc/Air' }] }] },
      ],
    });
    await s.api('PUT', '/plant/assets/north-mill-3/assignment', {
      profileId: 'example-cnc-v2',
      interfaces: [{ interface: 'opc', active: true }],
      additions: { interfaces: [], dataPoints: [{ interface: 'opc', group: '', id: 'air_pressure', name: 'Air', address: 'ns=2;s=/Plc/Air' }] },
    });
    // switching the profile in the database the way an import of a later file would
    const { db } = await import('../src/db.js');
    db().run("UPDATE plant_assignments SET profile_id = 'example-cnc-v3' WHERE asset_id = 'north-mill-3'");
    const a = await s.api('GET', '/plant/assets/north-mill-3/assignment');
    expect(a.checks.map((c: { code: string }) => c.code)).toEqual(['addition_shadowed']);
  });
});

describe('YAML', () => {
  it('a derived profile exports only its own part, with the same keys, and imports back unchanged', async () => {
    const out = await s.api('GET', '/plant/export?profile=example-cnc-v2');
    const doc = YAML.parse(typeof out === 'string' ? out : JSON.stringify(out));
    expect(doc.device_profile).toMatchObject({ id: 'example-cnc-v2', extends: 'example-cnc-base' });
    expect(doc.device_profile.manufacturer).toBeUndefined();
    expect(doc.device_profile.interfaces).toEqual([
      {
        id: 'opc',
        default_port: 4841,
        groups: [
          {
            name: 'State',
            data_points: [
              { id: 'prog_name', address: 'ns=3;s=/Channel/ProgramPointer/progName[u1,1]' },
              { id: 'legacy_alarm', present: false },
              { id: 'spindle_load', name: 'Spindle load', unit: '%', address: 'ns=2;s=/DriveHsa/State/load' },
            ],
          },
        ],
      },
      { id: 'web', present: false },
      { id: 'mqtt', name: 'MQTT', protocol: 'mqtt', data_points: [{ id: 'part_count', name: 'Part count', address: 'cnc/parts' }] },
    ]);
    const p = await s.api('POST', '/plant/import/preview', { files: [file('v2.yaml', doc)], mode: 'update' });
    expect(p.problems).toEqual([]);
    expect(p.changes.map((c: { action: string; fields?: string[] }) => `${c.action} ${c.fields ?? ''}`)).toEqual(['unchanged ']);
  });

  it('a whole catalogue round-trips; an assignment exports its additions', async () => {
    // (the asset whose addition is shadowed is drift: an import refuses it, as it refuses other drift)
    await s.api('DELETE', '/plant/assets/north-mill-3/assignment');
    const out = await s.api('GET', '/plant/export');
    const doc = YAML.parse(out);
    const a2 = doc.assignments.find((a: { asset: string }) => a.asset === 'north-mill-2');
    expect(a2.additions).toMatchObject({
      interfaces: [{ id: 'clamp-io', protocol: 'modbus_tcp' }],
      data_points: [{ interface: 'opc', group: 'Pneumatics', id: 'air_pressure', aliases: ['AirP'] }],
    });
    const p = await s.api('POST', '/plant/import/preview', { files: [file('all.yaml', doc)], mode: 'update' });
    expect(p.problems).toEqual([]);
    expect(p.changes.filter((c: { action: string }) => c.action !== 'unchanged')).toEqual([]);
  });

  it('imports a base and its derived profile from the files in any order; refuses unknown inherited items and cycles', async () => {
    const child = {
      id: 'example-pump-v2',
      name: 'Pump controller v2',
      extends: 'example-pump',
      interfaces: [
        {
          id: 'mb',
          groups: [
            {
              name: 'Flow',
              data_points: [
                { id: 'flow', unit: 'L/min' },
                { id: 'pressure', name: 'Pressure', address: 'input:10,2' },
              ],
            },
          ],
        },
      ],
    };
    const base = {
      id: 'example-pump',
      name: 'Pump controller',
      interfaces: [{ id: 'mb', protocol: 'modbus_tcp', groups: [{ name: 'Flow', data_points: [{ id: 'flow', name: 'Flow', address: 'input:0,2' }] }] }],
    };
    const r = await s.api('POST', '/plant/import', { files: [file('pumps.yaml', { version: 1, device_profiles: [child, base] })], mode: 'add' });
    expect(r.import.counts).toMatchObject({ add: 2 });
    const v2 = await s.api('GET', '/plant/profiles/example-pump-v2');
    expect(v2.interfaces[0].groups[0].dataPoints.map((d: { id: string; unit: string }) => `${d.id}:${d.unit}`)).toEqual(['flow:L/min', 'pressure:']);
    const bad = await s.api('POST', '/plant/import/preview', {
      files: [
        file('bad.yaml', {
          version: 1,
          device_profiles: [
            {
              ...child,
              id: 'example-pump-v3',
              interfaces: [{ id: 'mb', groups: [{ name: 'Flow', data_points: [{ id: 'ghost', present: false }] }] }, { id: 'new-one' }],
            },
            { id: 'cyc-a', name: 'A', extends: 'cyc-b' },
            { id: 'cyc-b', name: 'B', extends: 'cyc-a' },
          ],
        }),
      ],
      mode: 'add',
    });
    const messages = bad.problems.map((x: { message: string }) => x.message).join('\n');
    expect(messages).toMatch(/The base has no data point "ghost"/);
    expect(messages).toMatch(/a new interface needs its protocol/);
    expect(messages).toMatch(/no cycles/);
  });
});
