import { z } from 'zod';
import {
  CIA_COLORS,
  CIA_LEVEL_KEY_RE,
  CIA_LIMITS,
  DATA_AGREEMENT_KINDS,
  DATA_CLASSIFICATIONS,
  DATA_CONSUMER_KINDS,
  DATA_ELEMENT_KINDS,
  DATA_ENVIRONMENT_STATES,
  DATA_MEMBER_ROLES,
  DATA_OBJECT_LIFECYCLES,
  DATA_PORT_DIRECTIONS,
  DATA_PORT_LIFECYCLES,
  DATA_PORT_TYPES,
  DATA_PRODUCT_CRITICALITIES,
  DATA_PRODUCT_KEY_RE,
  DATA_PRODUCT_LIFECYCLES,
  DATA_PRODUCT_LIMITS as L,
  DATA_PRODUCT_TYPES,
  DATA_STEP_KINDS,
  DATA_TRANSFORM_KINDS,
  DATA_VALUE_TIERS,
  LEGAL_BASES,
  PERSONAL_DATA_LEVELS,
  SPECIAL_DATA_CATEGORIES,
  boundedRecord,
} from '@sm/shared';

/**
 * Steward's file format of the data products module, version 1 (ADR 0036 part 15, docs/DATA-PRODUCTS.md "File
 * format"): YAML or JSON in snake_case, published as a JSON Schema 2020-12 document
 * (docs/data-products/data-products-1.schema.json, written from this file by `npx tsx server/src/cli/data-products-schema.ts`
 * and checked by the tests). One file holds any of `domains`, `data_objects`, `elements` and `data_products` (or one of
 * them: `domain:`, `data_object:`, `data_product:`); several files are one import.
 *
 * Identity: domains, data objects and products by `key`; elements by platform (its name, or `platform_id`), kind,
 * qualified name and environment; ports by direction, name and version; bindings by environment; steps by name within
 * their product; consumers by kind and whom they name. Everything else is optional: a key the file leaves out keeps
 * what Steward has (an import adds and changes, it never removes – phase 1).
 *
 * Never in a file: credentials, platform variables, discovery run-as users, readouts, check states, costs.
 */

export const DATA_PRODUCT_FORMAT_VERSION = 1;
export const SCHEMA_ID = 'https://github.com/vxrz/Steward/blob/main/docs/data-products/data-products-1.schema.json';

/** Limits of an import (the parser's limits are those of the other YAML importers: yaml-safe.ts). */
export const DATA_PRODUCT_IMPORT_LIMITS = {
  /** All files together (UTF-8 bytes) */
  bytes: 8 * 1024 * 1024,
  files: 500,
  /** Upper bound of the keys of all files (checked before parsing) */
  keys: 500_000,
  aliases: 100,
  /** Nesting of a document */
  depth: 12,
  /** Elements of one import (the catalogue holds L.elements; discovery fills it, files document what it cannot read) */
  elements: 20_000,
  /** Problems and changes shown in a preview */
  problems: 200,
  changes: 2_000,
} as const;

const keyHint = 'lower case letters, digits, “.”, “_” and “-”, starting with a letter or digit';
const key = (what: string) => z.string().regex(DATA_PRODUCT_KEY_RE, keyHint).describe(what);
const name = () => z.string().trim().min(1).max(L.name);
const text = (max: number = L.text) => z.string().max(max);
const date = () =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2027-03-31')
    .nullable();
const subject = () =>
  z
    .string()
    .max(L.short)
    .regex(/^(user|team):.+$/, 'user:<name> or team:<name>')
    .describe('A person or a team: user:<name> or team:<name>');
function list(max: number): z.ZodArray<z.ZodString>;
function list<T extends z.ZodType>(max: number, item: T): z.ZodArray<T>;
function list(max: number, item: z.ZodType = text(L.short)) {
  return z.array(item).max(max);
}
const httpUrl = () =>
  z
    .string()
    .max(L.url)
    .regex(/^https?:\/\/\S+$/i, 'an http(s) address');
const externalRef = z
  .object({ label: text(L.short).optional(), url: httpUrl() })
  .strict()
  .meta({ id: 'ExternalRef', description: 'A link with a label' });
const externalRefs = () => z.array(externalRef).max(L.externalRefs).describe('Links: a wiki page, a catalogue entry (a DataHub URN as a URL), a repository');
const environment = () => z.string().max(60).describe('An environment of Settings → Environments (empty: none)');

// ---------- references ----------

export const elementRefSchema = z
  .object({
    platform: z
      .string()
      .min(1)
      .max(L.name)
      .nullable()
      .optional()
      .describe('The platform by its name (a platform you may see; left out: no platform, where the kind allows it)'),
    platform_id: z.string().min(1).max(100).optional().describe('The platform by its id, instead of its name'),
    kind: z.enum(DATA_ELEMENT_KINDS),
    qualified_name: z.string().trim().min(1).max(L.qualifiedName).describe('SHOP.SALES.ORDERS, orders.v1, public.orders, a path'),
    environment: environment().optional(),
  })
  .strict()
  .meta({ id: 'ElementRef', description: 'An element of the catalogue: platform, kind, qualified name and environment' });
export type ElementRefFile = z.infer<typeof elementRefSchema>;

const objectivesSchema = z
  .object({
    freshness_minutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 366)
      .nullable()
      .optional(),
    availability_pct: z.number().min(0).max(100).nullable().optional(),
    completeness: text(L.short).nullable().optional(),
    completeness_pct: z.number().min(0).max(100).nullable().optional(),
    update_schedule: text(L.short).nullable().optional(),
    retention: text(L.short).nullable().optional(),
  })
  .strict()
  .meta({
    id: 'Objectives',
    description: 'Objectives (SLO): freshness in minutes, availability and completeness in percent over 30 days, an update schedule and retention',
  });
const objectives = () => objectivesSchema;

const ratingLevel = z
  .object({ level: z.string().regex(CIA_LEVEL_KEY_RE), justification: z.string().trim().min(1).max(CIA_LIMITS.justification) })
  .strict()
  .meta({ id: 'RatingLevel', description: 'A level of the instance’s CIA scale with its justification' });
const ratingDimension = () => ratingLevel.nullable().optional().describe('A level with its justification (null: not rated)');

const ciaRating = () => ({ confidentiality: ratingDimension(), integrity: ratingDimension(), availability: ratingDimension() });

// ---------- domains ----------

export const domainFileSchema = z
  .object({
    key: key('Unique key of the domain'),
    name: name(),
    description: text(L.description).optional(),
    parent: key('The parent domain (a sub-domain belongs to a top-level domain)').nullable().optional(),
    colour: z.enum(CIA_COLORS).nullable().optional(),
    owners: list(L.subjects, subject()).optional(),
  })
  .strict()
  .meta({ id: 'DataDomain' });
export type DomainFile = z.infer<typeof domainFileSchema>;

// ---------- data objects ----------

export const objectFileSchema = z
  .object({
    key: key('Unique key of the data object (customer, order)'),
    name: name(),
    definition: text(L.description).optional().describe('What the data is (Markdown): the business glossary of the module'),
    synonyms: list(L.synonyms).optional(),
    domain: key('Its domain').nullable().optional(),
    lifecycle: z.enum(DATA_OBJECT_LIFECYCLES).optional(),
    classification: z.enum(DATA_CLASSIFICATIONS).nullable().optional(),
    personal_data: z.enum(PERSONAL_DATA_LEVELS).optional(),
    categories: list(L.listValues).optional(),
    special_categories: z.array(z.enum(SPECIAL_DATA_CATEGORIES)).max(SPECIAL_DATA_CATEGORIES.length).optional(),
    subjects: list(L.listValues).optional().describe('Data subjects: customers, employees …'),
    legal_basis: z.enum(LEGAL_BASES).nullable().optional(),
    legal_note: text().optional(),
    purposes: list(L.listValues).optional(),
    retention: text(L.short).optional().describe('An ISO 8601 duration (P10Y) or text'),
    deletion_rule: text().optional(),
    regulatory_flags: list(L.listValues).optional(),
    attributes: z
      .array(z.object({ name: name(), description: text().optional(), personal: z.boolean().optional() }).strict())
      .max(L.attributes)
      .optional(),
    owner: z.string().max(L.short).nullable().optional().describe('The data owner: a user name'),
    stewards: list(L.subjects, subject()).optional(),
    custodians: list(L.subjects, subject()).optional(),
    external_refs: externalRefs().optional(),
    rating: z.object(ciaRating()).strict().optional(),
    elements: z
      .array(z.object({ element: elementRefSchema, note: text().optional() }).strict())
      .max(L.membersPerProduct)
      .optional()
      .describe('Elements that implement it (added; links the file does not name stay)'),
  })
  .strict()
  .meta({ id: 'DataObject' });
export type ObjectFile = z.infer<typeof objectFileSchema>;

// ---------- elements ----------

export const elementFileSchema = elementRefSchema
  .extend({
    display_name: text(L.name).optional(),
    parent: z.string().min(1).max(L.qualifiedName).nullable().optional().describe('The qualified name of its parent (same platform and environment)'),
    layer: text(60).optional(),
    description: text(L.description).optional(),
    type_label: text(L.short).optional().describe('A free type label (Power BI dataset, Excel extract)'),
    api_ref: z
      .object({ url: httpUrl().optional(), operations: z.array(text(L.short)).max(200).optional() })
      .strict()
      .nullable()
      .optional()
      .describe('An API element: the address of its description and the operations that serve data'),
    flags: boundedRecord(z.union([z.string().max(L.short), z.number(), z.boolean()]), L.flags)
      .optional()
      .describe('Flags of a new element (secure, materialized …); an import does not change those of an existing one'),
  })
  .strict()
  .meta({ id: 'DataElement' });
export type ElementFile = z.infer<typeof elementFileSchema>;

// ---------- products ----------

const consumerSchema = z
  .object({
    kind: z.enum(DATA_CONSUMER_KINDS),
    subject: subject().optional().describe('kind team or user: team:<name> or user:<name>'),
    ref: z.string().min(1).max(L.name).optional().describe('kind application or service: its name; kind product: its key'),
    text: text(L.short).optional().describe('kind text: who it is'),
    purpose: text().optional(),
    since: date().optional(),
    end_date: date().optional(),
    agreement: z
      .object({ kind: z.enum(DATA_AGREEMENT_KINDS), ref: z.string().min(1).max(L.url), label: text(L.short).optional() })
      .strict()
      .nullable()
      .optional(),
    contacts: list(L.subjects, subject()).optional(),
  })
  .strict()
  .meta({ id: 'PortConsumer' });
export type ConsumerFile = z.infer<typeof consumerSchema>;

const bindingSchema = z
  .object({
    environment: environment(),
    elements: z.array(elementRefSchema).max(L.elementsPerBinding).optional(),
    contract: z.string().min(1).max(L.short).nullable().optional().describe('Output ports: the data contract by its ODCS id'),
    contract_version: z.number().int().min(1).nullable().optional().describe('The version it is held to (null: the current one)'),
    contract_server: text(L.short).nullable().optional().describe('The ODCS server of the contract for this environment'),
    objectives: objectives().optional(),
  })
  .strict()
  .meta({ id: 'PortBinding' });
export type BindingFile = z.infer<typeof bindingSchema>;

const sourceSchema = z
  .object({
    product: key('Another product’s key').optional(),
    port: z.string().min(1).max(100).optional().describe('Its output port’s name'),
    version: z.string().max(60).optional().describe('Its output port’s version'),
    element: elementRefSchema.optional(),
    text: text().optional(),
  })
  .strict()
  .meta({ id: 'PortSource', description: "Input ports: another product's output port (product, port, version), an element of a source system, or a text" });
export type SourceFile = z.infer<typeof sourceSchema>;

const portSchema = z
  .object({
    direction: z.enum(DATA_PORT_DIRECTIONS),
    name: z.string().trim().min(1).max(100),
    version: z.string().max(60).optional().describe('Two versions are two ports'),
    type: z.enum(DATA_PORT_TYPES).optional(),
    description: text(L.description).optional(),
    lifecycle: z.enum(DATA_PORT_LIFECYCLES).optional(),
    sunset_date: date().optional(),
    successor: z
      .object({ name: z.string().min(1).max(100), version: z.string().max(60).optional() })
      .strict()
      .nullable()
      .optional()
      .describe('The port of this product that follows a deprecated one'),
    objectives: objectives().optional(),
    source: sourceSchema.nullable().optional(),
    data_objects: list(L.objectsPerPort, key('A data object')).optional(),
    bindings: z.array(bindingSchema).max(50).optional(),
    consumers: z.array(consumerSchema).max(L.consumersPerPort).optional(),
  })
  .strict()
  .meta({ id: 'Port' });
export type PortFile = z.infer<typeof portSchema>;

const runnerSchema = z
  .object({
    kind: z.enum(['application', 'platform', 'process', 'element', 'connector', 'tool']),
    name: z.string().min(1).max(L.name).optional().describe('application, platform, process: its name; connector: the connector’s name'),
    platform: z.string().min(1).max(L.name).optional().describe('connector: the platform it runs on'),
    element: elementRefSchema.optional().describe('element: a Snowflake task, pipe or dynamic table'),
    tool: text(L.short).optional().describe('tool: Airflow, dbt, Fivetran, Kafka Connect …'),
    text: text().optional(),
  })
  .strict()
  .meta({ id: 'StepRunner' });
export type RunnerFile = z.infer<typeof runnerSchema>;

const stepSchema = z
  .object({
    name: name(),
    kind: z.enum(DATA_STEP_KINDS).optional(),
    runner: runnerSchema.nullable().optional(),
    schedule: text(L.short).optional(),
    description: text(L.description).optional(),
    notes: z
      .array(z.object({ kind: z.enum(DATA_TRANSFORM_KINDS), text: text().optional() }).strict())
      .max(L.transformNotes)
      .optional(),
    inputs: z.array(elementRefSchema).max(L.stepEnds).optional(),
    outputs: z.array(elementRefSchema).max(L.stepEnds).optional(),
  })
  .strict()
  .meta({ id: 'Step' });
export type StepFile = z.infer<typeof stepSchema>;

const reason = () => z.string().trim().max(CIA_LIMITS.reason).nullable().optional();

export const productFileSchema = z
  .object({
    key: key('Unique key of the product (ODPS id)'),
    name: name(),
    description: text(L.description).optional(),
    purpose: text(L.description).optional(),
    type: z.enum(DATA_PRODUCT_TYPES).nullable().optional(),
    domain: key('Its domain or sub-domain').nullable().optional(),
    owners: list(L.subjects, subject()).optional().describe('The product owners'),
    support: z
      .object({ channel: text(L.short).optional(), url: z.union([httpUrl(), z.literal('')]).optional(), hours: text(L.short).optional() })
      .strict()
      .optional(),
    criticality: z.enum(DATA_PRODUCT_CRITICALITIES).nullable().optional(),
    tier: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .nullable()
      .optional(),
    version: text(60).optional(),
    value_statement: text().optional(),
    value_tier: z.enum(DATA_VALUE_TIERS).nullable().optional(),
    value_amount: z.number().min(0).max(1e12).nullable().optional().describe('A yearly amount in value_currency (shown beside costs, never netted)'),
    value_currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
    successor: key('The product that follows a deprecated one').nullable().optional(),
    tags: list(L.tags, text(160)).optional(),
    external_refs: externalRefs().optional(),
    lifecycle: z.enum(DATA_PRODUCT_LIFECYCLES).optional(),
    sunset_date: date().optional(),
    rating: z
      .object({
        ...ciaRating(),
        classification: z.enum(DATA_CLASSIFICATIONS).nullable().optional(),
        reasons: z
          .object({ confidentiality: reason(), integrity: reason(), availability: reason(), classification: reason() })
          .strict()
          .optional()
          .describe('Why the product is below the data objects it exposes (the distribution effect)'),
      })
      .strict()
      .optional(),
    environments: z
      .array(z.object({ environment: environment(), state: z.enum(DATA_ENVIRONMENT_STATES).optional() }).strict())
      .max(50)
      .optional(),
    members: z
      .array(
        z
          .object({
            element: elementRefSchema,
            role: z.enum(DATA_MEMBER_ROLES).optional(),
            include_descendants: z.boolean().optional(),
            note: text().optional(),
          })
          .strict(),
      )
      .max(L.membersPerProduct)
      .optional()
      .describe('Its elements with their role (input, internal, output)'),
    ports: z.array(portSchema).max(L.portsPerProduct).optional(),
    steps: z.array(stepSchema).max(L.stepsPerPipeline).optional().describe('Steps documented with this product: each writes at least one of its elements'),
  })
  .strict()
  .meta({ id: 'DataProduct' });
export type ProductFile = z.infer<typeof productFileSchema>;

// ---------- the file ----------

export const dataProductsFileSchema = z
  .object({
    version: z.literal(DATA_PRODUCT_FORMAT_VERSION).describe('The format of the file'),
    domains: z.array(domainFileSchema).max(L.domains).optional(),
    domain: domainFileSchema.optional(),
    data_objects: z.array(objectFileSchema).max(L.objects).optional(),
    data_object: objectFileSchema.optional(),
    elements: z.array(elementFileSchema).max(DATA_PRODUCT_IMPORT_LIMITS.elements).optional(),
    data_products: z.array(productFileSchema).max(L.products).optional(),
    data_product: productFileSchema.optional(),
  })
  .strict();
export type DataProductsFile = z.infer<typeof dataProductsFileSchema>;

/** The JSON Schema of the format (docs/data-products/data-products-1.schema.json, GET /api/data-products/schema). */
export function dataProductsJsonSchema(): Record<string, unknown> {
  const s = z.toJSONSchema(dataProductsFileSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema, ...rest } = s;
  return {
    $schema: $schema ?? 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'Steward data products, format 1',
    description:
      'Data domains, data objects (the business data: definition, rating, classification, personal data), the element catalogue (tables, views, topics, APIs, paths on platforms, per environment) and data products with their ports (bindings per environment, ODCS contracts, objectives, consumers), members and steps. Exported and imported by Steward; ODPS v1.0.0 is the exchange format of a single product. See docs/DATA-PRODUCTS.md.',
    ...rest,
  };
}

// ---------- messages ----------

const at = (path: PropertyKey[]): string =>
  path.reduce<string>((s, p) => (typeof p === 'number' ? `${s}[${p}]` : s ? `${s}.${String(p)}` : String(p)), '') || '(document)';

/** Zod issues as short messages with the place in the file (data_products[0].ports[1].name). */
export function issueMessages(issues: z.core.$ZodIssue[]): { path: string; message: string }[] {
  return issues.slice(0, 50).map((i) => {
    const issue = i as z.core.$ZodIssue & { keys?: string[] };
    const message =
      i.code === 'unrecognized_keys'
        ? `Unknown key${issue.keys!.length > 1 ? 's' : ''} ${issue.keys!.map((k) => `"${k}"`).join(', ')} (see docs/DATA-PRODUCTS.md)`
        : i.message;
    return { path: at(i.path), message };
  });
}

// ---------- identities ----------

/** The identity of an element reference (platform as written: a name or an id, resolved by the importer). */
export const portIdentity = (p: { direction: string; name: string; version?: string }): string => `${p.direction} ${p.name} ${p.version ?? ''}`.trim();
