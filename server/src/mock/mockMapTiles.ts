import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { zxyToTileId } from 'pmtiles';
import { loopbackUrl } from '../config.js';

/**
 * A made-up tile source for the demo and the tests (#234), mounted at /mock/map: the map of sites never fetches real
 * tiles there. In demo mode the built-in sources (OpenStreetMap, OpenFreeMap) point here (plant/mapTiles.ts), and the
 * tests set own sources and PMTiles files that use it.
 *
 *   GET /mock/map/osm/:z/:x/:y.png                 raster tiles: a pale chequered pattern with a grid (PNG)
 *   GET /mock/map/openfreemap/planet               TileJSON of the vector tiles below
 *   GET /mock/map/openfreemap/tiles/:z/:x/:y.pbf   vector tiles in the OpenMapTiles schema (water, landcover,
 *                                                  transportation, building, place)
 *   GET /mock/map/style.json                       a MapLibre style (an "own style URL"), raster, with glyphs and a sprite
 *   GET /mock/map/fonts/:fontstack/:range          glyphs (an empty glyph set)
 *   GET /mock/map/sprite(@2x).json|png             a sprite with one image
 *   GET /mock/map/key/:z/:x/:y.png                 raster tiles that need ?key=demo-map-key (or the header x-map-key)
 *   GET /mock/map/redirect/:z/:x/:y                redirects to localhost (another origin than 127.0.0.1)
 *   GET /mock/map/html/:z/:x/:y                    answers HTML (a wrong content type)
 *   GET /mock/map/big/:z/:x/:y                     200 KB "tiles" (the cache's size limit)
 *
 * Every answer is small and generated on the fly; nothing here names a real place.
 */

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** An RGB PNG of size×size drawn by `px(x, y)`. */
export function pngOf(size: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = px(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rasterCache = new Map<string, Buffer>();
/** A mock raster tile: land in pale green and sand, a grid every 64 px, darker with the zoom level. */
export function mockRasterTile(z: number, x: number, y: number): Buffer {
  const key = `${z % 4}|${(x + y) % 2}`;
  let b = rasterCache.get(key);
  if (!b) {
    const even = (x + y) % 2 === 0;
    const base: [number, number, number] = even ? [233, 240, 226] : [242, 238, 226];
    const shade = (z % 4) * 4;
    b = pngOf(256, (px, py) =>
      px % 64 === 0 || py % 64 === 0 ? [205 - shade, 211 - shade, 214 - shade] : [base[0] - shade, base[1] - shade, base[2] - shade],
    );
    rasterCache.set(key, b);
  }
  return b;
}

// ---------- vector tiles (Mapbox Vector Tile 2.1, protobuf) ----------

const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 127) {
    out.push((v & 127) | 128);
    v >>>= 7;
  }
  out.push(v);
  return out;
};
const zigzag = (n: number) => (n << 1) ^ (n >> 31);
const field = (num: number, wire: number) => varint((num << 3) | wire);
const bytesField = (num: number, data: number[] | Buffer) => [...field(num, 2), ...varint(data.length), ...data];
const stringField = (num: number, s: string) => bytesField(num, Buffer.from(s, 'utf8'));
const uintField = (num: number, v: number) => [...field(num, 0), ...varint(v)];
const packed = (num: number, values: number[]) => bytesField(num, values.flatMap(varint));

type Geom = { type: 1 | 2 | 3; rings: [number, number][][] };
function geometry(g: Geom): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const ring of g.rings) {
    const [first, ...rest] = ring;
    out.push((1 & 7) | (1 << 3), zigzag(first![0] - cx), zigzag(first![1] - cy));
    cx = first![0];
    cy = first![1];
    if (rest.length) {
      out.push((2 & 7) | (rest.length << 3));
      for (const [x, y] of rest) {
        out.push(zigzag(x - cx), zigzag(y - cy));
        cx = x;
        cy = y;
      }
    }
    if (g.type === 3) out.push((7 & 7) | (1 << 3));
  }
  return out;
}

interface MockFeature {
  geom: Geom;
  props: Record<string, string>;
}
function layer(name: string, features: MockFeature[]): number[] {
  const keys: string[] = [];
  const values: string[] = [];
  const idx = (list: string[], v: string) => {
    let i = list.indexOf(v);
    if (i < 0) i = list.push(v) - 1;
    return i;
  };
  const feats = features.map((f, i) => {
    const tags = Object.entries(f.props).flatMap(([k, v]) => [idx(keys, k), idx(values, v)]);
    return bytesField(2, [...uintField(1, i + 1), ...packed(2, tags), ...uintField(3, f.geom.type), ...packed(4, geometry(f.geom))]);
  });
  return bytesField(3, [
    ...uintField(15, 2),
    ...stringField(1, name),
    ...feats.flat(),
    ...keys.flatMap((k) => stringField(3, k)),
    ...values.flatMap((v) => bytesField(4, stringField(1, v))),
    ...uintField(5, 4096),
  ]);
}

const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x0, y1],
  [x1, y1],
  [x1, y0],
  [x0, y0],
];
const PLACES = ['Northfield', 'Lakeside', 'Old Mill', 'Eastbrook', 'Hillcrest', 'Riverbend', 'Stonebridge', 'Greenvale'];

/** A mock vector tile in the OpenMapTiles schema (layer and class names as there), the same pattern on every tile. */
export function mockVectorTile(z: number, x: number, y: number): Buffer {
  const k = (x * 7 + y * 13 + z) % 5;
  const layers: number[] = [];
  layers.push(...layer('landcover', [{ geom: { type: 3, rings: [square(0, 0, 4096, 4096)] }, props: { class: k % 2 ? 'grass' : 'farmland' } }]));
  layers.push(...layer('park', [{ geom: { type: 3, rings: [square(2600, 300, 3800, 1400)] }, props: { class: 'park' } }]));
  if (k !== 1) layers.push(...layer('water', [{ geom: { type: 3, rings: [square(300 + k * 120, 2600, 1900, 3900)] }, props: { class: 'lake' } }]));
  layers.push(
    ...layer('transportation', [
      {
        geom: {
          type: 2,
          rings: [
            [
              [0, 2048],
              [4096, 2048 + (k - 2) * 200],
            ],
          ],
        },
        props: { class: 'primary' },
      },
      {
        geom: {
          type: 2,
          rings: [
            [
              [1400, 0],
              [1600, 4096],
            ],
          ],
        },
        props: { class: 'minor' },
      },
    ]),
  );
  if (z >= 13)
    layers.push(
      ...layer('building', [
        { geom: { type: 3, rings: [square(2200, 2300, 2600, 2700)] }, props: {} },
        { geom: { type: 3, rings: [square(2800, 2300, 3300, 2600)] }, props: {} },
      ]),
    );
  layers.push(
    ...layer('place', [{ geom: { type: 1, rings: [[[3000, 3200]]] }, props: { class: z < 9 ? 'town' : 'village', name: PLACES[(x + y) % PLACES.length]! } }]),
  );
  return Buffer.from(layers);
}

// ---------- PMTiles (v3) ----------

/** Writes a PMTiles v3 archive (uncompressed, one root directory) with the given tiles – for the demo and the tests. */
export function pmtilesArchive(
  tiles: { z: number; x: number; y: number; data: Buffer }[],
  o: { tileType: 1 | 2 | 3 | 4; metadata: Record<string, unknown>; minZoom: number; maxZoom: number },
): Buffer {
  const entries = tiles.map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), data: t.data })).sort((a, b) => a.id - b.id);
  let offset = 0;
  const dirEntries = entries.map((e) => {
    const d = { id: e.id, offset, length: e.data.length };
    offset += e.data.length;
    return d;
  });
  const dir: number[] = [...varint(dirEntries.length)];
  let last = 0;
  for (const e of dirEntries) {
    dir.push(...varint(e.id - last));
    last = e.id;
  }
  dirEntries.forEach(() => dir.push(1));
  for (const e of dirEntries) dir.push(...varint(e.length));
  dirEntries.forEach((e, i) => dir.push(...varint(i > 0 && e.offset === dirEntries[i - 1]!.offset + dirEntries[i - 1]!.length ? 0 : e.offset + 1)));
  const dirBuf = Buffer.from(dir);
  const meta = Buffer.from(JSON.stringify(o.metadata), 'utf8');
  const data = Buffer.concat(entries.map((e) => e.data));
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'ascii');
  h[7] = 3;
  const u64 = (pos: number, v: number) => h.writeBigUInt64LE(BigInt(v), pos);
  const rootOff = 127;
  const metaOff = rootOff + dirBuf.length;
  const dataOff = metaOff + meta.length;
  u64(8, rootOff);
  u64(16, dirBuf.length);
  u64(24, metaOff);
  u64(32, meta.length);
  u64(40, dataOff + data.length);
  u64(48, 0);
  u64(56, dataOff);
  u64(64, data.length);
  u64(72, entries.length);
  u64(80, entries.length);
  u64(88, entries.length);
  h[96] = 1; // clustered
  h[97] = 1; // internal compression: none
  h[98] = 1; // tile compression: none
  h[99] = o.tileType;
  h[100] = o.minZoom;
  h[101] = o.maxZoom;
  h.writeInt32LE(-180 * 1e7, 102);
  h.writeInt32LE(-85 * 1e7, 106);
  h.writeInt32LE(180 * 1e7, 110);
  h.writeInt32LE(85 * 1e7, 114);
  h[118] = o.minZoom;
  h.writeInt32LE(0, 119);
  h.writeInt32LE(0, 123);
  return Buffer.concat([h, dirBuf, meta, data]);
}

/** Every tile of zoom 0 … maxZoom. */
function pyramid(maxZoom: number, tile: (z: number, x: number, y: number) => Buffer) {
  const out: { z: number; x: number; y: number; data: Buffer }[] = [];
  for (let z = 0; z <= maxZoom; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) out.push({ z, x, y, data: tile(z, x, y) });
  return out;
}

/** The demo's self-hosted file: <data>/maps/demo-raster.pmtiles, zoom 0–4 (written once). */
export function writeDemoPmtiles(mapsDir: string): string {
  const file = path.join(mapsDir, 'demo-raster.pmtiles');
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(mapsDir, { recursive: true, mode: 0o700 });
  const buf = pmtilesArchive(pyramid(4, mockRasterTile), {
    tileType: 2,
    minZoom: 0,
    maxZoom: 4,
    metadata: { name: 'Demo raster', attribution: 'Demo tiles (made up)', type: 'baselayer' },
  });
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return file;
}

/** A small vector PMTiles file in the Protomaps or OpenMapTiles schema (zoom 0–2), for the tests. */
export function vectorPmtiles(schema: 'protomaps' | 'openmaptiles' | 'other'): Buffer {
  const ids = schema === 'protomaps' ? ['earth', 'water', 'roads', 'places'] : schema === 'openmaptiles' ? ['water', 'transportation', 'place'] : ['things'];
  return pmtilesArchive(pyramid(2, mockVectorTile), {
    tileType: 1,
    minZoom: 0,
    maxZoom: 2,
    metadata: {
      name: `Mock ${schema}`,
      attribution: '<a href="https://example.com">Mock data</a> & friends',
      vector_layers: ids.map((id) => ({ id, fields: {} })),
    },
  });
}

// ---------- routes ----------

const coords = (req: FastifyRequest): { z: number; x: number; y: number } | null => {
  const p = req.params as Record<string, string>;
  const z = Number(p.z);
  const x = Number(p.x);
  const y = Number(String(p.y).split('.')[0]);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;
  return { z, x, y };
};

/** How often the mock answered, by path family (the tests check that the cache keeps requests away). */
export const mockMapHits = { raster: 0, vector: 0, tilejson: 0, style: 0, glyphs: 0, sprite: 0, key: 0, big: 0, userAgent: '' };

export const DEMO_MAP_KEY = 'demo-map-key';

export async function mockMapTiles(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    if (req.url.includes('/map/')) mockMapHits.userAgent = String(req.headers['user-agent'] ?? '');
  });
  const raster = async (req: FastifyRequest, reply: FastifyReply) => {
    const c = coords(req);
    if (!c) return reply.code(404).send();
    mockMapHits.raster++;
    return reply
      .header('cache-control', 'public, max-age=86400')
      .type('image/png')
      .send(mockRasterTile(c.z, c.x, c.y));
  };
  app.get('/map/osm/:z/:x/:y', raster);
  app.get('/map/key/:z/:x/:y', async (req, reply) => {
    mockMapHits.key++;
    if ((req.query as Record<string, string>).key !== DEMO_MAP_KEY && req.headers['x-map-key'] !== DEMO_MAP_KEY) return reply.code(401).send();
    return raster(req, reply);
  });
  app.get('/map/redirect/:z/:x/:y', async (req, reply) => {
    const p = req.params as Record<string, string>;
    return reply.redirect(`${loopbackUrl().replace('127.0.0.1', 'localhost')}/mock/map/osm/${p.z}/${p.x}/${p.y}`);
  });
  app.get('/map/html/:z/:x/:y', async (_req, reply) => reply.type('text/html').send('<html><script>alert(1)</script></html>'));
  app.get('/map/big/:z/:x/:y', async (req, reply) => {
    const c = coords(req);
    if (!c) return reply.code(404).send();
    mockMapHits.big++;
    const b = Buffer.alloc(200 * 1024, (c.x * 31 + c.y * 7 + c.z) % 251);
    return reply.header('cache-control', 'public, max-age=86400').type('image/png').send(b);
  });
  app.get('/map/openfreemap/planet', async (_req, reply) => {
    mockMapHits.tilejson++;
    return reply.header('cache-control', 'public, max-age=3600').send({
      tilejson: '3.0.0',
      tiles: [`${loopbackUrl()}/mock/map/openfreemap/tiles/{z}/{x}/{y}.pbf`],
      minzoom: 0,
      maxzoom: 14,
      attribution: '<a href="https://example.com">Mock vector tiles</a>',
      vector_layers: ['landcover', 'park', 'water', 'transportation', 'building', 'place'].map((id) => ({ id, fields: {} })),
    });
  });
  app.get('/map/openfreemap/tiles/:z/:x/:y', async (req, reply) => {
    const c = coords(req);
    if (!c) return reply.code(404).send();
    mockMapHits.vector++;
    return reply
      .header('cache-control', 'public, max-age=86400')
      .type('application/x-protobuf')
      .send(mockVectorTile(c.z, c.x, c.y));
  });
  app.get('/map/style.json', async (_req, reply) => {
    mockMapHits.style++;
    const base = `${loopbackUrl()}/mock/map`;
    return reply.send({
      version: 8,
      name: 'Mock own style',
      metadata: { 'mock:comment': 'dropped by Steward' },
      sprite: `${base}/sprite`,
      glyphs: `${base}/fonts/{fontstack}/{range}.pbf`,
      sources: {
        'mock-raster': { type: 'raster', tiles: [`${base}/osm/{z}/{x}/{y}.png`], tileSize: 256, maxzoom: 18, attribution: 'Mock own style <b>tiles</b>' },
        'mock-vector': { type: 'vector', url: `${base}/openfreemap/planet` },
        ignored: { type: 'geojson', data: `${base}/data.geojson` },
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#eef2f0' } },
        { id: 'tiles', type: 'raster', source: 'mock-raster', metadata: { dropped: true } },
        { id: 'points', type: 'circle', source: 'ignored' },
        {
          id: 'places',
          type: 'symbol',
          source: 'mock-vector',
          'source-layer': 'place',
          layout: { 'text-field': ['get', 'name'], 'text-font': ['literal', ['Mock Sans Regular']], 'icon-image': 'dot' },
        },
      ],
    });
  });
  app.get('/map/fonts/:fontstack/:range', async (_req, reply) => {
    mockMapHits.glyphs++;
    return reply.type('application/x-protobuf').send(Buffer.alloc(0));
  });
  app.get('/map/:sprite', async (req, reply) => {
    const name = (req.params as { sprite: string }).sprite;
    if (!/^sprite(@2x)?\.(json|png)$/.test(name)) return reply.code(404).send();
    mockMapHits.sprite++;
    if (name.endsWith('.json')) return reply.send({ dot: { x: 0, y: 0, width: 8, height: 8, pixelRatio: name.includes('@2x') ? 2 : 1 } });
    return reply.type('image/png').send(pngOf(8, () => [28, 126, 214]));
  });
}
