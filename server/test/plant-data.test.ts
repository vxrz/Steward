import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The plant registry, part 2 (#219): device profiles (interfaces, data points – OPC UA NodeIds, Modbus addresses,
 * data types, UCUM units), KPI definitions, an asset's assignment and KPI instances, what Steward checks, the search
 * ("which assets deliver data point X", "which KPIs can this asset have"), the rights (catalogues of the installation,
 * assignments follow the asset's site; hidden sites stay hidden; the Plant viewer), the YAML import and export with
 * their modes and the read endpoints of the public API.
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
    (e: { status: number; body?: { code?: string; error?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const file = (name: string, content: string | object) => ({ name, content: typeof content === 'string' ? content : YAML.stringify(content) });
const codes = (checks: { code: string }[]) => checks.map((c) => c.code).sort();
const enable = (enabled = true) => s.api('PUT', '/settings/plant', { enabled, enterprise: 'Brightwater Components', labels: {}, fields: {} });

/** A profile of an invented device with two interfaces. */
const PROFILE: { id: string; interfaces: { id: string; groups: { name: string; dataPoints: Record<string, any>[] }[]; [k: string]: any }[]; [k: string]: any } =
  {
    id: 'example-drives-x1',
    name: 'Example Drives X1 drive controller',
    manufacturer: 'Example Drives',
    model: 'X1',
    version: '2.x',
    category: 'Drive controller',
    interfaces: [
      {
        id: 'opc',
        name: 'OPC UA',
        protocol: 'opc_ua',
        defaultPort: 4840,
        groups: [
          {
            name: 'State',
            dataPoints: [
              { id: 'run_state', name: 'Run state', dataType: 'int', address: 'ns=3;s=Drive.State', enumValues: ['off', 'on'] },
              { id: 'speed', name: 'Speed', dataType: 'float[]', unit: 'rpm', address: 'ns=3;i=1001', updateRateMs: 500 },
            ],
          },
        ],
      },
      {
        id: 'mb',
        name: 'Modbus',
        protocol: 'modbus_tcp',
        groups: [{ name: '', dataPoints: [{ id: 'energy', name: 'Energy', dataType: 'LREAL', unit: 'kWh', address: 'input:801,4' }] }],
      },
    ],
  };

const KPI = {
  id: 'drive-uptime',
  name: 'Drive uptime',
  category: 'Availability',
  unit: 's',
  trend: 'higher_is_better',
  inputs: [{ profile: 'example-drives-x1', dataPoints: ['run_state'] }],
  parameters: [
    { name: 'gap_ms', aliases: ['max_gap_ms'], type: 'integer', default: 60000, min: 1000, max: 600000 },
    { name: 'calendar', type: 'string', required: true },
  ],
  columns: [
    { name: 'up', unit: 's' },
    { name: 'total', unit: 's' },
    { name: 'up_pct', kind: 'ratio', unit: '%', numerator: 'up', denominator: 'total', scale: 100 },
  ],
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['vera', 'viewer'],
    ['pia', 'plant'],
    ['olaf', 'operator'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
});
afterAll(async () => {
  await s?.app.close();
});

describe('module switch', () => {
  it('while the module is off, every route of part 2 answers 404 PLANT_MODULE_OFF', async () => {
    for (const url of [
      '/plant/profiles',
      '/plant/kpis',
      '/plant/checks',
      '/plant/explore/points?q=x',
      '/plant/profiles/x',
      '/plant/kpis/x',
      '/plant/assets/x/assignment',
    ])
      expect(await status(s.api('GET', url)), url).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    expect(await status(s.api('POST', '/plant/profiles', PROFILE))).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    await enable();
  });
});

describe('the demo', () => {
  it('has invented device profiles, KPI definitions and assignments – one with a check problem', async () => {
    const profiles = await s.api('GET', '/plant/profiles');
    expect(profiles.map((p: { id: string }) => p.id).sort()).toEqual(['example-controls-c80', 'example-meters-pm200', 'example-plastics-mc6']);
    expect(profiles.find((p: { id: string }) => p.id === 'example-controls-c80')).toMatchObject({ assetCount: 2, protocols: ['opc_ua', 'webdav', 'http'] });
    const kpis = await s.api('GET', '/plant/kpis');
    expect(kpis.map((k: { id: string }) => k.id).sort()).toEqual(['energy-consumption', 'machine-state-time']);
    const one = await s.api('GET', '/plant/assets/rvs-mill-01/assignment');
    expect(one.profile.id).toBe('example-controls-c80');
    expect(one.checks).toEqual([]);
    expect(one.possibleKpis).toEqual([expect.objectContaining({ id: 'machine-state-time', instantiated: true })]);
    expect(one.kpis[0].results).toEqual([{ kind: 'dataset', id: 'plant.machine-state', label: 'plant.machine-state', path: null, visible: false }]);
    // the OPC UA interface of milling centre 2 is not set up yet: its KPI cannot read the program status
    const two = await s.api('GET', '/plant/assets/rvs-mill-02/assignment');
    expect(two.checks).toEqual([
      expect.objectContaining({
        code: 'kpi_interface_inactive',
        job: 'rvs-mill-02-machine-state',
        subject: { kind: 'asset', id: 'rvs-mill-02', name: 'Milling centre 2', siteId: 'riverside' },
        params: { kpi: 'Time in machine state', point: 'program_status', interface: 'OPC UA server' },
      }),
    ]);
    expect(two.possibleKpis).toEqual([]);
    const checks = await s.api('GET', '/plant/checks');
    expect(checks.map((c: { subject: { id: string }; code: string }) => `${c.subject.id}:${c.code}`)).toEqual(['rvs-mill-02:kpi_interface_inactive']);
  });
});

describe('device profiles', () => {
  it('designers add them: data types, units and addresses after OPC UA, IEC 61131-3, UCUM and Modbus; audited', async () => {
    const p = await users.dana!('POST', '/plant/profiles', PROFILE);
    const [state, speed] = p.interfaces[0].groups[0].dataPoints;
    expect(state).toMatchObject({ dataType: 'Integer', access: 'read', enumValues: ['off', 'on'] });
    expect(speed).toMatchObject({ dataType: 'Float[]', unit: '/min', updateRateMs: 500 });
    expect(p.interfaces[1].groups[0].dataPoints[0]).toMatchObject({ dataType: 'LREAL', unit: 'kW.h' });
    expect(p).toMatchObject({ dataPointCount: 3, interfaceCount: 2, protocols: ['opc_ua', 'modbus_tcp'], assetCount: 0, canManage: true });
    const log = await s.api('GET', '/audit?action=device_profile.created&limit=1');
    expect(log[0].summary).toContain('Example Drives X1 drive controller');
  });

  it('refuses what a profile may not hold: a wrong address for the protocol, an id twice, an unknown data type', async () => {
    const bad = (patch: (p: typeof PROFILE) => void) => {
      const p = structuredClone(PROFILE);
      p.id = 'example-drives-bad';
      patch(p);
      return status(users.dana!('POST', '/plant/profiles', p));
    };
    expect(await bad((p) => (p.interfaces[0]!.groups[0]!.dataPoints[0]!.address = 'Drive.State'))).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(await bad((p) => (p.interfaces[0]!.groups[0]!.dataPoints[0]!.address = 'ns=3;i=abc'))).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(await bad((p) => (p.interfaces[1]!.groups[0]!.dataPoints[0]!.address = 'register 801'))).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(await bad((p) => (p.interfaces[1]!.groups[0]!.dataPoints[0]!.id = 'run_state'))).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(await bad((p) => (p.interfaces[1]!.id = 'opc'))).toEqual({ status: 400, code: 'PLANT_PROFILE_INVALID' });
    expect(await bad((p) => (p.interfaces[0]!.groups[0]!.dataPoints[0]!.dataType = 'quaternion'))).toMatchObject({ status: 400 });
    expect(await bad((p) => (p.interfaces[0]!.groups[0]!.dataPoints[0]!.id = '__proto__'))).toMatchObject({ status: 400 });
    expect(await status(users.dana!('POST', '/plant/profiles', PROFILE))).toEqual({ status: 409, code: 'PLANT_ID_TAKEN' });
  });

  it('the catalogue is the installation’s: everyone in the registry sees it, designers and administrators manage it', async () => {
    for (const c of ['vera', 'pia', 'olaf']) {
      expect((await users[c]!('GET', '/plant/profiles/example-drives-x1')).canManage, c).toBe(false);
      const { id: _i, ...rest } = PROFILE;
      expect(await status(users[c]!('PUT', '/plant/profiles/example-drives-x1', rest)), c).toEqual({ status: 403, code: 'FORBIDDEN' });
      expect(await status(users[c]!('DELETE', '/plant/profiles/example-drives-x1')), c).toEqual({ status: 403, code: 'FORBIDDEN' });
      expect(await status(users[c]!('POST', '/plant/profiles', { ...PROFILE, id: `x-${c}` })), c).toEqual({ status: 403, code: 'FORBIDDEN' });
    }
    expect((await users.pia!('GET', '/plant/config')).canManageCatalogue).toBe(false);
    expect((await users.dana!('GET', '/plant/config')).canManageCatalogue).toBe(true);
  });

  it('a change is audited with the interfaces and data points it touches', async () => {
    const { id: _i, ...rest } = structuredClone(PROFILE);
    rest.interfaces[0]!.groups[0]!.dataPoints.push({ id: 'torque', name: 'Torque', dataType: 'Double', unit: 'N.m', address: 'ns=3;s=Drive.Torque' } as never);
    rest.interfaces[0]!.groups[0]!.dataPoints[1]!.unit = '/min';
    const p = await users.dana!('PUT', '/plant/profiles/example-drives-x1', rest);
    expect(p.dataPointCount).toBe(4);
    const [log] = await s.api('GET', '/audit?action=device_profile.updated&limit=1');
    expect(log.summary).toBe('Device profile "Example Drives X1 drive controller" changed (data points)');
    expect(log.details.dataPoints).toEqual({ added: ['torque'], removed: [], changed: [] });
  });
});

describe('KPI definitions', () => {
  it('designers add them with ISO 22400 attributes; a ratio without its denominator is a check, not an error', async () => {
    const k = await users.dana!('POST', '/plant/kpis', KPI);
    expect(k).toMatchObject({ unit: 's', trend: 'higher_is_better', parameterCount: 2, columnCount: 3, problemCount: 0, profiles: ['example-drives-x1'] });
    expect(k.profileNames).toEqual({ 'example-drives-x1': 'Example Drives X1 drive controller' });
    const { id: _i, ...rest } = structuredClone(KPI);
    rest.columns[2] = { name: 'up_pct', kind: 'ratio', unit: '%', numerator: 'up', denominator: '', scale: 100 } as never;
    rest.columns.push({ name: 'odd_ratio', kind: 'ratio', numerator: 'nothing', denominator: 'total' } as never);
    rest.inputs.push({ profile: 'example-drives-x1', dataPoints: ['no_such_point'] } as never);
    const changed = await users.dana!('PUT', '/plant/kpis/drive-uptime', rest);
    expect(codes(changed.checks)).toEqual(['input_point_unknown', 'ratio_column_unknown', 'ratio_no_denominator']);
    expect(changed.checks.find((c: { code: string }) => c.code === 'ratio_no_denominator').message).toBe(
      'Column "up_pct" is a ratio without a denominator: it cannot be combined over a longer period',
    );
    expect((await s.api('GET', '/plant/kpis')).find((x: { id: string }) => x.id === 'drive-uptime').problemCount).toBe(3);
    expect((await s.api('GET', '/plant/checks')).filter((c: { subject: { id: string } }) => c.subject.id === 'drive-uptime')).toHaveLength(3);
    const { id: _j, ...ok } = KPI;
    await users.dana!('PUT', '/plant/kpis/drive-uptime', ok);
  });

  it('refuses a parameter name twice (aliases count), a column twice, a range upside down', async () => {
    const bad = (patch: Record<string, unknown>) => status(users.dana!('POST', '/plant/kpis', { ...KPI, id: 'kpi-bad', ...patch }));
    expect(await bad({ parameters: [{ name: 'a' }, { name: 'b', aliases: ['a'] }] })).toEqual({ status: 400, code: 'PLANT_KPI_INVALID' });
    expect(await bad({ columns: [{ name: 'a' }, { name: 'a' }] })).toEqual({ status: 400, code: 'PLANT_KPI_INVALID' });
    expect(await bad({ rangeMin: 10, rangeMax: 1 })).toEqual({ status: 400, code: 'PLANT_KPI_INVALID' });
    expect(await status(users.vera!('POST', '/plant/kpis', { ...KPI, id: 'kpi-vera' }))).toEqual({ status: 403, code: 'FORBIDDEN' });
  });
});

describe('assignments and KPI instances', () => {
  const base = { profileId: 'example-drives-x1', firmware: '2.4', interfaces: [{ interface: 'opc', endpoint: 'opc.tcp://drive.example.com:4840' }] };
  const kpi = (params: Record<string, unknown>) => ({ kpi: 'drive-uptime', job: 'press-uptime', params });

  it('an asset gets a profile, endpoints, overrides, publications and KPI instances; references are checked on save', async () => {
    expect(await status(s.api('PUT', '/plant/assets/rvs-press-01/assignment', { ...base, interfaces: [{ interface: 'nope' }] }))).toEqual({
      status: 400,
      code: 'PLANT_ASSIGNMENT_INVALID',
    });
    expect(await status(s.api('PUT', '/plant/assets/rvs-press-01/assignment', { ...base, profileId: 'nope' }))).toEqual({
      status: 400,
      code: 'PLANT_ASSIGNMENT_INVALID',
    });
    expect(await status(s.api('PUT', '/plant/assets/rvs-press-01/assignment', { ...base, kpis: [{ kpi: 'nope', job: 'x' }] }))).toEqual({
      status: 400,
      code: 'PLANT_ASSIGNMENT_INVALID',
    });
    expect(
      await status(s.api('PUT', '/plant/assets/rvs-press-01/assignment', { ...base, overrides: [{ dataPoint: 'speed', address: 'not a node id' }] })),
    ).toEqual({ status: 400, code: 'PLANT_ASSIGNMENT_INVALID' });
    const a = await users.dana!('PUT', '/plant/assets/rvs-press-01/assignment', {
      ...base,
      publications: [{ dataPoint: 'run_state', target: 'iot-platform', path: 'press/state', name: 'RunState', publishedBy: 'gateway' }],
      kpis: [kpi({ calendar: 'two-shift' })],
    });
    expect(a.checks).toEqual([]);
    expect(a.possibleKpis).toEqual([expect.objectContaining({ id: 'drive-uptime', instantiated: true })]);
    const [log] = await s.api('GET', '/audit?action=asset.assignment_set&limit=1');
    expect(log.summary).toBe('Asset "Assembly press" assigned device profile example-drives-x1 with 1 KPI instances');
    // the profile names who has it
    expect((await s.api('GET', '/plant/profiles/example-drives-x1')).assets.map((x: { id: string }) => x.id)).toEqual(['rvs-press-01']);
    expect((await s.api('GET', '/plant/kpis/drive-uptime')).instances).toEqual([expect.objectContaining({ job: 'press-uptime', problems: 0 })]);
  });

  it('checks the parameters against the definition: unknown, of the wrong type, outside the range, missing, twice', async () => {
    const put = (params: Record<string, unknown>) => s.api('PUT', '/plant/assets/rvs-press-01/assignment', { ...base, kpis: [kpi(params)] });
    expect(codes((await put({ calendar: 'x', other: 1 })).checks)).toEqual(['param_unknown']);
    expect(codes((await put({ calendar: 'x', gap_ms: 'long' })).checks)).toEqual(['param_type']);
    expect(codes((await put({ calendar: 'x', gap_ms: 1.5 })).checks)).toEqual(['param_type']);
    const range = await put({ calendar: 'x', max_gap_ms: 5 });
    expect(range.checks).toEqual([expect.objectContaining({ code: 'param_range', message: 'Parameter "max_gap_ms" is 5, outside 1000 to 600000' })]);
    expect(codes((await put({})).checks)).toEqual(['param_required']);
    expect(codes((await put({ calendar: 'x', gap_ms: 2000, max_gap_ms: 3000 })).checks)).toEqual(['param_twice']);
    // a key that reaches an object's prototype never gets in
    expect(
      await status(s.api('PUT', '/plant/assets/rvs-press-01/assignment', { ...base, kpis: [kpi(JSON.parse('{"calendar":"x","__proto__":{"a":1}}'))] })),
    ).toMatchObject({
      status: 400,
    });
    const { cleanParams } = await import('../src/plant/data-model.js');
    expect(Object.keys(cleanParams(JSON.parse('{"a":1,"__proto__":2,"constructor":3}')))).toEqual(['a']);
  });

  it('checks the inputs: an interface not active, an override that says the asset lacks it, another profile, no profile', async () => {
    const put = (body: Record<string, unknown>) => s.api('PUT', '/plant/assets/rvs-press-01/assignment', { ...base, kpis: [kpi({ calendar: 'x' })], ...body });
    expect(codes((await put({ interfaces: [{ interface: 'opc', active: false }] })).checks)).toEqual(['kpi_interface_inactive']);
    expect(codes((await put({ interfaces: [] })).checks)).toEqual(['kpi_interface_inactive']);
    const lacks = await put({ overrides: [{ dataPoint: 'run_state', available: false }] });
    expect(codes(lacks.checks)).toEqual(['kpi_point_unavailable']);
    expect(lacks.possibleKpis).toEqual([]);
    expect(codes((await put({ profileId: 'example-meters-pm200', interfaces: [] })).checks)).toEqual(['kpi_other_profile']);
    expect(codes((await put({ profileId: null, interfaces: [] })).checks)).toEqual(['kpi_no_profile']);
    // a data point that leaves the profile later is found by the checks
    await put({});
    const { id: _i, ...rest } = structuredClone(PROFILE);
    rest.interfaces[0]!.groups[0]!.dataPoints = rest.interfaces[0]!.groups[0]!.dataPoints.filter((d) => d.id !== 'run_state');
    await users.dana!('PUT', '/plant/profiles/example-drives-x1', rest);
    expect(codes((await s.api('GET', '/plant/assets/rvs-press-01/assignment')).checks)).toEqual(['kpi_point_unknown']);
    const { id: _j, ...again } = PROFILE;
    await users.dana!('PUT', '/plant/profiles/example-drives-x1', again);
    expect((await s.api('GET', '/plant/assets/rvs-press-01/assignment')).checks).toEqual([]);
  });

  it('a profile or KPI definition in use is not deleted; an unused one is', async () => {
    expect(await status(users.dana!('DELETE', '/plant/profiles/example-drives-x1'))).toEqual({ status: 409, code: 'PLANT_PROFILE_IN_USE' });
    expect(await status(users.dana!('DELETE', '/plant/kpis/drive-uptime'))).toEqual({ status: 409, code: 'PLANT_KPI_IN_USE' });
    await users.dana!('POST', '/plant/profiles', { id: 'example-unused', name: 'Unused' });
    await users.dana!('DELETE', '/plant/profiles/example-unused');
    expect(await status(s.api('GET', '/plant/profiles/example-unused'))).toEqual({ status: 404, code: 'PLANT_PROFILE_NOT_FOUND' });
  });

  it('only who manages the asset’s site changes its assignment; viewers and plant viewers see it', async () => {
    for (const c of ['vera', 'pia', 'olaf']) {
      expect((await users[c]!('GET', '/plant/assets/rvs-press-01/assignment')).canManage, c).toBe(false);
      expect(await status(users[c]!('PUT', '/plant/assets/rvs-press-01/assignment', base)), c).toEqual({ status: 403, code: 'FORBIDDEN' });
      expect(await status(users[c]!('DELETE', '/plant/assets/rvs-press-01/assignment')), c).toEqual({ status: 403, code: 'FORBIDDEN' });
    }
  });
});

describe('search', () => {
  it('which assets deliver a data point, which KPIs an asset can have', async () => {
    const hits = await s.api('GET', '/plant/explore/points?q=program');
    const status_ = hits.find((h: { point: { id: string } }) => h.point.id === 'program_status');
    // milling centre 1 delivers it; milling centre 2's OPC UA interface is not set up
    expect(status_).toMatchObject({ profile: { id: 'example-controls-c80' }, interface: { protocol: 'opc_ua' }, group: 'Machine state', deliveredBy: 1 });
    expect(await s.api('GET', '/plant/explore/points?q=')).toEqual([]);
    // no pattern: a text with regular expression characters is only text
    expect(await s.api('GET', '/plant/explore/points?q=.*')).toEqual([]);
    const point = await s.api('GET', '/plant/profiles/example-controls-c80/points/program_status');
    expect(point.assets.map((a: { asset: { id: string }; delivers: boolean; reason: string | null }) => [a.asset.id, a.delivers, a.reason])).toEqual([
      ['rvs-mill-01', true, null],
      ['rvs-mill-02', false, 'interface_inactive'],
    ]);
    expect(point.kpis.map((k: { id: string }) => k.id)).toEqual(['machine-state-time']);
    expect(point.assets[0].publications).toEqual([expect.objectContaining({ target: 'iot-platform', name: 'ProgramStatus' })]);
    expect(await status(s.api('GET', '/plant/profiles/example-controls-c80/points/nope'))).toEqual({ status: 404, code: 'PLANT_POINT_NOT_FOUND' });
    // the asset list filters by profile and data point
    const by = await s.api('GET', '/plant/assets?profile=example-controls-c80&dataPoint=program_status');
    expect(by.map((a: { id: string }) => a.id)).toEqual(['rvs-mill-01']);
    expect((await s.api('GET', '/plant/assets?profile=example-controls-c80')).map((a: { id: string }) => a.id)).toEqual(['rvs-mill-01', 'rvs-mill-02']);
    // the KPI definition knows the assets that could have it
    const k = await s.api('GET', '/plant/kpis/machine-state-time');
    expect(k.instances.map((i: { asset: { id: string }; problems: number }) => [i.asset.id, i.problems])).toEqual([
      ['rvs-mill-01', 0],
      ['rvs-mill-02', 1],
    ]);
    expect(k.candidates).toEqual([]);
  });
});

describe('hidden sites stay hidden', () => {
  beforeAll(async () => {
    // Hillcrest only for the administrators: the designer may not see it
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [{ subject: 'user:vera', permissions: ['view'] }] });
  });
  afterAll(async () => {
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [] });
  });

  it('lists, counts, checks, the search and the data point page leave its assets out', async () => {
    const dana = users.dana!;
    expect(await status(dana('GET', '/plant/assets/hlc-im-01/assignment'))).toEqual({ status: 404, code: 'PLANT_ASSET_NOT_FOUND' });
    expect((await dana('GET', '/plant/profiles')).find((p: { id: string }) => p.id === 'example-plastics-mc6').assetCount).toBe(0);
    expect((await s.api('GET', '/plant/profiles')).find((p: { id: string }) => p.id === 'example-plastics-mc6').assetCount).toBe(1);
    expect((await dana('GET', '/plant/profiles/example-plastics-mc6')).assets).toEqual([]);
    expect((await dana('GET', '/plant/explore/points?q=cycle_counter'))[0].deliveredBy).toBe(0);
    expect((await dana('GET', '/plant/profiles/example-plastics-mc6/points/cycle_counter')).assets).toEqual([]);
    // a profile that only a hidden asset has is "still in use" – without a count or a name
    const res = await status(dana('DELETE', '/plant/profiles/example-plastics-mc6'));
    expect(res).toEqual({ status: 409, code: 'PLANT_PROFILE_IN_USE' });
    try {
      await dana('DELETE', '/plant/profiles/example-plastics-mc6');
    } catch (e) {
      expect((e as { body: { error: string; params?: { count: number } } }).body).toMatchObject({ params: { count: 0 } });
      expect(JSON.stringify((e as { body: unknown }).body)).not.toContain('hlc');
    }
    // an import into it reads like one the designer may not change, without naming the site
    const p = await dana('POST', '/plant/import/preview', {
      files: [file('a.yaml', { version: 1, assignment: { asset: 'hlc-im-01', profile: 'example-plastics-mc6' } })],
      mode: 'update',
    });
    expect(p.problems.map((x: { message: string }) => x.message)).toEqual(['You may not add or change asset "hlc-im-01"']);
    expect(JSON.stringify(p)).not.toContain('hillcrest');
  });
});

describe('YAML import and export', () => {
  /** A device profile written the way other tools write them: their spellings of protocols, types and addresses. */
  const FOREIGN = {
    version: 1,
    device_profile: {
      id: 'example-welding-w7',
      name: 'Example Welding W7 robot controller',
      manufacturer: 'Example Welding',
      model: 'W7',
      version: 2,
      category: 'Robot controller',
      interfaces: [
        {
          id: 'opc-ua-server',
          protocol: 'OPC-UA',
          direction: 'read',
          version: '1.0',
          default_port: 4840,
          client: 'gateway',
          authentication: 'none',
          groups: [
            {
              name: 'Robot Status',
              description: 'State of the controller.',
              data_points: [
                {
                  id: 'robot_mode',
                  name: 'Robot Mode',
                  data_type: 'string',
                  unit: null,
                  node_id: 'ns=2;s=RobotStatus.Mode',
                  enum_values: ['auto', 'manual'],
                  update_rate_ms: 1000,
                  notes: null,
                },
                { id: 'axis_positions', name: 'Axis positions', data_type: 'float[]', unit: 'deg', node_id: 'ns=2;s=Position.Axes', update_rate_ms: 100 },
                { id: 'timer_running', name: 'Timer running', data_type: 'int', unit: 'ns', publications: [{ path: 'normalizedTimers', name: 'Running' }] },
              ],
            },
          ],
        },
        {
          id: 'modbus-tcp',
          protocol: 'Modbus/TCP',
          default_port: 502,
          authentication: 'none',
          groups: [{ name: 'Basic Status', data_points: [{ id: 'mb_running', name: 'Running', data_type: 'bool', modbus_address: 'coil:0' }] }],
        },
        {
          id: 'smb-archive',
          protocol: 'SMB/CIFS',
          authentication: 'username-password',
          file_sets: [{ id: 'weld-files', name: 'Weld files', path_pattern: '*', format: null }],
        },
      ],
    },
  };
  const FOREIGN_KPI = {
    version: 1,
    kpi_definition: {
      id: 'example-weld-time',
      name: 'Weld time',
      category: 'Availability',
      dynamic_columns: false,
      inputs: [{ kind: 'datapoint', profile: 'example-welding-w7', data_points: ['timer_running'] }],
      parameters: [{ name: 'gap_ms', aliases: ['gap_s'], type: 'number', default: 60000 }],
      columns: [
        { name: 'running', kind: 'sum', scope: 'full', unit: 's' },
        { name: 'coverage_pct', kind: 'ratio', scope: 'bare', unit: '%', numerator: 'running', denominator: 'coverage_total', scale: 100 },
      ],
      computation: {
        summary: 'Counters at the boundaries.',
        steps: [{ name: 'Sample', does: 'Reads the counter.', why: 'It is monotonic.' }],
        limits: ['A reset reads as a gap.'],
      },
    },
  };
  const ASSIGNMENT = {
    version: 1,
    assignment: {
      asset: 'rvs-mill-03',
      site: 'riverside',
      profile: 'example-welding-w7',
      firmware: '4.92.6.11',
      interfaces: [{ interface: 'opc-ua-server', active: true, endpoint: 'opc.tcp://w7.example.com:4840', notes: 'Read-only account.' }],
      overrides: [],
      publications: [{ data_point: 'timer_running', path: 'normalizedTimers', name: 'Running', published_by: 'gateway' }],
      kpis: [{ kpi: 'example-weld-time', job: 'mill-03-weld-time', active: true, params: { gap_s: 'sixty' } }],
    },
  };

  it('reads other tools’ spellings; the preview shows the checks of the records after the import', async () => {
    const p = await s.api('POST', '/plant/import/preview', {
      files: [file('profile.yaml', FOREIGN), file('kpi.yaml', FOREIGN_KPI), file('assignment.yaml', ASSIGNMENT)],
      mode: 'add',
    });
    expect(p.problems).toEqual([]);
    expect(p.changes.map((c: { kind: string; action: string; id: string }) => `${c.kind}:${c.action}:${c.id}`)).toEqual([
      'profile:add:example-welding-w7',
      'kpi:add:example-weld-time',
      'assignment:add:rvs-mill-03',
    ]);
    expect(p.byKind).toMatchObject({ profile: { add: 1 }, kpi: { add: 1 }, assignment: { add: 1 } });
    expect(codes(p.checks)).toEqual(['param_type', 'ratio_column_unknown']);
    const r = await s.api('POST', '/plant/import', {
      files: [file('profile.yaml', FOREIGN), file('kpi.yaml', FOREIGN_KPI), file('assignment.yaml', ASSIGNMENT)],
      mode: 'add',
    });
    expect(r.import.counts).toMatchObject({ add: 3 });
    const prof = await s.api('GET', '/plant/profiles/example-welding-w7');
    expect(prof).toMatchObject({ version: '2', protocols: ['opc_ua', 'modbus_tcp', 'smb'] });
    expect(prof.interfaces[0].groups[0].dataPoints.map((d: { dataType: string; address: string }) => `${d.dataType} ${d.address}`)).toEqual([
      'String ns=2;s=RobotStatus.Mode',
      'Float[] ns=2;s=Position.Axes',
      'Integer ',
    ]);
    expect(prof.interfaces[1].groups[0].dataPoints[0]).toMatchObject({ dataType: 'Boolean', address: 'coil:0' });
    expect(prof.interfaces[2]).toMatchObject({
      protocol: 'smb',
      authentication: 'username_password',
      fileSets: [expect.objectContaining({ id: 'weld-files' })],
    });
    expect((await s.api('GET', '/plant/kpis/example-weld-time')).inputs[0].kind).toBe('data_point');
  });

  it('problems name the file and the place in it; a file with problems imports nothing', async () => {
    const bad: any = structuredClone(FOREIGN);
    bad.device_profile.id = 'example-welding-bad';
    bad.device_profile.interfaces[0]!.groups![0]!.data_points![0]!.node_id = 'RobotStatus.Mode';
    bad.device_profile.interfaces[1]!.groups![0]!.data_points!.push({ id: 'robot_mode', name: 'Twice', data_type: 'bool', modbus_address: 'coil:1' } as never);
    const p = await s.api('POST', '/plant/import/preview', { files: [file('bad.yaml', bad)], mode: 'add' });
    expect(p.ok).toBe(false);
    expect(p.problems.map((x: { file: string; path: string }) => `${x.file} ${x.path}`)).toEqual([
      'bad.yaml device_profile.interfaces[0].groups[0].data_points[0].address',
      'bad.yaml device_profile.interfaces[1].groups[0].data_points[1].id',
    ]);
    const schema = await s.api('POST', '/plant/import/preview', {
      files: [file('s.yaml', { version: 1, device_profile: { id: 'x', name: 'X', interfaces: [{ id: 'i', protocol: 'carrier pigeon' }] } })],
      mode: 'add',
    });
    expect(schema.problems[0]).toMatchObject({ path: 'device_profile.interfaces[0].protocol' });
    expect(schema.problems[0].message).toContain('opc_ua');
    const missing = await s.api('POST', '/plant/import/preview', {
      files: [file('m.yaml', { version: 1, assignment: { asset: 'rvs-mill-03', profile: 'nope', kpis: [{ kpi: 'nope', job: 'j' }] } })],
      mode: 'update',
    });
    expect(missing.problems.map((x: { path: string }) => x.path)).toEqual(['assignment.profile', 'assignment.kpis[0].kpi']);
    const asset = await s.api('POST', '/plant/import/preview', { files: [file('n.yaml', { version: 1, assignment: { asset: 'nope' } })], mode: 'update' });
    expect(asset.problems[0]).toMatchObject({ path: 'assignment.asset', message: 'There is no asset "nope"' });
  });

  it('the catalogues need their own right: a site manager may import assignments, not profiles', async () => {
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [{ subject: 'user:olaf', permissions: ['manage'] }] });
    const p = await users.olaf!('POST', '/plant/import/preview', { files: [file('profile.yaml', FOREIGN)], mode: 'update' });
    expect(p.problems.map((x: { message: string }) => x.message)).toEqual(['You may not add or change device profiles and KPI definitions']);
    const a = await users.olaf!('POST', '/plant/import/preview', { files: [file('assignment.yaml', ASSIGNMENT)], mode: 'update' });
    expect(a.problems).toEqual([]);
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [] });
  });

  it('update and replace: keys left out keep their values; records of the earlier import that the files lack go or are marked', async () => {
    const upd = await s.api('POST', '/plant/import', {
      files: [file('u.yaml', { version: 1, device_profile: { id: 'example-welding-w7', name: 'Example Welding W7 controller' } })],
      mode: 'update',
    });
    expect(upd.changes).toEqual([expect.objectContaining({ kind: 'profile', action: 'change', fields: ['name'] })]);
    expect((await s.api('GET', '/plant/profiles/example-welding-w7')).interfaces).toHaveLength(3);
    const imports = await s.api('GET', '/plant/imports');
    const first = imports.find((i: { counts: { add: number }; files: { name: string }[] }) => i.files[0]?.name === 'profile.yaml');
    // replace that import with the profile alone: the KPI definition and the assignment are not in the files
    const req = { files: [file('profile.yaml', FOREIGN)], mode: 'replace', replaces: first.id, missing: 'remove' };
    const p = await s.api('POST', '/plant/import/preview', req);
    // the KPI definition still has an instance that stays? no – the assignment goes with it
    expect(p.problems).toEqual([]);
    expect(p.changes.filter((c: { action: string }) => c.action === 'remove').map((c: { kind: string; id: string }) => `${c.kind}:${c.id}`)).toEqual([
      'kpi:example-weld-time',
      'assignment:rvs-mill-03',
    ]);
    // keeping the assignment by hand while the KPI definition goes stops the import
    const keep = await s.api('POST', '/plant/import/preview', { ...req, files: [file('profile.yaml', FOREIGN), file('assignment.yaml', ASSIGNMENT)] });
    expect(keep.problems.map((x: { path: string }) => x.path)).toEqual(['assignment.kpis[0].kpi', 'kpi_definitions']);
    const marked = await s.api('POST', '/plant/import', { ...req, missing: 'mark' });
    expect(marked.counts).toMatchObject({ mark: 2 });
    expect((await s.api('GET', '/plant/kpis/example-weld-time')).notInSource).toBe(true);
    expect((await s.api('GET', '/plant/assets/rvs-mill-03/assignment')).notInSource).toBe(true);
  });

  it('exports and imports back unchanged: the whole registry, the catalogues, one profile, one KPI definition', async () => {
    const token = (await s.api('POST', '/me/tokens', { name: 'export', scope: 'read' })).token;
    const get = async (q: string) => {
      const res = await fetch(`${s.base}/api/plant/export${q}`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, q).toBe(200);
      return { text: (await res.text()).replace(/^#.*\n/gm, ''), name: res.headers.get('content-disposition') };
    };
    const all = await get('');
    const doc = YAML.parse(all.text);
    expect(Object.keys(doc)).toEqual(['version', 'enterprise', 'sites', 'device_profiles', 'kpi_definitions', 'assignments']);
    const imports = await s.api('GET', '/plant/imports');
    const p = await s.api('POST', '/plant/import', { files: [file('all.yaml', all.text)], mode: 'replace', replaces: imports[0].id, missing: 'mark' });
    expect(p.counts.change).toBe(p.changes.filter((c: { fields?: string[] }) => c.fields?.join() === 'notInSource').length);
    const again = await s.api('POST', '/plant/import/preview', {
      files: [file('all.yaml', all.text)],
      mode: 'replace',
      replaces: p.import.id,
      missing: 'remove',
    });
    expect(again.counts).toMatchObject({ add: 0, change: 0, remove: 0 });
    expect((await get('')).text).toBe(all.text);
    const cat = YAML.parse((await get('?part=catalogue')).text);
    expect(Object.keys(cat)).toEqual(['version', 'device_profiles', 'kpi_definitions']);
    const one = await get('?profile=example-controls-c80');
    expect(one.name).toContain('example-controls-c80.profile.plant.yaml');
    const prof = YAML.parse(one.text);
    expect(prof.device_profile.interfaces[0].groups[0].data_points[0]).toMatchObject({
      id: 'program_status',
      data_type: 'Int32',
      address: 'ns=2;s=Channel1.ProgramStatus',
    });
    expect((await s.api('POST', '/plant/import/preview', { files: [file('p.yaml', one.text)], mode: 'update' })).counts).toMatchObject({
      unchanged: 1,
      change: 0,
    });
    const k = YAML.parse((await get('?kpi=machine-state-time')).text);
    expect(k.kpi_definition.columns.find((c: { name: string }) => c.name === 'availability_pct')).toMatchObject({
      kind: 'ratio',
      denominator: 'planned_production_time',
    });
    const site = YAML.parse((await get('?site=riverside')).text);
    expect(site.assignments.map((a: { asset: string }) => a.asset)).toContain('rvs-mill-01');
    expect(site.device_profiles).toBeUndefined();
  });
});

describe('duplicate and delete', () => {
  it('profiles and KPI definitions are duplicated; an asset copy takes its profile, not its endpoints or KPI instances', async () => {
    const p = await users.dana!('POST', '/plant/profiles/example-controls-c80/duplicate', {
      name: 'Example Controls C80 (firmware 4)',
      key: 'example-controls-c80-v4',
    });
    expect(p).toMatchObject({ id: 'example-controls-c80-v4' });
    expect((await s.api('GET', '/plant/profiles/example-controls-c80-v4')).dataPointCount).toBe(
      (await s.api('GET', '/plant/profiles/example-controls-c80')).dataPointCount,
    );
    const k = await users.dana!('POST', '/plant/kpis/machine-state-time/duplicate', { name: 'Time in machine state v2', key: 'machine-state-time-v2' });
    expect(k.id).toBe('machine-state-time-v2');
    expect(await status(users.vera!('POST', '/plant/kpis/machine-state-time/duplicate', { name: 'x', key: 'x-x' }))).toMatchObject({ status: 403 });
    await users.dana!('POST', '/plant/assets/rvs-mill-01/duplicate', { name: 'Milling centre 1b', key: 'rvs-mill-01b' });
    const copy = await s.api('GET', '/plant/assets/rvs-mill-01b/assignment');
    expect(copy.assignment).toMatchObject({ profileId: 'example-controls-c80', publications: [], kpis: [] });
    expect(copy.assignment.interfaces.every((i: { endpoint: string }) => i.endpoint === '')).toBe(true);
  });

  it('deleting an asset removes its assignment', async () => {
    await s.api('DELETE', '/plant/assets/rvs-mill-01b');
    const { db } = await import('../src/db.js');
    expect(db().get("SELECT 1 FROM plant_assignments WHERE asset_id = 'rvs-mill-01b'")).toBeUndefined();
    await s.api('DELETE', '/plant/assets/rvs-press-01/assignment');
    expect((await s.api('GET', '/plant/assets/rvs-press-01/assignment')).assignment).toBeNull();
    const [log] = await s.api('GET', '/audit?action=asset.assignment_removed&limit=1');
    expect(log.entityId).toBe('rvs-press-01');
  });
});

describe('public API', () => {
  it('lists profiles and KPI definitions and an asset’s assignment for a token (the Plant viewer too); 404 while the module is off', async () => {
    const { token } = await users.pia!('POST', '/me/tokens', { name: 'plant viewer', scope: 'read' });
    const v1 = (url: string) => fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
    const profiles = await (await v1('/plant/profiles?limit=2')).json();
    expect(profiles.items).toHaveLength(2);
    expect(profiles.nextCursor).toBeTruthy();
    const one = await (await v1('/plant/profiles/example-controls-c80')).json();
    expect(one).toMatchObject({ id: 'example-controls-c80', interfaces: expect.any(Array) });
    expect(one.canManage).toBeUndefined();
    const kpis = await (await v1('/plant/kpis')).json();
    expect(kpis.items.map((k: { id: string }) => k.id)).toContain('machine-state-time');
    expect((await (await v1('/plant/kpis/machine-state-time')).json()).columns.length).toBeGreaterThan(3);
    const a = await (await v1('/plant/assets/rvs-mill-02/assignment')).json();
    expect(a.checks[0].code).toBe('kpi_interface_inactive');
    expect(a.kpis[0].results).toBeUndefined();
    expect((await (await v1('/plant/assets?profile=example-controls-c80&dataPoint=program_status')).json()).items.map((x: { id: string }) => x.id)).toEqual([
      'rvs-mill-01',
    ]);
    expect((await v1('/plant/profiles/nope')).status).toBe(404);
    await enable(false);
    expect((await v1('/plant/profiles')).status).toBe(404);
    await enable(true);
  });
});
