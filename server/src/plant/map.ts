import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  MAP_KEY_PLACES,
  MAP_OWN_KINDS,
  MAP_SOURCES,
  PLANT_MAP_LIMITS,
  siteMapState,
  type MapKeyPlace,
  type MapOwnKind,
  type MapSource,
  type PlantMapCheck,
  type PlantMapClient,
  type PlantMapFile,
  type PlantMapSettingsView,
  type PlantMapSite,
  type PlantMapSites,
  type PlantMapStatus,
  type Translations,
} from '@sm/shared';
import { audit } from '../audit.js';
import { config, loopbackUrl } from '../config.js';
import { me } from '../auth/access.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { db } from '../db.js';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { vault } from '../vault.js';
import { siteRights } from './access.js';
import { requirePlant } from './settings.js';
import { overview } from './views.js';
import { openMapTilesLayers, protomapsLayers, rasterLayers, type Layer, type MapTheme } from './mapStyles.js';
import { archiveOf, clearArchives, fetchMapFile, fetchStatus, pmtilesTile, resetFetchStatus, type Fetched, type Upstream } from './mapTiles.js';

/**
 * The map of sites (#234, ADR 0015): its settings (internal setting `plant.map`, the API key vault-encrypted in
 * `plant.mapKey`, an own style reduced to what Steward needs in `plant.mapStyle`), the plan of the chosen source (its
 * upstream URLs and origins), the style Steward serves the browser (every URL pointing back to Steward), and the sites
 * the reader may see.
 *
 * The map is off until an administrator turns it on. Changing where tiles come from is a step-up action (control point
 * plant.mapSource) and audited (plant.map_settings_changed, with the old and new origins, never the key).
 */

const KEY = 'plant.map';
const KEY_SECRET = 'plant.mapKey';
const KEY_STYLE = 'plant.mapStyle';

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const OPENFREEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles';

/** In the demo (and the tests) the built-in sources are the mock tile source (mock/mockMapTiles.ts): nothing real is fetched. */
const builtin = () =>
  config.demo
    ? { osm: `${loopbackUrl()}/mock/map/osm/{z}/{x}/{y}.png`, openfreemap: `${loopbackUrl()}/mock/map/openfreemap/planet` }
    : { osm: OSM_TILES, openfreemap: OPENFREEMAP_TILEJSON };

// ---------- stored settings ----------

interface OwnSettings {
  kind: MapOwnKind;
  url: string;
  attribution: string;
  keyPlace: MapKeyPlace;
  keyName: string;
  maxZoom: number;
}
interface FileSettings {
  name: string;
  attribution: string;
  /** Read from the file when it was chosen */
  kind: 'raster' | 'vector';
  schema: 'protomaps' | 'openmaptiles' | null;
  minZoom: number;
  maxZoom: number;
  fileAttribution: string;
}
interface Stored {
  source: MapSource;
  own: OwnSettings | null;
  file: FileSettings | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A source of the served style, with where its tiles come from. */
interface PlanSource {
  type: 'raster' | 'vector' | 'raster-dem';
  /** Upstream URL template ({z}/{x}/{y}) */
  tiles?: string;
  /** Upstream TileJSON: its template is read when needed (OpenFreeMap changes it with every planet build) */
  tilejson?: string;
  /** A self-hosted file */
  file?: string;
  minzoom: number;
  maxzoom: number;
  tileSize?: number;
  scheme?: 'xyz' | 'tms';
  bounds?: [number, number, number, number];
}

/** An own style as Steward keeps it: sources and layers, its glyphs and sprite, the origins in it. */
interface OwnStyle {
  url: string;
  fetchedAt: string;
  sources: Record<string, PlanSource>;
  layers: Layer[];
  glyphs: string | null;
  sprites: { id: string; url: string }[];
  fonts: string[];
  origins: string[];
  attribution: string[];
}

const DEFAULTS: Stored = { source: 'off', own: null, file: null, updatedAt: null, updatedBy: null };

function stored(): Stored {
  const s = readSetting<Partial<Stored>>(KEY, {});
  return { ...DEFAULTS, ...s, source: MAP_SOURCES.includes(s.source as MapSource) ? (s.source as MapSource) : 'off' };
}

const hasKey = (): boolean => !!readSetting<{ blob?: string } | null>(KEY_SECRET, null)?.blob;
function keyValue(): string | null {
  const blob = readSetting<{ blob?: string } | null>(KEY_SECRET, null)?.blob;
  return blob ? vault().decrypt<string>(blob) : null;
}

// ---------- plain text ----------

/** Text without markup: attributions from files and styles are shown as text, never as HTML. */
export function plainText(s: string, max: number = PLANT_MAP_LIMITS.attribution): string {
  let out = '';
  let inTag = false;
  for (const ch of String(s)) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  return out
    .replaceAll('&copy;', '©')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '‹')
    .replaceAll('&gt;', '›')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------- URLs ----------

function httpUrl(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, `${what}: not a URL`, 'PLANT_MAP_URL', { what });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, `${what}: use an https (or http) address`, 'PLANT_MAP_URL', { what });
  if (u.username || u.password) throw new HttpError(400, `${what}: no user name or password in the address – use the API key`, 'PLANT_MAP_URL', { what });
  return u;
}

/** A tile URL template: {z}, {x} and {y} (or {-y}? no – TMS sources say scheme "tms"), nothing else in braces. */
function checkTemplate(t: string, what: string): string {
  // the placeholders are written encoded by the URL parser; check the raw text
  for (const p of ['{z}', '{x}', '{y}']) if (!t.includes(p)) throw new HttpError(400, `${what}: the template needs {z}, {x} and {y}`, 'PLANT_MAP_TEMPLATE');
  const rest = t.replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0');
  if (rest.includes('{') || rest.includes('}'))
    throw new HttpError(400, `${what}: only {z}, {x} and {y} are filled in (no {s} sub-domains, {r} or {quadkey})`, 'PLANT_MAP_TEMPLATE');
  httpUrl(rest, what);
  return t;
}

const originOfUrl = (u: string): string => new URL(u.replaceAll('{', '').replaceAll('}', '')).origin;
const resolveAgainst = (u: string, base: string): string => {
  // keep the placeholders as written: a relative URL is resolved with them escaped and unescaped again
  const resolved = new URL(u.replaceAll('{', '%7B').replaceAll('}', '%7D'), base).toString();
  return resolved.replaceAll('%7B', '{').replaceAll('%7D', '}');
};

// ---------- the plan of the current source ----------

interface Plan {
  source: MapSource;
  kind: 'raster' | 'vector';
  themed: boolean;
  origins: string[];
  attribution: string[];
  osm: boolean;
  minZoom: number;
  maxZoom: number;
  sources: Record<string, PlanSource>;
  layers: (theme: MapTheme, lang: string) => Layer[];
  glyphs: string | null;
  sprites: { id: string; url: string }[];
  fonts: Set<string>;
  key: { place: 'query' | 'header'; name: string } | null;
  stamp: string;
}

export const mapsDir = (): string => path.join(config.dataDir, 'maps');

function plan(s: Stored = stored()): Plan | null {
  const stamp = s.updatedAt ?? 'none';
  const base = { glyphs: null, sprites: [], fonts: new Set<string>(), key: null, stamp, osm: false, minZoom: 0 };
  const b = builtin();
  switch (s.source) {
    case 'off':
      return null;
    case 'osm':
      return {
        ...base,
        source: 'osm',
        kind: 'raster',
        themed: true,
        origins: [originOfUrl(b.osm)],
        attribution: [OSM_ATTRIBUTION],
        osm: true,
        maxZoom: 19,
        sources: { base: { type: 'raster', tiles: b.osm, minzoom: 0, maxzoom: 19, tileSize: 256 } },
        layers: (theme) => rasterLayers(theme),
      };
    case 'openfreemap':
      return {
        ...base,
        source: 'openfreemap',
        kind: 'vector',
        themed: true,
        origins: [originOfUrl(b.openfreemap)],
        attribution: [OPENFREEMAP_ATTRIBUTION, OSM_ATTRIBUTION],
        osm: true,
        maxZoom: 19,
        sources: { base: { type: 'vector', tilejson: b.openfreemap, minzoom: 0, maxzoom: 14 } },
        layers: (theme, lang) => openMapTilesLayers(theme, lang),
      };
    case 'own': {
      const o = s.own;
      if (!o) return null;
      const key = o.keyPlace !== 'none' && o.keyName ? { place: o.keyPlace, name: o.keyName } : null;
      if (o.kind === 'raster')
        return {
          ...base,
          key,
          source: 'own',
          kind: 'raster',
          themed: true,
          origins: [originOfUrl(o.url)],
          attribution: [o.attribution],
          maxZoom: o.maxZoom,
          sources: { base: { type: 'raster', tiles: o.url, minzoom: 0, maxzoom: o.maxZoom, tileSize: 256 } },
          layers: (theme) => rasterLayers(theme),
        };
      const st = readSetting<OwnStyle | null>(KEY_STYLE, null);
      if (!st) return null;
      return {
        ...base,
        key,
        source: 'own',
        kind: Object.values(st.sources).some((x) => x.type === 'vector') ? 'vector' : 'raster',
        themed: false,
        origins: st.origins,
        attribution: [o.attribution, ...st.attribution].filter((x, i, a) => x && a.indexOf(x) === i),
        maxZoom: Math.max(0, ...Object.values(st.sources).map((x) => x.maxzoom), o.maxZoom),
        sources: st.sources,
        layers: () => st.layers,
        glyphs: st.glyphs,
        sprites: st.sprites,
        fonts: new Set(st.fonts),
      };
    }
    case 'file': {
      const f = s.file;
      if (!f) return null;
      const file = path.join(mapsDir(), f.name);
      return {
        ...base,
        source: 'file',
        kind: f.kind,
        themed: true,
        origins: [],
        attribution: [f.attribution || f.fileAttribution].filter(Boolean),
        minZoom: f.minZoom,
        maxZoom: f.kind === 'vector' ? Math.max(f.maxZoom, 19) : f.maxZoom,
        sources: { base: { type: f.kind, file, minzoom: f.minZoom, maxzoom: f.maxZoom, ...(f.kind === 'raster' ? { tileSize: 256 } : {}) } },
        layers: (theme, lang) =>
          f.kind === 'raster' ? rasterLayers(theme) : f.schema === 'protomaps' ? protomapsLayers(theme, lang) : openMapTilesLayers(theme, lang),
      };
    }
  }
}

/** 404 PLANT_MAP_OFF while the map is off (like a route that does not exist), else the plan. */
function requireMap(): Plan {
  requirePlant();
  const p = plan();
  if (!p) throw new HttpError(404, 'The map is off (Settings → Plant registry → Map)', 'PLANT_MAP_OFF');
  return p;
}

// ---------- what readers are told ----------

export function mapClient(): PlantMapClient {
  const s = stored();
  const p = plan(s);
  if (!p) return { on: false, source: 'off', kind: 'raster', themed: false, attribution: [], osm: false, minZoom: 0, maxZoom: 19, version: 'off' };
  return {
    on: true,
    source: p.source,
    kind: p.kind,
    themed: p.themed,
    attribution: p.attribution,
    osm: p.osm,
    minZoom: p.minZoom,
    maxZoom: p.maxZoom,
    version: crypto.createHash('sha256').update(p.stamp).digest('hex').slice(0, 12),
  };
}

const PREFIX = () => `${config.basePath}/api/plant/map`;

/** The MapLibre style of the current source: every URL points back to Steward (paths; the browser makes them absolute). */
export function mapStyle(theme: MapTheme, lang: string): Record<string, unknown> {
  const p = requireMap();
  const sources = Object.fromEntries(
    Object.entries(p.sources).map(([name, s]) => [
      name,
      {
        type: s.type,
        tiles: [`${PREFIX()}/tiles/${name}/{z}/{x}/{y}`],
        minzoom: s.minzoom,
        maxzoom: s.maxzoom,
        ...(s.tileSize ? { tileSize: s.tileSize } : {}),
        ...(s.scheme === 'tms' ? { scheme: 'tms' } : {}),
        ...(s.bounds ? { bounds: s.bounds } : {}),
      },
    ]),
  );
  return {
    version: 8,
    name: `Steward map (${p.source})`,
    sources,
    layers: p.layers(theme, lang),
    ...(p.glyphs ? { glyphs: `${PREFIX()}/glyphs/{fontstack}/{range}.pbf` } : {}),
    ...(p.sprites.length === 1 && p.sprites[0]!.id === 'default'
      ? { sprite: `${PREFIX()}/sprites/default` }
      : p.sprites.length
        ? { sprite: p.sprites.map((x) => ({ id: x.id, url: `${PREFIX()}/sprites/${x.id}` })) }
        : {}),
  };
}

// ---------- tiles, glyphs, sprites ----------

const upstreamOf = (p: Plan, url: string, kind: Upstream['kind'], user: string | null = null): Upstream => {
  const v = p.key ? keyValue() : null;
  return { url, kind, origins: p.origins, key: p.key && v ? { ...p.key, value: v } : null, stamp: p.stamp, user };
};

const tileJsonTemplates = new Map<string, { at: number; tiles: string }>();
/** The tile template a TileJSON names (read again after an hour; the fetcher's cache keeps it for its own lifetime). */
async function templateOf(p: Plan, s: PlanSource): Promise<string> {
  if (s.tiles) return s.tiles;
  const url = s.tilejson!;
  const hit = tileJsonTemplates.get(`${p.stamp}|${url}`);
  if (hit && Date.now() - hit.at < 3600_000) return hit.tiles;
  const tj = parseJsonFile(await fetchMapFile(upstreamOf(p, url, 'json')), 'TileJSON');
  const t = Array.isArray(tj.tiles) && typeof tj.tiles[0] === 'string' ? resolveAgainst(tj.tiles[0], url) : null;
  if (!t) throw new HttpError(502, 'The source’s TileJSON names no tiles', 'PLANT_MAP_UPSTREAM', { reason: 'tilejson' });
  checkTemplate(t, 'TileJSON');
  tileJsonTemplates.set(`${p.stamp}|${url}`, { at: Date.now(), tiles: t });
  return t;
}

function parseJsonFile(f: Fetched, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(f.body.toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // not JSON: the error below
  }
  throw new HttpError(502, `The source's ${what} is not a JSON object`, 'PLANT_MAP_UPSTREAM', { reason: 'json' });
}

/** z/x/y as integers in range (the browser passes nothing else to the upstream URL). */
export function tileCoords(zs: string, xs: string, ys: string): { z: number; x: number; y: number } {
  const int = (v: string) => (v.length > 0 && v.length <= 8 && [...v].every((c) => c >= '0' && c <= '9') ? Number(v) : NaN);
  const z = int(zs);
  const x = int(xs);
  const y = int(ys);
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z > 22 || x >= 2 ** z || y >= 2 ** z)
    throw new HttpError(404, 'No tile here', 'PLANT_MAP_NO_TILE');
  return { z, x, y };
}

export async function mapTile(layer: string, zs: string, xs: string, ys: string): Promise<Fetched> {
  const p = requireMap();
  const s = Object.hasOwn(p.sources, layer) ? p.sources[layer] : undefined;
  if (!s) throw new HttpError(404, 'No such map layer', 'PLANT_MAP_NO_TILE');
  const { z, x, y } = tileCoords(zs, xs, ys);
  if (z < s.minzoom || z > s.maxzoom) throw new HttpError(404, 'No tile here', 'PLANT_MAP_NO_TILE');
  if (s.file) return pmtilesTile(s.file, z, x, y);
  const t = await templateOf(p, s);
  const url = t.replaceAll('{z}', String(z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y));
  // above zoom 12 every user has their own cache entries: nobody learns from timing where others looked closely
  const user = z > PLANT_MAP_LIMITS.sharedCacheMaxZoom ? me().id : null;
  return fetchMapFile(upstreamOf(p, url, 'tile', user));
}

/** A glyph range of a font stack the style uses ("0-255.pbf" … "65280-65535.pbf"). */
export async function mapGlyphs(fontstack: string, range: string): Promise<Fetched> {
  const p = requireMap();
  if (!p.glyphs) throw new HttpError(404, 'This map has no glyphs', 'PLANT_MAP_NO_TILE');
  const fonts = fontstack.split(',').map((f) => f.trim());
  if (!fonts.length || fontstack.length > 300 || !fonts.every((f) => p.fonts.has(f))) throw new HttpError(404, 'No such font', 'PLANT_MAP_NO_TILE');
  const r = range.endsWith('.pbf') ? range.slice(0, -4) : range;
  const [a, b, ...more] = r.split('-');
  const start = Number(a);
  const end = Number(b);
  if (more.length || !Number.isInteger(start) || start % 256 !== 0 || end !== start + 255 || start > 65280 || String(start) !== a || String(end) !== b)
    throw new HttpError(404, 'No such glyph range', 'PLANT_MAP_NO_TILE');
  const url = p.glyphs.replaceAll('{fontstack}', encodeURIComponent(fonts.join(','))).replaceAll('{range}', `${start}-${end}`);
  return fetchMapFile(upstreamOf(p, url, 'glyphs'));
}

/** A sprite file: "<id>.json", "<id>.png", "<id>@2x.json" or "<id>@2x.png" of a sprite the style names. */
export async function mapSprite(file: string): Promise<Fetched> {
  const p = requireMap();
  const ext = file.endsWith('.json') ? '.json' : file.endsWith('.png') ? '.png' : null;
  if (!ext) throw new HttpError(404, 'No such sprite', 'PLANT_MAP_NO_TILE');
  let id = file.slice(0, -ext.length);
  const hi = id.endsWith('@2x');
  if (hi) id = id.slice(0, -3);
  const sp = p.sprites.find((x) => x.id === id);
  if (!sp) throw new HttpError(404, 'No such sprite', 'PLANT_MAP_NO_TILE');
  const [pathPart, query] = [sp.url.split('?')[0]!, sp.url.includes('?') ? sp.url.slice(sp.url.indexOf('?')) : ''];
  return fetchMapFile(upstreamOf(p, `${pathPart}${hi ? '@2x' : ''}${ext}${query}`, 'sprite'));
}

export function mapStatus(): PlantMapStatus {
  requireMap();
  const s = fetchStatus();
  const failing = !!s.lastError && (!s.lastOk || s.lastError.at > s.lastOk);
  return {
    ok: !failing,
    at: failing ? s.lastError!.at : s.lastOk,
    // the reason (an address, a status) is for administrators only
    reason: failing && isAdmin(currentUser()) ? s.lastError!.reason : null,
  };
}

// ---------- the sites ----------

export function mapSites(): PlantMapSites {
  requirePlant();
  const rows = db().all<{ id: string; code: string; name: string; names: string; acl: string; lat: number | null; lon: number | null; zoom: number | null }>(
    'SELECT id, code, name, names, acl, lat, lon, zoom FROM plant_sites',
  );
  const rights = siteRights(rows);
  const tiles = new Map(overview().map((t) => [t.siteId, t]));
  const sites: PlantMapSite[] = rows
    .filter((r) => rights.get(r.id)!.includes('view'))
    .map((r) => {
      const t = tiles.get(r.id) ?? { counts: {}, total: 0, live: {}, checks: 0, coverage: { complete: 0, partial: 0, missing: 0, na: 0 } };
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        names: parseJson<Translations>(r.names, {}),
        geo: r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon), zoom: r.zoom === null ? null : Number(r.zoom) } : null,
        state: siteMapState(t),
        counts: t.counts,
        total: t.total,
        live: t.live,
        checks: t.checks,
        coverage: t.coverage as PlantMapSite['coverage'],
      };
    });
  // sorted here, not in SQL: the same order on every database
  sites.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { sites };
}

// ---------- self-hosted files ----------

const FILE_NAME_OK = (n: string) => n.length <= 200 && n.endsWith('.pmtiles') && !n.startsWith('.') && [...n].every((c) => /[A-Za-z0-9._-]/.test(c));

async function describeFile(name: string): Promise<PlantMapFile> {
  const file = path.join(mapsDir(), name);
  const st = fs.statSync(file);
  const out: PlantMapFile = { name, bytes: st.size, kind: 'unknown', schema: null, attribution: '', minZoom: 0, maxZoom: 0, problem: null };
  try {
    const a = archiveOf(file);
    const h = await a.getHeader();
    out.minZoom = h.minZoom;
    out.maxZoom = h.maxZoom;
    out.kind = h.tileType === 1 ? 'vector' : [2, 3, 4].includes(h.tileType) ? 'raster' : 'unknown';
    const meta = ((await a.getMetadata().catch(() => ({}))) ?? {}) as { attribution?: unknown; vector_layers?: { id?: unknown }[] };
    out.attribution = typeof meta.attribution === 'string' ? plainText(meta.attribution) : '';
    if (out.kind === 'unknown') out.problem = 'The file holds tiles of a type Steward cannot draw (PNG, JPEG, WebP or vector tiles)';
    if (out.kind === 'vector') {
      const ids = new Set((Array.isArray(meta.vector_layers) ? meta.vector_layers : []).map((l) => String(l?.id ?? '')));
      out.schema = ids.has('earth') && ids.has('roads') ? 'protomaps' : ids.has('transportation') || ids.has('water') ? 'openmaptiles' : null;
      if (!out.schema) out.problem = 'Vector tiles in a schema Steward has no style for (Protomaps or OpenMapTiles)';
    }
  } catch (e) {
    out.problem = `Not a readable PMTiles file (${(e as Error).message.slice(0, 120)})`;
  }
  return out;
}

export async function listMapFiles(): Promise<PlantMapFile[]> {
  // the demo has a made-up raster file to choose (mock/mockMapTiles.ts), written when someone first looks
  if (config.demo) (await import('../mock/mockMapTiles.js')).writeDemoPmtiles(mapsDir());
  let names: string[];
  try {
    names = fs
      .readdirSync(mapsDir(), { withFileTypes: true })
      .filter((d) => (d.isFile() || d.isSymbolicLink()) && FILE_NAME_OK(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return []; // no maps folder: no files
  }
  const out: PlantMapFile[] = [];
  for (const n of names.slice(0, 100)) {
    try {
      if (fs.statSync(path.join(mapsDir(), n)).isFile()) out.push(await describeFile(n));
    } catch {
      // a link to nothing: not listed
    }
  }
  return out;
}

// ---------- an own style ----------

const LAYER_TYPES = new Set(['background', 'fill', 'line', 'symbol', 'circle', 'heatmap', 'fill-extrusion', 'raster', 'hillshade']);
const SOURCE_TYPES = new Set(['raster', 'vector', 'raster-dem']);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const zoomOf = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 22) : d);

/** Every string in a value (the font names of a text-font, whatever expression holds them). */
function strings(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 20 || out.size > 200) return;
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
}

const ID_OK = (s: string) => s.length > 0 && s.length <= 40 && [...s].every((c) => /[A-Za-z0-9_-]/.test(c));

/**
 * Reads an own style (fetched by the server) and keeps what Steward needs: its raster and vector sources (TileJSON read
 * to its tile template), its layers on those sources, its glyphs and sprite. Every URL is resolved against the style's
 * address; their origins become the source's origins. Everything else of the file is dropped.
 */
async function readOwnStyle(styleUrl: string, key: Plan['key'], keyVal: string | null): Promise<OwnStyle> {
  const styleOrigin = new URL(styleUrl).origin;
  const origins = new Set<string>([styleOrigin]);
  const up = (url: string, kind: Upstream['kind']): Upstream => ({
    url,
    kind,
    origins: [...origins],
    key: key && keyVal ? { ...key, value: keyVal } : null,
    stamp: `check|${Date.now()}`,
  });
  const style = parseJsonFile(await fetchMapFile(up(styleUrl, 'json')), 'style');
  if (style.version !== 8) throw new HttpError(400, 'The style is not a MapLibre style (version 8)', 'PLANT_MAP_STYLE');
  const rawSources = obj(style.sources);
  const sources: Record<string, PlanSource> = {};
  const rename = new Map<string, string>();
  const attribution: string[] = [];
  for (const [name, raw] of Object.entries(rawSources).slice(0, PLANT_MAP_LIMITS.styleSources)) {
    const s = obj(raw);
    if (!SOURCE_TYPES.has(String(s.type))) continue;
    let tj = s;
    if (typeof s.url === 'string' && !Array.isArray(s.tiles)) {
      if (!s.url.startsWith('http')) continue; // mapbox:// and the like: not reachable
      const u = resolveAgainst(s.url, styleUrl);
      origins.add(new URL(u).origin);
      tj = { ...parseJsonFile(await fetchMapFile(up(u, 'json')), 'TileJSON'), ...s };
    }
    const t = Array.isArray(tj.tiles) && typeof tj.tiles[0] === 'string' ? resolveAgainst(tj.tiles[0], styleUrl) : null;
    if (!t) continue;
    checkTemplate(t, `Source ${name}`);
    origins.add(originOfUrl(t));
    const id = `s${Object.keys(sources).length}`;
    rename.set(name, id);
    const b =
      Array.isArray(tj.bounds) && tj.bounds.length === 4 && tj.bounds.every((x) => typeof x === 'number')
        ? (tj.bounds as [number, number, number, number])
        : undefined;
    sources[id] = {
      type: s.type as PlanSource['type'],
      tiles: t,
      minzoom: zoomOf(tj.minzoom, 0),
      maxzoom: zoomOf(tj.maxzoom, 22),
      ...(typeof tj.tileSize === 'number' && [256, 512].includes(tj.tileSize) ? { tileSize: tj.tileSize } : {}),
      ...(tj.scheme === 'tms' ? { scheme: 'tms' as const } : {}),
      ...(b ? { bounds: b } : {}),
    };
    if (typeof tj.attribution === 'string' && plainText(tj.attribution)) attribution.push(plainText(tj.attribution));
  }
  if (!Object.keys(sources).length) throw new HttpError(400, 'The style has no raster or vector source Steward can serve', 'PLANT_MAP_STYLE');
  const fonts = new Set<string>();
  const layers: Layer[] = [];
  for (const raw of (Array.isArray(style.layers) ? style.layers : []).slice(0, PLANT_MAP_LIMITS.styleLayers)) {
    const l = obj(raw);
    if (!LAYER_TYPES.has(String(l.type)) || typeof l.id !== 'string') continue;
    const src = l.type === 'background' ? null : rename.get(String(l.source));
    if (l.type !== 'background' && !src) continue; // on a source Steward does not serve
    const out: Layer = { id: l.id.slice(0, 200), type: l.type };
    if (src) out.source = src;
    if (typeof l['source-layer'] === 'string') out['source-layer'] = l['source-layer'];
    if (typeof l.minzoom === 'number') out.minzoom = l.minzoom;
    if (typeof l.maxzoom === 'number') out.maxzoom = l.maxzoom;
    for (const k of ['filter', 'layout', 'paint'] as const) if (l[k] !== undefined) out[k] = l[k];
    strings(obj(l.layout)['text-font'], fonts);
    layers.push(out);
  }
  let glyphs: string | null = null;
  if (typeof style.glyphs === 'string' && style.glyphs.includes('{fontstack}') && style.glyphs.includes('{range}')) {
    glyphs = resolveAgainst(style.glyphs, styleUrl);
    httpUrl(glyphs.replaceAll('{fontstack}', 'f').replaceAll('{range}', '0-255'), 'Glyphs');
    origins.add(originOfUrl(glyphs));
  }
  const sprites: { id: string; url: string }[] = [];
  const addSprite = (id: string, url: unknown) => {
    if (typeof url !== 'string' || !ID_OK(id) || sprites.length >= 10) return;
    const u = resolveAgainst(url, styleUrl);
    httpUrl(u, 'Sprite');
    origins.add(new URL(u).origin);
    sprites.push({ id, url: u });
  };
  if (typeof style.sprite === 'string') addSprite('default', style.sprite);
  else if (Array.isArray(style.sprite)) for (const sp of style.sprite) addSprite(String(obj(sp).id ?? ''), obj(sp).url);
  return {
    url: styleUrl,
    fetchedAt: nowIso(),
    sources,
    layers,
    glyphs,
    sprites,
    fonts: [...fonts].slice(0, 200),
    origins: [...origins].sort(),
    attribution: attribution.filter((x, i, a) => a.indexOf(x) === i).slice(0, 5),
  };
}

// ---------- settings ----------

const keyName = z
  .string()
  .trim()
  .max(60)
  .refine((v) => !v || [...v].every((c) => /[A-Za-z0-9_-]/.test(c)), 'Letters, digits, - and _ only');

export const mapSettingsInput = z
  .object({
    source: z.enum(MAP_SOURCES),
    own: z
      .object({
        kind: z.enum(MAP_OWN_KINDS),
        url: z.string().trim().max(PLANT_MAP_LIMITS.url),
        attribution: z.string().trim().max(PLANT_MAP_LIMITS.attribution).default(''),
        keyPlace: z.enum(MAP_KEY_PLACES).default('none'),
        keyName: keyName.default(''),
        /** undefined: keep the stored key; '': remove it */
        key: z.string().max(500).optional(),
        maxZoom: z.number().int().min(0).max(22).default(19),
      })
      .strict()
      .optional(),
    file: z
      .object({ name: z.string().max(200), attribution: z.string().trim().max(PLANT_MAP_LIMITS.attribution).default('') })
      .strict()
      .optional(),
    /** Fetch the own style again (its origins may change) */
    reload: z.boolean().optional(),
  })
  .strict();
export type MapSettingsInput = z.infer<typeof mapSettingsInput>;

/** The body of PUT /api/settings/plant/map, if it parses (for the step-up rule, before the handler). */
export function mapBody(body: unknown): MapSettingsInput | null {
  const b = mapSettingsInput.safeParse(body ?? {});
  return b.success ? b.data : null;
}

/** Whether a change moves where tiles come from: a new source, URL, key or file, or the style read again. Off never asks. */
export function changesMapSource(b: MapSettingsInput | null): boolean {
  if (!b) return true;
  if (b.source === 'off') return false;
  const s = stored();
  if (b.reload) return true;
  if (b.source !== s.source) return true;
  if (b.source === 'own' && b.own) {
    const o = s.own;
    if (!o || o.kind !== b.own.kind || o.url !== b.own.url || o.keyPlace !== b.own.keyPlace || o.keyName !== b.own.keyName) return true;
    if (b.own.key !== undefined) return true;
  }
  if (b.source === 'file' && b.file && b.file.name !== s.file?.name) return true;
  return false;
}

export async function mapSettingsView(): Promise<PlantMapSettingsView> {
  const s = stored();
  const p = plan(s);
  return {
    source: s.source,
    own: s.own ? { ...s.own, hasKey: hasKey() } : null,
    file: s.file ? { name: s.file.name, attribution: s.file.attribution } : null,
    origins: p?.origins ?? [],
    files: await listMapFiles(),
    mapsDir: mapsDir(),
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
  };
}

function ownInput(b: NonNullable<MapSettingsInput['own']>): OwnSettings {
  if (!b.attribution) throw new HttpError(400, 'Enter the attribution the tile source asks for', 'PLANT_MAP_ATTRIBUTION');
  if (b.kind === 'raster') checkTemplate(b.url, 'Tile URL');
  else httpUrl(b.url, 'Style URL');
  if (b.keyPlace !== 'none' && !b.keyName) throw new HttpError(400, 'Name the query parameter or header of the API key', 'PLANT_MAP_KEY_NAME');
  return { kind: b.kind, url: b.url, attribution: b.attribution, keyPlace: b.keyPlace, keyName: b.keyPlace === 'none' ? '' : b.keyName, maxZoom: b.maxZoom };
}

/** POST /api/settings/plant/map/check: reads an own style (or checks a template) and says where it would fetch from. */
export async function checkMapSource(b: NonNullable<MapSettingsInput['own']>): Promise<PlantMapCheck> {
  me();
  const o = ownInput({ ...b, attribution: b.attribution || '–' });
  const keyVal = b.key !== undefined ? b.key || null : keyValue();
  if (o.kind === 'raster') return { origins: [originOfUrl(o.url)], kind: 'raster', layers: 1, attribution: b.attribution };
  const st = await readOwnStyle(o.url, o.keyPlace !== 'none' ? { place: o.keyPlace, name: o.keyName } : null, keyVal);
  return {
    origins: st.origins,
    kind: Object.values(st.sources).some((x) => x.type === 'vector') ? 'vector' : 'raster',
    layers: st.layers.length,
    attribution: [b.attribution, ...st.attribution].filter(Boolean).join(' · '),
  };
}

export async function updateMapSettings(b: MapSettingsInput): Promise<PlantMapSettingsView> {
  requirePlant();
  const u = me();
  const before = stored();
  const beforeOrigins = plan(before)?.origins ?? [];
  const next: Stored = { ...before, source: b.source, updatedAt: nowIso(), updatedBy: u.username };
  let newStyle: OwnStyle | null | undefined;
  let newKey: string | null | undefined;
  if (b.own) {
    next.own = ownInput(b.own);
    if (b.own.key !== undefined) newKey = b.own.key || null;
  }
  if (b.source === 'own') {
    if (!next.own) throw new HttpError(400, 'Enter the tile source', 'PLANT_MAP_URL', { what: 'Tile URL' });
    if (next.own.kind === 'style') {
      const same = before.own?.kind === 'style' && before.own.url === next.own.url && readSetting<OwnStyle | null>(KEY_STYLE, null);
      if (!same || b.reload || newKey !== undefined || before.source !== 'own') {
        const keyVal = newKey !== undefined ? newKey : keyValue();
        newStyle = await readOwnStyle(next.own.url, next.own.keyPlace !== 'none' ? { place: next.own.keyPlace, name: next.own.keyName } : null, keyVal);
      }
    }
  }
  if (b.file) {
    if (!FILE_NAME_OK(b.file.name) || !fs.existsSync(path.join(mapsDir(), b.file.name)))
      throw new HttpError(400, `No map file "${b.file.name.slice(0, 200)}" in the maps folder`, 'PLANT_MAP_FILE');
    const d = await describeFile(b.file.name);
    if (d.problem || d.kind === 'unknown') throw new HttpError(400, d.problem ?? 'The file cannot be drawn', 'PLANT_MAP_FILE');
    if (!b.file.attribution && !d.attribution) throw new HttpError(400, 'Enter the attribution of the map data (the file names none)', 'PLANT_MAP_ATTRIBUTION');
    next.file = {
      name: d.name,
      attribution: b.file.attribution,
      kind: d.kind,
      schema: d.schema,
      minZoom: d.minZoom,
      maxZoom: d.maxZoom,
      fileAttribution: d.attribution,
    };
  }
  if (b.source === 'file' && !next.file) throw new HttpError(400, 'Choose a map file', 'PLANT_MAP_FILE');
  writeSetting(KEY, next);
  if (newStyle !== undefined) writeSetting(KEY_STYLE, newStyle);
  if (newKey !== undefined) writeSetting(KEY_SECRET, newKey ? { blob: vault().encrypt(newKey) } : null);
  clearArchives();
  resetFetchStatus();
  const afterOrigins = plan(next)?.origins ?? [];
  audit({
    action: 'plant.map_settings_changed',
    entityType: 'settings',
    entityId: 'plant.map',
    summary:
      b.source === 'off'
        ? 'Map of sites turned off'
        : `Map of sites: tiles from ${b.source === 'file' ? `the file ${next.file?.name}` : afterOrigins.join(', ') || b.source}`,
    details: {
      old: { source: before.source, origins: beforeOrigins, ...(before.file ? { file: before.file.name } : {}) },
      new: { source: next.source, origins: afterOrigins, ...(next.file ? { file: next.file.name } : {}) },
      ...(newKey !== undefined ? { apiKey: newKey ? 'set' : 'removed' } : {}),
      ...(newStyle ? { styleReadAt: newStyle.fetchedAt } : {}),
    },
  });
  return mapSettingsView();
}
