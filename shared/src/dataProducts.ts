import { CIA_DIMENSIONS, levelRank, type ApplicationRating, type CiaDimension, type CiaLevel, type CiaColor } from './catalogue.js';
import type { MonitorStatus } from './monitors.js';

/**
 * The data products module (0.22.0, ADR 0036, docs/DATA-PRODUCTS.md): data objects say what the business data is, how
 * sensitive and whose; elements are concrete things on a platform (a table, a topic, an API, a path) in a catalogue of
 * their own; a data product belongs to a domain, has a type, a rating, a lifecycle and owners, and is made of elements –
 * many to many, with a role per membership – in one or more environments; its ports expose elements and data objects,
 * each output port optionally under an ODCS contract, with registered consumers and objectives; steps document how data
 * moves between elements (documentation, never run).
 *
 * This file is the shared contract of the module's work packages: the kinds, roles, lifecycles and classifications,
 * the limits, the types of the internal API and the pure functions (rating floor, maturity, lifecycle rules). Changes
 * to it are announced to every package that builds on it.
 */

// ---------- ids ----------

/** Id prefixes (ADR 0036 part 18): domains, data objects, products, elements, ports, steps; the rest are internal. */
export const DATA_PRODUCT_ID_PREFIX = {
  domain: 'dpd_',
  object: 'dpo_',
  product: 'dpr_',
  element: 'dpe_',
  port: 'dpp_',
  step: 'dps_',
  binding: 'dpb_',
  consumer: 'dpc_',
  checkLink: 'dpk_',
  source: 'dpq_',
  run: 'dpn_',
  costMatch: 'dpm_',
  allocation: 'dpa_',
} as const;

/** The owned kinds of the module (resource_teams.kind, OWNED_KINDS): owning teams decide who sees and changes them. */
export const DATA_PRODUCT_OWNED_KINDS = ['data_product', 'data_object', 'data_element', 'data_domain'] as const;
export type DataProductOwnedKind = (typeof DATA_PRODUCT_OWNED_KINDS)[number];

/** Keys of domains, data objects and products: lower case, digits, `.`, `_`, `-` (the file format, Git and ODPS `id`). */
export const DATA_PRODUCT_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

// ---------- limits (ADR 0036 part 19) ----------

export const DATA_PRODUCT_LIMITS = {
  domains: 200,
  objects: 5_000,
  products: 2_000,
  elements: 250_000,
  /** Elements one discovery run reads (a read beyond keeps the first and says truncated) */
  elementsPerRun: 50_000,
  discoverySources: 50,
  /** Discovery runs kept per source (the newest) */
  runsKept: 30,
  /** Members per product (a project with descendants counts once) */
  membersPerProduct: 5_000,
  portsPerProduct: 50,
  elementsPerBinding: 20,
  consumersPerPort: 200,
  objectsPerPort: 100,
  /** Steps of one product's pipeline, and inputs and outputs per step */
  stepsPerPipeline: 2_000,
  stepEnds: 50,
  transformNotes: 50,
  /** Topics a bundle resolves to */
  bundleTopics: 2_000,
  checkLinksPerElement: 100,
  draftMonitorChecks: 100,
  costMatches: 1_000,
  /** Lineage: depth and nodes (the rest counted per direction) */
  lineageDepth: 4,
  lineageNodes: 200,
  /** A page of a list (keyset paging) */
  page: 100,
  /** Counts of a text search are capped (shown as 10,000+) */
  countCap: 10_000,
  /** A readout as stored (bytes of JSON) */
  readoutBytes: 8 * 1024,
  /** Elements added to a product in one request */
  membersPerRequest: 500,
  // text fields
  key: 100,
  name: 200,
  qualifiedName: 1_000,
  description: 20_000,
  text: 2_000,
  short: 200,
  url: 2_000,
  synonyms: 20,
  attributes: 100,
  tags: 50,
  externalRefs: 50,
  subjects: 50,
  /** Categories, special categories, data subjects, purposes, regulatory flags of a data object */
  listValues: 50,
  flags: 30,
} as const;

// ---------- vocabularies ----------

/** Product lifecycle: the ODPS statuses, in order. */
export const DATA_PRODUCT_LIFECYCLES = ['proposed', 'draft', 'active', 'deprecated', 'retired'] as const;
export type DataProductLifecycle = (typeof DATA_PRODUCT_LIFECYCLES)[number];

/** Lifecycle of data objects and ports (no proposal stage). */
export const DATA_OBJECT_LIFECYCLES = ['draft', 'active', 'deprecated', 'retired'] as const;
export type DataObjectLifecycle = (typeof DATA_OBJECT_LIFECYCLES)[number];
export const DATA_PORT_LIFECYCLES = DATA_OBJECT_LIFECYCLES;
export type DataPortLifecycle = DataObjectLifecycle;

/** Product types (Dehghani); optional. */
export const DATA_PRODUCT_TYPES = ['sourceAligned', 'aggregate', 'consumerAligned'] as const;
export type DataProductType = (typeof DATA_PRODUCT_TYPES)[number];

/** Classification of data objects and products: four fixed keys, labels translated (decision 7). */
export const DATA_CLASSIFICATIONS = ['public', 'internal', 'confidential', 'strictly_confidential'] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];
export const classificationRank = (c: string | null | undefined): number => (c ? (DATA_CLASSIFICATIONS as readonly string[]).indexOf(c) : -1);

/** Criticality of a product (as applications and services). */
export const DATA_PRODUCT_CRITICALITIES = ['low', 'medium', 'high', 'critical'] as const;
export type DataProductCriticality = (typeof DATA_PRODUCT_CRITICALITIES)[number];

/** Support tier 1–3: how a product is supported (hours, response). */
export const DATA_PRODUCT_SUPPORT_TIERS = [1, 2, 3] as const;
export type DataProductSupportTier = (typeof DATA_PRODUCT_SUPPORT_TIERS)[number];

export const DATA_VALUE_TIERS = ['high', 'medium', 'low'] as const;
export type DataValueTier = (typeof DATA_VALUE_TIERS)[number];

/** Personal data in a data object: none, personal data, special categories (GDPR Art. 9). */
export const PERSONAL_DATA_LEVELS = ['none', 'personal', 'special'] as const;
export type PersonalDataLevel = (typeof PERSONAL_DATA_LEVELS)[number];

/** Suggested categories of personal data (free values allowed). */
export const PERSONAL_DATA_CATEGORIES = [
  'identification',
  'contact',
  'employment',
  'financial',
  'location',
  'onlineIdentifiers',
  'behaviour',
  'technicalDevice',
] as const;

/** GDPR Art. 9 special categories and Art. 10 criminal convictions (fixed keys). */
export const SPECIAL_DATA_CATEGORIES = [
  'racialEthnicOrigin',
  'politicalOpinions',
  'religiousBeliefs',
  'tradeUnionMembership',
  'genetic',
  'biometric',
  'health',
  'sexLifeOrientation',
  'criminalConvictions',
] as const;
export type SpecialDataCategory = (typeof SPECIAL_DATA_CATEGORIES)[number];

/** Suggested data subjects (free values allowed). */
export const DATA_SUBJECT_SUGGESTIONS = ['customers', 'employees', 'supplierContacts', 'applicants', 'visitors'] as const;

/** Legal basis of the processing: GDPR Art. 6(1)(a)–(f). */
export const LEGAL_BASES = ['consent', 'contract', 'legalObligation', 'vitalInterests', 'publicTask', 'legitimateInterests'] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];

/** Suggested regulatory flags (Settings → Data products → Regulatory flags; tags with a meaning, nothing enforced). */
export const DEFAULT_REGULATORY_FLAGS = ['GDPR', 'trade secret', 'export control', 'SOX', 'NIS2', 'product liability'] as const;

/** Default layers of elements (Settings → Data products → Layers), source first. */
export const DEFAULT_DATA_LAYERS = ['source', 'raw', 'staged', 'curated', 'mart'] as const;

/** The role of an element in a product (decision 4): consumed, transformation, offered. */
export const DATA_MEMBER_ROLES = ['input', 'internal', 'output'] as const;
export type DataMemberRole = (typeof DATA_MEMBER_ROLES)[number];

export const DATA_PORT_DIRECTIONS = ['input', 'output'] as const;
export type DataPortDirection = (typeof DATA_PORT_DIRECTIONS)[number];

export const DATA_PORT_TYPES = ['table', 'topic', 'api', 'file', 'other'] as const;
export type DataPortType = (typeof DATA_PORT_TYPES)[number];

/** A product's state in one environment. */
export const DATA_ENVIRONMENT_STATES = ['planned', 'available', 'withdrawn'] as const;
export type DataEnvironmentState = (typeof DATA_ENVIRONMENT_STATES)[number];

/** Who a registered consumer is. */
export const DATA_CONSUMER_KINDS = ['team', 'user', 'application', 'service', 'product', 'text'] as const;
export type DataConsumerKind = (typeof DATA_CONSUMER_KINDS)[number];

/** What a consumer's agreement is. */
export const DATA_AGREEMENT_KINDS = ['record', 'contract', 'ticket', 'url'] as const;
export type DataAgreementKind = (typeof DATA_AGREEMENT_KINDS)[number];

/** How an element came into the catalogue. */
export const DATA_ELEMENT_SOURCES = ['entered', 'discovered', 'imported'] as const;
export type DataElementSource = (typeof DATA_ELEMENT_SOURCES)[number];

/** Kinds of steps (part 9). */
export const DATA_STEP_KINDS = ['ingest', 'stage', 'transform', 'curate', 'publish', 'replicate', 'other'] as const;
export type DataStepKind = (typeof DATA_STEP_KINDS)[number];

/** What runs a step: a Steward application, platform, process or element, a connector, or a tool named in text. */
export const DATA_RUNNER_KINDS = ['application', 'platform', 'process', 'element', 'connector', 'tool'] as const;
export type DataRunnerKind = (typeof DATA_RUNNER_KINDS)[number];

/** Suggested tools of a runner (free values allowed). */
export const DATA_RUNNER_TOOLS = [
  'Airflow',
  'Azure Data Factory',
  'dbt',
  'Fivetran',
  'Kafka Connect',
  'Snowflake task',
  'Snowpipe',
  'Spark',
  'AWS Glue',
  'script',
] as const;

/** Kinds of transformation notes (ADR 0019's sink transformation kinds). */
export const DATA_TRANSFORM_KINDS = ['rename', 'scale', 'unit', 'aggregate', 'filter', 'enrich', 'compute', 'format', 'other'] as const;
export type DataTransformKind = (typeof DATA_TRANSFORM_KINDS)[number];

/** Why a check is linked to an element or a step (part 10). */
export const DATA_CHECK_PURPOSES = ['freshness', 'schema', 'volume', 'quality', 'availability', 'other'] as const;
export type DataCheckPurpose = (typeof DATA_CHECK_PURPOSES)[number];

/** How a check link came about: made by Create monitor, linked by a person, found from a check's fields. */
export const DATA_CHECK_LINK_ORIGINS = ['made', 'linked', 'found'] as const;
export type DataCheckLinkOrigin = (typeof DATA_CHECK_LINK_ORIGINS)[number];

/** Rights on the module's items. manage: owning teams, delete, lifecycle retired. */
export const DATA_PRODUCT_PERMISSIONS = ['view', 'edit', 'manage'] as const;
export type DataProductPermission = (typeof DATA_PRODUCT_PERMISSIONS)[number];

/** Module roles (ADR 0034): until module access is built, the core roles map onto them (part 12). */
export const DATA_PRODUCT_MODULE_ROLES = ['viewer', 'contributor', 'manager'] as const;
export type DataProductModuleRole = (typeof DATA_PRODUCT_MODULE_ROLES)[number];

// ---------- elements and their kinds (part 5) ----------

export const DATA_ELEMENT_KINDS = [
  'snowflake.database',
  'snowflake.schema',
  'snowflake.table',
  'snowflake.view',
  'snowflake.dynamicTable',
  'snowflake.stream',
  'snowflake.task',
  'snowflake.stage',
  'snowflake.pipe',
  'kafka.topic',
  'kafka.topicBundle',
  'sql.schema',
  'sql.table',
  'sql.view',
  'api.openapi',
  'api.asyncapi',
  'api.graphql',
  'api.endpoint',
  'files.path',
  'insightsHub.aspect',
  'other',
] as const;
export type DataElementKind = (typeof DATA_ELEMENT_KINDS)[number];
export const isDataElementKind = (x: unknown): x is DataElementKind => typeof x === 'string' && (DATA_ELEMENT_KINDS as readonly string[]).includes(x);

export interface DataElementKindDef {
  /** The platform kinds an element of this kind may live on (`any`: any platform); null platform allowed when !platformRequired */
  platformKinds: readonly string[] | 'any';
  platformRequired: boolean;
  /** A project or a bundle: a membership may include everything below it (`includeDescendants`) */
  container: boolean;
  /** The kinds its parent may have (empty: no parent) */
  parentKinds: readonly DataElementKind[];
  /** Read by discovery in phase 1 (WP2); the others are entered or imported */
  discovered: boolean;
  /** The port type an element of this kind usually serves */
  portType: DataPortType;
}

const SNOWFLAKE = ['snowflake'] as const;
const KAFKA = ['kafka', 'confluent-cloud'] as const;
const SQL = ['database'] as const;
const inSnowflakeSchema = (discovered = true): DataElementKindDef => ({
  platformKinds: SNOWFLAKE,
  platformRequired: true,
  container: false,
  parentKinds: ['snowflake.schema'],
  discovered,
  portType: 'table',
});

export const DATA_ELEMENT_KIND_DEFS: Readonly<Record<DataElementKind, DataElementKindDef>> = {
  'snowflake.database': { platformKinds: SNOWFLAKE, platformRequired: true, container: true, parentKinds: [], discovered: true, portType: 'table' },
  'snowflake.schema': {
    platformKinds: SNOWFLAKE,
    platformRequired: true,
    container: true,
    parentKinds: ['snowflake.database'],
    discovered: true,
    portType: 'table',
  },
  'snowflake.table': inSnowflakeSchema(),
  'snowflake.view': inSnowflakeSchema(),
  'snowflake.dynamicTable': inSnowflakeSchema(),
  'snowflake.stream': inSnowflakeSchema(),
  'snowflake.task': { ...inSnowflakeSchema(), portType: 'other' },
  'snowflake.stage': { ...inSnowflakeSchema(), portType: 'file' },
  'snowflake.pipe': { ...inSnowflakeSchema(), portType: 'other' },
  'kafka.topic': { platformKinds: KAFKA, platformRequired: true, container: false, parentKinds: ['kafka.topicBundle'], discovered: true, portType: 'topic' },
  'kafka.topicBundle': { platformKinds: KAFKA, platformRequired: true, container: true, parentKinds: [], discovered: false, portType: 'topic' },
  'sql.schema': { platformKinds: SQL, platformRequired: true, container: true, parentKinds: [], discovered: true, portType: 'table' },
  'sql.table': { platformKinds: SQL, platformRequired: true, container: false, parentKinds: ['sql.schema'], discovered: true, portType: 'table' },
  'sql.view': { platformKinds: SQL, platformRequired: true, container: false, parentKinds: ['sql.schema'], discovered: true, portType: 'table' },
  'api.openapi': { platformKinds: 'any', platformRequired: false, container: false, parentKinds: [], discovered: false, portType: 'api' },
  'api.asyncapi': { platformKinds: 'any', platformRequired: false, container: false, parentKinds: [], discovered: false, portType: 'api' },
  'api.graphql': { platformKinds: 'any', platformRequired: false, container: false, parentKinds: [], discovered: false, portType: 'api' },
  'api.endpoint': { platformKinds: 'any', platformRequired: false, container: false, parentKinds: [], discovered: false, portType: 'api' },
  'files.path': { platformKinds: ['aws'], platformRequired: false, container: false, parentKinds: [], discovered: false, portType: 'file' },
  'insightsHub.aspect': { platformKinds: ['insights-hub'], platformRequired: true, container: false, parentKinds: [], discovered: false, portType: 'other' },
  other: { platformKinds: 'any', platformRequired: false, container: false, parentKinds: [], discovered: false, portType: 'other' },
};

/** Whether an element of `kind` may live on a platform of `platformKind` (null: no platform). */
export function elementKindFits(kind: DataElementKind, platformKind: string | null): boolean {
  const d = DATA_ELEMENT_KIND_DEFS[kind];
  if (platformKind === null) return !d.platformRequired;
  return d.platformKinds === 'any' || d.platformKinds.includes(platformKind);
}

/**
 * The normalised qualified name an element is unique by (with platform, kind and environment) and searched by prefix:
 * trimmed and lower case. Snowflake identifiers without quotes are upper case, so `shop.sales.orders` and
 * `SHOP.SALES.ORDERS` are the same element; Kafka topics that differ only in case are one element in the catalogue.
 */
export const elementNameNorm = (qualifiedName: string): string => qualifiedName.trim().toLowerCase();

/** The last part of a dotted qualified name (`SHOP.SALES.ORDERS` → `ORDERS`), the display name by default. */
export const elementShortName = (qualifiedName: string): string => {
  const s = qualifiedName.trim();
  const i = s.lastIndexOf('.');
  return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : s;
};

/**
 * The OpenLineage dataset of an element (phase 2 matches run events by them): `snowflake://<org>-<account>` with
 * `DB.SCHEMA.TABLE`, `kafka://<bootstrap host>:<port>` with the topic, `postgres://<host>:<port>` with the table.
 * `platformAddress` is what the platform's settings give (account, bootstrap server, host and port); null when unknown.
 */
export function openLineageDataset(kind: DataElementKind, platformAddress: string | null, qualifiedName: string): { namespace: string; name: string } | null {
  if (!platformAddress) return null;
  if (kind.startsWith('snowflake.')) return { namespace: `snowflake://${platformAddress.toLowerCase()}`, name: qualifiedName.toUpperCase() };
  if (kind === 'kafka.topic') return { namespace: `kafka://${platformAddress}`, name: qualifiedName };
  if (kind.startsWith('sql.')) return { namespace: platformAddress, name: qualifiedName };
  return null;
}

// ---------- shared shapes ----------

/** A subject that is responsible or owns: `user:<name>` or `team:<name>`. */
export type DataSubject = string;

export interface DataExternalRef {
  label: string;
  url: string;
}

export interface OwningTeamRef {
  id: string;
  name: string;
}

/** A reference to an item the reader may see, or the fact that there is one they may not (counted, not named). */
export type DataRef = { id: string; key: string; name: string; hidden?: false } | { id: null; key: null; name: null; hidden: true };

/** A CIA rating of a product or a data object: the application ratings' shape, on the instance's CIA scale. */
export type DataRating = ApplicationRating;

/** Paged lists: keyset paging; `next` is the cursor of the next page (null: the last page). */
export interface DataPage<T> {
  items: T[];
  /** Matching items the reader may see (capped at DATA_PRODUCT_LIMITS.countCap for text searches: `countCapped`) */
  total: number;
  countCapped?: boolean;
  next: string | null;
}

// ---------- domains ----------

export interface DataDomain {
  id: string;
  key: string;
  name: string;
  description: string;
  parentId: string | null;
  colour: CiaColor | null;
  owners: DataSubject[];
  owningTeams: OwningTeamRef[];
  /** Products and data objects in it the reader may see */
  products: number;
  objects: number;
  permissions: DataProductPermission[];
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

// ---------- data objects (part 2) ----------

export interface DataObjectAttribute {
  name: string;
  description: string;
  personal: boolean;
}

export interface DataObjectSummary {
  id: string;
  key: string;
  name: string;
  domain: DataRef | null;
  lifecycle: DataObjectLifecycle;
  classification: DataClassification | null;
  personalData: PersonalDataLevel;
  rating: DataRating;
  owner: string | null;
  permissions: DataProductPermission[];
  updatedAt: string;
}

export interface DataObject extends DataObjectSummary {
  definition: string;
  synonyms: string[];
  categories: string[];
  specialCategories: SpecialDataCategory[];
  subjects: string[];
  legalBasis: LegalBasis | null;
  legalNote: string;
  purposes: string[];
  /** ISO 8601 duration (`P10Y`) or text */
  retention: string;
  deletionRule: string;
  regulatoryFlags: string[];
  attributes: DataObjectAttribute[];
  stewards: DataSubject[];
  custodians: DataSubject[];
  externalRefs: DataExternalRef[];
  owningTeams: OwningTeamRef[];
  /** Elements that implement it (visible to the reader / hidden) */
  elements: { visible: number; hidden: number };
  /** Products that expose or process it */
  products: { items: DataRef[]; hidden: number };
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedBy: string;
}

// ---------- the rating floor (part 3, decision 8) ----------

/** What a product exposes for the floor: a data object with its rating and classification. */
export interface ExposedObject {
  id: string;
  rating: Partial<Record<CiaDimension, { level: string; needsRerating: boolean } | null>>;
  classification: DataClassification | null;
}

export type RatingFloorDimension = CiaDimension | 'classification';
export const RATING_FLOOR_DIMENSIONS: readonly RatingFloorDimension[] = [...CIA_DIMENSIONS, 'classification'];

export interface RatingFloorFinding {
  dimension: RatingFloorDimension;
  /** The product's level (null: not rated) */
  level: string | null;
  /** The highest level of the exposed data objects */
  floor: string;
  /** The objects with that level (ids; the server names those the reader may see) */
  from: string[];
  /** The product's reason for being below (the distribution effect); null: none given – a warning */
  reason: string | null;
}

export interface RatingFloor {
  findings: RatingFloorFinding[];
  /** A finding without a reason: the page, the list and the scorecard warn (`ratingBelowObjects`) */
  warning: boolean;
  /** The highest classification of the exposed objects (shown on the product) */
  highestClassification: DataClassification | null;
}

/**
 * The rating floor of a product (decision 8): per dimension its rating must be at least the highest rating of the data
 * objects it exposes; the same for the classification. Lower is allowed with a reason, never blocked. Ratings that wait
 * for a re-rating do not count (as for the maximum principle of services); a dimension the product has not rated while
 * an object has is below the floor.
 */
export function ratingFloor(
  product: { rating: Partial<Record<CiaDimension, { level: string; needsRerating: boolean } | null>>; classification: DataClassification | null },
  exposed: readonly ExposedObject[],
  levels: Record<CiaDimension, readonly CiaLevel[]>,
  reasons: Partial<Record<RatingFloorDimension, string>> = {},
): RatingFloor {
  const findings: RatingFloorFinding[] = [];
  for (const d of CIA_DIMENSIONS) {
    let best = -1;
    let from: string[] = [];
    for (const o of exposed) {
      const r = o.rating[d];
      if (!r || r.needsRerating) continue;
      const rank = levelRank(levels[d], r.level);
      if (rank < 0) continue;
      if (rank > best) {
        best = rank;
        from = [o.id];
      } else if (rank === best) from.push(o.id);
    }
    if (best < 0) continue;
    const own = product.rating[d];
    const ownRank = own && !own.needsRerating ? levelRank(levels[d], own.level) : -1;
    if (ownRank < best) findings.push({ dimension: d, level: own?.level ?? null, floor: levels[d][best]!.key, from, reason: reasons[d]?.trim() || null });
  }
  let best = -1;
  let from: string[] = [];
  for (const o of exposed) {
    const rank = classificationRank(o.classification);
    if (rank < 0) continue;
    if (rank > best) {
      best = rank;
      from = [o.id];
    } else if (rank === best) from.push(o.id);
  }
  const highestClassification = best >= 0 ? DATA_CLASSIFICATIONS[best]! : null;
  if (highestClassification && classificationRank(product.classification) < best)
    findings.push({
      dimension: 'classification',
      level: product.classification,
      floor: highestClassification,
      from,
      reason: reasons.classification?.trim() || null,
    });
  return { findings, warning: findings.some((f) => !f.reason), highestClassification };
}

// ---------- data products (part 3) ----------

export interface DataProductSupport {
  channel: string;
  url: string;
  hours: string;
}

export interface DataProductSummary {
  id: string;
  key: string;
  name: string;
  type: DataProductType | null;
  domain: DataRef | null;
  lifecycle: DataProductLifecycle;
  sunsetDate: string | null;
  criticality: DataProductCriticality | null;
  tier: DataProductSupportTier | null;
  rating: DataRating;
  classification: DataClassification | null;
  /** The rating floor is not met and no reason is given (ratingBelowObjects) */
  ratingBelowObjects: boolean;
  valueTier: DataValueTier | null;
  /** The environments it exists in (production first) */
  environments: string[];
  owners: DataSubject[];
  owningTeams: OwningTeamRef[];
  tags: string[];
  version: string;
  permissions: DataProductPermission[];
  updatedAt: string;
}

export interface DataProductEnvironment {
  environment: string;
  state: DataEnvironmentState;
  /** The product's monitor there (WP3: Create monitor); null: none */
  monitorId: string | null;
  production: boolean;
}

export interface DataProduct extends DataProductSummary {
  description: string;
  purpose: string;
  support: DataProductSupport;
  /** When each lifecycle state was reached (ISO dates) */
  lifecycleDates: Partial<Record<DataProductLifecycle, string>>;
  successor: DataRef | null;
  valueStatement: string;
  /** A yearly amount in micros with its currency; null: none */
  valueAmount: number | null;
  valueCurrency: string | null;
  /** Reasons for being below the rating floor, per dimension (and the classification) */
  ratingReasons: Partial<Record<RatingFloorDimension, string>>;
  ratingFloor: RatingFloor & { objects: DataRef[] };
  externalRefs: DataExternalRef[];
  environmentDetails: DataProductEnvironment[];
  ports: DataPort[];
  /** Members: counts by role (the list is paged: GET …/members) */
  memberCounts: Record<DataMemberRole, number>;
  /** Data objects exposed through its output ports (declared or through elements) */
  objects: DataRef[];
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedBy: string;
}

// ---------- membership (part 6) ----------

/** An element as a product shows it: also one the reader may not see otherwise (decision 15), without a way to it. */
export interface DataElementOnProduct {
  id: string;
  kind: DataElementKind;
  qualifiedName: string;
  displayName: string;
  environment: string;
  layer: string;
  /** null: no platform, or a platform the reader may not see (platformHidden) */
  platformId: string | null;
  platformName: string | null;
  platformHidden: boolean;
  missingSince: string | null;
  /** The reader may open the element's own page */
  visible: boolean;
}

export interface DataProductMember {
  productId: string;
  elementId: string;
  role: DataMemberRole;
  includeDescendants: boolean;
  note: string;
  addedBy: string;
  addedAt: string;
  element: DataElementOnProduct;
}

// ---------- ports, bindings, consumers, objectives (part 7) ----------

export interface DataObjectives {
  /** The data is at most this many minutes old */
  freshnessMinutes?: number | null;
  /** Share of time up or degraded over 30 days, in percent */
  availabilityPct?: number | null;
  /** Phase 2: volume and quality */
  completeness?: string | null;
  updateSchedule?: string | null;
  retention?: string | null;
}

/** Where an input port's data comes from. */
export type DataPortSource =
  | {
      kind: 'port';
      portId: string;
      product: DataRef;
      portName: string | null;
      version: string | null;
      lifecycle: DataPortLifecycle | null;
      sunsetDate: string | null;
    }
  | { kind: 'element'; elementId: string }
  | { kind: 'text'; text: string };

export interface DataPortBinding {
  id: string;
  portId: string;
  environment: string;
  /** A data contract (Steward's id) and the version it is held to (null: the current one) and its ODCS server */
  contractId: string | null;
  contractVersion: number | null;
  contractServer: string | null;
  /** The contract as the reader may see it (hidden: a contract they may not see) */
  contract: DataRef | null;
  /** Objectives that differ from the port's */
  objectives: DataObjectives;
  elementIds: string[];
}

export interface DataPort {
  id: string;
  productId: string;
  direction: DataPortDirection;
  name: string;
  type: DataPortType;
  version: string;
  description: string;
  lifecycle: DataPortLifecycle;
  lifecycleDates: Partial<Record<DataPortLifecycle, string>>;
  sunsetDate: string | null;
  successorId: string | null;
  objectives: DataObjectives;
  /** Input ports: where the data comes from */
  source: DataPortSource | null;
  /** Data objects: declared on the port and through its elements (output: exposes; input: needs) */
  objects: { declared: DataRef[]; throughElements: DataRef[] };
  bindings: DataPortBinding[];
  /** Registered consumers and consuming products (input ports of other products naming it), visible and hidden */
  consumers: { registered: number; derived: number };
  /** The port consumes a deprecated or retired port */
  consumesDeprecated: boolean;
  position: number;
  revision: number;
}

export interface DataAgreement {
  kind: DataAgreementKind;
  /** A record or contract id, a ticket reference id, or a URL */
  ref: string;
  label: string;
}

export interface DataConsumer {
  id: string;
  portId: string;
  kind: DataConsumerKind;
  /** application, service, product: its id */
  refId: string | null;
  /** team or user: the subject (`team:<name>`, `user:<name>`) */
  subject: string | null;
  text: string;
  /** The consumer's name as the reader may see it (null: hidden) */
  label: string | null;
  purpose: string;
  since: string | null;
  endDate: string | null;
  agreement: DataAgreement | null;
  /** Who is told when the port is deprecated (users and teams) */
  contacts: DataSubject[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

// ---------- the element catalogue (part 5) ----------

export interface DataElementSummary {
  id: string;
  platformId: string | null;
  platformName: string | null;
  platformHidden: boolean;
  kind: DataElementKind;
  qualifiedName: string;
  displayName: string;
  environment: string;
  layer: string;
  source: DataElementSource;
  parentId: string | null;
  missingSince: string | null;
  /** Products it is a member of (visible to the reader / hidden: counted, never named) */
  products: { visible: number; hidden: number };
  updatedAt: string;
}

export interface DataElement extends DataElementSummary {
  description: string;
  typeLabel: string;
  discoverySourceId: string | null;
  externalId: string | null;
  olNamespace: string | null;
  olName: string | null;
  applicationId: string | null;
  componentId: string | null;
  plantSink: { assetId: string; collectionId: string; sinkId: string } | null;
  apiRef: { specId?: string; operations?: string[]; url?: string } | null;
  flags: Record<string, string | number | boolean>;
  owningTeams: OwningTeamRef[];
  permissions: DataProductPermission[];
  /** Products it is part of, with its role there */
  productRefs: { product: DataRef; role: DataMemberRole }[];
  objects: DataRef[];
  readout: DataElementReadout | null;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedBy: string;
}

/** What a discovery read last (separate from the element: a daily read does not rewrite the catalogue). */
export interface DataElementReadout {
  readAt: string;
  rowCount?: number | null;
  bytes?: number | null;
  lastAltered?: string | null;
  partitions?: number | null;
  retentionMs?: number | null;
  schemaVersion?: number | null;
  [k: string]: string | number | boolean | null | undefined;
}

// ---------- discovery (part 5; WP2) ----------

/** One element as a discovery reader hands it to the store (upsertDiscovered). */
export interface DiscoveredElement {
  kind: DataElementKind;
  qualifiedName: string;
  displayName?: string;
  /** The parent's qualified name (same platform and environment); its kind follows from DATA_ELEMENT_KIND_DEFS */
  parentQualifiedName?: string | null;
  environment: string;
  /** Snowflake TABLE_ID, Kafka topic id: a known id under a new name is a rename */
  externalId?: string | null;
  flags?: Record<string, string | number | boolean>;
  readout?: Omit<DataElementReadout, 'readAt'> | null;
  /** The OpenLineage dataset (openLineageDataset; phase 2 matches run events by it) */
  olNamespace?: string | null;
  olName?: string | null;
}

export interface DiscoveryUpsertResult {
  added: number;
  changed: number;
  renamed: number;
  unchanged: number;
  /** Readouts written */
  readouts: number;
  /** Not added: the instance holds DATA_PRODUCT_LIMITS.elements already */
  skipped: number;
  /** Ids of every element the batch named (added or found) */
  seen: string[];
}

export const DATA_DISCOVERY_MODES = ['informationSchema', 'accountUsage'] as const;
export type DataDiscoveryMode = (typeof DATA_DISCOVERY_MODES)[number];

export const DATA_DISCOVERY_RUN_STATUSES = ['running', 'succeeded', 'failed', 'truncated'] as const;
export type DataDiscoveryRunStatus = (typeof DATA_DISCOVERY_RUN_STATUSES)[number];

/** An environment rule of a discovery source: names starting (prefix) or ending (suffix) with `value` → `environment`. */
export interface DataEnvironmentRule {
  match: 'prefix' | 'suffix';
  value: string;
  environment: string;
}

export interface DataDiscoverySource {
  id: string;
  name: string;
  platformId: string;
  /** Snowflake: databases and optionally schemas (`DB` or `DB.SCHEMA`); Kafka: topic prefixes ([] = all); SQL: [] (the snapshot) */
  scope: string[];
  includePrefixes: string[];
  excludePrefixes: string[];
  environmentRules: DataEnvironmentRule[];
  mode: DataDiscoveryMode | null;
  identityId: string | null;
  /** Owning teams of what it discovers (default: the platform's) */
  elementTeamIds: string[];
  intervalMinutes: number;
  enabled: boolean;
  runAs: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: DataDiscoveryRunStatus | null;
  failingSince: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** The platform's name and kind (the reader sees the platform, or the source is not listed) */
  platformName?: string;
  platformKind?: string;
  /** What the reader may do: view; manage (change, delete, Read now) */
  permissions?: ('view' | 'manage')[];
  /** A run is going on now */
  running?: boolean;
  /** The newest run */
  lastRun?: DataDiscoveryRun | null;
}

export interface DataDiscoveryRun {
  id: string;
  sourceId: string;
  status: DataDiscoveryRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  added: number;
  changed: number;
  renamed: number;
  missing: number;
  removed: number;
  unchanged: number;
  truncated: boolean;
  /**
   * Why the run failed or stopped early, or what it could not read (a Schema Registry), in English; the web app shows
   * errors:codes.<errorCode> with errorParams when there is a code
   */
  error: string | null;
  errorCode?: string | null;
  errorParams?: Record<string, string | number | boolean | null> | null;
  actor: string;
}

/** Limits and defaults of discovery (ADR 0036 parts 5 and 19, _Performance_). */
export const DATA_DISCOVERY_LIMITS = {
  /** How often a source is read (minutes): at most hourly, daily by default, at least weekly */
  intervalMinutes: { min: 60, default: 1_440, max: 10_080 },
  /** Entries of a scope (Snowflake databases or schemas, Kafka prefixes, SQL schemas) */
  scope: 50,
  /** Include and exclude prefixes each */
  prefixes: 100,
  environmentRules: 20,
  elementTeams: 20,
  /**
   * Elements written per transaction, with a yield to the event loop between batches: 250 keep one batch well below
   * 100 ms on PostgreSQL (each statement is a hop to the database), so the event loop's lag stays below 200 ms
   */
  batch: 250,
  /** A run stops after this long and says truncated */
  timeBudgetMs: 10 * 60_000,
  /** The Snowflake SQL API's statement timeout (seconds) */
  statementTimeoutSeconds: 120,
  /** Missing elements in no product are removed after this many days */
  missingDays: 30,
  /** Schema Registry subjects whose latest version one run reads (the others keep their last readout) */
  registrySubjects: 2_000,
  /** Topics described per Kafka request */
  topicsPerRequest: 200,
} as const;

/** The scope entry that is a whole Snowflake database or a schema (`DB`, `DB.SCHEMA`; unquoted identifiers). */
export const SNOWFLAKE_DISCOVERY_SCOPE_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,254}(\.[A-Za-z_][A-Za-z0-9_$]{0,254})?$/;

/**
 * The environment of a discovered element by the source's rules (part 4): the first rule whose prefix starts, or whose
 * suffix ends, the element's root name (the Snowflake database, the SQL schema, the Kafka topic) – compared without
 * case; plain comparisons, no patterns. No rule matches: `fallback` (the platform's environment).
 */
export function environmentByRules(rootName: string, rules: readonly DataEnvironmentRule[], fallback: string): string {
  const n = rootName.trim().toLowerCase();
  for (const r of rules) {
    const v = r.value.trim().toLowerCase();
    if (!v) continue;
    if (r.match === 'prefix' ? n.startsWith(v) : n.endsWith(v)) return r.environment;
  }
  return fallback;
}

/**
 * Whether a source keeps an element by its include and exclude prefixes (plain comparisons without case, no patterns):
 * excluded when an exclude prefix starts its qualified name; with include prefixes, kept when one starts its name – or,
 * for a container (a database, a schema), when the container leads to one (`SHOP` and `SHOP.SALES` for `SHOP.SALES.`).
 */
export function discoveryKeeps(qualifiedName: string, include: readonly string[], exclude: readonly string[], container = false): boolean {
  const n = qualifiedName.trim().toLowerCase();
  if (exclude.some((x) => x && n.startsWith(x.trim().toLowerCase()))) return false;
  if (!include.length) return true;
  return include.some((raw) => {
    const x = raw.trim().toLowerCase();
    return !x || n.startsWith(x) || (container && (x.startsWith(`${n}.`) || x === n));
  });
}

// ---------- steps and lineage (part 9) ----------

export type DataStepRunner =
  | { kind: 'application' | 'platform' | 'process' | 'element'; id: string }
  | { kind: 'connector'; platformId: string; name: string }
  | { kind: 'tool'; tool: string; text: string };

export interface DataTransformNote {
  kind: DataTransformKind;
  text: string;
}

export interface DataStep {
  id: string;
  name: string;
  kind: DataStepKind;
  runner: DataStepRunner | null;
  /** The runner is an application, platform, process or element the reader may not see (runner is null then) */
  runnerHidden: boolean;
  /** Text or a cron expression */
  schedule: string;
  description: string;
  notes: DataTransformNote[];
  /** Element ids the reader may see; the others are counted */
  inputs: string[];
  outputs: string[];
  hiddenInputs: number;
  hiddenOutputs: number;
  /** The reader may change it (edit on a product of its output elements) */
  canEdit: boolean;
  /**
   * 0.24.0 (ADR 0036 phase 2): the last run a lineage source reported for it – an OpenLineage job or a dbt model it was
   * accepted from: the state, when, and the last complete run (freshness evidence of its outputs); null: none reported
   */
  lastRun?: { state: string; at: string; completeAt: string | null; origin: string; sourceId: string } | null;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** stepsAround(elementIds, depth): the steps within `depth` steps up and down, breadth-first by level. */
export interface DataStepsAround {
  steps: { id: string; name: string; kind: DataStepKind; inputs: string[]; outputs: string[] }[];
  /** Every element reached, with its distance (negative: upstream) */
  elements: { id: string; distance: number }[];
  /** The node limit stopped the walk: elements left out per direction */
  truncated: { upstream: number; downstream: number };
}

// ---------- checks and health (part 10; WP3) ----------

export interface DataCheckLink {
  id: string;
  elementId: string | null;
  stepId: string | null;
  monitorId: string;
  checkId: string;
  purpose: DataCheckPurpose;
  origin: DataCheckLinkOrigin;
  createdAt: string;
  createdBy: string;
}

/** Health of an element or a product: a monitor status, or no linked check at all (never OK without one). */
export type DataHealthStatus = MonitorStatus | 'noData';

/**
 * Health from worst to best – the one order of the module (product health, the scorecard, collapsed nodes of the
 * pictures, legends). It is the monitors' ranking (shared/src/monitors.ts: `off` below `up`, so a switched-off check
 * does not make a product off) with _No data_ last: any status of a check says more than none.
 */
export const DATA_HEALTH_ORDER: readonly DataHealthStatus[] = ['down', 'degraded', 'unknown', 'blocked', 'maintenance', 'up', 'off', 'noData'];
const HEALTH_RANK = new Map(DATA_HEALTH_ORDER.map((s, i) => [s, i]));
/** The worse of two health statuses. */
export const worseHealth = (a: DataHealthStatus, b: DataHealthStatus): DataHealthStatus =>
  (HEALTH_RANK.get(b) ?? DATA_HEALTH_ORDER.length) < (HEALTH_RANK.get(a) ?? DATA_HEALTH_ORDER.length) ? b : a;
/** The worst of a list (missing entries ignored; null when nothing is left). */
export function worstHealth(xs: readonly (DataHealthStatus | null | undefined)[]): DataHealthStatus | null {
  let out: DataHealthStatus | null = null;
  for (const x of xs) if (x && HEALTH_RANK.has(x)) out = out ? worseHealth(out, x) : x;
  return out;
}

export interface ElementHealth {
  elementId: string;
  status: DataHealthStatus;
  /** Linked checks the reader may see, and those they may not (counted by status only) */
  checks: { visible: number; hidden: number };
}

export interface ProductHealth {
  productId: string;
  environment: string;
  status: DataHealthStatus;
  /** monitor: the product's monitor there; elements: its output-port elements (internal ones at most degrading); none */
  source: 'monitor' | 'elements' | 'none';
  monitorId: string | null;
  elements: ElementHealth[];
}

// ---------- costs (part 11; WP4) ----------

export const DATA_COST_MATCH_KINDS = ['resource', 'subAccount', 'service', 'tag', 'application'] as const;
export type DataCostMatchKind = (typeof DATA_COST_MATCH_KINDS)[number];

export const DATA_COST_ALLOCATION_RULES = ['equal', 'weight', 'measured'] as const;
export type DataCostAllocationRule = (typeof DATA_COST_ALLOCATION_RULES)[number];

export interface ProductCostLine {
  platformId: string;
  /** direct: only this product matches the line; share: split by the allocation's rule */
  kind: 'direct' | 'share';
  rule: DataCostAllocationRule | null;
  /** The product's share of the line (0–1) */
  share: number;
  amountMicros: number;
  currency: string;
}

export interface ProductCost {
  productId: string;
  environment: string;
  /** The month (YYYY-MM) */
  month: string;
  totals: { currency: string; amountMicros: number }[];
  lines: ProductCostLine[];
  /** A part the reader may not see makes the total incomplete (never a figure the hidden part could be computed from) */
  incomplete: boolean;
  amountsHidden: boolean;
}

/**
 * A cost match (part 11): the lines of a platform a product claims in one environment – by resource id, sub-account,
 * service name, tag value or the application the lines are mapped to. On an element, the products it is a member of
 * inherit it (in the element's environment).
 */
export interface DataCostMatch {
  id: string;
  /** The product the match is on; null: on an element */
  productId: string | null;
  elementId: string | null;
  /** The element of an inherited match as the product shows it (decision 15); null for a product's own match */
  element: { id: string; qualifiedName: string; visible: boolean } | null;
  environment: string;
  /** null: a platform the reader may not see – its value is not shown either (platformHidden) */
  platformId: string | null;
  platformName: string | null;
  platformHidden: boolean;
  kind: DataCostMatchKind;
  value: string | null;
  /** The tag's key (kind tag) */
  tagKey: string;
  /** Other products that match the same lines (counted, never named) */
  sharedWith: number;
  canDelete: boolean;
  createdAt: string;
  createdBy: string;
}

/** A line of a product's costs in a month: what it takes of the platform's lines of one match, with the rule. */
export interface DataProductCostLine extends ProductCostLine {
  platformName: string;
  match: { kind: DataCostMatchKind; value: string; tagKey: string };
  /** The products the line is split between, this one included (others counted, never named) */
  products: number;
}

/** The Costs tab of a product (GET /api/data-products/:id/costs): per month in one environment, value beside it. */
export interface DataProductCosts {
  productId: string;
  /** The environment shown (production first by default); null: the product has none */
  environment: string | null;
  environments: string[];
  /** Oldest month first */
  months: (Omit<ProductCost, 'lines'> & { lines: DataProductCostLine[] })[];
  /** Its own matches and those inherited from its elements, in the environment */
  matches: DataCostMatch[];
  /** The product's value beside its costs – never netted, no ratio (decision 30) */
  value: { statement: string; tier: DataValueTier | null; amount: number | null; currency: string | null };
  /** Some month is incomplete: a platform whose amounts the reader may not see takes part */
  incomplete: boolean;
  amountsHidden: boolean;
  canEditMatches: boolean;
}

/**
 * How a platform's lines of one match key are split between the products that match them (part 11): equal, or by a
 * weight in percent per product – never more than 100 % of a line; the rest is not attributed. Set by who may manage
 * the platform; weights are shown to who sees the platform's amounts.
 */
export interface DataCostAllocation {
  platformId: string;
  platformName: string;
  kind: DataCostMatchKind;
  value: string;
  tagKey: string;
  rule: DataCostAllocationRule;
  /** Products matching the key that the reader may see, with their weight (null: weights not shown) */
  products: { product: DataRef & { hidden?: false }; environments: string[]; weightPct: number | null }[];
  /** Products matching it that the reader may not see (counted, never named) */
  hiddenProducts: number;
  /** Weight of the hidden products together (null: weights not shown) */
  hiddenWeightPct: number | null;
  /** What no product takes (weight rule; null: weights not shown) */
  notAttributedPct: number | null;
  weightsShown: boolean;
  canEdit: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

// ---------- scorecard and maturity (part 13; WP4) ----------

export const DATA_SCORECARD_PARTS = [
  'documented',
  'rated',
  'ports',
  'contracted',
  'observed',
  'healthy',
  'objectivesMet',
  'dependencies',
  'costsKnown',
] as const;
export type DataScorecardPartId = (typeof DATA_SCORECARD_PARTS)[number];

/** ISO/IEC 25012 data quality dimensions. */
export const ISO_25012_DIMENSIONS = [
  'accuracy',
  'completeness',
  'consistency',
  'credibility',
  'currentness',
  'accessibility',
  'compliance',
  'confidentiality',
  'efficiency',
  'precision',
  'traceability',
  'understandability',
  'availability',
  'portability',
  'recoverability',
] as const;
export type Iso25012Dimension = (typeof ISO_25012_DIMENSIONS)[number];

export const DATA_SCORECARD_STATES = ['met', 'partial', 'notMet', 'noEvidence', 'notApplicable'] as const;
export type DataScorecardState = (typeof DATA_SCORECARD_STATES)[number];

export interface DataScorecardPart {
  id: DataScorecardPartId | Iso25012Dimension;
  /** A part of the scorecard, or an ISO/IEC 25012 dimension */
  group: 'part' | 'iso25012';
  state: DataScorecardState;
  /** What the state rests on (i18n keys with values, rendered by the web app) */
  evidence: { key: string; values?: Record<string, string | number> }[];
}

/** The scorecard of a product in one environment (GET /api/data-products/:id/scorecard): computed on read. */
export interface DataProductScorecard {
  productId: string;
  /** The environment shown (production first by default); null: the product has none */
  environment: string | null;
  environments: string[];
  /** The parts (group part), then the ISO/IEC 25012 dimensions (group iso25012) */
  parts: DataScorecardPart[];
  maturity: DataMaturityLevel;
}

/**
 * GET /api/data-products/facts?ids=&environment=: what the product list shows beside a page of products, read in bulk
 * (a fixed number of statements for the page) – the maturity and last month's attributed costs, in the environment
 * asked for or each product's default (production first). Products the reader may not see are left out.
 */
export interface DataProductListFacts {
  productId: string;
  environment: string | null;
  maturity: DataMaturityLevel;
  /** Last month's attributed costs per currency, or null when no line is attributed; `incomplete`: a part is not shown */
  lastMonth: { month: string; totals: { currency: string; amountMicros: number }[]; incomplete: boolean } | null;
}

/** Maturity levels: 0 not yet documented, 1 documented, 2 observed, 3 contracted, 4 reliable, 5 endorsed (phase 2). */
export const DATA_MATURITY_LEVELS = [0, 1, 2, 3, 4, 5] as const;
export type DataMaturityLevel = (typeof DATA_MATURITY_LEVELS)[number];

/**
 * Maturity, computed from the scorecard (decision 9), never typed: level 1 documented and rated; 2 observed; 3
 * contracted; 4 objectives met for 30 days; 5 endorsed (phase 2). Each level needs the ones below it.
 */
export function maturityLevel(state: (id: DataScorecardPartId) => DataScorecardState | undefined, endorsed = false): DataMaturityLevel {
  const met = (id: DataScorecardPartId) => state(id) === 'met';
  if (!(met('documented') && met('rated'))) return 0;
  if (!met('observed')) return 1;
  if (!met('contracted')) return 2;
  if (!met('objectivesMet')) return 3;
  return endorsed ? 5 : 4;
}

// ---------- lifecycle rules (part 3) ----------

/** What a lifecycle change needs: active an owner and an output port; deprecated a sunset date; retired a confirmation while consumed. */
export type LifecycleProblem = 'needsOwner' | 'needsOutputPort' | 'needsSunsetDate' | 'consumersRegistered';

export function lifecycleProblems(
  to: DataProductLifecycle,
  p: { owners: readonly string[]; outputPorts: number; sunsetDate: string | null; consumers: number; confirmed: boolean },
): LifecycleProblem[] {
  const out: LifecycleProblem[] = [];
  if (to === 'active') {
    if (!p.owners.length) out.push('needsOwner');
    if (!p.outputPorts) out.push('needsOutputPort');
  }
  if (to === 'deprecated' && !p.sunsetDate) out.push('needsSunsetDate');
  if (to === 'retired' && p.consumers > 0 && !p.confirmed) out.push('consumersRegistered');
  return out;
}

/** The member role an element bound to a port of `direction` has (the service keeps roles and ports consistent). */
export const roleOfPort = (direction: DataPortDirection): DataMemberRole => (direction === 'output' ? 'output' : 'input');
