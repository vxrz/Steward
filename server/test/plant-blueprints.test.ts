import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlantBlueprintCoverageView, PlantBlueprintDetail } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Machine blueprints (0.30.0, ADR 0041): CRUD of blueprints and signals, assigning to profiles and assets, mapping,
 * not applicable, coverage (the profile lacks it / the profile has it, this asset does not collect it), suggestions that
 * never count, team scope and the audit entries.
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
const audits = async (action: string) =>
  (await import('../src/db.js')).db().all<{ summary: string; details: string }>('SELECT summary, details FROM audit_log WHERE action = ?', action);

const WELDER = {
  id: 'welding-machine',
  name: 'Welding machine',
  reference: 'Own experience',
  version: '1',
  signals: [
    { id: 'energy_total', name: 'Energy total', meaning: 'Energy drawn since commissioning', why: ['energy'], importance: 'must', aliases: ['kWh counter'] },
    { id: 'state', name: 'Machine state', meaning: 'Running, idle or faulted', why: ['availability'], importance: 'must', aliases: ['status'] },
    { id: 'fault_code', name: 'Fault code', meaning: 'The active fault', why: ['maintenance'], importance: 'should' },
    { id: 'part_counter', name: 'Part counter', meaning: 'Parts welded', why: ['traceability'], importance: 'nice' },
  ],
};
const PROFILE = {
  id: 'weld-ctl-1',
  name: 'Example Weld controller',
  interfaces: [
    {
      id: 'opc',
      name: 'OPC UA',
      protocol: 'opc_ua',
      groups: [
        {
          name: 'Data',
          dataPoints: [
            { id: 'energy_kwh', name: 'Energy total', dataType: 'Float', unit: 'kWh', address: 'ns=2;s=E' },
            { id: 'machine_status', name: 'Status', dataType: 'Int16', address: 'ns=2;s=S' },
            { id: 'faultcode', name: 'Fault', dataType: 'Int16', address: 'ns=2;s=F' },
          ],
        },
      ],
    },
  ],
};

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
  await s.api('POST', '/plant/profiles', PROFILE);
  for (const id of ['weld-1', 'weld-2'])
    await s.api('PUT', `/plant/assets/${id}/assignment`, {
      profileId: 'weld-ctl-1',
      interfaces: [{ interface: 'opc', active: true, endpoint: 'opc.tcp://plc.example:4840' }],
    });
});
afterAll(async () => {
  await s?.app.close();
});

const cov = (v: PlantBlueprintCoverageView, signal: string, bp = 'welding-machine') =>
  v.blueprints.find((b) => b.blueprint.id === bp)!.signals.find((x) => x.signal.id === signal)!;

describe('blueprints and signals', () => {
  it('designers add, readers read; ids are unique; signals can be added, changed and removed', async () => {
    expect(await status(vera('POST', '/plant/blueprints', WELDER))).toMatchObject({ status: 403 });
    const made = (await dana('POST', '/plant/blueprints', WELDER)) as PlantBlueprintDetail;
    expect(made).toMatchObject({ id: 'welding-machine', signalCount: 4, byImportance: { must: 2, should: 1, nice: 1 }, canEdit: true });
    expect(await status(dana('POST', '/plant/blueprints', WELDER))).toMatchObject({ status: 409, code: 'PLANT_ID_TAKEN' });
    expect((await vera('GET', '/plant/blueprints')).map((b: { id: string }) => b.id)).toEqual(['welding-machine']);
    expect(await vera('GET', '/plant/blueprints/welding-machine')).toMatchObject({ canEdit: false });
    expect(await status(vera('PUT', '/plant/blueprints/welding-machine', { name: 'x' }))).toMatchObject({ status: 403 });
    expect(await status(dana('POST', '/plant/blueprints', { ...WELDER, id: 'dup', signals: [WELDER.signals[0], WELDER.signals[0]] }))).toMatchObject({
      status: 400,
      code: 'PLANT_BLUEPRINT_INVALID',
    });
    await dana('POST', '/plant/blueprints/welding-machine/signals', { id: 'wire_feed', name: 'Wire feed', importance: 'nice' });
    await dana('PUT', '/plant/blueprints/welding-machine/signals/wire_feed', { importance: 'should', aliases: ['feed speed'] });
    const after = (await dana('GET', '/plant/blueprints/welding-machine')) as PlantBlueprintDetail;
    expect(after.signals.find((x) => x.id === 'wire_feed')).toMatchObject({ importance: 'should', aliases: ['feed speed'] });
    await dana('DELETE', '/plant/blueprints/welding-machine/signals/wire_feed');
    expect(((await dana('GET', '/plant/blueprints/welding-machine')) as PlantBlueprintDetail).signalCount).toBe(4);
    expect(await status(dana('DELETE', '/plant/blueprints/welding-machine/signals/nope'))).toMatchObject({
      status: 404,
      code: 'PLANT_BLUEPRINT_SIGNAL_NOT_FOUND',
    });
    expect((await audits('blueprint.created')).length).toBe(1);
    expect((await audits('blueprint.updated')).length).toBe(3);
  });
});

describe('coverage of a profile', () => {
  it('suggests by name and alias but never counts a suggestion; a confirmed mapping counts', async () => {
    let v = (await vera('GET', '/plant/profiles/weld-ctl-1/blueprints')) as PlantBlueprintCoverageView;
    expect(v.blueprints).toEqual([]);
    expect(await status(vera('PUT', '/plant/profiles/weld-ctl-1/blueprints/welding-machine'))).toMatchObject({ status: 403 });
    v = await dana('PUT', '/plant/profiles/weld-ctl-1/blueprints/welding-machine');
    expect(v.blueprints[0]!.totals).toMatchObject({ total: 4, covered: 0, missing: 4 });
    expect(cov(v, 'energy_total').suggestions[0]).toMatchObject({ dataPoint: 'energy_kwh', matchedBy: 'name' });
    expect(cov(v, 'state').suggestions[0]).toMatchObject({ dataPoint: 'machine_status', matchedBy: 'alias' });
    expect(cov(v, 'fault_code').suggestions[0]).toMatchObject({ dataPoint: 'faultcode', matchedBy: 'keyword' });
    expect(v.blueprints[0]!.totals.suggested).toBe(3);
    // an unknown data point is refused; a mapping covers
    expect(
      await status(dana('POST', '/plant/profiles/weld-ctl-1/blueprints/welding-machine/signals/energy_total/mapping', { dataPoint: 'nope' })),
    ).toMatchObject({
      status: 400,
      code: 'PLANT_BLUEPRINT_POINT_NOT_FOUND',
    });
    v = await dana('POST', '/plant/profiles/weld-ctl-1/blueprints/welding-machine/signals/energy_total/mapping', { dataPoint: 'energy_kwh' });
    expect(cov(v, 'energy_total')).toMatchObject({ state: 'covered', suggestions: [] });
    await dana('PUT', '/plant/profiles/weld-ctl-1/blueprints/welding-machine/signals/state/mapping', { dataPoints: ['machine_status'] });
    // not applicable needs a reason and is not missing
    expect(
      await status(dana('PUT', '/plant/profiles/weld-ctl-1/blueprints/welding-machine/signals/part_counter/not-applicable', { reason: ' ' })),
    ).toMatchObject({ status: 400 });
    v = await dana('PUT', '/plant/profiles/weld-ctl-1/blueprints/welding-machine/signals/part_counter/not-applicable', {
      reason: 'The cell counts parts elsewhere',
    });
    expect(cov(v, 'part_counter')).toMatchObject({
      state: 'notApplicable',
      notApplicable: { reason: 'The cell counts parts elsewhere', by: 'dana', on: 'profile' },
    });
    const t = v.blueprints[0]!;
    expect(t.totals).toMatchObject({ total: 4, applicable: 3, covered: 2, missing: 1, notApplicable: 1 });
    expect(t.byImportance.must).toMatchObject({ covered: 2, missing: 0 });
    expect(t.byImportance.should).toMatchObject({ missing: 1, suggested: 1 });
    expect((await audits('blueprint.mapping_changed')).length).toBe(2);
    expect((await audits('blueprint.not_applicable_set')).length).toBe(1);
    expect((await audits('blueprint.assigned')).length).toBe(1);
  });
});

describe('coverage of an asset', () => {
  it('tells "the profile lacks it" from "the profile has it, not collected here"', async () => {
    await s.api('POST', '/plant/assets/weld-1/collections', {
      id: 'etl',
      name: 'Energy ETL',
      collector: { kind: 'job', ref: 'energy-etl' },
      interfaceId: 'opc',
      items: [{ address: 'ns=2;s=E', outputName: 'E', dataPoint: 'energy_kwh' }],
    });
    const w1 = (await vera('GET', '/plant/assets/weld-1/blueprints')) as PlantBlueprintCoverageView;
    expect(w1.profile).toMatchObject({ id: 'weld-ctl-1' });
    expect(cov(w1, 'energy_total').state).toBe('covered');
    expect(cov(w1, 'state').state).toBe('notCollected');
    expect(cov(w1, 'fault_code').state).toBe('missing');
    expect(cov(w1, 'part_counter')).toMatchObject({ state: 'notApplicable', notApplicable: { on: 'profile' } });
    expect(w1.blueprints[0]).toMatchObject({ via: 'profile', totals: { covered: 1, notCollected: 1, missing: 1, notApplicable: 1 } });
    // the asset may add its own mark and mapping
    const w2 = (await dana('PUT', '/plant/assets/weld-2/blueprints/welding-machine/signals/fault_code/not-applicable', {
      reason: 'No fault output on this cell',
    })) as PlantBlueprintCoverageView;
    expect(cov(w2, 'fault_code')).toMatchObject({ state: 'notApplicable', notApplicable: { on: 'asset' } });
    expect(cov(w1, 'fault_code').state).toBe('missing');
    expect(await status(vera('PUT', '/plant/assets/weld-2/blueprints/welding-machine/signals/state/not-applicable', { reason: 'x' }))).toMatchObject({
      status: 403,
    });
    // an asset without a profile has direct blueprints only
    expect(((await dana('GET', '/plant/assets/bare-1/blueprints')) as PlantBlueprintCoverageView).blueprints).toEqual([]);
    const b = (await dana('PUT', '/plant/assets/bare-1/blueprints/welding-machine')) as PlantBlueprintCoverageView;
    expect(b.blueprints[0]).toMatchObject({ via: 'direct', totals: { missing: 4 } });
    expect(await status(dana('POST', '/plant/assets/bare-1/blueprints/welding-machine/signals/state/mapping', { dataPoint: 'machine_status' }))).toMatchObject({
      status: 400,
    });
    // a blueprint that is not the target's cannot be mapped
    await dana('POST', '/plant/blueprints', { id: 'other', name: 'Other', signals: [{ id: 'x', name: 'X' }] });
    expect(await status(dana('PUT', '/plant/assets/weld-2/blueprints/other/signals/x/mapping', { dataPoints: [] }))).toMatchObject({
      status: 409,
      code: 'PLANT_BLUEPRINT_NOT_ASSIGNED',
    });
    // unmark
    const un = (await dana('DELETE', '/plant/assets/weld-2/blueprints/welding-machine/signals/fault_code/not-applicable')) as PlantBlueprintCoverageView;
    expect(cov(un, 'fault_code').state).toBe('missing');
    expect((await audits('blueprint.not_applicable_cleared')).length).toBe(1);
  });
});

describe('team scope, deleting and removing', () => {
  it('a hidden blueprint is never seen, counted or named; deleting is refused while assigned', async () => {
    await s.api('PUT', '/owning-teams/blueprint/welding-machine', { teamIds: [machines] });
    expect((await vera('GET', '/plant/blueprints')).map((b: { id: string }) => b.id)).toEqual(['other']);
    expect(await status(vera('GET', '/plant/blueprints/welding-machine'))).toMatchObject({ status: 404, code: 'PLANT_BLUEPRINT_NOT_FOUND' });
    expect(((await vera('GET', '/plant/assets/weld-1/blueprints')) as PlantBlueprintCoverageView).blueprints).toEqual([]);
    expect(((await vera('GET', '/plant/profiles/weld-ctl-1/blueprints')) as PlantBlueprintCoverageView).blueprints).toEqual([]);
    expect(await status(dana('PUT', '/plant/assets/weld-1/blueprints/welding-machine'))).toMatchObject({ status: 404 });
    expect(await vera('GET', '/plant/catalogue/hidden')).toEqual({ profiles: 0, kpis: 0 });
    // a member designer sees it; an instance designer outside the team does not
    expect(await status(tom('GET', '/plant/blueprints/welding-machine'))).toMatchObject({ status: 200 });
    expect(await status(dana('GET', '/plant/blueprints/welding-machine'))).toMatchObject({ status: 404 });
    expect(await status(tom('DELETE', '/plant/blueprints/welding-machine'))).toMatchObject({ status: 409, code: 'PLANT_BLUEPRINT_IN_USE' });
    await s.api('PUT', '/owning-teams/blueprint/welding-machine', { teamIds: [] });
    // removing an asset and a profile forgets what blueprints say about them
    await dana('DELETE', '/plant/profiles/weld-ctl-1/blueprints/welding-machine');
    await dana('DELETE', '/plant/assets/bare-1/blueprints/welding-machine');
    const { db } = await import('../src/db.js');
    expect(db().all('SELECT 1 FROM plant_blueprint_mappings')).toEqual([]);
    expect(db().all('SELECT 1 FROM plant_blueprint_not_applicable')).toEqual([]);
    await dana('DELETE', '/plant/blueprints/welding-machine');
    expect(await status(dana('GET', '/plant/blueprints/welding-machine'))).toMatchObject({ status: 404 });
    expect((await audits('blueprint.deleted')).length).toBe(1);
  });
});
