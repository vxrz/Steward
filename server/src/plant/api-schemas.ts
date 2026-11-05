import { z, type ZodTypeAny } from 'zod';
import {
  ASSET_STATUSES,
  BUILDING_KINDS,
  KPI_AUDIENCES,
  KPI_COLUMN_KINDS,
  KPI_INPUT_KINDS,
  KPI_METHODOLOGIES,
  KPI_PARAM_TYPES,
  KPI_TIMINGS,
  KPI_TRENDS,
  PLANT_AUTH_KINDS,
  PLANT_CHECK_CODES,
  PLANT_DIRECTIONS,
  PLANT_LEVELS,
  PLANT_PROTOCOLS,
} from '@sm/shared';
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

// ---------- part 2 (#219): device profiles, KPI definitions, assignments ----------

const PublicationTarget = z.object({
  target: z.string().describe('The system it is published to'),
  path: z.string().describe('Where there: a path, an aspect, a topic'),
  name: z.string().describe('Its name there: a variable, a tag'),
});

const DataPoint = z.object({
  id: z.string().describe('Stable id, unique in the profile'),
  name: z.string(),
  description: z.string(),
  dataType: z.string().describe('OPC UA built-in type (IEC 62541) or IEC 61131-3 type; [] for an array; or empty'),
  unit: z.string().describe('UCUM code (kW.h, Cel, /min), or empty'),
  address: z.string().describe('OPC UA NodeId, Modbus <table>:<address>[,<count>], a topic, a file path …'),
  access: z.enum(PLANT_DIRECTIONS),
  updateRateMs: z.number().int().nullable().describe('Typical update rate in milliseconds'),
  enumValues: z.array(z.string()),
  notes: z.string(),
  publications: z.array(PublicationTarget).describe('Where it is usually published'),
});

const Interface = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(PLANT_PROTOCOLS),
  direction: z.enum(PLANT_DIRECTIONS),
  description: z.string(),
  version: z.string(),
  defaultPort: z.number().int().nullable(),
  authentication: z.enum(PLANT_AUTH_KINDS),
  client: z.string().describe('The client it needs'),
  notes: z.string(),
  groups: z.array(z.object({ name: z.string().describe('Empty: data points without a group'), description: z.string(), dataPoints: z.array(DataPoint) })),
  fileSets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      format: z.string(),
      direction: z.enum(PLANT_DIRECTIONS),
      pathPattern: z.string(),
      producedPer: z.string(),
      retention: z.string(),
      encoding: z.string(),
      notes: z.string(),
    }),
  ),
});

const AssetBrief = z.object({ id: z.string(), name: z.string(), status: z.enum(ASSET_STATUSES), siteId: z.string(), site: Place.extend({ code: z.string() }) });

export const PlantProfileEntry = z.object({
  id: z.string().describe('Stable id'),
  name: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  version: z.string().describe('Firmware or product version the profile describes'),
  category: z.string(),
  protocols: z.array(z.enum(PLANT_PROTOCOLS)),
  interfaceCount: z.number().int(),
  dataPointCount: z.number().int(),
  assetCount: z.number().int().describe('Assets with this profile in sites the token owner may see'),
  ...source,
  updatedAt: ts(),
});

export const PlantProfileDetailEntry = PlantProfileEntry.extend({
  description: z.string(),
  notes: z.string(),
  interfaces: z.array(Interface),
  assets: z.array(AssetBrief).describe('Assets with this profile (that the token owner may see)'),
  kpis: z.array(z.object({ id: z.string(), name: z.string(), names, dataPoints: z.array(z.string()) })).describe('KPI definitions that read its data points'),
  createdAt: ts(),
  createdBy: z.string(),
  updatedBy: z.string(),
});

const Check = z.object({
  code: z.enum(PLANT_CHECK_CODES),
  subject: z.object({ kind: z.enum(['asset', 'kpi']), id: z.string(), name: z.string(), siteId: z.string().optional() }),
  job: z.string().optional().describe('The KPI instance (job) the problem is on'),
  message: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});

const KpiParameter = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
  type: z.enum(KPI_PARAM_TYPES),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  required: z.boolean(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  unit: z.string(),
  description: z.string(),
});

const KpiColumn = z.object({
  name: z.string(),
  kind: z.enum(KPI_COLUMN_KINDS).describe('sum: summed over a period; ratio: numerator / denominator × scale; ignore: not combined'),
  scope: z.string(),
  unit: z.string(),
  numerator: z.string(),
  denominator: z.string(),
  scale: z.number().nullable(),
  description: z.string(),
});

export const PlantKpiEntry = z.object({
  id: z.string().describe('Stable id'),
  name: z.string(),
  names,
  category: z.string(),
  unit: z.string(),
  trend: z.enum(KPI_TRENDS).nullable(),
  profiles: z.array(z.string()).describe('The device profiles its inputs read'),
  parameterCount: z.number().int(),
  columnCount: z.number().int(),
  instanceCount: z.number().int().describe('KPI instances on assets the token owner may see'),
  problemCount: z.number().int().describe('Problems of the definition (a ratio without its denominator …)'),
  ...source,
  updatedAt: ts(),
});

export const PlantKpiDetailEntry = PlantKpiEntry.extend({
  type: z.string(),
  description: z.string(),
  formula: z.string().describe('ISO 22400-2: formula'),
  rangeMin: z.number().nullable(),
  rangeMax: z.number().nullable(),
  timing: z.enum(KPI_TIMINGS).nullable(),
  audience: z.array(z.enum(KPI_AUDIENCES)),
  methodology: z.enum(KPI_METHODOLOGIES).nullable(),
  strategy: z.string(),
  implementation: z.string(),
  dynamicColumns: z.boolean(),
  inputs: z.array(z.object({ kind: z.enum(KPI_INPUT_KINDS), profile: z.string(), dataPoints: z.array(z.string()), notes: z.string() })),
  parameters: z.array(KpiParameter),
  columns: z.array(KpiColumn),
  computation: z.object({
    summary: z.string(),
    diagram: z.string(),
    steps: z.array(z.object({ name: z.string(), does: z.string(), why: z.string() })),
    identities: z.array(z.object({ relation: z.string(), note: z.string() })),
    limits: z.array(z.string()),
  }),
  notes: z.string(),
  profileNames: z.record(z.string(), z.string().nullable()),
  checks: z.array(Check),
  instances: z.array(z.object({ asset: AssetBrief, job: z.string(), active: z.boolean(), problems: z.number().int() })),
  candidates: z.array(AssetBrief).describe('Assets that deliver every input but have no instance'),
  createdAt: ts(),
  createdBy: z.string(),
  updatedBy: z.string(),
});

export const PlantAssignmentEntry = z.object({
  asset: AssetBrief,
  assignment: z
    .object({
      profileId: z.string().nullable(),
      firmware: z.string(),
      interfaces: z.array(z.object({ interface: z.string(), active: z.boolean(), endpoint: z.string(), notes: z.string() })),
      overrides: z.array(
        z.object({
          dataPoint: z.string(),
          available: z.boolean(),
          address: z.string().nullable(),
          unit: z.string().nullable(),
          dataType: z.string().nullable(),
          updateRateMs: z.number().int().nullable(),
          notes: z.string(),
        }),
      ),
      publications: z.array(PublicationTarget.extend({ dataPoint: z.string(), publishedBy: z.string(), notes: z.string() })),
      kpis: z.array(z.unknown()).describe('See kpis on the top level'),
      notes: z.string(),
    })
    .nullable()
    .describe('Null: the asset has no assignment'),
  profile: z
    .object({
      id: z.string(),
      name: z.string(),
      manufacturer: z.string(),
      model: z.string(),
      version: z.string(),
      category: z.string(),
      interfaces: z.array(Interface),
    })
    .nullable(),
  kpis: z.array(
    z.object({
      kpi: z.string(),
      job: z.string(),
      active: z.boolean(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      dashboard: z.string().nullable(),
      dataset: z.string().nullable(),
      notes: z.string(),
      definition: z.object({ id: z.string(), name: z.string(), names, category: z.string() }).nullable(),
    }),
  ),
  checks: z.array(Check),
  possibleKpis: z.array(z.object({ id: z.string(), name: z.string(), names, category: z.string(), instantiated: z.boolean() })),
  ...source,
  updatedAt: ts().nullable(),
  updatedBy: z.string().nullable(),
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
  profile: z.string().max(100).optional().describe('Only assets with this device profile (id)'),
  dataPoint: z.string().max(120).optional().describe('With profile: only assets that deliver this data point of it'),
});

export const PlantCatalogueListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
});

export const PlantCheckEntry = z.object({
  kind: z.enum(PLANT_CHECK_CODES).describe('What is wrong (the check’s code, e.g. kpi_interface_inactive)'),
  message: z.string().describe('Plain English text'),
  on: z.enum(['asset', 'kpi']).describe('The record the problem is on: an asset (its assignment or a KPI instance) or a KPI definition'),
  asset: z.object({ id: z.string(), name: z.string() }).nullable().describe('The asset (null: a problem of a KPI definition)'),
  siteId: z.string().nullable().describe('The asset’s site'),
  kpiId: z.string().nullable().describe('The KPI definition: the one with the problem, or the definition of the KPI instance'),
  job: z.string().nullable().describe('The KPI instance (job) the problem is on'),
  details: z.record(z.string(), z.union([z.string(), z.number()])).describe('The values the message names (data point, parameter, profile …)'),
});

export const PlantCheckListQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
  site: z.string().max(100).optional().describe('Only problems of assets of this site (id)'),
  asset: z.string().max(100).optional().describe('Only problems of this asset (id)'),
  kpi: z.string().max(100).optional().describe('Only problems of this KPI definition and of its KPI instances (id)'),
  kind: z.enum(PLANT_CHECK_CODES).optional().describe('Only problems of this kind'),
});

export const PlantExportQuery = z.object({
  site: z.string().max(100).optional().describe('One site (`site:`) with the assignments of its assets'),
  part: z.enum(['all', 'catalogue']).optional().describe('`catalogue`: the device profiles and KPI definitions only'),
  profile: z.string().max(100).optional().describe('One device profile (`device_profile:`)'),
  kpi: z.string().max(100).optional().describe('One KPI definition (`kpi_definition:`)'),
  format: z.enum(['yaml', 'json']).default('yaml').describe('yaml (default) or json: the same document'),
});

export const PLANT_COMPONENTS: Record<string, ZodTypeAny> = {
  PlantCheckEntry,
  PlantSiteEntry,
  PlantSiteDetailEntry,
  PlantNodeEntry,
  PlantBuildingEntry,
  PlantAssetEntry,
  PlantAssetDetailEntry,
  PlantProfileEntry,
  PlantProfileDetailEntry,
  PlantKpiEntry,
  PlantKpiDetailEntry,
  PlantAssignmentEntry,
};
