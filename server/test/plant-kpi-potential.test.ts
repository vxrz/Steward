import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  unitRelation,
  type PlantAssignmentView,
  type PlantCoverage,
  type PlantExtractCandidates,
  type PlantExtractPreview,
  type PlantKpiDetail,
  type PlantProfileDetail,
  type PlantProfileSummary,
} from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The plant registry, 0.12.0: KPI potential and the work around shared device profiles – the unit check of KPI inputs
 * (kpi_unit_mismatch), template profiles (no asset may have one), extracting a base profile from two or more profiles
 * (the models of every asset stay as they are) and the "could have it" cells split into collected and not collected.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string; params?: Record<string, unknown> }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string; params?: Record<string, unknown> } }) => ({ status: e.status, code: e.body?.code, params: e.body?.params }),
  );
const file = (name: string, content: object) => ({ name, content: YAML.stringify(content) });

/** Two power meters of a made-up vendor: largely the same quantities, partly other ids, addresses and units. */
const A100 = {
  id: 'meter-a100',
  name: 'Meter A100',
  manufacturer: 'Example Meters',
  model: 'A100',
  category: 'Power meter',
  interfaces: [
    {
      id: 'modbus',
      name: 'Modbus/TCP',
      protocol: 'modbus_tcp',
      defaultPort: 502,
      groups: [
        {
          name: 'Energy',
          description: 'Counters',
          dataPoints: [
            { id: 'energy_total', name: 'Active energy', dataType: 'Float', unit: 'kWh', address: 'holding:100,2', aliases: ['EnergyTotal'] },
            { id: 'power', name: 'Active power', dataType: 'Float', unit: 'kW', address: 'holding:110,2' },
          ],
        },
        { name: 'Voltages', dataPoints: [{ id: 'voltage_l1', name: 'Voltage L1', dataType: 'Float', unit: 'V', address: 'input:0,2' }] },
      ],
    },
    { id: 'web', name: 'Web UI', protocol: 'http', groups: [] },
  ],
};
const A300 = {
  id: 'meter-a300',
  name: 'Meter A300',
  manufacturer: 'Example Meters',
  model: 'A300',
  category: 'Power meter',
  interfaces: [
    {
      id: 'mb',
      name: 'Modbus TCP server',
      protocol: 'modbus_tcp',
      defaultPort: 502,
      groups: [
        {
          name: 'Energy',
          description: 'Counters',
          dataPoints: [
            { id: 'e_import', name: 'Active energy', dataType: 'Float', unit: 'Wh', address: 'holding:4000,2', aliases: ['EnergyTotal'] },
            { id: 'power', name: 'Active power', dataType: 'Float', unit: 'kW', address: 'holding:4010,2' },
            { id: 'reactive_energy', name: 'Reactive energy', dataType: 'Float', address: 'holding:4020,2' },
          ],
        },
        { name: 'Voltages', dataPoints: [{ id: 'voltage_l1', name: 'Voltage L1', dataType: 'Float', unit: 'V', address: 'input:10,2' }] },
      ],
      fileSets: [],
    },
    {
      id: 'opc',
      name: 'OPC UA',
      protocol: 'opc_ua',
      groups: [{ name: 'Energy', dataPoints: [{ id: 'temp', name: 'Temperature', unit: 'Cel', address: 'ns=2;s=Temp' }] }],
    },
  ],
};

const assign = (assetId: string, profileId: string, iface: string) =>
  s.api('PUT', `/plant/assets/${assetId}/assignment`, { profileId, interfaces: [{ interface: iface, active: true, endpoint: '10.0.0.1:502' }] });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'east', name: 'East works' });
  for (const id of ['east-meter-1', 'east-meter-2', 'east-meter-3', 'east-mill']) await s.api('POST', '/plant/assets', { id, siteId: 'east', name: id });
  await s.api('POST', '/plant/profiles', A100);
  await s.api('POST', '/plant/profiles', A300);
  await assign('east-meter-1', 'meter-a100', 'modbus');
  await assign('east-meter-2', 'meter-a300', 'mb');
  await assign('east-meter-3', 'meter-a300', 'mb');
  // an asset unit override, a data collection that maps the energy counter
  await s.api('PUT', '/plant/assets/east-meter-3/assignment', {
    profileId: 'meter-a300',
    interfaces: [{ interface: 'mb', active: true, endpoint: '10.0.0.3:502' }],
    overrides: [{ dataPoint: 'power', unit: 'W' }],
  });
  await s.api('POST', '/plant/assets/east-meter-2/collections', {
    id: 'etl',
    name: 'Energy ETL',
    collector: { kind: 'job', ref: 'energy-etl' },
    interfaceId: 'mb',
    items: [
      { address: 'holding:4000,2', outputName: 'EnergyTotal', dataPoint: 'e_import' },
      { address: 'holding:4010,2', outputName: 'Power', dataPoint: 'power' },
    ],
  });
  await s.api('POST', '/plant/kpis', {
    id: 'energy-a300',
    name: 'Energy per shift',
    inputs: [{ profile: 'meter-a300', dataPoints: ['e_import', 'power'], units: { e_import: 'kWh' } }],
  });
});
afterAll(async () => {
  await s?.app.close();
});

describe('units', () => {
  it('relates units: the same, convertible by a factor, or not', () => {
    expect(unitRelation('kWh', 'kW.h')).toBe('same');
    expect(unitRelation('W.h', 'kW.h')).toBe('convertible');
    expect(unitRelation('J', 'kWh')).toBe('convertible');
    expect(unitRelation('bar', 'kPa')).toBe('convertible');
    expect(unitRelation('kW', 'kW.h')).toBe('incompatible');
    expect(unitRelation('Cel', 'K')).toBe('incompatible');
    expect(unitRelation('{count}', 'V')).toBe('incompatible');
  });

  it('a KPI input states units per data point it reads (stored as UCUM codes; others are refused)', async () => {
    const k = (await s.api('GET', '/plant/kpis/energy-a300')) as PlantKpiDetail;
    expect(k.inputs[0]!.units).toEqual({ e_import: 'kW.h' });
    const bad = await status(
      s.api('POST', '/plant/kpis', { id: 'bad-units', name: 'Bad', inputs: [{ profile: 'meter-a300', dataPoints: ['power'], units: { voltage_l1: 'V' } }] }),
    );
    expect(bad).toMatchObject({ status: 400, code: 'PLANT_KPI_INVALID' });
  });

  it('flags a data point in another unit on the KPI page, in coverage and on an asset’s KPI job', async () => {
    const k = (await s.api('GET', '/plant/kpis/energy-a300')) as PlantKpiDetail;
    // both meters deliver every input; the input expects kWh, the profile says Wh: convertible, differs
    expect(k.candidates.map((c) => c.id)).toEqual(['east-meter-2', 'east-meter-3']);
    expect(k.candidateInfo!['east-meter-2']!.units).toEqual([{ point: 'e_import', expected: 'kW.h', actual: 'W.h', relation: 'convertible' }]);
    // east-meter-3 overrides power to W; the input's default is the profile's unit (kW)
    expect(k.candidateInfo!['east-meter-3']!.units.map((u) => [u.point, u.actual, u.relation])).toEqual([
      ['e_import', 'W.h', 'convertible'],
      ['power', 'W', 'convertible'],
    ]);
    const cov = (await s.api('GET', '/plant/views/coverage?kpi=energy-a300')) as PlantCoverage;
    const cell = cov.rows.find((r) => r.asset.id === 'east-meter-2')!.cells[0]!;
    expect(cell.state).toBe('could');
    expect(cell.units?.[0]).toMatchObject({ point: 'e_import', relation: 'convertible' });
    // with a job, the mismatch is a check of it (the cell: problem)
    await s.api('PUT', '/plant/assets/east-meter-2/assignment', {
      profileId: 'meter-a300',
      interfaces: [{ interface: 'mb', active: true, endpoint: '10.0.0.2:502' }],
      kpis: [{ kpi: 'energy-a300', job: 'energy-shift' }],
    });
    const view = (await s.api('GET', '/plant/assets/east-meter-2/assignment')) as PlantAssignmentView;
    expect(view.checks.map((c) => [c.code, c.params.point, c.params.relation])).toEqual([['kpi_unit_mismatch', 'e_import', 'convertible']]);
    const cov2 = (await s.api('GET', '/plant/views/coverage?kpi=energy-a300')) as PlantCoverage;
    expect(cov2.rows.find((r) => r.asset.id === 'east-meter-2')!.cells[0]!.state).toBe('problem');
    // an incompatible unit says so
    await s.api('PUT', '/plant/kpis/energy-a300', {
      name: 'Energy per shift',
      inputs: [{ profile: 'meter-a300', dataPoints: ['e_import', 'power'], units: { e_import: 'kW' } }],
    });
    const view2 = (await s.api('GET', '/plant/assets/east-meter-2/assignment')) as PlantAssignmentView;
    expect(view2.checks[0]!.params).toMatchObject({ point: 'e_import', expected: 'kW', actual: 'W.h', relation: 'incompatible' });
    // the units are right again: no check
    await s.api('PUT', '/plant/kpis/energy-a300', {
      name: 'Energy per shift',
      inputs: [{ profile: 'meter-a300', dataPoints: ['e_import', 'power'], units: { e_import: 'Wh' } }],
    });
    expect(((await s.api('GET', '/plant/assets/east-meter-2/assignment')) as PlantAssignmentView).checks).toEqual([]);
    await s.api('PUT', '/plant/assets/east-meter-2/assignment', {
      profileId: 'meter-a300',
      interfaces: [{ interface: 'mb', active: true, endpoint: '10.0.0.2:502' }],
    });
  });

  it('imports and exports the units of an input', async () => {
    const yaml = {
      version: 1,
      kpi_definitions: [
        { id: 'energy-import', name: 'Energy (import)', inputs: [{ profile: 'meter-a300', data_points: ['e_import'], units: { e_import: 'kWh' } }] },
      ],
    };
    await s.api('POST', '/plant/import', { files: [file('kpi.yaml', yaml)], mode: 'update' });
    const k = (await s.api('GET', '/plant/kpis/energy-import')) as PlantKpiDetail;
    expect(k.inputs[0]!.units).toEqual({ e_import: 'kW.h' });
    const out = String(await s.api('GET', '/plant/export?part=catalogue'));
    expect(out).toContain('e_import: kW.h');
  });
});

describe('KPI potential', () => {
  it('splits "could have it" into collected (a collection maps every input) and not collected, with totals per site and area', async () => {
    const cov = (await s.api('GET', '/plant/views/coverage?kpi=energy-a300')) as PlantCoverage;
    const cell = (id: string) => cov.rows.find((r) => r.asset.id === id)!.cells[0]!;
    expect(cell('east-meter-2')).toMatchObject({ state: 'could', collected: true });
    expect(cell('east-meter-3')).toMatchObject({ state: 'could', collected: false });
    expect(cov.totals.could).toBe(2);
    expect(cov.potential).toEqual({ ready: 1, collect: 1 });
    expect(cov.groups.find((g) => g.siteId === 'east' && g.areaId === null)).toMatchObject({ assets: 4, potential: { ready: 1, collect: 1 } });
    const k = (await s.api('GET', '/plant/kpis/energy-a300')) as PlantKpiDetail;
    expect(k.candidateInfo!['east-meter-2']!.collected).toBe(true);
    expect(k.candidateInfo!['east-meter-3']!.collected).toBe(false);
    const tiles = (await s.api('GET', '/plant/views/overview')) as { siteId: string; potential: { ready: number; collect: number } }[];
    expect(tiles.find((t) => t.siteId === 'east')!.potential.ready).toBeGreaterThanOrEqual(1);
    const view = (await s.api('GET', '/plant/assets/east-meter-2/assignment')) as PlantAssignmentView;
    expect(view.possibleKpis.find((p) => p.id === 'energy-a300')).toMatchObject({ collected: true });
  });
});

describe('template profiles', () => {
  it('cannot be assigned (assignment, bulk, import) and cannot become one while assets have it', async () => {
    await s.api('POST', '/plant/profiles', { id: 'meter-template', name: 'Meter template', template: true });
    const list = (await s.api('GET', '/plant/profiles')) as PlantProfileSummary[];
    expect(list.find((p) => p.id === 'meter-template')!.template).toBe(true);
    expect(await status(assign('east-mill', 'meter-template', 'modbus'))).toMatchObject({ status: 400, code: 'PLANT_PROFILE_TEMPLATE' });
    const bulk = (await s.api('POST', '/plant/bulk', {
      kind: 'asset',
      action: 'edit',
      items: [{ id: 'east-mill' }],
      set: { profileId: 'meter-template' },
    })) as {
      items: { outcome: string; reason?: { code: string } }[];
    };
    expect(bulk.items[0]).toMatchObject({ outcome: 'refused', reason: { code: 'PLANT_PROFILE_TEMPLATE' } });
    const prev = (await s.api('POST', '/plant/import/preview', {
      files: [file('a.yaml', { version: 1, assignments: [{ asset: 'east-mill', profile: 'meter-template' }] })],
      mode: 'update',
    })) as { problems: { message: string }[] };
    expect(prev.problems.map((p) => p.message).join(' ')).toContain('is a template');
    // a profile assets have does not become a template
    const refused = await status(s.api('PUT', '/plant/profiles/meter-a100', { ...A100, id: undefined, template: true }));
    expect(refused).toMatchObject({ status: 409, code: 'PLANT_PROFILE_TEMPLATE_IN_USE', params: { count: 1 } });
    const imp = (await s.api('POST', '/plant/import/preview', {
      files: [file('p.yaml', { version: 1, device_profiles: [{ id: 'meter-a100', name: 'Meter A100', template: true }] })],
      mode: 'update',
    })) as { problems: { message: string }[] };
    expect(imp.problems.map((p) => p.message).join(' ')).toContain('is a template, but assets have it');
    // the export writes the flag
    const out = String(await s.api('GET', '/plant/export?part=catalogue'));
    expect(out).toMatch(/id: meter-template\n\s+name: Meter template\n\s+template: true/);
  });
});

describe('extracting a base profile', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    id: 'meter-a-base',
    name: 'Meter A series',
    leading: 'meter-a100',
    profiles: ['meter-a100', 'meter-a300'],
    points: [
      { id: 'energy_total', from: { 'meter-a100': 'energy_total', 'meter-a300': 'e_import' } },
      { id: 'power', from: { 'meter-a100': 'power', 'meter-a300': 'power' } },
      { id: 'voltage_l1', from: { 'meter-a100': 'voltage_l1', 'meter-a300': 'voltage_l1' } },
    ],
    ...over,
  });
  const models = async () => {
    const out: Record<string, unknown> = {};
    for (const id of ['east-meter-1', 'east-meter-2', 'east-meter-3']) {
      const v = (await s.api('GET', `/plant/assets/${id}/assignment`)) as PlantAssignmentView;
      const sorted = v.model
        .map((i) => ({
          ...i,
          groups: i.groups
            .map((g) => ({ ...g, dataPoints: [...g.dataPoints].sort((a, b) => a.id.localeCompare(b.id)) }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      out[id] = sorted;
    }
    return out;
  };

  it('suggests matches by id, known-as name, name and unit', async () => {
    const c = (await s.api('POST', '/plant/profiles/extract-base/candidates', {
      profiles: ['meter-a100', 'meter-a300'],
      leading: 'meter-a100',
    })) as PlantExtractCandidates;
    const m = (id: string) => c.points.find((p) => p.id === id)!.matches['meter-a300'];
    expect(m('energy_total')).toMatchObject({ id: 'e_import', by: ['known_as', 'name'] });
    expect(m('power')).toMatchObject({ id: 'power', by: ['id', 'name', 'unit'] });
    expect(m('voltage_l1')!.id).toBe('voltage_l1');
    expect(c.profiles.map((p) => [p.id, p.assets])).toEqual([
      ['meter-a100', 1],
      ['meter-a300', 2],
    ]);
  });

  it('refuses what a base cannot hold: an interface split differently, another group, a profile with a base, a taken id', async () => {
    const p = (await s.api(
      'POST',
      '/plant/profiles/extract-base/preview',
      input({
        points: [
          { id: 'energy_total', from: { 'meter-a100': 'energy_total', 'meter-a300': 'e_import' } },
          { id: 'temp', from: { 'meter-a100': 'power', 'meter-a300': 'temp' } },
          { id: 'voltage', from: { 'meter-a100': 'voltage_l1', 'meter-a300': 'power' } },
        ],
      }),
    )) as PlantExtractPreview;
    expect(p.ok).toBe(false);
    // 0.13: another protocol is no refusal any more – but the A300's OPC UA interface is not the one its energy is on
    expect(p.points.map((x) => x.problem?.code ?? null)).toEqual([null, 'interface', 'group']);
    const taken = (await s.api('POST', '/plant/profiles/extract-base/preview', input({ id: 'meter-a300' }))) as PlantExtractPreview;
    expect(taken.problems[0]!.code).toBe('base_taken');
    const one = await status(s.api('POST', '/plant/profiles/extract-base/preview', input({ profiles: ['meter-a100'] })));
    expect(one.status).toBe(400);
    await s.api('POST', '/plant/profiles', { id: 'meter-a100-special', name: 'Meter A100 special', extends: 'meter-a100' });
    const based = (await s.api(
      'POST',
      '/plant/profiles/extract-base/preview',
      input({ profiles: ['meter-a100', 'meter-a100-special'], points: [{ id: 'power', from: { 'meter-a100': 'power', 'meter-a100-special': 'power' } }] }),
    )) as PlantExtractPreview;
    expect(based.problems[0]).toMatchObject({ code: 'has_base', params: { profile: 'meter-a100-special' } });
    // nothing changed by a preview
    expect(((await s.api('GET', '/plant/profiles/meter-a300')) as PlantProfileDetail).extends).toBeNull();
    const refused = await status(s.api('POST', '/plant/profiles/extract-base', input({ id: 'meter-a300' })));
    expect(refused).toMatchObject({ status: 409, code: 'PLANT_EXTRACT_REFUSED' });
  });

  it('previews, then extracts in one transaction: renames, base, overrides – every asset model unchanged', async () => {
    // a KPI and a collection name the id that is renamed
    const before = await models();
    const p = (await s.api('POST', '/plant/profiles/extract-base/preview', input())) as PlantExtractPreview;
    expect(p.ok).toBe(true);
    expect(p.base.template).toBe(true);
    expect(p.base.interfaces.map((i) => [i.id, i.groups.map((g) => [g.name, g.description, g.dataPoints.map((d) => d.id)])])).toEqual([
      [
        'modbus',
        [
          ['Energy', 'Counters', ['energy_total', 'power']],
          ['Voltages', '', ['voltage_l1']],
        ],
      ],
    ]);
    const a300 = p.profiles.find((x) => x.id === 'meter-a300')!;
    expect(a300.renames.map((r) => [r.kind, r.from, r.to])).toEqual([
      ['interface', 'mb', 'modbus'],
      ['data_point', 'e_import', 'energy_total'],
    ]);
    expect(a300.pointOverrides.find((o) => o.dataPoint === 'energy_total')!.fields).toEqual(['unit', 'address']);
    expect(a300.interfaceOverrides[0]).toMatchObject({ interface: 'modbus', fields: ['name', 'dataPoints'] });

    const done = (await s.api('POST', '/plant/profiles/extract-base', input())) as PlantExtractPreview;
    expect(done.ok).toBe(true);
    const base = (await s.api('GET', '/plant/profiles/meter-a-base')) as PlantProfileDetail;
    expect(base).toMatchObject({ template: true, manufacturer: 'Example Meters', model: '', extendedBy: [{ id: 'meter-a100' }, { id: 'meter-a300' }] });
    const energy = base.interfaces[0]!.groups[0]!.dataPoints[0]!;
    // the leading profile's name, unit and type; the address only where every profile agrees
    expect(energy).toMatchObject({ id: 'energy_total', name: 'Active energy', unit: 'kW.h', address: '', aliases: ['EnergyTotal'] });
    const d300 = (await s.api('GET', '/plant/profiles/meter-a300')) as PlantProfileDetail;
    expect(d300.extends).toBe('meter-a-base');
    expect(d300.own.pointOverrides.find((o) => o.dataPoint === 'energy_total')).toEqual({
      dataPoint: 'energy_total',
      present: true,
      unit: 'W.h',
      address: 'holding:4000,2',
    });
    expect(d300.own.interfaces.map((i) => i.id)).toEqual(['opc']);
    // every asset's model is the one it had (ids renamed as mapped)
    const after = await models();
    expect(JSON.stringify(after).replaceAll('"mb"', '"modbus"')).toBe(
      JSON.stringify(before).replaceAll('"mb"', '"modbus"').replaceAll('"e_import"', '"energy_total"'),
    );
    expect(JSON.stringify(after)).not.toContain('e_import');
    // the references followed: the assignment's interface, the collection, the KPI input (and its units)
    const v2 = (await s.api('GET', '/plant/assets/east-meter-2/assignment')) as PlantAssignmentView;
    expect(v2.assignment!.interfaces[0]!.interface).toBe('modbus');
    const coll = (await s.api('GET', '/plant/assets/east-meter-2/collections/etl')) as { items: { dataPoint: string | null }[]; interfaceId: string };
    expect(coll.items.map((i) => i.dataPoint)).toEqual(['energy_total', 'power']);
    expect(coll.interfaceId).toBe('modbus');
    const k = (await s.api('GET', '/plant/kpis/energy-a300')) as PlantKpiDetail;
    expect(k.inputs[0]).toMatchObject({ dataPoints: ['energy_total', 'power'], units: { energy_total: 'W.h' } });
    // the old id stays an alias of the data point (an import that names it reaches the new one)
    const { db } = await import('../src/db.js');
    expect(
      db().get<{ new_id: string }>("SELECT new_id FROM plant_id_aliases WHERE kind = 'data_point' AND scope = 'meter-a300' AND old_id = 'e_import'")?.new_id,
    ).toBe('energy_total');
    // a KPI reading the base reads both; its unit default is the base's (kWh): the A300 delivers Wh (convertible)
    await s.api('POST', '/plant/kpis', { id: 'energy-any', name: 'Energy (any meter)', inputs: [{ profile: 'meter-a-base', dataPoints: ['energy_total'] }] });
    const any = (await s.api('GET', '/plant/kpis/energy-any')) as PlantKpiDetail;
    expect(any.candidates.map((c) => c.id)).toEqual(['east-meter-1', 'east-meter-2', 'east-meter-3']);
    expect(any.candidateInfo!['east-meter-1']!.units).toEqual([]);
    expect(any.candidateInfo!['east-meter-2']!.units).toEqual([{ point: 'energy_total', expected: 'kW.h', actual: 'W.h', relation: 'convertible' }]);
    // audited
    const audit = (await s.api('GET', '/audit?action=device_profile.base_extracted')) as { entityId: string }[];
    expect(audit[0]!.entityId).toBe('meter-a-base');
    // the base is a template: no asset may have it
    expect(await status(assign('east-mill', 'meter-a-base', 'modbus'))).toMatchObject({ code: 'PLANT_PROFILE_TEMPLATE' });
  });
});
