import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EnvHttpProxyAgent, fetch } from 'undici';
import { PMTiles, TileType, type RangeResponse, type Source } from 'pmtiles';
import { BRAND, PLANT_MAP_LIMITS } from '@sm/shared';
import { config, env } from '../config.js';
import { logger } from '../log.js';
import { assertAddressSafe, guardedLookup } from '../platforms/outbound.js';
import { HttpError } from '../util.js';

/**
 * The map's tile fetcher (#234, ADR 0015): Steward fetches what the browser asks for from the chosen source, keeps it
 * in a disk cache and serves it from there. Not an open proxy:
 *
 *  - URLs come only from the saved source (map.ts builds them from its templates; the browser passes a layer name and
 *    z/x/y, a font stack and range from the style, or a sprite name); only GET, no cookies, no body.
 *  - Only the source's origins (`origins`), never the outbound allow-list: they are allowed for this fetcher only.
 *    Redirects only within them. Address safety always (no cloud metadata, no link-local, not Steward's own API; the
 *    address is pinned against DNS rebinding).
 *  - Answers are checked: content type, at most 2 MB per tile and 1 MB per other file, 10 seconds.
 *  - At most 4 parallel requests per origin, 2 for tile.openstreetmap.org (its tile usage policy).
 *  - Steward's own User-Agent with the project's address, and the tiles are cached as their headers allow.
 *
 * The cache lives in <data>/cache/map/ (least recently used out, at most SM_MAP_CACHE_MB). Tiles up to zoom 12 are
 * shared; above it the cache key includes the user, so nobody can time answers to learn where others looked closely.
 */

/**
 * An error of the map with its English message also as the parameter `detail`: the web app's translated text names
 * what went wrong (an address, a status, the problem of a file) – never an API key (messages name origin and path only).
 */
export class MapError extends HttpError {
  constructor(status: number, message: string, code: string, params: Record<string, string | number> = {}) {
    super(status, message, code, { ...params, detail: message });
  }
}

export type FetchKind = 'tile' | 'json' | 'glyphs' | 'sprite';

export const USER_AGENT = `${BRAND.name}/${config.version} (+${BRAND.repoUrl})`;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const DEFAULT_TTL_S = 7 * 86400;
const MAX_TTL_S = 30 * 86400;

const TYPES: Record<FetchKind, string[]> = {
  tile: ['image/png', 'image/jpeg', 'image/webp', 'application/x-protobuf', 'application/vnd.mapbox-vector-tile', 'application/octet-stream'],
  json: ['application/json', 'text/json', 'application/geo+json'],
  glyphs: ['application/x-protobuf', 'application/octet-stream'],
  sprite: ['image/png', 'application/json'],
};
const LIMIT: Record<FetchKind, number> = {
  tile: PLANT_MAP_LIMITS.tileBytes,
  json: PLANT_MAP_LIMITS.fileBytes,
  glyphs: PLANT_MAP_LIMITS.fileBytes,
  sprite: PLANT_MAP_LIMITS.fileBytes,
};

export interface Fetched {
  body: Buffer;
  type: string;
}

/** Where a request goes and how: the URL without the key, the key's place, the origins it may reach. */
export interface Upstream {
  url: string;
  kind: FetchKind;
  origins: string[];
  key?: { place: 'query' | 'header'; name: string; value: string } | null;
  /** The key goes only to these origins (a stored key: its own source's origins); default: every origin of `origins` */
  keyOrigins?: string[];
  /** Part of the cache key: a new source never reads the old one's entries */
  stamp: string;
  /** Above zoom 12: the user whose own cache entry it is */
  user?: string | null;
}

// ---------- the source's state (GET /api/plant/map/status) ----------

let lastOk: string | null = null;
let lastError: { at: string; reason: string } | null = null;
export const fetchStatus = () => ({ lastOk, lastError });
export function resetFetchStatus(): void {
  lastOk = null;
  lastError = null;
}

/** Origin and path, without a query (where an API key may be). */
export function where(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'the source';
  }
}

const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
};

// ---------- parallel requests per origin ----------

const slots = new Map<string, { active: number; queue: (() => void)[] }>();
const maxParallel = (origin: string) => (new URL(origin).hostname === 'tile.openstreetmap.org' ? 2 : 4);
async function withSlot<T>(origin: string, fn: () => Promise<T>): Promise<T> {
  let s = slots.get(origin);
  if (!s) slots.set(origin, (s = { active: 0, queue: [] }));
  const slot = s;
  if (slot.active >= maxParallel(origin)) await new Promise<void>((resolve) => slot.queue.push(resolve));
  slot.active++;
  try {
    return await fn();
  } finally {
    slot.active--;
    slot.queue.shift()?.();
  }
}

// ---------- the disk cache ----------

interface Meta {
  type: string;
  /** Fresh until (ms since epoch) */
  exp: number;
  etag?: string;
  lastModified?: string;
  bytes: number;
}

const index = new Map<string, Meta>();
let total = 0;
let loaded = false;
const cacheDir = () => path.join(config.dataDir, 'cache', 'map');
const cacheLimit = () => env.SM_MAP_CACHE_MB * 1024 * 1024;

function loadIndex(): void {
  if (loaded) return;
  loaded = true;
  const dir = cacheDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return; // no cache yet
  }
  const found: { key: string; meta: Meta; at: number }[] = [];
  for (const n of names) {
    const key = n.slice(0, -5);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Meta;
      const at = fs.statSync(path.join(dir, `${key}.bin`)).mtimeMs;
      found.push({ key, meta, at });
    } catch {
      dropFiles(key); // half written: gone
    }
  }
  // least recently used first, so the Map's order is the eviction order
  for (const f of found.sort((a, b) => a.at - b.at)) {
    index.set(f.key, f.meta);
    total += f.meta.bytes;
  }
}

function dropFiles(key: string): void {
  for (const ext of ['.bin', '.json']) fs.rmSync(path.join(cacheDir(), key + ext), { force: true });
}

function evict(): void {
  const limit = cacheLimit();
  for (const [key, meta] of index) {
    if (total <= limit) break;
    index.delete(key);
    total -= meta.bytes;
    dropFiles(key);
  }
}

function cacheRead(key: string): { meta: Meta; body: Buffer } | null {
  if (!cacheLimit()) return null;
  loadIndex();
  const meta = index.get(key);
  if (!meta) return null;
  try {
    const body = fs.readFileSync(path.join(cacheDir(), `${key}.bin`));
    // most recently used: to the end of the order
    index.delete(key);
    index.set(key, meta);
    return { meta, body };
  } catch {
    index.delete(key);
    total -= meta.bytes;
    return null;
  }
}

function cacheWrite(key: string, meta: Meta, body: Buffer): void {
  if (!cacheLimit() || body.length > cacheLimit() / 4) return;
  loadIndex();
  const dir = cacheDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `${key}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, `${key}.bin`));
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(meta), { mode: 0o600 });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'map tile cache: could not write');
    return;
  }
  const before = index.get(key);
  if (before) total -= before.bytes;
  index.delete(key);
  index.set(key, meta);
  total += meta.bytes;
  evict();
}

/** Empties the cache (tests; a changed SM_MAP_CACHE_MB applies on the next write). */
export function clearMapCache(): void {
  index.clear();
  total = 0;
  loaded = false;
  fs.rmSync(cacheDir(), { recursive: true, force: true });
}

export const mapCacheBytes = (): number => {
  loadIndex();
  return total;
};

const cacheKeyOf = (u: Upstream): string =>
  crypto
    .createHash('sha256')
    .update(`${u.stamp}\u0000${u.url}\u0000${u.user ?? '*'}`)
    .digest('hex')
    .slice(0, 40);

/** How long an answer may be served without asking again (seconds), from Cache-Control / Expires; 0: not stored. */
export function freshFor(cacheControl: string | null, expires: string | null, now = Date.now()): number {
  const cc = (cacheControl ?? '').toLowerCase();
  if (cc.includes('no-store')) return 0;
  const parts = cc.split(',').map((x) => x.trim());
  if (parts.includes('no-cache')) return 60;
  const age = parts.find((x) => x.startsWith('max-age='));
  if (age) {
    const n = Number(age.slice(8));
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.max(n, 60), MAX_TTL_S);
  }
  if (expires) {
    const t = Date.parse(expires);
    if (Number.isFinite(t)) return Math.min(Math.max(Math.round((t - now) / 1000), 60), MAX_TTL_S);
  }
  return DEFAULT_TTL_S;
}

// ---------- the request ----------

const dispatcher = new EnvHttpProxyAgent({ connect: { lookup: guardedLookup }, requestTls: { lookup: guardedLookup } } as never);
const inFlight = new Map<string, Promise<Fetched>>();

/** Does a content type fit what was asked for? Answers the normalised type, or null. */
function acceptedType(kind: FetchKind, header: string | null, url: string): string | null {
  const t = (header ?? '').split(';')[0]!.trim().toLowerCase();
  if (TYPES[kind].includes(t)) {
    if (t === 'application/octet-stream' || t === 'application/vnd.mapbox-vector-tile') return 'application/x-protobuf';
    if (t === 'text/json' || t === 'application/geo+json') return 'application/json';
    return t;
  }
  // some servers answer a vector tile, a glyph range or a sprite sheet without a type: by its ending, never by content
  if (!t || t === 'binary/octet-stream') {
    const p = where(url).toLowerCase();
    if ((kind === 'tile' || kind === 'glyphs') && (p.endsWith('.pbf') || p.endsWith('.mvt'))) return 'application/x-protobuf';
    if (kind === 'json' && p.endsWith('.json')) return 'application/json';
  }
  return null;
}

async function readLimited(res: Awaited<ReturnType<typeof fetch>>, max: number, url: string): Promise<Buffer> {
  const tooLarge = () => new MapError(502, `${where(url)} answered with more than ${Math.round(max / 1024)} KB`, 'PLANT_MAP_UPSTREAM');
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined); // not read: a failed cancel changes nothing
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let n = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        await reader.cancel().catch(() => undefined); // the rest is not read: a failed cancel changes nothing
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

function withKey(url: string, key: Upstream['key'], keyOrigins?: string[]): { url: string; headers: Record<string, string> } {
  if (!key || (keyOrigins && !keyOrigins.includes(originOf(url) ?? ''))) return { url, headers: {} };
  if (key.place === 'header') return { url, headers: Object.fromEntries([[key.name.toLowerCase(), key.value]]) };
  const u = new URL(url);
  u.searchParams.set(key.name, key.value);
  return { url: u.toString(), headers: {} };
}

/** One request with the redirects it may follow (within the source's origins). 404: null. */
async function send(
  up: Upstream,
  cond: { etag?: string; lastModified?: string },
): Promise<{ status: number; res: Awaited<ReturnType<typeof fetch>> | null; url: string }> {
  let url = up.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const origin = originOf(url);
    if (!origin || !up.origins.includes(origin))
      throw new MapError(502, `${where(url)} is not one of the map source's origins`, 'PLANT_MAP_UPSTREAM', { reason: 'origin' });
    await assertAddressSafe(url).catch((e: unknown) => {
      throw new MapError(502, `${where(url)}: ${(e as Error).message}`, 'PLANT_MAP_UPSTREAM', { reason: 'address' });
    });
    const k = withKey(url, up.key, up.keyOrigins);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await withSlot(origin, () =>
        fetch(k.url, {
          method: 'GET',
          headers: {
            'user-agent': USER_AGENT,
            accept: up.kind === 'tile' ? 'image/*, application/x-protobuf;q=0.9, */*;q=0.5' : up.kind === 'sprite' ? 'image/png, application/json' : '*/*',
            ...(cond.etag ? { 'if-none-match': cond.etag } : {}),
            ...(cond.lastModified ? { 'if-modified-since': cond.lastModified } : {}),
            ...k.headers,
          },
          redirect: 'manual',
          dispatcher,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
      );
    } catch (e) {
      const err = e as Error & { cause?: Error & { code?: string } };
      const why = err.cause?.code === 'ESSRFBLOCKED' ? err.cause.message : err.name === 'TimeoutError' ? 'no answer within 10 s' : 'not reachable';
      throw new MapError(502, `${where(url)}: ${why}`, 'PLANT_MAP_UPSTREAM', { reason: 'unreachable' });
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined); // a redirect's body is not read: a failed cancel changes nothing
      if (!loc) throw new MapError(502, `${where(url)} redirected without a target`, 'PLANT_MAP_UPSTREAM', { reason: 'redirect' });
      url = new URL(loc, url).toString();
      continue;
    }
    return { status: res.status, res, url };
  }
  throw new MapError(502, `${where(up.url)} redirected too often`, 'PLANT_MAP_UPSTREAM', { reason: 'redirect' });
}

async function fetchFresh(up: Upstream, key: string, stale: { meta: Meta; body: Buffer } | null): Promise<Fetched> {
  const { status, res, url } = await send(up, stale ? { etag: stale.meta.etag, lastModified: stale.meta.lastModified } : {});
  if (status === 304 && stale) {
    const ttl = freshFor(res!.headers.get('cache-control'), res!.headers.get('expires'));
    await res!.body?.cancel().catch(() => undefined); // 304 has no body: a failed cancel changes nothing
    if (ttl) cacheWrite(key, { ...stale.meta, exp: Date.now() + ttl * 1000 }, stale.body);
    return { body: stale.body, type: stale.meta.type };
  }
  if (status === 404 || status === 204) {
    await res!.body?.cancel().catch(() => undefined); // nothing to read: a failed cancel changes nothing
    throw new HttpError(404, 'No tile here', 'PLANT_MAP_NO_TILE');
  }
  if (status < 200 || status >= 300) {
    await res!.body?.cancel().catch(() => undefined); // an error answer is not read: a failed cancel changes nothing
    const hint = status === 401 || status === 403 ? ' (check the API key)' : status === 429 ? ' (too many requests – the provider limits this server)' : '';
    throw new MapError(502, `${where(url)} answered ${status}${hint}`, 'PLANT_MAP_UPSTREAM', { reason: 'status', status });
  }
  const type = acceptedType(up.kind, res!.headers.get('content-type'), url);
  if (!type) {
    await res!.body?.cancel().catch(() => undefined); // refused unread: a failed cancel changes nothing
    throw new MapError(502, `${where(url)} answered with an unexpected content type`, 'PLANT_MAP_UPSTREAM', { reason: 'type' });
  }
  const body = await readLimited(res!, LIMIT[up.kind], url);
  const ttl = freshFor(res!.headers.get('cache-control'), res!.headers.get('expires'));
  if (ttl)
    cacheWrite(
      key,
      {
        type,
        exp: Date.now() + ttl * 1000,
        ...(res!.headers.get('etag') ? { etag: res!.headers.get('etag')! } : {}),
        ...(res!.headers.get('last-modified') ? { lastModified: res!.headers.get('last-modified')! } : {}),
        bytes: body.length,
      },
      body,
    );
  return { body, type };
}

/**
 * A tile, style, glyph range or sprite file: from the cache while fresh, else from the source (asking again with the
 * cached ETag when there is one). When the source fails, a cached copy is served even when it is stale.
 */
export async function fetchMapFile(up: Upstream): Promise<Fetched> {
  const key = cacheKeyOf(up);
  const hit = cacheRead(key);
  if (hit && hit.meta.exp > Date.now()) return { body: hit.body, type: hit.meta.type };
  const running = inFlight.get(key);
  if (running) return running;
  const p = fetchFresh(up, key, hit)
    .then((r) => {
      lastOk = new Date().toISOString();
      return r;
    })
    .catch((e: unknown) => {
      if ((e as HttpError).statusCode !== 404) {
        lastError = { at: new Date().toISOString(), reason: (e as Error).message };
        if (hit) return { body: hit.body, type: hit.meta.type };
      }
      throw e;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ---------- self-hosted PMTiles files ----------

/** A PMTiles archive on disk, read in byte ranges (the browser never gets the file). */
class DiskSource implements Source {
  constructor(private file: string) {}
  getKey(): string {
    return this.file;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const fh = await fs.promises.open(this.file, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      const out = buf.subarray(0, bytesRead);
      return { data: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer };
    } finally {
      await fh.close();
    }
  }
}

const archives = new Map<string, { stamp: string; p: PMTiles }>();
/** The PMTiles reader of a file (one per file and modification time). */
export function archiveOf(file: string): PMTiles {
  const st = fs.statSync(file);
  const stamp = `${st.size}|${st.mtimeMs}`;
  const hit = archives.get(file);
  if (hit && hit.stamp === stamp) return hit.p;
  const p = new PMTiles(new DiskSource(file));
  archives.set(file, { stamp, p });
  return p;
}

const TILE_TYPES: Partial<Record<TileType, string>> = {
  [TileType.Mvt]: 'application/x-protobuf',
  [TileType.Png]: 'image/png',
  [TileType.Jpeg]: 'image/jpeg',
  [TileType.Webp]: 'image/webp',
};

export async function pmtilesTile(file: string, z: number, x: number, y: number): Promise<Fetched> {
  const p = archiveOf(file);
  const h = await p.getHeader();
  const type = TILE_TYPES[h.tileType];
  if (!type) throw new MapError(502, 'The map file holds tiles of a type Steward cannot serve', 'PLANT_MAP_UPSTREAM', { reason: 'type' });
  const t = await p.getZxy(z, x, y);
  if (!t) throw new HttpError(404, 'No tile here', 'PLANT_MAP_NO_TILE');
  const body = Buffer.from(t.data);
  if (body.length > PLANT_MAP_LIMITS.tileBytes) throw new MapError(502, 'A tile of the map file is too large', 'PLANT_MAP_UPSTREAM', { reason: 'size' });
  return { body, type };
}

/** Forgets the open files (a new source, or a file replaced in place). */
export function clearArchives(): void {
  archives.clear();
}
