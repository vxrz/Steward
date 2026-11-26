import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlantBlueprintDetail, PlantBlueprintMatrix, PlantCoverage, PlantKpiBlueprints } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Machine blueprints, step 2 (0.30.0, ADR 0041): the site matrix (assets by blueprints, totals per importance, team scope:
 * nothing hidden is a column, a row or counted) and the links of signals to KPI definitions (shown on the blueprint and the
 * KPI, and – as additional information – where the KPI coverage says a KPI cannot be computed).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Plant-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let tom: Client;
let machines = '';

const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );

const WELDER = {
  id: 'welding-machine',
  name: 'Welding machine',
  signals: [
    { id: 'energy_total', name: 'Energy total', importance: 'must', kpis: ['weld-energy'] },
    { id: 'state', name: 'Machine state', importance: 'should' },
  ],
};
const ROBOT = { id: 'robot-cell', name: 'Robot cell', signals: [{ id: 'cycles', name: 'Cycles', importance: 'nice' }] };

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Plant AG', labels: {}, fields: {} });
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['vera', 'viewer'],
    ['tom', 'operator'],
  ] as const)
    createUser({ username: name, roles: [role], password: PW });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  tom = await s.as('tom', PW);
  machines = (await s.api('POST', '/teams', { name: 'Machines', members: ['tom'], memberRoles: { tom: ['designer'] } })).id;
  await s.api('POST', '/plant/sites', { id: 'east', name: 'East works' });
  for (const id of ['weld-1', 'weld-2', 'bare-1']) await s.api('POST', '/plant/assets', { id, siteId: 'east', name: id });
  await s.api('POST', '/plant/profiles', {
    id: 'weld-ctl-1',
    name: 'Example Weld controller',
    interfaces: [
      {
        id: 'opc',
        name: 'OPC UA',
        protocol: 'opc_ua',
        groups: [{ name: 'Data', dataPoints: [{ id: 'energy_kwh', name: 'Energy total', dataType: 'Float', address: 'ns=2;s=E' }] }],
      },
    ],
  });
  for (const id of ['weld-1', 'weld-2'])
    await s.api('PUT', `/plant/assets/${id}/assignment`, {
      profileId: 'weld-ctl-1',
      interfaces: [{ interface: 'opc', active: true, endpoint: 'opc.tcp://10.0.0.1:4840' }],
    });
  await s.api('POST', '/plant/kpis', { id: 'weld-energy', name: 'Weld energy', inputs: [{ profile: 'weld-ctl-1', dataPoints: ['energy_kwh'] }] });
});
afterAll(async () => {
  await s?.app.close();
});

describe('links to KPI definitions', () => {
  it('are saved with a signal, refused for a KPI that is not there, and shown on the blueprint', async () => {
    const made = (await dana('POST', '/plant/blueprints', WELDER)) as PlantBlueprintDetail;
    expect(made.signals.find((x) => x.id === 'energy_total')!.kpis).toEqual(['weld-energy']);
    expect(made.signals.find((x) => x.id === 'state')!.kpis).toEqual([]);
    expect(await status(dana('PUT', '/plant/blueprints/welding-machine/signals/state', { kpis: ['ghost'] }))).toMatchObject({
      status: 400,
      code: 'PLANT_BLUEPRINT_INVALID',
    });
    await dana('POST', '/plant/blueprints', ROBOT);
    await dana('PUT', '/plant/profiles/weld-ctl-1/blueprints/welding-machine');
    await dana('PUT', '/plant/assets/bare-1/blueprints/welding-machine');
    await dana('PUT', '/plant/profiles/weld-ctl-1/blueprints/welding-machine/signals/energy_total/mapping', { dataPoints: ['energy_kwh'] });
  });

  it('say, beside the KPI coverage, which blueprint signal is missing – without changing the state', async () => {
    const c = (await dana('GET', '/plant/views/coverage')) as PlantCoverage;
    const at = c.kpis.findIndex((k) => k.id === 'weld-energy');
    const cell = (asset: string) => c.rows.find((r) => r.asset.id === asset)!.cells[at]!;
    expect(cell('weld-1')).toMatchObject({
      state: 'could',
      collected: false,
      blueprintGaps: [{ blueprint: { id: 'welding-machine' }, signal: { id: 'energy_total' }, state: 'notCollected' }],
    });
    expect(cell('bare-1')).toMatchObject({ state: 'cannot', blueprintGaps: [{ signal: { id: 'energy_total' }, state: 'missing' }] });
    const k = (await dana('GET', '/plant/kpis/weld-energy/blueprints')) as PlantKpiBlueprints;
    expect(k.signals).toEqual([
      {
        blueprint: { id: 'welding-machine', name: 'Welding machine' },
        signal: { id: 'energy_total', name: 'Energy total', importance: 'must' },
        assets: { covered: 0, missing: 1, notCollected: 2, notApplicable: 0 },
      },
    ]);
    expect(Object.keys(k.gaps).sort()).toEqual(['bare-1', 'weld-1', 'weld-2']);
  });

  it('follow the id of a KPI definition, and stay unseen by a reader who may not see the KPI', async () => {
    await s.api('PUT', '/owning-teams/kpi_definition/weld-energy', { teamIds: [machines] });
    expect((await vera('GET', '/plant/blueprints/welding-machine')).signals[0].kpis).toEqual([]);
    expect(await status(vera('GET', '/plant/kpis/weld-energy/blueprints'))).toMatchObject({ status: 404 });
    const c = (await vera('GET', '/plant/views/coverage')) as PlantCoverage;
    expect(JSON.stringify(c)).not.toContain('blueprintGaps');
    // a designer outside the team cannot change what they cannot see: the link stays when they save other keys
    expect((await tom('GET', '/plant/blueprints/welding-machine')).signals[0].kpis).toEqual(['weld-energy']);
    await s.api('PUT', '/owning-teams/kpi_definition/weld-energy', { teamIds: [] });
    // renaming the KPI definition takes the links along
    await s.api('POST', '/plant/ids/rename', { kind: 'kpi', scope: '', id: 'weld-energy', newId: 'weld-energy-2' });
    expect((await dana('GET', '/plant/blueprints/welding-machine')).signals[0].kpis).toEqual(['weld-energy-2']);
    await s.api('POST', '/plant/ids/rename', { kind: 'kpi', scope: '', id: 'weld-energy-2', newId: 'weld-energy' });
  });
});

describe('the site matrix', () => {
  it('has the assets by the blueprints they have, with totals per importance', async () => {
    await dana('PUT', '/plant/assets/weld-2/blueprints/robot-cell');
    const m = (await dana('GET', '/plant/views/blueprints?site=east')) as PlantBlueprintMatrix;
    expect(m.blueprints.map((b) => [b.id, b.assets])).toEqual([
      ['robot-cell', 1],
      ['welding-machine', 3],
    ]);
    expect(m.total).toBe(3);
    const row = (id: string) => m.rows.find((r) => r.asset.id === id)!;
    expect(row('weld-1').cells[0]).toBeNull();
    expect(row('weld-1').cells[1]).toMatchObject({ via: 'profile', byImportance: { must: { total: 1, notCollected: 1 }, should: { total: 1, missing: 1 } } });
    expect(row('bare-1').cells[1]).toMatchObject({ via: 'direct', byImportance: { must: { missing: 1 } } });
    expect(row('weld-2').cells[0]).toMatchObject({ via: 'direct', byImportance: { nice: { total: 1, missing: 1 } } });
    expect(m.totals.must).toMatchObject({ total: 3, notCollected: 2, missing: 1, covered: 0 });
    expect(m.totals.should).toMatchObject({ total: 3, missing: 3 });
    expect(m.totals.nice).toMatchObject({ total: 1, missing: 1 });
    expect(m.groups.find((g) => g.siteId === 'east' && g.areaId === null)).toMatchObject({ assets: 3 });
    expect((await dana('GET', '/plant/views/blueprints?blueprint=robot-cell')).rows.map((r: { asset: { id: string } }) => r.asset.id)).toEqual(['weld-2']);
    expect(await status(dana('GET', '/plant/views/blueprints?site=nowhere'))).toMatchObject({ status: 404 });
  });

  it('never shows, counts or names what the reader may not see: a hidden blueprint is no column and no total', async () => {
    await s.api('PUT', '/owning-teams/blueprint/welding-machine', { teamIds: [machines] });
    const v = (await vera('GET', '/plant/views/blueprints')) as PlantBlueprintMatrix;
    expect(v.blueprints.map((b) => b.id)).toEqual(['robot-cell']);
    expect(v.total).toBe(1);
    expect(v.rows.map((r) => r.asset.id)).toEqual(['weld-2']);
    expect(v.totals.must.total).toBe(0);
    expect(v.totals.should.total).toBe(0);
    expect(JSON.stringify(v)).not.toContain('welding');
    expect(await status(vera('GET', '/plant/views/blueprints?blueprint=welding-machine'))).toMatchObject({ status: 404, code: 'PLANT_BLUEPRINT_NOT_FOUND' });
    expect(await vera('GET', '/plant/catalogue/hidden')).toEqual({ profiles: 0, kpis: 0 });
    // a member of the team sees all of it
    expect(((await tom('GET', '/plant/views/blueprints')) as PlantBlueprintMatrix).total).toBe(3);
    // an asset's hidden profile is a placeholder, not a name
    await s.api('PUT', '/owning-teams/device_profile/weld-ctl-1', { teamIds: [machines] });
    const h = (await vera('GET', '/plant/views/blueprints')) as PlantBlueprintMatrix;
    expect(JSON.stringify(h)).not.toContain('weld-ctl-1');
    expect(h.options.profiles.map((p) => p.id)).not.toContain('weld-ctl-1');
    await s.api('PUT', '/owning-teams/device_profile/weld-ctl-1', { teamIds: [] });
    await s.api('PUT', '/owning-teams/blueprint/welding-machine', { teamIds: [] });
  });
});
