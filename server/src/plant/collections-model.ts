import { z } from 'zod';
import {
  COLLECTION_DESTINATION_KINDS,
  COLLECTION_FORMATS,
  COLLECTION_MODES,
  COLLECTOR_KINDS,
  modbusAddress,
  PLANT_COLLECTION_LIMITS as L,
  PLANT_ID_RE,
  SINK_TRANSFORM_KINDS,
  type PlantCollectionDestination,
  type PlantCollectionSink,
  PLANT_LIMITS,
  type PlantAssignmentValues,
  type PlantCollectionCoverage,
  type PlantCollectionItem,
  type PlantCollectionPoint,
  type PlantCollectionValues,
  type PlantCollector,
  type PlantInterface,
  type PlantProtocol,
} from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { plantId } from './model.js';
import { assetModel } from './resolve.js';

/**
 * Data collections (0.11.0, docs/adr/0019-data-collections.md): what a collector reads from an asset, stored per
 * asset and id (table plant_collections), and the mappings remembered from imports (plant_collection_mappings). The
 * rules here are pure: address and name normalisation, the asset's points (its model with its own addresses), the
 * coverage of a collection.
 */

// ---------- rows ----------

export interface CollectionRow {
  asset_id: string;
  id: string;
  name: string;
  collector: string;
  data_path_id: string | null;
  interface_id: string | null;
  mode: string;
  interval_ms: number | null;
  debounce_ms: number | null;
  triggers: string;
  composition: string;
  destination: string | null;
  access: string;
  settings: string;
  items: string;
  /** 0.12.0 (plant-008) */
  description: string;
  notes: string;
  format: string;
  source_file: string;
  /** 0.12: the sinks (JSON); '[]' with a destination: the destination is the first sink */
  sinks: string;
  /** 0.12: the gateway configuration document the imports keep up to date */
  document_id: string | null;
  position: number;
  import_id: string | null;
  not_in_source: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface MappingRow {
  collector_key: string;
  /** Empty: a collector alias, for every asset the collector reads */
  asset_id: string;
  gateway_name: string;
  data_point: string;
  created_at: string;
  created_by: string;
}

export const collectorKey = (c: PlantCollector) => `${c.kind}:${c.ref}`;

/** A plant id made from a name (sinks, collections): lower case, the rest replaced by "-". */
export const idOf = (name: string, fallback = 'sink'): string => {
  const x = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 80);
  return PLANT_ID_RE.test(x) ? x : fallback;
};

/** The single destination of 0.11 as a sink (stored rows that were never saved with sinks). */
export const sinkOfDestination = (d: PlantCollectionDestination): PlantCollectionSink => ({
  id: idOf(d.ref),
  name: d.ref,
  kind: d.kind,
  ref: d.ref,
  object: d.path,
  format: '',
  schedule: '',
  owner: '',
  description: d.notes,
  transforms: [],
  mappings: [],
  imported: false,
});

/** The first sink as the destination of 0.11 (older clients and the API read it). */
export const destinationOfSink = (s: PlantCollectionSink | undefined): PlantCollectionDestination | null =>
  s ? { kind: s.kind, ref: s.ref, path: s.object, notes: s.description } : null;

/** A stored sink with every field (rows written by an older version may lack new ones). */
const fullSink = (x: Partial<PlantCollectionSink>): PlantCollectionSink => ({
  id: x.id ?? 'sink',
  name: x.name ?? '',
  kind: x.kind ?? 'other',
  ref: x.ref ?? '',
  object: x.object ?? '',
  format: x.format ?? '',
  schedule: x.schedule ?? '',
  owner: x.owner ?? '',
  description: x.description ?? '',
  transforms: x.transforms ?? [],
  mappings: (x.mappings ?? []).map(ihClean),
  imported: x.imported ?? false,
  ...(x.ih && (x.ih.assetId || x.ih.aspect) ? { ih: { assetId: x.ih.assetId ?? '', assetName: x.ih.assetName ?? '', aspect: x.ih.aspect ?? '' } } : {}),
});

/** A mapping without empty Insights Hub fields (0.14): what an older version stored and what it reads back stay the same. */
export function ihClean<T extends { assetId?: string; assetName?: string; aspect?: string }>(m: T): T {
  const out = { ...m };
  for (const k of ['assetId', 'assetName', 'aspect'] as const) if (!out[k]) delete out[k];
  return out;
}

/** The sinks of a row: the stored ones, else the 0.11 destination as the first one. */
export function sinksOf(r: Pick<CollectionRow, 'sinks' | 'destination'>): PlantCollectionSink[] {
  const stored = parseJson<Partial<PlantCollectionSink>[]>(r.sinks ?? '[]', []);
  if (stored.length) return stored.map(fullSink);
  const d = r.destination ? parseJson<PlantCollectionDestination | null>(r.destination, null) : null;
  return d ? [sinkOfDestination(d)] : [];
}

export const collectionValuesOf = (r: CollectionRow): PlantCollectionValues => ({
  id: r.id,
  name: r.name,
  collector: parseJson<PlantCollector>(r.collector, { kind: 'job', ref: '', host: null }),
  dataPathId: r.data_path_id ?? null,
  interfaceId: r.interface_id ?? null,
  mode: (r.mode || 'interval') as PlantCollectionValues['mode'],
  intervalMs: r.interval_ms === null ? null : Number(r.interval_ms),
  debounceMs: r.debounce_ms === null ? null : Number(r.debounce_ms),
  triggers: parseJson(r.triggers, []),
  composition: r.composition,
  destination: destinationOfSink(sinksOf(r)[0]),
  sinks: sinksOf(r),
  access: { read: [], write: [], create: [], delete: [], ...parseJson<Partial<PlantCollectionValues['access']>>(r.access, {}) },
  settings: parseJson(r.settings, []),
  // an item stored before 0.12.0 has no description
  items: parseJson<PlantCollectionItem[]>(r.items, []).map((i) => ({ ...i, description: i.description ?? '' })),
  description: r.description ?? '',
  notes: r.notes,
  format: (r.format || '') as PlantCollectionValues['format'],
  sourceFile: r.source_file,
});

export const collectionRows = (assetId: string) => db().all<CollectionRow>('SELECT * FROM plant_collections WHERE asset_id = ? ORDER BY position, id', assetId);
export const collectionRowOf = (assetId: string, id: string) =>
  db().get<CollectionRow>('SELECT * FROM plant_collections WHERE asset_id = ? AND id = ?', assetId, id);

// ---------- input ----------

const text = (max: number = L.text) => z.string().trim().max(max).default('');
const ms = z
  .number()
  .int()
  .min(0)
  .max(31 * 86_400_000)
  .nullable()
  .default(null);
const patterns = z.array(z.string().trim().min(1).max(L.address)).max(L.patterns).default([]);

export const collectionItemInput = z
  .object({
    address: text(L.address),
    outputName: text(),
    outputType: text(60),
    dataPoint: z.string().trim().min(1).max(120).nullable().default(null),
    transform: z
      .object({
        note: text(2000),
        scale: z.number().finite().nullable().default(null),
        offset: z.number().finite().nullable().default(null),
        cast: text(40),
      })
      .strict()
      .default({ note: '', scale: null, offset: null, cast: '' }),
    description: text(PLANT_LIMITS.description),
    notes: text(2000),
  })
  .strict();

const sinkInput = z
  .object({
    id: plantId,
    name: z.string().trim().min(1).max(L.text),
    kind: z.enum(COLLECTION_DESTINATION_KINDS).default('other'),
    ref: text(L.text),
    object: text(L.address),
    format: text(),
    schedule: text(2000),
    owner: text(),
    description: text(L.longText),
    transforms: z
      .array(
        z
          .object({
            kind: z.enum(SINK_TRANSFORM_KINDS).default('other'),
            field: text(),
            // an expression or code, kept as text: never run
            expression: text(L.longText),
            window: text(),
            function: text(),
            description: text(2000),
          })
          .strict(),
      )
      .max(L.transforms)
      .default([]),
    mappings: z
      .array(
        z
          .object({
            item: z.string().trim().min(1).max(L.address),
            target: text(L.address),
            transform: text(2000),
            // 0.14, an Insights Hub sink: the item's own asset (its id there, or a placeholder) and aspect
            assetId: z.string().trim().max(L.text).optional(),
            assetName: z.string().trim().max(L.text).optional(),
            aspect: z.string().trim().max(L.text).optional(),
          })
          .strict()
          .transform(ihClean),
      )
      .max(L.items)
      .default([]),
    imported: z.boolean().default(false),
    /** 0.14, an Insights Hub sink: the default asset and aspect of its items */
    ih: z
      .object({ assetId: text(L.text), assetName: text(L.text), aspect: text(L.text) })
      .strict()
      .nullable()
      .optional()
      .transform((x) => (x && (x.assetId || x.aspect) ? x : undefined)),
  })
  .strict()
  .transform(({ ih, ...x }) => (ih ? { ...x, ih } : x));

export const collectionInput = z
  .object({
    id: plantId,
    name: z.string().trim().min(1).max(L.text),
    collector: z
      .object({
        kind: z.enum(COLLECTOR_KINDS),
        ref: z.string().trim().min(1).max(L.text),
        host: z.string().trim().min(1).max(100).nullable().default(null),
      })
      .strict(),
    dataPathId: plantId.nullable().default(null),
    interfaceId: z.string().trim().min(1).max(120).nullable().default(null),
    mode: z.enum(COLLECTION_MODES).default('interval'),
    intervalMs: ms,
    debounceMs: ms,
    triggers: z
      .array(z.object({ name: text(), condition: text(), referencePoint: text(L.address), referenceValue: text() }).strict())
      .max(L.triggers)
      .default([]),
    composition: text(2000),
    destination: z
      .object({
        kind: z.enum(COLLECTION_DESTINATION_KINDS).default('other'),
        ref: z.string().trim().min(1).max(L.text),
        path: text(L.address),
        notes: text(2000),
      })
      .strict()
      .nullable()
      .default(null),
    /** 0.12: where the data goes; missing: the destination (0.11) is the only sink */
    sinks: z.array(sinkInput).max(L.sinks).optional(),
    access: z.object({ read: patterns, write: patterns, create: patterns, delete: patterns }).strict().default({ read: [], write: [], create: [], delete: [] }),
    settings: z
      .array(z.object({ key: z.string().trim().min(1).max(L.text), value: text(2000) }).strict())
      .max(L.settings)
      .default([]),
    items: z.array(collectionItemInput).max(L.items).default([]),
    description: text(PLANT_LIMITS.description),
    notes: text(L.longText),
    format: z.union([z.enum(COLLECTION_FORMATS), z.literal('')]).default(''),
    sourceFile: text(),
  })
  .strict();
export const collectionUpdate = collectionInput.omit({ id: true });

/**
 * The values of an input: its sinks, or – from a client of 0.11 that sends only a destination – the destination as
 * the one sink. The destination is always the first sink.
 */
export function withSinks<T extends { destination: PlantCollectionDestination | null; sinks?: PlantCollectionSink[] }>(
  input: T,
): Omit<T, 'sinks'> & { sinks: PlantCollectionSink[]; destination: PlantCollectionDestination | null } {
  const sinks = input.sinks ?? (input.destination ? [sinkOfDestination(input.destination)] : []);
  return { ...input, sinks, destination: destinationOfSink(sinks[0]) };
}

// ---------- normalising ----------

/** Protocols whose addresses ignore case (PLC and CNC variable paths, Modbus). OPC UA NodeIds do not. */
const caseSensitive = (protocol: PlantProtocol | null) => protocol === 'opc_ua';

/**
 * The keys an address is matched by: whitespace removed (`[u1, 1]` is `[u1,1]`), lower case where the protocol
 * ignores case, a Modbus address in its canonical form, and for an OPC UA NodeId with a string identifier also the
 * identifier alone (a gateway that writes `/Channel/State/progStatus[u1]` reads `ns=2;s=/Channel/State/progStatus[u1]`).
 */
export function addressKeys(address: string, protocol: PlantProtocol | null): string[] {
  const bare = address.replace(/\s+/g, '');
  if (!bare) return [];
  const out = new Set<string>();
  const m = modbusAddress(bare);
  if (m) out.add(`modbus:${m.table}:${m.address}:${m.count}`);
  const ns = /^(?:ns=\d+|nsu=[^;]+);s=(.+)$/i.exec(bare);
  if (ns) out.add(ns[1]!);
  out.add(caseSensitive(protocol) ? bare : bare.toLowerCase());
  // a gateway's address is compared case-insensitively unless its interface is known to be OPC UA
  if (protocol === null) out.add(bare.toLowerCase());
  return [...out];
}

/** Two addresses are the same (normalised, see addressKeys). */
export function sameAddress(a: string, b: string, protocol: PlantProtocol | null): boolean {
  const ka = new Set(addressKeys(a, protocol));
  return addressKeys(b, protocol).some((k) => ka.has(k));
}

/** A name for matching: lower case, letters and digits only (`Spindle_speed-Act` → `spindlespeedact`). */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** How alike two names are, 0 … 1 (Dice coefficient of letter pairs of their name keys). */
export function similarity(a: string, b: string): number {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const px = pairs(x);
  const py = pairs(y);
  let both = 0;
  for (const [k, n] of px) both += Math.min(n, py.get(k) ?? 0);
  return (2 * both) / (x.length - 1 + (y.length - 1));
}

// ---------- the asset's points ----------

/** The data points of an asset's model with the asset's own addresses (the override's, else the profile's). */
export function assetPoints(
  a: PlantAssignmentValues | null | undefined,
  profile: Pick<PlantProfileLike, 'interfaces'> | null | undefined,
): { points: (PlantCollectionPoint & { aliases: string[]; protocol: PlantProtocol })[]; interfaces: PlantInterface[] } {
  const model = assetModel(a ?? null, profile);
  const overrides = new Map((a?.overrides ?? []).map((o) => [o.dataPoint, o]));
  const points = model.interfaces.flatMap((i) =>
    i.groups.flatMap((g) =>
      g.dataPoints.map((d) => ({
        id: d.id,
        name: d.name,
        interface: i.id,
        protocol: i.protocol,
        address: overrides.get(d.id)?.address || d.address,
        dataType: overrides.get(d.id)?.dataType || d.dataType,
        unit: overrides.get(d.id)?.unit || d.unit,
        added: model.added.points.has(d.id),
        aliases: d.aliases ?? [],
      })),
    ),
  );
  return { points, interfaces: model.interfaces };
}
type PlantProfileLike = { interfaces: PlantInterface[] };

/** The coverage of one collection; `readByOthers` are the data points the asset's other collections read. */
export function coverageOf(
  v: Pick<PlantCollectionValues, 'items' | 'interfaceId'>,
  points: PlantCollectionPoint[],
  readByAll: Set<string>,
  protocolOf: (iface: string | null) => PlantProtocol | null,
): PlantCollectionCoverage {
  const byId = new Map(points.map((p) => [p.id, p]));
  const proto = protocolOf(v.interfaceId);
  const unknown: number[] = [];
  const stale: number[] = [];
  const seen = new Map<string, number[]>();
  let mapped = 0;
  v.items.forEach((it: PlantCollectionItem, i) => {
    if (it.dataPoint && byId.has(it.dataPoint)) {
      mapped++;
      seen.set(it.dataPoint, [...(seen.get(it.dataPoint) ?? []), i]);
      return;
    }
    if (it.dataPoint) stale.push(i);
    else if (!points.some((p) => p.address && sameAddress(p.address, it.address, proto ?? protocolOf(p.interface)))) unknown.push(i);
  });
  const scope = v.interfaceId ? points.filter((p) => p.interface === v.interfaceId) : points;
  return {
    mapped,
    raw: v.items.length - mapped,
    unknown,
    stale,
    duplicates: [...seen].filter(([, items]) => items.length > 1).map(([dataPoint, items]) => ({ dataPoint, items })),
    notCollected: scope.filter((p) => !readByAll.has(p.id)),
  };
}

/** What a collection may not hold: an item twice by address and name is fine, an unknown interface or data path is not. */
export function collectionProblems(
  v: PlantCollectionValues,
  ctx: { interfaces: Set<string>; dataPaths: Set<string>; points: Set<string> },
): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (v.interfaceId && !ctx.interfaces.has(v.interfaceId)) out.push({ path: 'interfaceId', message: `The asset has no interface "${v.interfaceId}"` });
  if (v.dataPathId && !ctx.dataPaths.has(v.dataPathId)) out.push({ path: 'dataPathId', message: `The asset has no data path "${v.dataPathId}"` });
  const sinkIds = new Set<string>();
  v.sinks.forEach((x, i) => {
    if (sinkIds.has(x.id)) out.push({ path: `sinks[${i}].id`, message: `Sink "${x.id}" is there twice` });
    sinkIds.add(x.id);
    if (x.kind !== 'other' && x.kind !== 'publication' && !x.ref) out.push({ path: `sinks[${i}].ref`, message: 'Name the target' });
  });
  v.items.forEach((it, i) => {
    if (!it.address && !it.dataPoint) out.push({ path: `items[${i}]`, message: 'An item needs an address or a data point' });
    if (it.dataPoint && !ctx.points.has(it.dataPoint)) out.push({ path: `items[${i}].dataPoint`, message: `The asset has no data point "${it.dataPoint}"` });
  });
  return out;
}

/** Whether the collector may change something on the machine. */
export const writes = (v: Pick<PlantCollectionValues, 'access'>) => v.access.write.length + v.access.create.length + v.access.delete.length > 0;

// ---------- writing (callers check rights and rules) ----------

interface Meta {
  importId?: string | null;
  at: string;
  by: string;
}

export function upsertCollection(assetId: string, v: PlantCollectionValues, position: number, m: Meta): void {
  const j = (x: unknown) => JSON.stringify(x);
  db().run(
    `INSERT INTO plant_collections (asset_id, id, name, collector, data_path_id, interface_id, mode, interval_ms, debounce_ms, triggers, composition,
       destination, sinks, access, settings, items, description, notes, format, source_file, position, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT (asset_id, id) DO UPDATE SET name = excluded.name, collector = excluded.collector, data_path_id = excluded.data_path_id,
       interface_id = excluded.interface_id, mode = excluded.mode, interval_ms = excluded.interval_ms, debounce_ms = excluded.debounce_ms,
       triggers = excluded.triggers, composition = excluded.composition, destination = excluded.destination, sinks = excluded.sinks, access = excluded.access,
       settings = excluded.settings, items = excluded.items, description = excluded.description, notes = excluded.notes, format = excluded.format,
       source_file = excluded.source_file,
       import_id = COALESCE(excluded.import_id, plant_collections.import_id), updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    assetId,
    v.id,
    v.name,
    j(v.collector),
    v.dataPathId,
    v.interfaceId,
    v.mode,
    v.intervalMs,
    v.debounceMs,
    j(v.triggers),
    v.composition,
    // the first sink as the destination of 0.11, for readers of older versions (a backup restored elsewhere)
    v.sinks.length ? j(destinationOfSink(v.sinks[0])) : null,
    j(v.sinks),
    j(v.access),
    j(v.settings),
    j(v.items),
    v.description,
    v.notes,
    v.format,
    v.sourceFile,
    position,
    m.importId ?? null,
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

/** Remembers a confirmed gateway name → data point pair (asset '' : for every asset of the collector). */
export function rememberMapping(collector: string, assetId: string, gatewayName: string, dataPoint: string, m: Meta): void {
  db().run(
    `INSERT INTO plant_collection_mappings (collector_key, asset_id, gateway_name, data_point, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (collector_key, asset_id, gateway_name) DO UPDATE SET data_point = excluded.data_point, created_at = excluded.created_at, created_by = excluded.created_by`,
    collector,
    assetId,
    gatewayName,
    dataPoint,
    m.at,
    m.by,
  );
}

export const mappingsOf = (collector: string, assetId: string) =>
  db().all<MappingRow>("SELECT * FROM plant_collection_mappings WHERE collector_key = ? AND asset_id IN (?, '')", collector, assetId);

export function removeAssetCollections(assetId: string): void {
  db().run('DELETE FROM plant_collections WHERE asset_id = ?', assetId);
  db().run('DELETE FROM plant_collection_mappings WHERE asset_id = ?', assetId);
}
