import { z } from 'zod';
import {
  ASSET_STATUSES,
  authKindOf,
  BUILDING_KINDS,
  boundedRecord,
  dataTypeOf,
  directionOf,
  KPI_AUDIENCES,
  KPI_COLUMN_KINDS,
  KPI_METHODOLOGIES,
  KPI_PARAM_TYPES,
  KPI_TIMINGS,
  KPI_TRENDS,
  PLANT_AUTH_KINDS,
  PLANT_DATA_LIMITS as L,
  PLANT_DIRECTIONS,
  PLANT_FORMAT_VERSION,
  PLANT_ID_RE,
  PLANT_LANG_RE,
  PLANT_LIMITS,
  PLANT_PROTOCOLS,
  protocolOf,
  WORK_CENTER_TYPES,
  WORK_UNIT_TYPES,
} from '@sm/shared';
import { ID_HINT } from './model.js';
import { NAME_HINT, NAME_RE } from './data-model.js';

/**
 * The import and export format of the plant registry, version 1 (#218): YAML (or JSON) in snake_case, published as
 * a JSON Schema 2020-12 document (docs/plant/plant-registry-1.schema.json, generated from this file by
 * `npm run plant:schema`). One file holds a whole tree (`sites:`), one site (`site:`) or only assets (`assets:`,
 * each naming its site in `location.site`) – an import takes several files at once.
 *
 * Part 2 (#219) adds the optional top-level keys `device_profiles` (`device_profile`), `kpi_definitions`
 * (`kpi_definition`) and `assignments` (`assignment`) – files of part 1 stay valid. Later parts add more (OT network).
 */

export const SCHEMA_ID = 'https://github.com/vxrz/Steward/blob/main/docs/plant/plant-registry-1.schema.json';

const id = z.string().regex(PLANT_ID_RE, ID_HINT).describe('Stable id: lower-case letters, digits, ".", "_" and "-"; never changes');
const ref = id.nullable().optional();
const name = z.string().min(1).max(PLANT_LIMITS.name).describe('Name in the installation’s default language');
const names = boundedRecord(z.string().min(1).max(PLANT_LIMITS.name), PLANT_LIMITS.translations)
  .refine((o) => Object.keys(o).every((k) => PLANT_LANG_RE.test(k)), 'Translations are keyed by language codes such as de or pt-BR')
  .describe('Translations of the name, keyed by language code: { de: Halle 1 }')
  .optional();
const text = (max: number) => z.string().max(max).nullable().optional();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD)')
  .nullable()
  .optional()
  .describe('A date: YYYY-MM-DD');
const fields = boundedRecord(z.union([z.string().max(PLANT_LIMITS.fieldText), z.number(), z.boolean(), z.null()]), PLANT_LIMITS.fieldDefs)
  .describe('Own fields of the record type, as defined in Settings → Modules → Plant registry')
  .optional();
const externalRefs = z
  .array(
    z
      .object({
        system: z.string().min(1).max(60).describe('The other tool, e.g. erp, cmms, inventory'),
        id: z.union([z.string().min(1).max(200), z.number()]).describe('The record’s id in that tool'),
        url: z.string().max(2000).nullable().optional().describe('Its page there (http or https)'),
        label: text(200),
      })
      .strict(),
  )
  .max(PLANT_LIMITS.refs)
  .optional()
  .describe('External references: the ids of this record in other tools');

const contact = z
  .object({
    name: z.string().min(1).max(PLANT_LIMITS.text),
    role: text(PLANT_LIMITS.text),
    email: text(320),
    phone: text(60),
    url: text(2000),
  })
  .strict();

export const buildingSchema = z
  .object({
    id,
    name,
    names,
    kind: z.enum(BUILDING_KINDS).optional().describe('building (default), hall, floor, room, outdoor or other'),
    parent: ref.describe('A building part (floor, room) names the building it is in'),
    description: text(PLANT_LIMITS.description),
    fields,
  })
  .strict()
  .meta({ id: 'Building', description: 'A place on the spatial axis (IEC 81346 location aspect)' });

const building = ref.describe('The building this node stands in; the innermost one wins (work unit, work center, area)');

export const workUnitSchema = z
  .object({ id, name, names, type: z.enum(WORK_UNIT_TYPES).optional().describe('ISA-95 kind'), building, description: text(PLANT_LIMITS.description), fields })
  .strict()
  .meta({ id: 'WorkUnit', description: 'ISA-95 work unit' });

export const workCenterSchema = z
  .object({
    id,
    name,
    names,
    type: z.enum(WORK_CENTER_TYPES).optional().describe('ISA-95 kind'),
    building,
    description: text(PLANT_LIMITS.description),
    fields,
    work_units: z.array(workUnitSchema).max(PLANT_LIMITS.nodesPerSite).optional(),
  })
  .strict()
  .meta({ id: 'WorkCenter', description: 'ISA-95 work center: a line, unit, cell or storage zone' });

export const areaSchema = z
  .object({
    id,
    name,
    names,
    domain: text(60).describe('The manufacturing domain the area belongs to (optional)'),
    building,
    description: text(PLANT_LIMITS.description),
    fields,
    work_centers: z.array(workCenterSchema).max(PLANT_LIMITS.nodesPerSite).optional(),
  })
  .strict()
  .meta({ id: 'Area', description: 'ISA-95 area: what happens there (function), not where (put the hall in building)' });

export const assetSchema = z
  .object({
    id,
    name,
    manufacturer: text(PLANT_LIMITS.text),
    model: text(PLANT_LIMITS.text),
    status: z.enum(ASSET_STATUSES).optional().describe('operational (default), planned, commissioning, maintenance, out_of_service or decommissioned'),
    location: z
      .object({
        site: id.optional().describe('Needed when the asset is not listed below its site'),
        area: ref,
        work_center: ref,
        work_unit: ref,
        building: ref.describe('Overrides the building of the location'),
      })
      .strict()
      .optional(),
    parent: ref.describe('The asset this one is part of (equipment hierarchy; same site)'),
    children: z.array(id).max(1000).optional().describe('Accepted on import as the other way to say parent; the export writes parent only'),
    taxonomy: z
      .object({ domain: text(60), process_area: text(60), role: text(60) })
      .strict()
      .optional(),
    tags: z.array(z.string().min(1).max(PLANT_LIMITS.tag)).max(PLANT_LIMITS.tags).optional(),
    lifecycle: z.object({ commissioned: date, end_of_support: date }).strict().optional(),
    description: text(PLANT_LIMITS.description),
    capabilities: z.array(z.string().min(1).max(PLANT_LIMITS.capability)).max(PLANT_LIMITS.capabilities).optional(),
    image: text(200).describe('File name of the image in the source; the image itself is uploaded in Steward'),
    external_refs: externalRefs,
    fields,
  })
  .strict()
  .meta({ id: 'Asset', description: 'A piece of equipment' });

export const siteSchema = z
  .object({
    id,
    code: text(PLANT_LIMITS.code).describe('Short code, unique in the installation'),
    name,
    names,
    description: text(PLANT_LIMITS.description),
    geo: z
      .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), zoom: z.number().int().min(0).max(19).nullable().optional() })
      .strict()
      .nullable()
      .optional(),
    contacts: z.array(contact).max(PLANT_LIMITS.contacts).optional(),
    external_refs: externalRefs,
    fields,
    buildings: z.array(buildingSchema).max(PLANT_LIMITS.buildingsPerSite).optional(),
    areas: z.array(areaSchema).max(PLANT_LIMITS.nodesPerSite).optional(),
    assets: z.array(assetSchema).max(PLANT_LIMITS.assets).optional(),
  })
  .strict()
  .meta({ id: 'Site', description: 'A site (factory) of the enterprise' });

// ---------- part 2 (#219): device profiles, KPI definitions, assignments ----------

const pointId = z.string().regex(NAME_RE, NAME_HINT).describe('Id of a data point, interface, parameter or column: letters, digits, ".", "_" and "-"');
const long = text(L.longText);
const versionText = z
  .union([z.string().max(60), z.number()])
  .nullable()
  .optional();
/** A value written in one of its usual spellings (`OPC-UA`, `Modbus/TCP`, `username-password`), stored as the value. */
const spelled = (of: (s: string) => string | null, values: readonly string[], what: string) =>
  z
    .string()
    .max(60)
    .refine((v) => of(v) !== null, `Use one of: ${values.join(', ')}`)
    .describe(`${what}: ${values.join(', ')} (usual spellings such as OPC-UA or Modbus/TCP are accepted)`);
const direction = spelled(directionOf, PLANT_DIRECTIONS, 'Direction, seen from whoever reads the device').nullable().optional();
const unit = text(40).describe('Unit as a UCUM code (kW.h, Cel, /min, %); usual spellings such as kWh or °C are read as their code');
const rate = z
  .number()
  .int()
  .min(0)
  .max(31 * 86_400_000)
  .nullable()
  .optional()
  .describe('Typical update rate in milliseconds');

const publicationTarget = z
  .object({
    target: text(L.text).describe('The system it is published to (an IoT platform, a historian)'),
    path: text(L.address).describe('Where there: a path, an aspect, a topic'),
    name: text(L.text).describe('Its name there: a variable, a tag'),
  })
  .strict();

export const dataPointSchema = z
  .object({
    id: pointId,
    name: z.string().min(1).max(PLANT_LIMITS.name).optional().describe('Name (default: the id)'),
    description: long,
    data_type: z
      .string()
      .max(40)
      .refine(
        (v) => dataTypeOf(v) !== null,
        'Use an OPC UA data type (Boolean, Int32, Float, Double, String …), an IEC 61131-3 type (BOOL, INT, REAL …) or int, float, bool, string; [] for an array',
      )
      .nullable()
      .optional()
      .describe('OPC UA built-in type (IEC 62541), IEC 61131-3 elementary type, or int, float, bool, string; [] for an array'),
    unit,
    address: text(L.address).describe(
      'OPC UA NodeId (ns=2;s=Spindle.Speed), Modbus <table>:<address>[,<count>] (holding:100, input:7,2), a topic, a file path or column',
    ),
    node_id: text(L.address).describe('Another spelling of address (an OPC UA NodeId)'),
    modbus_address: text(L.address).describe('Another spelling of address (a Modbus address)'),
    access: direction,
    update_rate_ms: rate,
    enum_values: z
      .array(z.union([z.string().min(1).max(L.text), z.number()]))
      .max(L.enumValues)
      .optional(),
    notes: long,
    publications: z.array(publicationTarget).max(L.publicationsPerPoint).optional().describe('Where it is usually published'),
  })
  .strict()
  .meta({ id: 'DataPoint', description: 'A value an interface delivers' });

const fileSetSchema = z
  .object({
    id: pointId,
    name: text(PLANT_LIMITS.name),
    description: long,
    format: text(L.text),
    direction,
    path_pattern: text(L.address),
    produced_per: text(L.text),
    retention: text(L.text),
    encoding: text(L.text),
    notes: long,
  })
  .strict()
  .meta({ id: 'FileSet', description: 'Files a file-transfer interface exchanges' });

export const interfaceSchema = z
  .object({
    id: pointId,
    name: text(PLANT_LIMITS.name),
    protocol: spelled(protocolOf, PLANT_PROTOCOLS, 'Protocol'),
    direction,
    description: long,
    version: versionText,
    default_port: z.number().int().min(1).max(65535).nullable().optional(),
    authentication: spelled(authKindOf, PLANT_AUTH_KINDS, 'How a client signs in').nullable().optional(),
    client: text(L.text).describe('The client it needs (a gateway, a driver, manual)'),
    notes: long,
    groups: z
      .array(z.object({ name: z.string().min(1).max(L.text), description: long, data_points: z.array(dataPointSchema).max(L.dataPoints).optional() }).strict())
      .max(L.groups)
      .optional()
      .describe('Data point groups'),
    data_points: z.array(dataPointSchema).max(L.dataPoints).optional().describe('Data points without a group'),
    file_sets: z.array(fileSetSchema).max(L.fileSets).optional(),
  })
  .strict()
  .meta({ id: 'Interface', description: 'An interface of a device: OPC UA, Modbus/TCP, MQTT, file transfer, web UI …' });

export const profileSchema = z
  .object({
    id,
    name,
    manufacturer: text(PLANT_LIMITS.text),
    model: text(PLANT_LIMITS.text),
    version: versionText.describe('Firmware or product version the profile describes'),
    category: text(100),
    description: long,
    notes: long,
    interfaces: z.array(interfaceSchema).max(L.interfaces).optional(),
  })
  .strict()
  .meta({ id: 'DeviceProfile', description: 'A kind of controller or device with its interfaces and data points (a catalogue of the installation)' });

const paramValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const optionalNumber = z.number().nullable().optional();

export const kpiSchema = z
  .object({
    id,
    name,
    names,
    category: text(100).describe('Availability, performance, quality, energy …'),
    type: text(100),
    description: long,
    formula: text(2000).describe('ISO 22400-2: the formula'),
    unit,
    range: z.object({ min: optionalNumber, max: optionalNumber }).strict().optional().describe('ISO 22400-2: the range of the value'),
    trend: z.enum(KPI_TRENDS).nullable().optional().describe('ISO 22400-2: whether higher or lower is better'),
    timing: z.enum(KPI_TIMINGS).nullable().optional().describe('ISO 22400-2: real_time, periodic or on_demand'),
    audience: z.array(z.enum(KPI_AUDIENCES)).max(KPI_AUDIENCES.length).optional().describe('ISO 22400-2: who reads it'),
    methodology: z.enum(KPI_METHODOLOGIES).nullable().optional().describe('ISO 22400-2: production methodology'),
    strategy: text(L.text).describe('The computing system’s name of the method'),
    implementation: text(500).describe('Where its code lives'),
    dynamic_columns: z.boolean().nullable().optional().describe('The columns vary from run to run'),
    inputs: z
      .array(
        z
          .object({
            kind: z
              .string()
              .max(40)
              .refine((v) => ['data_point', 'datapoint', 'other'].includes(v.toLowerCase().replace(/[\s-]/g, '_')), 'Use data_point or other')
              .optional()
              .describe('data_point (default) or other'),
            profile: id.nullable().optional().describe('The device profile the data points belong to'),
            data_points: z.array(pointId).max(L.inputPoints).optional(),
            notes: long,
          })
          .strict(),
      )
      .max(L.inputs)
      .optional(),
    parameters: z
      .array(
        z
          .object({
            name: pointId,
            aliases: z.array(pointId).max(L.aliases).optional(),
            description: long,
            type: z.enum(KPI_PARAM_TYPES).optional().describe('number (default), integer, string or boolean'),
            default: paramValue.optional(),
            required: z.boolean().nullable().optional(),
            min: optionalNumber,
            max: optionalNumber,
            unit,
          })
          .strict(),
      )
      .max(L.parameters)
      .optional(),
    columns: z
      .array(
        z
          .object({
            name: pointId,
            kind: z.enum(KPI_COLUMN_KINDS).optional().describe('sum (default), ratio or ignore'),
            scope: text(60).describe('Which windows the column is written for'),
            unit,
            numerator: text(120),
            denominator: text(120),
            scale: optionalNumber,
            description: long,
          })
          .strict(),
      )
      .max(L.columns)
      .optional(),
    computation: z
      .object({
        summary: long,
        diagram: long,
        steps: z
          .array(z.object({ name: z.string().min(1).max(L.text), does: long, why: long }).strict())
          .max(L.steps)
          .optional(),
        identities: z
          .array(z.object({ relation: z.string().min(1).max(1000), note: long }).strict())
          .max(L.identities)
          .optional(),
        limits: z.array(z.string().min(1).max(L.longText)).max(L.limits).optional(),
      })
      .strict()
      .optional(),
    notes: long,
  })
  .strict()
  .meta({ id: 'KpiDefinition', description: 'A KPI: its inputs, parameters, result columns and computation (ISO 22400-2 attributes)' });

export const assignmentSchema = z
  .object({
    asset: id.describe('The asset'),
    site: id.optional().describe('The asset’s site (optional; checked when given)'),
    profile: id.nullable().optional().describe('Its device profile'),
    firmware: versionText.describe('Controller firmware'),
    interfaces: z
      .array(z.object({ interface: pointId, active: z.boolean().nullable().optional(), endpoint: text(2000), notes: long }).strict())
      .max(L.assignmentInterfaces)
      .optional()
      .describe('Per interface of the profile: set up (active) and where (endpoint)'),
    overrides: z
      .array(
        z
          .object({
            data_point: pointId,
            available: z.boolean().nullable().optional().describe('false: this asset does not deliver it'),
            address: text(L.address),
            unit,
            data_type: z
              .string()
              .max(40)
              .refine((v) => dataTypeOf(v) !== null, 'Use an OPC UA or IEC 61131-3 data type')
              .nullable()
              .optional(),
            update_rate_ms: rate,
            notes: long,
          })
          .strict(),
      )
      .max(L.overrides)
      .optional()
      .describe('Data points that differ on this asset'),
    publications: z
      .array(
        z
          .object({
            data_point: pointId,
            target: text(L.text),
            path: text(L.address),
            name: text(L.text),
            published_by: text(L.text),
            notes: long,
          })
          .strict(),
      )
      .max(L.publications)
      .optional()
      .describe('Where data points of this asset are published'),
    kpis: z
      .array(
        z
          .object({
            kpi: id.describe('The KPI definition'),
            job: z.string().min(1).max(L.text).describe('The computation job, unique per asset'),
            active: z.boolean().nullable().optional(),
            params: boundedRecord(paramValue, L.params).optional(),
            dashboard: text(100).describe('The Steward dashboard (id) that shows the result'),
            dataset: text(200).describe('The Steward dataset (key) the result is published to'),
            notes: long,
          })
          .strict(),
      )
      .max(L.kpiInstances)
      .optional()
      .describe('KPI instances'),
    notes: long,
  })
  .strict()
  .meta({ id: 'Assignment', description: 'What an asset’s interfaces deliver: its device profile, endpoints, overrides, publications and KPI instances' });

export const plantFileSchema = z
  .object({
    $schema: z.string().max(500).optional(),
    version: z.literal(PLANT_FORMAT_VERSION).describe('Version of this format'),
    enterprise: z
      .object({ name: z.string().max(PLANT_LIMITS.name) })
      .strict()
      .optional(),
    site: siteSchema.optional().describe('One site (a file per site)'),
    sites: z.array(siteSchema).max(PLANT_LIMITS.sites).optional().describe('Several sites (a whole tree)'),
    assets: z.array(assetSchema).max(PLANT_LIMITS.assets).optional().describe('Assets that name their site in location.site'),
    device_profile: profileSchema.optional().describe('One device profile (a file per profile)'),
    device_profiles: z.array(profileSchema).max(L.profiles).optional().describe('Device profiles (a catalogue of the installation)'),
    kpi_definition: kpiSchema.optional().describe('One KPI definition'),
    kpi_definitions: z.array(kpiSchema).max(L.kpis).optional().describe('KPI definitions (a catalogue of the installation)'),
    assignment: assignmentSchema.optional().describe('The assignment of one asset'),
    assignments: z.array(assignmentSchema).max(PLANT_LIMITS.assets).optional().describe('Assignments of assets'),
  })
  .strict()
  .refine((f) => !(f.site && f.sites), { message: 'Use either site (one) or sites (several), not both', path: ['site'] })
  .refine((f) => !(f.device_profile && f.device_profiles), { message: 'Use either device_profile or device_profiles, not both', path: ['device_profile'] })
  .refine((f) => !(f.kpi_definition && f.kpi_definitions), { message: 'Use either kpi_definition or kpi_definitions, not both', path: ['kpi_definition'] })
  .refine((f) => !(f.assignment && f.assignments), { message: 'Use either assignment or assignments, not both', path: ['assignment'] });

export type PlantFile = z.infer<typeof plantFileSchema>;
export type SiteFile = z.infer<typeof siteSchema>;
export type AssetFile = z.infer<typeof assetSchema>;
export type AreaFile = z.infer<typeof areaSchema>;
export type ProfileFile = z.infer<typeof profileSchema>;
export type InterfaceFile = z.infer<typeof interfaceSchema>;
export type DataPointFile = z.infer<typeof dataPointSchema>;
export type KpiFile = z.infer<typeof kpiSchema>;
export type AssignmentFile = z.infer<typeof assignmentSchema>;

/** The published JSON Schema (2020-12) of the format. */
export function plantJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(plantFileSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema, ...rest } = s;
  return {
    $schema: $schema ?? 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'Steward plant registry, format 1',
    description:
      'Sites of an enterprise with their ISA-95 (IEC 62264) hierarchy – area, work center, work unit –, the buildings (IEC 81346 location aspect) and the assets in them; device profiles with their interfaces and data points (OPC UA IEC 62541, Modbus, IEC 61131-3, UCUM), KPI definitions (ISO 22400-2) and the assignments of assets. See docs/PLANT.md.',
    ...rest,
  };
}

// ---------- messages ----------

const at = (path: PropertyKey[]): string =>
  path.reduce<string>((s, p) => (typeof p === 'number' ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), '') || '(document)';

/** Zod issues as short, helpful messages with the place in the file (sites[0].areas[1].id). */
export function issueMessages(issues: z.core.$ZodIssue[]): { path: string; message: string }[] {
  return issues.slice(0, 50).map((i) => {
    const path = at(i.path);
    const issue = i as z.core.$ZodIssue & { keys?: string[]; values?: unknown[]; input?: unknown; expected?: string };
    let message = i.message;
    if (i.code === 'unrecognized_keys')
      message = `Unknown key${issue.keys!.length > 1 ? 's' : ''} ${issue.keys!.map((k) => `"${k}"`).join(', ')} (see docs/PLANT.md)`;
    else if (i.code === 'invalid_type' && issue.input === undefined) message = 'Required';
    else if (i.code === 'invalid_type')
      message = `Expected ${issue.expected === 'array' ? 'a list' : issue.expected === 'object' ? 'a mapping (key: value)' : issue.expected}`;
    else if (i.code === 'invalid_value' && issue.values) message = `Use one of: ${issue.values.map(String).join(', ')}`;
    else if (i.code === 'invalid_union') message = 'Expected text or a number';
    return { path, message };
  });
}
