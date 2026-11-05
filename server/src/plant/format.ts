import { z } from 'zod';
import {
  ASSET_STATUSES,
  BUILDING_KINDS,
  boundedRecord,
  PLANT_FORMAT_VERSION,
  PLANT_ID_RE,
  PLANT_LANG_RE,
  PLANT_LIMITS,
  WORK_CENTER_TYPES,
  WORK_UNIT_TYPES,
} from '@sm/shared';
import { ID_HINT } from './model.js';

/**
 * The import and export format of the plant registry, version 1 (#218): YAML (or JSON) in snake_case, published as
 * a JSON Schema 2020-12 document (docs/plant/plant-registry-1.schema.json, generated from this file by
 * `npm run plant:schema`). One file holds a whole tree (`sites:`), one site (`site:`) or only assets (`assets:`,
 * each naming its site in `location.site`) – an import takes several files at once.
 *
 * Later versions of the module add optional keys (device profiles, OT network) without changing these.
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
  })
  .strict()
  .refine((f) => !(f.site && f.sites), { message: 'Use either site (one) or sites (several), not both', path: ['site'] });

export type PlantFile = z.infer<typeof plantFileSchema>;
export type SiteFile = z.infer<typeof siteSchema>;
export type AssetFile = z.infer<typeof assetSchema>;
export type AreaFile = z.infer<typeof areaSchema>;

/** The published JSON Schema (2020-12) of the format. */
export function plantJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(plantFileSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema, ...rest } = s;
  return {
    $schema: $schema ?? 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'Steward plant registry, format 1',
    description:
      'Sites of an enterprise with their ISA-95 (IEC 62264) hierarchy – area, work center, work unit –, the buildings (IEC 81346 location aspect) and the assets in them. See docs/PLANT.md.',
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
