import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type {
  PlantAssignmentView,
  PlantCoverage,
  PlantDataPointDetail,
  PlantExtractPreview,
  PlantKpiDetail,
  PlantProfileDetail,
  PlantSiteTile,
} from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The plant registry, 0.13: KPI potential across profiles and parts – base profiles across protocols (an inherited
 * interface of protocol "other" gets its protocol in the profile that extends it; extracting a base no longer refuses
 * interfaces of different protocols, and every asset's model stays as it was), KPI inputs of "any of these profiles"
 * with a data point mapping per profile, and KPI potential and coverage rolled up from parts to the machine they belong
 * to (opt-in per KPI definition).
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

describe('KPI inputs of any of several profiles, with a mapping', () => {
  /** Two models that cannot share a base: other ids, another unit. */
  const C1 = {
    id: 'meter-c1',
    name: 'Meter C1',
    interfaces: [
      {
        id: 'mqtt',
        protocol: 'mqtt',
        groups: [{ name: '', dataPoints: [{ id: 'e_total', name: 'Energy', unit: 'kWh', address: 'c1/energy' }] }],
      },
    ],
  };
  const D2 = {
    id: 'meter-d2',
    name: 'Meter D2',
    interfaces: [
      {
        id: 'opc',
        protocol: 'opc_ua',
        groups: [
          {
            name: '',
            dataPoints: [
              { id: 'EnergyImport', name: 'Energy import', unit: 'Wh', address: 'ns=2;s=EnergyImport' },
              { id: 'Spare', name: 'Spare', address: 'ns=2;s=Spare' },
            ],
          },
        ],
      },
    ],
  };
  const KPI = {
    id: 'energy-any',
    name: 'Energy (any meter)',
    inputs: [{ profiles: ['meter-c1', 'meter-d2'], dataPoints: ['e_total'], mapping: { 'meter-d2': { e_total: 'EnergyImport' } } }],
  };

  beforeAll(async () => {
    await s.api('POST', '/plant/profiles', C1);
    await s.api('POST', '/plant/profiles', D2);
    for (const id of ['north-c1', 'north-d2', 'north-d2-off', 'north-other'])
      await s.api('POST', '/plant/assets', { id, siteId: 'north', name: id.replace('north-', 'North ') });
    await assign('north-c1', 'meter-c1', 'mqtt');
    await assign('north-d2', 'meter-d2', 'opc');
    await assign('north-d2-off', 'meter-d2', 'opc', { overrides: [{ dataPoint: 'EnergyImport', available: false }] });
    await assign('north-other', 'meter-a100', 'meter');
  });

  it('stores profiles and mapping (profile: the first) and refuses a mapping the profiles cannot follow', async () => {
    await s.api('POST', '/plant/kpis', KPI);
    const k = (await s.api('GET', '/plant/kpis/energy-any')) as PlantKpiDetail;
    expect(k.inputs[0]).toMatchObject({ profile: 'meter-c1', profiles: ['meter-c1', 'meter-d2'], mapping: { 'meter-d2': { e_total: 'EnergyImport' } } });
    expect(k.profiles).toEqual(['meter-c1', 'meter-d2']);
    expect(k.profileNames).toEqual({ 'meter-c1': 'Meter C1', 'meter-d2': 'Meter D2' });
    expect(k.checks).toEqual([]);
    const bad = (over: Record<string, unknown>) => status(s.api('POST', '/plant/kpis', { id: 'bad', name: 'Bad', inputs: [{ ...KPI.inputs[0], ...over }] }));
    // a data point the profile lacks
    const lacks = await bad({ mapping: { 'meter-d2': { e_total: 'Nope' } } });
    expect(lacks).toMatchObject({ status: 400, code: 'PLANT_KPI_INVALID' });
    expect(lacks.message).toContain('Profile "Meter D2" has no data point "Nope"');
    // a profile the input does not name; a data point it does not read; a profile not among profiles; two read one
    expect((await bad({ mapping: { 'meter-a100': { e_total: 'power' } } })).message).toContain('which the input does not name');
    expect((await bad({ mapping: { 'meter-d2': { power: 'EnergyImport' } } })).message).toContain('the input does not read it');
    expect((await bad({ profile: 'meter-a100' })).message).toContain('is not one of the input');
    expect((await bad({ dataPoints: ['e_total', 'Spare'], mapping: { 'meter-d2': { e_total: 'Spare' } } })).message).toContain(
      'both read its data point "Spare"',
    );
    // one profile only: written as `profile`, no `profiles`
    await s.api('POST', '/plant/kpis', { id: 'energy-one', name: 'Energy (one)', inputs: [{ profiles: ['meter-d2'], dataPoints: ['EnergyImport'] }] });
    const one = (await s.api('GET', '/plant/kpis/energy-one')) as PlantKpiDetail;
    expect(one.inputs[0]!.profile).toBe('meter-d2');
    expect(one.inputs[0]!.profiles).toBeUndefined();
  });

  it('reads each asset through its profile and the mapping: candidates, gaps, units, collected', async () => {
    const k = (await s.api('GET', '/plant/kpis/energy-any')) as PlantKpiDetail;
    expect(k.candidates.map((c) => c.id)).toEqual(['north-c1', 'north-d2']);
    // the expected unit is the first profile's (kWh): the D2 delivers Wh
    expect(k.candidateInfo!['north-c1']!.units).toEqual([]);
    expect(k.candidateInfo!['north-d2']!.units).toEqual([
      { point: 'EnergyImport', input: 'e_total', expected: 'kW.h', actual: 'W.h', relation: 'convertible' },
    ]);
    const cov = (await s.api('GET', '/plant/views/coverage?kpi=energy-any')) as PlantCoverage;
    const cell = (id: string) => cov.rows.find((r) => r.asset.id === id)!.cells[0]!;
    expect(cell('north-d2')).toMatchObject({ state: 'could', collected: false });
    expect(cell('north-d2-off')).toMatchObject({ state: 'cannot', gaps: [{ code: 'kpi_point_unavailable', params: { point: 'EnergyImport' } }] });
    expect(cell('north-other')).toMatchObject({ state: 'cannot', gaps: [{ code: 'kpi_other_profile', params: { profile: 'meter-c1, meter-d2' } }] });
    // a collection that maps the D2's data point: collected
    await s.api('POST', '/plant/assets/north-d2/collections', {
      id: 'gw',
      name: 'Gateway',
      collector: { kind: 'job', ref: 'energy-etl' },
      interfaceId: 'opc',
      items: [{ address: 'ns=2;s=EnergyImport', outputName: 'Energy', dataPoint: 'EnergyImport' }],
    });
    expect(((await s.api('GET', '/plant/kpis/energy-any')) as PlantKpiDetail).candidateInfo!['north-d2']!.collected).toBe(true);
    // a job on the D2: its unit check names the asset's data point
    await assign('north-d2', 'meter-d2', 'opc', { kpis: [{ kpi: 'energy-any', job: 'north-d2-energy' }] });
    const v = (await s.api('GET', '/plant/assets/north-d2/assignment')) as PlantAssignmentView;
    expect(v.checks.map((c) => [c.code, c.params.point])).toEqual([['kpi_unit_mismatch', 'EnergyImport']]);
    // with the input's own unit for it, nothing differs
    await s.api('PUT', '/plant/kpis/energy-any', { ...KPI, id: undefined, inputs: [{ ...KPI.inputs[0], units: { e_total: 'Wh' } }] });
    expect(((await s.api('GET', '/plant/assets/north-d2/assignment')) as PlantAssignmentView).checks).toEqual([]);
    await s.api('PUT', '/plant/kpis/energy-any', { ...KPI, id: undefined });
    // the data point pages and the profile page name the KPI
    const d = (await s.api('GET', '/plant/profiles/meter-d2/points/EnergyImport')) as PlantDataPointDetail;
    expect(d.kpis.map((x) => x.id)).toContain('energy-any');
    const p = (await s.api('GET', '/plant/profiles/meter-d2')) as PlantProfileDetail;
    expect(p.kpis.find((x) => x.id === 'energy-any')!.dataPoints).toEqual(['EnergyImport']);
  });

  it('imports and exports profiles and mapping (an unknown data point is a problem)', async () => {
    const yaml = {
      version: 1,
      kpi_definitions: [
        {
          id: 'energy-file',
          name: 'Energy (file)',
          inputs: [{ profiles: ['meter-c1', 'meter-d2'], data_points: ['e_total'], mapping: { 'meter-d2': { e_total: 'EnergyImport' } } }],
        },
      ],
    };
    const prev = (await s.api('POST', '/plant/import/preview', { files: [file('k.yaml', yaml)], mode: 'update' })) as { problems: unknown[] };
    expect(prev.problems).toEqual([]);
    await s.api('POST', '/plant/import', { files: [file('k.yaml', yaml)], mode: 'update' });
    const k = (await s.api('GET', '/plant/kpis/energy-file')) as PlantKpiDetail;
    expect(k.inputs[0]).toMatchObject({ profile: 'meter-c1', profiles: ['meter-c1', 'meter-d2'], mapping: { 'meter-d2': { e_total: 'EnergyImport' } } });
    const out = String(await s.api('GET', '/plant/export?part=catalogue'));
    const exported = (YAML.parseAllDocuments(out).map((d) => d.toJSON()) as { kpi_definitions?: { id: string; inputs: unknown[] }[] }[])
      .flatMap((d) => d.kpi_definitions ?? [])
      .find((x) => x.id === 'energy-file')!;
    expect(exported.inputs).toEqual([{ profiles: ['meter-c1', 'meter-d2'], data_points: ['e_total'], mapping: { 'meter-d2': { e_total: 'EnergyImport' } } }]);
    // the export imports back unchanged
    const again = (await s.api('POST', '/plant/import/preview', {
      files: [file('out.yaml', YAML.parse(YAML.stringify({ version: 1, kpi_definitions: [exported] })))],
      mode: 'update',
    })) as {
      problems: unknown[];
      summary: { kpis: { changed: number } };
    };
    expect(again.problems).toEqual([]);
    const wrong = (await s.api('POST', '/plant/import/preview', {
      files: [
        file('w.yaml', {
          version: 1,
          kpi_definitions: [
            {
              ...yaml.kpi_definitions[0],
              mapping: undefined,
              inputs: [{ ...yaml.kpi_definitions[0]!.inputs[0], mapping: { 'meter-d2': { e_total: 'Gone' } } }],
            },
          ],
        }),
      ],
      mode: 'update',
    })) as { problems: { path: string; message: string }[] };
    expect(wrong.problems[0]).toMatchObject({ path: 'kpi_definitions[0].inputs[0].mapping.meter-d2.e_total' });
    expect(wrong.problems[0]!.message).toContain('has no data point "Gone"');
  });

  it('follows renames: a mapped data point, a profile, and a data point of one profile while the others keep the id', async () => {
    const rename = (kind: string, id: string, newId: string, scope = '') => s.api('POST', '/plant/ids/rename', { kind, scope, id, newId });
    await rename('data_point', 'EnergyImport', 'energy_import', 'meter-d2');
    let k = (await s.api('GET', '/plant/kpis/energy-any')) as PlantKpiDetail;
    expect(k.inputs[0]!.mapping).toEqual({ 'meter-d2': { e_total: 'energy_import' } });
    await rename('profile', 'meter-d2', 'meter-d2x');
    k = (await s.api('GET', '/plant/kpis/energy-any')) as PlantKpiDetail;
    expect(k.inputs[0]).toMatchObject({ profiles: ['meter-c1', 'meter-d2x'], mapping: { 'meter-d2x': { e_total: 'energy_import' } } });
    // the C1's e_total renamed: the input keeps its id, the C1 gets a mapping
    await rename('data_point', 'e_total', 'energy', 'meter-c1');
    k = (await s.api('GET', '/plant/kpis/energy-any')) as PlantKpiDetail;
    expect(k.inputs[0]).toMatchObject({ dataPoints: ['e_total'], mapping: { 'meter-c1': { e_total: 'energy' }, 'meter-d2x': { e_total: 'energy_import' } } });
    expect(k.checks).toEqual([]);
    expect(k.candidates.map((c) => c.id)).toEqual(['north-c1']);
    expect(k.instances.map((x) => x.asset.id)).toEqual(['north-d2']);
  });
});

describe('KPI potential rolled up from parts', () => {
  const inputs = [
    { profiles: ['meter-c1', 'meter-d2x'], dataPoints: ['e_total'], mapping: { 'meter-c1': { e_total: 'energy' }, 'meter-d2x': { e_total: 'energy_import' } } },
  ];

  beforeAll(async () => {
    // two machines without a device profile; a meter is part of each
    await s.api('POST', '/plant/assets', { id: 'north-press', siteId: 'north', name: 'North press' });
    await s.api('POST', '/plant/assets', { id: 'north-oven', siteId: 'north', name: 'North oven' });
    await s.api('POST', '/plant/assets', { id: 'north-press-meter', siteId: 'north', name: 'North press meter', parentId: 'north-press' });
    await s.api('POST', '/plant/assets', { id: 'north-oven-meter', siteId: 'north', name: 'North oven meter', parentId: 'north-oven' });
    await assign('north-press-meter', 'meter-c1', 'mqtt');
    await assign('north-oven-meter', 'meter-d2x', 'opc');
    await s.api('POST', '/plant/kpis', { id: 'machine-plain', name: 'Machine energy (no roll-up)', inputs });
    await s.api('POST', '/plant/kpis', { id: 'machine-energy', name: 'Machine energy', rollUp: 'parts', inputs });
  });
  const coverage = async () => {
    const cov = (await s.api('GET', '/plant/views/coverage?site=north')) as PlantCoverage;
    const at = (kpi: string) => cov.kpis.findIndex((k) => k.id === kpi);
    return { cov, cell: (asset: string, kpi: string) => cov.rows.find((r) => r.asset.id === asset)!.cells[at(kpi)]! };
  };

  it('is off by default: a machine whose part delivers the inputs cannot have the KPI itself', async () => {
    const k = (await s.api('GET', '/plant/kpis/machine-plain')) as PlantKpiDetail;
    expect(k.rollUp).toBe('none');
    const { cell } = await coverage();
    expect(cell('north-press', 'machine-plain')).toMatchObject({ state: 'cannot' });
    expect(cell('north-press', 'machine-plain').via).toBeUndefined();
    expect(cell('north-press-meter', 'machine-plain')).toMatchObject({ state: 'could' });
    expect(cell('north-press-meter', 'machine-plain').rolledUp).toBeUndefined();
  });

  it('counts the part for the machine, once: coverage cells, totals per site, site tiles', async () => {
    const one = await coverage();
    expect(one.cell('north-press', 'machine-energy')).toMatchObject({
      state: 'could',
      collected: false,
      via: { id: 'north-press-meter', name: 'North press meter' },
    });
    expect(one.cell('north-press-meter', 'machine-energy')).toMatchObject({ state: 'could', rolledUp: { id: 'north-press', name: 'North press' } });
    // the oven's meter is collected already (its collection maps the data point): the oven is ready
    await s.api('POST', '/plant/assets/north-oven-meter/collections', {
      id: 'gw',
      name: 'Gateway',
      collector: { kind: 'job', ref: 'energy-etl' },
      interfaceId: 'opc',
      items: [{ address: 'ns=2;s=EnergyImport', outputName: 'Energy', dataPoint: 'energy_import' }],
    });
    const { cov, cell } = await coverage();
    expect(cell('north-oven', 'machine-energy')).toMatchObject({ state: 'could', collected: true, via: { id: 'north-oven-meter' } });
    // per KPI: the plain one counts both meters, the rolled-up one both machines (not their meters again)
    const could = (kpi: string) =>
      cov.rows.filter((r) => {
        const c = r.cells[cov.kpis.findIndex((k) => k.id === kpi)]!;
        return c.state === 'could' && !c.rolledUp;
      }).length;
    expect(could('machine-plain')).toBe(could('machine-energy'));
    const plainRows = cov.rows.map((r) => r.cells[cov.kpis.findIndex((k) => k.id === 'machine-plain')]!).filter((c) => c.state === 'could').length;
    const rolledRows = cov.rows.map((r) => r.cells[cov.kpis.findIndex((k) => k.id === 'machine-energy')]!).filter((c) => c.state === 'could').length;
    expect(rolledRows).toBe(plainRows + 2);
    // the totals: one ready and one in need of a collection more for the rolled-up KPI (the machines), not four
    const only = (await s.api('GET', '/plant/views/coverage?site=north&kpi=machine-energy')) as PlantCoverage;
    const plain = (await s.api('GET', '/plant/views/coverage?site=north&kpi=machine-plain')) as PlantCoverage;
    expect(only.totals.could).toBe(plain.totals.could);
    expect(only.potential).toEqual(plain.potential);
    expect(only.groups.find((g) => g.siteId === 'north' && g.areaId === null)!.potential).toEqual(only.potential);
    // the site tile counts the same as the coverage of the site
    const tiles = (await s.api('GET', '/plant/views/overview')) as PlantSiteTile[];
    const t = tiles.find((x) => x.siteId === 'north')!;
    expect(t.coverage).toEqual(cov.totals);
    expect(t.potential).toEqual(cov.potential);
  });

  it('a job on the part: the machine has the KPI through it', async () => {
    await assign('north-press-meter', 'meter-c1', 'mqtt', { kpis: [{ kpi: 'machine-energy', job: 'press-energy' }] });
    const { cell } = await coverage();
    expect(cell('north-press', 'machine-energy')).toMatchObject({ state: 'has', jobs: ['press-energy'], via: { id: 'north-press-meter' } });
    expect(cell('north-press-meter', 'machine-energy')).toMatchObject({ state: 'has', rolledUp: { id: 'north-press' } });
    const only = (await s.api('GET', '/plant/views/coverage?site=north&kpi=machine-energy')) as PlantCoverage;
    expect(only.totals.has).toBe(1);
    await assign('north-press-meter', 'meter-c1', 'mqtt');
  });

  it('lists the machine with its part on the asset page and the KPI page; the file format has roll_up', async () => {
    const v = (await s.api('GET', '/plant/assets/north-oven/assignment')) as PlantAssignmentView;
    expect(v.possibleKpis.map((p) => [p.id, p.via?.id, p.collected])).toEqual([['machine-energy', 'north-oven-meter', true]]);
    const k = (await s.api('GET', '/plant/kpis/machine-energy')) as PlantKpiDetail;
    expect(k.candidates.map((c) => c.id)).toEqual(['north-c1', 'north-d2', 'north-oven', 'north-oven-meter', 'north-press', 'north-press-meter']);
    expect(k.candidateInfo!['north-oven']).toMatchObject({ collected: true, via: { id: 'north-oven-meter', name: 'North oven meter' } });
    expect(((await s.api('GET', '/plant/kpis/machine-plain')) as PlantKpiDetail).candidates.map((c) => c.id)).not.toContain('north-oven');
    const out = String(await s.api('GET', '/plant/export?part=catalogue'));
    expect(out).toMatch(/id: machine-energy\n\s+name: Machine energy\n\s+roll_up: parts/);
    const yaml = {
      version: 1,
      kpi_definitions: [
        {
          id: 'machine-file',
          name: 'Machine (file)',
          roll_up: 'parts',
          inputs: [{ profiles: inputs[0]!.profiles, data_points: ['e_total'], mapping: inputs[0]!.mapping }],
        },
      ],
    };
    const pv = (await s.api('POST', '/plant/import/preview', { files: [file('m.yaml', yaml)], mode: 'update' })) as { problems: unknown[] };
    expect(pv.problems).toEqual([]);
    await s.api('POST', '/plant/import', { files: [file('m.yaml', yaml)], mode: 'update' });
    expect(((await s.api('GET', '/plant/kpis/machine-file')) as PlantKpiDetail).rollUp).toBe('parts');
  });
});
