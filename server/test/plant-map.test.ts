import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setEnv, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The map of sites (#234, ADR 0015): off until an administrator turns it on; tiles, glyphs and sprites only through
 * Steward (only from the source's origins, address safety, content type and size checks, a disk cache with per-user
 * entries above zoom 12, session access only); changing the source needs a step-up and is audited, never with the key;
 * the sites answer is filtered by the site rights. Every upstream here is the mock tile source (mock/mockMapTiles.ts):
 * in demo mode the built-in sources point there, so no test fetches real tiles.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const cookies: Record<string, string> = {};
let hits: typeof import('../src/mock/mockMapTiles.js').mockMapHits;
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const mock = () => `${s.base}/mock/map`;
/** A raw GET with a user's session (tiles are binary). */
const raw = (who: string, url: string, extra: Record<string, string> = {}) =>
  fetch(`${s.base}/api${url}`, { headers: { 'x-sm-client': '1', ...authHeaders(cookies[who]!), ...extra } });
const setMap = (body: unknown) => s.api('PUT', '/settings/plant/map', body);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['vera', 'viewer'],
    ['pia', 'plant'],
    ['stella', 'status'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
    cookies[name] = await loginCookie(s.base, name, PW);
  }
  cookies.admin = await loginCookie(s.base, 'admin', 'Admin-password-1');
  hits = (await import('../src/mock/mockMapTiles.js')).mockMapHits;
});
afterAll(async () => {
  await s?.app.close();
});

describe('off by default', () => {
  it('nothing of the map works while the module is off', async () => {
    expect(await status(s.api('GET', '/plant/map/sites'))).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    expect(await status(s.api('GET', '/settings/plant/map'))).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  });

  it('with the module on, the map is off: the list only, nothing is fetched', async () => {
    const cfg = await users.vera!('GET', '/plant/config');
    expect(cfg.map).toMatchObject({ on: false, source: 'off' });
    const view = await s.api('GET', '/settings/plant/map');
    expect(view).toMatchObject({ source: 'off', origins: [] });
    for (const url of ['/plant/map/style.json', '/plant/map/tiles/base/0/0/0', '/plant/map/status'])
      expect(await status(s.api('GET', url)), url).toEqual({ status: 404, code: 'PLANT_MAP_OFF' });
    // the sites answer works without a map (the list)
    expect((await users.vera!('GET', '/plant/map/sites')).sites.length).toBeGreaterThan(0);
  });
});

describe('changing the source', () => {
  it('needs a step-up and is audited with the origins; turning it off does not ask', async () => {
    const noAuto = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    await noAuto('DELETE', '/auth/step-up').catch(() => undefined);
    const refused = await noAuto('PUT', '/settings/plant/map', { source: 'osm' }).catch((e: { status: number; body: any }) => e);
    expect(refused).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED', stepUp: { action: 'changeMapSource' } } });
    const view = await setMap({ source: 'osm' });
    expect(view.source).toBe('osm');
    // the demo's OpenStreetMap is the mock tile source on this server
    expect(view.origins).toEqual([new URL(s.base).origin]);
    const log = await s.api('GET', '/audit?action=plant.map_settings_changed');
    expect(log[0].details).toMatchObject({ old: { source: 'off', origins: [] }, new: { source: 'osm', origins: [new URL(s.base).origin] } });
    expect(log[0].details.assurance?.[0]).toMatchObject({ point: 'plant.mapSource' });
    // the attribution of the same source is no change of where tiles come from
    expect(await status(noAuto('PUT', '/settings/plant/map', { source: 'osm' }))).toEqual({ status: 200 });
    expect(await status(noAuto('PUT', '/settings/plant/map', { source: 'off' }))).toEqual({ status: 200 });
    await setMap({ source: 'osm' });
  });

  it('only administrators, only in a session', async () => {
    expect(await status(users.vera!('PUT', '/settings/plant/map', { source: 'off' }))).toMatchObject({ status: 403 });
    expect(await status(users.vera!('GET', '/settings/plant/map'))).toMatchObject({ status: 403 });
  });
});

describe('tiles through Steward', () => {
  it('the style points back to Steward; the dark theme dims the raster', async () => {
    const st = await users.vera!('GET', '/plant/map/style.json?theme=dark');
    expect(st.sources.base.tiles).toEqual(['/api/plant/map/tiles/base/{z}/{x}/{y}']);
    expect(JSON.stringify(st)).not.toContain('mock');
    expect(st.layers.find((l: any) => l.type === 'raster').paint['raster-brightness-max']).toBeLessThan(1);
    const cfg = await users.vera!('GET', '/plant/config');
    expect(cfg.map).toMatchObject({ on: true, source: 'osm', kind: 'raster', osm: true, attribution: ['© OpenStreetMap contributors'] });
  });

  it('serves a tile inert, with its own User-Agent, and from the cache the second time', async () => {
    const before = hits.raster;
    const r = await raw('vera', '/plant/map/tiles/base/3/2/1');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('ratelimit-limit')).toBe('600');
    expect(
      Buffer.from(await r.arrayBuffer())
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    expect(hits.userAgent).toMatch(/^Steward\/\S+ \(\+https:\/\/github\.com\/vxrz\/steward\)$/);
    expect((await raw('pia', '/plant/map/tiles/base/3/2/1')).status).toBe(200);
    expect(hits.raster).toBe(before + 1);
    expect(fs.readdirSync(path.join(s.dataDir, 'cache', 'map')).some((f) => f.endsWith('.bin'))).toBe(true);
  });

  it('above zoom 12 every user has their own cache entry', async () => {
    const before = hits.raster;
    expect((await raw('vera', '/plant/map/tiles/base/13/4000/3000')).status).toBe(200);
    expect((await raw('vera', '/plant/map/tiles/base/13/4000/3000')).status).toBe(200);
    expect((await raw('admin', '/plant/map/tiles/base/13/4000/3000')).status).toBe(200);
    expect(hits.raster).toBe(before + 2);
  });

  it('nothing but a layer of the style and z/x/y in range reaches the upstream URL', async () => {
    for (const url of [
      '/plant/map/tiles/base/3/8/1',
      '/plant/map/tiles/base/23/0/0',
      '/plant/map/tiles/base/1/0/-1',
      '/plant/map/tiles/other/0/0/0',
      '/plant/map/tiles/base/1/0/0x1',
    ])
      expect((await raw('vera', url)).status, url).toBe(404);
    expect((await raw('vera', '/plant/map/tiles/__proto__/0/0/0')).status).toBe(404);
  });

  it('a browser session only: API tokens and status viewers are refused; the Plant viewer loads tiles', async () => {
    const token = (await s.api('POST', '/me/tokens', { name: 'map', scope: 'read' })).token;
    const t = await fetch(`${s.base}/api/plant/map/tiles/base/0/0/0`, { headers: { authorization: `Bearer ${token}` } });
    expect(t.status).toBe(403);
    expect((await t.json()).code).toBe('SESSION_REQUIRED');
    expect((await raw('stella', '/plant/map/tiles/base/0/0/0')).status).toBe(403);
    expect((await raw('pia', '/plant/map/tiles/base/0/0/0')).status).toBe(200);
    expect((await fetch(`${s.base}/api/plant/map/tiles/base/0/0/0`)).status).toBe(401);
  });

  it('Light and Dark: vector tiles in the OpenMapTiles schema through the TileJSON, labels in the reader’s language', async () => {
    await setMap({ source: 'openfreemap' });
    const st = await users.vera!('GET', '/plant/map/style.json?theme=light&lang=de');
    expect(st.sources.base).toMatchObject({ type: 'vector', maxzoom: 14 });
    expect(st.glyphs).toBeUndefined();
    expect(JSON.stringify(st.layers)).toContain('name:de');
    const r = await raw('vera', '/plant/map/tiles/base/2/1/1');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/x-protobuf');
    expect((await users.vera!('GET', '/plant/config')).map.attribution).toEqual(['OpenFreeMap © OpenMapTiles', '© OpenStreetMap contributors']);
  });
});

describe('an own tile source', () => {
  it('a raster template with an API key: the key stays on the server and out of the audit log', async () => {
    const view = await setMap({
      source: 'own',
      own: {
        kind: 'raster',
        url: `${mock()}/key/{z}/{x}/{y}.png`,
        attribution: 'Mock tiles',
        keyPlace: 'query',
        keyName: 'key',
        key: 'demo-map-key',
        maxZoom: 18,
      },
    });
    expect(view.own).toMatchObject({ hasKey: true, keyName: 'key' });
    expect(JSON.stringify(view)).not.toContain('demo-map-key');
    expect((await raw('vera', '/plant/map/tiles/base/1/1/1')).status).toBe(200);
    expect(JSON.stringify(await users.vera!('GET', '/plant/map/style.json'))).not.toContain('demo-map-key');
    const log = await s.api('GET', '/audit?action=plant.map_settings_changed');
    expect(JSON.stringify(log)).not.toContain('demo-map-key');
    expect(log[0].details.apiKey).toBe('set');
    // the key in a header instead
    await setMap({
      source: 'own',
      own: { kind: 'raster', url: `${mock()}/key/{z}/{x}/{y}.png`, attribution: 'Mock tiles', keyPlace: 'header', keyName: 'x-map-key', maxZoom: 18 },
    });
    expect((await raw('vera', '/plant/map/tiles/base/1/0/1')).status).toBe(200);
  });

  it('a wrong key: 502, the reason for administrators only', async () => {
    await setMap({
      source: 'own',
      own: { kind: 'raster', url: `${mock()}/key/{z}/{x}/{y}.png`, attribution: 'Mock tiles', keyPlace: 'query', keyName: 'key', key: 'wrong', maxZoom: 18 },
    });
    expect((await raw('vera', '/plant/map/tiles/base/2/2/2')).status).toBe(502);
    expect(await users.vera!('GET', '/plant/map/status')).toMatchObject({ ok: false, reason: null });
    const st = await s.api('GET', '/plant/map/status');
    expect(st.ok).toBe(false);
    expect(st.reason).toMatch(/answered 401 \(check the API key\)/);
    expect(st.reason).not.toContain('wrong');
  });

  it('checks the template and the attribution before saving', async () => {
    const bad = (own: unknown) => status(setMap({ source: 'own', own }));
    expect(await bad({ kind: 'raster', url: `${mock()}/osm/{z}/{x}.png`, attribution: 'x' })).toEqual({ status: 400, code: 'PLANT_MAP_TEMPLATE' });
    expect(await bad({ kind: 'raster', url: 'https://{s}.tiles.example.com/{z}/{x}/{y}.png', attribution: 'x' })).toEqual({
      status: 400,
      code: 'PLANT_MAP_TEMPLATE',
    });
    expect(await bad({ kind: 'raster', url: 'ftp://tiles.example.com/{z}/{x}/{y}.png', attribution: 'x' })).toEqual({ status: 400, code: 'PLANT_MAP_URL' });
    expect(await bad({ kind: 'raster', url: `${mock()}/osm/{z}/{x}/{y}.png`, attribution: '' })).toEqual({ status: 400, code: 'PLANT_MAP_ATTRIBUTION' });
    for (const keyName of ['__proto__', 'Host', 'cookie'])
      expect(await bad({ kind: 'raster', url: `${mock()}/osm/{z}/{x}/{y}.png`, attribution: 'x', keyPlace: 'header', keyName }), keyName).toEqual({
        status: 400,
        code: 'INVALID_INPUT',
      });
    expect(await bad({ kind: 'raster', url: `${mock()}/osm/{z}/{x}/{y}.png`, attribution: 'x', keyPlace: 'query', keyName: '' })).toEqual({
      status: 400,
      code: 'PLANT_MAP_KEY_NAME',
    });
  });

  it('no redirects to other origins, no wrong content types, no addresses that are never reachable', async () => {
    const own = (url: string) => setMap({ source: 'own', own: { kind: 'raster', url, attribution: 'Mock tiles', key: '' } });
    await own(`${mock()}/redirect/{z}/{x}/{y}`);
    expect((await raw('vera', '/plant/map/tiles/base/1/0/0')).status).toBe(502);
    expect((await s.api('GET', '/plant/map/status')).reason).toMatch(/not one of the map source's origins/);
    await own(`${mock()}/html/{z}/{x}/{y}`);
    expect((await raw('vera', '/plant/map/tiles/base/1/0/0')).status).toBe(502);
    expect((await s.api('GET', '/plant/map/status')).reason).toMatch(/unexpected content type/);
    await own('http://169.254.169.254/{z}/{x}/{y}.png');
    expect((await raw('vera', '/plant/map/tiles/base/1/0/0')).status).toBe(502);
    expect((await s.api('GET', '/plant/map/status')).reason).toMatch(/Blocked/);
    // Steward's own API is never a tile source
    await own(`${s.base}/api/plant/map/tiles/base/{z}/{x}/{y}`);
    expect((await raw('admin', '/plant/map/tiles/base/1/0/0')).status).toBe(502);
    expect((await s.api('GET', '/plant/map/status')).reason).toMatch(/Steward server itself/);
  });

  it('a style URL: checked before saving, reduced to its sources and layers, every URL rewritten to Steward', async () => {
    const check = await s.api('POST', '/settings/plant/map/check', { kind: 'style', url: `${mock()}/style.json`, attribution: 'Mock style' });
    expect(check).toMatchObject({ origins: [new URL(s.base).origin], kind: 'vector', layers: 3 });
    await setMap({ source: 'own', own: { kind: 'style', url: `${mock()}/style.json`, attribution: 'Mock style', key: '' } });
    const st = await users.vera!('GET', '/plant/map/style.json');
    expect(Object.keys(st.sources)).toEqual(['s0', 's1']);
    expect(st.layers.map((l: any) => l.id)).toEqual(['background', 'tiles', 'places']);
    expect(st.layers[1].metadata).toBeUndefined();
    expect(st.glyphs).toBe('/api/plant/map/glyphs/{fontstack}/{range}.pbf');
    expect(st.sprite).toBe('/api/plant/map/sprites/default');
    expect(JSON.stringify(st)).not.toContain('/mock/');
    expect((await users.vera!('GET', '/plant/config')).map.attribution).toEqual(['Mock style', 'Mock own style tiles', 'Mock vector tiles']);
    // tiles of both sources, the glyphs of the style's fonts, its sprite
    expect((await raw('vera', '/plant/map/tiles/s0/1/0/0')).status).toBe(200);
    expect((await raw('vera', '/plant/map/tiles/s1/1/0/0')).headers.get('content-type')).toBe('application/x-protobuf');
    expect((await raw('vera', '/plant/map/glyphs/Mock%20Sans%20Regular/0-255.pbf')).status).toBe(200);
    expect((await raw('vera', '/plant/map/glyphs/Other%20Font/0-255.pbf')).status).toBe(404);
    expect((await raw('vera', '/plant/map/glyphs/Mock%20Sans%20Regular/1-256.pbf')).status).toBe(404);
    expect((await raw('vera', '/plant/map/glyphs/Mock%20Sans%20Regular/65536-65791.pbf')).status).toBe(404);
    const sprite = await raw('vera', '/plant/map/sprites/default@2x.json');
    expect(sprite.status).toBe(200);
    expect((await sprite.json()).dot.pixelRatio).toBe(2);
    expect((await raw('vera', '/plant/map/sprites/default.png')).headers.get('content-type')).toBe('image/png');
    expect((await raw('vera', '/plant/map/sprites/other.json')).status).toBe(404);
  });
});

describe('a self-hosted PMTiles file', () => {
  it('lists the files in <data>/maps and reads raster tiles from one, never the whole file', async () => {
    const view = await s.api('GET', '/settings/plant/map');
    expect(view.mapsDir).toBe(path.join(s.dataDir, 'maps'));
    expect(view.files.find((f: any) => f.name === 'demo-raster.pmtiles')).toMatchObject({
      kind: 'raster',
      maxZoom: 4,
      attribution: 'Demo tiles (made up)',
      problem: null,
    });
    await setMap({ source: 'file', file: { name: 'demo-raster.pmtiles', attribution: '' } });
    expect((await setMap({ source: 'file', file: { name: 'demo-raster.pmtiles', attribution: '' } })).origins).toEqual([]);
    const r = await raw('vera', '/plant/map/tiles/base/2/1/1');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect((await raw('vera', '/plant/map/tiles/base/5/1/1')).status).toBe(404);
    expect((await users.vera!('GET', '/plant/config')).map).toMatchObject({ source: 'file', attribution: ['Demo tiles (made up)'], maxZoom: 4 });
  });

  it('vector files: the Protomaps or OpenMapTiles style; another schema cannot be chosen; attributions as plain text', async () => {
    const { vectorPmtiles } = await import('../src/mock/mockMapTiles.js');
    const dir = path.join(s.dataDir, 'maps');
    fs.writeFileSync(path.join(dir, 'protomaps.pmtiles'), vectorPmtiles('protomaps'));
    fs.writeFileSync(path.join(dir, 'other.pmtiles'), vectorPmtiles('other'));
    fs.writeFileSync(path.join(dir, 'broken.pmtiles'), 'not a map');
    const files = (await s.api('GET', '/settings/plant/map')).files;
    expect(files.find((f: any) => f.name === 'protomaps.pmtiles')).toMatchObject({ kind: 'vector', schema: 'protomaps', attribution: 'Mock data & friends' });
    expect(files.find((f: any) => f.name === 'other.pmtiles').problem).toMatch(/schema/);
    expect(files.find((f: any) => f.name === 'broken.pmtiles').problem).toMatch(/Not a readable PMTiles file/);
    expect(await status(setMap({ source: 'file', file: { name: 'other.pmtiles', attribution: 'x' } }))).toEqual({ status: 400, code: 'PLANT_MAP_FILE' });
    expect(await status(setMap({ source: 'file', file: { name: '../vault.json', attribution: 'x' } }))).toEqual({ status: 400, code: 'PLANT_MAP_FILE' });
    await setMap({ source: 'file', file: { name: 'protomaps.pmtiles', attribution: '' } });
    const st = await users.vera!('GET', '/plant/map/style.json?theme=dark');
    expect(st.layers.some((l: any) => l['source-layer'] === 'earth')).toBe(true);
    expect(JSON.stringify(st.layers)).not.toContain('icon-image');
    expect((await raw('vera', '/plant/map/tiles/base/1/1/1')).headers.get('content-type')).toBe('application/x-protobuf');
  });
});

describe('the sites', () => {
  it('only the sites the reader may see, with position and state', async () => {
    const all = (await s.api('GET', '/plant/map/sites')).sites;
    const riverside = all.find((x: any) => x.id === 'riverside');
    expect(riverside).toMatchObject({ code: 'RVS', geo: { lat: expect.any(Number), lon: expect.any(Number) } });
    expect(['fail', 'warn', 'unknown', 'ok', 'none']).toContain(riverside.state);
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [{ subject: 'user:pia', permissions: ['view'] }] });
    expect((await users.vera!('GET', '/plant/map/sites')).sites.map((x: any) => x.id)).not.toContain('hillcrest');
    expect((await users.pia!('GET', '/plant/map/sites')).sites.map((x: any) => x.id)).toContain('hillcrest');
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: [] });
  });
});

describe('the disk cache', () => {
  it('keeps at most SM_MAP_CACHE_MB, least recently used out; 0 keeps nothing', async () => {
    const { clearMapCache, mapCacheBytes } = await import('../src/plant/mapTiles.js');
    clearMapCache();
    await setEnv({ SM_MAP_CACHE_MB: '1' });
    await setMap({ source: 'own', own: { kind: 'raster', url: `${mock()}/big/{z}/{x}/{y}`, attribution: 'Big tiles', key: '' } });
    for (let x = 0; x < 8; x++) expect((await raw('vera', `/plant/map/tiles/base/3/${x}/0`)).status).toBe(200);
    expect(mapCacheBytes()).toBeLessThanOrEqual(1024 * 1024);
    const before = hits.big;
    await raw('vera', '/plant/map/tiles/base/3/7/0'); // the newest is still there
    expect(hits.big).toBe(before);
    await raw('vera', '/plant/map/tiles/base/3/0/0'); // the oldest was dropped
    expect(hits.big).toBe(before + 1);
    clearMapCache();
    await setEnv({ SM_MAP_CACHE_MB: '0' });
    await raw('vera', '/plant/map/tiles/base/3/1/0');
    expect(fs.existsSync(path.join(s.dataDir, 'cache', 'map'))).toBe(false);
    await setEnv({ SM_MAP_CACHE_MB: undefined });
  });

  it('follows the caching headers', async () => {
    const { freshFor } = await import('../src/plant/mapTiles.js');
    expect(freshFor('public, max-age=86400', null)).toBe(86400);
    expect(freshFor('no-store', null)).toBe(0);
    expect(freshFor('max-age=5', null)).toBe(60);
    expect(freshFor(null, new Date(Date.now() + 7200_000).toUTCString())).toBeGreaterThan(7000);
    expect(freshFor('max-age=999999999', null)).toBe(30 * 86400);
  });
});

describe('backups and the vault', () => {
  it('backups leave the cache and the maps folder out; the API key is rotated with the vault', async () => {
    const { dataFiles } = await import('../src/backup/archive.js');
    const files = dataFiles().map((f) => f.rel);
    expect(files.some((f) => f.startsWith('cache/') || f.startsWith('maps/'))).toBe(false);
    const { ENCRYPTED_SETTINGS } = await import('../src/vault-rotation.js');
    expect(ENCRYPTED_SETTINGS.map((x) => x.key)).toContain('plant.mapKey');
  });
});

/**
 * Security review of 0.10.0 (map of sites): the style check never sends the stored key to an address the caller names and
 * needs the step-up of a new source; turning the map off or keeping a source never rewrites the stored own source
 * without one; a tile error tells a reader of the plant registry no upstream address.
 */
describe('security review', () => {
  let evil: http.Server;
  let evilPort = 0;
  const evilSeen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  beforeAll(async () => {
    evil = http.createServer((req, res) => {
      evilSeen.push({ url: req.url ?? '', headers: req.headers });
      if ((req.url ?? '').includes('/fail/')) {
        res.writeHead(500);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 8, sources: {}, layers: [] }));
    });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', () => r()));
    evilPort = (evil.address() as { port: number }).port;
    // a stored own style with an API key (an administrator who confirmed it)
    await setMap({
      source: 'own',
      own: { kind: 'style', url: `${mock()}/style.json`, attribution: 'Mock style', keyPlace: 'query', keyName: 'key', key: 'STORED-MAP-KEY-1' },
    });
  });
  afterAll(() => evil?.close());
  const unconfirmed = async () => {
    const c = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    await c('DELETE', '/auth/step-up').catch(() => undefined);
    return c;
  };
  const stolen = () => evilSeen.some((r) => JSON.stringify(r).includes('STORED-MAP-KEY-1'));

  it('the check of a new address needs a step-up and never gets the stored key; it is audited', async () => {
    const c = await unconfirmed();
    const evilStyle = { kind: 'style', url: `http://127.0.0.1:${evilPort}/style.json`, attribution: 'x', keyPlace: 'header', keyName: 'x-stolen' };
    const refused = await c('POST', '/settings/plant/map/check', evilStyle).catch((e: { status: number; body: any }) => e);
    expect(refused).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED', stepUp: { action: 'changeMapSource' } } });
    expect(evilSeen).toEqual([]);
    // confirmed: the new address is read, but without the stored key (a key for it has to be entered)
    await s.api('POST', '/settings/plant/map/check', evilStyle).catch(() => undefined);
    await s.api('POST', '/settings/plant/map/check', { ...evilStyle, keyPlace: 'query', keyName: 'key' }).catch(() => undefined);
    expect(evilSeen.length).toBeGreaterThan(0);
    expect(stolen()).toBe(false);
    const [entry] = await s.api('GET', '/audit?action=plant.map_source_checked');
    expect(entry.details).toMatchObject({ origins: [`http://127.0.0.1:${evilPort}`], storedKey: false });
    expect(JSON.stringify(entry)).not.toContain('STORED-MAP-KEY-1');
  });

  it('the check of the stored source needs no step-up and uses the stored key only there', async () => {
    const c = await unconfirmed();
    const r = await c('POST', '/settings/plant/map/check', {
      kind: 'style',
      url: `${mock()}/style.json`,
      attribution: 'Mock style',
      keyPlace: 'query',
      keyName: 'key',
    });
    expect(r.origins).toEqual([new URL(s.base).origin]);
    const [entry] = await s.api('GET', '/audit?action=plant.map_source_checked');
    expect(entry.details).toMatchObject({ storedKey: true });
    expect(stolen()).toBe(false);
  });

  it('turning the map off keeps the stored own source; changing it under another source needs a step-up', async () => {
    const c = await unconfirmed();
    const evilOwn = { kind: 'raster', url: `http://127.0.0.1:${evilPort}/{z}/{x}/{y}.png`, attribution: 'x', keyPlace: 'query', keyName: 'key' };
    const off = await c('PUT', '/settings/plant/map', { source: 'off', own: evilOwn });
    expect(off.source).toBe('off');
    expect(off.own).toMatchObject({ kind: 'style', url: `${mock()}/style.json`, hasKey: true });
    const [entry] = await s.api('GET', '/audit?action=plant.map_settings_changed');
    expect(entry.summary).toBe('Map of sites turned off');
    // another source with a changed own source: the step-up of a new source, audited with the own source's origins
    const refused = await c('PUT', '/settings/plant/map', { source: 'osm', own: evilOwn }).catch((e: { status: number; body: any }) => e);
    expect(refused).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    const keyOnly = await c('PUT', '/settings/plant/map', {
      source: 'osm',
      own: { kind: 'style', url: `${mock()}/style.json`, attribution: 'Mock style', keyPlace: 'query', keyName: 'key', key: 'other' },
    }).catch((e: { status: number; body: any }) => e);
    expect(keyOnly).toMatchObject({ status: 403, body: { code: 'STEP_UP_REQUIRED' } });
    // a stored key belongs to its address: another origin needs it entered again
    expect(await status(setMap({ source: 'osm', own: evilOwn }))).toEqual({ status: 400, code: 'PLANT_MAP_KEY_AGAIN' });
    const saved = await setMap({ source: 'osm', own: { ...evilOwn, key: 'NEW-KEY' } });
    expect(saved.own).toMatchObject({ url: evilOwn.url, hasKey: true });
    const [changed] = await s.api('GET', '/audit?action=plant.map_settings_changed');
    expect(changed.details.own).toEqual({ old: [new URL(s.base).origin], new: [`http://127.0.0.1:${evilPort}`] });
  });

  it('a failing tile names the upstream address to administrators only', async () => {
    await setMap({ source: 'own', own: { kind: 'raster', url: `http://127.0.0.1:${evilPort}/fail/{z}/{x}/{y}.png`, attribution: 'x', key: '' } });
    const reader = await raw('pia', '/plant/map/tiles/base/1/0/0');
    expect(reader.status).toBe(502);
    const body = await reader.text();
    expect(JSON.parse(body).code).toBe('PLANT_MAP_SOURCE_FAILED');
    expect(body).not.toContain(String(evilPort));
    expect(body).not.toContain('/fail/');
    const admin = await raw('admin', '/plant/map/tiles/base/1/1/0');
    expect(admin.status).toBe(502);
    expect(await admin.text()).toContain(`127.0.0.1:${evilPort}/fail/1/1/0.png`);
  });
});
