import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Steward systems and platforms in zones (0.20, docs/PLANT.md#steward-items-in-zones): a zone lists the systems and
 * platforms in it – cloud services and enterprise systems without a VLAN of the site –, not exclusively (one in the
 * External zone of every site). Who manages the site changes it; adding one needs to see it; one the reader may not
 * see is counted, never named, and kept by a save or an import of who may not see it. File format, export, API v1.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client;
let cloud = '';
let secret = '';
let iot = '';
const status = async (p: Promise<unknown>): Promise<{ status: number; message?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { params?: { message?: string } } }) => ({
      status: e.status,
      ...(e.body?.params?.message ? { message: e.body.params.message } : {}),
    }),
  );
const zoneOf = async (site: string, id: string, c: Client = s.api) =>
  (await c('GET', `/plant/sites/${site}/network`)).zones.find((z: { id: string }) => z.id === id);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: 'Plant-password-1' });
  dana = await s.as('dana', 'Plant-password-1');
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  const files = ['brightwater.plant.yaml', 'brightwater-ot-network.plant.yaml'].map((name) => ({
    name,
    content: fs.readFileSync(path.resolve(__dirname, '../../examples/plant', name), 'utf8'),
  }));
  await s.api('POST', '/plant/import', { files, mode: 'add' });
  cloud = (await s.api('POST', '/systems', { name: 'Invented cloud historian', kind: 'server' })).id;
  iot = (await s.api('POST', '/platforms', { name: 'Invented IoT platform', kind: 'generic', baseUrl: 'http://127.0.0.1:9/api' })).id;
  // a platform only administrators may use: designers do not see it
  secret = (await s.api('POST', '/platforms', { name: 'Invented secret platform', kind: 'generic', baseUrl: 'http://127.0.0.1:9/api' })).id;
  await s.api('PUT', `/platforms/${secret}/access`, { acl: [{ subject: 'role:admin', permissions: ['use', 'manage'] }] });
});

describe('Steward items in zones', () => {
  it('a zone lists systems and platforms, in zones of several sites; audited as a zone change', async () => {
    await dana('POST', '/plant/sites/riverside/zones', { id: 'rvs-ext', name: 'External', level: 'external', systems: [cloud], platforms: [iot] });
    await dana('POST', '/plant/sites/hillcrest/zones', { id: 'hc-ext', name: 'External', level: 'external', platforms: [iot] });
    expect(await zoneOf('riverside', 'rvs-ext', dana)).toMatchObject({
      systems: [cloud],
      platforms: [iot],
      hiddenItems: 0,
      items: [
        { kind: 'system', id: cloud, label: 'Invented cloud historian', visible: true },
        { kind: 'platform', id: iot, label: 'Invented IoT platform', visible: true },
      ],
    });
    expect((await zoneOf('hillcrest', 'hc-ext', dana)).platforms).toEqual([iot]);
    // a system twice, one that does not exist
    expect(await status(dana('PUT', '/plant/sites/riverside/zones/rvs-ext', { name: 'External', systems: [cloud, cloud] }))).toMatchObject({ status: 400 });
    expect(await status(dana('PUT', '/plant/sites/riverside/zones/rvs-ext', { name: 'External', systems: ['sys_nope'] }))).toMatchObject({
      status: 400,
      message: expect.stringContaining('There is no system'),
    });
    await dana('PUT', '/plant/sites/riverside/zones/rvs-ext', { name: 'External', level: 'external', systems: [], platforms: [iot] });
    const changed = (await s.api('GET', '/audit?action=site.zone_changed'))[0];
    expect(changed.details).toMatchObject({ zone: 'rvs-ext', changes: ['systems'], old: { systems: [cloud] }, new: { systems: [] } });
    await dana('PUT', '/plant/sites/riverside/zones/rvs-ext', { name: 'External', level: 'external', systems: [cloud], platforms: [iot] });
  });

  it('one the reader may not see: counted, never named; adding it is refused; their save and import keep it', async () => {
    await s.api('PUT', '/plant/sites/riverside/zones/rvs-ext', { name: 'External', level: 'external', systems: [cloud], platforms: [iot, secret] });
    const seen = await zoneOf('riverside', 'rvs-ext', dana);
    expect(seen).toMatchObject({ platforms: [iot], hiddenItems: 1 });
    expect(JSON.stringify(seen)).not.toContain(secret);
    expect(JSON.stringify(seen)).not.toContain('Invented secret platform');
    // naming it anew is refused (it reads like one that does not exist)
    expect(await status(dana('POST', '/plant/sites/riverside/zones', { id: 'x', name: 'X', platforms: [secret] }))).toMatchObject({ status: 400 });
    // her save sends what she sees: the hidden one stays, in its place
    await dana('PUT', '/plant/sites/riverside/zones/rvs-ext', { name: 'External (cloud)', level: 'external', systems: [cloud], platforms: [iot] });
    expect((await zoneOf('riverside', 'rvs-ext')).platforms).toEqual([iot, secret]);
    // her export names only what she sees; importing it again keeps the hidden one and changes nothing
    const yaml: string = await dana('GET', '/plant/export?site=riverside');
    const zone = YAML.parse(yaml).ot_network.zones.find((z: { id: string }) => z.id === 'rvs-ext');
    expect(zone).toMatchObject({ systems: [cloud], platforms: [iot] });
    expect(yaml).not.toContain(secret);
    const preview = await dana('POST', '/plant/import/preview', { files: [{ name: 'r.plant.yaml', content: yaml }], mode: 'update' });
    expect(preview.problems).toEqual([]);
    expect(preview.byKind.zone).toMatchObject({ unchanged: expect.any(Number) });
    expect(preview.byKind.zone.change ?? 0).toBe(0);
    await dana('POST', '/plant/import', { files: [{ name: 'r.plant.yaml', content: yaml }], mode: 'update' });
    expect((await zoneOf('riverside', 'rvs-ext')).platforms).toEqual([iot, secret]);
    // the public API: the same
    const token = (await s.api('POST', '/me/tokens', { name: 'zone items', scope: 'read' })).token;
    const res = await fetch(`${s.base}/api/v1/plant/sites/riverside/network`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const v1 = (await res.json()) as { zones: { id: string; platforms: string[]; hiddenItems: number }[] };
    expect(v1.zones.find((z) => z.id === 'rvs-ext')).toMatchObject({ platforms: [iot, secret], hiddenItems: 0 });
  });

  it('an import adds and changes the systems of a zone; one the importer may not see is refused', async () => {
    const doc = (systems: string[], platforms: string[]) =>
      YAML.stringify({
        version: 1,
        ot_network: { site: 'hillcrest', zones: [{ id: 'hc-ext', name: 'External', level: 'external', systems, platforms }] },
      });
    const pre = await dana('POST', '/plant/import/preview', { files: [{ name: 'h.plant.yaml', content: doc([cloud], [iot]) }], mode: 'update' });
    expect(pre.problems).toEqual([]);
    expect(pre.byKind.zone).toMatchObject({ change: 1 });
    await dana('POST', '/plant/import', { files: [{ name: 'h.plant.yaml', content: doc([cloud], [iot]) }], mode: 'update' });
    expect((await zoneOf('hillcrest', 'hc-ext')).systems).toEqual([cloud]);
    const refused = await dana('POST', '/plant/import/preview', { files: [{ name: 'h.plant.yaml', content: doc([cloud], [iot, secret]) }], mode: 'update' });
    expect(refused.problems).toEqual([expect.objectContaining({ path: expect.stringContaining('platforms[1]') })]);
  });

  it('a system that is removed: no longer counted or exported, dropped at the next save', async () => {
    const gone = (await s.api('POST', '/systems', { name: 'Invented old server', kind: 'server' })).id;
    await s.api('PUT', '/plant/sites/hillcrest/zones/hc-ext', { name: 'External', level: 'external', systems: [cloud, gone], platforms: [iot] });
    await s.api('DELETE', `/systems/${gone}`);
    const z = await zoneOf('hillcrest', 'hc-ext', dana);
    expect(z).toMatchObject({ systems: [cloud], hiddenItems: 0 });
    await dana('PUT', '/plant/sites/hillcrest/zones/hc-ext', { name: 'External', level: 'external', systems: [cloud], platforms: [iot] });
    expect((await zoneOf('hillcrest', 'hc-ext')).systems).toEqual([cloud]);
  });
});
