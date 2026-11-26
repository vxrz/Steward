import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { PlantBlueprintCoverageView, PlantImportPreview } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Machine blueprints in the plant YAML (0.30.0, ADR 0041): the `blueprint:` document kind, the keys of profiles and
 * assignments, export and import back, the JSON Schema, warnings for names that lead nowhere, and ids that follow a rename.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const file = (name: string, content: object) => ({ name, content: YAML.stringify(content) });
const imp = (files: { name: string; content: string }[]) => s.api('POST', '/plant/import', { files, mode: 'update' });

const DOC = {
  version: 1,
  blueprints: [
    {
      id: 'compressor',
      name: 'Compressor',
      reference: 'Own experience',
      version: '2',
      signals: [
        { id: 'pressure', name: 'Pressure', meaning: 'Outlet pressure', why: ['quality', 'safety'], importance: 'must', aliases: ['bar'] },
        { id: 'run_hours', name: 'Run hours', importance: 'should' },
        { id: 'leakage', name: 'Leakage', importance: 'nice' },
      ],
    },
  ],
  sites: [{ id: 'west', name: 'West works', assets: [{ id: 'comp-1', name: 'Compressor 1' }] }],
  device_profiles: [
    {
      id: 'comp-ctl',
      name: 'Example compressor controller',
      blueprints: ['compressor', 'ghost'],
      blueprint_mappings: [{ blueprint: 'compressor', signal: 'pressure', data_points: ['p_out', 'nope'] }],
      blueprint_not_applicable: [{ blueprint: 'compressor', signal: 'leakage', reason: 'Not measured on this model' }],
      interfaces: [
        { id: 'mb', name: 'Modbus', protocol: 'modbus_tcp', groups: [{ name: 'g', data_points: [{ id: 'p_out', name: 'Pressure', data_type: 'Float' }] }] },
      ],
    },
  ],
  assignments: [
    { asset: 'comp-1', profile: 'comp-ctl', blueprint_not_applicable: [{ blueprint: 'compressor', signal: 'run_hours', reason: 'Counted by the plant PLC' }] },
  ],
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Plant AG', labels: {}, fields: {} });
});
afterAll(async () => {
  await s?.app.close();
});

describe('the blueprint document kind', () => {
  it('is part of the JSON Schema', async () => {
    const { plantJsonSchema } = await import('../src/plant/format.js');
    const j = JSON.stringify(plantJsonSchema());
    for (const k of ['MachineBlueprint', 'BlueprintSignal', 'blueprint_mappings', 'blueprint_not_applicable']) expect(j).toContain(k);
  });

  it('imports with warnings for unknown names and exports back unchanged', async () => {
    const preview = (await s.api('POST', '/plant/import/preview', { files: [file('a.yaml', DOC)], mode: 'update' })) as PlantImportPreview;
    expect(preview.problems).toEqual([]);
    expect(preview.blueprints).toMatchObject({ added: 1, changed: 0 });
    expect(preview.warnings.map((w) => w.message).join('\n')).toContain('"ghost" not found');
    expect(preview.warnings.map((w) => w.message).join('\n')).toContain('Data point "nope" not found');
    // a preview wrote nothing
    expect(await s.api('GET', '/plant/blueprints')).toEqual([]);
    await imp([file('a.yaml', DOC)]);
    const asset = (await s.api('GET', '/plant/assets/comp-1/blueprints')) as PlantBlueprintCoverageView;
    const sig = (id: string) => asset.blueprints[0]!.signals.find((x) => x.signal.id === id)!;
    expect(sig('pressure').points.map((p) => p.id)).toEqual(['p_out']);
    expect(sig('leakage')).toMatchObject({ state: 'notApplicable', notApplicable: { on: 'profile' } });
    expect(sig('run_hours')).toMatchObject({ state: 'notApplicable', notApplicable: { on: 'asset', reason: 'Counted by the plant PLC' } });

    const out = YAML.parse(await s.api('GET', '/plant/export'));
    expect(out.blueprints[0]).toMatchObject({ id: 'compressor', reference: 'Own experience', version: '2' });
    expect(out.blueprints[0].signals[0]).toMatchObject({ id: 'pressure', why: ['quality', 'safety'], importance: 'must', aliases: ['bar'] });
    const profile = out.device_profiles.find((p: { id: string }) => p.id === 'comp-ctl');
    expect(profile.blueprints).toEqual(['compressor']);
    expect(profile.blueprint_mappings).toEqual([{ blueprint: 'compressor', signal: 'pressure', data_points: ['p_out'] }]);
    expect(profile.blueprint_not_applicable[0]).toMatchObject({ signal: 'leakage', reason: 'Not measured on this model', by: expect.any(String) });
    expect(out.assignments[0].blueprint_not_applicable[0]).toMatchObject({ signal: 'run_hours' });
    // importing the export again changes nothing
    const again = (await s.api('POST', '/plant/import/preview', {
      files: [{ name: 'out.yaml', content: YAML.stringify(out) }],
      mode: 'update',
    })) as PlantImportPreview;
    expect(again.ok).toBe(true);
    expect(again.blueprints).toMatchObject({ added: 0, changed: 0, unchanged: 1, targets: 0 });
    expect(again.warnings).toEqual([]);
  });

  it('a list given replaces the stored one; a data point renamed in the profile moves the mapping', async () => {
    await imp([
      file('b.yaml', {
        version: 1,
        device_profiles: [{ id: 'comp-ctl', name: 'Example compressor controller', blueprints: ['compressor'], blueprint_mappings: [] }],
      }),
    ]);
    const p = (await s.api('GET', '/plant/profiles/comp-ctl/blueprints')) as PlantBlueprintCoverageView;
    expect(p.blueprints[0]!.totals).toMatchObject({ covered: 0, notApplicable: 1 });
    await s.api('PUT', '/plant/profiles/comp-ctl/blueprints/compressor/signals/pressure/mapping', { dataPoints: ['p_out'] });
    await s.api('POST', '/plant/ids/rename', { kind: 'data_point', scope: 'comp-ctl', id: 'p_out', newId: 'p_outlet' });
    const after = (await s.api('GET', '/plant/profiles/comp-ctl/blueprints')) as PlantBlueprintCoverageView;
    expect(after.blueprints[0]!.signals[0]!.points.map((x) => x.id)).toEqual(['p_outlet']);
    await s.api('POST', '/plant/ids/rename', { kind: 'asset', scope: '', id: 'comp-1', newId: 'comp-9' });
    expect(
      ((await s.api('GET', '/plant/assets/comp-9/blueprints')) as PlantBlueprintCoverageView).blueprints[0]!.signals.find((x) => x.signal.id === 'run_hours')!
        .state,
    ).toBe('notApplicable');
  });
});
