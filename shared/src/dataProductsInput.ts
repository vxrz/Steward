import { z } from 'zod';
import { CIA_COLORS, CIA_LEVEL_KEY_RE, CIA_LIMITS } from './catalogue.js';
import { isoCurrencyCode } from './costs.js';
import {
  DATA_AGREEMENT_KINDS,
  DATA_CHECK_PURPOSES,
  DATA_CLASSIFICATIONS,
  DATA_CONSUMER_KINDS,
  DATA_DISCOVERY_LIMITS as DL,
  DATA_DISCOVERY_MODES,
  DATA_COST_MATCH_KINDS,
  DATA_COST_MEASURE_LIMITS,
  DATA_COST_MEASURES,
  DATA_ELEMENT_KINDS,
  DATA_ENVIRONMENT_STATES,
  DATA_MEMBER_ROLES,
  DATA_OBJECT_LIFECYCLES,
  DATA_PORT_DIRECTIONS,
  DATA_PORT_LIFECYCLES,
  DATA_PORT_TYPES,
  DATA_FILE_FORMATS,
  DATA_PORT_PARTITION_KEYS,
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
} from './dataProducts.js';

/**
 * Input schemas of the data products module's internal API (ADR 0036 part 19): every array has its `.max()`, every
 * text its length. Shared so that the web app's forms check the same limits.
 */

const text = (max: number = L.text) => z.string().trim().max(max);
const name = () => z.string().trim().min(1).max(L.name);
const key = () => z.string().trim().regex(DATA_PRODUCT_KEY_RE, 'lower case letters, digits, “.”, “_” and “-”, starting with a letter or digit');
const id = () => z.string().trim().min(1).max(100);
const subject = () =>
  z
    .string()
    .trim()
    .max(L.short)
    .regex(/^(user|team):.+$/, 'user:<name> or team:<name>');
const isoDate = () =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2027-03-31');
const httpUrl = () =>
  z
    .string()
    .trim()
    .max(L.url)
    .regex(/^https?:\/\/\S+$/i, 'an http(s) address');
const environment = () => z.string().trim().max(60);
const list = (max: number, item = text(L.short)) => z.array(item).max(max);

export const dataExternalRefInput = z.object({ label: text(L.short), url: httpUrl() }).strict();
const externalRefs = () => z.array(dataExternalRefInput).max(L.externalRefs);

// ---------- domains ----------

export const dataDomainInput = z
  .object({
    key: key(),
    name: name(),
    description: text(L.description).default(''),
    parentId: id().nullable().default(null),
    colour: z.enum(CIA_COLORS).nullable().default(null),
    owners: z.array(subject()).max(L.subjects).default([]),
  })
  .strict();
export type DataDomainInput = z.input<typeof dataDomainInput>;

// ---------- data objects ----------

export const dataObjectAttributeInput = z.object({ name: name(), description: text().default(''), personal: z.boolean().default(false) }).strict();

export const dataObjectInput = z
  .object({
    key: key(),
    name: name(),
    definition: text(L.description).default(''),
    synonyms: list(L.synonyms).default([]),
    domainId: id().nullable().default(null),
    lifecycle: z.enum(DATA_OBJECT_LIFECYCLES).default('draft'),
    classification: z.enum(DATA_CLASSIFICATIONS).nullable().default(null),
    personalData: z.enum(PERSONAL_DATA_LEVELS).default('none'),
    categories: list(L.listValues).default([]),
    specialCategories: z.array(z.enum(SPECIAL_DATA_CATEGORIES)).max(SPECIAL_DATA_CATEGORIES.length).default([]),
    subjects: list(L.listValues).default([]),
    legalBasis: z.enum(LEGAL_BASES).nullable().default(null),
    legalNote: text().default(''),
    purposes: list(L.listValues).default([]),
    retention: text(L.short).default(''),
    deletionRule: text().default(''),
    regulatoryFlags: list(L.listValues).default([]),
    attributes: z.array(dataObjectAttributeInput).max(L.attributes).default([]),
    /** The data owner: a user name */
    owner: z.string().trim().max(L.short).nullable().default(null),
    stewards: z.array(subject()).max(L.subjects).default([]),
    custodians: z.array(subject()).max(L.subjects).default([]),
    externalRefs: externalRefs().default([]),
  })
  .strict();
export type DataObjectInput = z.input<typeof dataObjectInput>;

const ratingDimension = z
  .object({
    level: z.string().trim().regex(CIA_LEVEL_KEY_RE),
    justification: z.string().trim().min(1, 'Give a justification').max(CIA_LIMITS.justification),
  })
  .strict()
  .nullable()
  .optional();

/** Per dimension: a level with its justification, null to remove the rating, missing to keep it. */
export const dataRatingInput = z.object({ confidentiality: ratingDimension, integrity: ratingDimension, availability: ratingDimension }).strict();
export type DataRatingInput = z.infer<typeof dataRatingInput>;

const reason = () => z.string().trim().max(CIA_LIMITS.reason).nullable().optional();
/** A product's rating with the reasons for being below its data objects (per dimension and the classification). */
export const dataProductRatingInput = dataRatingInput
  .extend({
    classification: z.enum(DATA_CLASSIFICATIONS).nullable().optional(),
    reasons: z.object({ confidentiality: reason(), integrity: reason(), availability: reason(), classification: reason() }).strict().optional(),
  })
  .strict();
export type DataProductRatingInput = z.infer<typeof dataProductRatingInput>;

export const dataObjectElementInput = z.object({ elementId: id(), note: text().default('') }).strict();

// ---------- products ----------

export const dataProductInput = z
  .object({
    key: key(),
    name: name(),
    description: text(L.description).default(''),
    purpose: text(L.description).default(''),
    type: z.enum(DATA_PRODUCT_TYPES).nullable().default(null),
    domainId: id().nullable().default(null),
    owners: z.array(subject()).max(L.subjects).default([]),
    support: z
      .object({ channel: text(L.short).default(''), url: z.union([httpUrl(), z.literal('')]).default(''), hours: text(L.short).default('') })
      .strict()
      .default({ channel: '', url: '', hours: '' }),
    criticality: z.enum(DATA_PRODUCT_CRITICALITIES).nullable().default(null),
    tier: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .nullable()
      .default(null),
    version: text(60).default(''),
    valueStatement: text().default(''),
    valueTier: z.enum(DATA_VALUE_TIERS).nullable().default(null),
    valueAmount: z.number().int().min(0).max(1e18).nullable().default(null),
    valueCurrency: isoCurrencyCode.nullable().default(null),
    successorId: id().nullable().default(null),
    tags: list(L.tags, text(160)).default([]),
    externalRefs: externalRefs().default([]),
  })
  .strict();
export type DataProductInput = z.input<typeof dataProductInput>;

export const dataProductLifecycleInput = z
  .object({
    lifecycle: z.enum(DATA_PRODUCT_LIFECYCLES),
    sunsetDate: isoDate().nullable().optional(),
    successorId: id().nullable().optional(),
    /** Retiring while consumers are registered or consuming products are active */
    confirm: z.boolean().default(false),
  })
  .strict();
export type DataProductLifecycleInput = z.input<typeof dataProductLifecycleInput>;

export const dataProductEnvironmentInput = z.object({ state: z.enum(DATA_ENVIRONMENT_STATES).default('planned') }).strict();

export const dataProductMembersInput = z
  .object({
    elementIds: z.array(id()).min(1).max(L.membersPerRequest),
    role: z.enum(DATA_MEMBER_ROLES).default('internal'),
    includeDescendants: z.boolean().default(false),
    note: text().default(''),
  })
  .strict();
export type DataProductMembersInput = z.input<typeof dataProductMembersInput>;

export const dataProductMemberUpdate = z
  .object({ role: z.enum(DATA_MEMBER_ROLES).optional(), includeDescendants: z.boolean().optional(), note: text().optional() })
  .strict();

// ---------- ports ----------

export const dataObjectivesInput = z
  .object({
    freshnessMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 366)
      .nullable()
      .optional(),
    availabilityPct: z.number().min(0).max(100).nullable().optional(),
    completeness: text(L.short).nullable().optional(),
    completenessPct: z.number().min(0).max(100).nullable().optional(),
    updateSchedule: text(L.short).nullable().optional(),
    retention: text(L.short).nullable().optional(),
  })
  .strict();

export const dataPortSourceInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('port'), portId: id() }).strict(),
  z.object({ kind: z.literal('element'), elementId: id() }).strict(),
  z.object({ kind: z.literal('text'), text: text().pipe(z.string().min(1)) }).strict(),
]);

export const dataPortInput = z
  .object({
    direction: z.enum(DATA_PORT_DIRECTIONS),
    name: z.string().trim().min(1).max(100),
    type: z.enum(DATA_PORT_TYPES).default('table'),
    version: text(60).default(''),
    description: text(L.description).default(''),
    lifecycle: z.enum(DATA_PORT_LIFECYCLES).default('draft'),
    sunsetDate: isoDate().nullable().default(null),
    successorId: id().nullable().default(null),
    objectives: dataObjectivesInput.default({}),
    source: dataPortSourceInput.nullable().default(null),
    objectIds: z.array(id()).max(L.objectsPerPort).default([]),
    position: z.number().int().min(0).max(1000).optional(),
    /** 0.25.0: a file port's format and partition keys (left out: kept as they are) */
    fileFormat: z.enum(DATA_FILE_FORMATS).nullable().optional(),
    partitioning: z.array(z.string().trim().min(1).max(100)).max(DATA_PORT_PARTITION_KEYS).optional(),
  })
  .strict();
export type DataPortInput = z.input<typeof dataPortInput>;

export const dataPortBindingInput = z
  .object({
    elementIds: z.array(id()).max(L.elementsPerBinding).default([]),
    contractId: id().nullable().default(null),
    contractVersion: z.number().int().min(1).nullable().default(null),
    contractServer: text(L.short).nullable().default(null),
    objectives: dataObjectivesInput.default({}),
  })
  .strict();
export type DataPortBindingInput = z.input<typeof dataPortBindingInput>;

export const dataConsumerInput = z
  .object({
    kind: z.enum(DATA_CONSUMER_KINDS),
    refId: id().nullable().default(null),
    subject: subject().nullable().default(null),
    text: text(L.short).default(''),
    purpose: text().default(''),
    since: isoDate().nullable().default(null),
    endDate: isoDate().nullable().default(null),
    agreement: z
      .object({ kind: z.enum(DATA_AGREEMENT_KINDS), ref: z.string().trim().min(1).max(L.url), label: text(L.short).default('') })
      .strict()
      .nullable()
      .default(null),
    contacts: z.array(subject()).max(L.subjects).default([]),
  })
  .strict();
export type DataConsumerInput = z.input<typeof dataConsumerInput>;

// ---------- elements ----------

const flagValue = z.union([z.string().max(L.short), z.number(), z.boolean()]);

export const dataElementInput = z
  .object({
    platformId: id().nullable().default(null),
    kind: z.enum(DATA_ELEMENT_KINDS),
    qualifiedName: z.string().trim().min(1).max(L.qualifiedName),
    displayName: text(L.name).default(''),
    environment: environment().default(''),
    parentId: id().nullable().default(null),
    layer: text(60).default(''),
    description: text(L.description).default(''),
    typeLabel: text(L.short).default(''),
    applicationId: id().nullable().default(null),
    componentId: id().nullable().default(null),
    plantSink: z.object({ assetId: id(), collectionId: id(), sinkId: id() }).strict().nullable().default(null),
    apiRef: z
      .object({ specId: id().optional(), operations: z.array(text(L.short)).max(200).optional(), url: httpUrl().optional() })
      .strict()
      .nullable()
      .default(null),
    flags: z
      .array(z.object({ name: z.string().trim().min(1).max(60), value: flagValue }).strict())
      .max(L.flags)
      .default([]),
  })
  .strict();
export type DataElementInput = z.input<typeof dataElementInput>;

/** An element's people's fields: what a discovery never overwrites (the re-import rule of ADR 0019). */
export const dataElementUpdate = dataElementInput
  .pick({ displayName: true, layer: true, description: true, typeLabel: true, applicationId: true, componentId: true, plantSink: true, apiRef: true })
  .partial()
  .extend({ environment: environment().optional(), qualifiedName: z.string().trim().min(1).max(L.qualifiedName).optional() })
  .strict();

export const dataElementListQuery = z.object({
  platformId: id().optional(),
  kind: z.enum(DATA_ELEMENT_KINDS).optional(),
  environment: environment().optional(),
  layer: text(60).optional(),
  /** Qualified names starting with this (by index) */
  prefix: z.string().trim().max(L.qualifiedName).optional(),
  /** A text in the qualified or display name (a bounded scan) */
  q: z.string().trim().max(L.short).optional(),
  inNoProduct: z.coerce.boolean().optional(),
  missing: z.coerce.boolean().optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(L.page).default(L.page),
});
export type DataElementListQuery = z.infer<typeof dataElementListQuery>;

export const dataProductListQuery = z.object({
  domain: id().optional(),
  type: z.enum(DATA_PRODUCT_TYPES).optional(),
  lifecycle: z.enum(DATA_PRODUCT_LIFECYCLES).optional(),
  team: id().optional(),
  environment: environment().optional(),
  q: z.string().trim().max(L.short).optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(L.page).default(L.page),
});
export type DataProductListQuery = z.infer<typeof dataProductListQuery>;

export const dataObjectListQuery = z.object({
  domain: id().optional(),
  lifecycle: z.enum(DATA_OBJECT_LIFECYCLES).optional(),
  classification: z.enum(DATA_CLASSIFICATIONS).optional(),
  personalData: z.enum(PERSONAL_DATA_LEVELS).optional(),
  q: z.string().trim().max(L.short).optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(L.page).default(L.page),
});
export type DataObjectListQuery = z.infer<typeof dataObjectListQuery>;

export const dataMemberListQuery = z.object({
  role: z.enum(DATA_MEMBER_ROLES).optional(),
  environment: environment().optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(L.page).default(L.page),
});

// ---------- steps ----------

export const dataStepRunnerInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['application', 'platform', 'process', 'element']), id: id() }).strict(),
  z.object({ kind: z.literal('connector'), platformId: id(), name: z.string().trim().min(1).max(L.short) }).strict(),
  z.object({ kind: z.literal('tool'), tool: text(L.short).default(''), text: text().default('') }).strict(),
]);

export const dataStepInput = z
  .object({
    name: name(),
    kind: z.enum(DATA_STEP_KINDS).default('transform'),
    runner: dataStepRunnerInput.nullable().default(null),
    schedule: text(L.short).default(''),
    description: text(L.description).default(''),
    notes: z
      .array(z.object({ kind: z.enum(DATA_TRANSFORM_KINDS), text: text() }).strict())
      .max(L.transformNotes)
      .default([]),
    inputs: z.array(id()).max(L.stepEnds).default([]),
    outputs: z.array(id()).min(1).max(L.stepEnds),
  })
  .strict();
export type DataStepInput = z.input<typeof dataStepInput>;

export const dataCheckLinkInput = z
  .object({
    elementId: id().nullable().default(null),
    stepId: id().nullable().default(null),
    monitorId: id(),
    checkId: z.string().trim().min(1).max(100),
    purpose: z.enum(DATA_CHECK_PURPOSES).default('other'),
  })
  .strict();
export type DataCheckLinkInput = z.input<typeof dataCheckLinkInput>;

// ---------- discovery sources (part 5; WP2) ----------

/**
 * A discovery source: which platform, what to read (the scope, include and exclude prefixes – plain comparisons, no
 * patterns), the environment rules, the Snowflake mode, the identity, the owning teams of what it finds and how often.
 * The scope's entries are checked against the platform's kind by the server (Snowflake `DB` or `DB.SCHEMA`, Kafka topic
 * prefixes, SQL schema names).
 */
export const dataDiscoverySourceInput = z
  .object({
    name: name(),
    platformId: id(),
    scope: z.array(z.string().trim().min(1).max(L.short)).max(DL.scope).default([]),
    includePrefixes: z.array(z.string().trim().min(1).max(L.short)).max(DL.prefixes).default([]),
    excludePrefixes: z.array(z.string().trim().min(1).max(L.short)).max(DL.prefixes).default([]),
    environmentRules: z
      .array(
        z
          .object({ match: z.enum(['prefix', 'suffix']), value: z.string().trim().min(1).max(100), environment: environment().pipe(z.string().min(1)) })
          .strict(),
      )
      .max(DL.environmentRules)
      .default([]),
    mode: z.enum(DATA_DISCOVERY_MODES).nullable().default(null),
    identityId: id().nullable().default(null),
    elementTeamIds: z.array(id()).max(DL.elementTeams).default([]),
    intervalMinutes: z.number().int().min(DL.intervalMinutes.min).max(DL.intervalMinutes.max).default(DL.intervalMinutes.default),
    enabled: z.boolean().default(true),
  })
  .strict();
export type DataDiscoverySourceInput = z.input<typeof dataDiscoverySourceInput>;
// ---------- costs (part 11; WP4) ----------

const costMatchFields = {
  kind: z.enum(DATA_COST_MATCH_KINDS),
  /** A resource id, sub-account id, service name, tag value or application id, as the cost lines carry it */
  value: z.string().trim().min(1).max(L.short),
  /** The tag's key (kind tag only) */
  tagKey: z.string().trim().max(100).default(''),
};

/** A product's own match (POST /api/data-products/:id/costs/matches): in one environment. */
export const dataCostMatchInput = z.object({ platformId: id(), environment: z.string().trim().min(1).max(60), ...costMatchFields }).strict();
export type DataCostMatchInput = z.input<typeof dataCostMatchInput>;

/** An element's match (POST /api/data-elements/:id/cost-matches): its platform unless named, its environment. */
export const dataElementCostMatchInput = z.object({ platformId: id().optional(), ...costMatchFields }).strict();
export type DataElementCostMatchInput = z.input<typeof dataElementCostMatchInput>;

/** The split of a platform's lines of one match key (PUT /api/data-products/cost-allocations). */
export const dataCostAllocationInput = z
  .object({
    platformId: id(),
    ...costMatchFields,
    rule: z.enum(['equal', 'weight', 'measured']),
    /** Percent of the line per product (weight rule); at most 100 together, the rest is not attributed */
    weights: z
      .array(z.object({ productId: id(), pct: z.number().min(0).max(100) }).strict())
      .max(L.products)
      .default([]),
    /** Rule measured (phase 2): what is measured */
    measure: z.enum(DATA_COST_MEASURES).optional(),
    /**
     * Rule measured: the warehouses, query tags or topics measured per product (topics: none given – the product's
     * member topics)
     */
    subjects: z
      .array(
        z
          .object({
            productId: id(),
            subjects: z.array(z.string().trim().min(1).max(DATA_COST_MEASURE_LIMITS.subjectChars)).max(DATA_COST_MEASURE_LIMITS.subjectsPerProduct),
          })
          .strict(),
      )
      .max(L.products)
      .default([]),
  })
  .strict();
export type DataCostAllocationInput = z.input<typeof dataCostAllocationInput>;

export const dataProductCostsQuery = z.object({
  environment: z.string().trim().max(60).optional(),
  /** Months back from the current one (included) */
  months: z.coerce.number().int().min(1).max(24).default(12),
});

export const dataCostAllocationsQuery = z.object({
  platformId: z.string().trim().max(100).optional(),
});

export const dataProductScorecardQuery = z.object({
  environment: z.string().trim().max(60).optional(),
});
