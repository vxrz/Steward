import { z, type ZodTypeAny } from 'zod';
import { ASSET_STATUSES, BUILDING_KINDS, PLANT_LEVELS } from '@sm/shared';
import { RecordLink } from '../records/api-schemas.js';

/** Response and query schemas of the plant registry in the public API (/api/v1/plant…, #218). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const names = z.record(z.string(), z.string()).describe('Translations of the name, keyed by language code');
const fields = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).describe('Own fields (Settings → Modules → Plant registry)');
const source = {
  importId: z.string().nullable().describe('The last import that wrote the record (null: entered in Steward)'),
  notInSource: z.boolean().describe('Kept although the import that replaced its earlier one no longer contained it'),
};
const ExternalRef = z.object({
  system: z.string().describe('The other tool (erp, cmms, inventory, …)'),
  id: z.string().describe('The record’s id there'),
  url: z.string().describe('Its page there, or empty'),
  label: z.string(),
});
const Place = z.object({ id: z.string(), name: z.string(), names });

const NodeBase = z.object({
  id: z.string(),
  level: z.enum(PLANT_LEVELS).describe('ISA-95 level: area, work_center or work_unit'),
  parentId: z.string().nullable(),
  name: z.string(),
  names,
  type: z.string().describe('ISA-95 kind of a work center or work unit, or empty'),
  domain: z.string(),
  buildingId: z.string().nullable().describe('The building the node names'),
  effectiveBuildingId: z.string().nullable().describe('The building that applies: the innermost one of the node and its parents'),
  description: z.string(),
  fields,
  assetCount: z.number().int().describe('Assets placed exactly here'),
  ...source,
});
const WorkUnit = NodeBase.extend({ children: z.array(z.never()).describe('Always empty') });
const WorkCenter = NodeBase.extend({ children: z.array(WorkUnit).describe('Its work units') });
export const PlantNodeEntry = NodeBase.extend({ children: z.array(WorkCenter).describe('Its work centers with their work units') });

export const PlantBuildingEntry = z.object({
  id: z.string(),
  name: z.string(),
  names,
  kind: z.enum(BUILDING_KINDS),
  parentId: z.string().nullable().describe('A building part names the building it is in'),
  description: z.string(),
  fields,
  nodeCount: z.number().int(),
  assetCount: z.number().int().describe('Assets whose building this is'),
  ...source,
});

const statusCounts = z.object(Object.fromEntries(ASSET_STATUSES.map((s) => [s, z.number().int().optional()]))).describe('Assets by status');

export const PlantSiteEntry = z.object({
  id: z.string().describe('Stable id'),
  code: z.string(),
  name: z.string(),
  names,
  description: z.string(),
  geo: z.object({ lat: z.number(), lon: z.number(), zoom: z.number().int().nullable() }).nullable(),
  areaCount: z.number().int(),
  buildingCount: z.number().int(),
  assetCount: z.number().int(),
  statusCounts,
  ...source,
  updatedAt: ts(),
});

export const PlantSiteDetailEntry = PlantSiteEntry.extend({
  contacts: z.array(z.object({ name: z.string(), role: z.string(), email: z.string(), phone: z.string(), url: z.string() })),
  externalRefs: z.array(ExternalRef),
  fields,
  areas: z.array(PlantNodeEntry).describe('The ISA-95 hierarchy: areas with their work centers and work units'),
  buildings: z.array(PlantBuildingEntry).describe('The spatial axis: buildings, halls, floors, rooms, outdoor places'),
  links: z.array(RecordLink),
  createdAt: ts(),
  createdBy: z.string(),
  updatedBy: z.string(),
});

const Location = z.object({
  site: Place.extend({ code: z.string() }),
  area: Place.nullable(),
  workCenter: Place.nullable(),
  workUnit: Place.nullable(),
  buildingId: z.string().nullable().describe('The asset’s own building (override)'),
  building: Place.extend({ kind: z.enum(BUILDING_KINDS) })
    .nullable()
    .describe('The building that applies'),
  buildingFrom: z.enum(['asset', 'work_unit', 'work_center', 'area']).nullable().describe('Where the building comes from'),
});

export const PlantAssetEntry = z.object({
  id: z.string().describe('Stable id'),
  name: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  status: z.enum(ASSET_STATUSES),
  siteId: z.string(),
  location: Location,
  domain: z.string(),
  processArea: z.string(),
  role: z.string(),
  tags: z.array(z.string()),
  parentId: z.string().nullable().describe('The asset this one is part of (equipment hierarchy)'),
  childCount: z.number().int(),
  externalRefs: z.array(ExternalRef),
  ...source,
  updatedAt: ts(),
});

const AssetRef = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(ASSET_STATUSES),
  visible: z.boolean().describe('False: in a site the token owner may not see'),
});

export const PlantAssetDetailEntry = PlantAssetEntry.extend({
  description: z.string(),
  capabilities: z.array(z.string()),
  commissioned: z.string().nullable().describe('Date (YYYY-MM-DD)'),
  endOfSupport: z.string().nullable().describe('Date (YYYY-MM-DD)'),
  imageName: z.string(),
  hasImage: z.boolean(),
  fields,
  parent: AssetRef.nullable(),
  children: z.array(AssetRef),
  links: z.array(RecordLink),
  createdAt: ts(),
  createdBy: z.string(),
  updatedBy: z.string(),
});

export const PlantSiteListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
});

export const PlantAssetListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  site: z.string().max(100).optional().describe('Only assets of this site (id)'),
  node: z.string().max(100).optional().describe('Only assets in this area, work center or work unit (id)'),
  domain: z.string().max(100).optional().describe('Only assets of this domain (their own, or their area’s)'),
  status: z.enum(ASSET_STATUSES).optional(),
  tag: z.string().max(100).optional(),
  ref: z.string().max(300).optional().describe('An external reference: system:id, or only the id'),
});

export const PLANT_COMPONENTS: Record<string, ZodTypeAny> = {
  PlantSiteEntry,
  PlantSiteDetailEntry,
  PlantNodeEntry,
  PlantBuildingEntry,
  PlantAssetEntry,
  PlantAssetDetailEntry,
};
