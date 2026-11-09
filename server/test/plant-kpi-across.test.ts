import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { PlantAssignmentView, PlantExtractPreview, PlantKpiDetail, PlantProfileDetail } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The plant registry, 0.13: base profiles across protocols (an inherited interface of protocol "other" gets its
 * protocol in the profile that extends it; extracting a base no longer refuses interfaces of different protocols, and
 * every asset's model stays as it was).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string; params?: Record<string, unknown>; message?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string; params?: Record<string, unknown>; error?: string } }) => ({
      status: e.status,
      code: e.body?.code,
      params: e.body?.params,
      message: e.body?.error,
    }),
  );
const file = (name: string, content: object) => ({ name, content: YAML.stringify(content) });
const assign = (assetId: string, profileId: string, iface: string, more: Record<string, unknown> = {}) =>
  s.api('PUT', `/plant/assets/${assetId}/assignment`, { profileId, interfaces: [{ interface: iface, active: true, endpoint: '10.0.0.1' }], ...more });

/** A power meter with Modbus/TCP and one of another vendor with OPC UA: the same quantities, other ids and units. */
const A100 = {
  id: 'meter-a100',
  name: 'Meter A100',
  manufacturer: 'Example Meters',
  interfaces: [
    {
      id: 'modbus',
      name: 'Modbus/TCP',
      protocol: 'modbus_tcp',
      defaultPort: 502,
      groups: [
        {
          name: 'Energy',
          dataPoints: [
            { id: 'energy_total', name: 'Active energy', dataType: 'Float', unit: 'kWh', address: 'holding:100,2' },
            { id: 'power', name: 'Active power', dataType: 'Float', unit: 'kW', address: 'holding:110,2' },
          ],
        },
      ],
    },
  ],
};
const B700 = {
  id: 'meter-b700',
  name: 'Meter B700',
  manufacturer: 'Sample Instruments',
  interfaces: [
    {
      id: 'opc-ua',
      name: 'OPC UA server',
      protocol: 'opc_ua',
      defaultPort: 4840,
      groups: [
        {
          name: 'Energy',
          dataPoints: [
            { id: 'ActiveEnergy', name: 'Active energy', dataType: 'Double', unit: 'Wh', address: 'ns=2;s=Meter.ActiveEnergy' },
            { id: 'ActivePower', name: 'Active power', dataType: 'Double', unit: 'kW', address: 'ns=2;s=Meter.ActivePower' },
          ],
        },
      ],
    },
  ],
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'north', name: 'North works' });
});
afterAll(async () => {
  await s?.app.close();
});

describe('a base across protocols: an interface of protocol "other"', () => {
  beforeAll(async () => {
    await s.api('POST', '/plant/profiles', {
      id: 'meter-any',
      name: 'Any meter',
      template: true,
      interfaces: [
        { id: 'meter', name: 'Meter', protocol: 'other', groups: [{ name: 'Energy', dataPoints: [{ id: 'energy', name: 'Energy', unit: 'kWh' }] }] },
      ],
    });
  });

  it('lets a derived profile set the protocol and the addresses', async () => {
    await s.api('POST', '/plant/profiles', {
      id: 'meter-x-modbus',
      name: 'Meter X (Modbus)',
      extends: 'meter-any',
      interfaceOverrides: [{ interface: 'meter', protocol: 'modbus_tcp', defaultPort: 502 }],
      pointOverrides: [{ dataPoint: 'energy', address: 'holding:1,2' }],
    });
    const p = (await s.api('GET', '/plant/profiles/meter-x-modbus')) as PlantProfileDetail;
    expect(p.interfaces[0]).toMatchObject({ id: 'meter', protocol: 'modbus_tcp', defaultPort: 502 });
    expect(p.interfaces[0]!.groups[0]!.dataPoints[0]!.address).toBe('holding:1,2');
    expect(p.origins.interfaces.meter).toMatchObject({ kind: 'overridden', fields: expect.arrayContaining(['protocol', 'defaultPort']) });
    expect(p.protocols).toEqual(['modbus_tcp']);
    // the base itself stays "other"
    expect(((await s.api('GET', '/plant/profiles/meter-any')) as PlantProfileDetail).interfaces[0]!.protocol).toBe('other');
  });

  it('checks addresses against the protocol it sets, also of data points it adds to the interface', async () => {
    const bad = await status(
      s.api('POST', '/plant/profiles', {
        id: 'meter-x-bad',
        name: 'Meter X bad',
        extends: 'meter-any',
        interfaceOverrides: [{ interface: 'meter', protocol: 'modbus_tcp' }],
        pointOverrides: [{ dataPoint: 'energy', address: 'ns=2;s=Energy' }],
      }),
    );
    expect(bad).toMatchObject({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    const added = await status(
      s.api('POST', '/plant/profiles', {
        id: 'meter-x-bad',
        name: 'Meter X bad',
        extends: 'meter-any',
        interfaceOverrides: [
          { interface: 'meter', protocol: 'opc_ua', groups: [{ name: 'Energy', dataPoints: [{ id: 'power', name: 'Power', address: 'holding:3' }] }] },
        ],
      }),
    );
    expect(added).toMatchObject({ status: 400, code: 'PLANT_PROFILE_INVALID' });
  });

  it('refuses a protocol on an inherited interface whose base has one, and a base that takes "other" away', async () => {
    await s.api('POST', '/plant/profiles', A100);
    const refused = await status(
      s.api('POST', '/plant/profiles', {
        id: 'meter-a100-opc',
        name: 'Meter A100 OPC',
        extends: 'meter-a100',
        interfaceOverrides: [{ interface: 'modbus', protocol: 'opc_ua' }],
      }),
    );
    expect(refused).toMatchObject({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(refused.message).toContain('only an inherited interface of protocol "other"');
    // the base gives its interface a protocol while a derived profile sets another: refused
    const base = (await s.api('GET', '/plant/profiles/meter-any')) as PlantProfileDetail;
    const taken = await status(
      s.api('PUT', '/plant/profiles/meter-any', { ...base.own, id: undefined, interfaces: [{ ...base.own.interfaces[0], protocol: 'opc_ua' }] }),
    );
    expect(taken).toMatchObject({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(taken.message).toContain('meter-x-modbus');
  });

  it('imports and exports the protocol of an inherited interface', async () => {
    const yaml = {
      version: 1,
      device_profiles: [
        {
          id: 'meter-x-opc',
          name: 'Meter X (OPC UA)',
          extends: 'meter-any',
          interfaces: [{ id: 'meter', protocol: 'OPC-UA', data_points: [{ id: 'energy', address: 'ns=2;s=Energy' }] }],
        },
      ],
    };
    const prev = (await s.api('POST', '/plant/import/preview', { files: [file('p.yaml', yaml)], mode: 'update' })) as { problems: unknown[] };
    expect(prev.problems).toEqual([]);
    await s.api('POST', '/plant/import', { files: [file('p.yaml', yaml)], mode: 'update' });
    const p = (await s.api('GET', '/plant/profiles/meter-x-opc')) as PlantProfileDetail;
    expect(p.interfaces[0]).toMatchObject({ protocol: 'opc_ua' });
    expect(p.own.interfaceOverrides[0]).toMatchObject({ interface: 'meter', protocol: 'opc_ua' });
    const out = String(await s.api('GET', '/plant/export?part=catalogue'));
    const exported = (YAML.parseAllDocuments(out).map((d) => d.toJSON()) as { device_profiles?: { id: string; interfaces?: unknown[] }[] }[])
      .flatMap((d) => d.device_profiles ?? [])
      .find((x) => x.id === 'meter-x-opc')!;
    expect(exported.interfaces).toEqual([
      { id: 'meter', protocol: 'opc_ua', groups: [{ name: 'Energy', data_points: [{ id: 'energy', address: 'ns=2;s=Energy' }] }] },
    ]);
    // a protocol for an inherited interface whose base has one is a problem
    const wrong = (await s.api('POST', '/plant/import/preview', {
      files: [
        file('w.yaml', {
          version: 1,
          device_profiles: [{ id: 'meter-w', name: 'W', extends: 'meter-a100', interfaces: [{ id: 'modbus', protocol: 'mqtt' }] }],
        }),
      ],
      mode: 'update',
    })) as { problems: { message: string }[] };
    expect(wrong.problems.map((x) => x.message).join(' ')).toContain('its protocol stays modbus_tcp');
  });
});

describe('extracting a base across protocols', () => {
  const models = async (ids: string[], rename: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const v = (await s.api('GET', `/plant/assets/${id}/assignment`)) as PlantAssignmentView;
      out[id] = v.model
        .map((i) => ({
          ...i,
          id: rename[i.id] ?? i.id,
          groups: i.groups
            .map((g) => ({ ...g, dataPoints: [...g.dataPoints].map((d) => ({ ...d, id: rename[d.id] ?? d.id })).sort((a, b) => a.id.localeCompare(b.id)) }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    return JSON.stringify(out);
  };
  const input = (over: Record<string, unknown> = {}) => ({
    id: 'meter-base',
    name: 'Power meter',
    leading: 'meter-a100',
    profiles: ['meter-a100', 'meter-b700'],
    interfaces: { modbus: 'meter' },
    points: [
      { id: 'energy_total', from: { 'meter-a100': 'energy_total', 'meter-b700': 'ActiveEnergy' } },
      { id: 'power', from: { 'meter-a100': 'power', 'meter-b700': 'ActivePower' } },
    ],
    ...over,
  });

  beforeAll(async () => {
    await s.api('POST', '/plant/profiles', B700);
    for (const id of ['north-meter-a', 'north-meter-b']) await s.api('POST', '/plant/assets', { id, siteId: 'north', name: id });
    await assign('north-meter-a', 'meter-a100', 'modbus', { overrides: [{ dataPoint: 'power', address: 'holding:120,2' }] });
    await assign('north-meter-b', 'meter-b700', 'opc-ua');
  });

  it('no longer refuses interfaces of different protocols: the base has one of protocol "other", without addresses', async () => {
    // the A100 has a profile extending it from the test before; leave it out of the extraction
    await s.api('DELETE', '/plant/profiles/meter-a100-opc').catch(() => undefined);
    const p = (await s.api('POST', '/plant/profiles/extract-base/preview', input())) as PlantExtractPreview;
    expect(p.problems).toEqual([]);
    expect(p.ok).toBe(true);
    expect(p.base.interfaces).toHaveLength(1);
    expect(p.base.interfaces[0]).toMatchObject({ id: 'meter', protocol: 'other', defaultPort: null });
    expect(p.base.interfaces[0]!.groups[0]!.dataPoints.map((d) => [d.id, d.address, d.unit])).toEqual([
      ['energy_total', '', 'kW.h'],
      ['power', '', 'kW'],
    ]);
    const b = p.profiles.find((x) => x.id === 'meter-b700')!;
    expect(b.renames.map((r) => [r.kind, r.from, r.to])).toEqual([
      ['interface', 'opc-ua', 'meter'],
      ['data_point', 'ActiveEnergy', 'energy_total'],
      ['data_point', 'ActivePower', 'power'],
    ]);
    expect(b.interfaceOverrides[0]!.fields).toEqual(expect.arrayContaining(['protocol', 'defaultPort']));
    // the leading profile's interface gets the base's id, too
    expect(p.profiles.find((x) => x.id === 'meter-a100')!.renames.map((r) => [r.kind, r.from, r.to])).toEqual([['interface', 'modbus', 'meter']]);
  });

  it('refuses two leading interfaces given the same base id', async () => {
    await s.api('POST', '/plant/profiles', {
      id: 'meter-c2',
      name: 'Meter C2',
      interfaces: [
        { id: 'one', protocol: 'modbus_tcp', groups: [{ name: 'Energy', dataPoints: [{ id: 'energy_total', name: 'Energy', address: 'holding:1' }] }] },
        { id: 'two', protocol: 'mqtt', groups: [{ name: 'Energy', dataPoints: [{ id: 'power', name: 'Power', address: 'meter/power' }] }] },
      ],
    });
    const p = (await s.api(
      'POST',
      '/plant/profiles/extract-base/preview',
      input({
        leading: 'meter-c2',
        profiles: ['meter-c2', 'meter-b700'],
        interfaces: { one: 'meter', two: 'meter' },
        points: [
          { id: 'energy_total', from: { 'meter-c2': 'energy_total', 'meter-b700': 'ActiveEnergy' } },
          { id: 'power', from: { 'meter-c2': 'power', 'meter-b700': 'ActivePower' } },
        ],
      }),
    )) as PlantExtractPreview;
    expect(p.points.map((x) => x.problem?.code ?? null)).toEqual([null, 'interface']);
    await s.api('DELETE', '/plant/profiles/meter-c2');
  });

  it('extracts: each profile sets its protocol and addresses, every asset model stays as it was', async () => {
    const rename = { modbus: 'meter', 'opc-ua': 'meter', ActiveEnergy: 'energy_total', ActivePower: 'power' };
    const before = await models(['north-meter-a', 'north-meter-b'], rename);
    const done = (await s.api('POST', '/plant/profiles/extract-base', input())) as PlantExtractPreview;
    expect(done.ok).toBe(true);
    const b = (await s.api('GET', '/plant/profiles/meter-b700')) as PlantProfileDetail;
    expect(b.extends).toBe('meter-base');
    expect(b.own.interfaceOverrides[0]).toMatchObject({ interface: 'meter', protocol: 'opc_ua', defaultPort: 4840 });
    expect(b.interfaces[0]).toMatchObject({ id: 'meter', protocol: 'opc_ua' });
    expect(b.interfaces[0]!.groups[0]!.dataPoints.find((d) => d.id === 'energy_total')).toMatchObject({ unit: 'W.h', address: 'ns=2;s=Meter.ActiveEnergy' });
    const a = (await s.api('GET', '/plant/profiles/meter-a100')) as PlantProfileDetail;
    expect(a.interfaces[0]).toMatchObject({ id: 'meter', protocol: 'modbus_tcp' });
    expect(await models(['north-meter-a', 'north-meter-b'], {})).toBe(before);
    // a KPI input that names the base reads both meters, across protocols
    await s.api('POST', '/plant/kpis', { id: 'energy-base', name: 'Energy (base)', inputs: [{ profile: 'meter-base', dataPoints: ['energy_total'] }] });
    const k = (await s.api('GET', '/plant/kpis/energy-base')) as PlantKpiDetail;
    expect(k.candidates.map((c) => c.id)).toEqual(['north-meter-a', 'north-meter-b']);
    expect(k.candidateInfo!['north-meter-b']!.units).toEqual([{ point: 'energy_total', expected: 'kW.h', actual: 'W.h', relation: 'convertible' }]);
  });
});
