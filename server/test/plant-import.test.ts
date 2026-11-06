import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * YAML import and export of the plant registry (#218): the round trip with the invented two-site enterprise
 * (examples/plant), the three modes – add, update, replace with missing records removed or marked –, schema and model
 * errors with the place in the file, the size and depth limits, rights per site and the audit entry.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let vera: Client;
let dana: Client;
const PW = 'Plant-password-1';

type Doc = {
  version: number;
  assignments?: { asset: string }[];
  sites: {
    id: string;
    name: string;
    areas?: { id: string; work_centers?: { id: string; work_units?: { id: string }[] }[] }[];
    assets?: Record<string, unknown>[];
  }[];
};
const file = (name: string, content: string | object) => ({ name, content: typeof content === 'string' ? content : YAML.stringify(content) });
const exportYaml = async (site?: string) => {
  const res = await fetch(`${s.base}/api/plant/export${site ? `?site=${site}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-disposition')).toContain('.plant.yaml');
  return res.text();
};
/** The export without its header (it names the time) */
const body = (yaml: string) => yaml.replace(/^#.*\n/gm, '');
let token = '';
let demoImport = '';

const status = async (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'vera', roles: ['viewer'], password: PW });
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  vera = await s.as('vera', PW);
  dana = await s.as('dana', PW);
  token = (await s.api('POST', '/me/tokens', { name: 'export', scope: 'read' })).token;
  // turned on in demo mode (as every test server runs): the example enterprise is imported (add)
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  const imports = await s.api('GET', '/plant/imports');
  expect(imports).toHaveLength(1);
  demoImport = imports[0].id;
});
afterAll(async () => {
  await s?.app.close();
});

describe('round trip', () => {
  it('the example enterprise is imported with its hierarchy, buildings and assets', async () => {
    const [imp] = await s.api('GET', '/plant/imports');
    // part 1's enterprise (37 records) and part 2's profiles, KPI definitions and assignments (9, #219)
    expect(imp).toMatchObject({
      mode: 'add',
      counts: { add: 46, change: 0, remove: 0 },
      files: [{ name: 'brightwater.plant.yaml' }, { name: 'brightwater-data-points.plant.yaml' }],
      records: 46,
    });
    const site = await s.api('GET', '/plant/sites/riverside');
    expect(site).toMatchObject({ code: 'RVS', names: { de: 'Werk Riverside' }, geo: { lat: 52.3512, lon: 9.0531, zoom: 16 }, importId: demoImport });
    expect(site.areas.map((a: { id: string }) => a.id)).toEqual(['rvs-machining', 'rvs-assembly', 'rvs-utilities']);
    const test = await s.api('GET', '/plant/assets/rvs-test-bench-01');
    // the work unit names its floor: the innermost building wins over the area's hall
    expect(test.location).toMatchObject({
      area: { id: 'rvs-assembly' },
      workCenter: { id: 'rvs-final-assembly' },
      building: { id: 'rvs-hall-2-mezzanine' },
      buildingFrom: 'work_unit',
    });
    expect((await s.api('GET', '/plant/assets/rvs-mill-01')).children.map((c: { id: string }) => c.id)).toEqual(['rvs-mill-01-meter']);
    expect((await s.api('GET', '/plant/assets?site=hillcrest')).length).toBe(4);
  });

  it('export → import (replace) changes nothing, and the export stays the same', async () => {
    const first = await exportYaml();
    const doc = YAML.parse(first) as Doc;
    expect(doc).toMatchObject({ version: 1, enterprise: { name: 'Brightwater Components' } });
    expect(doc.sites.map((x) => x.id)).toEqual(['hillcrest', 'riverside']);
    const preview = await s.api('POST', '/plant/import/preview', {
      files: [file('tree.yaml', first)],
      mode: 'replace',
      replaces: demoImport,
      missing: 'remove',
    });
    expect(preview.problems).toEqual([]);
    expect(preview.counts).toEqual({ add: 0, change: 0, remove: 0, mark: 0, unchanged: 46, skip: 0 });
    await s.api('POST', '/plant/import', { files: [file('tree.yaml', first)], mode: 'replace', replaces: demoImport, missing: 'remove' });
    expect(body(await exportYaml())).toBe(body(first));
    // one site: its own file (site:)
    const one = YAML.parse(await exportYaml('hillcrest')) as { site: { id: string; assets: unknown[] }; sites?: unknown };
    expect(one.site.id).toBe('hillcrest');
    expect(one.sites).toBeUndefined();
    const again = await s.api('POST', '/plant/import/preview', { files: [file('hillcrest.yaml', one)], mode: 'update' });
    // the site, its buildings, areas, work centers, work units, assets – and the assignment of one asset (#219)
    expect(again.counts).toMatchObject({ add: 0, change: 0, unchanged: 1 + 2 + 2 + 2 + 3 + 4 + 1 });
  });

  it('the published JSON Schema is the one the import checks', async () => {
    const { plantJsonSchema } = await import('../src/plant/format.js');
    const published = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/plant/plant-registry-1.schema.json'), 'utf8'));
    expect(published, 'docs/plant/plant-registry-1.schema.json is stale: npm run plant:schema').toEqual(plantJsonSchema());
    expect(published.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(await s.api('GET', '/plant/schema')).toEqual(published);
  });
});

describe('modes', () => {
  let tree: Doc;
  let current = '';
  beforeAll(async () => {
    tree = YAML.parse(await exportYaml()) as Doc;
    current = (await s.api('GET', '/plant/imports'))[0].id;
  });
  const riverside = (d: Doc) => d.sites.find((x) => x.id === 'riverside')!;

  it('add only: new records are added, existing ones stay as they are', async () => {
    const d = structuredClone(tree);
    riverside(d).assets![0]!.name = 'Renamed';
    riverside(d).assets!.push({ id: 'rvs-new-01', name: 'New machine', location: { area: 'rvs-utilities' } });
    const p = await s.api('POST', '/plant/import/preview', { files: [file('a.yaml', d)], mode: 'add' });
    expect(p.counts).toMatchObject({ add: 1, change: 0, skip: 46 });
    expect(p.changes.find((c: { id: string }) => c.id === 'rvs-new-01')).toMatchObject({ kind: 'asset', action: 'add', siteId: 'riverside' });
    await s.api('POST', '/plant/import', { files: [file('a.yaml', d)], mode: 'add' });
    expect((await s.api('GET', `/plant/assets/${String(riverside(tree).assets![0]!.id)}`)).name).not.toBe('Renamed');
    expect((await s.api('GET', '/plant/assets/rvs-new-01')).location.area.id).toBe('rvs-utilities');
  });

  it('add and update: what the file says is overwritten, what it leaves out is kept', async () => {
    const p = await s.api('POST', '/plant/import/preview', {
      files: [file('names.yaml', { version: 1, assets: [{ id: 'rvs-mill-01', name: 'Milling centre 1 (5-axis)', location: { site: 'riverside' } }] })],
      mode: 'update',
    });
    expect(p.changes).toEqual([expect.objectContaining({ kind: 'asset', action: 'change', id: 'rvs-mill-01', fields: ['name'] })]);
    await s.api('POST', '/plant/import', {
      files: [file('names.yaml', { version: 1, assets: [{ id: 'rvs-mill-01', name: 'Milling centre 1 (5-axis)', location: { site: 'riverside' } }] })],
      mode: 'update',
    });
    const a = await s.api('GET', '/plant/assets/rvs-mill-01');
    expect(a).toMatchObject({ name: 'Milling centre 1 (5-axis)', manufacturer: 'Example Machine Tools', tags: ['cnc', 'milling'] });
    expect(a.refs).toHaveLength(2);
  });

  it('replace, keep and mark: missing records stay, marked "not in source"; back in the file, the mark goes', async () => {
    const d = structuredClone(tree);
    const r = riverside(d);
    r.assets = r.assets!.filter((x) => x.id !== 'rvs-compressor-01');
    const req = { files: [file('tree.yaml', d)], mode: 'replace', replaces: current, missing: 'mark' };
    const p = await s.api('POST', '/plant/import/preview', req);
    expect(p.problems).toEqual([]);
    // the name changed by the update import above is the file's again; the manual asset (rvs-new-01) is not the import's
    expect(p.changes.filter((c: { action: string }) => c.action !== 'unchanged')).toEqual([
      expect.objectContaining({ kind: 'asset', action: 'change', id: 'rvs-mill-01', fields: ['name'] }),
      expect.objectContaining({ kind: 'asset', action: 'mark', id: 'rvs-compressor-01' }),
    ]);
    const done = await s.api('POST', '/plant/import', req);
    expect(done.import).toMatchObject({ mode: 'replace', missing: 'mark', replaces: current, counts: { mark: 1, change: 1 } });
    expect(await s.api('GET', '/plant/assets/rvs-compressor-01')).toMatchObject({ notInSource: true, importId: done.import.id });
    expect((await s.api('GET', '/plant/assets/rvs-new-01')).notInSource).toBe(false);
    // the full file again: the record is in the source again
    const back = await s.api('POST', '/plant/import', { files: [file('tree.yaml', tree)], mode: 'replace', replaces: done.import.id, missing: 'mark' });
    expect(back.changes.find((c: { id: string }) => c.id === 'rvs-compressor-01')).toMatchObject({ action: 'change', fields: ['notInSource'] });
    expect((await s.api('GET', '/plant/assets/rvs-compressor-01')).notInSource).toBe(false);
    current = back.import.id;
  });

  it('replace and remove: what the earlier import wrote and the file lacks is removed; what people added stays', async () => {
    const d = structuredClone(tree);
    const r = riverside(d);
    // the milling line 2 with its cell and machine leave the file; the meter loses its parent machine
    const machining = r.areas!.find((a) => a.id === 'rvs-machining')!;
    machining.work_centers = machining.work_centers!.filter((w) => w.id !== 'rvs-mill-line-2');
    r.assets = r.assets!.filter((x) => x.id !== 'rvs-mill-03' && x.id !== 'rvs-mill-01');
    r.assets.find((x) => x.id === 'rvs-mill-01-meter')!.parent = null;
    // its assignment goes with it (#219)
    d.assignments = d.assignments!.filter((x) => x.asset !== 'rvs-mill-01');
    // a machine added by hand in the cell that goes
    await s.api('POST', '/plant/assets', { id: 'rvs-hand-01', siteId: 'riverside', name: 'Hand-made', workUnitId: 'rvs-mill-line-2-cell-1' });
    const req = { files: [file('tree.yaml', d)], mode: 'replace', replaces: current, missing: 'remove' };
    const p = await s.api('POST', '/plant/import/preview', req);
    expect(p.problems).toEqual([]);
    const removed = p.changes.filter((c: { action: string }) => c.action === 'remove').map((c: { kind: string; id: string }) => `${c.kind}:${c.id}`);
    expect(removed.sort()).toEqual(['asset:rvs-mill-01', 'asset:rvs-mill-03', 'work_center:rvs-mill-line-2', 'work_unit:rvs-mill-line-2-cell-1']);
    expect(p.changes.find((c: { id: string }) => c.id === 'rvs-hand-01')).toMatchObject({ action: 'change', note: 'names a record that is removed' });
    await s.api('POST', '/plant/import', req);
    expect(await status(s.api('GET', '/plant/assets/rvs-mill-03'))).toEqual({ status: 404, code: 'PLANT_ASSET_NOT_FOUND' });
    const hand = await s.api('GET', '/plant/assets/rvs-hand-01');
    // it keeps the levels that stay
    expect(hand.location).toMatchObject({ area: { id: 'rvs-machining' }, workCenter: null, workUnit: null });
    expect((await s.api('GET', '/plant/assets/rvs-new-01')).name).toBe('New machine');
    const site = await s.api('GET', '/plant/sites/riverside');
    expect(site.areas[0].children.map((c: { id: string }) => c.id)).toEqual(['rvs-mill-line-1']);
  });

  it('is audited with its counts and the files’ SHA-256', async () => {
    const [last] = await s.api('GET', '/audit?action=plant.imported&limit=1');
    expect(last.summary).toMatch(/replace, missing records removed\): 0 added, \d+ changed, 4 removed/);
    const crypto = await import('node:crypto');
    const content = YAML.stringify(tree);
    const p = await s.api('POST', '/plant/import/preview', { files: [file('x.yaml', content)], mode: 'add' });
    expect(p.files).toEqual([{ name: 'x.yaml', sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) }]);
  });

  it('takes several files: the hierarchy in one, assets in others', async () => {
    const files = [
      file('site.yaml', {
        version: 1,
        site: {
          id: 'eastfield',
          code: 'EFD',
          name: 'Eastfield',
          buildings: [{ id: 'efd-hall', name: 'Hall' }],
          areas: [{ id: 'efd-paint', name: 'Paint shop', building: 'efd-hall' }],
        },
      }),
      file('asset-1.yaml', { version: 1, assets: [{ id: 'efd-booth-1', name: 'Paint booth 1', location: { site: 'eastfield', area: 'efd-paint' } }] }),
      file('asset-2.yaml', {
        version: 1,
        assets: [{ id: 'efd-booth-2', name: 'Paint booth 2', location: { site: 'eastfield', area: 'efd-paint' }, children: ['efd-booth-1'] }],
      }),
    ];
    const r = await s.api('POST', '/plant/import', { files, mode: 'add' });
    expect(r.counts.add).toBe(5);
    expect((await s.api('GET', '/plant/assets/efd-booth-1')).parentId).toBe('efd-booth-2');
    expect((await s.api('GET', '/plant/assets/efd-booth-1')).location.building.id).toBe('efd-hall');
  });
});

describe('problems', () => {
  const preview = (files: { name: string; content: string }[], mode = 'add') => s.api('POST', '/plant/import/preview', { files, mode });
  const problems = async (content: string | object) =>
    ((await preview([file('bad.yaml', content)])).problems as { path: string; message: string }[]).map((p) => `${p.path}: ${p.message}`);

  it('schema errors name the place in the file and say what is expected', async () => {
    expect(await problems({ sites: [] })).toEqual(['version: Required: version: 1 (the format of the file)']);
    expect(
      await problems({
        version: 1,
        sites: [{ id: 'Bad Id', name: 'X', areas: [{ id: 'a', name: 'A', asset_role: 'x' }], assets: [{ id: 'm', name: 'M', status: 'running' }] }],
      }),
    ).toEqual([
      'sites[0].id: Use lower-case letters, digits, ".", "_" and "-", starting with a letter or digit (at most 80)',
      'sites[0].areas[0]: Unknown key "asset_role" (see docs/PLANT.md)',
      'sites[0].assets[0].status: Use one of: planned, commissioning, operational, maintenance, out_of_service, decommissioned',
    ]);
    expect(await problems('version: 1\nsites:\n  - id: a\n    name: [unclosed\n')).toEqual([expect.stringMatching(/^line \d+, column \d+: /)]);
    expect(await problems('version: 1\nversion: 1\n')).toEqual([expect.stringMatching(/unique/)]);
    expect(await problems({ version: 2 })).toEqual(['version: Use one of: 1']);
    expect(
      await problems({ version: 1, site: { id: 'w', name: 'W', areas: [{ id: 'a', name: 'A', work_centers: [{ id: 'c', name: 'C', type: 'work_cell' }] }] } }),
    ).toEqual(['site.areas[0].work_centers[0].type: Use one of: production_line, production_unit, process_cell, storage_zone']);
  });

  it('model errors: unknown places, the levels, twice the same id, equipment cycles', async () => {
    expect(
      await problems({
        version: 1,
        site: {
          id: 'west',
          name: 'West',
          buildings: [{ id: 'w-b', name: 'B', parent: 'w-b' }],
          areas: [{ id: 'w-a', name: 'A', building: 'nowhere', work_centers: [{ id: 'w-c', name: 'C', type: 'process_cell' }] }],
          assets: [
            { id: 'w-1', name: 'One', parent: 'w-2', location: { work_unit: 'w-c' } },
            { id: 'w-2', name: 'Two', parent: 'w-1' },
            { id: 'w-2', name: 'Again' },
          ],
        },
      }),
    ).toEqual([
      'site.assets[2]: Asset "w-2" is defined twice (also in bad.yaml at site.assets[1])',
      'site.buildings[0].parent: A building cannot be inside itself',
      'site.areas[0].building: There is no building "nowhere" in this site',
      'site.assets[0].location: "w-c" is a work center, not a work unit',
      'site.assets[0].parent: The equipment hierarchy has a cycle: w-1 → w-2 → w-1',
      'site.assets[1].parent: The equipment hierarchy has a cycle: w-2 → w-1 → w-2',
    ]);
    expect(await problems({ version: 1, assets: [{ id: 'z-1', name: 'Z' }] })).toEqual([
      'assets[0].location.site: Name the site of the asset (location.site), or list it below its site',
    ]);
    expect(await problems({ version: 1, assets: [{ id: 'z-1', name: 'Z', location: { site: 'nowhere' } }] })).toEqual([
      'assets[0].location.site: There is no site "nowhere"',
    ]);
    // applying a file with problems is refused
    expect(
      await status(s.api('POST', '/plant/import', { files: [file('bad.yaml', { version: 1, assets: [{ id: 'z-1', name: 'Z' }] })], mode: 'add' })),
    ).toEqual({
      status: 400,
      code: 'PLANT_IMPORT_INVALID',
    });
    // replace needs the earlier import
    expect((await s.api('POST', '/plant/import/preview', { files: [file('a.yaml', { version: 1 })], mode: 'replace' })).problems[0].message).toMatch(
      /earlier import/,
    );
  });

  it('size, keys and depth are limited like the other YAML importers', async () => {
    const big = `version: 1\n# ${'x'.repeat(9 * 1024 * 1024)}\n`;
    expect(await status(preview([file('big.yaml', big)]))).toMatchObject({ status: 413 });
    let deep = 'x: 1';
    for (let i = 0; i < 20; i++) deep = `a:\n${deep.replace(/^/gm, '  ')}`;
    expect(await problems(`version: 1\nfields:\n${deep.replace(/^/gm, '  ')}\n`)).toEqual(['(document): The document is nested deeper than 12 levels']);
    const keys = Array.from({ length: 30000 }, (_, i) => `  k${i}: 1`).join('\n');
    const t = Date.now();
    const r = await preview([file('keys.yaml', `version: 1\nx:\n${keys}\n`)]);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(r.problems[0].message).toMatch(/Unknown key "x"/);
  });

  it('rights: a viewer may not import or preview; nobody changes a site without the manage right', async () => {
    const tree = await exportYaml();
    // the preview needs the import's own right (adding sites or managing one): viewers and plant viewers have neither
    const { createUser } = await import('../src/auth/users.js');
    createUser({ username: 'pia', roles: ['plant'], password: PW });
    const pia = await s.as('pia', PW);
    for (const c of [vera, pia])
      expect(await status(c('POST', '/plant/import/preview', { files: [file('t.yaml', tree)], mode: 'update' }))).toEqual({ status: 403, code: 'FORBIDDEN' });
    // who may manage a site sees which ones they may not change
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [{ subject: 'user:vera', permissions: ['manage'] }] });
    const v = await vera('POST', '/plant/import/preview', { files: [file('t.yaml', tree)], mode: 'update' });
    expect(v.ok).toBe(false);
    expect(v.problems[0].message).toBe('You may not change site "eastfield"');
    // a new site reads like one the caller may not see
    expect(
      (await vera('POST', '/plant/import/preview', { files: [file('t.yaml', { version: 1, site: { id: 'mine', name: 'Mine' } })], mode: 'add' })).problems[0]
        .message,
    ).toBe('You may not add or change site "mine"');
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [{ subject: 'user:vera', permissions: ['view'] }] });
    const d = await dana('POST', '/plant/import/preview', { files: [file('t.yaml', tree)], mode: 'update' });
    expect(d.problems.map((p: { message: string }) => p.message)).toEqual(['You may not add or change site "hillcrest"']);
    // designers export what they see
    const res = await fetch(`${s.base}/api/plant/export`, {
      headers: { authorization: `Bearer ${(await dana('POST', '/me/tokens', { name: 'x', scope: 'read' })).token}` },
    });
    expect((YAML.parse(await res.text()) as Doc).sites.map((x) => x.id)).not.toContain('hillcrest');
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [] });
  });

  it('sites the caller may not see: an earlier import of them does not exist, their ids, codes and records are not named', async () => {
    const secret = await s.api('POST', '/plant/import', {
      files: [file('secret-works.yaml', { version: 1, site: { id: 'secret', code: 'SEC', name: 'Secret works', assets: [{ id: 'secret-1', name: 'S 1' }] } })],
      mode: 'add',
    });
    await s.api('PUT', '/plant/sites/secret/access', { acl: [{ subject: 'user:vera', permissions: ['view'] }] });
    const mine = { version: 1, site: { id: 'dana-site', name: 'Dana works' } };
    const p = await dana('POST', '/plant/import/preview', { files: [file('t.yaml', mine)], mode: 'replace', replaces: secret.import.id, missing: 'remove' });
    expect(p.replaces).toBeNull();
    expect(p.problems.map((x: { message: string }) => x.message)).toEqual(['Choose the earlier import this file replaces']);
    expect(JSON.stringify(p)).not.toMatch(/secret|admin/i);
    // who sees the site sees the import
    expect(
      (await s.api('POST', '/plant/import/preview', { files: [file('t.yaml', mine)], mode: 'replace', replaces: secret.import.id })).replaces,
    ).toMatchObject({
      id: secret.import.id,
      files: ['secret-works.yaml'],
    });
    // the site's code, an asset id in it and the site itself in a file: no hint that it is there
    const q = await dana('POST', '/plant/import/preview', {
      files: [file('t.yaml', { version: 1, sites: [{ id: 'dana-2', code: 'sec', name: 'D', assets: [{ id: 'secret-1', name: 'Mine' }] }] })],
      mode: 'add',
    });
    expect(q.problems.map((x: { path: string; message: string }) => `${x.path}: ${x.message}`).sort()).toEqual(
      ['sites[0].assets[0].id: You may not add or change asset "secret-1"', 'sites[0].code: Another site has the code sec already'].sort(),
    );
    const named = await dana('POST', '/plant/import/preview', { files: [file('t.yaml', { version: 1, site: { id: 'secret', name: 'X' } })], mode: 'update' });
    expect(named.problems.map((x: { message: string }) => x.message)).toEqual(['You may not add or change site "secret"']);
    // nor what the file would change there
    expect(named.changes).toEqual([]);

    // replace: what the earlier import wrote in a site the caller may not see is not named (an asset moved there by hand)
    const gv = await s.api('POST', '/plant/import', {
      files: [
        file('gv.yaml', {
          version: 1,
          site: {
            id: 'gv',
            name: 'GV',
            assets: [
              { id: 'gv-1', name: 'GV 1' },
              { id: 'gv-2', name: 'GV 2' },
            ],
          },
        }),
      ],
      mode: 'add',
    });
    await s.api('POST', '/plant/sites', { id: 'gh', name: 'GH' });
    await s.api('PUT', '/plant/assets/gv-2', { siteId: 'gh', name: 'GV 2' });
    await s.api('PUT', '/plant/sites/gv/access', { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
    await s.api('PUT', '/plant/sites/gh/access', { acl: [{ subject: 'user:vera', permissions: ['view'] }] });
    const g = await dana('POST', '/plant/import/preview', {
      files: [file('gv.yaml', { version: 1, site: { id: 'gv', name: 'GV' } })],
      mode: 'replace',
      replaces: gv.import.id,
      missing: 'remove',
    });
    expect(g.replaces).toMatchObject({ id: gv.import.id });
    expect(g.warnings.map((x: { message: string }) => x.message)).toEqual(['asset "gv-1" is not in the files, but you may not change site "gv": it stays']);
    expect(JSON.stringify(g)).not.toMatch(/gv-2|"gh"/);
    for (const id of ['secret', 'gv', 'gh']) {
      for (const a of await s.api('GET', `/plant/assets?site=${id}`)) await s.api('DELETE', `/plant/assets/${a.id}`);
      await s.api('DELETE', `/plant/sites/${id}`);
    }
  });

  it('answers 404 while the module is off', async () => {
    await s.api('PUT', '/settings/plant', { enabled: false, enterprise: 'Brightwater Components', labels: {}, fields: {} });
    expect(await status(preview([file('a.yaml', { version: 1 })]))).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  });
});
