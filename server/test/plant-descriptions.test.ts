import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Descriptions in the plant registry (0.12.0): optional plain text on device profiles, interfaces, data point groups,
 * data points and file sets, inherited along a profile's chain – a derived profile shows the base's and may describe
 * each one anew (stored in its own part) or go back to the inherited one. The export writes only the own part and
 * imports back unchanged; an import's preview shows a changed description. Asset additions and data collections with
 * their items have their own descriptions.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const file = (name: string, content: object) => ({ name, content: YAML.stringify(content) });
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );

const BASE = {
  id: 'example-plc-base',
  name: 'Example PLC',
  description: 'A small PLC with an OPC UA server.',
  interfaces: [
    {
      id: 'opc',
      name: 'OPC UA server',
      protocol: 'opc_ua',
      description: 'The PLC’s OPC UA server.',
      groups: [
        {
          name: 'State',
          description: 'Machine state.',
          dataPoints: [{ id: 'run', name: 'Running', description: 'True while the machine runs.', dataType: 'Boolean', address: 'ns=2;s=Run' }],
        },
      ],
    },
    {
      id: 'files',
      name: 'Program share',
      protocol: 'smb',
      groups: [],
      fileSets: [{ id: 'programs', name: 'Programs', description: 'Part programs.', format: 'txt' }],
    },
  ],
};

const profile = (id: string) => s.api('GET', `/plant/profiles/${id}`);
const own = async (id: string) => (await profile(id)).own;
const put = async (id: string, change: (own: any) => void) => {
  const o = await own(id);
  change(o);
  const { id: _id, ...body } = o;
  return s.api('PUT', `/plant/profiles/${id}`, body);
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'north', name: 'North works' });
  await s.api('POST', '/plant/assets', { id: 'north-press-1', siteId: 'north', name: 'Press 1' });
  await s.api('POST', '/plant/profiles', BASE);
  await s.api('POST', '/plant/profiles', { id: 'example-plc-v2', name: 'Example PLC v2', extends: 'example-plc-base' });
  await s.api('POST', '/plant/profiles', { id: 'example-plc-v3', name: 'Example PLC v3', extends: 'example-plc-v2' });
});
afterAll(async () => {
  await s?.app.close();
});

describe('inherited descriptions', () => {
  it('a derived profile shows every description of its bases and says where each comes from', async () => {
    const v3 = await profile('example-plc-v3');
    expect(v3.description).toBe('A small PLC with an OPC UA server.');
    expect(v3.descriptionFrom).toBe('example-plc-base');
    // the own part stays empty: nothing is copied
    expect(v3.own.description).toBe('');
    expect(v3.interfaces[0].description).toBe('The PLC’s OPC UA server.');
    expect(v3.origins.interfaces.opc).toMatchObject({ kind: 'inherited', descriptionFrom: 'example-plc-base' });
    expect(v3.interfaces[0].groups[0].description).toBe('Machine state.');
    expect(v3.origins.groups['opc/State']).toMatchObject({ kind: 'inherited', descriptionFrom: 'example-plc-base' });
    expect(v3.origins.points.run).toMatchObject({ kind: 'inherited', descriptionFrom: 'example-plc-base' });
    expect(v3.interfaces[1].fileSets[0].description).toBe('Part programs.');
    expect(v3.origins.fileSets['files/programs']).toMatchObject({ kind: 'inherited', descriptionFrom: 'example-plc-base' });
    const point = await s.api('GET', '/plant/profiles/example-plc-v3/points/run');
    expect(point.point.description).toBe('True while the machine runs.');
    expect(point.origin.descriptionFrom).toBe('example-plc-base');
  });

  it('describes each one anew in the own part; the next level inherits the new text; a reset brings back the inherited one', async () => {
    await put('example-plc-v2', (o) => {
      o.description = 'The second generation.';
      o.interfaceOverrides = [
        {
          interface: 'opc',
          present: true,
          description: 'OPC UA server, firmware 2.',
          groups: [{ name: 'State', description: 'Machine state, firmware 2.', dataPoints: [] }],
          fileSets: [],
        },
        {
          interface: 'files',
          present: true,
          groups: [],
          fileSets: [
            {
              ...BASE.interfaces[1]!.fileSets![0],
              direction: 'read',
              pathPattern: '',
              producedPer: '',
              retention: '',
              encoding: '',
              notes: '',
              description: 'Part programs, firmware 2.',
            },
          ],
        },
      ];
      o.pointOverrides = [{ dataPoint: 'run', present: true, description: 'True while the spindle turns.' }];
    });
    const v2 = await profile('example-plc-v2');
    expect(v2).toMatchObject({ description: 'The second generation.', descriptionFrom: 'example-plc-v2' });
    expect(v2.origins.interfaces.opc).toMatchObject({ kind: 'overridden', fields: ['description'], descriptionFrom: 'example-plc-v2' });
    expect(v2.origins.groups['opc/State']).toMatchObject({ kind: 'overridden', fields: ['description'], descriptionFrom: 'example-plc-v2' });
    expect(v2.origins.fileSets['files/programs']).toMatchObject({ kind: 'overridden', fields: ['description'], descriptionFrom: 'example-plc-v2' });
    expect(v2.origins.points.run).toMatchObject({ kind: 'overridden', fields: ['description'], descriptionFrom: 'example-plc-v2' });
    expect(v2.interfaces[0].groups[0]).toMatchObject({ name: 'State', description: 'Machine state, firmware 2.' });
    expect(v2.interfaces[0].groups[0].dataPoints.map((d: { id: string }) => d.id)).toEqual(['run']);

    const v3 = await profile('example-plc-v3');
    expect(v3).toMatchObject({ description: 'The second generation.', descriptionFrom: 'example-plc-v2' });
    expect(v3.origins.interfaces.opc).toMatchObject({ kind: 'inherited', descriptionFrom: 'example-plc-v2' });
    expect(v3.origins.groups['opc/State']).toMatchObject({ kind: 'inherited', descriptionFrom: 'example-plc-v2' });
    expect(v3.interfaces[1].fileSets[0].description).toBe('Part programs, firmware 2.');
    expect(v3.interfaces[0].groups[0].dataPoints[0].description).toBe('True while the spindle turns.');

    // back to the inherited ones: the profile's text empty, the override keys gone, a group's and a file set's text empty
    await put('example-plc-v2', (o) => {
      o.description = '';
      o.interfaceOverrides = o.interfaceOverrides.map((x: any) => {
        const { description: _d, ...rest } = x;
        return {
          ...rest,
          groups: rest.groups.map((g: any) => ({ ...g, description: '' })),
          fileSets: rest.fileSets.map((f: any) => ({ ...f, description: '' })),
        };
      });
      o.pointOverrides = [];
    });
    const back = await profile('example-plc-v2');
    expect(back).toMatchObject({ description: 'A small PLC with an OPC UA server.', descriptionFrom: 'example-plc-base' });
    // nothing left that changes anything: no overrides stored
    expect(back.own.interfaceOverrides).toEqual([]);
    expect(back.origins.groups['opc/State']).toMatchObject({ kind: 'inherited', descriptionFrom: 'example-plc-base' });
    expect(back.interfaces[1].fileSets[0].description).toBe('Part programs.');
    expect(back.origins.points.run.descriptionFrom).toBe('example-plc-base');
  });

  it('keeps the length limit of descriptions', async () => {
    const r = await status(put('example-plc-v2', (o) => (o.description = 'x'.repeat(9000))));
    expect(r.status).toBe(400);
  });
});

describe('import and export', () => {
  it('exports only the own part and imports back unchanged; the preview shows a changed description', async () => {
    await put('example-plc-v2', (o) => {
      o.description = 'The second generation.';
      o.interfaceOverrides = [
        {
          interface: 'opc',
          present: true,
          description: 'OPC UA server, firmware 2.',
          groups: [{ name: 'State', description: 'Machine state, firmware 2.', dataPoints: [] }],
          fileSets: [],
        },
      ];
      o.pointOverrides = [{ dataPoint: 'run', present: true, description: 'True while the spindle turns.' }];
    });
    const v3doc = YAML.parse(await s.api('GET', '/plant/export?profile=example-plc-v3'));
    // v3 describes nothing itself: the export has no description at all
    expect(JSON.stringify(v3doc)).not.toContain('description');
    const doc = YAML.parse(await s.api('GET', '/plant/export?profile=example-plc-v2'));
    expect(doc.device_profile).toEqual({
      id: 'example-plc-v2',
      name: 'Example PLC v2',
      extends: 'example-plc-base',
      description: 'The second generation.',
      interfaces: [
        {
          id: 'opc',
          description: 'OPC UA server, firmware 2.',
          groups: [{ name: 'State', description: 'Machine state, firmware 2.', data_points: [{ id: 'run', description: 'True while the spindle turns.' }] }],
        },
      ],
    });
    const same = await s.api('POST', '/plant/import/preview', { files: [file('v2.yaml', doc)], mode: 'update' });
    expect(same.problems).toEqual([]);
    expect(same.changes.map((c: { action: string }) => c.action)).toEqual(['unchanged']);

    // a group described anew in a file (no data points) is kept; the preview names the changed field
    doc.device_profile.interfaces[0].groups[0] = { name: 'State', description: 'Machine state (from a file).' };
    const changed = await s.api('POST', '/plant/import/preview', { files: [file('v2.yaml', doc)], mode: 'update' });
    expect(changed.problems).toEqual([]);
    expect(changed.changes).toHaveLength(1);
    expect(changed.changes[0]).toMatchObject({ kind: 'profile', action: 'change' });
    expect(changed.changes[0].diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'interfaceOverrides[opc].groups[State].description',
          before: 'Machine state, firmware 2.',
          after: 'Machine state (from a file).',
        }),
      ]),
    );
    await s.api('POST', '/plant/import', { files: [file('v2.yaml', doc)], mode: 'update' });
    expect((await profile('example-plc-v3')).interfaces[0].groups[0].description).toBe('Machine state (from a file).');
  });
});

describe('asset additions and data collections', () => {
  it('an addition keeps its description through the export', async () => {
    await s.api('PUT', '/plant/assets/north-press-1/assignment', {
      profileId: 'example-plc-v3',
      interfaces: [{ interface: 'opc', active: true, endpoint: '', notes: '' }],
      overrides: [{ dataPoint: 'run', available: true, address: 'ns=2;s=Press.Run', notes: 'On this press: the hydraulic pump’s run signal.' }],
      additions: {
        interfaces: [],
        dataPoints: [
          { interface: 'opc', group: 'State', id: 'stroke', name: 'Stroke count', description: 'Strokes since the last reset.', address: 'ns=2;s=Stroke' },
        ],
      },
    });
    const doc = YAML.parse(await s.api('GET', '/plant/export?asset=north-press-1'));
    const a = (doc.assignments ?? [doc.assignment]).find((x: { asset: string }) => x.asset === 'north-press-1');
    expect(a.additions.data_points[0]).toMatchObject({ id: 'stroke', description: 'Strokes since the last reset.' });
    expect(a.overrides[0]).toMatchObject({ data_point: 'run', notes: 'On this press: the hydraulic pump’s run signal.' });
  });

  it('a collection and its items have optional descriptions; a re-import keeps an item’s description', async () => {
    const created = await s.api('POST', '/plant/assets/north-press-1/collections', {
      id: 'gw',
      name: 'Gateway',
      collector: { kind: 'job', ref: 'example-gateway' },
      description: 'What the edge gateway reads every second.',
      items: [{ address: 'ns=2;s=Run', outputName: 'PressRun', dataPoint: 'run', description: 'Read for the availability KPI.' }],
    });
    expect(created).toMatchObject({ description: 'What the edge gateway reads every second.' });
    expect(created.items[0].description).toBe('Read for the availability KPI.');
    const view = await s.api('GET', '/plant/assets/north-press-1/collections/gw');
    expect(view.description).toBe('What the edge gateway reads every second.');
    // too long: refused
    expect(
      await status(s.api('PUT', '/plant/assets/north-press-1/collections/gw', { ...created, id: undefined, description: 'x'.repeat(5000) })),
    ).toMatchObject({
      status: 400,
    });

    // the table format reads a description column; a re-import without one keeps what was written by hand
    const csv = 'collection,source_address,output_name,description\nLine,ns=2;s=Stroke,Strokes,Counted by the PLC\nLine,ns=2;s=Run,Run,\n';
    const body = { collector: { kind: 'job', ref: 'example-table-job' }, files: [{ name: 'line.csv', content: csv }], format: 'table' };
    await s.api('POST', '/plant/assets/north-press-1/collections/import', body);
    const all = await s.api('GET', '/plant/assets/north-press-1/collections');
    const line = all.collections.find((c: { name: string }) => c.name === 'Line');
    const got = await s.api('GET', `/plant/assets/north-press-1/collections/${line.id}`);
    expect(got.items.map((i: { description: string }) => i.description)).toEqual(['Counted by the PLC', '']);
    const items = got.items.map((i: any, n: number) => (n === 1 ? { ...i, description: 'Written by hand.' } : i));
    const {
      id: _i,
      assetId: _a,
      assetName: _n,
      siteId: _s,
      collectorRef: _c,
      collectorHost: _h,
      destinationRef: _d,
      // 0.12: derived from the sinks, as destinationRef
      sinkRefs: _r,
      points: _p,
      coverage: _v,
      writes: _w,
      importId: _m,
      notInSource: _x,
      updatedAt: _u,
      updatedBy: _b,
      ...rest
    } = got;
    await s.api('PUT', `/plant/assets/north-press-1/collections/${line.id}`, { ...rest, items });
    await s.api('POST', '/plant/assets/north-press-1/collections/import', body);
    const again = await s.api('GET', `/plant/assets/north-press-1/collections/${line.id}`);
    expect(again.items.map((i: { description: string }) => i.description)).toEqual(['Counted by the PLC', 'Written by hand.']);
  });
});
