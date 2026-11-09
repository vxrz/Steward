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
  ADDRESS_TYPES,
  COLLECTOR_KINDS,
  CONDUIT_DIRECTIONS,
  DESTINATION_KINDS,
  DEVICE_CONFIDENCE,
  DEVICE_STATES,
  PEER_KINDS,
  PLANT_NETWORK_LIMITS as NL,
  TRANSFER_MODES,
  VLAN_RANGE_TYPES,
  ZONE_CRITICALITIES,
  ZONE_LEVELS,
  PLANT_BULK,
  PLANT_REMOVABLE_KINDS,
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
 * (`kpi_definition`) and `assignments` (`assignment`) – files of part 1 stay valid. Part 3 (#220) adds the OT network:
 * `ot_networks` (`ot_network`: a site's VLANs, IEC 62443-3-2 zones and conduits) and `asset_networks` (`asset_network`:
 * an asset's devices, data paths and the checks that give its live status).
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
    aliases: z
      .array(z.string().min(1).max(L.text))
      .max(L.aliases * 5)
      .optional()
      .describe('Known as: names that tools commonly use for it (a gateway’s variable names) – matched when collections are imported'),
    notes: long,
    publications: z.array(publicationTarget).max(L.publicationsPerPoint).optional().describe('Where it is usually published'),
    present: z
      .boolean()
      .optional()
      .describe('In a profile that extends another: false marks an inherited data point as not present (the other keys change an inherited one)'),
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
    protocol: spelled(protocolOf, PLANT_PROTOCOLS, 'Protocol').optional().describe('Protocol (required for a new interface; an inherited one keeps its own)'),
    present: z.boolean().optional().describe('In a profile that extends another: false marks an inherited interface as not present'),
    direction,
    description: long,
    version: versionText,
    default_port: z.number().int().min(1).max(65535).nullable().optional(),
    authentication: spelled(authKindOf, PLANT_AUTH_KINDS, 'How a client signs in').nullable().optional(),
    client: text(L.text).describe('The client it needs (a gateway, a driver, manual)'),
    notes: long,
    groups: z
      .array(
        z
          .object({
            name: z.string().min(1).max(L.text),
            description: long.describe('Plain text. An inherited group’s entry describes it anew (0.12.0); left out or empty: the inherited description'),
            data_points: z.array(dataPointSchema).max(L.dataPoints).optional(),
          })
          .strict(),
      )
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
    extends: id
      .nullable()
      .optional()
      .describe(
        'The base profile this one extends (0.11.0): its interfaces, data points and files are inherited; `interfaces` then lists only what this profile adds or changes',
      ),
    manufacturer: text(PLANT_LIMITS.text),
    model: text(PLANT_LIMITS.text),
    version: versionText.describe('Firmware or product version the profile describes'),
    category: text(100),
    description: long.describe('Plain text. A profile that extends another inherits its base’s description while it has none (0.12.0)'),
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
    additions: z
      .object({
        interfaces: z.array(interfaceSchema).max(L.assignmentInterfaces).optional().describe('Interfaces of this asset alone'),
        data_points: z
          .array(
            dataPointSchema
              .extend({
                interface: pointId.describe('The interface (of the profile, or added here)'),
                group: text(L.text).describe('Its group there (empty: without a group)'),
              })
              .strict(),
          )
          .max(L.dataPoints)
          .optional()
          .describe('Data points this asset adds to an interface of its profile'),
      })
      .strict()
      .optional()
      .describe('What this asset has beyond its profile (0.11.0): they count as delivered like the profile’s data points'),
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

// ---------- part 3 (#220): the OT network ----------

const short = text(NL.text);
const strings = (max: number) => z.array(z.string().min(1).max(NL.text)).max(max).optional();

export const statusCheckSchema = z
  .object({
    monitor: z.string().min(1).max(200).optional().describe('A Steward monitor (key or id) whose status tells it'),
    check: z.string().max(128).nullable().optional().describe('One check of the monitor (id or key; empty: the whole monitor)'),
    dataset: z.string().min(1).max(200).optional().describe('A Steward dataset (key) whose freshness tells it'),
    column: text(120).describe('Only rows whose column has value (a dataset per device or asset)'),
    value: z
      .union([z.string().max(NL.text), z.number()])
      .nullable()
      .optional(),
    time_column: text(120).describe('The column with the time of the last value (empty: when the dataset was written)'),
    max_age_minutes: z.number().int().min(1).max(525_600).nullable().optional().describe('Older is offline (empty: the dataset’s own freshness)'),
    note: text(500),
  })
  .strict()
  .refine((c) => !!c.monitor !== !!c.dataset, { message: 'Name either a monitor or a dataset' })
  .meta({ id: 'StatusCheck', description: 'A check that tells the live status: a monitor (or one of its checks) or the freshness of a dataset' });

const checks = z.array(statusCheckSchema).max(NL.checks).optional().describe('Linked checks: the live status (online, offline, unknown) comes only from them');

const ip = text(45).describe('IPv4 or IPv6 address');

export const vlanSchema = z
  .object({
    id,
    name,
    vid: z.number().int().min(1).max(4094).nullable().optional().describe('IEEE 802.1Q VLAN identifier (VID), 1–4094'),
    type: text(60).describe('What it is for: production, management, iot …'),
    owner: short,
    description: text(NL.longText),
    subnets: z
      .array(
        z
          .object({
            cidr: z.string().min(1).max(50).describe('CIDR notation, IPv4 or IPv6: 10.20.30.0/24, 2001:db8:30::/48'),
            gateway: ip,
            description: text(500),
            ranges: z
              .array(z.object({ start: z.string().min(1).max(45), end: z.string().min(1).max(45), type: z.enum(VLAN_RANGE_TYPES), notes: text(500) }).strict())
              .max(NL.ranges)
              .optional()
              .describe('Address ranges: blocked, dynamic (DHCP) or static'),
          })
          .strict(),
      )
      .max(NL.subnets)
      .optional(),
    restricted: z.boolean().nullable().optional().describe('Access to it is restricted (an rVLAN behind a firewall)'),
    managed_by: short.describe('Who manages it'),
    rules_at: text(2000).describe('Where its access rules are kept'),
    sites: z.array(id).max(NL.sites).optional().describe('Other sites it reaches'),
    location: short,
    segment: text(100).describe('The Steward network segment (system id) it is linked to'),
    notes: text(NL.longText),
  })
  .strict()
  .meta({ id: 'Vlan', description: 'An IEEE 802.1Q VLAN of a site with its subnets and ranges' });

export const zoneSchema = z
  .object({
    id,
    name,
    description: text(NL.longText),
    criticality: z.enum(ZONE_CRITICALITIES).nullable().optional(),
    level: z
      .enum(ZONE_LEVELS)
      .nullable()
      .optional()
      .describe('Where the zone sits in the Purdue levels, bottom to top; leave it out and the diagram derives one'),
    vlans: z.array(id).max(NL.vlansPerZone).optional().describe('The VLANs in the zone (ids of VLANs of the site)'),
    owner: short,
    sl_t: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .nullable()
      .optional()
      .describe('IEC 62443-3-2 target security level (SL-T 1–4); leave it out until a risk assessment sets it'),
    risk_assessment: text(500).describe('The risk assessment that set SL-T (needed with sl_t)'),
    assessed_at: date,
    notes: text(NL.longText),
  })
  .strict()
  .meta({ id: 'Zone', description: 'An IEC 62443-3-2 zone' });

export const conduitSchema = z
  .object({
    id,
    name,
    description: text(NL.longText),
    zones: z.tuple([id, id]).describe('The two zones it connects'),
    direction: z.enum(CONDUIT_DIRECTIONS).optional().describe('a_to_b (first to second zone), b_to_a or both (default)'),
    protocols: strings(NL.protocols).describe('Protocols and ports: opc-ua tcp/4840, https tcp/443'),
    controls: strings(NL.controls).describe('Its controls: firewall, data diode, jump host'),
    notes: text(NL.longText),
  })
  .strict()
  .meta({ id: 'Conduit', description: 'An IEC 62443-3-2 conduit between two zones' });

export const otNetworkSchema = z
  .object({
    site: id.describe('The site'),
    vlans: z.array(vlanSchema).max(NL.vlansPerSite).optional(),
    zones: z.array(zoneSchema).max(NL.zonesPerSite).optional(),
    conduits: z.array(conduitSchema).max(NL.conduitsPerSite).optional(),
  })
  .strict()
  .meta({ id: 'OtNetwork', description: 'The OT network of a site: VLANs, zones and conduits' });

export const deviceSchema = z
  .object({
    id,
    hostname: text(NL.host),
    domain: text(NL.host),
    purpose: short,
    mac: text(20).describe('MAC address (EUI-48): AC-DE-48-00-00-80, ac:de:48:00:00:80 or acde.4800.0080'),
    serial: short,
    vlan: ref.describe('A VLAN of the asset’s site'),
    address_type: z.enum(ADDRESS_TYPES).nullable().optional(),
    address: ip,
    switch: short,
    switch_port: text(100),
    wall_outlet: text(100),
    cmdb_port: short.describe('The port’s name in the CMDB'),
    state: z.enum(DEVICE_STATES).optional().describe('active (default), planned, inactive or retired'),
    flags: z.array(z.string().min(1).max(40)).max(NL.flags).optional().describe('snake_case flags: device_ordered, port_ordered, address_ordered …'),
    confidence: z.enum(DEVICE_CONFIDENCE).nullable().optional().describe('How sure the documentation is'),
    owner: short,
    monitoring: text(500).describe('The monitoring that watches it (text)'),
    checks,
    notes: text(NL.longText),
  })
  .strict()
  .meta({ id: 'Device', description: 'A device of an asset: its network identity' });

export const dataPathSchema = z
  .object({
    id,
    subject: z.string().min(1).max(NL.text).describe('What data'),
    description: text(NL.longText),
    devices: z.array(id).max(NL.devicesPerPath).optional().describe('Devices of the asset it covers'),
    collector: z
      .object({
        kind: z.enum(COLLECTOR_KINDS).describe('application, platform, process (a Steward item) or job (elsewhere, by name)'),
        ref: z.string().min(1).max(NL.text).describe('Its id (the name of a job)'),
        host: text(100).describe('The Steward system it runs on'),
      })
      .strict()
      .nullable()
      .optional(),
    transfers: z
      .array(
        z
          .object({
            protocol: z.string().min(1).max(60),
            mode: z.enum(TRANSFER_MODES),
            peer_kind: z.enum(PEER_KINDS).optional().describe('device (of the asset), system (a Steward system) or other (default)'),
            peer: short,
            port: z.number().int().min(1).max(65535).nullable().optional(),
            notes: text(500),
          })
          .strict(),
      )
      .max(NL.transfers)
      .optional(),
    destinations: z
      .array(
        z
          .object({
            kind: z.enum(DESTINATION_KINDS).optional().describe('system, dataset or other (default)'),
            ref: z.string().min(1).max(NL.text),
            path: text(500),
            notes: text(500),
          })
          .strict(),
      )
      .max(NL.destinations)
      .optional(),
    notes: text(NL.longText),
  })
  .strict()
  .meta({ id: 'DataPath', description: 'What data leaves an asset, who collects it, how it is transferred and where it ends up' });

export const assetNetworkSchema = z
  .object({
    asset: id.describe('The asset'),
    site: id.optional().describe('The asset’s site (optional; checked when given)'),
    checks,
    devices: z.array(deviceSchema).max(NL.devicesPerAsset).optional(),
    data_paths: z.array(dataPathSchema).max(NL.pathsPerAsset).optional(),
  })
  .strict()
  .meta({ id: 'AssetNetwork', description: 'The OT network of an asset: its devices, data paths and live-status checks' });

// 0.11.0 (docs/PLANT.md#changing-many-entries-at-once): entries the import removes, by kind and id
export const removeSchema = z
  .object({
    kind: z
      .enum(PLANT_REMOVABLE_KINDS)
      .describe('site, building, node (area, work center, work unit), asset, profile, kpi, vlan, zone, conduit, device or data_path'),
    id: z.string().min(1).max(120).describe('Its id'),
    site: id.optional().describe('The site of a building, node, VLAN, zone or conduit'),
    asset: id.optional().describe('The asset of a device or data path'),
  })
  .strict()
  .meta({ id: 'Removal', description: 'An entry the import removes (with what belongs to it only when the person asks for it)' });

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
    ot_network: otNetworkSchema.optional().describe('The OT network of one site (a file per site)'),
    ot_networks: z.array(otNetworkSchema).max(PLANT_LIMITS.sites).optional().describe('The OT networks of sites'),
    asset_network: assetNetworkSchema.optional().describe('The OT network of one asset'),
    asset_networks: z.array(assetNetworkSchema).max(PLANT_LIMITS.assets).optional().describe('The OT networks of assets'),
    remove: z.array(removeSchema).max(PLANT_BULK.maxItems).optional().describe('Entries to remove (since 0.11.0)'),
  })
  .strict()
  .refine((f) => !(f.site && f.sites), { message: 'Use either site (one) or sites (several), not both', path: ['site'] })
  .refine((f) => !(f.device_profile && f.device_profiles), { message: 'Use either device_profile or device_profiles, not both', path: ['device_profile'] })
  .refine((f) => !(f.kpi_definition && f.kpi_definitions), { message: 'Use either kpi_definition or kpi_definitions, not both', path: ['kpi_definition'] })
  .refine((f) => !(f.assignment && f.assignments), { message: 'Use either assignment or assignments, not both', path: ['assignment'] })
  .refine((f) => !(f.ot_network && f.ot_networks), { message: 'Use either ot_network or ot_networks, not both', path: ['ot_network'] })
  .refine((f) => !(f.asset_network && f.asset_networks), { message: 'Use either asset_network or asset_networks, not both', path: ['asset_network'] });

export type PlantFile = z.infer<typeof plantFileSchema>;
export type SiteFile = z.infer<typeof siteSchema>;
export type AssetFile = z.infer<typeof assetSchema>;
export type AreaFile = z.infer<typeof areaSchema>;
export type ProfileFile = z.infer<typeof profileSchema>;
export type InterfaceFile = z.infer<typeof interfaceSchema>;
export type DataPointFile = z.infer<typeof dataPointSchema>;
export type KpiFile = z.infer<typeof kpiSchema>;
export type AssignmentFile = z.infer<typeof assignmentSchema>;
export type OtNetworkFile = z.infer<typeof otNetworkSchema>;
export type AssetNetworkFile = z.infer<typeof assetNetworkSchema>;
export type StatusCheckFile = z.infer<typeof statusCheckSchema>;
export type RemoveFile = z.infer<typeof removeSchema>;

/** The published JSON Schema (2020-12) of the format. */
export function plantJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(plantFileSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema, ...rest } = s;
  return {
    $schema: $schema ?? 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'Steward plant registry, format 1',
    description:
      'Sites of an enterprise with their ISA-95 (IEC 62264) hierarchy – area, work center, work unit –, the buildings (IEC 81346 location aspect) and the assets in them; device profiles with their interfaces and data points (OPC UA IEC 62541, Modbus, IEC 61131-3, UCUM), KPI definitions (ISO 22400-2) and the assignments of assets; the OT network – IEEE 802.1Q VLANs, IEC 62443-3-2 zones and conduits, devices and data paths of assets. See docs/PLANT.md.',
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
