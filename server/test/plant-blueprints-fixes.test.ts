import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { PlantBlueprintCoverageView, PlantBlueprintMatrix } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Machine blueprints, review fixes (0.30.0): taking a blueprint off a profile keeps what its assets said, the matrix does
 * no suggestion work, and an import cannot forge who set a mark.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Plant-password-1';
let s: TestServer;
let dana: Client;
const ASSETS = 150;

const signals = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `sig_${i}`, name: i === 0 ? 'Energy total' : `Signal number ${i}`, importance: i % 3 ? 'should' : 'must' }));

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Plant AG', labels: {}, fields: {} });
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  dana = await s.as('dana', PW);
  await s.api('POST', '/plant/sites', { id: 'east', name: 'East works' });
  await s.api('POST', '/plant/profiles', {
    id: 'ctl-1',
    name: 'Example controller',
    interfaces: [
      {
        id: 'opc',
        name: 'OPC UA',
        protocol: 'opc_ua',
        groups: [{ name: 'Data', dataPoints: [{ id: 'energy_kwh', name: 'Energy total', dataType: 'Float', address: 'ns=2;s=E' }] }],
      },
    ],
  });
  for (let i = 0; i < ASSETS; i++) {
    await s.api('POST', '/plant/assets', { id: `m-${i}`, siteId: 'east', name: `Machine ${i}` });
    await s.api('PUT', `/plant/assets/m-${i}/assignment`, {
      profileId: 'ctl-1',
      interfaces: [{ interface: 'opc', active: true, endpoint: 'opc.tcp://plc.example:4840' }],
    });
  }
  for (const b of ['alpha', 'beta', 'gamma']) await s.api('POST', '/plant/blueprints', { id: b, name: b, signals: signals(50) });
});
afterAll(async () => {
  await s?.app.close();
});

describe('taking a blueprint off a profile', () => {
  it('keeps what its assets mapped and marked, which stays unseen and unexported until it is assigned again', async () => {
    await s.api('PUT', '/plant/profiles/ctl-1/blueprints/alpha');
    await s.api('PUT', '/plant/profiles/ctl-1/blueprints/alpha/signals/sig_1/not-applicable', { reason: 'Profile level' });
    await s.api('PUT', '/plant/assets/m-0/blueprints/alpha/signals/sig_2/not-applicable', { reason: 'Asset level' });
    await s.api('PUT', '/plant/assets/m-0/blueprints/alpha/signals/sig_0/mapping', { dataPoints: ['energy_kwh'] });
    await s.api('DELETE', '/plant/profiles/ctl-1/blueprints/alpha');

    const { marksOf, mappingsOf } = await import('../src/plant/blueprint-store.js');
    const own = { kind: 'asset' as const, id: 'm-0' };
    expect(marksOf(own).map((m) => m.signal)).toEqual(['sig_2']);
    expect(mappingsOf(own).map((m) => m.signal)).toEqual(['sig_0']);
    expect(marksOf({ kind: 'profile', id: 'ctl-1' })).toEqual([]);

    // not shown, not counted, not exported while the blueprint is not assigned to the asset
    expect(((await s.api('GET', '/plant/assets/m-0/blueprints')) as PlantBlueprintCoverageView).blueprints).toEqual([]);
    const matrix = (await s.api('GET', '/plant/views/blueprints')) as PlantBlueprintMatrix;
    expect(matrix.rows).toEqual([]);
    const out = YAML.parse(await s.api('GET', '/plant/export'));
    expect(JSON.stringify(out)).not.toContain('Asset level');
    expect(JSON.stringify(out)).not.toContain('blueprint_mappings');

    // the audit entry counts only the profile's own data
    const log = JSON.stringify(await s.api('GET', '/audit?action=blueprint.unassigned'));
    expect(log).toContain('"marksRemoved":1');
    expect(log).toContain('"mappingsRemoved":0');

    await s.api('PUT', '/plant/profiles/ctl-1/blueprints/alpha');
    const back = (await s.api('GET', '/plant/assets/m-0/blueprints')) as PlantBlueprintCoverageView;
    const sig = (id: string) => back.blueprints[0]!.signals.find((x) => x.signal.id === id)!;
    expect(sig('sig_2')).toMatchObject({ state: 'notApplicable', notApplicable: { reason: 'Asset level', on: 'asset' } });
    expect(sig('sig_0').points.map((p) => p.id)).toEqual(['energy_kwh']);
    await s.api('DELETE', '/plant/profiles/ctl-1/blueprints/alpha');
  });
});

describe('the matrix of a larger site', () => {
  it('does no suggestion work, while the asset view still suggests', async () => {
    for (const b of ['alpha', 'beta', 'gamma']) await s.api('PUT', `/plant/profiles/ctl-1/blueprints/${b}`);
    const asset = (await s.api('GET', '/plant/assets/m-1/blueprints')) as PlantBlueprintCoverageView;
    expect(asset.blueprints[0]!.totals.suggested).toBe(1);
    const started = Date.now();
    const m = (await s.api('GET', '/plant/views/blueprints')) as PlantBlueprintMatrix;
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(m.groups[0]!.assets).toBe(ASSETS);
    expect(m.blueprints).toHaveLength(3);
    expect(JSON.stringify(m)).not.toMatch(/"suggested":[1-9]/);
    // the work counted: suggestions are computed for no signal in the aggregate view
    const src = await import('../src/plant/blueprint-source.js');
    const scope = (await import('../src/plant/catalogue-access.js')).catalogueScope();
    const cov = src.blueprintSource(new Set(['m-1']), scope).of('m-1');
    expect(cov.every((c) => c.totals.suggested === 0)).toBe(true);
  });
});

describe('who set a mark an import brings', () => {
  const doc = (by: string, at: string) =>
    YAML.stringify({
      version: 1,
      assignments: [{ asset: 'm-3', profile: 'ctl-1', blueprint_not_applicable: [{ blueprint: 'beta', signal: 'sig_5', reason: 'Imported', by, at }] }],
    });
  const mark = async () => (await import('../src/plant/blueprint-store.js')).markOf('beta', { kind: 'asset', id: 'm-3' }, 'sig_5');

  it('is the importing user, now, unless an administrator restores an export', async () => {
    await dana('POST', '/plant/import', { files: [{ name: 'a.yaml', content: doc('somebody-else', '2001-02-03T04:05:06Z') }], mode: 'update' });
    const m = await mark();
    expect(m).toMatchObject({ by: 'dana', reason: 'Imported' });
    expect(m!.at.startsWith('2001')).toBe(false);
  });

  it('keeps by and at for an administrator when at is an ISO timestamp, and caps by', async () => {
    await s.api('DELETE', '/plant/assets/m-3/blueprints/beta/signals/sig_5/not-applicable');
    await s.api('POST', '/plant/import', { files: [{ name: 'a.yaml', content: doc('x'.repeat(150), '2001-02-03T04:05:06Z') }], mode: 'update' });
    expect(await mark()).toMatchObject({ by: 'x'.repeat(100), at: '2001-02-03T04:05:06.000Z' });
    await s.api('DELETE', '/plant/assets/m-3/blueprints/beta/signals/sig_5/not-applicable');
    await s.api('POST', '/plant/import', { files: [{ name: 'a.yaml', content: doc('restorer', 'yesterday') }], mode: 'update' });
    const m = await mark();
    expect(m!.by).toBe('restorer');
    expect(m!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m!.at.startsWith('2001')).toBe(false);
  });
});
