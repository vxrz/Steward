import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The plant registry module (#218): the switch, the model rules (ISA-95 levels, the innermost building wins, the
 * equipment hierarchy has no cycles), rights per site, links and duplicates. The YAML import and export are in
 * plant-import.test.ts.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const EXAMPLE = fs.readFileSync(path.resolve(__dirname, '../../examples/plant/brightwater.plant.yaml'), 'utf8');

const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );

const enable = (enabled = true) => s.api('PUT', '/settings/plant', { enabled, enterprise: 'Brightwater Components', labels: {}, fields: {} });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['vera', 'viewer'],
    ['pia', 'plant'],
    ['stella', 'status'],
    ['audrey', 'auditor'],
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
  it('is off by default: every route answers 404 PLANT_MODULE_OFF, links offer no plant kinds', async () => {
    expect((await s.api('GET', '/settings/plant')).enabled).toBe(false);
    for (const url of [
      '/plant/sites',
      '/plant/assets',
      '/plant/config',
      '/plant/hierarchy',
      '/plant/imports',
      '/plant/schema',
      '/plant/export',
      '/plant/sites/x',
      '/plant/assets/x',
    ])
      expect(await status(s.api('GET', url)), url).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    expect(await status(s.api('POST', '/plant/sites', { id: 'x', name: 'X' }))).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    expect(await status(s.api('POST', '/plant/import/preview', { files: [{ name: 'a.yaml', content: 'version: 1' }], mode: 'add' }))).toMatchObject({
      status: 404,
    });
    expect(await s.api('GET', '/link-targets?kind=site&q=')).toEqual([]);
    expect((await s.api('GET', '/auth/status')).me.capabilities.plant).toBe(false);
  });

  it('only administrators turn it on; turning it on is audited (and loads the demo enterprise in demo mode)', async () => {
    expect(await status(users.dana!('PUT', '/settings/plant', { enabled: true }))).toMatchObject({ status: 403 });
    await enable();
    expect((await s.api('GET', '/auth/status')).me.capabilities.plant).toBe(true);
    expect((await s.api('GET', '/plant/sites')).map((x: { id: string }) => x.id)).toEqual(['hillcrest', 'riverside']);
    expect((await users.pia!('GET', '/auth/status')).me.capabilities.plant).toBe(true);
    // status viewers never see the module
    expect((await users.stella!('GET', '/auth/status')).me.capabilities.plant).toBe(false);
    expect(await status(users.stella!('GET', '/plant/sites'))).toMatchObject({ status: 403 });
    const log = await s.api('GET', '/audit?action=plant.module_enabled');
    expect(log.length).toBeGreaterThan(0);
  });
});

describe('model rules', () => {
  it('a site with its ISA-95 hierarchy; the innermost building wins', async () => {
    await s.api('POST', '/plant/sites', { id: 'alpha', code: 'ALP', name: 'Alpha Works', names: { de: 'Werk Alpha' }, geo: { lat: 50.1, lon: 8.2 } });
    expect(await status(s.api('POST', '/plant/sites', { id: 'alpha2', code: 'alp', name: 'Again' }))).toEqual({ status: 409, code: 'PLANT_SITE_CODE_TAKEN' });
    expect(await status(s.api('POST', '/plant/sites', { id: 'Bad Id', name: 'X' }))).toMatchObject({ status: 400 });
    await s.api('POST', '/plant/sites/alpha/buildings', { id: 'h1', name: 'Hall 1', kind: 'hall' });
    await s.api('POST', '/plant/sites/alpha/buildings', { id: 'h2', name: 'Hall 2', kind: 'hall' });
    await s.api('POST', '/plant/sites/alpha/nodes', { id: 'machining', level: 'area', name: 'Machining', domain: 'machining', buildingId: 'h1' });
    await s.api('POST', '/plant/sites/alpha/nodes', { id: 'line-1', level: 'work_center', parentId: 'machining', name: 'Line 1', type: 'production_line' });
    await s.api('POST', '/plant/sites/alpha/nodes', { id: 'line-2', level: 'work_center', parentId: 'machining', name: 'Line 2', buildingId: 'h2' });
    const site = await s.api('POST', '/plant/sites/alpha/nodes', { id: 'cell-a', level: 'work_unit', parentId: 'line-2', name: 'Cell A' });
    const machining = site.areas[0];
    expect(machining.effectiveBuildingId).toBe('h1');
    expect(machining.children.map((c: { id: string; effectiveBuildingId: string }) => [c.id, c.effectiveBuildingId])).toEqual([
      ['line-1', 'h1'],
      ['line-2', 'h2'],
    ]);
    expect(machining.children[1].children[0]).toMatchObject({ id: 'cell-a', effectiveBuildingId: 'h2' });
    // the levels: a work unit belongs below a work center, an ISA-95 type of the level, a building of the site
    expect(await status(s.api('POST', '/plant/sites/alpha/nodes', { id: 'x1', level: 'work_unit', parentId: 'machining', name: 'X' }))).toEqual({
      status: 400,
      code: 'PLANT_NODE_PARENT',
    });
    expect(await status(s.api('POST', '/plant/sites/alpha/nodes', { id: 'x2', level: 'area', parentId: 'machining', name: 'X' }))).toEqual({
      status: 400,
      code: 'PLANT_NODE_PARENT',
    });
    expect(
      await status(s.api('POST', '/plant/sites/alpha/nodes', { id: 'x3', level: 'work_center', parentId: 'machining', name: 'X', type: 'work_cell' })),
    ).toEqual({
      status: 400,
      code: 'PLANT_NODE_TYPE',
    });
    expect(await status(s.api('POST', '/plant/sites/alpha/nodes', { id: 'x4', level: 'area', name: 'X', buildingId: 'nope' }))).toEqual({
      status: 400,
      code: 'PLANT_BUILDING_UNKNOWN',
    });
    // a building part cannot be inside itself
    await s.api('POST', '/plant/sites/alpha/buildings', { id: 'h2-floor', name: 'Floor', kind: 'floor', parentId: 'h2' });
    expect(await status(s.api('PUT', '/plant/sites/alpha/buildings/h2', { name: 'Hall 2', kind: 'hall', parentId: 'h2-floor' }))).toEqual({
      status: 400,
      code: 'PLANT_BUILDING_CYCLE',
    });
  });

  it('an asset: the innermost node decides its location, its own building overrides', async () => {
    const a = await s.api('POST', '/plant/assets', { id: 'mill-1', siteId: 'alpha', name: 'Mill 1', workUnitId: 'cell-a', tags: ['CNC', 'cnc', 'milling'] });
    expect(a.location).toMatchObject({
      area: { id: 'machining' },
      workCenter: { id: 'line-2' },
      workUnit: { id: 'cell-a' },
      building: { id: 'h2' },
      buildingFrom: 'work_center',
    });
    expect(a.tags).toEqual(['CNC', 'milling']);
    const b = await s.api('POST', '/plant/assets', { id: 'mill-2', siteId: 'alpha', name: 'Mill 2', workCenterId: 'line-1', buildingId: 'h2' });
    expect(b.location).toMatchObject({ area: { id: 'machining' }, building: { id: 'h2' }, buildingFrom: 'asset' });
    const c = await s.api('POST', '/plant/assets', { id: 'mill-3', siteId: 'alpha', name: 'Mill 3', areaId: 'machining' });
    expect(c.location).toMatchObject({ area: { id: 'machining' }, workCenter: null, building: { id: 'h1' }, buildingFrom: 'area' });
    expect(
      await status(
        s.api('POST', '/plant/assets', {
          id: 'mill-4',
          siteId: 'alpha',
          name: 'Mill 4',
          areaId: 'machining',
          workCenterId: 'line-2',
          workUnitId: 'cell-a',
          buildingId: 'h9',
        }),
      ),
    ).toEqual({ status: 400, code: 'PLANT_BUILDING_UNKNOWN' });
    await s.api('POST', '/plant/sites', { id: 'beta', name: 'Beta Plant' });
    await s.api('POST', '/plant/sites/beta/nodes', { id: 'other', level: 'area', name: 'Other' });
    expect(await status(s.api('POST', '/plant/assets', { id: 'mill-5', siteId: 'alpha', name: 'X', workCenterId: 'line-1', areaId: 'other' }))).toEqual({
      status: 400,
      code: 'PLANT_LOCATION_UNKNOWN',
    });
    expect(await status(s.api('POST', '/plant/assets', { id: 'mill-5', siteId: 'alpha', name: 'X', workUnitId: 'cell-a', workCenterId: 'line-1' }))).toEqual({
      status: 400,
      code: 'PLANT_LOCATION_MISMATCH',
    });
    expect(await status(s.api('POST', '/plant/assets', { id: 'mill-1', siteId: 'alpha', name: 'Twice' }))).toEqual({ status: 409, code: 'PLANT_ID_TAKEN' });
    // moving a work center to another area takes its assets along
    await s.api('POST', '/plant/sites/alpha/nodes', { id: 'assembly', level: 'area', name: 'Assembly' });
    await s.api('PUT', '/plant/sites/alpha/nodes/line-2', { parentId: 'assembly', name: 'Line 2', buildingId: 'h2' });
    expect((await s.api('GET', '/plant/assets/mill-1')).location.area.id).toBe('assembly');
    // a node that holds assets or nodes stays
    expect(await status(s.api('DELETE', '/plant/sites/alpha/nodes/line-2'))).toEqual({ status: 409, code: 'PLANT_NODE_IN_USE' });
    expect(await status(s.api('DELETE', '/plant/sites/alpha/buildings/h2'))).toEqual({ status: 409, code: 'PLANT_BUILDING_IN_USE' });
    expect(await status(s.api('DELETE', '/plant/sites/alpha'))).toEqual({ status: 409, code: 'PLANT_SITE_HAS_ASSETS' });
  });

  it('the equipment hierarchy has no cycles and stays in its site', async () => {
    await s.api('PUT', '/plant/assets/mill-2', { siteId: 'alpha', name: 'Mill 2', workCenterId: 'line-1', parentId: 'mill-1' });
    await s.api('PUT', '/plant/assets/mill-3', { siteId: 'alpha', name: 'Mill 3', areaId: 'machining', parentId: 'mill-2' });
    expect(await status(s.api('PUT', '/plant/assets/mill-1', { siteId: 'alpha', name: 'Mill 1', workUnitId: 'cell-a', parentId: 'mill-3' }))).toEqual({
      status: 400,
      code: 'PLANT_EQUIPMENT_CYCLE',
    });
    expect(await status(s.api('PUT', '/plant/assets/mill-1', { siteId: 'alpha', name: 'Mill 1', workUnitId: 'cell-a', parentId: 'mill-1' }))).toEqual({
      status: 400,
      code: 'PLANT_EQUIPMENT_CYCLE',
    });
    await s.api('POST', '/plant/assets', { id: 'beta-1', siteId: 'beta', name: 'Beta 1' });
    expect(await status(s.api('PUT', '/plant/assets/mill-1', { siteId: 'alpha', name: 'Mill 1', workUnitId: 'cell-a', parentId: 'beta-1' }))).toEqual({
      status: 400,
      code: 'PLANT_PARENT_OTHER_SITE',
    });
    const mill1 = await s.api('GET', '/plant/assets/mill-1');
    expect(mill1.children.map((c: { id: string }) => c.id)).toEqual(['mill-2']);
    expect((await s.api('GET', '/plant/assets/mill-2')).parent).toMatchObject({ id: 'mill-1', visible: true });
    // deleting a parent: its children stay, without a parent
    await s.api('DELETE', '/plant/assets/mill-1');
    expect((await s.api('GET', '/plant/assets/mill-2')).parentId).toBeNull();
  });

  it('own fields follow their schema in the settings', async () => {
    await s.api('PUT', '/settings/plant', {
      enabled: true,
      enterprise: 'Brightwater Components',
      labels: { asset: { en: { one: 'Machine', other: 'Machines' } } },
      fields: {
        asset: [
          { key: 'cost_center', label: 'Cost center', kind: 'text', required: false },
          { key: 'criticality', label: 'Criticality', kind: 'select', options: ['low', 'high'] },
          { key: 'power_kw', label: 'Power (kW)', kind: 'number' },
        ],
      },
    });
    const a = await s.api('PUT', '/plant/assets/mill-2', {
      siteId: 'alpha',
      name: 'Mill 2',
      workCenterId: 'line-1',
      fields: { cost_center: 4711, criticality: 'high', power_kw: 22 },
    });
    expect(a.fields).toEqual({ cost_center: '4711', criticality: 'high', power_kw: 22 });
    expect(await status(s.api('PUT', '/plant/assets/mill-2', { siteId: 'alpha', name: 'Mill 2', fields: { criticality: 'medium' } }))).toEqual({
      status: 400,
      code: 'PLANT_FIELD_INVALID',
    });
    expect(await status(s.api('PUT', '/plant/assets/mill-2', { siteId: 'alpha', name: 'Mill 2', fields: { unknown_key: 'x' } }))).toEqual({
      status: 400,
      code: 'PLANT_FIELD_INVALID',
    });
    expect(
      await status(s.api('PUT', '/settings/plant', { enabled: true, fields: { asset: [{ key: 'x', label: 'X', kind: 'select', options: [] }] } })),
    ).toEqual({
      status: 400,
      code: 'PLANT_FIELD_OPTIONS',
    });
    const cfg = await users.vera!('GET', '/plant/config');
    expect(cfg.labels.asset.en).toEqual({ one: 'Machine', other: 'Machines' });
    expect(cfg.canCreateSites).toBe(false);
  });

  it('an image is a PNG, JPEG or WebP (never SVG), served inert', async () => {
    const { tinyPng } = await import('./png.js');
    const data = tinyPng();
    const a = await s.api('PUT', '/plant/assets/mill-2/image', { contentBase64: data.toString('base64') });
    expect(a.image).toMatchObject({ mime: 'image/png', width: 1, height: 1 });
    const res = await fetch(`${s.base}/api/plant/assets/mill-2/image`, { headers: { 'x-sm-client': '1' } });
    expect(res.status).toBe(401);
    expect(await status(s.api('PUT', '/plant/assets/mill-2/image', { contentBase64: Buffer.from('<svg onload="x()"></svg>').toString('base64') }))).toEqual({
      status: 400,
      code: 'PLANT_IMAGE_SVG',
    });
    expect((await s.api('DELETE', '/plant/assets/mill-2/image')).image).toBeNull();
  });
});

describe('rights per site', () => {
  it('everyone working in Steward sees a site; designers and administrators manage it; the Plant viewer only sees', async () => {
    for (const u of ['vera', 'pia', 'audrey', 'olaf', 'dana'])
      expect(
        (await users[u]!('GET', '/plant/sites')).map((x: { id: string }) => x.id),
        u,
      ).toContain('alpha');
    expect((await users.dana!('GET', '/plant/sites/alpha')).permissions).toEqual(['view', 'manage']);
    expect((await users.pia!('GET', '/plant/sites/alpha')).permissions).toEqual(['view']);
    expect(await status(users.pia!('PUT', '/plant/sites/alpha', { name: 'Changed' }))).toMatchObject({ status: 403 });
    expect(await status(users.vera!('POST', '/plant/assets', { id: 'v-1', siteId: 'alpha', name: 'V' }))).toMatchObject({ status: 403 });
    expect(await status(users.pia!('POST', '/plant/sites', { id: 'p-site', name: 'P' }))).toMatchObject({ status: 403 });
    // the Plant viewer role gives nothing else
    expect(await users.pia!('GET', '/processes')).toEqual([]);
    expect(await status(users.pia!('GET', '/audit'))).toMatchObject({ status: 403 });
  });

  it('an access list restricts a site to its entries; its assets follow', async () => {
    await s.api('PUT', '/plant/sites/beta/access', {
      acl: [
        { subject: 'user:pia', permissions: ['view'] },
        { subject: 'user:olaf', permissions: ['manage'] },
      ],
    });
    expect((await users.vera!('GET', '/plant/sites')).map((x: { id: string }) => x.id)).not.toContain('beta');
    expect(await status(users.vera!('GET', '/plant/sites/beta'))).toEqual({ status: 404, code: 'PLANT_SITE_NOT_FOUND' });
    expect(await status(users.vera!('GET', '/plant/assets/beta-1'))).toEqual({ status: 404, code: 'PLANT_ASSET_NOT_FOUND' });
    expect((await users.vera!('GET', '/plant/assets')).map((x: { id: string }) => x.id)).not.toContain('beta-1');
    // designers too: the list decides
    expect(await status(users.dana!('PUT', '/plant/sites/beta', { name: 'Beta Plant' }))).toMatchObject({ status: 404 });
    expect((await users.pia!('GET', '/plant/sites/beta')).permissions).toEqual(['view']);
    // manage includes view
    expect((await users.olaf!('GET', '/plant/sites/beta')).permissions).toEqual(['view', 'manage']);
    await users.olaf!('POST', '/plant/assets', { id: 'beta-2', siteId: 'beta', name: 'Beta 2' });
    // auditors see every site
    expect((await users.audrey!('GET', '/plant/sites')).map((x: { id: string }) => x.id)).toContain('beta');
    // the access list is never shown to who only sees the site
    expect((await users.pia!('GET', '/plant/sites/beta')).acl).toBeNull();
    const log = await s.api('GET', '/audit?action=site.access_changed');
    expect(log[0].summary).toMatch(/restricted to 2 entries/);
  });

  it('owning teams scope a site like other resources', async () => {
    const team = await s.api('POST', '/teams', { name: 'Riverside team', members: ['vera'] });
    await s.api('PUT', '/plant/sites/alpha/access', { acl: [] });
    await s.api('PUT', `/owning-teams/site/alpha`, { teamIds: [team.id] });
    expect((await users.vera!('GET', '/plant/sites')).map((x: { id: string }) => x.id)).toContain('alpha');
    expect((await users.pia!('GET', '/plant/sites')).map((x: { id: string }) => x.id)).not.toContain('alpha');
    const why = await s.api('GET', '/access/explain?kind=site&id=alpha&user=vera');
    expect(why.permissions).toEqual(['view']);
    await s.api('PUT', `/owning-teams/site/alpha`, { teamIds: [] });
  });
});

describe('links', () => {
  it('records, services and tickets link to sites and assets; an asset links to systems; readers see what they may', async () => {
    const sys = await s.api('POST', '/systems', { name: 'Line PLC gateway', kind: 'appliance' });
    await s.api('POST', '/plant/assets/mill-2/links', { kind: 'system', id: sys.id, note: 'sends machine data' });
    const backlinks = (await s.api('GET', `/systems/${sys.id}`)).backlinks;
    expect(backlinks).toEqual([expect.objectContaining({ kind: 'asset', id: 'mill-2', label: 'Mill 2', path: '/plant/assets/mill-2' })]);
    const svcEntry = await s.api('POST', '/services', { name: 'Machine data', owners: [] });
    await s.api('POST', `/services/${svcEntry.id}/links`, { kind: 'asset', id: 'beta-1', note: '' });
    await s.api('POST', `/services/${svcEntry.id}/links`, { kind: 'site', id: 'alpha', note: '' });
    const seen = await users.vera!('GET', `/services/${svcEntry.id}`);
    // beta is restricted: vera sees that a link is there, not where it leads
    expect(seen.links.map((l: { kind: string; visible: boolean; targetId: string | null }) => [l.kind, l.visible, l.targetId])).toEqual([
      ['asset', false, null],
      ['site', true, 'alpha'],
    ]);
    expect((await users.pia!('GET', '/plant/assets/beta-1')).backlinks.map((b: { kind: string }) => b.kind)).toEqual(['service']);
    expect((await s.api('GET', '/link-targets?kind=asset&q=mill-')).map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(['mill-2', 'mill-3']));
    // turned off, nothing resolves – and comes back when turned on again
    await enable(false);
    expect((await s.api('GET', `/services/${svcEntry.id}`)).links.every((l: { visible: boolean }) => !l.visible)).toBe(true);
    expect((await s.api('GET', `/systems/${sys.id}`)).backlinks).toEqual([]);
    await enable(true);
    expect((await s.api('GET', `/services/${svcEntry.id}`)).links.every((l: { visible: boolean }) => l.visible)).toBe(true);
  });

  it('an asset can be duplicated: attributes and location, not its external references', async () => {
    await s.api('PUT', '/plant/assets/mill-3', {
      siteId: 'alpha',
      name: 'Mill 3',
      areaId: 'machining',
      manufacturer: 'Example Machine Tools',
      refs: [{ system: 'erp', id: '42' }],
      tags: ['cnc'],
    });
    const sug = await s.api('GET', '/duplicates/asset/mill-3');
    expect(sug).toMatchObject({ key: 'mill-3-copy', accessApplies: false });
    const copy = await s.api('POST', '/plant/assets/mill-3/duplicate', { name: 'Mill 4', key: 'mill-4' });
    expect(copy).toMatchObject({ id: 'mill-4', path: '/plant/assets/mill-4' });
    const a = await s.api('GET', '/plant/assets/mill-4');
    expect(a).toMatchObject({ name: 'Mill 4', manufacturer: 'Example Machine Tools', tags: ['cnc'], refs: [], location: { area: { id: 'machining' } } });
    expect(await status(users.pia!('POST', '/plant/assets/mill-3/duplicate', {}))).toMatchObject({ status: 403 });
  });
});

describe('public API', () => {
  it('lists sites and assets for a token; 404 while the module is off', async () => {
    const t = await s.api('POST', '/me/tokens', { name: 'plant', scope: 'read' });
    const v1 = (url: string) => fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${t.token}` } });
    const sites = await (await v1('/plant/sites')).json();
    // the demo (SM_DEMO=1 in the tests) loads its enterprise when the module is turned on
    expect(sites.items.map((x: { id: string }) => x.id)).toEqual(['alpha', 'beta', 'hillcrest', 'riverside']);
    const site = await (await v1('/plant/sites/alpha')).json();
    expect(site.areas.map((a: { id: string }) => a.id)).toEqual(['machining', 'assembly']);
    const assets = await (await v1('/plant/assets?site=alpha&ref=erp:42')).json();
    expect(assets.items.map((x: { id: string }) => x.id)).toEqual(['mill-3']);
    expect(assets.items[0].externalRefs).toEqual([{ system: 'erp', id: '42', url: '', label: '' }]);
    const one = await (await v1('/plant/assets/mill-2')).json();
    expect(one).toMatchObject({ id: 'mill-2', links: [expect.objectContaining({ kind: 'system' })] });
    await enable(false);
    const off = await v1('/plant/sites');
    expect(off.status).toBe(404);
    expect(off.headers.get('content-type')).toContain('problem+json');
    await enable(true);
  });
});

describe('the example enterprise', () => {
  it('is valid', () => {
    const doc = YAML.parse(EXAMPLE) as { sites: { assets: unknown[] }[] };
    expect(doc.sites).toHaveLength(2);
    expect(doc.sites.flatMap((x) => x.assets).length).toBeGreaterThanOrEqual(10);
  });
});
