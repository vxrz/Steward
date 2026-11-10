import { z } from 'zod';
import {
  ASSET_STATUSES,
  BUILDING_KINDS,
  boundedRecord,
  PLANT_ID_RE,
  PLANT_LANG_RE,
  PLANT_LIMITS,
  PLANT_LEVELS,
  WORK_CENTER_TYPES,
  WORK_UNIT_TYPES,
  type AssetLocation,
  type AssetStatus,
  type BuildingKind,
  type ExternalRef,
  type FieldValues,
  type GeoPosition,
  type PlantBuilding,
  type PlantLevel,
  type PlantNode,
  type SiteContact,
  type Translations,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, parseJson } from '../util.js';
import { fieldValuesInput, isDate, isHttpUrl } from './settings.js';

/**
 * The plant registry's records as stored (rows), as values (what an edit or an import says) and the rules that hold
 * for them: ids, the ISA-95 levels (an area holds work centers, a work center work units), the innermost building
 * wins, an asset's location names nodes of its own site, and the equipment hierarchy has no cycles.
 */

// ---------- rows ----------

interface Source {
  import_id: string | null;
  not_in_source: number;
  /** 0.13.0: the entry's revision (changesets/track.ts raises it) */
  revision?: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface SiteRow extends Source {
  id: string;
  code: string;
  name: string;
  names: string;
  description: string;
  lat: number | null;
  lon: number | null;
  zoom: number | null;
  contacts: string;
  fields: string;
  acl: string;
}

export interface NodeRow extends Source {
  site_id: string;
  id: string;
  level: PlantLevel;
  parent_id: string | null;
  name: string;
  names: string;
  type: string;
  domain: string;
  building_id: string | null;
  description: string;
  position: number;
  fields: string;
}

export interface BuildingRow extends Source {
  site_id: string;
  id: string;
  name: string;
  names: string;
  kind: BuildingKind;
  parent_id: string | null;
  description: string;
  position: number;
  fields: string;
}

export interface AssetRow extends Source {
  id: string;
  site_id: string;
  area_id: string | null;
  work_center_id: string | null;
  work_unit_id: string | null;
  building_id: string | null;
  name: string;
  manufacturer: string;
  model: string;
  status: AssetStatus;
  parent_id: string | null;
  domain: string;
  process_area: string;
  role: string;
  tags: string;
  commissioned: string | null;
  end_of_support: string | null;
  description: string;
  capabilities: string;
  image_name: string;
  fields: string;
}

// ---------- values (camelCase: what the API and the import give) ----------

export interface SiteValues {
  id: string;
  code: string;
  name: string;
  names: Translations;
  description: string;
  geo: GeoPosition | null;
  contacts: SiteContact[];
  refs: ExternalRef[];
  fields: FieldValues;
}

export interface NodeValues {
  id: string;
  level: PlantLevel;
  parentId: string | null;
  name: string;
  names: Translations;
  type: string;
  domain: string;
  buildingId: string | null;
  description: string;
  fields: FieldValues;
}

export interface BuildingValues {
  id: string;
  name: string;
  names: Translations;
  kind: BuildingKind;
  parentId: string | null;
  description: string;
  fields: FieldValues;
}

export interface AssetValues {
  id: string;
  siteId: string;
  areaId: string | null;
  workCenterId: string | null;
  workUnitId: string | null;
  buildingId: string | null;
  name: string;
  manufacturer: string;
  model: string;
  status: AssetStatus;
  parentId: string | null;
  domain: string;
  processArea: string;
  role: string;
  tags: string[];
  commissioned: string | null;
  endOfSupport: string | null;
  description: string;
  capabilities: string[];
  imageName: string;
  refs: ExternalRef[];
  fields: FieldValues;
}

export const siteValuesOf = (r: SiteRow, refs: ExternalRef[]): SiteValues => ({
  id: r.id,
  code: r.code,
  name: r.name,
  names: parseJson<Translations>(r.names, {}),
  description: r.description,
  geo: r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon), zoom: r.zoom === null ? null : Number(r.zoom) } : null,
  contacts: parseJson<SiteContact[]>(r.contacts, []),
  refs,
  fields: parseJson<FieldValues>(r.fields, {}),
});

export const nodeValuesOf = (r: NodeRow): NodeValues => ({
  id: r.id,
  level: r.level,
  parentId: r.parent_id,
  name: r.name,
  names: parseJson<Translations>(r.names, {}),
  type: r.type,
  domain: r.domain,
  buildingId: r.building_id,
  description: r.description,
  fields: parseJson<FieldValues>(r.fields, {}),
});

export const buildingValuesOf = (r: BuildingRow): BuildingValues => ({
  id: r.id,
  name: r.name,
  names: parseJson<Translations>(r.names, {}),
  kind: r.kind,
  parentId: r.parent_id,
  description: r.description,
  fields: parseJson<FieldValues>(r.fields, {}),
});

export const assetValuesOf = (r: AssetRow, refs: ExternalRef[]): AssetValues => ({
  id: r.id,
  siteId: r.site_id,
  areaId: r.area_id,
  workCenterId: r.work_center_id,
  workUnitId: r.work_unit_id,
  buildingId: r.building_id,
  name: r.name,
  manufacturer: r.manufacturer,
  model: r.model,
  status: r.status,
  parentId: r.parent_id,
  domain: r.domain,
  processArea: r.process_area,
  role: r.role,
  tags: parseJson<string[]>(r.tags, []),
  commissioned: r.commissioned,
  endOfSupport: r.end_of_support,
  description: r.description,
  capabilities: parseJson<string[]>(r.capabilities, []),
  imageName: r.image_name,
  refs,
  fields: parseJson<FieldValues>(r.fields, {}),
});

/** The keys whose values differ (for the audit entry and the import preview). */
export function changedKeys<T extends object>(before: T, after: T, skip: (keyof T)[] = []): string[] {
  return (Object.keys(after) as (keyof T)[]).filter((k) => !skip.includes(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(String);
}

// ---------- input schemas (API) ----------

export const ID_HINT = 'Use lower-case letters, digits, ".", "_" and "-", starting with a letter or digit (at most 80)';
export const plantId = z.string().trim().regex(PLANT_ID_RE, ID_HINT);
const text = (max: number) => z.string().trim().max(max).default('');
export const translations = boundedRecord(z.string().trim().min(1).max(PLANT_LIMITS.name), PLANT_LIMITS.translations)
  .refine((o) => Object.keys(o).every((k) => PLANT_LANG_RE.test(k)), 'Translations are keyed by language codes such as de or pt-BR')
  .default({});
const url = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => !v || isHttpUrl(v), 'Use an http or https address')
  .default('');
export const refInput = z.object({ system: z.string().trim().min(1).max(60), id: z.string().trim().min(1).max(200), url, label: text(200) }).strict();
export const contactInput = z
  .object({
    name: z.string().trim().min(1).max(PLANT_LIMITS.text),
    role: text(PLANT_LIMITS.text),
    email: z
      .string()
      .trim()
      .max(320)
      .refine((v) => !v || /^[^\s@]+@[^\s@]+$/.test(v), 'Use an e-mail address')
      .default(''),
    phone: text(60),
    url,
  })
  .strict();
export const geoInput = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    zoom: z.number().int().min(0).max(19).nullable().default(null),
  })
  .strict();
const date = z
  .string()
  .trim()
  .refine((v) => isDate(v), 'Use a date (YYYY-MM-DD)')
  .nullable()
  .default(null);
const stringList = (n: number, max: number) => z.array(z.string().trim().min(1).max(max)).max(n).default([]);

export const siteInput = z
  .object({
    id: plantId,
    code: text(PLANT_LIMITS.code),
    name: z.string().trim().min(1).max(PLANT_LIMITS.name),
    names: translations,
    description: text(PLANT_LIMITS.description),
    geo: geoInput.nullable().default(null),
    contacts: z.array(contactInput).max(PLANT_LIMITS.contacts).default([]),
    refs: z.array(refInput).max(PLANT_LIMITS.refs).default([]),
    fields: fieldValuesInput.default({}),
  })
  .strict();
export const siteUpdate = siteInput.omit({ id: true });

export const nodeInput = z
  .object({
    id: plantId,
    level: z.enum(PLANT_LEVELS),
    parentId: plantId.nullable().default(null),
    name: z.string().trim().min(1).max(PLANT_LIMITS.name),
    names: translations,
    type: text(40),
    domain: text(60),
    buildingId: plantId.nullable().default(null),
    description: text(PLANT_LIMITS.description),
    fields: fieldValuesInput.default({}),
  })
  .strict();
export const nodeUpdate = nodeInput.omit({ id: true, level: true });

export const buildingInput = z
  .object({
    id: plantId,
    name: z.string().trim().min(1).max(PLANT_LIMITS.name),
    names: translations,
    kind: z.enum(BUILDING_KINDS).default('building'),
    parentId: plantId.nullable().default(null),
    description: text(PLANT_LIMITS.description),
    fields: fieldValuesInput.default({}),
  })
  .strict();
export const buildingUpdate = buildingInput.omit({ id: true });

export const assetInput = z
  .object({
    id: plantId,
    siteId: plantId,
    areaId: plantId.nullable().default(null),
    workCenterId: plantId.nullable().default(null),
    workUnitId: plantId.nullable().default(null),
    buildingId: plantId.nullable().default(null),
    name: z.string().trim().min(1).max(PLANT_LIMITS.name),
    manufacturer: text(PLANT_LIMITS.text),
    model: text(PLANT_LIMITS.text),
    status: z.enum(ASSET_STATUSES).default('operational'),
    parentId: plantId.nullable().default(null),
    domain: text(60),
    processArea: text(60),
    role: text(60),
    tags: stringList(PLANT_LIMITS.tags, PLANT_LIMITS.tag),
    commissioned: date,
    endOfSupport: date,
    description: text(PLANT_LIMITS.description),
    capabilities: stringList(PLANT_LIMITS.capabilities, PLANT_LIMITS.capability),
    imageName: text(200),
    refs: z.array(refInput).max(PLANT_LIMITS.refs).default([]),
    fields: fieldValuesInput.default({}),
  })
  .strict();
export const assetUpdate = assetInput.omit({ id: true });

/** Tags once each (case does not matter), in the order given. */
export function cleanTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

// ---------- a site's hierarchy and buildings ----------

/** A site's nodes and buildings, read once (location checks, trees, the building that applies). */
export interface SiteIndex {
  siteId: string;
  nodes: Map<string, NodeRow>;
  buildings: Map<string, BuildingRow>;
}

export function loadIndex(siteId: string): SiteIndex {
  return {
    siteId,
    nodes: new Map(
      db()
        .all<NodeRow>('SELECT * FROM plant_nodes WHERE site_id = ? ORDER BY position, name', siteId)
        .map((n) => [n.id, n]),
    ),
    buildings: new Map(
      db()
        .all<BuildingRow>('SELECT * FROM plant_buildings WHERE site_id = ? ORDER BY position, name', siteId)
        .map((b) => [b.id, b]),
    ),
  };
}

/** Indexes of every site (lists over all sites). */
export function loadAllIndexes(): Map<string, SiteIndex> {
  const out = new Map<string, SiteIndex>();
  const get = (siteId: string) => {
    let x = out.get(siteId);
    if (!x) out.set(siteId, (x = { siteId, nodes: new Map(), buildings: new Map() }));
    return x;
  };
  for (const n of db().all<NodeRow>('SELECT * FROM plant_nodes ORDER BY position, name')) get(n.site_id).nodes.set(n.id, n);
  for (const b of db().all<BuildingRow>('SELECT * FROM plant_buildings ORDER BY position, name')) get(b.site_id).buildings.set(b.id, b);
  return out;
}

const PARENT_LEVEL: Record<PlantLevel, PlantLevel | null> = { area: null, work_center: 'area', work_unit: 'work_center' };

/** The building that applies to a node: its own, else its parents' (the innermost one wins, IEC 81346). */
export function nodeBuilding(index: Pick<SiteIndex, 'nodes'>, nodeId: string | null): { id: string; from: PlantLevel } | null {
  let cur = nodeId ? index.nodes.get(nodeId) : undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.building_id) return { id: cur.building_id, from: cur.level };
    cur = cur.parent_id ? index.nodes.get(cur.parent_id) : undefined;
  }
  return null;
}

/** The building that applies to an asset: its own override, else the innermost building of its location. */
export function assetBuilding(
  index: Pick<SiteIndex, 'nodes'>,
  a: { buildingId: string | null; areaId: string | null; workCenterId: string | null; workUnitId: string | null },
): { id: string; from: AssetLocation['buildingFrom'] } | null {
  if (a.buildingId) return { id: a.buildingId, from: 'asset' };
  return nodeBuilding(index, a.workUnitId ?? a.workCenterId ?? a.areaId);
}

/**
 * A location as stored: the innermost node given decides, the levels above are filled in from it; a level given that
 * does not contain it is refused. Returns the problem as text (null: fine).
 */
export function resolveLocation(
  index: Pick<SiteIndex, 'nodes' | 'buildings'>,
  loc: { areaId: string | null; workCenterId: string | null; workUnitId: string | null; buildingId: string | null },
):
  | { value: { areaId: string | null; workCenterId: string | null; workUnitId: string | null; buildingId: string | null } }
  | { problem: string; code: string; params: Record<string, string> } {
  type Found = { row: NodeRow | null } | { problem: string; code: string; params: Record<string, string> };
  const at = (id: string | null, level: PlantLevel): Found => {
    if (!id) return { row: null };
    const n = index.nodes.get(id);
    if (!n) return { problem: `There is no ${level.replace('_', ' ')} "${id}" in this site`, code: 'PLANT_LOCATION_UNKNOWN', params: { id, level } };
    if (n.level !== level)
      return { problem: `"${id}" is a ${n.level.replace('_', ' ')}, not a ${level.replace('_', ' ')}`, code: 'PLANT_LOCATION_LEVEL', params: { id, level } };
    return { row: n };
  };
  const wu = at(loc.workUnitId, 'work_unit');
  if ('problem' in wu) return wu;
  const wc = at(loc.workCenterId, 'work_center');
  if ('problem' in wc) return wc;
  const ar = at(loc.areaId, 'area');
  if ('problem' in ar) return ar;
  let workCenterId = loc.workCenterId;
  let areaId = loc.areaId;
  if (wu.row) {
    if (workCenterId && workCenterId !== wu.row.parent_id)
      return {
        problem: `Work unit "${wu.row.id}" is not in work center "${workCenterId}"`,
        code: 'PLANT_LOCATION_MISMATCH',
        params: { id: wu.row.id, parent: workCenterId },
      };
    workCenterId = wu.row.parent_id;
  }
  const wcRow = workCenterId ? index.nodes.get(workCenterId) : undefined;
  if (wcRow) {
    if (areaId && areaId !== wcRow.parent_id)
      return { problem: `Work center "${wcRow.id}" is not in area "${areaId}"`, code: 'PLANT_LOCATION_MISMATCH', params: { id: wcRow.id, parent: areaId } };
    areaId = wcRow.parent_id;
  }
  if (loc.buildingId && !index.buildings.has(loc.buildingId))
    return { problem: `There is no building "${loc.buildingId}" in this site`, code: 'PLANT_BUILDING_UNKNOWN', params: { id: loc.buildingId } };
  return { value: { areaId, workCenterId, workUnitId: loc.workUnitId, buildingId: loc.buildingId } };
}

/** What is wrong with a node's place in the hierarchy (null: fine). */
export function nodeProblem(
  index: Pick<SiteIndex, 'nodes' | 'buildings'>,
  n: { id: string; level: PlantLevel; parentId: string | null; buildingId: string | null; type: string },
): { problem: string; code: string; params: Record<string, string> } | null {
  const want = PARENT_LEVEL[n.level];
  if (!want && n.parentId) return { problem: 'An area is directly below its site (it has no parent)', code: 'PLANT_NODE_PARENT', params: { id: n.id } };
  if (want) {
    if (!n.parentId) return { problem: `A ${n.level.replace('_', ' ')} needs its ${want.replace('_', ' ')}`, code: 'PLANT_NODE_PARENT', params: { id: n.id } };
    const p = index.nodes.get(n.parentId);
    if (!p || p.level !== want)
      return { problem: `"${n.parentId}" is not a ${want.replace('_', ' ')} of this site`, code: 'PLANT_NODE_PARENT', params: { id: n.parentId } };
  }
  if (n.buildingId && !index.buildings.has(n.buildingId))
    return { problem: `There is no building "${n.buildingId}" in this site`, code: 'PLANT_BUILDING_UNKNOWN', params: { id: n.buildingId } };
  const types: readonly string[] = n.level === 'work_center' ? WORK_CENTER_TYPES : n.level === 'work_unit' ? WORK_UNIT_TYPES : [];
  if (n.type && !types.includes(n.type))
    return {
      problem: n.level === 'area' ? 'An area has no ISA-95 type' : `Use one of ${types.join(', ')} as the type`,
      code: 'PLANT_NODE_TYPE',
      params: { type: n.type },
    };
  return null;
}

/** A building part's parent: in the same site, and no cycle (a building inside itself). */
export function buildingProblem(
  index: Pick<SiteIndex, 'buildings'>,
  b: { id: string; parentId: string | null },
): { problem: string; code: string; params: Record<string, string> } | null {
  if (!b.parentId) return null;
  if (b.parentId === b.id) return { problem: 'A building cannot be inside itself', code: 'PLANT_BUILDING_CYCLE', params: { id: b.id } };
  let cur = index.buildings.get(b.parentId);
  if (!cur) return { problem: `There is no building "${b.parentId}" in this site`, code: 'PLANT_BUILDING_UNKNOWN', params: { id: b.parentId } };
  for (let i = 0; cur && i < 100; i++) {
    if (cur.parent_id === b.id) return { problem: `"${b.parentId}" is inside "${b.id}" already`, code: 'PLANT_BUILDING_CYCLE', params: { id: b.id } };
    cur = cur.parent_id ? index.buildings.get(cur.parent_id) : undefined;
  }
  return null;
}

/**
 * Whether making `parentId` the parent of `assetId` closes a cycle in the equipment hierarchy. `parentOf` gives the
 * parent of an asset as it will be (the stored one, or the import's).
 */
export function equipmentCycle(assetId: string, parentId: string | null, parentOf: (id: string) => string | null | undefined): string[] | null {
  if (!parentId) return null;
  const path = [assetId, parentId];
  let cur: string | null | undefined = parentId;
  for (let i = 0; cur && i < 10_000; i++) {
    if (cur === assetId) return path;
    cur = parentOf(cur);
    if (cur) path.push(cur);
  }
  return null;
}

// ---------- reading for the pages ----------

export function nodeTree(index: SiteIndex, assetCounts: Map<string, number>): PlantNode[] {
  const byParent = new Map<string | null, NodeRow[]>();
  for (const n of index.nodes.values()) byParent.set(n.parent_id, [...(byParent.get(n.parent_id) ?? []), n]);
  const build = (n: NodeRow, depth: number): PlantNode => ({
    id: n.id,
    level: n.level,
    parentId: n.parent_id,
    name: n.name,
    names: parseJson<Translations>(n.names, {}),
    type: n.type,
    domain: n.domain,
    buildingId: n.building_id,
    effectiveBuildingId: nodeBuilding(index, n.id)?.id ?? null,
    description: n.description,
    fields: parseJson<FieldValues>(n.fields, {}),
    assetCount: assetCounts.get(n.id) ?? 0,
    importId: n.import_id,
    notInSource: !!n.not_in_source,
    revision: Number(n.revision ?? 1),
    children: depth < 2 ? (byParent.get(n.id) ?? []).filter((c) => c.level !== 'area').map((c) => build(c, depth + 1)) : [],
  });
  return (byParent.get(null) ?? []).filter((n) => n.level === 'area').map((n) => build(n, 0));
}

export function buildingList(index: SiteIndex, assets: AssetRow[]): PlantBuilding[] {
  const nodeCount = new Map<string, number>();
  for (const n of index.nodes.values()) if (n.building_id) nodeCount.set(n.building_id, (nodeCount.get(n.building_id) ?? 0) + 1);
  const assetCount = new Map<string, number>();
  for (const a of assets) {
    const b = assetBuilding(index, { buildingId: a.building_id, areaId: a.area_id, workCenterId: a.work_center_id, workUnitId: a.work_unit_id });
    if (b) assetCount.set(b.id, (assetCount.get(b.id) ?? 0) + 1);
  }
  return [...index.buildings.values()].map((b) => ({
    id: b.id,
    name: b.name,
    names: parseJson<Translations>(b.names, {}),
    kind: b.kind,
    parentId: b.parent_id,
    description: b.description,
    fields: parseJson<FieldValues>(b.fields, {}),
    nodeCount: nodeCount.get(b.id) ?? 0,
    assetCount: assetCount.get(b.id) ?? 0,
    importId: b.import_id,
    notInSource: !!b.not_in_source,
    revision: Number(b.revision ?? 1),
  }));
}

const place = (r: { id: string; name: string; names: string } | undefined | null) =>
  r ? { id: r.id, name: r.name, names: parseJson<Translations>(r.names, {}) } : null;

export function locationOf(site: Pick<SiteRow, 'id' | 'name' | 'names' | 'code'>, index: SiteIndex, a: AssetRow): AssetLocation {
  const b = assetBuilding(index, { buildingId: a.building_id, areaId: a.area_id, workCenterId: a.work_center_id, workUnitId: a.work_unit_id });
  const building = b ? index.buildings.get(b.id) : undefined;
  return {
    site: { ...place(site)!, code: site.code },
    area: place(a.area_id ? index.nodes.get(a.area_id) : null),
    workCenter: place(a.work_center_id ? index.nodes.get(a.work_center_id) : null),
    workUnit: place(a.work_unit_id ? index.nodes.get(a.work_unit_id) : null),
    buildingId: a.building_id,
    building: building ? { ...place(building)!, kind: building.kind } : null,
    buildingFrom: building ? (b!.from ?? null) : null,
  };
}

// ---------- external references ----------

export type RefKind = 'site' | 'asset';

export function refsOf(kind: RefKind, ids: string[]): Map<string, ExternalRef[]> {
  const out = new Map<string, ExternalRef[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    if (!chunk.length) continue;
    for (const r of db().all<{ item_id: string; system: string; ref_id: string; url: string; label: string }>(
      `SELECT item_id, system, ref_id, url, label FROM plant_refs WHERE kind = ? AND item_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY item_id, position`,
      kind,
      ...chunk,
    ))
      out.set(r.item_id, [...(out.get(r.item_id) ?? []), { system: r.system, id: r.ref_id, url: r.url, label: r.label }]);
  }
  return out;
}

export const refsOfOne = (kind: RefKind, id: string): ExternalRef[] => refsOf(kind, [id]).get(id) ?? [];

export function writeRefs(kind: RefKind, id: string, refs: ExternalRef[]): void {
  db().run('DELETE FROM plant_refs WHERE kind = ? AND item_id = ?', kind, id);
  refs.forEach((r, i) =>
    db().run(
      'INSERT INTO plant_refs (kind, item_id, position, system, ref_id, url, label) VALUES (?, ?, ?, ?, ?, ?, ?)',
      kind,
      id,
      i,
      r.system,
      r.id,
      r.url,
      r.label,
    ),
  );
}

/** References once each (system and id). */
export function cleanRefs(refs: ExternalRef[]): ExternalRef[] {
  const out: ExternalRef[] = [];
  for (const r of refs) if (!out.some((x) => x.system.toLowerCase() === r.system.toLowerCase() && x.id === r.id)) out.push(r);
  return out;
}

// ---------- writing rows (callers check rights and rules) ----------

interface Meta {
  importId?: string | null;
  notInSource?: boolean;
  at: string;
  by: string;
}

const src = (m: Meta) => [m.importId ?? null, m.notInSource ? 1 : 0] as const;

export function upsertSite(v: SiteValues, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_sites (id, code, name, names, description, lat, lon, zoom, contacts, fields, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET code = excluded.code, name = excluded.name, names = excluded.names, description = excluded.description,
       lat = excluded.lat, lon = excluded.lon, zoom = excluded.zoom, contacts = excluded.contacts, fields = excluded.fields,
       ${opts.keepSource ? '' : 'import_id = excluded.import_id, not_in_source = excluded.not_in_source,'} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    v.id,
    v.code,
    v.name,
    JSON.stringify(v.names),
    v.description,
    v.geo?.lat ?? null,
    v.geo?.lon ?? null,
    v.geo?.zoom ?? null,
    JSON.stringify(v.contacts),
    JSON.stringify(v.fields),
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
  writeRefs('site', v.id, v.refs);
}

export function upsertNode(siteId: string, v: NodeValues, position: number, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_nodes (site_id, id, level, parent_id, name, names, type, domain, building_id, description, position, fields, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, id) DO UPDATE SET level = excluded.level, parent_id = excluded.parent_id, name = excluded.name, names = excluded.names,
       type = excluded.type, domain = excluded.domain, building_id = excluded.building_id, description = excluded.description, position = excluded.position,
       fields = excluded.fields, ${opts.keepSource ? '' : 'import_id = excluded.import_id, not_in_source = excluded.not_in_source,'} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    siteId,
    v.id,
    v.level,
    v.parentId,
    v.name,
    JSON.stringify(v.names),
    v.type,
    v.domain,
    v.buildingId,
    v.description,
    position,
    JSON.stringify(v.fields),
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export function upsertBuilding(siteId: string, v: BuildingValues, position: number, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_buildings (site_id, id, name, names, kind, parent_id, description, position, fields, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, id) DO UPDATE SET name = excluded.name, names = excluded.names, kind = excluded.kind, parent_id = excluded.parent_id,
       description = excluded.description, position = excluded.position, fields = excluded.fields,
       ${opts.keepSource ? '' : 'import_id = excluded.import_id, not_in_source = excluded.not_in_source,'} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    siteId,
    v.id,
    v.name,
    JSON.stringify(v.names),
    v.kind,
    v.parentId,
    v.description,
    position,
    JSON.stringify(v.fields),
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
}

export function upsertAsset(v: AssetValues, m: Meta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_assets (id, site_id, area_id, work_center_id, work_unit_id, building_id, name, manufacturer, model, status, parent_id, domain, process_area, role,
       tags, commissioned, end_of_support, description, capabilities, image_name, fields, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET site_id = excluded.site_id, area_id = excluded.area_id, work_center_id = excluded.work_center_id,
       work_unit_id = excluded.work_unit_id, building_id = excluded.building_id, name = excluded.name, manufacturer = excluded.manufacturer,
       model = excluded.model, status = excluded.status, parent_id = excluded.parent_id, domain = excluded.domain, process_area = excluded.process_area,
       role = excluded.role, tags = excluded.tags, commissioned = excluded.commissioned, end_of_support = excluded.end_of_support,
       description = excluded.description, capabilities = excluded.capabilities, image_name = excluded.image_name, fields = excluded.fields,
       ${opts.keepSource ? '' : 'import_id = excluded.import_id, not_in_source = excluded.not_in_source,'} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    v.id,
    v.siteId,
    v.areaId,
    v.workCenterId,
    v.workUnitId,
    v.buildingId,
    v.name,
    v.manufacturer,
    v.model,
    v.status,
    v.parentId,
    v.domain,
    v.processArea,
    v.role,
    JSON.stringify(v.tags),
    v.commissioned,
    v.endOfSupport,
    v.description,
    JSON.stringify(v.capabilities),
    v.imageName,
    JSON.stringify(v.fields),
    ...src(m),
    m.at,
    m.by,
    m.at,
    m.by,
  );
  writeRefs('asset', v.id, v.refs);
}

/** Removes an asset row and what belongs to it alone (image, references, assignment, its own links); its children lose their parent. */
export function removeAssetRow(id: string): void {
  db().run('UPDATE plant_assets SET parent_id = NULL WHERE parent_id = ?', id);
  db().run('DELETE FROM plant_asset_images WHERE asset_id = ?', id);
  // its profile assignment and KPI instances (#219)
  db().run('DELETE FROM plant_assignments WHERE asset_id = ?', id);
  // its devices, data paths and linked checks (#220)
  for (const t of ['plant_devices', 'plant_data_paths', 'plant_asset_checks']) db().run(`DELETE FROM ${t} WHERE asset_id = ?`, id);
  // its data collections and the mappings remembered for it (0.11.0)
  // 0.14: the Insights Hub checks of their sinks and the links of their items to monitor checks
  for (const t of ['plant_collections', 'plant_collection_mappings', 'plant_ih_checks', 'plant_ih_monitor_links'])
    db().run(`DELETE FROM ${t} WHERE asset_id = ?`, id);
  // 0.12: the kept files of its collection imports, and the links of records to its collections and their sinks
  db().run('DELETE FROM plant_collection_sources WHERE asset_id = ?', id);
  removeCollectionLinks(id);
  db().run("DELETE FROM plant_refs WHERE kind = 'asset' AND item_id = ?", id);
  db().run("DELETE FROM item_links WHERE from_kind = 'asset' AND from_id = ?", id);
  db().run("DELETE FROM copied_from WHERE kind = 'asset' AND id = ?", id);
  // 0.14: the last "still current" of its documentation as a whole
  db().run("DELETE FROM plant_doc_confirmations WHERE kind = 'asset' AND target_id = ?", id);
  db().run('DELETE FROM plant_assets WHERE id = ?', id);
}

/**
 * Removes the links of records to an asset's data collections and sinks (0.12; linked as `<asset>/<collection>` and
 * `<asset>/<collection>/<sink>`), or to one collection and its sinks. An exact prefix, no pattern (ids may hold "_").
 */
export function removeCollectionLinks(assetId: string, collectionId?: string): number {
  return collectionLinks(assetId, collectionId).reduce((n, l) => n + db().run('DELETE FROM item_links WHERE id = ?', l.id).changes, 0);
}

/** The links of records to an asset's data collections and sinks (or to one collection and its sinks). */
export function collectionLinks(assetId: string, collectionId?: string): { id: string; to_kind: string; to_id: string }[] {
  const prefix = collectionId ? `${assetId}/${collectionId}` : assetId;
  return db()
    .all<{ id: string; to_kind: string; to_id: string }>(
      "SELECT id, to_kind, to_id FROM item_links WHERE to_kind IN ('data-collection', 'data-sink') AND substr(to_id, 1, ?) = ?",
      prefix.length + 1,
      `${prefix}/`,
    )
    .concat(
      collectionId
        ? db().all<{ id: string; to_kind: string; to_id: string }>(
            "SELECT id, to_kind, to_id FROM item_links WHERE to_kind = 'data-collection' AND to_id = ?",
            prefix,
          )
        : [],
    );
}

/** Removes a site with its hierarchy, buildings and OT network (its assets must be gone already). */
export function removeSiteRows(id: string): void {
  db().run('DELETE FROM plant_nodes WHERE site_id = ?', id);
  db().run('DELETE FROM plant_buildings WHERE site_id = ?', id);
  // its VLANs, zones and conduits (#220)
  for (const t of ['plant_conduits', 'plant_zones', 'plant_vlans']) db().run(`DELETE FROM ${t} WHERE site_id = ?`, id);
  db().run("DELETE FROM plant_refs WHERE kind = 'site' AND item_id = ?", id);
  db().run("DELETE FROM item_links WHERE from_kind = 'site' AND from_id = ?", id);
  db().run("DELETE FROM resource_teams WHERE kind = 'site' AND resource_id = ?", id);
  db().run('DELETE FROM plant_sites WHERE id = ?', id);
}

export const siteRowOf = (id: string): SiteRow | undefined => db().get<SiteRow>('SELECT * FROM plant_sites WHERE id = ?', id);
export const assetRowOf = (id: string): AssetRow | undefined => db().get<AssetRow>('SELECT * FROM plant_assets WHERE id = ?', id);

export function notFound(kind: 'site' | 'asset' | 'node' | 'building', id: string): HttpError {
  if (kind === 'site') return new HttpError(404, `Site ${id} not found`, 'PLANT_SITE_NOT_FOUND', { id });
  if (kind === 'asset') return new HttpError(404, `Asset ${id} not found`, 'PLANT_ASSET_NOT_FOUND', { id });
  if (kind === 'node') return new HttpError(404, `Hierarchy node ${id} not found`, 'PLANT_NODE_NOT_FOUND', { id });
  return new HttpError(404, `Building ${id} not found`, 'PLANT_BUILDING_NOT_FOUND', { id });
}

/** A broken model rule (nodeProblem, buildingProblem, resolveLocation) as the 400 answer of an edit. */
export function ruleError(p: { problem: string; code: string; params: Record<string, string> }): HttpError {
  switch (p.code) {
    case 'PLANT_NODE_PARENT':
      return new HttpError(400, p.problem, 'PLANT_NODE_PARENT', p.params);
    case 'PLANT_NODE_TYPE':
      return new HttpError(400, p.problem, 'PLANT_NODE_TYPE', p.params);
    case 'PLANT_BUILDING_UNKNOWN':
      return new HttpError(400, p.problem, 'PLANT_BUILDING_UNKNOWN', p.params);
    case 'PLANT_BUILDING_CYCLE':
      return new HttpError(400, p.problem, 'PLANT_BUILDING_CYCLE', p.params);
    case 'PLANT_LOCATION_LEVEL':
      return new HttpError(400, p.problem, 'PLANT_LOCATION_LEVEL', p.params);
    case 'PLANT_LOCATION_MISMATCH':
      return new HttpError(400, p.problem, 'PLANT_LOCATION_MISMATCH', p.params);
    default:
      return new HttpError(400, p.problem, 'PLANT_LOCATION_UNKNOWN', p.params);
  }
}
